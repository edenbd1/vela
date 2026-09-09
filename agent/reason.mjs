/**
 * An agent that actually decides.
 *
 * Everything else here was called an agent and reasoned about nothing: it
 * screened a hardcoded list and bought a fixed tier. That is a payment
 * substrate with an agent-shaped hole in it, and on a track about agents it
 * is the wrong half to have built.
 *
 * This one runs a model locally — Ollama, so it costs nothing and needs no
 * key on a host that is supposed to hold none — gives it four tools, and
 * lets it choose. The interesting behaviour is not that it succeeds. It is
 * what happens when the chip says no: the refusal comes back as a fact with a
 * reason, the model reads it, and picks something that fits. The hardware
 * boundary is part of the environment the agent has to reason about, which is
 * the whole argument made from the agent's side rather than the operator's.
 *
 *   BROKER=… GATEWAY=… AGENT_TOKEN=… node reason.mjs
 */
const OLLAMA = process.env.OLLAMA ?? "http://127.0.0.1:11434";
const MODEL = process.env.AGENT_MODEL ?? "hermes3:8b";
const BROKER = process.env.BROKER ?? "http://127.0.0.1:4060";
const GATEWAY = process.env.GATEWAY ?? "http://127.0.0.1:4030";
const TOKEN = process.env.AGENT_TOKEN ?? "";
const NAME = process.env.AGENT_NAME ?? "research-1";
const MAX_STEPS = Number(process.env.AGENT_STEPS ?? 10);

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

/* ------------------------------------------------------------- tools ---- */

const TOOLS = [
  {
    type: "function",
    function: {
      name: "check_envelope",
      description:
        "What this agent is allowed to spend. Returns the amount left and the " +
        "ceiling on any single payment. Check this before choosing what to buy.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "screen_counterparty",
      description:
        "Screen one Hedera account against a private risk feed. Returns a " +
        "score from 0 to 100 and a reason. Higher is worse.",
      parameters: {
        type: "object",
        properties: { account: { type: "string", description: "e.g. 0.0.10388937" } },
        required: ["account"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "buy_analysis",
      description:
        "Buy one analysis. Tiers: triage (0.01 HBAR, shallow), synthesis " +
        "(0.08 HBAR, deep), exhaustive (0.15 HBAR, the most thorough). " +
        "Payment is authorised by a hardware device and may be refused.",
      parameters: {
        type: "object",
        properties: {
          tier: { type: "string", enum: ["triage", "synthesis", "exhaustive"] },
        },
        required: ["tier"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "report",
      description: "Give the final verdict and stop.",
      parameters: {
        type: "object",
        properties: { verdict: { type: "string" } },
        required: ["verdict"],
      },
    },
  },
];

let finished = null;
const spent = [];

async function runTool(name, args) {
  switch (name) {
    case "check_envelope": {
      const d = await api(`${GATEWAY}/envelope`);
      if (d.error) {
        return { error: `the envelope cannot be read: ${d.error}`,
                 why: "the signing device is not answering. Nothing can be " +
                      "bought until it does; this is not yours to fix." };
      }
      if (!d.mandate) {
        return { error: "no envelope has been granted to you",
                 why: d.note ?? "a human must grant one on the device" };
      }
      const out = {
        available: hbar(d.mandate.available),
        max_per_payment: hbar(d.mandate.per_call_max),
        may_pay: d.mandate.payees,
      };
      // The advisory narrows the envelope without being part of it. Handing
      // it over separately, labelled, is the honest shape: the agent should
      // be able to tell what it cannot do from what it is being told not to.
      if (d.advisory?.denied?.length) {
        out.advised_against = d.advisory.denied;
        out.advisory_note =
          "advice from a confidential risk workflow, not a hardware rule. " +
          "It narrows what you should do; it cannot widen what you may do.";
      }
      return out;
    }

    case "screen_counterparty": {
      const d = await api(`${BROKER}/do/risk.screen`,
                          { params: { account: String(args?.account ?? "") } });
      if (!d.ok) return { refused: d.reason, why: d.advice };
      return { account: d.result.account, score: d.result.score, reason: d.result.reason };
    }

    case "buy_analysis": {
      const d = await api(`${GATEWAY}/pay`, { service: String(args?.tier ?? "") });
      if (d.paid) {
        spent.push(Number(d.spent));
        return { bought: args.tier, cost: hbar(d.spent), result: d.response,
                 left: hbar(d.remaining) };
      }
      // The point of the whole project, handed to the model as something it
      // can act on: a reason, and whether trying again could ever help.
      return {
        refused: d.reason ?? "not_settled",
        why: d.advice ?? d.detail?.header?.errorMessage ?? "the payment did not settle",
        retrying_will_help: d.terminal === false,
      };
    }

    case "report":
      finished = String(args?.verdict ?? "");
      return { ok: true };

    default:
      return { error: `no tool named ${name}` };
  }
}

/* -------------------------------------------------------------- loop ---- */

const messages = [
  {
    role: "system",
    content:
      "You are a research agent that pays for what it uses. You hold no API " +
      "keys and no private keys: tools do the work on your behalf, and a " +
      "hardware device authorises every payment and can refuse one.\n\n" +
      "A refusal is an answer, not an error. Read its reason. If " +
      "retrying_will_help is false, the device will refuse identically " +
      "forever — choose something different instead of trying again.\n\n" +
      "Check your envelope before choosing what to buy. Call report when you " +
      "have a verdict.",
  },
  {
    role: "user",
    content:
      `Assess counterparty risk across these accounts: ${COUNTERPARTIES.join(", ")}. ` +
      `Screen each one, then buy the most thorough analysis your envelope ` +
      `actually allows, and report a verdict.`,
  },
];

console.log(`\nagent ${NAME}  ·  model ${MODEL}`);
console.log(`  it holds no keys. It decides; the chip decides whether it may.\n`);

let asked = false;   // has it looked at what it may spend?
let bought = false;

for (let step = 1; step <= MAX_STEPS && finished === null; step++) {
  let res;
  try {
    res = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL, messages, tools: TOOLS, stream: false,
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
    process.exit(1);
  }

  const msg = res.message ?? {};
  messages.push(msg);

  const calls = msg.tool_calls ?? [];

  if (calls.length === 0) {
    // A small model will happily narrate a budget it never looked up — this
    // one announced it had 100 HBAR when its envelope held half of one. That
    // is not a bug to paper over: it is the entire argument for putting the
    // limit in silicon, since a policy that asks an agent to stay within its
    // means is trusting a thing that invents its means. So: don't accept
    // prose in place of work. Say what is still undone and let it continue.
    const missing = !asked ? "you have not called check_envelope, so any " +
                             "figure you have in mind is one you invented"
                  : !bought ? "you have not bought anything yet"
                  : null;
    if (missing && step < MAX_STEPS) {
      console.log(`  ${String(step).padStart(2)}  (prose, no tool call)`);
      console.log(`      pushed back: ${missing}`);
      messages.push({
        role: "user",
        content: `Stop. ${missing}. Use the tools. Do not state any amount ` +
                 `you have not read from check_envelope.`,
      });
      continue;
    }
    if (msg.content?.trim()) { finished = msg.content.trim(); break; }
    console.log("  the model returned nothing to act on; stopping.");
    break;
  }

  for (const c of calls) {
    const name = c.function?.name;
    const args = c.function?.arguments ?? {};
    const out = await runTool(name, args);
    if (name === "check_envelope" && !out.error) asked = true;
    if (name === "buy_analysis" && out.bought) bought = true;

    const summary = out.refused
      ? `REFUSED ${out.refused} — ${out.why}`
      : out.error
        ? `error: ${out.error}`
        : Object.entries(out).slice(0, 3)
            .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
            .join("  ");
    console.log(`  ${String(step).padStart(2)}  ${name}(${JSON.stringify(args)})`);
    console.log(`      ${summary}`);

    messages.push({ role: "tool", tool_name: name, content: JSON.stringify(out) });
  }
}

console.log();
if (finished) {
  console.log(`verdict  ${finished.slice(0, 400)}`);
} else {
  console.log(`the agent ran out of steps without reporting.`);
}
const total = spent.reduce((a, b) => a + b, 0);
console.log(`spent    ${hbar(total)} across ${spent.length} payment(s)`);
console.log(`          every one of them authorised inside a Secure Element`);
console.log(`          this process cannot reach.\n`);
