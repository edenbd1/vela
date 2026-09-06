/**
 * The whole point, on real hardware.
 *
 * An agent pays for a service on Hedera. The account it pays from is
 * controlled by a key that exists only inside a Secure Element, and every
 * draw is judged against a mandate held in that chip's own memory.
 *
 * There is no private key on this machine for the account being debited.
 * Delete this file, rewrite it, run it as root — the chip still decides.
 *
 *   python3 host/bridge.py &        # in another shell
 *   node hedera/pay-with-ledger.mjs
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactHederaScheme } from "@x402/hedera/exact/client";

import { createLedgerHederaSigner } from "./ledger-signer.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(ROOT, ".env") });

const NETWORK = "hedera:testnet";
const BUYER = process.env.HEDERA_BUYER_ID;
const HBAR = 100_000_000n;
const hbar = (n) => `${Number(n) / 1e8} HBAR`;

// Ask who is listening before anything else. On the dashboard the device
// answers our APDUs with bytes that only fail much later, in a buffer read,
// pointing at the wrong thing entirely.
{
  const { BridgeTransport } = await import("./ledger-signer.mjs");
  const t = new BridgeTransport();
  await t.open();
  const r = await t.exchange(Buffer.from([0xb0, 0x01, 0, 0, 0]));
  const name = r.subarray(2, 2 + r[1]).toString("latin1");
  if (name !== "Vela") {
    console.log(`the device is on '${name}', not Vela.`);
    console.log("open the Vela app and stay on it — the back arrow quits.");
    process.exit(1);
  }
}

const signer = await createLedgerHederaSigner({
  accountId: BUYER,
  slot: 0,
  onDraw: ({ seq, available, bodyLen }) =>
    console.log(`   chip signed a ${bodyLen}-byte transfer for draw #${seq}; ` +
                `${hbar(available)} left in the envelope`),
});

console.log(`buyer     ${BUYER}`);
console.log(`key       ${signer.publicKey.toString("hex")}`);
console.log(`           this machine holds no private key for that account\n`);

// --- grant, if the slot is empty -----------------------------------------
const MANDATE_STATE_LEN = 69;

// An empty Buffer is truthy, so `if (!state)` quietly falls through to the
// branch that reads offsets out of it. Check the length.
const state = await signer.transport
  .exchange(Buffer.from([0xe0, 0x10, 0, 0, 0]))
  .catch((e) => (e.sw === 0xb102 ? null : Promise.reject(e)));

if (!state || state.length < MANDATE_STATE_LEN) {
  console.log("1. no mandate in slot 0 — granting one.");
  console.log("   0.5 HBAR total, 0.1 max per draw, may pay " +
              `${process.env.HEDERA_TREASURY_ID}`);
  console.log("\n   >>> approve it on the device <<<\n");

  const payee = BigInt(process.env.HEDERA_TREASURY_ID.split(".").pop());
  const body = Buffer.alloc(20 + 1 + 8 + 8 + 8 + 4);
  body.fill(0xa1, 0, 20);            // agent id
  body.writeUInt8(1, 20);            // one payee
  body.writeBigUInt64BE(payee, 21);
  body.writeBigUInt64BE(HBAR / 2n, 29);   // total
  body.writeBigUInt64BE(HBAR / 10n, 37);  // per draw
  body.writeUInt32BE(0, 45);              // never expires

  const slot = await signer.transport.exchange(
    Buffer.concat([Buffer.from([0xe0, 0x11, 0, 0, body.length]), body]),
  );
  console.log(`   granted in slot ${slot[0]}\n`);
} else {
  const budget = state.readBigUInt64BE(21);
  const available = state.readBigUInt64BE(53);
  console.log(`1. mandate already in slot 0: ${hbar(available)} of ` +
              `${hbar(budget)} left\n`);
}

// --- pay ------------------------------------------------------------------
const client = new x402Client().register(NETWORK, new ExactHederaScheme(signer));
client.setSpendControls({
  allowedAssets: [{ network: NETWORK, asset: "0.0.0", maxAmountPerPayment: "20000000" }],
});
const http = new x402HTTPClient(client);

const url = `http://127.0.0.1:${process.env.SELLER_PORT ?? 4021}/infer/triage`;
console.log(`2. asking ${url}`);

const first = await fetch(url);
const required = http.getPaymentRequiredResponse(
  (n) => first.headers.get(n),
  await first.clone().json().catch(() => undefined),
);
const accepts = required.accepts[0];
console.log(`   ${hbar(accepts.amount)} to ${accepts.payTo}, ` +
            `network fee carried by ${accepts.extra.feePayer}\n`);

const payload = await http.createPaymentPayload(required);
const paid = await fetch(url, { headers: http.encodePaymentSignatureHeader(payload) });
const result = await http.processResponse(paid);

if (result.paymentStatus !== "settled") {
  console.log(`\nnot settled:\n${JSON.stringify(result, null, 2)}`);
  process.exit(1);
}

await signer.settle(BigInt(accepts.amount));

const tx = result.header.transaction;
console.log(`\n3. settled. the service answered:`);
console.log(`   ${JSON.stringify(result.body)}`);
console.log(`\n   tx      ${tx}`);
console.log(`   mirror  ${process.env.HEDERA_MIRROR}/transactions/` +
            tx.replace("@", "-").replace(/\.(\d+)$/, "-$1"));
console.log(`\n   That signature was produced inside the Secure Element, after`);
console.log(`   the chip checked the payee and the amount against a mandate`);
console.log(`   this host cannot read and cannot change.`);
