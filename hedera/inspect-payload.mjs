/** Decode what the software signer produces, so the device can match it. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClientHederaSigner, inspectHederaTransaction } from "@x402/hedera";
import { PrivateKey } from "@hiero-ledger/sdk";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(ROOT, ".env") });

const signer = createClientHederaSigner(
  process.env.HEDERA_SOFTWARE_BUYER_ID,
  PrivateKey.fromStringED25519(process.env.HEDERA_SOFTWARE_BUYER_KEY),
);

const requirements = {
  scheme: "exact",
  network: "hedera:testnet",
  amount: "1000000",
  asset: "0.0.0",
  payTo: process.env.HEDERA_TREASURY_ID,
  maxTimeoutSeconds: 120,
  extra: { feePayer: "0.0.7162784" },
};

const b64 = await signer.createPartiallySignedTransferTransaction(requirements);
const raw = Buffer.from(b64, "base64");
console.log(`payload: ${raw.length} bytes`);
console.log(`hex    : ${raw.toString("hex")}`);
console.log();
console.log("inspected:", JSON.stringify(inspectHederaTransaction(raw), null, 2));
