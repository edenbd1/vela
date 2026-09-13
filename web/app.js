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
// Set while the chip is mid-operation. Declared up here with the rest of the
// page's state rather than beside lockActions: paintTiers reads it, and
// paintTiers runs during the first refresh, which is well before the bottom
// of this file has executed.
let DEVICE_BUSY = false;

async function api(path, opts) {
  const r = await fetch(`/api/${path}`, opts);
  return r.json();
}

/* ---------------------------------------------------------------- feed -- */

/**
 * The chip's statement, read with the verifier's own parser.
 *
 * web/chain.js decodes these 29 bytes to check the signature over them, and
 * this page shows them under the payment that produced them. Two decoders of
 * one wire format is one decoder that can drift from the thing it is meant to
 * be checking, so there is one, and test/chain-parity.test.mjs holds it.
 */
let chainMod = null;
async function statementOf(hex) {
  if (!hex) return null;
  if (!chainMod) chainMod = await import("/chain.js");
  const said = chainMod.readStatement(hex);
  if (!said) return null;
  const hbar8 = (n) => `${(Number(n) / 1e8).toFixed(4)} HBAR`;
  return {
    slot: String(said.slot),
    draw: String(said.seq),
    payee: `0.0.${said.payee}`,
    amount: hbar8(said.amount),
    left: hbar8(said.remaining),
  };
}

function event({ kind, who, text, detail, link, signed }) {
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
  if (signed?.said) {
    const dl = document.createElement("dl");
    dl.className = "signed";
    const rows = [...Object.entries(signed.said),
                  ["signature", signed.signature ?? "—"]];
    for (const [k, val] of rows) {
      const dt = document.createElement("dt"); dt.textContent = k;
      const dd = document.createElement("dd"); dd.textContent = val;
      dl.append(dt, dd);
    }
    li.append(dl);
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

  // The thinking columns label each agent with the slot the *device* put it
  // in, and they are built from an event stream that replays the moment the
  // page connects — before this fetch has answered. Re-label them now that it
  // has, or a column says "unclaimed slot" directly above a fleet card
  // showing the slot.
  relabelSlots?.();

  // The operations buttons act on the selected agent, so they say which one.
  // "Run one here" ran research-1 whatever the page had highlighted, which is
  // the kind of thing nobody notices until the wrong agent spends.
  $("ops-subject").textContent = row?.label ?? "none";
  const here = $("op-agent-here");
  here.textContent = row ? `Run ${row.label} here` : "Run it here";
  here.disabled = !row;

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
    // DEVICE_BUSY as well as busy: this row is rebuilt on every refresh, and
    // a refresh during a grant put the Buy buttons back while the chip was
    // still holding a screen up.
    b.disabled = busy || DEMO || DEVICE_BUSY;
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
  lockActions(true);
  // Not "approve on your device". The difference between this and Grant is
  // the product, and the banner is where someone actually reads it.
  deviceSigns(`${tier.price} HBAR to the ${tier.label} tier — no tap needed.`);
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
    lockActions(false);
    deviceIdle();
    $("hint").textContent = `request failed: ${e.message}`;

    await refresh();
    return;
  }

  if (d.paid) {
    deviceDone(`Signed ${hbar(d.spent)} in the chip, without a tap.`);
    const said = await statementOf(d.signed?.statement);
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
      // The bytes the Secure Element put its name to. Everything else on this
      // page is the host's account of what the chip decided; this is the
      // chip's own, and the same 29 bytes go on the public topic.
      signed: said && { said, signature: d.signed?.signature },
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
    deviceDone(`The chip refused — ${d.reason}. Nothing was signed.`, 7000);
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
  lockActions(false);
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
  lockActions(true);
  // A swap is a signature too, and one the chip builds itself rather than
  // being handed. Same banner as a payment, and the same point: nobody taps.
  deviceSigns(`a call to ${s.contract} — built and signed on-chip, no tap.`);
  $("defi-hint").textContent = "asking the chip…";
  const d = await api("call", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contract: s.contract, calldata: s.calldata, amount: "1000000" }),
  });

  if (d.signed) {
    deviceDone(`The chip built and signed the call itself.`);
    const said = await statementOf(d.statement?.statement);
    event({ kind: "paid", who: "chip",
            text: `signed a call to ${s.contract}`,
            detail: `${s.sig} — ${d.body_len}-byte body built and signed on-chip, ` +
                    `draw #${d.seq}`,
            signed: said && { said, signature: d.statement?.signature } });
  } else if (d.refused) {
    deviceDone(`The chip refused — ${d.reason}. Nothing was signed.`, 7000);
    event({ kind: "refused", who: "chip",
            text: `refused — ${d.reason}`,
            detail: d.advice });
  } else {
    deviceIdle();
    event({ kind: "refused", who: "gateway",
            text: d.error ?? "no answer", detail: JSON.stringify(d).slice(0, 200) });
  }
  lockActions(false);
  $("defi-hint").textContent = "";


  await refresh();
}

/* ------------------------------------------------------------- revoke -- */

async function revoke() {
  const row = FLEET?.agents?.find((a) => a.slot === selected && !a.free);
  if (!row) return;

  const btn = $("revoke");
  lockActions(true);
  btn.classList.add("waiting");
  btn.textContent = `waiting for a finger on the device…`;
  $("hint").textContent =
    `the device is asking whether to forget ${row.label}. Nothing has changed yet.`;
  deviceAsks(`confirm forgetting ${row.label}. Nothing has changed yet.`);

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

  lockActions(false);
  btn.classList.remove("waiting");
  btn.textContent = "Revoke this agent";

  if (d.revoked) {
    deviceDone(`${d.was} is gone from the chip.`);
  } else {
    deviceIdle();
  }

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
// Whether somebody has pressed Connect in this session. The page reads the
// chip whether or not they have — it is a console, not a wallet — but
// "connected" should mean a person asked for it and got an answer out of the
// device, rather than a poll that happened to succeed.
let CONNECTED = false;
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
  const under = d.keyMatches === true ? "under this device's key"
              : d.keyMatches === false ? "NOT under this device's key"
              : d.key ? "could not check against Hedera" : null;
  for (const [k, v] of [["via", d.via], ["app", d.app],
                        ["version", d.version],
                        // The account and the key side by side, because the
                        // account came out of .env and the key came out of
                        // the chip. Hedera says which one owns the other.
                        ["account", d.buyer], ["", under],
                        ["device key", d.key ? `${d.key.slice(0, 16)}…` : null],
                        // Named because it is the answer to "why does the
                        // rest of the page still work?", which is the
                        // question this whole arrangement exists to settle.
                        ["serving", d.lending ? "the console, on :8099" : null]]) {
    if (!v) continue;
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    // The one line here that is a verdict rather than a reading. Green for
    // the account being under the chip's key, the chip's own red for not —
    // the palette's existing meanings, so it needs no legend.
    if (v === under) dd.className = d.keyMatches === true ? "ok" : d.keyMatches === false ? "chip" : "";
    facts.append(dt, dd);
  }

  // The other way in, when there is one. Separate from "To fix", because a
  // working bridge is not a fault and putting it under that heading would
  // read as one.
  const note = $("device-note"), cmd = $("device-note-cmd");
  note.hidden = cmd.hidden = !d.note;
  if (d.note) { note.textContent = d.note; cmd.textContent = d.noteCmd ?? ""; }
  cmd.hidden = !d.noteCmd;

  const btn = $("device-connect");
  btn.hidden = !d.canConnect;
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
    return paintDevice({
      ...d, via: d.via ?? "host/bridge.py",
      label: d.buyer ?? "connected",
      // Connecting through a bridge that is already up is not a no-op: it is
      // what reads the key out of the chip and checks the account against
      // Hedera. Until someone asks, this panel is repeating .env.
      canConnect: !CONNECTED,
      why: CONNECTED
        ? `read from the device, through ${d.via ?? "host/bridge.py"}`
        : `${d.via ?? "host/bridge.py"} is holding the device`,
      // Only worth saying when this browser could actually take over, and
      // only when it is not already the thing holding it.
      note: canConnect && !/WebHID/.test(d.via ?? "")
        ? "This tab can hold the Flex itself, with no bridge process. " +
          "Stop the bridge first — one process gets the USB interface — " +
          "then press Connect Ledger."
        : null,
      noteCmd: canConnect && !/WebHID/.test(d.via ?? "")
        ? "pkill -f host/bridge.py" : null,
    });
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
  const btn = $("device-connect");

  // Route one: something is already holding the device for this console. Then
  // connecting means asking the chip who it is and checking that against
  // Hedera — no picker, no permission prompt, and it works in every browser.
  btn.disabled = true; btn.textContent = "Reading the device…";
  try {
    const d = await (await fetch("/api/device")).json();
    if (d.state === "ready") {
      CONNECTED = true;
      await probeDevice();
      deviceDone(d.keyMatches === true
        ? `Connected. ${d.buyer} is under the key in this device.`
        : `Connected to ${d.app} ${d.version}.`);
      refresh().catch(() => {});
      return;
    }
  } catch { /* fall through to the browser's own connection */ }
  finally { btn.disabled = false; btn.textContent = "Connect Ledger"; }

  // Route two: nothing is holding it, so this tab opens it itself.
  const m = await hidModule();
  if (!m.supported()) {
    return paintDevice({
      state: "no-bridge", label: "no device", canConnect: false,
      why: "nothing is holding the Flex, and this browser cannot open one",
      fix: "python3 host/bridge.py, or use a Chromium-based browser",
    });
  }
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
          // An instruction on the wire, reported by the tab that is carrying
          // it. Three of the app's commands put a screen up; the rest answer
          // in milliseconds and must not raise a banner.
          if (state.working !== undefined) {
            const asks = ASKS_FOR[state.ins];
            if (state.working && asks) deviceAsks(asks);
            else if (!state.working && asks) deviceIdle();
            return;
          }
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

    CONNECTED = true;
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
  LENDING?.stop(); LENDING = null; LENT = null; CONNECTED = false;
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

/* --------------------------------------------------------- device bar ----
 * What the Flex is asking for, at the top of the page.
 *
 * The console could already make the device put a screen up — Grant, Revoke,
 * Restore — and the only sign of it was one line in a subprocess transcript
 * four cards down, inside a pane that only opens once an operation starts.
 * Someone who had just pressed a button had no reason to look at the device
 * in their hand, and the chip's 180-second approval window ran out in silence.
 *
 * Two states, and the difference between them is the product:
 *
 *   asks     a screen is up and a person has to answer it. Granting an
 *            envelope, revoking one, restoring one.
 *   signs    the chip is deciding on its own, inside a mandate a person
 *            already approved. Every payment. No tap, and saying so each
 *            time is the clearest way to show what the envelope buys.
 */
const ASKS_FOR = {
  0x11: "approve the new envelope",
  0x14: "confirm revoking this agent",
  0x1a: "confirm restoring this envelope",
};

let devbarHold = null;      // a timer holding the "done" state on screen

function devbar(cls, lead, strong) {
  clearTimeout(devbarHold);
  devbarHold = null;
  const msg = $("devbar-msg");
  // Built as nodes, not markup. Some of this text comes back through a
  // subprocess, and this page asserts elsewhere that nothing it is handed
  // becomes markup.
  msg.replaceChildren(document.createTextNode(lead));
  if (strong) {
    const b = document.createElement("b");
    b.textContent = strong;
    msg.append(b);
  }
  // The state class goes on the bar; the wrapper is what sticks and what
  // gets hidden.
  const wrap = $("devbar");
  wrap.querySelector(".devbar").className = `devbar${cls ? ` ${cls}` : ""}`;
  wrap.hidden = false;
}

/** A screen is up on the Flex and it is waiting for a person. */
const deviceAsks = (what) => devbar("", "Look at your Flex — ", what);

/** The chip is deciding inside a mandate. Nothing to press. */
const deviceSigns = (what) =>
  devbar("", "Signing in the Secure Element — ", what);

/** It decided. Held briefly, then gone: a banner that never clears is noise. */
function deviceDone(what, ms = 5000) {
  devbar("done", "", what);
  devbarHold = setTimeout(() => { $("devbar").hidden = true; }, ms);
}

function deviceIdle() {
  clearTimeout(devbarHold);
  devbarHold = null;
  $("devbar").hidden = true;
}

/**
 * One device, one operation at a time.
 *
 * The chip answers one APDU at a time and a grant holds it for as long as a
 * person takes to read four screens. Two buttons pressed in that window do
 * not queue, they collide — and the second one's failure looks like the chip
 * refusing. Inputs stay editable: it is the device that is busy, not the page.
 */
function lockActions(locked) {
  DEVICE_BUSY = locked;
  for (const b of document.querySelectorAll(
      "#tiers .act, #ops .act[data-op], #revoke, button.scenario")) {
    b.disabled = locked;
  }
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
  // A device prompt is also the one line here that someone has to act on, and
  // this pane is four cards down inside a section that only opens once an
  // operation starts. So it goes to the banner as well as the transcript.
  const ask = text.match(/>>>\s*(.*?)\s*<<</);
  // "on the device" is what the terminal has to say and the banner does not:
  // it is already telling someone to look at the Flex.
  if (ask) deviceAsks(ask[1].replace(/\s+on the device\b/, ""));
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

  lockActions(true);
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
    lockActions(false);
    buttons.forEach((b) => (b.disabled = false));
    if (pressed) pressed.textContent = was;
    // The banner outlives the operation only if it has something to say. A
    // prompt left on screen after the thing it was asking about has finished
    // is worse than none: it sends someone to a device that is asking nothing.
    deviceIdle();
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
      // The selected agent, by the label the chip gave it — not the one the
      // broker thinks it has. The device is the one that cannot be edited.
      : op === "agent-here"
      ? { agent: FLEET?.agents?.find((a) => a.slot === selected)?.label }
      : {};
    runOp(op, params);
  });
});
