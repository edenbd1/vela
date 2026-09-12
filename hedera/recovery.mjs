/**
 * What a replacement device is allowed to be told.
 *
 * Lifted out of recover.mjs for the same reason buildUrl was lifted out of the
 * broker: this is where the damage would be. Every one of these functions
 * decides how much budget an agent gets back, and getting one wrong does not
 * throw — it quietly hands a restored envelope spending it had already done.
 *
 * Nothing here touches the network or the device.
 */
import { checkChain, splitGrants } from "./anchor.mjs";

/**
 * Where each envelope had got to, and whether that can be trusted.
 *
 * Keyed by digest *and* instance together, because the digest commits to the
 * terms and not to the lifetime: granting the same envelope twice gives the
 * same digest and a counter that restarted at 1. Taking the highest sequence
 * across both lives would restore an envelope to a position from a different
 * one.
 */
export function positions(records) {
  const grouped = new Map();
  for (const r of records) {
    const key = `${r.m}/${r.i}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(r);
  }

  const out = new Map();
  for (const [key, all] of grouped) {
    // Revoking an envelope and granting the same terms again inside one
    // instance writes a second chain under the same digest. Merged, it has
    // two draws at seq 1, checkChain calls that a gap, and this refuses to
    // restore the envelope at all — safe, and wrong.
    //
    // The chip holds the latest grant, so that is the one a replacement
    // device has to be put back to. The earlier segments belong to envelopes
    // that were revoked and are not being restored.
    //
    // Split on the order the log has them in, not on the sequence number:
    // sorting first turns [1, 2, 1] into [1, 1, 2] and the split then keeps
    // the *first* grant's tail as the current one. Consensus order is the
    // order these happened, which is exactly what tells the grants apart.
    const grants = splitGrants(all);
    const rs = [...grants.at(-1)].sort((a, b) => a.seq - b.seq);
    // A gap is not cosmetic here. Every missing draw is spending this would
    // hand back: restore from a chain that lost four draws and the agent gets
    // those four draws' worth of budget again. So the continuity check the
    // public verifier runs is run here too, and a broken chain yields no
    // position at all.
    const failures = checkChain(rs).filter(([ok]) => !ok).map(([, why]) => why);
    // Two different "last" here, and conflating them costs budget.
    //
    // `last` is where the chip's counter got to, releases included: a release
    // consumed a sequence number and the replacement device has to continue
    // past it or the next draw collides with one already on the log.
    //
    // `lastPaid` is where the money got to. A release gives its headroom back
    // — checkChain enforces exactly that, one screen up — but the release
    // record itself is published with the *pre-release* balance, and its
    // remaining is deliberately only bounded rather than exact. Reading spend
    // off it restores an envelope short by the whole released draw, silently,
    // every time a chain happens to end on a release. hedera/refusals.mjs
    // ends every run that way.
    out.set(key, { last: rs.at(-1), lastPaid: rs.filter((r) => !r.r).at(-1),
                   count: rs.length, failures,
                   // Surfaced so an operator restoring a device is told the
                   // log held more than one grant of these terms, and that
                   // this took the last of them.
                   grants: grants.length });
  }
  return out;
}

/**
 * What to restore, and what to refuse.
 *
 * `digestOf` is passed in rather than imported so a caller can be tested
 * without recomputing SHA-256 by hand.
 */
export function plan({ mandates, instance, seen, digestOf, assumeUnused = false }) {
  const out = [];
  for (const m of mandates) {
    const digest = digestOf(m);
    const found = seen.get(`${digest}/${instance}`);
    const budget = BigInt(m.budgetTotal);

    if (!found) {
      // Either it never drew, or its draws are on a topic this is not
      // reading — and the chain cannot tell those apart. One restores at zero
      // correctly; the other hands back everything spent. So it is refused
      // unless someone says which it is.
      out.push(assumeUnused
        ? { ...m, digest, seq: 0, spent: 0n, assumed: true }
        : { ...m, digest, refused: "nothing on this topic" });
      continue;
    }

    if (found.failures.length) {
      out.push({ ...m, digest, refused: "the chain for this envelope is broken",
                 failures: found.failures });
      continue;
    }

    // Nothing paid on this chain — every record is a release — so the
    // envelope is where it was granted, at the sequence the releases reached.
    const remaining = found.lastPaid ? BigInt(found.lastPaid.remaining) : budget;
    // A chain claiming more left than the envelope ever held describes some
    // other envelope, whatever its digest says. The chip refuses this too;
    // catching it here means saying why rather than reading `bad_request`.
    if (remaining > budget) {
      out.push({ ...m, digest,
                 refused: `the log says ${remaining} left of a ${budget} envelope` });
      continue;
    }

    out.push({ ...m, digest, seq: found.last.seq, spent: budget - remaining,
               draws: found.count });
  }
  return out;
}
