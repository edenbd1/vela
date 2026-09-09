/**
 * Grant the fleet.
 *
 * A tool rather than a snippet, for the reason written across this
 * repository twice already: a mandate's digest covers its terms and not its
 * lifetime, so granting the same envelope again produces the same digest
 * while the chip's counter restarts. Anything that grants has to open a
 * grant epoch, and every shell script that skipped that step has left a
 * chain reading 1,2,3,4,5,6,7,8,4,5 and a verifier correctly calling it
 * broken.
 *
 *   node hedera/fleet.mjs        # three agents, three taps
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import { BridgeTransport } from "./ledger-signer.mjs";
import { openInstance } from "./instance.mjs";
import { makeTopic } from "./topic.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(ROOT, ".env") });

const CLA = 0xe0;
const [GET, CREATE] = [0x10, 0x11];

const FLEET = [
  { label: "research-1",  budget: 50_000_000n, perCall: 10_000_000n, tag: 0xa1 },
  { label: "ops-nightly", budget: 20_000_000n, perCall:  5_000_000n, tag: 0xb2 },
  { label: "watcher",     budget: 10_000_000n, perCall:  1_000_000n, tag: 0xc3 },
];

const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(v); return b; };
const hbar = (v) => `${Number(v) / 1e8}`;

const t = new BridgeTransport();
await t.open();

const payee = BigInt(process.env.HEDERA_TREASURY_ID.split(".")[2]);

// --- clear the slots ------------------------------------------------------
//
// Revoked here rather than left to a separate command, because a fleet
// half-granted over an old one is the state that produces an unverifiable
// log: same terms, same digest, a counter that never restarted.
for (let slot = 0; slot < FLEET.length; slot++) {
  const occupied = await t
    .exchange(Buffer.from([CLA, GET, slot, 0, 0]))
    .then(() => true)
    .catch((e) => (e.sw === 0xb102 ? false : Promise.reject(e)));
  if (!occupied) continue;

  console.log(`\n  >>> approve the revoke of slot ${slot} on the device <<<`);
  await t.exchange(Buffer.concat([Buffer.from([CLA, 0x14, 0, 0, 1]), Buffer.from([slot])]));
  console.log(`      slot ${slot} cleared`);
}

// --- a topic that begins when the envelopes do ----------------------------
//
// The chip's counter starts at 1 when a mandate is granted, and a verifier
// reading the log expects the first record it sees to be draw 1. Rotating
// the topic while an envelope is alive leaves a chain that starts at 3 —
// which reads as three hidden draws and is refused, correctly. The log has
// to be as old as the thing it describes, so it is created here.
const topic = await makeTopic();
console.log(`\n  audit log ${topic}`);

for (const a of FLEET) {

  const body = Buffer.concat([
    Buffer.alloc(20, a.tag),          // agent id
    Buffer.from([1]), u64(payee),     // one payee
    u64(a.budget), u64(a.perCall),
    Buffer.alloc(4),                  // never expires
    Buffer.from([a.label.length]), Buffer.from(a.label, "latin1"),
  ]);

  console.log(`\n  >>> approve '${a.label}' on the device ` +
              `(${hbar(a.budget)} HBAR, ${hbar(a.perCall)} max) <<<`);
  const r = await t.exchange(
    Buffer.concat([Buffer.from([CLA, CREATE, 0, 0, body.length]), body]));
  console.log(`      granted in slot ${r[0]}`);
}

// One epoch for the whole fleet. Each agent has its own digest — different
// agent id, different budget — so they separate in the log on their own; the
// epoch is what separates *this* fleet from the last one granted with the
// same terms.
// The epoch carries the topic that was made for it a moment ago. A gateway
// already running then anchors to this one rather than to whatever it read
// from .env when it started.
const instance = openInstance(topic);
console.log(`\n  grant epoch ${instance}`);
console.log(`  every draw from now on is anchored under it, on ${topic},`);
console.log(`  and every chain there starts at draw 1.`);
t.close();
