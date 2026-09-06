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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactHederaScheme } from "@x402/hedera/exact/client";

import { createLedgerHederaSigner } from "./ledger-signer.mjs";
import { drawRecord, makeAnchor, mandateDigest } from "./anchor.mjs";
import { currentInstance, openInstance } from "./instance.mjs";

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

let lastDraw = null;
const signer = await createLedgerHederaSigner({
  accountId: BUYER,
  slot: 0,
  onDraw: (d) => {
    lastDraw = d;
    console.log(`   chip signed a ${d.bodyLen}-byte transfer for draw #${d.seq}; ` +
                `${hbar(d.available)} left in the envelope`);
  },
});

console.log(`buyer     ${BUYER}`);
console.log(`key       ${signer.publicKey.toString("hex")}`);
console.log(`           this machine holds no private key for that account\n`);

// --- grant, if the slot is empty -----------------------------------------
const MANDATE_STATE_LEN = 69;

// The envelope, kept here so its digest can be published without publishing
// the envelope itself.
const MANDATE = {
  agentId: Buffer.alloc(20, 0xa1),
  payees: [BigInt(process.env.HEDERA_TREASURY_ID.split(".").pop())],
  budgetTotal: HBAR / 2n,
  perCallMax: HBAR / 10n,
  expiry: 0,
};
const mandateHash = mandateDigest(MANDATE);
let instance;
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

  const payee = MANDATE.payees[0];
  const body = Buffer.alloc(20 + 1 + 8 + 8 + 8 + 4);
  body.fill(0xa1, 0, 20);            // agent id
  body.writeUInt8(1, 20);            // one payee
  body.writeBigUInt64BE(payee, 21);
  body.writeBigUInt64BE(MANDATE.budgetTotal, 29);
  body.writeBigUInt64BE(MANDATE.perCallMax, 37);
  body.writeUInt32BE(0, 45);              // never expires

  const slot = await signer.transport.exchange(
    Buffer.concat([Buffer.from([0xe0, 0x11, 0, 0, body.length]), body]),
  );
  instance = openInstance();
  console.log(`   granted in slot ${slot[0]}, instance ${instance}\n`);
} else {
  const budget = state.readBigUInt64BE(21);
  const available = state.readBigUInt64BE(53);
  const cur = currentInstance();
  instance = cur.id;
  console.log(`1. mandate already in slot 0: ${hbar(available)} of ` +
              `${hbar(budget)} left`);
  if (cur.minted) {
    console.log(`   no grant epoch on file for it — opening ${instance}, so ` +
                `these draws\n   get their own chain instead of joining one ` +
                `they do not belong to`);
  }
  console.log("");
}

// --- pay ------------------------------------------------------------------
const client = new x402Client().register(NETWORK, new ExactHederaScheme(signer));
// allowedAssets: true, with no cap. A host-side ceiling here would shadow the
// one in the chip: whichever is lower refuses first, and if it is this one the
// demo proves nothing except that a number in a JavaScript object can be
// compared. x402 applies spend controls by default and HBAR is not a default
// asset, so this line is what gets out of the way rather than what adds a rule.
client.setSpendControls({ allowedAssets: true });
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

// --- anchor -------------------------------------------------------------
if (process.env.HEDERA_TOPIC_ID && lastDraw) {
  const anchor = makeAnchor({
    topicId: process.env.HEDERA_TOPIC_ID,
    operatorId: process.env.HEDERA_TREASURY_ID,
    operatorKey: process.env.HEDERA_TREASURY_KEY,
  });
  const record = drawRecord({
    mandateHash,
    instance,
    seq: lastDraw.seq,
    payee: MANDATE.payees[0],
    amount: BigInt(accepts.amount),
    remaining: lastDraw.available,
    tx,
    anchor: lastDraw.anchor,
    anchorSig: lastDraw.anchorSig,
  });
  const n = await anchor.submit(record);
  anchor.close();

  console.log(`\n4. anchored as message #${n} on topic ${process.env.HEDERA_TOPIC_ID}`);
  console.log(`   ${JSON.stringify(record)}`);
  console.log(`   https://hashscan.io/testnet/topic/${process.env.HEDERA_TOPIC_ID}`);
}
