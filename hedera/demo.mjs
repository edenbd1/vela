#!/usr/bin/env node
/**
 * The demo, in one run: grant an envelope, draw against it three times, and
 * anchor every draw.
 *
 * One tap, at the start. After that the agent works on its own — which is
 * the point. A device that asks for a tap per payment is not governing an
 * autonomous agent, it is standing in for one.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactHederaScheme } from "@x402/hedera/exact/client";

import { createLedgerHederaSigner } from "./ledger-signer.mjs";
import { drawRecord, makeAnchor, mandateDigest } from "./anchor.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(ROOT, ".env") });

const NETWORK = "hedera:testnet";
const HBAR = 100_000_000n;
const DRAWS = Number(process.argv[2] ?? 3);
const hbar = (n) => `${Number(n) / 1e8} HBAR`;

const MANDATE = {
  agentId: Buffer.alloc(20, 0xa1),
  payees: [BigInt(process.env.HEDERA_TREASURY_ID.split(".").pop())],
  budgetTotal: HBAR / 2n,
  perCallMax: HBAR / 10n,
  expiry: 0,
};
const mandateHash = mandateDigest(MANDATE);

let last = null;
const signer = await createLedgerHederaSigner({
  accountId: process.env.HEDERA_BUYER_ID,
  slot: 0,
  onDraw: (d) => (last = d),
});

console.log(`buyer   ${process.env.HEDERA_BUYER_ID}`);
console.log(`key     ${signer.publicKey.toString("hex")}`);
console.log(`        no private key for that account exists on this machine\n`);

// --- grant ----------------------------------------------------------------
const existing = await signer.transport
  .exchange(Buffer.from([0xe0, 0x10, 0, 0, 0]))
  .catch((e) => (e.sw === 0xb102 ? null : Promise.reject(e)));

if (existing && existing.length >= 69) {
  console.log("slot 0 already holds a mandate. Revoke it on the device first,");
  console.log("so this run starts a fresh chain from draw #1.");
  process.exit(1);
}

console.log(`1. granting ${hbar(MANDATE.budgetTotal)}, ` +
            `${hbar(MANDATE.perCallMax)} max per draw, ` +
            `may pay 0.0.${MANDATE.payees[0]}`);
console.log("\n   >>> approve on the device <<<\n");

const body = Buffer.alloc(49);
MANDATE.agentId.copy(body, 0);
body.writeUInt8(1, 20);
body.writeBigUInt64BE(MANDATE.payees[0], 21);
body.writeBigUInt64BE(MANDATE.budgetTotal, 29);
body.writeBigUInt64BE(MANDATE.perCallMax, 37);
body.writeUInt32BE(MANDATE.expiry, 45);

await signer.transport.exchange(
  Buffer.concat([Buffer.from([0xe0, 0x11, 0, 0, body.length]), body]),
);
const instance = String(Math.floor(Date.now() / 1000));
console.log(`   granted. instance ${instance}\n`);

// --- draw -----------------------------------------------------------------
const client = new x402Client().register(NETWORK, new ExactHederaScheme(signer));
client.setSpendControls({
  allowedAssets: [{ network: NETWORK, asset: "0.0.0", maxAmountPerPayment: "20000000" }],
});
const http = new x402HTTPClient(client);
const anchor = makeAnchor({
  topicId: process.env.HEDERA_TOPIC_ID,
  operatorId: process.env.HEDERA_TREASURY_ID,
  operatorKey: process.env.HEDERA_TREASURY_KEY,
});

console.log(`2. the agent works. ${DRAWS} paid calls, no taps.\n`);

for (let i = 1; i <= DRAWS; i++) {
  const tier = i === DRAWS ? "synthesis" : "triage";
  const url = `http://127.0.0.1:${process.env.SELLER_PORT ?? 4021}/infer/${tier}`;

  const first = await fetch(url);
  const required = http.getPaymentRequiredResponse(
    (n) => first.headers.get(n),
    await first.clone().json().catch(() => undefined),
  );
  const accepts = required.accepts[0];

  const payload = await http.createPaymentPayload(required);
  const paid = await fetch(url, { headers: http.encodePaymentSignatureHeader(payload) });
  const result = await http.processResponse(paid);

  if (result.paymentStatus !== "settled") {
    console.log(`   draw ${i} did not settle: ${result.header?.errorMessage ?? ""}`);
    break;
  }
  await signer.settle(BigInt(accepts.amount));

  const record = drawRecord({
    mandateHash,
    instance,
    seq: last.seq,
    payee: MANDATE.payees[0],
    amount: BigInt(accepts.amount),
    remaining: last.available,
    tx: result.header.transaction,
  });
  const n = await anchor.submit(record);

  console.log(`   draw #${last.seq}  ${tier.padEnd(9)} ${hbar(accepts.amount).padEnd(11)}` +
              ` ${hbar(last.available).padEnd(11)} left   anchored #${n}`);
}

anchor.close();
console.log(`\n3. verify it yourself, from the public log alone:`);
console.log(`   node hedera/verify.mjs ${process.env.HEDERA_TOPIC_ID}`);
