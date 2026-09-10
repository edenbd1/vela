/**
 * The host-side logic, asserted.
 *
 * The chip has its own suite; this covers the two places on this side where
 * being wrong is expensive: what a broker will let an agent make it fetch,
 * and whether a published audit chain adds up.
 *
 *   node --test test/
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildUrl } from "../broker/capability.mjs";
import { checkChain, drawRecord, releaseRecord, mandateDigest } from "../hedera/anchor.mjs";

/* ------------------------------------------------------- the broker ----- */

const RISK = {
  url: "http://feed.internal/risk/{account}",
  params: { account: "^0\\.0\\.[0-9]{1,12}$" },
};

test("a declared parameter matching its pattern builds the URL", () => {
  assert.equal(buildUrl(RISK, { account: "0.0.10388937" }),
               "http://feed.internal/risk/0.0.10388937");
});

test("an undeclared parameter is refused", () => {
  // The one that matters: an agent trying to name the endpoint a credential
  // will be attached to.
  assert.throws(() => buildUrl(RISK, { account: "0.0.1", url: "http://evil/collect" }),
                /'url' is not part of this capability/);
});

test("a value that does not match its pattern is refused", () => {
  assert.throws(() => buildUrl(RISK, { account: "../../admin" }), /does not match/);
});

test("a missing parameter is refused rather than left in the template", () => {
  assert.throws(() => buildUrl(RISK, {}), /missing parameter 'account'/);
});

test("a value cannot smuggle in a path, query or authority", () => {
  // Even a value the pattern would allow is encoded, so nothing it contains
  // can change the shape of the URL.
  const loose = { url: "http://feed.internal/risk/{q}", params: { q: "^.+$" } };
  assert.equal(buildUrl(loose, { q: "a/b?c=d#e" }),
               "http://feed.internal/risk/a%2Fb%3Fc%3Dd%23e");
  assert.equal(buildUrl(loose, { q: "evil.example/x" }),
               "http://feed.internal/risk/evil.example%2Fx");
});

test("a template with a placeholder nobody declared is refused", () => {
  const broken = { url: "http://feed.internal/{a}/{b}", params: { a: "^x$" } };
  assert.throws(() => buildUrl(broken, { a: "x" }), /unfilled placeholder/);
});

/* -------------------------------------------------------- the chain ----- */

const rec = (seq, amount, remaining, released) => ({
  seq, amount: String(amount), remaining: String(remaining),
  ...(released ? { r: true } : {}),
});

const failures = (records) => checkChain(records).filter(([ok]) => !ok).map(([, why]) => why);

test("an ordinary chain verifies", () => {
  assert.deepEqual(failures([rec(1, 10, 40), rec(2, 10, 30), rec(3, 10, 20)]), []);
});

test("a gap in the sequence is caught", () => {
  assert.match(failures([rec(1, 10, 40), rec(3, 10, 30)])[0], /seq 3 follows 1/);
});

test("a released draw does not consume budget", () => {
  // The next paying draw starts where the last paying draw left off.
  assert.deepEqual(failures([rec(1, 10, 40), rec(2, 10, 30, true), rec(3, 10, 30)]), []);
});

test("several stacked releases still return their headroom", () => {
  // Reservations accumulate while held, so the signed balance walks down to
  // zero before any of it comes back.
  assert.deepEqual(failures([
    rec(1, 10, 40),
    rec(2, 10, 30, true), rec(3, 10, 20, true), rec(4, 10, 10, true), rec(5, 10, 0, true),
    rec(6, 10, 30),
  ]), []);
});

test("a release that hides a payment is caught", () => {
  // The guarantee: spent would have risen, so the next chip-signed remaining
  // comes back lower than the arithmetic allows.
  assert.match(failures([rec(1, 10, 40), rec(2, 10, 30, true), rec(3, 10, 20)])[0],
               /remaining 20 = 40 - 10/);
});

test("a release claiming more than the envelope held is caught", () => {
  assert.match(failures([rec(1, 10, 40), rec(2, 10, 50, true)])[0], /released within/);
});

test("a negative balance is caught", () => {
  assert.ok(failures([rec(1, 10, 40), rec(2, 50, -10)]).some((w) => /not negative/.test(w)));
});

/* ------------------------------------------------------- the digest ----- */

const TERMS = {
  agentId: Buffer.alloc(20, 0xa1),
  payees: [10388937n],
  budgetTotal: 50_000_000n,
  perCallMax: 10_000_000n,
  expiry: 0,
};

test("the same terms digest the same", () => {
  assert.equal(mandateDigest(TERMS), mandateDigest({ ...TERMS }));
});

test("every term changes the digest", () => {
  for (const [key, value] of Object.entries({
    agentId: Buffer.alloc(20, 0xb2),
    payees: [66666666n],
    budgetTotal: 50_000_001n,
    perCallMax: 10_000_001n,
    expiry: 1,
  })) {
    assert.notEqual(mandateDigest({ ...TERMS, [key]: value }), mandateDigest(TERMS),
                    `changing ${key} left the digest unchanged`);
  }
});

test("a release record carries no transaction and says so", () => {
  const r = releaseRecord({ mandateHash: "x", instance: "1", seq: 1, payee: 1n,
                            amount: 1n, remaining: 1n });
  assert.equal(r.r, true);
  assert.equal(r.tx, null);
});

test("a draw record without a chip signature reports null, not an empty string", () => {
  // "the chip did not sign this" and "the chip signed nothing" have to stay
  // distinguishable to the verifier.
  const r = drawRecord({ mandateHash: "x", instance: "1", seq: 1, payee: 1n,
                         amount: 1n, remaining: 1n, tx: "t" });
  assert.equal(r.a, null);
  assert.equal(r.s, null);
});

/* ------------------------------------------------------------------------ *
 * Values that change under a running process.
 *
 * The gateway anchored three agents' payments to a topic that .env had
 * stopped naming twenty minutes earlier, because dotenv reads once at import
 * and fleet.mjs rewrites the file. The chain was intact on a topic nobody was
 * reading, and the verifier correctly reported an empty log while money was
 * visibly moving.
 * ------------------------------------------------------------------------ */
test("live() reads .env as it is now, not as it was at import", async (t) => {
  const { writeFileSync, readFileSync, existsSync, unlinkSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  const ENV = join(ROOT, ".env");

  const had = existsSync(ENV);
  const before = had ? readFileSync(ENV, "utf8") : null;
  t.after(() => { if (had) writeFileSync(ENV, before); else unlinkSync(ENV); });

  const { live, liveTopic } = await import("../hedera/live-env.mjs");

  writeFileSync(ENV, "HEDERA_TOPIC_ID=0.0.111\n");
  assert.equal(liveTopic(), "0.0.111");

  // The case that mattered: another process rewrites the file while this one
  // is running. Nothing is re-imported and nothing is restarted.
  writeFileSync(ENV, "HEDERA_TOPIC_ID=0.0.222\n");
  assert.equal(liveTopic(), "0.0.222", "a rotated topic must be picked up");

  // Last assignment wins within the file, as dotenv does — fleet.mjs comments
  // out superseded lines rather than deleting them.
  writeFileSync(ENV,
    "# superseded, kept for provenance: HEDERA_TOPIC_ID=0.0.222\n" +
    "HEDERA_TOPIC_ID=0.0.333\n");
  assert.equal(liveTopic(), "0.0.333", "a commented-out line is not a value");

  assert.equal(live("NOT_IN_THE_FILE", "fallback"), "fallback");
});

/* ------------------------------------------------------------------------ *
 * The epoch carries its topic.
 *
 * They have to rotate together or not at all. When they did not, one
 * envelope's first draw landed on one topic and its second on another, and
 * the verifier read a draw numbered 2 with no 1 in front of it.
 * ------------------------------------------------------------------------ */
test("a grant epoch remembers the topic it was opened with", async (t) => {
  const { writeFileSync, readFileSync, existsSync, unlinkSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  const FILE = join(ROOT, ".vela-instance");

  const had = existsSync(FILE);
  const before = had ? readFileSync(FILE, "utf8") : null;
  t.after(() => { if (had) writeFileSync(FILE, before); else if (existsSync(FILE)) unlinkSync(FILE); });

  const { openInstance, currentInstance } = await import("../hedera/instance.mjs");

  const id = openInstance("0.0.4242");
  const cur = currentInstance();
  assert.equal(cur.id, id);
  assert.equal(cur.topic, "0.0.4242", "the topic must survive the round trip");
  assert.equal(cur.minted, false);

  // The old format: a bare timestamp, no topic. Reading it rather than
  // minting a new epoch matters — a fresh epoch would split the chain of a
  // mandate still live in the chip, which is what this file prevents.
  writeFileSync(FILE, "1788000000");
  const old = currentInstance();
  assert.equal(old.id, "1788000000", "an old bare-timestamp file is still an epoch");
  assert.equal(old.topic, null);
  assert.equal(old.minted, false, "reading an old file must not mint a new epoch");

  // No file at all: mint, and say so.
  unlinkSync(FILE);
  assert.equal(currentInstance().minted, true);
});

/* ------------------------------------------------------------------------ *
 * Recovery: what a replacement device is allowed to be told.
 *
 * Every assertion here is about handing back budget that was already spent.
 * None of these failures throw — a wrong answer is a restored envelope with
 * more money in it than the agent had left, which looks like a working
 * recovery.
 * ------------------------------------------------------------------------ */
const { positions, plan } = await import("../hedera/recovery.mjs");

const draw = (m, i, seq, amount, remaining, extra = {}) => ({
  v: "vela.draw.v1", m, i: String(i), seq,
  payee: "10388937", amount: String(amount), remaining: String(remaining),
  tx: "0.0.1@1.0", ...extra,
});

const D = "digest-a";
const digestOf = () => D;
const env = { label: "research-1", budgetTotal: "50000000", perCallMax: "10000000",
              agentId: "aa".repeat(20), payees: ["10388937"], expiry: 0 };

test("a whole chain gives the position it ended at", () => {
  const seen = positions([
    draw(D, 7, 1, 10_000_000, 40_000_000),
    draw(D, 7, 2, 10_000_000, 30_000_000),
    draw(D, 7, 3, 8_000_000, 22_000_000),
  ]);
  const [r] = plan({ mandates: [env], instance: "7", seen, digestOf });
  assert.equal(r.refused, undefined);
  assert.equal(r.seq, 3);
  assert.equal(r.spent, 28_000_000n, "50 - 22 = 28 spent");
  assert.equal(r.draws, 3);
});

test("a chain with a hole in it restores nothing", () => {
  // The hole is the whole point: draws 2 and 3 are missing, so the last
  // record claims more left than the agent really had.
  const seen = positions([
    draw(D, 7, 1, 10_000_000, 40_000_000),
    draw(D, 7, 4, 10_000_000, 30_000_000),
  ]);
  const [r] = plan({ mandates: [env], instance: "7", seen, digestOf });
  assert.equal(r.refused, "the chain for this envelope is broken");
  assert.ok(r.failures.some((f) => /seq 4 follows 1/.test(f)), r.failures.join("; "));
  assert.equal(r.spent, undefined, "a refused envelope carries no position");
});

test("a chain that starts mid-sequence is a hole too", () => {
  // Exactly what the topic-rotation bug produced: draw 1 on the old topic,
  // draw 2 on the new one. Restoring from the new one alone would hand back
  // whatever draw 1 spent.
  const seen = positions([draw(D, 7, 2, 8_000_000, 41_000_000)]);
  const [r] = plan({ mandates: [env], instance: "7", seen, digestOf });
  assert.equal(r.refused, "the chain for this envelope is broken");
});

test("an envelope with no records is refused, not restored at zero", () => {
  const [r] = plan({ mandates: [env], instance: "7", seen: new Map(), digestOf });
  assert.equal(r.refused, "nothing on this topic");
});

test("…unless someone says it was never used", () => {
  const [r] = plan({ mandates: [env], instance: "7", seen: new Map(), digestOf,
                     assumeUnused: true });
  assert.equal(r.refused, undefined);
  assert.equal(r.spent, 0n);
  assert.equal(r.seq, 0);
  assert.equal(r.assumed, true, "and it is marked as an assumption");
});

test("a different grant epoch is a different envelope", () => {
  // Same terms granted twice: same digest, and a counter that restarted.
  // Reading across both would restore the new envelope to the old one's
  // position, or the reverse.
  const seen = positions([
    draw(D, 7, 1, 10_000_000, 40_000_000),
    draw(D, 7, 2, 10_000_000, 30_000_000),
    draw(D, 9, 1, 1_000_000, 49_000_000),
  ]);
  const [older] = plan({ mandates: [env], instance: "7", seen, digestOf });
  const [newer] = plan({ mandates: [env], instance: "9", seen, digestOf });
  assert.equal(older.spent, 20_000_000n);
  assert.equal(newer.spent, 1_000_000n, "the new life starts from its own draw 1");
});

test("a log claiming more left than the envelope held is refused", () => {
  const seen = positions([draw(D, 7, 1, 1_000_000, 99_000_000)]);
  const [r] = plan({ mandates: [env], instance: "7", seen, digestOf });
  assert.match(r.refused ?? "", /99000000 left of a 50000000 envelope/);
});

test("releases do not look like spending", () => {
  // A release gives its headroom back. If recovery counted it as spent, an
  // agent would lose budget it never used on every restore.
  const seen = positions([
    draw(D, 7, 1, 10_000_000, 40_000_000),
    draw(D, 7, 2, 10_000_000, 30_000_000, { tx: null, r: true }),
    draw(D, 7, 3, 5_000_000, 35_000_000),
  ]);
  const [r] = plan({ mandates: [env], instance: "7", seen, digestOf });
  assert.equal(r.refused, undefined, JSON.stringify(r.failures));
  assert.equal(r.spent, 15_000_000n, "10 paid + 5 paid; the release cost nothing");
});

/* ------------------------------------------------------------------------ *
 * A swap is a draw too.
 *
 * AUTHORIZE_CALL burns a sequence number and reserves budget exactly as a
 * transfer does. Leaving contract calls unpublished puts a hole in the chain
 * — the same hole releaseRecord exists to prevent, arriving from the other
 * direction — and the verifier and recovery both correctly refuse the whole
 * envelope when it appears.
 * ------------------------------------------------------------------------ */
const { callRecord } = await import("../hedera/anchor.mjs");

test("a contract call anchors like a draw, and says it is one", () => {
  const r = callRecord({
    mandateHash: "d", instance: 7n, seq: 4, contract: 5_000_001n,
    amount: 5_000_000n, remaining: 30_000_000n,
  });
  assert.equal(r.seq, 4);
  assert.equal(r.payee, "5000001", "the contract stands where the payee stands");
  assert.equal(r.c, true);
  assert.equal(r.tx, null, "the gateway signs the body and does not submit it");
  assert.equal(r.r, undefined, "a call is not a release");
});

test("a chain mixing payments and swaps has no gap in it", () => {
  const chain = [
    drawRecord({ mandateHash: "d", instance: 7n, seq: 1, payee: 10n,
                 amount: 10_000_000n, remaining: 40_000_000n, tx: "0.0.1@1.0" }),
    callRecord({ mandateHash: "d", instance: 7n, seq: 2, contract: 5_000_001n,
                 amount: 5_000_000n, remaining: 35_000_000n }),
    drawRecord({ mandateHash: "d", instance: 7n, seq: 3, payee: 10n,
                 amount: 1_000_000n, remaining: 34_000_000n, tx: "0.0.1@2.0" }),
  ];
  const failures = checkChain(chain).filter(([ok]) => !ok);
  assert.deepEqual(failures, [], JSON.stringify(failures));
});

test("a swap left unpublished is exactly what a gap looks like", () => {
  // The bug this fixed: an agent swaps once and pays twice, the swap goes
  // unrecorded, and the log reads 1, 3 — which the verifier refuses, and
  // which recovery refuses to restore from.
  const chain = [
    drawRecord({ mandateHash: "d", instance: 7n, seq: 1, payee: 10n,
                 amount: 10_000_000n, remaining: 40_000_000n, tx: "0.0.1@1.0" }),
    drawRecord({ mandateHash: "d", instance: 7n, seq: 3, payee: 10n,
                 amount: 1_000_000n, remaining: 34_000_000n, tx: "0.0.1@2.0" }),
  ];
  const failures = checkChain(chain).filter(([ok]) => !ok).map(([, w]) => w);
  assert.ok(failures.some((f) => /seq 3 follows 1/.test(f)), failures.join("; "));
});

test("recovery reads a position from a chain containing swaps", async () => {
  const { positions, plan } = await import("../hedera/recovery.mjs");
  const chain = [
    drawRecord({ mandateHash: "d", instance: "7", seq: 1, payee: 10n,
                 amount: 10_000_000n, remaining: 40_000_000n, tx: "0.0.1@1.0" }),
    callRecord({ mandateHash: "d", instance: "7", seq: 2, contract: 5_000_001n,
                 amount: 5_000_000n, remaining: 35_000_000n }),
  ].map((r) => ({ ...r, m: "d", i: "7" }));

  const [row] = plan({
    mandates: [{ label: "research-1", budgetTotal: "50000000",
                 perCallMax: "10000000", agentId: "aa".repeat(20),
                 payees: ["10"], expiry: 0 }],
    instance: "7", seen: positions(chain), digestOf: () => "d",
  });
  assert.equal(row.refused, undefined, JSON.stringify(row.failures));
  assert.equal(row.seq, 2);
  // A call reserves and is never settled, so its amount counts against the
  // envelope for good. Restoring anything less would hand the budget back.
  assert.equal(row.spent, 15_000_000n);
});
