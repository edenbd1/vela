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

import { writeFileSync } from "node:fs";

import { BridgeTransport } from "./ledger-signer.mjs";
import { openInstance } from "./instance.mjs";
import { makeTopic } from "./topic.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(ROOT, ".env") });

const CLA = 0xe0;
const [GET, CREATE] = [0x10, 0x11];
const BACKUP = join(ROOT, ".vela-fleet-backup.json");

// `swapExactHBARForTokens(uint256,address)` — the first four bytes of
// keccak256 over that signature. Argument 1 is the address the output goes
// to, which is what recipientArg names.
const ROUTER = 5_000_001n;
const SWAP = 0xf406a91a;

const FLEET = [
  // The only one that may trade. Its toolset is derived from these terms:
  // an agent whose mandate carries no contract clause is never shown that
  // swapping exists, so the boundary shapes what it considers rather than
  // only what it gets away with.
  { label: "research-1",  budget: 50_000_000n, perCall: 10_000_000n, tag: 0xa1,
    contracts: [ROUTER], selectors: [SWAP], recipientArg: 1 },
  // The one with a rate limit. A nightly job that suddenly wants six payments
  // a minute is the shape of a compromised agent, and the budget alone would
  // let it have them.
  { label: "ops-nightly", budget: 20_000_000n, perCall:  5_000_000n, tag: 0xb2,
    windowSecs: 3600, maxPerWindow: 4 },
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

  const parts = [
    Buffer.alloc(20, a.tag),          // agent id
    Buffer.from([1]), u64(payee),     // one payee
    u64(a.budget), u64(a.perCall),
    Buffer.alloc(4),                  // never expires
    Buffer.from([a.label.length]), Buffer.from(a.label, "latin1"),
  ];
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(Number(v)); return b; };
  if (a.contracts || a.windowSecs) {
    parts.push(
      Buffer.from([a.contracts?.length ?? 0]), ...(a.contracts ?? []).map(u64),
      Buffer.from([a.selectors?.length ?? 0]), ...(a.selectors ?? []).map(u32),
      Buffer.from([a.recipientArg ?? 0xff]));
  }
  if (a.windowSecs) {
    const w = Buffer.alloc(6);
    w.writeUInt32BE(a.windowSecs, 0);
    w.writeUInt16BE(a.maxPerWindow, 4);
    parts.push(w);
  }
  const body = Buffer.concat(parts);

  console.log(`\n  >>> approve '${a.label}' on the device ` +
              `(${hbar(a.budget)} HBAR, ${hbar(a.perCall)} max` +
              `${a.contracts ? `, may swap on 0.0.${a.contracts[0]}` : ""}` +
              `${a.windowSecs ? `, ${a.maxPerWindow}/hour` : ""}) <<<`);
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

// --- what a replacement device would need ---------------------------------
//
// A mandate is NVRAM state, not something derived from a seed: restore your
// 24 words onto a new Flex and the keys come back while every envelope is
// gone. Recovery needs the terms, and the terms are not on the chain — the
// log carries a digest of them, deliberately, because it is public.
//
// So they are written here. No secret is in this file: an agent id, a
// budget, a ceiling, a payee. What makes it safe to keep is that it is not
// trusted on its own — hedera/recover.mjs re-derives the digest from it and
// refuses anything the chain never saw, and the position comes from the
// chain rather than from here.
writeFileSync(BACKUP, JSON.stringify({
  topic,
  instance,
  granted: new Date().toISOString(),
  mandates: FLEET.map((a) => ({
    label: a.label,
    agentId: Buffer.alloc(20, a.tag).toString("hex"),
    payees: [String(payee)],
    budgetTotal: String(a.budget),
    perCallMax: String(a.perCall),
    expiry: 0,
    // Carried so a restore does not quietly hand back a narrower envelope.
    // The digest does not commit to these — it covers agent, payees, budget,
    // ceiling and expiry — so dropping them here would restore a mandate that
    // matches the chain and can no longer trade.
    ...(a.contracts ? {
      contracts: a.contracts.map(String),
      selectors: a.selectors.map((x) => x.toString(16).padStart(8, "0")),
      recipientArg: a.recipientArg,
    } : {}),
    ...(a.windowSecs ? { windowSecs: a.windowSecs, maxPerWindow: a.maxPerWindow } : {}),
  })),
}, null, 2));
console.log(`\n  terms backed up to ${BACKUP.replace(ROOT + "/", "")}`);
console.log(`  it holds no secret, and recover.mjs checks it against the chain`);
console.log(`  before it will restore anything.`);
t.close();
