/**
 * Create the audit topic.
 *
 * One topic per operator. Every decision the chip makes lands here as one
 * line, and anyone can read it without asking us for anything.
 *
 *   node topic.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
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
// Replace, do not append. Two HEDERA_TOPIC_ID lines in one file is a coin
// flip decided by dotenv's last-wins rule, and the loser is invisible: the
// anchoring writes to one topic while a reader points at the other, and the
// log looks empty rather than misrouted. The old value stays as a comment
// because a topic that was written to is worth being able to find again.
const envPath = join(ROOT, ".env");
const env = readFileSync(envPath, "utf8");
const line = `HEDERA_TOPIC_ID=${topicId.toString()}`;
writeFileSync(envPath, /^HEDERA_TOPIC_ID=.*$/m.test(env)
  ? env.replace(/^HEDERA_TOPIC_ID=.*$/m,
      (m) => `# superseded, kept for provenance: ${m}\n${line}`)
  : `${env.trimEnd()}\n${line}\n`);
console.log("written to .env");

client.close();
