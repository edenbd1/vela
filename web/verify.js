/**
 * Verification, in the reader's browser, against Hedera and nothing else.
 *
 * The chain arithmetic lives in chain.js and is checked line-for-line against
 * the Node implementation by test/chain-parity.test.mjs — a second verifier
 * is a second thing that can be wrong, and "the browser said it was fine" is
 * the worst way to find that out.
 */
import { readTopic, byEnvelope, checkChain, checkAnchor, checkTransfer,
         deviceKeyOf } from "./chain.js";

const $ = (id) => document.getElementById(id);

const li = (state, text) => {
  const el = document.createElement("li");
  el.className = state === true ? "paid" : state === false ? "chip" : "host";
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = state === true ? "ok" : state === false ? "fail" : "?";
  const body = document.createElement("span");
  body.textContent = text;
  el.append(who, body);
  return el;
};

function panel(title, note) {
  const s = document.createElement("div");
  s.className = "panel";
  s.style.marginBottom = "18px";
  const h = document.createElement("h2");
  h.className = "section";
  h.style.fontSize = "15px";
  h.textContent = title;
  if (note) {
    const n = document.createElement("span");
    n.className = "src";
    n.textContent = note;
    h.append(n);
  }
  const ol = document.createElement("ol");
  ol.className = "log";
  s.append(h, ol);
  return { s, ol };
}

async function run() {
  const topic = $("topic-in").value.trim();
  const out = $("results");
  out.innerHTML = "";
  $("go").disabled = true;
  $("status").textContent = `reading topic ${topic} from the mirror node…`;

  let records;
  try {
    records = await readTopic(topic);
  } catch (e) {
    $("status").textContent = `could not read that topic: ${e.message}`;
    $("go").disabled = false;
    return;
  }

  if (!records.length) {
    $("status").textContent =
      "no Vela records on that topic. Anyone may write to a public topic, so " +
      "an empty result means none of the messages were ours.";
    $("go").disabled = false;
    return;
  }

  const groups = byEnvelope(records);
  $("status").textContent =
    `${records.length} record(s), ${groups.size} envelope(s). Checking…`;

  let whole = 0;

  for (const [key, rs] of groups) {
    const [digest, instance] = key.split("/");
    const { s, ol } = panel(
      `envelope ${digest.slice(0, 16)}…`,
      `granted ${instance} · ${rs.length} draw(s)`);
    out.append(s);

    let failed = false;
    const note = (state, text) => {
      if (state === false) failed = true;
      ol.append(li(state, text));
    };

    for (const [ok, why] of checkChain(rs)) note(ok, why);

    // Settlement, then the chip's signature. The device key is read off the
    // account the log says was debited — so the key comes from Hedera too,
    // not from anything this page was told.
    let deviceKey = null;
    for (const r of rs) {
      const [ok, why] = await checkTransfer(r);
      note(ok, why);
      if (ok && !r.r && !r.c && !deviceKey && r.payer) {
        deviceKey = await deviceKeyOf(r.payer);
        if (deviceKey) {
          note(true, `the debited account ${r.payer} is under ` +
                     `${[...deviceKey].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("")}…`);
        }
      }
    }
    for (const r of rs) {
      const [ok, why] = await checkAnchor(r, deviceKey);
      note(ok, why);
    }

    const verdict = document.createElement("p");
    verdict.className = "onefield";
    verdict.style.borderLeftColor = failed ? "var(--chip)" : "var(--ok)";
    verdict.textContent = failed
      ? "incomplete — this envelope does not verify"
      : "complete and consistent";
    s.append(verdict);
    if (!failed) whole++;
  }

  $("status").textContent =
    `${whole} of ${groups.size} envelope(s) verify — checked here, in this browser.`;
  $("go").disabled = false;
}

$("go").onclick = run;
$("topic-in").onkeydown = (e) => { if (e.key === "Enter") run(); };

// A topic in the query string makes the result linkable, which is the point:
// "check it yourself" should be a URL, not an instruction.
const asked = new URLSearchParams(location.search).get("topic");
if (asked) { $("topic-in").value = asked; run(); }
