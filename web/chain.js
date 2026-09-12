/**
 * The audit chain, checked in your browser.
 *
 * A second implementation of what hedera/verify.mjs does, in the language the
 * page already speaks, so a reader can check the log without running anything
 * of ours. That is the whole point: the claim is "you do not have to trust
 * this repository", and a verifier you have to install is a verifier most
 * people will take on faith.
 *
 * A second implementation is also a second thing that can be wrong, so it is
 * not left to agree by inspection — test/chain-parity.test.mjs runs the same
 * records through both and fails if they differ.
 *
 * Node's Buffer is not here, so everything is Uint8Array and DataView, and
 * the signature check is WebCrypto's Ed25519 rather than a bundled library.
 * Nothing in this file talks to a Vela host: the only origin it contacts is
 * Hedera's public mirror node.
 */

export const SCHEMA = "vela.draw.v1";
export const MIRROR = "https://testnet.mirrornode.hedera.com/api/v1";

/** "vela.anchor.v1\0" — the domain tag the chip signs under. */
export const ANCHOR_TAG = new TextEncoder().encode("vela.anchor.v1\0");

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const unhex = (s) =>
  Uint8Array.from((s ?? "").match(/../g) ?? [], (h) => parseInt(h, 16));

const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/* --------------------------------------------------------------- reading */

/**
 * Every Vela record on a topic, oldest first.
 *
 * The topic is public and anyone may write to it, so anything that is not
 * ours is skipped rather than treated as corruption.
 */
export async function readTopic(topic, mirror = MIRROR) {
  const out = [];
  let next = `${mirror}/topics/${topic}/messages?limit=100&order=asc`;
  while (next) {
    const page = await (await fetch(next)).json();
    for (const m of page.messages ?? []) {
      try {
        const r = JSON.parse(new TextDecoder().decode(b64(m.message)));
        if (r.v === SCHEMA) out.push(r);
      } catch { /* not ours */ }
    }
    const link = page.links?.next ?? null;
    next = link ? (link.startsWith("http") ? link : mirror.replace(/\/api\/v1$/, "") + link) : null;
  }
  return out;
}

/** The Ed25519 key Hedera holds for an account. */
export async function deviceKeyOf(account, mirror = MIRROR) {
  const d = await (await fetch(`${mirror}/accounts/${account}`)).json();
  const key = d?.key;
  if (!key || !/ED25519/i.test(key._type ?? "")) return null;
  return unhex(key.key);
}

/* -------------------------------------------------------------- checking */

/**
 * Sequence continuity and the arithmetic between draws.
 *
 * Deliberately the same rules as hedera/anchor.mjs, including the awkward
 * one: a release only has to fit inside the envelope, because reservations
 * stack while they are held and the log does not record settlement timing.
 * What a release really costs is checked by the next draw that pays.
 */
export function checkChain(records) {
  const out = [];
  let prevSeq = 0;
  let lastPaidRemaining = null;

  for (const r of records) {
    const amount = BigInt(r.amount);
    const remaining = BigInt(r.remaining);

    out.push([r.seq === prevSeq + 1, `seq ${r.seq} follows ${prevSeq} with no gap`]);
    prevSeq = r.seq;

    if (r.r) {
      if (lastPaidRemaining !== null) {
        out.push([remaining <= lastPaidRemaining,
                  `draw ${r.seq} released within the envelope ` +
                  `(${remaining} <= ${lastPaidRemaining})`]);
      }
    } else if (lastPaidRemaining !== null) {
      const expected = lastPaidRemaining - amount;
      out.push([remaining === expected,
                `remaining ${remaining} = ${lastPaidRemaining} - ${amount}`]);
    }

    if (!r.r) lastPaidRemaining = remaining;
    out.push([remaining >= 0n, `remaining ${remaining} is not negative`]);
  }
  return out;
}

/**
 * The chip's own statement about a draw, and its signature over it.
 *
 * 29 bytes: slot, sequence, payee, amount, remaining. Without this the log is
 * the host's account of what the chip decided. With it, the host is only the
 * courier.
 */
export async function checkAnchor(record, publicKey) {
  if (!record.a || !record.s) return [false, `draw ${record.seq}: not signed by a device`];

  const a = unhex(record.a);
  if (a.length !== 29) return [false, `draw ${record.seq}: malformed statement`];

  const v = new DataView(a.buffer, a.byteOffset, a.byteLength);
  const seq = v.getUint32(1);
  const payee = v.getBigUint64(5);
  const amount = v.getBigUint64(13);
  const remaining = v.getBigUint64(21);

  if (seq !== record.seq || String(payee) !== record.payee ||
      String(amount) !== record.amount || String(remaining) !== record.remaining) {
    return [false, `draw ${record.seq}: the log disagrees with the chip's statement`];
  }
  if (!publicKey) return [false, `draw ${record.seq}: no device key to check against`];

  try {
    const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" },
                                              false, ["verify"]);
    const ok = await crypto.subtle.verify("Ed25519", key, unhex(record.s),
                                          cat(ANCHOR_TAG, a));
    return ok
      ? [true, `draw ${record.seq}: signed by the device, and the numbers match`]
      : [false, `draw ${record.seq}: signature does not verify`];
  } catch (e) {
    // Ed25519 landed in browsers late. Saying so is better than reporting a
    // signature failure for a signature nobody checked.
    return [null, `draw ${record.seq}: this browser cannot check Ed25519 (${e.name})`];
  }
}

/** Did the transfer this record claims really settle, exactly as claimed? */
export async function checkTransfer(record, mirror = MIRROR) {
  if (record.r) return [true, `draw ${record.seq}: released, nothing paid`];
  if (record.c) {
    return [true, `draw ${record.seq}: contract call on 0.0.${record.payee}, ` +
                  `signed on the device and submitted elsewhere`];
  }
  if (!record.tx) return [false, `draw ${record.seq} names no transaction`];

  const id = record.tx.replace("@", "-").replace(/\.(\d+)$/, "-$1");
  const d = await (await fetch(`${mirror}/transactions/${id}`)).json();
  const t = d.transactions?.[0];
  if (!t) return [false, `draw ${record.seq}: ${record.tx} is not on chain`];
  if (t.result !== "SUCCESS") return [false, `draw ${record.seq}: ${t.result}`];

  const debited = t.transfers.find((x) => String(x.amount) === `-${record.amount}`);
  if (debited) record.payer = debited.account;

  const credited = t.transfers.find(
    (x) => x.account.endsWith(`.${record.payee}`) && String(x.amount) === record.amount);
  return credited
    ? [true, `draw ${record.seq}: ${record.amount} tinybars reached 0.0.${record.payee}`]
    : [false, `draw ${record.seq}: no transfer of ${record.amount} to 0.0.${record.payee}`];
}

/**
 * Group by envelope, by the grant that opened it, and then by each grant of
 * those terms.
 *
 * The last of those is not free. Two envelopes granted with identical terms
 * inside one instance share a mandate digest — the chip's statement names the
 * slot, not the grant — so merged they carry two draws at seq 1, and the
 * continuity check calls that a gap. The chip's counter is what tells them
 * apart: it goes back to zero on a grant, so one envelope can never use the
 * same sequence number twice.
 *
 * The split is on the order the log has them in, not on the sequence number.
 * Sorting first turns [1, 2, 1] into [1, 1, 2] and splits in the wrong place.
 *
 * Kept in step with splitGrants in hedera/anchor.mjs by
 * test/chain-parity.test.mjs — a verifier that agrees with itself in a
 * terminal and disagrees in a browser is the one failure the last shot of the
 * demo would show a judge.
 */
export function byEnvelope(records) {
  const collected = new Map();
  for (const r of records) {
    const key = `${r.m}/${r.i}`;
    if (!collected.has(key)) collected.set(key, []);
    collected.get(key).push(r);
  }

  const groups = new Map();
  for (const [key, all] of collected) {
    const grants = [];
    let current = [];
    let seen = new Set();
    for (const r of all) {
      // A repeat, not a restart at 1: a topic returned out of order is still
      // one envelope, and [3, 1, 2] must not become two grants.
      if (seen.has(r.seq)) { grants.push(current); current = []; seen = new Set(); }
      current.push(r);
      seen.add(r.seq);
    }
    if (current.length) grants.push(current);

    grants.forEach((rs, n) => {
      rs.sort((a, b) => a.seq - b.seq);
      // "of" rather than "/": the key is already separated by slashes, so a
      // "1/2" in it loses its second half to key.split("/").
      groups.set(grants.length > 1 ? `${key}@${n + 1}of${grants.length}` : key, rs);
    });
  }
  return groups;
}
