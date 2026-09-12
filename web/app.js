/**
 * The page is deliberately thin. Every number it shows comes from the chip
 * by way of the gateway, and it holds no state of its own beyond the feed —
 * a dashboard that caches an envelope is a dashboard that can disagree with
 * the hardware, which is the one thing this project cannot afford to look
 * like it does.
 */
/**
 * An element, or a stand-in that swallows writes.
 *
 * `document.getElementById` returning null used to take the whole page down:
 * app.js referenced three ids that index.html no longer had, `refresh()` threw
 * on the first of them, and everything downstream — the envelope figures, the
 * buy buttons, the live agent feed — silently never ran. The fleet list
 * painted, so it looked fine.
 *
 * Found with a headless browser rather than by reading, which is the lesson:
 * nothing in this repository was checking that the page still worked.
 */
const MISSING = new Set();
const $ = (id) => {
  const el = document.getElementById(id);
  if (el) return el;
  if (!MISSING.has(id)) {
    MISSING.add(id);
    console.warn(`[vela] no element #${id} — that part of the page is dead`);
  }
  // A sink, so one absent node degrades one feature instead of the page.
  return new Proxy({ style: {}, classList: { add() {}, remove() {} } }, {
    get: (t, k) => (k in t ? t[k] : (typeof k === "string" ? () => {} : undefined)),
    set: () => true,
  });
};
const hbar = (tinybars) => `${Number(tinybars) / 1e8} HBAR`;

/**
 * Replay, for a reader who has neither the device nor the six processes.
 *
 * A judge reviewing this asynchronously cannot start a Ledger, a broker, a
 * gateway and three model runs — so the page can play a recording instead.
 * Everything it shows then came off real hardware; the banner says so and the
 * buttons are inert, because a console that let you press "buy" against a
 * recording would be a console that lies about what it is.
 *
 * On by default when there is no gateway to talk to, which is what a static
 * host looks like.
 */
let DEMO = new URLSearchParams(location.search).has("demo");

let CONFIG = null;
let busy = false;

/**
 * Which agent the panels below are showing.
 *
 * Held by slot rather than by name, because the slot is what the chip
 * indexes on. A name is a label a host could reuse; a slot is a place in
 * NVRAM.
 */
let selected = null;
let FLEET = null;

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

/* --------------------------------------------------------------- fleet -- */

async function paintFleet() {
  let d;
  try {
    d = await (await fetch("/api/fleet")).json();
  } catch {
    return null;
  }
  FLEET = d;
  return paintFleetFrom(d);
}

/**
 * Draw a fleet, whatever it came from.
 *
 * Split from the fetch so a recording can be painted with exactly the same
 * code as a live device. Two painters would be two things to keep in step,
 * and the one nobody looks at is the one that rots.
 */
function paintFleetFrom(d) {

  const live = d.agents.filter((a) => !a.free);
  if (selected === null && live.length) selected = live[0].slot;

  const box = $("agents");
  box.innerHTML = "";

  for (const a of d.agents) {
    const el = document.createElement("div");
    el.className = "agent" + (a.free ? " free" : "") +
                   (a.slot === selected ? " on" : "");

    if (a.unknown) {
      // Not free. The device did not answer, and saying "free" here would
      // mean the console reports a wiped fleet for an app that is merely
      // closed.
      el.className = "agent free";
      const name = document.createElement("div");
      name.className = "name";
      name.append(document.createTextNode(`Slot ${a.slot}`));
      const tag = document.createElement("span");
      tag.className = "slot";
      tag.textContent = "unknown";
      name.append(tag);
      const why = document.createElement("div");
      why.className = "unknown";
      why.textContent = a.why ?? "the device did not answer";
      el.append(name, why);
      box.append(el);
      continue;
    }

    if (a.free) {
      const n = document.createElement("div");
      n.className = "row";
      const label = document.createElement("span");
      label.className = "name";
      label.textContent = `Slot ${a.slot}`;
      const tag = document.createElement("span");
      tag.className = "slot";
      tag.textContent = "free";
      n.append(label, tag);
      const amt = document.createElement("div");
      amt.className = "amount";
      amt.textContent = "—";
      el.append(n, amt);
      box.append(el);
      continue;
    }

    const total = Number(a.budget_total) || 1;
    const pct = (x) => `${Math.max(0, (Number(x) / total) * 100)}%`;

    const row = document.createElement("div");
    row.className = "row";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = a.label;
    const slot = document.createElement("span");
    slot.className = "slot";
    slot.textContent = `slot ${a.slot}`;
    row.append(name, slot);

    const amount = document.createElement("div");
    amount.className = "amount";
    amount.textContent = (Number(a.available) / 1e8).toFixed(2);
    const unit = document.createElement("span");
    unit.textContent = "HBAR";
    amount.append(unit);

    const of = document.createElement("div");
    of.className = "of";
    of.textContent = `of ${(Number(a.budget_total) / 1e8).toFixed(2)} granted` +
                     `  ·  ${(Number(a.per_call_max) / 1e8).toFixed(2)} max per draw`;

    // Spent and reserved are different facts and the meter keeps them apart:
    // one is gone, the other is an authorisation in flight that may yet come
    // back. Collapsing them would make a held reservation look like a loss.
    const spent = Number(a.budget_total) - Number(a.available) - Number(a.reserved ?? 0);
    const meter = document.createElement("div");
    meter.className = "meter";
    const s1 = document.createElement("i");
    s1.className = "spent"; s1.style.width = pct(spent);
    const s2 = document.createElement("i");
    s2.className = "held"; s2.style.width = pct(a.reserved ?? 0);
    meter.append(s1, s2);

    el.append(row, amount, of, meter);

    const grants = document.createElement("div");
    grants.className = "grants";
    for (const g of a.grants ?? []) {
      const chip = document.createElement("span");
      chip.className = "grant";
      chip.textContent = `${g.name} ${g.used}/${g.limit}`;
      grants.append(chip);
    }
    if (!a.grants?.length) {
      const chip = document.createElement("span");
      chip.className = "grant";
      chip.textContent = "no capabilities granted";
      grants.append(chip);
    }
    if (a.calls?.contracts?.length) {
      const chip = document.createElement("span");
      chip.className = "grant";
      chip.textContent = `may call ${a.calls.contracts[0]}`;
      grants.append(chip);
    }
    el.append(grants);

    if (!a.known_to_broker) {
      const warn = document.createElement("span");
      warn.className = "grant";
      warn.textContent = "on the device, unknown to the broker";
      grants.append(warn);
    }

    el.onclick = () => { selected = a.slot; refresh(); };
    box.append(el);
  }
  return d;
}

/* ------------------------------------------------------------ envelope -- */

async function refresh() {
  const fleet = await paintFleet();
  // Kept for the thinking columns, which need to label an agent with the slot
  // the *device* put it in rather than the one it says it is in.
  window.__fleet = fleet?.agents ?? [];
  const row = fleet?.agents?.find((a) => a.slot === selected && !a.free);

  $("sel-name").textContent = row?.label ?? "no agent selected";
  $("sel-slot").textContent = row ? `slot ${row.slot}` : "";
  $("try-as").textContent = row ? `as ${row.label}` : "as —";

  let d;
  try {
    d = await api(`envelope?slot=${selected ?? 0}`);
  } catch {
    return null;
  }

  // Unreadable is not empty. Saying "no mandate in the chip" to someone whose
  // Flex is merely on the dashboard describes a revoked fleet — which is the
  // one picture this console must never draw by accident.
  if (d.unknown) {
    $("available").textContent = "—";
    // textContent, not innerHTML: `why` is a string the device handed us, and
    // this page asserts elsewhere that nothing it is handed becomes markup.
    const li = document.createElement("li");
    li.className = "none";
    li.textContent = d.why ?? "the device did not answer";
    $("payees").replaceChildren(li);
    return null;
  }

  if (!d.mandate) {
    $("available").textContent = "—";
    $("payees").innerHTML = '<li class="none">a human must grant an envelope on the device</li>';
    return null;
  }

  paintEnvelopeFrom(d, fleet);
  return d;
}

/**
 * Draw an envelope, live or recorded.
 *
 * Same code either way. Two painters would be two things to keep in step, and
 * the one nobody looks at is the one that rots.
 */
function paintEnvelopeFrom(d, fleet = null) {
  const m = d.mandate;
  $("available").textContent = hbar(m.available);
  $("percall").textContent = hbar(m.per_call_max);
  $("draws").textContent = m.draws_so_far;

  const total = Number(m.budget_total) || 1;
  const pct = (x) => `${Math.max(0, (Number(x) / total) * 100)}%`;
  const bar = $("bar");
  bar.querySelector(".spent").style.width = pct(m.spent);
  bar.querySelector(".held").style.width = pct(m.reserved);

  // The three numbers at the top of the page, from the chip and the fleet.
  const liveAgents = (fleet?.agents ?? []).filter((a) => !a.free && !a.unknown);
  $("c-agents").textContent = String(liveAgents.length);
  $("c-left").textContent =
    (liveAgents.reduce((t, a) => t + Number(a.available), 0) / 1e8).toFixed(2);
  $("c-draws").textContent =
    String(liveAgents.reduce((t, a) => t + Number(a.draws ?? 0), 0));

  $("payees").innerHTML = "";
  for (const p of m.payees ?? []) {
    const li = document.createElement("li");
    li.textContent = p;
    const note = document.createElement("em");
    note.textContent = "anything else is refused in the chip";
    li.append(note);
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
        const why = document.createElement("em");
        why.textContent = calls.selectors.join(" ");
        li.append(why);
      }
      $("contracts").append(li);
    }
  }

  const bound = calls?.proceeds ?? "unknown — this chip predates contract calls";
  // The rate limit sits with the other hardware bounds, because that is what
  // it is — and amber would put it with the advisory ones, which it is not.
  const rate = $("rate");
  if (rate) {
    rate.innerHTML = "";
    const li = document.createElement("li");
    if (m.velocity) {
      const v = m.velocity;
      const per = v.window_seconds % 3600 === 0
        ? `${v.window_seconds / 3600} hour(s)`
        : v.window_seconds % 60 === 0 ? `${v.window_seconds / 60} minute(s)`
        : `${v.window_seconds} seconds`;
      li.textContent = `${v.max_per_window} draws per ${per}`;
      const used = document.createElement("em");
      used.textContent = `${v.used_in_window} used in this window`;
      li.append(used);
    } else {
      li.className = "none";
      li.textContent = "no rate limit";
    }
    rate.append(li);
  }

  const pr = $("proceeds");
  pr.innerHTML = "";
  const prLi = document.createElement("li");
  prLi.textContent = bound;
  if (calls?.recipient_arg == null) prLi.className = "none";
  pr.append(prLi);

  const denied = d.advisory?.denied ?? [];
  $("denied").innerHTML = denied.length
    ? ""
    : '<li class="none">nothing flagged</li>';
  for (const x of denied) {
    const li = document.createElement("li");
    // Amber, not green. The enclave is advice: it narrows what the gateway
    // will ask for and cannot narrow what the chip will sign. Drawing it in
    // the same colour as a hardware bound would claim an authority it has
    // not got.
    li.className = "advisory";
    li.textContent = x.payee;
    const why = document.createElement("em");
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
    b.className = "act";
    b.disabled = busy || DEMO;
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

/* ------------------------------------------------------------- revoke -- */

async function revoke() {
  const row = FLEET?.agents?.find((a) => a.slot === selected && !a.free);
  if (!row) return;

  const btn = $("revoke");
  btn.disabled = true;
  btn.classList.add("waiting");
  btn.textContent = `waiting for a finger on the device…`;
  $("hint").textContent =
    `the device is asking whether to forget ${row.label}. Nothing has changed yet.`;

  let d;
  try {
    d = await api("revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: row.slot }),
    });
  } catch (e) {
    d = { revoked: false, reason: String(e.message) };
  }

  btn.disabled = false;
  btn.classList.remove("waiting");
  btn.textContent = "Revoke this agent";

  if (d.revoked) {
    event({
      kind: "refused",
      who: "human",
      text: `revoked ${d.was}`,
      detail: "the envelope is gone from NVRAM. Nothing on any host had to " +
              "be rotated, and the agent's next draw fails at the chip.",
    });
    $("hint").textContent = "";
    selected = null;
  } else {
    $("hint").textContent = d.advice ?? d.reason ?? "not revoked";
  }


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

/**
 * Everything the page needs to admit it is a recording.
 *
 * Called when there is no gateway to talk to, or when ?demo says so. The
 * banner appears, every control is disabled, and the fleet is painted from
 * the recording's own snapshot rather than from a device — because a console
 * showing live-looking numbers with nothing behind them is the one thing this
 * project cannot afford to ship.
 */
async function enterDemo(reason) {
  DEMO = true;
  $("demo-banner").hidden = false;
  $("dot").className = "dot demo";
  $("device-text").textContent = "recorded — no device";

  for (const b of document.querySelectorAll("button.act, button.scenario")) {
    b.disabled = true;
    b.title = "inert: this page is replaying a recording";
  }
  $("hint").textContent = reason;
  $("defi-hint").textContent =
    "recorded run — the buttons are inert. Clone the repo to press them.";

  // Paint the chip's half from the recording's own snapshot. Without this a
  // reader sees three agents reasoning against blank budget cards, and the
  // half that is missing is the half that came from the device.
  let rec = null;
  try { rec = await (await fetch("/demo-run.json")).json(); } catch { /* none */ }

  if (rec?.fleet) {
    FLEET = rec.fleet;
    // The reasoning columns label each agent with the slot the *device* put
    // it in. Without this they say "unclaimed slot" beside an agent the
    // recording clearly shows in slot 0.
    window.__fleet = rec.fleet.agents ?? [];
    paintFleetFrom(rec.fleet);
  }
  // The fleet goes in too: the three figures at the top of the page are
  // counted from it, and a recording that showed "0 agents" above three
  // agents would be worse than showing nothing.
  if (rec?.envelope?.mandate) {
    // The heading above the envelope is set by refresh(), which demo mode
    // never reaches — so it read "—" over a fully painted panel.
    const m = rec.envelope.mandate;
    $("sel-name").textContent = m.label ?? "the envelope";
    $("sel-slot").textContent = `slot ${rec.envelope.slot ?? 0}`;
    $("try-as").textContent = `as ${m.label ?? "—"}`;
    paintEnvelopeFrom(rec.envelope, rec.fleet);
  }
  if (rec?.topic) {
    const a = document.createElement("a");
    a.href = `https://hashscan.io/testnet/topic/${rec.topic}`;
    a.target = "_blank"; a.rel = "noopener";
    a.textContent = rec.topic;
    $("topic").textContent = "";
    $("topic").append(a);
    $("verify-link").href = `/verify.html?topic=${rec.topic}`;
  }

  const played = await replayAgents();
  if (!played) {
    $("minds-empty").hidden = false;
    $("minds-empty").textContent = "no recording found at /demo-run.json";
  }
}

(async () => {
  try {
    CONFIG = await (await fetch("/api/config")).json();
  } catch {
    // A static host has no /api. That is the ordinary case for a reader.
    CONFIG = { tiers: [], defi: { swap: { sig: "swapExactHBARForTokens(uint256,address)" } } };
    await enterDemo("no gateway on this origin — replaying a recorded run");
    return;
  }
  if (DEMO) { await enterDemo("replaying a recorded run"); return; }
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
  // Carry the topic across, so "check it yourself" is a link rather than an
  // instruction to type something.
  if (CONFIG?.topic) $("verify-link").href = `/verify.html?topic=${CONFIG.topic}`;
  $("revoke").onclick = revoke;
  for (const b of document.querySelectorAll("button.scenario")) {
    b.onclick = () => runScenario(b.dataset.case);
  }
  $("sig-good").textContent = CONFIG.defi.swap.sig;
  $("sig-steal").textContent = CONFIG.defi.swap.sig;


  await refresh();
  watchAgents();
  // The envelope can change without this page doing anything — another agent
  // draws on it, or a human revokes it on the device.
  setInterval(() => { if (!busy) refresh(); }, 5000);
})();


/* ------------------------------------------------------------- device ----
 * The pill in the corner, and the only part of this page that talks about a
 * Ledger as hardware rather than as a source of numbers.
 *
 * Two ways to reach the device, and the page prefers the one that needs no
 * terminal. WebHID lets it open the Flex itself after a click, which is what
 * the button does. Where WebHID is missing — Safari, Firefox — it falls back
 * to asking the console, which asks host/bridge.py.
 *
 * They cannot both hold it: macOS gives the HID interface to one process. The
 * first version of this button treated that as something to explain, and the
 * result was a Connect that worked and took the rest of the page down with
 * it — fleet, envelope and every figure on screen read the chip through the
 * bridge the browser had just displaced.
 *
 * So connecting does not mean keeping. A tab that opens the Flex lends it
 * back through /api/hid/stream, the console binds the bridge's port, and the
 * gateway never notices the swap. See web/relay.mjs.
 */
let LEDGER = null;         // a WebHidLedger once connected
let LENDING = null;        // the handle that gives it back, while connected
let LENT = null;           // what the console last said about the lend
let hid = null;            // the module, loaded lazily

async function hidModule() {
  if (!hid) hid = await import("/ledger.js");
  return hid;
}

const DEVICE_TITLE = {
  ready: "Connected",
  connect: "Not connected",
  "wrong-app": "Another app is open",
  "no-device": "Not answering",
  "no-bridge": "Bridge not running",
  busy: "Waiting on a screen",
  unknown: "Checking",
};

function paintDevice(d) {
  $("dot").className = `dot ${d.state === "ready" ? "on" : "off"}`;
  $("device-text").textContent = d.label;
  $("device-state").textContent = DEVICE_TITLE[d.state] ?? "Unknown";
  $("device-why").textContent = d.why ?? "";
  $("device").dataset.state = d.state;

  const fix = $("device-fix");
  if (d.fix) { fix.hidden = false; $("device-fix-text").textContent = d.fix; }
  else fix.hidden = true;

  const facts = $("device-facts");
  facts.replaceChildren();
  for (const [k, v] of [["via", d.via], ["app", d.app],
                        ["version", d.version], ["account", d.buyer],
                        // Named because it is the answer to "why does the
                        // rest of the page still work?", which is the
                        // question this whole arrangement exists to settle.
                        ["serving", d.lending ? "the console, on :8099" : null]]) {
    if (!v) continue;
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    facts.append(dt, dd);
  }

  const btn = $("device-connect");
  btn.hidden = d.state === "ready" || !d.canConnect;
  // Only offered when this tab is the one holding the device. Disconnecting
  // a bridge we did not start is not ours to do.
  $("device-disconnect").hidden = !d.lending;
  $("device-retry").textContent = "Check again";
}

/** Read the device the page is holding, if it is holding one. */
async function readOverHid() {
  const info = await LEDGER.appInfo();
  const ok = info.app === "Vela";
  return {
    state: ok ? "ready" : "wrong-app",
    label: ok ? (CONFIG?.buyer ?? "connected") : `open Vela on the Flex`,
    why: ok
      ? (LENT?.lending
          ? "this tab holds the Flex and is answering for the bridge, so the " +
            "rest of the console reads the chip through it"
          : "this tab holds the Flex, but the console is not reading it — " +
            (LENT?.why ?? "the lend stopped"))
      : `the Flex is on '${info.app}', not Vela`,
    fix: ok ? null : "open Vela on the device and stay on it",
    via: "WebHID (this tab)", app: info.app, version: info.version,
    buyer: ok ? CONFIG?.buyer : null,
    lending: Boolean(LENT?.lending),
  };
}

async function probeDevice() {
  // 1. the page's own connection, if it has one
  if (LEDGER) {
    try { return paintDevice(await readOverHid()); }
    catch (e) {
      LEDGER = null;
      return paintDevice({
        state: "no-device", label: "connect Ledger", canConnect: true,
        why: String(e.message ?? e),
      });
    }
  }

  // 2. otherwise the bridge, which may be holding it for the rest of the stack
  let d;
  try { d = await (await fetch("/api/device")).json(); }
  catch { d = { state: "no-bridge", why: "the console could not reach its own API" }; }

  const canConnect = (await hidModule()).supported();
  if (d.state === "ready") {
    return paintDevice({ ...d, via: "host/bridge.py",
                         label: d.buyer ?? "connected",
                         why: "host/bridge.py is holding the device" });
  }
  if (d.state === "wrong-app") {
    return paintDevice({ ...d, via: "host/bridge.py", canConnect,
                         label: `open ${d.expected ?? "Vela"} on the Flex` });
  }
  return paintDevice({
    ...d, canConnect,
    label: canConnect ? "connect Ledger" : (d.state === "no-bridge" ? "bridge not running" : "no device"),
    // With WebHID available the terminal command is no longer the only way
    // out, so it stops being the headline advice.
    fix: canConnect ? null : d.fix,
    why: canConnect
      ? (d.why ? `${d.why} — or connect this page to the Flex directly` : null)
      : d.why,
  });
}

/**
 * Open the Flex from this tab, then give it back to the console.
 *
 * The lend is not a nicety on the end: if it is refused, this tab is holding
 * a device nothing else can reach, which is the broken state the relay exists
 * to prevent. So a refusal closes the device again rather than keeping it.
 */
async function connectLedger() {
  const m = await hidModule();
  if (!m.supported()) return;
  const btn = $("device-connect");
  btn.disabled = true; btn.textContent = "Waiting for the picker…";
  try {
    LEDGER = (await m.WebHidLedger.existing()) ?? (await m.WebHidLedger.request());
    if (!LEDGER) return;                       // the picker was dismissed
    await LEDGER.open();

    btn.textContent = "Connecting…";
    let settled = false;
    const lent = await new Promise((resolve) => {
      const t = setTimeout(
        () => resolve({ lending: false, why: "the console did not answer" }), 8000);
      LENDING = m.lend(LEDGER, {
        expect: "Vela",
        on: (state) => {
          LENT = state;
          if (!settled) { settled = true; clearTimeout(t); return resolve(state); }
          // After the fact: the console restarted, or another tab got there
          // first on reconnect. Sitting on a device the rest of the stack
          // cannot reach is the state this whole arrangement exists to
          // prevent, so give it back rather than keep it quietly.
          // A blip is not a refusal: EventSource reconnects on its own and
          // dropping the device on every console reload would make a page
          // refresh feel like a disconnection.
          if (!state.lending && !state.transient) disconnectLedger();
          else probeDevice();
        },
      });
    });
    settled = true;

    if (!lent.lending) {
      // Hand it straight back. A tab that cannot share the device should not
      // be the one holding it.
      LENDING?.stop(); LENDING = null; LENT = null;
      await LEDGER.close().catch(() => {});
      LEDGER = null;
      return paintDevice({
        state: "no-device", label: "connect Ledger", canConnect: true,
        why: lent.why ?? "this console could not take the device",
        fix: "stop host/bridge.py, then connect again",
      });
    }

    await probeDevice();
    // The fleet and the envelope have been failing against a bridge that was
    // not there. They work now, and waiting five seconds for the next tick to
    // prove it makes a working Connect look broken.
    refresh().catch(() => {});
  } catch (e) {
    LENDING?.stop(); LENDING = null; LENT = null;
    LEDGER = null;
    paintDevice({
      state: "no-device", label: "connect Ledger", canConnect: true,
      why: String(e.message ?? e),
    });
  } finally {
    btn.disabled = false; btn.textContent = "Connect Ledger";
  }
}

/** Give the Flex back to the operating system, and say so. */
async function disconnectLedger() {
  LENDING?.stop(); LENDING = null; LENT = null;
  if (LEDGER) await LEDGER.close().catch(() => {});
  LEDGER = null;
  await probeDevice();
  refresh().catch(() => {});
}

if ($("device").addEventListener) {
  $("device").addEventListener("click", () => {
    const panel = $("device-panel");
    const open = panel.hidden;
    panel.hidden = !open;
    $("device").setAttribute("aria-expanded", String(open));
    if (open) probeDevice();
  });
  $("device-connect").addEventListener("click", (e) => { e.stopPropagation(); connectLedger(); });
  $("device-disconnect").addEventListener("click", (e) => {
    e.stopPropagation(); disconnectLedger();
  });
  $("device-retry").addEventListener("click", (e) => {
    e.stopPropagation();
    $("device-retry").textContent = "Checking…";
    probeDevice();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#device-panel") && !e.target.closest("#device")) {
      $("device-panel").hidden = true;
      $("device").setAttribute("aria-expanded", "false");
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $("device-panel").hidden = true;
  });

  // Deliberately not re-opened on load. A device granted in an earlier visit
  // can be opened again without a click, and doing so took the Flex away from
  // a running bridge the moment the page was refreshed — no button pressed,
  // no way to tell from the screen. Taking the device is a decision, so it
  // waits for someone to make it.
  //
  // The tab does release it on the way out, so a reload does not leave the
  // console holding a port with nothing behind it.
  window.addEventListener("pagehide", () => { LENDING?.stop(); });
  probeDevice();
  setInterval(probeDevice, 8000);
}

/* --------------------------------------------------------- operations ----
 * Buttons that start something, and a pane that shows it happening.
 *
 * The page names an operation by key; the server holds the list and builds
 * the argv. Output is streamed because these take between two seconds and
 * five minutes, and because the device's own prompts arrive on that channel —
 * ">>> approve 'remote-1' on the device <<<" is the point of pressing Grant,
 * and it has to be readable the moment it appears rather than at the end.
 */
let opRunning = null;

function opLine(text) {
  const log = $("ops-log");
  // The device's asks are the only thing here that needs a person, so they
  // are the only thing given weight. Everything else is a transcript.
  const bold = /^\s*>>>/.test(text);
  const node = bold ? document.createElement("b") : document.createTextNode(text);
  if (bold) node.textContent = text;
  log.append(node);
  $("ops-out").scrollTop = $("ops-out").scrollHeight;
}

async function runOp(op, params = {}) {
  if (opRunning) return;
  opRunning = op;

  const buttons = document.querySelectorAll("#ops .act");
  buttons.forEach((b) => (b.disabled = true));
  const pressed = document.querySelector(`#ops .act[data-op="${op}"]`);
  const was = pressed ? pressed.textContent : "";
  if (pressed) pressed.textContent = "Running…";

  $("ops-out").hidden = false;
  $("ops-log").replaceChildren();

  try {
    const r = await fetch("/api/ops", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op, ...params }),
    });

    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      opLine(e.error ?? `the console refused: ${r.status}\n`);
      return;
    }

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      opLine(dec.decode(value, { stream: true }));
    }
  } catch (e) {
    opLine(`\n${e.message ?? e}\n`);
  } finally {
    opRunning = null;
    buttons.forEach((b) => (b.disabled = false));
    if (pressed) pressed.textContent = was;
    // Anything here can change what the chip holds, so re-read rather than
    // let the page keep showing what was true before the button.
    refresh?.();
    probeDevice?.();
  }
}

document.querySelectorAll("#ops .act[data-op]").forEach((b) => {
  b.addEventListener("click", () => {
    const op = b.dataset.op;
    const params = op === "grant"
      ? { label: $("grant-label").value.trim(),
          budget: $("grant-budget").value.trim(),
          ceiling: $("grant-ceiling").value.trim() }
      : {};
    runOp(op, params);
  });
});
