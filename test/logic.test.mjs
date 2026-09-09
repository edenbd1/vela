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
