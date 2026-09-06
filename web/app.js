/**
 * The page is deliberately thin. Every number it shows comes from the chip
 * by way of the gateway, and it holds no state of its own beyond the feed —
 * a dashboard that caches an envelope is a dashboard that can disagree with
 * the hardware, which is the one thing this project cannot afford to look
 * like it does.
 */
const $ = (id) => document.getElementById(id);
const hbar = (tinybars) => `${Number(tinybars) / 1e8} HBAR`;

let CONFIG = null;
let busy = false;

async function api(path, opts) {
  const r = await fetch(`/api/${path}`, opts);
  return r.json();
}

/* ---------------------------------------------------------------- feed -- */

function event({ kind, who, text, detail, link }) {
  const list = $("events");
  list.querySelector("li.none")?.remove();

  const li = document.createElement("li");
  li.className = kind;

  const head = document.createElement("div");
  head.className = "head";
  const w = document.createElement("span");
  w.className = "who";
  w.textContent = who;
  const t = document.createElement("span");
  t.textContent = text;
  head.append(w, t);
  li.append(head);

  if (detail) {
    const d = document.createElement("div");
    d.className = "detail";
    d.textContent = detail;
    li.append(d);
  }
  if (link) {
    const d = document.createElement("div");
    d.className = "detail";
    const a = document.createElement("a");
    a.href = link.href;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = link.text;
    d.append(a);
    li.append(d);
  }
  list.prepend(li);
}

/* ------------------------------------------------------------ envelope -- */

async function refresh() {
  let d;
  try {
    d = await api("envelope");
  } catch {
    $("dot").className = "dot off";
    $("device-text").textContent = "gateway unreachable";
    return null;
  }

  if (!d.mandate) {
    $("dot").className = "dot off";
    $("device-text").textContent = "no mandate in the chip";
    $("available").textContent = "—";
    $("payees").innerHTML = '<li class="none">a human must grant an envelope on the device</li>';
    return null;
  }

  const m = d.mandate;
  $("dot").className = "dot on";
  $("device-text").textContent = CONFIG?.buyer ?? "device";

  $("available").textContent = hbar(m.available);
  $("percall").textContent = hbar(m.per_call_max);
  $("draws").textContent = m.draws_so_far;
  $("spent").textContent = hbar(m.spent);
  $("reserved").textContent = hbar(m.reserved);

  const total = Number(m.budget_total) || 1;
  const pct = (x) => `${(Number(x) / total) * 100}%`;
  const bar = $("bar");
  bar.querySelector(".spent").style.width = pct(m.spent);
  bar.querySelector(".reserved").style.width = pct(m.reserved);
  bar.querySelector(".left").style.width = pct(m.available);

  $("payees").innerHTML = "";
  for (const p of m.payees ?? []) {
    const li = document.createElement("li");
    li.textContent = p;
    $("payees").append(li);
  }

  // Contract terms, from the chip. Named rather than counted, for the same
  // reason the payees are: "2 contracts allowed" is not something a human can
  // check, and checking is the entire purpose of showing it.
  const calls = m.calls;
  $("contracts").innerHTML = "";
  if (!calls || calls.contracts.length === 0) {
    $("contracts").innerHTML = '<li class="none">no contract calls</li>';
  } else {
    for (const c of calls.contracts) {
      const li = document.createElement("li");
      li.textContent = c;
      if (calls.selectors.length) {
        const why = document.createElement("span");
        why.className = "why";
        why.textContent = calls.selectors.join(" ");
        li.append(why);
      }
      $("contracts").append(li);
    }
  }

  const bound = calls?.proceeds ?? "unknown — this chip predates contract calls";
  $("proceeds").textContent = bound;
  $("proceeds").className = calls?.recipient_arg == null ? "bound none" : "bound";

  const denied = d.advisory?.denied ?? [];
  $("denied").innerHTML = denied.length
    ? ""
    : '<li class="none">nothing flagged</li>';
  for (const x of denied) {
    const li = document.createElement("li");
    li.textContent = x.payee;
    const why = document.createElement("span");
    why.className = "why";
    why.textContent = x.reason;
    li.append(why);
    $("denied").append(li);
  }

  paintTiers(m);
  return m;
}

/* --------------------------------------------------------------- tiers -- */

function paintTiers(m) {
  const box = $("tiers");
  box.innerHTML = "";
  for (const tier of CONFIG.tiers) {
    const tinybars = Number(tier.price) * 1e8;
    const overCeiling = tinybars > Number(m.per_call_max);

    const b = document.createElement("button");
    b.disabled = busy;
    b.append(document.createTextNode(`Buy ${tier.label}`));

    const price = document.createElement("span");
    price.className = `price${overCeiling ? " over" : ""}`;
    price.textContent = overCeiling
      ? `${tier.price} HBAR — over the ceiling`
      : `${tier.price} HBAR`;
    b.append(price);

    b.onclick = () => buy(tier);
    box.append(b);
  }
}

async function buy(tier) {
  busy = true;
  $("hint").textContent = "asking the chip…";
  paintTiers(await api("envelope").then((d) => d.mandate));

  let d;
  try {
    d = await api("pay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: tier.label }),
    });
  } catch (e) {
    busy = false;
    $("hint").textContent = `request failed: ${e.message}`;
    await refresh();
    return;
  }

  if (d.paid) {
    event({
      kind: "paid",
      who: "chip",
      text: `signed ${hbar(d.spent)} to the ${tier.label} tier`,
      detail: d.response?.verdict
        ? `the service answered: ${d.response.verdict}`
        : undefined,
      link: d.tx
        ? { href: `https://hashscan.io/testnet/transaction/${d.tx}`,
            text: `settled on Hedera — ${d.tx}` }
        : undefined,
    });
  } else if (d.reason === "advisor_denied") {
    event({
      kind: "advised",
      who: "enclave",
      text: `advised against paying ${d.payee}`,
      detail: `${d.advice} — the chip would have allowed this. ` +
              `Not terminal: the next enclave run may clear it.`,
    });
  } else if (d.refused) {
    event({
      kind: "refused",
      who: "chip",
      text: `refused — ${d.reason}`,
      detail: `${d.advice} Nothing was signed, so there is nothing to publish.`,
    });
  } else {
    event({ kind: "refused", who: "gateway",
            text: d.reason ?? d.error ?? "no answer",
            detail: JSON.stringify(d).slice(0, 200) });
  }

  busy = false;
  const m = await refresh();
  $("hint").textContent = m
    ? `${hbar(m.available)} left in the envelope`
    : "";
}

/* ---------------------------------------------------------- the chip -- */

/** A Hedera account as a long-zero EVM address, padded to an ABI word. */
function addressWord(account) {
  const n = BigInt(String(account).split(".").pop());
  return n.toString(16).padStart(64, "0");
}

const numberWord = (n) => BigInt(n).toString(16).padStart(64, "0");

function scenario(name, m) {
  const { swap, approve, attacker, otherRouter } = CONFIG.defi;
  const router = m.calls?.contracts?.[0];
  const self = CONFIG.buyer;
  switch (name) {
    case "good":
      return { contract: router, sig: swap.sig,
               calldata: `0x${swap.selector}${numberWord(1)}${addressWord(self)}` };
    case "steal":
      return { contract: router, sig: swap.sig,
               calldata: `0x${swap.selector}${numberWord(1)}${addressWord(attacker)}` };
    case "approve":
      return { contract: router, sig: approve.sig,
               calldata: `0x${approve.selector}${addressWord(attacker)}${numberWord(1)}` };
    case "other":
      return { contract: otherRouter, sig: swap.sig,
               calldata: `0x${swap.selector}${numberWord(1)}${addressWord(self)}` };
  }
}

async function runScenario(name) {
  const env = await api("envelope");
  const m = env.mandate;
  if (!m?.calls?.contracts?.length) {
    $("defi-hint").textContent =
      "this mandate permits no contract calls — grant one that does";
    return;
  }

  const s = scenario(name, m);
  $("defi-hint").textContent = "asking the chip…";
  const d = await api("call", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contract: s.contract, calldata: s.calldata, amount: "1000000" }),
  });

  if (d.signed) {
    event({ kind: "paid", who: "chip",
            text: `signed a call to ${s.contract}`,
            detail: `${s.sig} — ${d.body_len}-byte body built and signed on-chip, ` +
                    `draw #${d.seq}` });
  } else if (d.refused) {
    event({ kind: "refused", who: "chip",
            text: `refused — ${d.reason}`,
            detail: d.advice });
  } else {
    event({ kind: "refused", who: "gateway",
            text: d.error ?? "no answer", detail: JSON.stringify(d).slice(0, 200) });
  }
  $("defi-hint").textContent = "";
  await refresh();
}

/* ----------------------------------------------------------- the proof -- */

async function loadReceipts() {
  const btn = $("load-receipts");
  btn.disabled = true;
  btn.textContent = "reading…";
  const d = await api("receipts");
  btn.disabled = false;
  btn.textContent = "Read the log from the mirror node";

  const list = $("receipts");
  list.innerHTML = "";
  const rows = (d.receipts ?? []).slice().reverse();
  if (!rows.length) {
    list.innerHTML = '<li class="none">nothing anchored yet</li>';
    return;
  }
  for (const r of rows) {
    const li = document.createElement("li");
    li.className = r.r ? "released" : (r.s ? "signed" : "");
    li.textContent = r.r
      ? `draw ${r.seq} — released, nothing paid`
      : `draw ${r.seq} — ${hbar(r.amount)} to 0.0.${r.payee}, ` +
        `${hbar(r.remaining)} left${r.s ? ", signed by the device" : ", unsigned"}`;
    list.append(li);
  }
}

/* ---------------------------------------------------------------- boot -- */

(async () => {
  CONFIG = await (await fetch("/api/config")).json();
  if (CONFIG.topic) {
    const a = document.createElement("a");
    a.href = `https://hashscan.io/testnet/topic/${CONFIG.topic}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = CONFIG.topic;
    $("topic").textContent = "";
    $("topic").append(a);
  }
  $("load-receipts").onclick = loadReceipts;
  for (const b of document.querySelectorAll("button.scenario")) {
    b.onclick = () => runScenario(b.dataset.case);
  }
  $("sig-good").textContent = CONFIG.defi.swap.sig;
  $("sig-steal").textContent = CONFIG.defi.swap.sig;
  await refresh();
  // The envelope can change without this page doing anything — another agent
  // draws on it, or a human revokes it on the device.
  setInterval(() => { if (!busy) refresh(); }, 5000);
})();
