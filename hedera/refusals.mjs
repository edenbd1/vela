/**
 * The chip's refusals, exercised without damaging the audit log.
 *
 * Three of the four refusals are free: the chip checks expiry, payee and the
 * per-draw ceiling before it touches NVRAM, so a refused request burns
 * nothing. `over_budget` is different. It can only fire when the available
 * balance has fallen below the per-draw ceiling — the checks run in that
 * order — so reaching it means genuinely reserving most of the envelope
 * first.
 *
 * Those reservations are real draws. They increment the chip's counter, and
 * an incremented counter with nothing published leaves a hole in the topic
 * that is indistinguishable, from outside, from a payment somebody chose to
 * hide. Two ad-hoc test scripts put exactly that hole in a chain during
 * development, which is why this exists as a tool rather than as a snippet
 * pasted into a shell each time: it captures the chip's signed statement for
 * every reservation it makes, releases the headroom, and publishes the
 * release. The log stays whole and the envelope ends where it started.
 *
 *   node hedera/refusals.mjs
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import { BridgeTransport } from "./ledger-signer.mjs";
import { makeAnchor, mandateDigest, releaseRecord } from "./anchor.mjs";
import { currentInstance } from "./instance.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(ROOT, ".env") });

const CLA = 0xe0;
const [GET, AUTHORIZE, SETTLE] = [0x10, 0x12, 0x13];
const SLOT = 0;

const NAMES = {
  0x9000: "AUTHORIZED", 0xb103: "expired", 0xb104: "payee_not_allowed",
  0xb105: "over_per_call", 0xb106: "over_budget",
};

const t = new BridgeTransport();
await t.open();

const hbar = (x) => `${Number(x) / 1e8}`;

async function envelope() {
  const s = await t.exchange(Buffer.from([CLA, GET, 0, 0, 0]));
  return {
    agent: s.subarray(1, 21),
    budgetTotal: s.readBigUInt64BE(21),
    reserved: s.readBigUInt64BE(29),
    perCallMax: s.readBigUInt64BE(45),
    available: s.readBigUInt64BE(53),
    expiry: s.readUInt32BE(61),
    seq: s.readUInt32BE(65),
    payees: Array.from({ length: s.readUInt8(69) },
                       (_, i) => s.readBigUInt64BE(70 + i * 8)),
  };
}

/** One AUTHORIZE. Returns the status word, and the chip's statement if it signed. */
async function authorize(payee, amount) {
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.alloc(69);
  let o = 0;
  body.writeUInt8(SLOT, o); o += 1;
  for (const v of [7162784n, BigInt(process.env.HEDERA_BUYER_ID.split(".")[2]),
                   payee, 3n, amount, 100_000_000n, BigInt(now)]) {
    body.writeBigUInt64BE(v, o); o += 8;
  }
  body.writeUInt32BE(0, o); o += 4;
  body.writeUInt32BE(120, o); o += 4;
  body.writeUInt32BE(now, o);

  try {
    const r = await t.exchange(Buffer.concat([Buffer.from([CLA, AUTHORIZE, 0, 0, 69]), body]));
    const bodyLen = r.readUInt8(12);
    const at = 13 + bodyLen + 64;
    return {
      sw: 0x9000,
      seq: r.readUInt32BE(0),
      available: r.readBigUInt64BE(4),
      anchor: r.subarray(at, at + 29),
      anchorSig: r.subarray(at + 29, at + 93),
    };
  } catch (e) {
    if (e.sw) return { sw: e.sw };
    throw e;
  }
}

async function settleToZero(quoted) {
  const d = Buffer.alloc(17);
  d.writeUInt8(SLOT, 0);
  d.writeBigUInt64BE(quoted, 1);
  d.writeBigUInt64BE(0n, 9);
  await t.exchange(Buffer.concat([Buffer.from([CLA, SETTLE, 0, 0, 17]), d]));
}

const before = await envelope();
console.log(`envelope  ${hbar(before.available)} of ${hbar(before.budgetTotal)} HBAR, ` +
            `${hbar(before.perCallMax)} max per draw, ${before.seq} draws so far\n`);

const allowed = before.payees[0];
const outsider = 66666666n;
const results = [];

// --- the three free refusals -------------------------------------------
results.push(["payee off the allowlist",
              (await authorize(outsider, 1_000_000n)).sw]);
results.push(["above the per-draw ceiling",
              (await authorize(allowed, before.perCallMax + 1n)).sw]);

// --- over_budget, which costs sequence numbers --------------------------
//
// Reserve in per_call_max steps until less than one full draw is left, then
// ask for something that fits under the ceiling but not under the balance.
const held = [];
let available = before.available;
while (available >= before.perCallMax) {
  const r = await authorize(allowed, before.perCallMax);
  if (r.sw !== 0x9000) break;
  held.push({ ...r, quoted: before.perCallMax });
  available = r.available;
}

const probe = available > 1n ? available + 1n : 1n;
results.push(["above the remaining budget",
              probe <= before.perCallMax
                ? (await authorize(allowed, probe)).sw
                : null]);

for (const [label, sw] of results) {
  if (sw === null) {
    console.log(`  ${label.padEnd(30)} not reachable in this envelope`);
  } else {
    console.log(`  ${label.padEnd(30)} 0x${sw.toString(16)}  ${NAMES[sw] ?? "?"}`);
  }
}

// --- give it all back, and say so publicly ------------------------------
if (held.length) {
  console.log(`\nreleasing ${held.length} reservation(s)`);
  const anchor = process.env.HEDERA_TOPIC_ID
    ? makeAnchor({ topicId: process.env.HEDERA_TOPIC_ID,
                   operatorId: process.env.HEDERA_TREASURY_ID,
                   operatorKey: process.env.HEDERA_TREASURY_KEY })
    : null;
  const mandateHash = mandateDigest({
    agentId: before.agent, payees: before.payees,
    budgetTotal: before.budgetTotal, perCallMax: before.perCallMax,
    expiry: before.expiry,
  });
  const instance = currentInstance().id;

  for (const h of held) {
    await settleToZero(h.quoted);
    if (anchor) {
      const n = await anchor.submit(releaseRecord({
        mandateHash, instance, seq: h.seq, payee: allowed,
        amount: h.quoted, remaining: h.available,
        anchor: h.anchor, anchorSig: h.anchorSig,
      }));
      console.log(`  draw ${h.seq} released, published as message #${n}`);
    }
  }
  anchor?.close();
}

const after = await envelope();
console.log(`\nenvelope  ${hbar(after.available)} of ${hbar(after.budgetTotal)} HBAR ` +
            `(was ${hbar(before.available)})`);
console.log(after.available === before.available
  ? "the envelope ends where it started"
  : "MISMATCH — headroom was not fully returned");
t.close();
