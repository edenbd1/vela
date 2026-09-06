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
import { checkChain, SCHEMA, STATEMENT } from "./anchor.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(ROOT, ".env") });

const MIRROR = process.env.HEDERA_MIRROR;
const TOPIC = process.argv[2] ?? process.env.HEDERA_TOPIC_ID;

/** The facilitator reports 0.0.X@sec.nanos; the mirror node keys on dashes. */
const mirrorId = (tx) => tx.replace("@", "-").replace(/\.(\d+)$/, "-$1");

async function json(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} on ${url}`);
  return r.json();
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

const byMandate = new Map();
for (const r of records) {
  if (!byMandate.has(r.m)) byMandate.set(r.m, []);
  byMandate.get(r.m).push(r);
}

let ok = true;
for (const [hash, draws] of byMandate) {
  console.log(`mandate ${hash.slice(0, 16)}…  ${draws.length} draw(s)`);

  for (const [pass, why] of checkChain(draws)) {
    console.log(`  ${pass ? "ok  " : "FAIL"}  ${why}`);
    ok &&= pass;
  }
  for (const r of draws) {
    const [pass, why] = await checkTransfer(r);
    console.log(`  ${pass ? "ok  " : "FAIL"}  ${why}`);
    ok &&= pass;
  }
  console.log();
}

console.log(ok ? "every check passed." : "SOMETHING DOES NOT ADD UP.");
console.log(STATEMENT);
process.exit(ok ? 0 : 1);
