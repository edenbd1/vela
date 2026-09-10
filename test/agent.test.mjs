/**
 * The agent loop, tested without the chip and without the model.
 *
 * The behaviour that matters here is not "can it pay" — the hardware suite
 * covers that. It is: when the Secure Element refuses, does the agent read
 * the refusal and choose something that fits, or does it hammer the same
 * request until its steps run out? That is a property of the loop, and a
 * property should not be demonstrated by getting lucky with an 8B model on
 * demo day.
 *
 * So all three of the agent's dependencies are stood up as fakes on
 * ephemeral ports: a gateway with a real per-call ceiling, a broker, and an
 * Ollama that plays a scripted model. The script under test is the actual
 * agent/reason.mjs, run as a child process, exactly as it ships.
 *
 *   node test/agent.test.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT = join(ROOT, "agent", "reason.mjs");

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};

/** A server that speaks JSON and remembers what it was asked. */
function serve(handler) {
  const log = [];
  const srv = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    log.push({ path: req.url, body });
    const out = await handler(req.url, body, log);
    res.writeHead(out.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(out.body ?? out));
  });
  return new Promise((r) =>
    srv.listen(0, "127.0.0.1", () =>
      r({ srv, log, port: srv.address().port, close: () => srv.close() })));
}

const PER_CALL = 10_000_000n;   // 0.1 HBAR
const PRICE = { triage: 1_000_000n, synthesis: 8_000_000n, exhaustive: 15_000_000n };

/**
 * Run the real agent against fakes.
 *
 * `turns` is what the scripted model says, in order. Anything it says after
 * the script runs out is a plain refusal to continue, which keeps a buggy
 * loop from spinning forever inside a test.
 */
async function run(turns, { available = 50_000_000n, env = {} } = {}) {
  let left = available;
  const paid = [];

  const gw = await serve((path, body) => {
    if (path === "/envelope") {
      return { slot: 0, agent: "test", mandate: {
        available: String(left), per_call_max: String(PER_CALL),
        payees: ["0.0.10365984"] } };
    }
    if (path === "/pay") {
      const price = PRICE[body?.service];
      if (price === undefined) return { status: 400, body: { error: "no such service" } };
      // The fake chip, with exactly the one rule under test.
      if (price > PER_CALL) {
        return { paid: false, refused: true, reason: "over_per_call", terminal: true,
                 advice: "this single payment exceeds per_call_max; a cheaper tier may fit" };
      }
      if (price > left) {
        return { paid: false, refused: true, reason: "over_budget", terminal: true,
                 advice: "the envelope has less left than this costs" };
      }
      left -= price;
      paid.push(body.service);
      return { paid: true, spent: String(price), remaining: String(left),
               response: { verdict: `${body.service} says: elevated` } };
    }
    return { status: 404, body: { error: "nope" } };
  });

  const br = await serve(() => ({ ok: true, result: { account: "0.0.1", score: 12,
                                                      reason: "clean" } }));

  // The scripted model. Each turn is one decision object, exactly as
  // grammar-constrained decoding would produce it; `turns` is what it says,
  // in order. Once the script runs out it reports, so a loop with a bug in it
  // cannot spin forever inside a test.
  let turn = 0;
  const sent = [];
  const llm = await serve((path, body) => {
    if (!body?.format) throw new Error("the agent asked for unconstrained output");
    sent.push(body.messages);
    const t = turns[turn++] ?? { tool: "report", verdict: "script exhausted" };
    return { message: { role: "assistant",
                        content: JSON.stringify({ thought: "…", ...t }) } };
  });

  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [AGENT], {
      env: { ...process.env,
             OLLAMA: `http://127.0.0.1:${llm.port}`,
             GATEWAY: `http://127.0.0.1:${gw.port}`,
             BROKER: `http://127.0.0.1:${br.port}`,
             AGENT_TOKEN: "test", AGENT_STEPS: "12", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let s = "";
    p.stdout.on("data", (d) => (s += d));
    p.stderr.on("data", (d) => (s += d));
    p.on("close", (code) => resolve({ text: s, code }));
  });

  gw.close(); br.close(); llm.close();
  return { ...out, paid, gateway: gw.log, turnsUsed: turn, sent };
}

console.log("\nthe agent loop, against a chip that says no\n");

/* ---------------------------------------------------------------------- */
{
  // The moment the project exists for: it reaches past the ceiling, is
  // refused, reads why, and comes back with something that fits.
  const r = await run([
    { tool: "check_envelope" },
    { tool: "buy_analysis", tier: "exhaustive" },
    { tool: "buy_analysis", tier: "synthesis" },
    { tool: "report", verdict: "elevated risk, bought synthesis" },
  ]);
  ok("a payment over the ceiling is refused", /REFUSED over_per_call/.test(r.text), r.text);
  ok("and the refusal carries a reason it can act on",
     /a cheaper tier may fit/.test(r.text), r.text);
  ok("the cheaper tier then settles", r.paid.length === 1 && r.paid[0] === "synthesis",
     JSON.stringify(r.paid));
  ok("and the run reports what it actually spent",
     /spent\s+0\.08 HBAR across 1 payment/.test(r.text), r.text);
  ok("the refused payment cost nothing",
     r.gateway.filter((e) => e.path === "/pay").length === 2, "");
}

/* ---------------------------------------------------------------------- */
{
  // Prose instead of work. A model that narrates a budget it never read gets
  // pushed back rather than believed — the failure observed on the first
  // real run against hermes3, where it announced 100 HBAR it did not have.
  const r = await run([
    { tool: "report", verdict: "all fine, and I have roughly 100 HBAR left" },
    { tool: "check_envelope" },
    { tool: "buy_analysis", tier: "triage" },
    { tool: "report", verdict: "done" },
  ]);
  ok("a verdict from an agent that never read its envelope is refused",
     /report — refused/.test(r.text) &&
     /you have not called check_envelope/.test(r.text), r.text);
  ok("and the run continues to a real payment", r.paid[0] === "triage",
     JSON.stringify(r.paid));
  ok("the invented figure never becomes the verdict",
     !/100 HBAR/.test(r.text), r.text);
}

/* ---------------------------------------------------------------------- */
{
  // An agent that keeps asking for the same refused thing must not be able
  // to spend anything by persistence. Terminal means terminal.
  const r = await run([
    { tool: "buy_analysis", tier: "exhaustive" },
    { tool: "buy_analysis", tier: "exhaustive" },
    { tool: "buy_analysis", tier: "exhaustive" },
    { tool: "buy_analysis", tier: "exhaustive" },
    { tool: "check_envelope" },
    { tool: "report", verdict: "could not afford anything" },
  ]);
  ok("repeating a terminal refusal never succeeds", r.paid.length === 0,
     JSON.stringify(r.paid));
  ok("and the envelope is untouched", /spent\s+0 HBAR/.test(r.text), r.text);
}

/* ---------------------------------------------------------------------- */
{
  // Stuck, not deciding. Observed for real: refused at the ceiling with three
  // models competing for one runtime, research-1 called check_envelope seven
  // times and never recovered. The envelope had not moved and could not.
  const r = await run([
    { tool: "check_envelope" },
    { tool: "check_envelope" },
    { tool: "check_envelope" },
    { tool: "check_envelope" },
    { tool: "buy_analysis", tier: "triage" },
    { tool: "report", verdict: "unstuck" },
  ]);
  ok("a call repeated with no change is pushed back",
     /same call 3×/.test(r.text) && /nothing about it has changed/.test(r.text), r.text);
  ok("and the run continues once it moves on", r.paid[0] === "triage",
     JSON.stringify(r.paid));
}

/* ---------------------------------------------------------------------- */
{
  // Told twice and still repeating. Ending is more honest than burning the
  // remaining steps to print the same line again.
  const r = await run(Array(8).fill({ tool: "check_envelope" }));
  ok("a model that will not move on ends the run",
     /giving up on this run/.test(r.text), r.text);
  ok("and it is reported as unfinished", r.code === 1, `exit ${r.code}`);
}

/* ---------------------------------------------------------------------- */
{
  // The envelope is nearly empty: the ceiling is not the binding rule, the
  // balance is, and the two refusals must not be confused.
  const r = await run([
    { tool: "check_envelope" },
    { tool: "buy_analysis", tier: "synthesis" },
    { tool: "buy_analysis", tier: "triage" },
    { tool: "report", verdict: "done cheaply" },
  ], { available: 5_000_000n });
  ok("a payment under the ceiling but over the balance is refused",
     /REFUSED over_budget/.test(r.text), r.text);
  ok("and it is told the balance, not the ceiling",
     /less left than this costs/.test(r.text), r.text);
  ok("the affordable tier settles", r.paid[0] === "triage", JSON.stringify(r.paid));
}

/* ---------------------------------------------------------------------- */
{
  // No mandate at all. Nothing to retry past, and the agent should not
  // pretend otherwise or spend a run trying.
  const gw = await serve(() => ({ slot: 0, mandate: null,
    note: "a human must grant one on the device" }));
  const br = await serve(() => ({ ok: true, result: { score: 1 } }));
  const llm = await serve(() => ({ message: { role: "assistant",
    content: JSON.stringify({ thought: "…", tool: "check_envelope" }) } }));
  const r = await new Promise((resolve) => {
    const p = spawn(process.execPath, [AGENT], {
      env: { ...process.env, OLLAMA: `http://127.0.0.1:${llm.port}`,
             GATEWAY: `http://127.0.0.1:${gw.port}`, BROKER: `http://127.0.0.1:${br.port}`,
             AGENT_TOKEN: "test", AGENT_STEPS: "2" },
      stdio: ["ignore", "pipe", "pipe"] });
    let s = ""; p.stdout.on("data", (d) => (s += d)); p.stderr.on("data", (d) => (s += d));
    p.on("close", () => resolve(s));
  });
  gw.close(); br.close(); llm.close();
  ok("an ungranted agent is told so plainly",
     /no envelope has been granted to you/.test(r), r);
}

/* ---------------------------------------------------------------------- */
{
  // A broker that answers with an error rather than a refusal. Handing the
  // model `refused: undefined` would be worse than useless — a refusal with
  // no reason in it is the one thing this loop is built to never produce.
  const gw = await serve(() => ({ slot: 0, mandate: {
    available: "50000000", per_call_max: "10000000", payees: [] } }));
  const br = await serve(() => ({ status: 401,
    body: { error: "present a bearer token" } }));
  const llm = await serve(() => ({ message: { role: "assistant",
    content: JSON.stringify({ thought: "…", tool: "screen_counterparty",
                              account: "0.0.1" }) } }));
  const r = await new Promise((resolve) => {
    const p = spawn(process.execPath, [AGENT], {
      env: { ...process.env, OLLAMA: `http://127.0.0.1:${llm.port}`,
             GATEWAY: `http://127.0.0.1:${gw.port}`, BROKER: `http://127.0.0.1:${br.port}`,
             AGENT_TOKEN: "test", AGENT_STEPS: "2" },
      stdio: ["ignore", "pipe", "pipe"] });
    let s = ""; p.stdout.on("data", (d) => (s += d)); p.stderr.on("data", (d) => (s += d));
    p.on("close", () => resolve(s));
  });
  gw.close(); br.close(); llm.close();
  ok("a broker error is reported as an error, not a reasonless refusal",
     /error: present a bearer token/.test(r) && !/undefined/.test(r), r);
}

/* ---------------------------------------------------------------------- */
{
  // The model is down. An agent that holds a mandate must fail loudly rather
  // than carry on with an empty head.
  const dead = await serve(() => ({ status: 500, body: { error: "model not found" } }));
  const r = await new Promise((resolve) => {
    const p = spawn(process.execPath, [AGENT], {
      env: { ...process.env, OLLAMA: `http://127.0.0.1:${dead.port}`,
             AGENT_TOKEN: "test", AGENT_STEPS: "2" },
      stdio: ["ignore", "pipe", "pipe"] });
    let s = ""; p.stdout.on("data", (d) => (s += d)); p.stderr.on("data", (d) => (s += d));
    p.on("close", (code) => resolve({ s, code }));
  });
  dead.close();
  ok("a broken model stops the run", r.code === 1, `exit ${r.code}`);
  ok("and says why", /model refused the request/.test(r.s), r.s);
}

/* ---------------------------------------------------------------------- *
 * The window.
 *
 * hermes3:8b holds 8k tokens and a long run walks off the end, which Ollama
 * reports as "unexpected EOF" — a failure that does not look like what it is.
 * Raising num_ctx only moves the wall, so the history is trimmed instead.
 * ---------------------------------------------------------------------- */
{
  // Long enough to force trimming: each step adds two messages.
  const turns = [];
  for (let i = 0; i < 10; i++) turns.push({ tool: "screen_counterparty", account: "0.0.1" });
  turns.push({ tool: "report", verdict: "done" });

  // Forced rather than hoped for: a small window makes this a test of the
  // trimming rule, not of whether the default happens to be exceeded.
  const r = await run(turns, { env: { AGENT_KEEP: "6" } });
  const last = r.sent.at(-1);

  ok("the system prompt always survives trimming",
     last[0].role === "system" && /research agent/.test(last[0].content), last[0]?.role);
  ok("and so does the original task",
     /Screen each one/.test(last[1].content) || /counterparty risk/.test(last[1].content),
     last[1]?.content?.slice(0, 60));
  ok("the window is bounded", last.length <= 9, `${last.length} messages`);
  ok("and the agent is told it forgot something",
     last.some((m) => /no longer in your context/.test(m.content ?? "")),
     JSON.stringify(last.map((m) => m.role)));
  // A short run must not be trimmed at all — a notice about dropped steps
  // when nothing was dropped would be a lie the model then reasons from.
  const short = await run([{ tool: "check_envelope" }, { tool: "report", verdict: "x" }],
                          { env: { AGENT_KEEP: "6" } });
  ok("a short run carries no dropped-steps notice",
     !short.sent.at(-1).some((m) => /no longer in your context/.test(m.content ?? "")));
}

console.log(`\n${pass}/${pass + fail} passed\n`);
process.exit(fail ? 1 : 0);
