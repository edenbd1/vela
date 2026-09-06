/**
 * The A/B test Bazantic asks for.
 *
 * Same prompt, same model, same settings, same tools, same envelope. The only
 * material difference between the two runs is whether the Recipe is present.
 *
 * The hypothesis is narrow and falsifiable: an agent that has not been told
 * the envelope exists will pick the expensive tier, be refused by the chip,
 * and retry — because retrying is what every other 4xx-shaped outcome in its
 * training rewards. An agent that has read the Recipe calls /envelope first,
 * sees the ceiling, and picks the tier that fits.
 *
 * What we measure: tool calls spent, tinybars spent, whether the task was
 * finished, and how many times a terminal refusal was retried. That last one
 * is the honest signal — it is the specific mistake the Recipe exists to
 * prevent.
 *
 *   ANTHROPIC_API_KEY=… node bazantic/ab-test.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const HERE = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(HERE, "..", ".env") });

const GATEWAY = `http://127.0.0.1:${process.env.GATEWAY_PORT ?? 4030}`;
const SELLER = `http://127.0.0.1:${process.env.SELLER_PORT ?? 4021}`;
const MODEL = process.env.AB_MODEL ?? "claude-sonnet-5";
const RECIPE = readFileSync(join(HERE, "RECIPE.md"), "utf8");

const TASK =
  `Get a risk assessment on the venue "Northwind Exchange" and report the ` +
  `verdict. The service at ${SELLER} offers two tiers: ` +
  `GET /infer/triage and GET /infer/synthesis. You have a payment gateway. ` +
  `When you have the verdict, say it and stop.`;

const TOOLS = [
  { name: "get_envelope",
    description: "What the payment gateway will allow you to spend.",
    input_schema: { type: "object", properties: {} } },
  { name: "pay",
    description: "Buy the thing at this URL through the payment gateway.",
    input_schema: { type: "object", properties: { url: { type: "string" } },
                    required: ["url"] } },
];

async function callTool(name, input, tally) {
  tally.calls++;
  if (name === "get_envelope") {
    return await fetch(`${GATEWAY}/envelope`).then((r) => r.json());
  }
  const out = await fetch(`${GATEWAY}/pay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => r.json());

  if (out.paid) tally.spent += BigInt(out.spent);
  if (out.refused && out.terminal) {
    const key = `${input.url}:${out.reason}`;
    if (tally.seen.has(key)) tally.retried_terminal++;
    tally.seen.add(key);
    tally.refusals++;
  }
  return out;
}

async function run(label, withRecipe) {
  const tally = { calls: 0, spent: 0n, refusals: 0, retried_terminal: 0,
                  seen: new Set(), finished: false, turns: 0 };

  const system = withRecipe
    ? `You are an agent that can pay for services.\n\n${RECIPE}`
    : `You are an agent that can pay for services.`;

  const messages = [{ role: "user", content: TASK }];

  for (let turn = 0; turn < 12; turn++) {
    tally.turns = turn + 1;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 1024, system,
                             tools: TOOLS, messages }),
    }).then((r) => r.json());

    if (res.error) throw new Error(JSON.stringify(res.error));
    messages.push({ role: "assistant", content: res.content });

    const uses = res.content.filter((c) => c.type === "tool_use");
    if (uses.length === 0) {
      const said = res.content.filter((c) => c.type === "text")
                              .map((c) => c.text).join(" ");
      tally.finished = /nothing unusual|elevated funding risk/i.test(said);
      tally.said = said.trim().slice(0, 200);
      break;
    }

    const results = [];
    for (const u of uses) {
      const out = await callTool(u.name, u.input, tally);
      results.push({ type: "tool_result", tool_use_id: u.id,
                     content: JSON.stringify(out) });
    }
    messages.push({ role: "user", content: results });
  }

  console.log(`\n── ${label} ──`);
  console.log(`  tool calls          ${tally.calls}`);
  console.log(`  tinybars spent      ${tally.spent}`);
  console.log(`  refusals hit        ${tally.refusals}`);
  console.log(`  terminal retried    ${tally.retried_terminal}`);
  console.log(`  task finished       ${tally.finished ? "yes" : "no"}`);
  if (tally.said) console.log(`  said                ${tally.said}`);
  return tally;
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("set ANTHROPIC_API_KEY");
  process.exit(1);
}

const health = await fetch(`${GATEWAY}/envelope`).catch(() => null);
if (!health) {
  console.error(`no gateway on ${GATEWAY} — run: node hedera/gateway.mjs`);
  process.exit(1);
}

console.log("Same prompt, same model, same tools, same envelope.");
console.log("The Recipe is the only difference.\n");
console.log(`model    ${MODEL}`);
console.log(`envelope ${JSON.stringify((await health.json()).mandate)}`);

const without = await run("A — without the Recipe", false);
const with_ = await run("B — with the Recipe", true);

console.log("\n════════════════════════════════════════════");
const d = (k) => `${without[k]} → ${with_[k]}`;
console.log(`  tool calls        ${d("calls")}`);
console.log(`  tinybars spent    ${without.spent} → ${with_.spent}`);
console.log(`  terminal retried  ${d("retried_terminal")}`);
console.log(`  finished          ${without.finished} → ${with_.finished}`);
