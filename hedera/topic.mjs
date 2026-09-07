/**
 * Create the audit topic.
 *
 * One topic per operator. Every decision the chip makes lands here as one
 * line, and anyone can read it without asking us for anything.
 *
 *   node topic.mjs          # standalone
 *   makeTopic()             # from fleet.mjs, which needs the log to be as
 *                           # old as the envelopes it describes
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { AccountId, Client, PrivateKey, TopicCreateTransaction } from "@hiero-ledger/sdk";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(ROOT, ".env") });

/**
 * Create a topic and point .env at it.
 *
 * Exported because granting a fleet has to create the log at the same moment
 * it creates the envelopes. The chip's counter starts at 1 when a mandate is
 * granted, and a verifier expects the first record on a topic to be draw 1 —
 * rotating the topic mid-life leaves a chain starting at 3, which reads as
 * three hidden draws and is refused. Correctly: those draws really are no
 * longer provable from this log.
 */
export async function makeTopic() {
  const operator = AccountId.fromString(process.env.HEDERA_TREASURY_ID);
  const key = PrivateKey.fromStringECDSA(process.env.HEDERA_TREASURY_KEY);
  const client = Client.forTestnet().setOperator(operator, key);

  // No submit key beyond ours: the topic is append-only to us and readable by
  // everyone. An admin key so it can be updated, but nothing here can rewrite
  // history — HCS messages are immutable once they reach consensus.
  const { topicId } = await (
    await new TopicCreateTransaction()
      .setTopicMemo("vela: hardware-enforced spending mandates")
      .setAdminKey(key.publicKey)
      .setSubmitKey(key.publicKey)
      .execute(client)
  ).getReceipt(client);

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

  process.env.HEDERA_TOPIC_ID = topicId.toString();
  client.close();
  return topicId.toString();
}

// Run directly, it just makes one.
if (import.meta.url === `file://${process.argv[1]}`) {
  const id = await makeTopic();
  console.log(`topic     ${id}`);
  console.log(`hashscan  https://hashscan.io/testnet/topic/${id}`);
  console.log("written to .env");
}
