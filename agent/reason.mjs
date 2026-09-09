/**
 * An agent that actually decides.
 *
 * Everything else here was called an agent and reasoned about nothing: it
 * screened a hardcoded list and bought a fixed tier. That is a payment
 * substrate with an agent-shaped hole in it, and on a track about agents it
 * is the wrong half to have built.
 *
 * This one runs a model locally — Ollama, so it costs nothing and needs no
 * key on a host that is supposed to hold none — gives it four tools, and lets
 * it choose. The interesting behaviour is not that it succeeds. It is what
 * happens when the chip says no: the refusal comes back as a fact with a
 * reason, the model reads it, and picks something that fits. The hardware
 * boundary is part of the environment the agent has to reason about, which is
 * the argument made from the agent's side rather than the operator's.
 *
 * On decoding. The obvious build is Ollama's native tool-calling API, and it
 * was the first one, and it broke: hermes3 answers the first round of tool
 * calls in prose and then never emits another tool call, no matter how it is
 * prompted — see /tmp reproduction notes in docs/AGENT-LOOP.md. That is a
 * chat-template artefact, not a reasoning failure, and it is not worth
 * building a demo on. So every turn is decoded against a JSON schema
 * instead: llama.cpp constrains sampling to the grammar, so the model cannot
 * emit anything but one well-formed decision. It works on any model, which
 * matters because a judge will run this with whatever they have pulled.
 *
 *   BROKER=… GATEWAY=… AGENT_TOKEN=… node agent/reason.mjs
 */
const OLLAMA = process.env.OLLAMA ?? "http://127.0.0.1:11434";
const MODEL = process.env.AGENT_MODEL ?? "hermes3:8b";
const BROKER = process.env.BROKER ?? "http://127.0.0.1:4060";
const GATEWAY = process.env.GATEWAY ?? "http://127.0.0.1:4030";
const TOKEN = process.env.AGENT_TOKEN ?? "";
const NAME = process.env.AGENT_NAME ?? "research-1";
const MAX_STEPS = Number(process.env.AGENT_STEPS ?? 12);

const COUNTERPARTIES = (process.env.COUNTERPARTIES ??
  "0.0.10388937,0.0.66666666,0.0.10365984").split(",");

const auth = () => (TOKEN ? { authorization: `Bearer ${TOKEN}` } : {});
const hbar = (t) => `${Number(t) / 1e8} HBAR`;

async function api(url, body) {
  const r = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...auth() },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

/* ------------------------------------------------------------ decision --- */

/**
 * One decision, per turn.
 *
 * Flat rather than nested because grammar-constrained decoding on a small
 * model is markedly more reliable over a flat object, and the unused fields
 * cost a few tokens. `thought` comes first on purpose: the model writes its
 * reasoning before it commits to a tool, which is the cheap version of
 * thinking out loud and measurably improves what it picks.
 */
const DECISION = {
  type: "object",
  properties: {
    thought: { type: "string" },
    tool: {
      type: "string",
      enum: ["check_envelope", "screen_counterparty", "buy_analysis", "report"],
    },
    account: { type: "string" },
    tier: { type: "string", enum: ["triage", "synthesis", "exhaustive"] },
    verdict: { type: "string" },
  },
  required: ["thought", "tool"],
};

const SYSTEM = `You are a research agent that pays for what it uses.

You hold no API keys and no private keys. Tools act on your behalf, and a
hardware device authorises every payment. It can refuse one, and you cannot
talk it out of a refusal.

Each turn, choose exactly one tool:

  check_envelope       what you may spend. No arguments.
  screen_counterparty  set "account". Returns a risk score 0-100, higher is worse.
  buy_analysis         set "tier": triage (0.01 HBAR, shallow),
                       synthesis (0.08 HBAR, deep),
                       exhaustive (0.15 HBAR, the most thorough).
  report               set "verdict". This ends the run.

Rules you are held to:

  Check your envelope before you buy anything. Never state an amount you have
  not read from check_envelope.

  A refusal is an answer, not an error. Read its reason. When
  retrying_will_help is false the device will refuse identically forever —
  choose something different rather than asking again.

  Screen every account you were given before reporting.`;

/* --------------------------------------------------------------- tools --- */

let finished = null;
const spent = [];

async function runTool(d) {
  switch (d.tool) {
    case "check_envelope": {
      const r = await api(`${GATEWAY}/envelope`);
      if (r.error) {
        return { error: `the envelope cannot be read: ${r.error}`,
                 why: "the signing device is not answering. Nothing can be " +
                      "bought until it does, and this is not yours to fix." };
      }
      if (!r.mandate) {
        return { error: "no envelope has been granted to you",
                 why: r.note ?? "a human must grant one on the device",
                 retrying_will_help: false };
      }
      const out = {
        available: hbar(r.mandate.available),
        max_per_payment: hbar(r.mandate.per_call_max),
        may_pay: r.mandate.payees,
      };
      // The advisory narrows the envelope without being part of it. Handed
      // over separately and labelled, so the agent can tell what it cannot do
      // from what it is merely being told not to.
      if (r.advisory?.denied?.length) {
        out.advised_against = r.advisory.denied;
        out.advisory_note =
          "advice from a confidential risk workflow, not a hardware rule. " +
          "It narrows what you should do; it cannot widen what you may do.";
      }
      return out;
    }

    case "screen_counterparty": {
      const account = String(d.account ?? "").trim();
      if (!account) return { error: 'set "account" to a Hedera account id' };
      const r = await api(`${BROKER}/do/risk.screen`, { params: { account } });
      if (!r.ok) return { refused: r.reason, why: r.advice,
                          retrying_will_help: false };
      return { account: r.result.account, score: r.result.score,
               reason: r.result.reason };
    }

    case "buy_analysis": {
      const tier = String(d.tier ?? "").trim();
      if (!tier) return { error: 'set "tier" to triage, synthesis or exhaustive' };
      const r = await api(`${GATEWAY}/pay`, { service: tier });
      if (r.paid) {
        spent.push(Number(r.spent));
        return { bought: tier, cost: hbar(r.spent), result: r.response,
                 left: hbar(r.remaining) };
      }
      // The point of the whole project, handed over as something the agent
      // can act on: a reason, and whether asking again could ever help.
      return {
        refused: r.reason ?? "not_settled",
        why: r.advice ?? r.detail?.header?.errorMessage ??
             "the payment did not settle",
        retrying_will_help: r.terminal === false,
      };
    }

    case "report":
      finished = String(d.verdict ?? "").trim() || "(no verdict given)";
      return { ok: true };

    default:
      return { error: `there is no tool named ${d.tool}` };
  }
}

/* ---------------------------------------------------------------- loop --- */

const messages = [
  { role: "system", content: SYSTEM },
  { role: "user", content:
      `Assess counterparty risk across these accounts: ` +
      `${COUNTERPARTIES.join(", ")}. Screen each one, then buy the most ` +
      `thorough analysis your envelope actually allows, and report a verdict.` },
];

/** Only the fields that tool takes, so the log reads like what happened. */
function callSig(d) {
  const arg = d.tool === "screen_counterparty" ? d.account
            : d.tool === "buy_analysis" ? d.tier
            : "";
  return `${d.tool}${arg ? `(${arg})` : "()"}`;
}

console.log(`\nagent ${NAME}  ·  ${MODEL} on ${OLLAMA}`);
console.log(`  it holds no keys. It decides; the chip decides whether it may.\n`);

let checked = false;    // it read its envelope
let attempted = false;  // it tried to, whatever came back
let pushbacks = 0;

for (let step = 1; step <= MAX_STEPS && finished === null; step++) {
  let res;
  try {
    res = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL, messages, format: DECISION, stream: false,
        // Low, because this agent spends money. Sampling variety is a fine
        // thing in a chatbot and a liability in something holding a mandate.
        options: { temperature: 0.1 },
      }),
    }).then((r) => r.json());
  } catch (e) {
    console.log(`  the model is unreachable at ${OLLAMA}: ${e.message}`);
    console.log(`  start it with: ollama serve`);
    process.exit(1);
  }

  if (res.error) {
    console.log(`  the model refused the request: ${res.error}`);
    console.log(`  pull a model first: ollama pull ${MODEL}`);
    process.exit(1);
  }

  let d;
  try {
    d = JSON.parse(res.message?.content ?? "");
  } catch {
    // Grammar-constrained decoding should make this impossible. If a runtime
    // ignores `format` it is better to stop than to guess at intent with a
    // mandate in hand.
    console.log(`  the model did not return a decision: ` +
                `${(res.message?.content ?? "").slice(0, 120)}`);
    break;
  }

  // A model that reports without ever having looked at its envelope is
  // reporting a number it made up — hermes3 did exactly that on the first
  // run here, announcing 100 HBAR against an envelope holding half of one.
  // A policy that asks an agent to stay within its means is trusting a thing
  // that invents its means. Push back once; the chip is what actually stops it.
  // Attempted, not checked: an agent that asked and was told the device is
  // down has done the honest thing, and reporting that is the right answer.
  // Pushing back there would be scolding it for someone else's outage.
  if (d.tool === "report" && !attempted && pushbacks < 2) {
    pushbacks++;
    console.log(`  ${String(step).padStart(2)}  report — refused`);
    console.log(`      you have not called check_envelope`);
    messages.push(res.message, { role: "user", content:
      "You have not called check_envelope, so any figure in that verdict is " +
      "one you invented. Call check_envelope." });
    continue;
  }

  console.log(`  ${String(step).padStart(2)}  ${callSig(d)}`);
  if (d.thought) console.log(`      · ${d.thought.slice(0, 100)}`);

  const out = await runTool(d);
  if (d.tool === "check_envelope") {
    attempted = true;
    checked = !out.error;
  }

  const summary = out.refused
    ? `REFUSED ${out.refused} — ${out.why}`
    : out.error
      ? `error: ${out.error}`
      : Object.entries(out).filter(([k]) => k !== "advisory_note").slice(0, 3)
          .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
          .join("  ");
  if (d.tool !== "report") console.log(`      ${summary}`);

  messages.push(res.message,
                { role: "user", content: `Result of ${d.tool}: ${JSON.stringify(out)}` });
}

console.log();
if (finished) {
  console.log(`verdict  ${finished.slice(0, 400)}`);
} else {
  console.log(`the agent ran out of steps without reporting.`);
}
const total = spent.reduce((a, b) => a + b, 0);
console.log(`spent    ${hbar(total)} across ${spent.length} payment(s)`);
if (!checked) {
  console.log(`         it never managed to read its envelope, so nothing it`);
  console.log(`         says about money is a figure it looked up.`);
}
console.log(`         every one authorised inside a Secure Element this`);
console.log(`         process cannot reach.\n`);
process.exit(finished ? 0 : 1);
