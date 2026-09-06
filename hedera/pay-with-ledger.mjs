/**
 * The whole point, end to end.
 *
 * An agent pays for a service on Hedera. The account it pays from is
 * controlled by a key that exists only inside a Secure Element, and every
 * draw is judged against a mandate held in that chip's own memory.
 *
 * There is no private key on this machine for the account being debited.
 *
 *   node pay-with-ledger.mjs
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
const API = "http://127.0.0.1:5001";
const BUYER = process.env.HEDERA_LEDGER_BUYER_ID ?? "0.0.10391654";
const HBAR = 100_000_000n;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- driving the emulator's screen ---------------------------------------
// On hardware a human reads four pages and holds a button. A test that needs
// a human is a test nobody runs.
const post = (p, b) =>
  fetch(API + p, { method: "POST", headers: { "content-type": "application/json" },
                   body: JSON.stringify(b) });

async function swipe() {
  await post("/finger", { action: "press", x: 400, y: 300 });
  await sleep(120);
  await post("/finger", { action: "release", x: 80, y: 300 });
  await sleep(500);
}

async function hold() {
  await post("/finger", { action: "press", x: 240, y: 470 });
  await sleep(2500);
  await post("/finger", { action: "release", x: 240, y: 470 });
  await sleep(900);
}

async function approve() {
  for (let i = 0; i < 3; i++) await swipe();
  await hold();
}

// --- 1. grant an envelope -------------------------------------------------
const signer = await createLedgerHederaSigner({
  accountId: BUYER,
  slot: 0,
  onDraw: ({ seq, available, bodyLen }) =>
    console.log(`   chip authorised draw #${seq}: signed a ${bodyLen}-byte body, ` +
                `${Number(available) / 1e8} HBAR left in the envelope`),
});

console.log(`buyer account   ${BUYER}`);
console.log(`device key      ${Buffer.from(signer.publicKey).toString("hex")}`);
console.log(`no private key for that account exists on this machine\n`);

console.log("1. granting an envelope — 0.5 HBAR total, 0.1 max per draw");
const agent = Buffer.alloc(20, 0xa1);
const payeeNum = BigInt(process.env.HEDERA_TREASURY_ID.split(".").pop());
const grant = Buffer.concat([
  agent,
  Buffer.from([1]),
  (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(payeeNum); return b; })(),
  (() => { const b = Buffer.alloc(20);
           b.writeBigUInt64BE(HBAR / 2n, 0);
           b.writeBigUInt64BE(HBAR / 10n, 8);
           b.writeUInt32BE(0, 16); return b; })(),
]);

const pending = signer.transport.exchange(
  Buffer.concat([Buffer.from([0xe0, 0x11, 0, 0, grant.length]), grant]),
);
await sleep(1500);
await approve();
const slotByte = await pending;
console.log(`   granted in slot ${slotByte[0]}\n`);

// --- 2. pay ---------------------------------------------------------------
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
console.log(`   price ${Number(required.accepts[0].amount) / 1e8} HBAR ` +
            `to ${required.accepts[0].payTo}\n`);

const payload = await http.createPaymentPayload(required);
const paid = await fetch(url, { headers: http.encodePaymentSignatureHeader(payload) });
const result = await http.processResponse(paid);

console.log();
if (result.paymentStatus !== "settled") {
  console.log(`not settled: ${JSON.stringify(result, null, 2)}`);
  signer.close();
  process.exit(1);
}

await signer.settle(BigInt(required.accepts[0].amount));

const tx = result.header.transaction;
console.log("3. settled on Hedera.");
console.log(`   ${JSON.stringify(result.body)}`);
console.log(`   tx      ${tx}`);
console.log(`   mirror  ${process.env.HEDERA_MIRROR}/transactions/` +
            tx.replace("@", "-").replace(/\.(\d+)$/, "-$1"));
console.log();
console.log("   The signature on that transfer was produced inside the Secure");
console.log("   Element, after the chip checked the payee and the amount against");
console.log("   a mandate this host cannot reach.");

signer.close();
