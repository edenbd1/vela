/**
 * Pay for one call, on Hedera, over x402.
 *
 *   node buy.mjs triage
 *   node buy.mjs synthesis
 *
 * The signer is the only interesting part. @x402/hedera takes a
 * ClientHederaSigner — an account id and one method that returns a
 * partially signed TransferTransaction — which is exactly the seam the
 * Secure Element belongs in. This file uses the software signer to prove
 * the rail works; ledger-signer.mjs replaces it with the device.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner } from "@x402/hedera";
import { PrivateKey } from "@hiero-ledger/sdk";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(ROOT, ".env") });

const NETWORK = "hedera:testnet";
const TIER = process.argv[2] ?? "triage";
const URL = `http://127.0.0.1:${process.env.SELLER_PORT ?? 4021}/infer/${TIER}`;

const signer = createClientHederaSigner(
  process.env.HEDERA_SOFTWARE_BUYER_ID,
  PrivateKey.fromStringED25519(process.env.HEDERA_SOFTWARE_BUYER_KEY),
);

const client = new x402Client().register(NETWORK, new ExactHederaScheme(signer));

// HBAR has to be opted into explicitly; without this every requirement is
// rejected before a payment is ever attempted.
//
// Worth noting what this is: x402 ships its own spending cap, in software,
// in the process doing the paying. It is a sensible guard and it is exactly
// the thing Vela moves into the Secure Element — here, anyone who can edit
// this file can raise it.
client.setSpendControls({
  allowedAssets: [
    { network: NETWORK, asset: "0.0.0", maxAmountPerPayment: "20000000" },
  ],
});

const http = new x402HTTPClient(client);

console.log(`buyer   ${signer.accountId}`);
console.log(`asking  ${URL}`);

const first = await fetch(URL);
if (first.status !== 402) {
  console.log(`unexpected ${first.status}: ${await first.text()}`);
  process.exit(1);
}

const required = http.getPaymentRequiredResponse(
  (name) => first.headers.get(name),
  await first.clone().json().catch(() => undefined),
);
const accepted = required.accepts[0];
console.log(`price   ${Number(accepted.amount) / 1e8} HBAR to ${accepted.payTo}`);

const payload = await http.createPaymentPayload(required);
const headers = http.encodePaymentSignatureHeader(payload);

const paid = await fetch(URL, { headers });
const result = await http.processResponse(paid);

if (result.paymentStatus !== "settled") {
  console.log(`not settled: ${JSON.stringify(result, null, 2)}`);
  process.exit(1);
}

console.log();
console.log("settled. the service answered:");
console.log(JSON.stringify(result.body, null, 2));

const tx = result.header?.transaction;
if (tx) {
  // The facilitator reports 0.0.X@sec.nanos; the mirror node keys on
  // 0.0.X-sec-nanos. One conversion, in one place, and nothing else in
  // this repo compares transaction ids.
  const mirrorId = tx.replace("@", "-").replace(/\.(\d+)$/, "-$1");
  console.log();
  console.log(`hedera tx   ${tx}`);
  console.log(`hashscan    https://hashscan.io/testnet/transaction/${tx}`);
  console.log(`mirror      ${process.env.HEDERA_MIRROR}/transactions/${mirrorId}`);
}
