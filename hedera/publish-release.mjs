/**
 * Anchor a draw that was authorised and then given back.
 *
 * A tool that asks the chip to authorise something burns a sequence number
 * whether or not it goes on to pay. Settling to zero returns the money; it
 * does not return the number. So a check that draws and walks away leaves the
 * log ending before the chip does — invisible to verify.mjs, because a hole
 * at the end of a chain has nothing after it to be discontinuous with, and
 * fatal to the next draw that *is* published.
 *
 * host/verify_body.py is in Python and the anchoring lives here, so this is
 * the seam. It takes what the chip already said — the statement it signed and
 * the signature over it — and publishes the release. Nothing is invented: a
 * release nobody can verify would be worse than the hole.
 *
 *   node hedera/publish-release.mjs <slot> <seq> <payee> <amount> <remaining> <anchorHex> <sigHex>
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import { BridgeTransport } from "./ledger-signer.mjs";
import { makeAnchor, mandateDigest, releaseRecord } from "./anchor.mjs";
import { currentInstance } from "./instance.mjs";
import { live, liveTopic } from "./live-env.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(ROOT, ".env") });

const [slot, seq, payee, amount, remaining, anchorHex, sigHex] = process.argv.slice(2);
if (!sigHex) {
  console.log("usage: publish-release.mjs <slot> <seq> <payee> <amount> <remaining> <anchor> <sig>");
  process.exit(2);
}

const topic = liveTopic();
if (!topic) {
  console.log("no topic — nothing to publish to");
  process.exit(0);
}

const t = new BridgeTransport();
await t.open();
const s = await t.exchange(Buffer.from([0xe0, 0x10, Number(slot), 0, 0]));
t.close();

const anchor = makeAnchor({
  topicId: topic,
  operatorId: live("HEDERA_TREASURY_ID"),
  operatorKey: live("HEDERA_TREASURY_KEY"),
});

const n = await anchor.submit(releaseRecord({
  mandateHash: mandateDigest({
    agentId: s.subarray(1, 21),
    payees: Array.from({ length: s.readUInt8(69) },
                       (_, i) => s.readBigUInt64BE(70 + i * 8)),
    budgetTotal: s.readBigUInt64BE(21),
    perCallMax: s.readBigUInt64BE(45),
    expiry: s.readUInt32BE(61),
  }),
  instance: currentInstance().id,
  seq: Number(seq),
  payee: BigInt(payee),
  amount: BigInt(amount),
  remaining: BigInt(remaining),
  anchor: Buffer.from(anchorHex, "hex"),
  anchorSig: Buffer.from(sigHex, "hex"),
}));
anchor.close();
console.log(`draw ${seq} released, published as message #${n}`);
