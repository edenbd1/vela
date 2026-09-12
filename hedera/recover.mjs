/**
 * Put the fleet back on a replacement device.
 *
 * You lost the Flex. You restored your 24 words onto a new one, so the keys
 * are back and the accounts are back — and every envelope is gone, because a
 * mandate is NVRAM state, not something derived from a seed. Without this, an
 * agent that had spent 0.38 of 0.5 HBAR gets a fresh 0.5.
 *
 * Two halves, from two places, and neither is trusted alone:
 *
 *   the terms      from a backup written when the fleet was granted. Not a
 *                  secret — payees, a budget, a ceiling — and checkable,
 *                  because the audit log carries a digest of exactly those
 *                  fields. A backup that has been edited does not match.
 *
 *   the position   from the audit log on Hedera, read through a public mirror
 *                  node. Nothing local is consulted for this: the number that
 *                  decides how much an agent may still spend comes from a
 *                  chain anyone can check.
 *
 * The chip cannot verify the position and this does not pretend it can. It
 * could check a signature it made over the last draw, and that would prove
 * nothing, because the chip signs whatever it is handed — a record fabricated
 * a second ago verifies exactly as well as a real one. Ed25519 over your own
 * key is not evidence to yourself.
 *
 * What checks it is the person holding the device. The position is printed
 * here, published on the chain, and shown on the trusted display in the same
 * units, so the three can be compared before the tap. That is the same trust
 * model as granting the mandate in the first place.
 *
 *   node hedera/recover.mjs              # what the log says, and what would happen
 *   node hedera/recover.mjs --restore    # do it, one tap per envelope
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import { mandateDigest } from "./anchor.mjs";
import { positions, plan as buildPlan } from "./recovery.mjs";
import { BridgeTransport } from "./ledger-signer.mjs";
import { liveTopic } from "./live-env.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(ROOT, ".env") });

const MIRROR = process.env.HEDERA_MIRROR ??
  "https://testnet.mirrornode.hedera.com/api/v1";
const BACKUP = join(ROOT, ".vela-fleet-backup.json");
const SCHEMA = "vela.draw.v1";

const CLA = 0xe0;
const RESTORE = 0x1a;
const hbar = (t) => (Number(t) / 1e8).toFixed(4);

const json = async (u) => {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${r.status} from ${u}`);
  return r.json();
};

/** Every record on the topic, oldest first. */
async function readTopic(topic) {
  const out = [];
  let next = `${MIRROR}/topics/${topic}/messages?limit=100&order=asc`;
  while (next) {
    const page = await json(
      next.startsWith("http") ? next : `${MIRROR.replace(/\/api\/v1$/, "")}${next}`);
    for (const m of page.messages ?? []) {
      try {
        const r = JSON.parse(Buffer.from(m.message, "base64").toString());
        if (r.v === SCHEMA) out.push(r);
      } catch { /* the topic is public; anyone may write to it */ }
    }
    next = page.links?.next ?? null;
  }
  return out;
}

/* ---------------------------------------------------------------------- */

const topic = liveTopic();
if (!topic) {
  console.log("no HEDERA_TOPIC_ID — there is no log to recover from.");
  process.exit(1);
}

if (!existsSync(BACKUP)) {
  console.log(`no backup at ${BACKUP}`);
  console.log();
  console.log("The audit log holds a digest of each envelope's terms, not the");
  console.log("terms themselves — by design, since the log is public. Granting");
  console.log("a fleet writes the backup; without one, the position below can");
  console.log("still be read but there is nothing to restore it onto.");
  process.exit(1);
}

const backup = JSON.parse(readFileSync(BACKUP, "utf8"));
const records = await readTopic(topic);
const seen = positions(records);

console.log();
console.log(`topic    ${topic}`);
console.log(`source   ${MIRROR} — and nothing else`);
console.log(`backup   ${backup.mandates.length} envelope(s), granted ${backup.instance}`);
console.log();

const digestOf = (m) => mandateDigest({
  agentId: Buffer.from(m.agentId, "hex"),
  payees: m.payees.map(BigInt),
  budgetTotal: BigInt(m.budgetTotal),
  perCallMax: BigInt(m.perCallMax),
  expiry: m.expiry ?? 0,
});

const rows = buildPlan({
  mandates: backup.mandates,
  instance: backup.instance,
  seen,
  digestOf,
  assumeUnused: process.argv.includes("--assume-unused"),
});

const pad = "".padEnd(14);
for (const r of rows) {
  if (r.refused) {
    console.log(`  ${r.label.padEnd(14)} ${r.refused}`);
    console.log(`  ${pad} digest ${r.digest.slice(0, 16)}…`);
    for (const f of (r.failures ?? []).slice(0, 3)) console.log(`  ${pad} ${f}`);
    if (r.refused === "nothing on this topic") {
      console.log(`  ${pad} either it never drew, or it drew somewhere this is`);
      console.log(`  ${pad} not reading. Restoring at zero is right for the`);
      console.log(`  ${pad} first and gives back everything spent for the`);
      console.log(`  ${pad} second. --assume-unused restores it at zero.`);
    } else {
      console.log(`  ${pad} Every missing draw is spending this would hand back.`);
    }
    console.log();
    continue;
  }
  const left = BigInt(r.budgetTotal) - r.spent;
  console.log(`  ${r.label.padEnd(14)} draw ${String(r.seq).padEnd(4)} ` +
              `${hbar(r.spent)} spent, ${hbar(left)} left of ${hbar(r.budgetTotal)}`);
  console.log(`  ${pad} digest ${r.digest.slice(0, 16)}…  matches the chain`);
  console.log(r.assumed
    ? `  ${pad} assumed unused — nothing on the chain said otherwise`
    : `  ${pad} ${r.draws} draw(s), no gaps`);
  console.log();
}

const plan = rows.filter((r) => !r.refused);
if (plan.length === 0) {
  console.log("Nothing can be restored from this log.");
  console.log();
  process.exit(1);
}

/**
 * The one case where the reconstruction can be marked.
 *
 * Recovery exists for a device that is gone, and against a gone device there
 * is nothing to compare a position to — which is exactly why an error here is
 * silent. But run it against a device that is still holding the fleet and the
 * answer is checkable: the chain says how much is left, the chip says how
 * much is left, and they either agree or the reconstruction is wrong.
 *
 * The chip's own figure is spent + reserved, not spent: a reservation the
 * host never settled is budget the envelope has already committed, and the
 * remaining balance the chip signed into each draw says so.
 */
if (process.argv.includes("--check")) {
  const gw = process.env.GATEWAY ?? "http://127.0.0.1:4030";
  let slots;
  try {
    slots = (await json(`${gw}/mandates`)).slots.filter((s) => s.label);
  } catch (e) {
    console.log(`  the chip could not be read (${e.message}), so nothing was`);
    console.log("  compared. That is the ordinary case for recovery.");
    console.log();
    process.exit(0);
  }
  let disagreed = 0;
  for (const r of plan) {
    const s = slots.find((x) => x.label === r.label);
    if (!s) {
      console.log(`  ${r.label.padEnd(14)} not on this device — nothing to compare`);
      continue;
    }
    const chip = BigInt(s.spent) + BigInt(s.reserved);
    const money = chip === r.spent;

    // The position, not only the money. A draw the chip authorised and nobody
    // anchored leaves these level in HBAR — settle it to zero and the spend
    // comes back — while the counter has moved on. That is exactly the state
    // that breaks the next anchor: the log ends at 10, the chip is at 12, and
    // draw 13 lands as `FAIL seq 13 follows 10`. verify.mjs cannot see it
    // either, because a hole at the end of a chain has nothing after it to be
    // discontinuous with. This check is the only place it shows.
    const behind = Number(s.draws_so_far) - Number(r.seq);
    const ok = money && behind === 0;
    if (!ok) disagreed++;

    console.log(`  ${r.label.padEnd(14)} ${ok ? "chip agrees" : "DISAGREES"}  ` +
                `chain ${hbar(r.spent)} spent, chip ${hbar(chip)} ` +
                `(${hbar(s.spent)} settled + ${hbar(s.reserved)} reserved)`);
    if (behind !== 0) {
      console.log(`  ${"".padEnd(14)} the chip is at draw ${s.draws_so_far} and the log ` +
                  `ends at ${r.seq} — ${Math.abs(behind)} draw(s) ` +
                  `${behind > 0 ? "nobody published" : "the chip has never made"}`);
    }
  }
  console.log();
  console.log(disagreed === 0
    ? "  The log reconstructs what the Secure Element is holding, to the tinybar."
    : `  ${disagreed} envelope(s) disagree. The restore would be wrong.`);
  console.log();
  process.exit(disagreed === 0 ? 0 : 1);
}

if (!process.argv.includes("--restore")) {
  console.log("Nothing was written. Check those positions against the log —");
  console.log(`  https://hashscan.io/testnet/topic/${topic}`);
  console.log("then run again with --restore. The device will show each one");
  console.log("before you approve it, in the same units printed here.");
  console.log();
  process.exit(0);
}

/* --------------------------------------------------------- the taps ---- */

const t = new BridgeTransport();
await t.open();

/**
 * Does this device know how to be restored?
 *
 * An app built before recovery existed answers 0x6D00 — "no such
 * instruction" — and the raw failure is a stack trace after the operator has
 * already been asked to approve a screen that will never appear. That is the
 * same mistake as a test waiting on a prompt the chip refuses before drawing:
 * the person stands there, then starts pressing things.
 *
 * So it is asked first, with a body the handler rejects on its own terms. A
 * device that has the instruction answers 0xB108 (bad request); one that does
 * not answers 0x6D00, and this stops before anyone touches the screen.
 */
const supported = await t
  .exchange(Buffer.from([CLA, RESTORE, 0, 0, 1, 0]))
  .then(() => true)
  .catch((e) => e?.sw !== 0x6d00);

if (!supported) {
  console.log("this device does not have the restore instruction.");
  console.log();
  console.log("  Recovery was added after the app now on the Flex was built.");
  console.log("  Load the current one and grant a fleet again:");
  console.log();
  console.log("      ./scripts/build.sh && ./scripts/load.sh");
  console.log("      node hedera/fleet.mjs");
  console.log();
  console.log("  Nothing was written, and the positions above are still");
  console.log("  correct — they came from the log, not from the device.");
  t.close();
  process.exit(1);
}

const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(v)); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(Number(v)); return b; };

for (const m of plan) {
  const label = Buffer.from(m.label, "utf8");

  // The contract terms have to be carried explicitly. The audit log's digest
  // covers the agent, the payees, the budget, the ceiling and the expiry —
  // not these — so a restore that dropped them would match the chain
  // perfectly and hand back an agent that can no longer trade. Silently
  // narrowing a mandate is a worse failure than refusing to restore it.
  const calls = m.contracts?.length
    ? Buffer.concat([
        Buffer.from([m.contracts.length]), ...m.contracts.map(u64),
        Buffer.from([m.selectors.length]),
        ...m.selectors.map((x) => Buffer.from(x.padStart(8, "0"), "hex")),
        Buffer.from([m.recipientArg]),
      ])
    : Buffer.from([0, 0, 0xff]);

  // Mandatory on a restore, zeroed when the mandate has no rate limit: the
  // position follows immediately, so an absent block and six bytes of
  // sequence number would be the same bytes.
  const velocity = Buffer.alloc(6);
  velocity.writeUInt32BE(Number(m.windowSecs ?? 0), 0);
  velocity.writeUInt16BE(Number(m.maxPerWindow ?? 0), 4);

  const body = Buffer.concat([
    Buffer.from(m.agentId, "hex"),
    Buffer.from([m.payees.length]),
    ...m.payees.map(u64),
    u64(m.budgetTotal), u64(m.perCallMax), u32(m.expiry ?? 0),
    Buffer.from([label.length]), label,
    calls,
    velocity,
    u32(m.seq), u64(m.spent),
  ]);

  console.log(`  >>> approve the restore of '${m.label}' on the device <<<`);
  console.log(`      ${hbar(m.spent)} spent, draw ${m.seq}` +
              (m.contracts?.length ? `, may swap on 0.0.${m.contracts[0]}` : ""));
  let r;
  try {
    r = await t.exchange(
      Buffer.concat([Buffer.from([CLA, RESTORE, 0, 0, body.length]), body]));
  } catch (e) {
    // A refusal here is a person saying no, or a slot problem. Either way it
    // is an answer, and the remaining envelopes can still be restored.
    const why = { 0x6985: "declined on the device",
                  0xb101: "no free slot — revoke one first",
                  0xb108: "the chip rejected these terms" }[e?.sw];
    console.log(`      ${why ?? `device refused: 0x${(e?.sw ?? 0).toString(16)}`}`);
    console.log();
    continue;
  }
  console.log(`      restored into slot ${r[0]}`);
  console.log();
}

console.log(`  The fleet is back where the log says it was.`);
console.log(`  Nothing was re-granted: every agent resumes with what it had left.`);
console.log();
