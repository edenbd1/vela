/**
 * Create the audit topic.
 *
 * One topic per operator. Every decision the chip makes lands here as one
 * line, and anyone can read it without asking us for anything.
 *
 *   node topic.mjs
 */
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { AccountId, Client, PrivateKey, TopicCreateTransaction } from "@hiero-ledger/sdk";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(ROOT, ".env") });

const operator = AccountId.fromString(process.env.HEDERA_TREASURY_ID);
const key = PrivateKey.fromStringECDSA(process.env.HEDERA_TREASURY_KEY);
const client = Client.forTestnet().setOperator(operator, key);

// No submit key: the topic is append-only to us and readable by everyone.
// An admin key so it can be updated, but nothing here can rewrite history —
// HCS messages are immutable once they reach consensus.
const { topicId } = await (
  await new TopicCreateTransaction()
    .setTopicMemo("vela: hardware-enforced spending mandates")
    .setAdminKey(key.publicKey)
    .setSubmitKey(key.publicKey)
    .execute(client)
).getReceipt(client);

console.log(`topic     ${topicId.toString()}`);
console.log(`hashscan  https://hashscan.io/testnet/topic/${topicId.toString()}`);
appendFileSync(join(ROOT, ".env"), `\nHEDERA_TOPIC_ID=${topicId.toString()}\n`);
console.log("written to .env");

client.close();
