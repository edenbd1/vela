/**
 * What gets written to the public log, and what it lets a stranger prove.
 *
 * Every draw the chip authorises becomes one line on an HCS topic carrying
 * the balance left after it. That turns the history into something checkable
 * by arithmetic alone:
 *
 *   seq strictly increases                nothing was dropped from the log
 *   remaining[n] = remaining[n-1] - amount[n]     the numbers are consistent
 *   remaining never goes negative         the ceiling was never exceeded
 *
 * Deleting a line breaks two of those at once, which is why the log cannot
 * be quietly trimmed.
 *
 * Only the mandate's digest is published. Publishing the envelope would
 * publish the strategy — which accounts an agent may pay, how large it may
 * go, when it must stop — and that is exactly what a counterparty would want
 * to know. A stranger can check that every draw belongs to one fixed
 * envelope without learning its limits.
 */
import { createHash } from "node:crypto";
import { AccountId, Client, PrivateKey, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";

export const SCHEMA = "vela.draw.v1";

/** Stable bytes: sorted keys, no incidental whitespace. */
export function canonical(obj) {
  const keys = Object.keys(obj).sort();
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, obj[k]])));
}

/** A commitment to the envelope that does not reveal it. */
export function mandateDigest({ agentId, payees, budgetTotal, perCallMax, expiry }) {
  const body = canonical({
    agent: Buffer.from(agentId).toString("hex"),
    payees: [...payees].map(String).sort(),
    budget_total: String(budgetTotal),
    per_call_max: String(perCallMax),
    expiry: String(expiry),
  });
  return createHash("sha256").update(body).digest("hex");
}

/**
 * Distinguish one grant from the next.
 *
 * The digest commits to the envelope's *terms*, so granting the same terms
 * twice produces the same digest — and the chip's sequence restarts at 1,
 * which reads as a hole in the chain. The instance separates them.
 *
 * It is chosen by the host, and the chain proves completeness within an
 * instance rather than across all of them. A host that anchors nothing
 * proves nothing, which was always true.
 */
export function drawRecord({ mandateHash, instance, seq, payee, amount,
                             remaining, tx, anchor, anchorSig }) {
  return {
    v: SCHEMA,
    m: mandateHash,
    i: String(instance),
    seq,
    payee: String(payee),
    amount: String(amount),
    remaining: String(remaining),
    tx: tx ?? null,
    // The chip's statement and its signature over it. Without these the log
    // is the host's account of what the chip decided; with them it is the
    // chip's own, and the host is only the courier.
    a: anchor ? Buffer.from(anchor).toString("hex") : null,
    s: anchorSig ? Buffer.from(anchorSig).toString("hex") : null,
  };
}

/** Domain separator, matching the app. A transaction body never starts here. */
export const ANCHOR_TAG = Buffer.from("vela.anchor.v1\0", "latin1");

/**
 * Does the chip's statement match what the record claims, and is it signed?
 *
 *   mandate_id (1) || seq (4) || payee (8) || amount (8) || remaining (8)
 */
export function checkAnchor(record, publicKey, verifyEd25519) {
  if (!record.a || !record.s) return [false, `draw ${record.seq}: not signed by a device`];

  const a = Buffer.from(record.a, "hex");
  if (a.length !== 29) return [false, `draw ${record.seq}: malformed statement`];

  const seq = a.readUInt32BE(1);
  const payee = a.readBigUInt64BE(5);
  const amount = a.readBigUInt64BE(13);
  const remaining = a.readBigUInt64BE(21);

  if (seq !== record.seq || String(payee) !== record.payee ||
      String(amount) !== record.amount || String(remaining) !== record.remaining) {
    return [false, `draw ${record.seq}: the log disagrees with the chip's statement`];
  }

  const ok = verifyEd25519(publicKey, Buffer.from(record.s, "hex"),
                           Buffer.concat([ANCHOR_TAG, a]));
  return ok
    ? [true, `draw ${record.seq}: signed by the device, and the numbers match`]
    : [false, `draw ${record.seq}: signature does not verify`];
}

export function makeAnchor({ topicId, operatorId, operatorKey, network = "testnet" }) {
  const client = Client.forName(network).setOperator(
    AccountId.fromString(operatorId),
    PrivateKey.fromStringECDSA(operatorKey),
  );

  return {
    async submit(record) {
      const receipt = await (
        await new TopicMessageSubmitTransaction()
          .setTopicId(topicId)
          .setMessage(canonical(record))
          .execute(client)
      ).getReceipt(client);
      return receipt.topicSequenceNumber?.toString();
    },
    close: () => client.close(),
  };
}

/**
 * Replay a mandate's history. Returns every check rather than the first
 * failure — a partial answer is worth more than an exception here.
 */
export function checkChain(records) {
  const out = [];
  let prevSeq = 0;
  let prevRemaining = null;

  for (const r of records) {
    const amount = BigInt(r.amount);
    const remaining = BigInt(r.remaining);

    out.push([r.seq === prevSeq + 1, `seq ${r.seq} follows ${prevSeq} with no gap`]);
    prevSeq = r.seq;

    if (prevRemaining !== null) {
      const expected = prevRemaining - amount;
      out.push([remaining === expected,
                `remaining ${remaining} = ${prevRemaining} - ${amount}`]);
    }
    prevRemaining = remaining;

    out.push([remaining >= 0n, `remaining ${remaining} is not negative`]);
  }
  return out;
}

export const STATEMENT = `
  proves        every anchored draw settled on Hedera exactly as recorded,
                in order, against one fixed envelope, and never past its
                ceiling
  does not      that the service delivered anything, that the envelope was a
  prove         sensible size, or that the agent did anything useful
`;
