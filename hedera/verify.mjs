#!/usr/bin/env node
/**
 * vela verify — check the log without trusting whoever produced it.
 *
 * Reads the HCS topic and the settled transfers from the public mirror node
 * and nothing else. It never talks to the operator's host, never sees the
 * mandate, and needs no credentials. Anyone can run it.
 *
 *   node verify.mjs [topicId]
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { createPublicKey, verify as nodeVerify } from "node:crypto";

import { checkAnchor, checkChain, SCHEMA, STATEMENT } from "./anchor.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(ROOT, ".env") });

const MIRROR = process.env.HEDERA_MIRROR;
const TOPIC = process.argv[2] ?? process.env.HEDERA_TOPIC_ID;

/**
 * Ed25519 verification from a raw 32-byte key.
 *
 * Node wants SPKI DER, so wrap the raw key in the fixed 12-byte prefix that
 * says "this is an Ed25519 public key". No dependency needed for the check,
 * which matters: a verifier nobody can run proves nothing.
 */
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

function verifyEd25519(rawPubkey, signature, message) {
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519, Buffer.from(rawPubkey)]),
      format: "der",
      type: "spki",
    });
    return nodeVerify(null, message, key, signature);
  } catch {
    return false;
  }
}

/** The facilitator reports 0.0.X@sec.nanos; the mirror node keys on dashes. */
const mirrorId = (tx) => tx.replace("@", "-").replace(/\.(\d+)$/, "-$1");

async function json(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} on ${url}`);
  return r.json();
}

/**
 * The device's public key, read off the account it controls.
 *
 * The verifier is given nothing but a topic id: it learns which account was
 * debited from the log's own transactions, then asks the mirror node what
 * key that account is under. Nobody has to hand it a key to trust.
 */
async function deviceKeyOf(accountId) {
  const d = await json(`${MIRROR}/accounts/${accountId}`);
  const k = d.key;
  if (!k || k._type !== "ED25519") return null;
  return Buffer.from(k.key, "hex");
}

async function readTopic(topic) {
  const out = [];
  let next = `${MIRROR}/topics/${topic}/messages?limit=100&order=asc`;
  while (next) {
    const page = await json(next.startsWith("http") ? next : `${MIRROR.replace(/\/api\/v1$/, "")}${next}`);
    for (const m of page.messages ?? []) {
      try {
        const r = JSON.parse(Buffer.from(m.message, "base64").toString());
        if (r.v === SCHEMA) out.push({ ...r, consensus: m.consensus_timestamp });
      } catch {
        // not ours; the topic is public and anyone may write to it
      }
    }
    next = page.links?.next ?? null;
  }
  return out;
}

/** Did this transfer really happen, exactly as the log claims? */
async function checkTransfer(record) {
  if (!record.tx) return [false, `draw ${record.seq} names no transaction`];
  const d = await json(`${MIRROR}/transactions/${mirrorId(record.tx)}`);
  const t = d.transactions?.[0];
  if (!t) return [false, `draw ${record.seq}: ${record.tx} is not on chain`];
  if (t.result !== "SUCCESS") return [false, `draw ${record.seq}: ${t.result}`];

  const debited = t.transfers.find((x) => String(x.amount) === `-${record.amount}`);
  if (debited) record.payer = debited.account;

  const credited = t.transfers.find(
    (x) => x.account.endsWith(`.${record.payee}`) && String(x.amount) === record.amount,
  );
  return credited
    ? [true, `draw ${record.seq}: ${record.amount} tinybars reached 0.0.${record.payee}`]
    : [false, `draw ${record.seq}: no transfer of ${record.amount} to 0.0.${record.payee}`];
}

if (!TOPIC) {
  console.log("usage: node verify.mjs <topicId>");
  process.exit(2);
}

console.log(`topic   ${TOPIC}`);
console.log(`source  ${MIRROR} — and nothing else\n`);

const records = await readTopic(TOPIC);
if (records.length === 0) {
  console.log("no draws anchored yet");
  process.exit(1);
}

// Group by envelope *instance*: the same terms granted twice share a digest,
// and each grant restarts the chip's sequence at 1.
const byMandate = new Map();
for (const r of records) {
  const key = `${r.m}#${r.i ?? "0"}`;
  if (!byMandate.has(key)) byMandate.set(key, []);
  byMandate.get(key).push(r);
}

// A verdict per envelope, not one for the whole topic. Anyone may write to
// a public topic, and one bad instance says nothing about the others.
const only = process.argv[3];
const verdicts = [];

for (const [key, draws] of byMandate) {
  const [hash, instance] = key.split("#");
  if (only && instance !== only) continue;

  console.log(`mandate ${hash.slice(0, 16)}…  granted ${instance}  ` +
              `${draws.length} draw(s)`);

  let ok = true;
  for (const [pass, why] of checkChain(draws)) {
    console.log(`  ${pass ? "ok  " : "FAIL"}  ${why}`);
    ok &&= pass;
  }
  // Who was debited? The log does not say directly; the settled transfers do.
  let deviceKey = null;
  for (const r of draws) {
    const [pass, why] = await checkTransfer(r);
    console.log(`  ${pass ? "ok  " : "FAIL"}  ${why}`);
    ok &&= pass;
    if (pass && !deviceKey && r.payer) deviceKey = await deviceKeyOf(r.payer);
  }

  if (deviceKey) {
    console.log(`  key   the debited account is under ${deviceKey.toString("hex").slice(0, 16)}…`);
    for (const r of draws) {
      const [pass, why] = checkAnchor(r, deviceKey, verifyEd25519);
      console.log(`  ${pass ? "ok  " : "FAIL"}  ${why}`);
      ok &&= pass;
    }
  } else {
    console.log("  --    no device key found; the chip's own statements are unchecked");
  }
  console.log(`  → ${ok ? "complete and consistent" : "incomplete"}\n`);
  verdicts.push([instance, ok]);
}

const good = verdicts.filter(([, v]) => v).length;
console.log(`${good} of ${verdicts.length} envelope(s) verify.`);
const ok = good === verdicts.length;
console.log(STATEMENT);
process.exit(ok ? 0 : 1);
