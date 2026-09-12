/**
 * One envelope, into a free slot, under the epoch that is already open.
 *
 * `fleet.mjs` grants the fleet and opens a *new* grant epoch, which is right
 * when you are starting over and wrong every other time: it revokes slots 0-2
 * and rotates the topic, so running it to add a fourth agent would end three
 * working chains. This adds one without touching either.
 *
 * It writes nothing to .vela-fleet-backup.json by default. A short-lived
 * envelope for an experiment is not something a replacement device needs
 * back, and putting it in the backup would have recover.mjs offering to
 * restore it forever.
 *
 * `--keep` is the other case, and it stopped being rare: this is what the
 * console's Grant button runs, so an envelope can now be granted from a web
 * page by somebody who has no idea a replacement device will not get it back.
 * The default stays silent-by-omission rather than surprising, and
 * `recover.mjs --check` names every envelope on the chip that no backup
 * covers.
 *
 *   node hedera/grant-one.mjs <label> <budget-hbar> <per-call-hbar> [--keep]
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createHash } from "node:crypto";

import { readFileSync, writeFileSync } from "node:fs";

import { BridgeTransport } from "./ledger-signer.mjs";
import { recordMandate } from "./recovery.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(ROOT, ".env") });

const CLA = 0xe0;
const [GET, CREATE] = [0x10, 0x11];

const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const [label, budgetHbar, perCallHbar] = args.filter((a) => !a.startsWith("--"));
if (!label || !budgetHbar || !perCallHbar) {
  console.log("usage: node hedera/grant-one.mjs <label> <budget-hbar> <per-call-hbar> [--keep]");
  console.log("  --keep  also record it for recovery, as fleet.mjs does");
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

if (KEEP) {
  // Appended to the epoch that is already open, because that is the one this
  // envelope was granted under — writing a fresh file would drop the fleet.
  const path = join(ROOT, ".vela-fleet-backup.json");
  let backup;
  try { backup = JSON.parse(readFileSync(path, "utf8")); }
  catch { backup = { mandates: [] }; }
  const entry = {
    label,
    agentId: tag.toString("hex"),
    payees: [String(payee)],
    budgetTotal: String(budget),
    perCallMax: String(perCall),
    expiry: 0,
  };
  writeFileSync(path, JSON.stringify(recordMandate(backup, entry), null, 1));
  console.log(`      recorded for recovery in .vela-fleet-backup.json`);
} else {
  console.log(`      not recorded for recovery — pass --keep if it should be`);
}
console.log();
console.log(`  revoke it with:  curl -s -X POST http://127.0.0.1:4030/revoke \\`);
console.log(`                     -H 'x-vela-operator: '"$(cat .vela-operator-token)" \\`);
console.log(`                     -H 'content-type: application/json' -d '{"slot":${r[0]}}'`);
console.log();
