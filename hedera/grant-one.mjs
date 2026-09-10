/**
 * One envelope, into a free slot, under the epoch that is already open.
 *
 * `fleet.mjs` grants the fleet and opens a *new* grant epoch, which is right
 * when you are starting over and wrong every other time: it revokes slots 0-2
 * and rotates the topic, so running it to add a fourth agent would end three
 * working chains. This adds one without touching either.
 *
 * It writes nothing to .vela-fleet-backup.json. A short-lived envelope for an
 * experiment is not something a replacement device needs back, and putting it
 * in the backup would have recover.mjs offering to restore it forever.
 *
 *   node hedera/grant-one.mjs <label> <budget-hbar> <per-call-hbar>
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createHash } from "node:crypto";

import { BridgeTransport } from "./ledger-signer.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(ROOT, ".env") });

const CLA = 0xe0;
const [GET, CREATE] = [0x10, 0x11];

const [label, budgetHbar, perCallHbar] = process.argv.slice(2);
if (!label || !budgetHbar || !perCallHbar) {
  console.log("usage: node hedera/grant-one.mjs <label> <budget-hbar> <per-call-hbar>");
  process.exit(1);
}

const tinybars = (h) => BigInt(Math.round(Number(h) * 1e8));
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(v)); return b; };
const budget = tinybars(budgetHbar);
const perCall = tinybars(perCallHbar);

const t = new BridgeTransport();
await t.open();

// A tag that is this label and nothing else, so two experiments an hour apart
// get two digests and two chains rather than one chain with a counter that
// restarted. fleet.mjs hands out tags by hand; here there is nobody to ask.
const tag = createHash("sha256").update(label).digest().subarray(0, 20);

let free = -1;
for (let slot = 0; slot < 64; slot++) {
  const state = await t
    .exchange(Buffer.from([CLA, GET, slot, 0, 0]))
    .then(() => "used")
    .catch((e) => (e.sw === 0xb102 ? "free" : e.sw === 0xb108 ? "end" : Promise.reject(e)));
  if (state === "end") break;
  if (state === "free") { free = slot; break; }
}
if (free === -1) {
  console.log("every slot is taken — revoke one first");
  process.exit(1);
}

const payee = BigInt(process.env.HEDERA_TREASURY_ID.split(".")[2]);
const body = Buffer.concat([
  tag,
  Buffer.from([1]), u64(payee),
  u64(budget), u64(perCall),
  Buffer.alloc(4),                                   // never expires
  Buffer.from([label.length]), Buffer.from(label, "latin1"),
]);

console.log(`\n  >>> approve '${label}' on the device ` +
            `(${budgetHbar} HBAR, ${perCallHbar} max per draw) <<<`);
const r = await t.exchange(
  Buffer.concat([Buffer.from([CLA, CREATE, 0, 0, body.length]), body]));
console.log(`      granted in slot ${r[0]}`);
console.log();
console.log(`  revoke it with:  curl -s -X POST http://127.0.0.1:4030/revoke \\`);
console.log(`                     -H 'x-vela-operator: '"$(cat .vela-operator-token)" \\`);
console.log(`                     -H 'content-type: application/json' -d '{"slot":${r[0]}}'`);
console.log();
