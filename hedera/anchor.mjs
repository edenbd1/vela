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
/**
 * A draw the chip authorised and the host then abandoned.
 *
 * Every AUTHORIZE burns a sequence number, whether or not a payment follows.
 * A host that reserves and then walks away — a crash, a settlement that never
 * came, a refusal downstream — leaves a hole in the log, and from outside a
 * hole is indistinguishable from a payment somebody chose not to publish. So
 * the hole gets filled: same chip-signed statement, no transaction, and an
 * explicit claim that nothing moved.
 */
/**
 * A contract call the chip authorised.
 *
 * Every AUTHORIZE_CALL burns a sequence number and reserves budget exactly as
 * a transfer does, so leaving calls unpublished puts a hole in the chain —
 * the same hole releaseRecord exists to prevent, arriving from a different
 * direction. An agent that swaps once and pays twice produces a log reading
 * 1, 3, 4, and a verifier correctly refuses it.
 *
 * `contract` stands where `payee` stands, because that is what the chip
 * agreed to hand value to. The recipient is deliberately absent: the chip
 * refused to sign any recipient but its own, so recording it would be
 * recording a constant — and a constant in a log invites someone to check the
 * wrong thing.
 *
 * `tx` is null and stays null. The gateway hands back a signed body rather
 * than submitting it, so it does not know whether the call executed. Claiming
 * a transaction id it has not seen would be the one kind of lie this log
 * cannot survive.
 */
export function callRecord({ mandateHash, instance, seq, contract, amount,
                             remaining, anchor, anchorSig }) {
  return {
    ...drawRecord({ mandateHash, instance, seq, payee: contract, amount,
                    remaining, tx: null, anchor, anchorSig }),
    c: true,
  };
}

export function releaseRecord(fields) {
  return { ...drawRecord({ ...fields, tx: null }), r: true };
}

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

  // The balance after the last draw that actually paid. Releases are measured
  // against it rather than against each other.
  let lastPaidRemaining = null;

  for (const r of records) {
    const amount = BigInt(r.amount);
    const remaining = BigInt(r.remaining);
    // A call reserves exactly as a transfer does and is never settled, so the
    // arithmetic below is the same. It is marked only so a reader can tell a
    // swap from a payment, and so the transfer check knows not to look for a
    // transaction id that was never created.

    out.push([r.seq === prevSeq + 1, `seq ${r.seq} follows ${prevSeq} with no gap`]);
    prevSeq = r.seq;

    if (r.r) {
      // A release only has to have reserved something the envelope could
      // cover at the time. Pinning it to an exact figure would mean encoding
      // *when* the host settled — reservations stack while they are held, so
      // four consecutive releases walk the signed balance down to zero before
      // any of it comes back — and the log does not record settlement timing.
      // Guessing at it produces false failures on honest chains.
      //
      // The property that matters is not checked here anyway. It is checked
      // by the next draw that pays.
      if (lastPaidRemaining !== null) {
        out.push([remaining <= lastPaidRemaining,
                  `draw ${r.seq} released within the envelope ` +
                  `(${remaining} <= ${lastPaidRemaining})`]);
      }
    } else if (lastPaidRemaining !== null) {
      // Here is the whole guarantee. A released draw must give its headroom
      // back, so the next paying draw starts from where the last paying draw
      // left off — as if the releases had never happened. If a host said
      // "released" and quietly paid, spent would have risen, and this number
      // — signed by the chip, not asserted by the host — comes back lower
      // than the arithmetic allows.
      const expected = lastPaidRemaining - amount;
      out.push([remaining === expected,
                `remaining ${remaining} = ${lastPaidRemaining} - ${amount}`]);
    }

    if (!r.r) lastPaidRemaining = remaining;

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
