/**
 * Create the buyer account.
 *
 * The point of this script is which key ends up on the account. Given a
 * public key, the account is created under it and nothing on this machine
 * can spend from it — that is how the buyer ends up controlled by the
 * Secure Element rather than by a file in the repo.
 *
 *   node accounts.mjs                    # software key, for wiring the pipeline
 *   node accounts.mjs <ed25519-pubkey>   # the Ledger's key, for the real thing
 */
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

// The .env lives at the repository root, not next to this script.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(ROOT, ".env") });
import {
  AccountCreateTransaction,
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  PublicKey,
} from "@hiero-ledger/sdk";

const treasuryId = AccountId.fromString(process.env.HEDERA_TREASURY_ID);
const treasuryKey = PrivateKey.fromStringECDSA(process.env.HEDERA_TREASURY_KEY);

const client = Client.forTestnet().setOperator(treasuryId, treasuryKey);

const argKey = process.argv[2];
let publicKey;
let softwareKey = null;

if (argKey) {
  publicKey = PublicKey.fromStringED25519(argKey.replace(/^0x/, ""));
  console.log("creating an account under a key this machine does not hold");
} else {
  softwareKey = PrivateKey.generateED25519();
  publicKey = softwareKey.publicKey;
  console.log("creating an account under a software key — pipeline wiring only,");
  console.log("this one can be spent from without the device");
}

const receipt = await (
  await new AccountCreateTransaction()
    .setKeyWithoutAlias(publicKey)
    .setInitialBalance(new Hbar(50))
    .execute(client)
).getReceipt(client);

const id = receipt.accountId.toString();
console.log();
console.log(`account   ${id}`);
console.log(`key       ${publicKey.toStringRaw()}`);
console.log(`balance   50 HBAR`);
console.log(`hashscan  https://hashscan.io/testnet/account/${id}`);

// A software account and a device account are different roles, so they get
// different names. Sharing the HEDERA_BUYER_ prefix once left a software
// key sitting next to a device account id, which signs nothing Hedera will
// accept and fails as INVALID_SIGNATURE far from the cause.
const prefix = softwareKey ? "HEDERA_SOFTWARE_BUYER" : "HEDERA_BUYER";
const lines = [`\n${prefix}_ID=${id}`, `${prefix}_PUBKEY=${publicKey.toStringRaw()}`];
if (softwareKey) {
  lines.push(`${prefix}_KEY=${softwareKey.toStringRaw()}`);
}
appendFileSync(join(ROOT, ".env"), lines.join("\n") + "\n");
console.log("\nwritten to .env");

client.close();
