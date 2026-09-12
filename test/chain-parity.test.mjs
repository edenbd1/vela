/**
 * The browser verifier and the Node one must agree.
 *
 * web/chain.js exists so a reader can check the audit log without installing
 * anything of ours — which is the whole claim, since a verifier you have to
 * install is one most people will take on faith. But a second implementation
 * is a second thing that can be wrong, and the failure mode is quiet: a
 * browser that reports "complete and consistent" for a chain Node calls
 * broken is worse than having no browser verifier at all.
 *
 * So they are run against the same records and compared line for line.
 *
 *   node --test test/chain-parity.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import { checkChain as nodeCheck, drawRecord, releaseRecord, callRecord,
         splitGrants } from "../hedera/anchor.mjs";
import { checkChain as webCheck, byEnvelope } from "../web/chain.js";

const draw = (seq, amount, remaining, extra = {}) =>
  drawRecord({ mandateHash: "d", instance: "7", seq, payee: 10n,
               amount: BigInt(amount), remaining: BigInt(remaining),
               tx: "0.0.1@1.0", ...extra });

/** Every shape the log can hold, including the ones that should fail. */
const CASES = {
  "a clean chain": [
    draw(1, 10_000_000, 40_000_000),
    draw(2, 8_000_000, 32_000_000),
    draw(3, 1_000_000, 31_000_000),
  ],
  "a gap": [draw(1, 10_000_000, 40_000_000), draw(4, 1_000_000, 39_000_000)],
  "starting mid-sequence": [draw(3, 1_000_000, 39_000_000)],
  "a release between two payments": [
    draw(1, 10_000_000, 40_000_000),
    releaseRecord({ mandateHash: "d", instance: "7", seq: 2, payee: 10n,
                    amount: 5_000_000n, remaining: 35_000_000n }),
    draw(3, 5_000_000, 35_000_000),
  ],
  "a contract call in the middle": [
    draw(1, 10_000_000, 40_000_000),
    callRecord({ mandateHash: "d", instance: "7", seq: 2, contract: 5_000_001n,
                 amount: 5_000_000n, remaining: 35_000_000n }),
    draw(3, 1_000_000, 34_000_000),
  ],
  "arithmetic that does not add up": [
    draw(1, 10_000_000, 40_000_000),
    draw(2, 8_000_000, 39_000_000),
  ],
  "a negative balance": [draw(1, 10_000_000, 40_000_000),
                         draw(2, 60_000_000, -20_000_000)],
  "a single draw": [draw(1, 1_000_000, 49_000_000)],
  "nothing at all": [],
};

for (const [name, records] of Object.entries(CASES)) {
  test(`browser and node agree on: ${name}`, () => {
    const a = nodeCheck(records);
    const b = webCheck(records);
    assert.equal(b.length, a.length, `${a.length} checks in node, ${b.length} in the browser`);
    for (let i = 0; i < a.length; i++) {
      assert.equal(b[i][0], a[i][0], `verdict ${i} differs: "${a[i][1]}" vs "${b[i][1]}"`);
      assert.equal(b[i][1], a[i][1], `wording ${i} differs`);
    }
  });
}

test("the browser groups by envelope and by grant, not by digest alone", () => {
  // Same terms granted twice: same digest, and a counter that restarted.
  // Merging them would read as one envelope whose sequence goes 1,2,1.
  const rs = [
    { ...draw(1, 1_000_000, 49_000_000), m: "d", i: "7" },
    { ...draw(2, 1_000_000, 48_000_000), m: "d", i: "7" },
    { ...draw(1, 1_000_000, 49_000_000), m: "d", i: "9" },
  ];
  const g = byEnvelope(rs);
  assert.equal(g.size, 2);
  assert.deepEqual([...g.keys()].sort(), ["d/7", "d/9"]);
  assert.equal(g.get("d/7").length, 2);
});

test("and sorts each envelope by sequence, whatever order the topic returned", () => {
  const rs = [
    { ...draw(3, 1_000_000, 47_000_000), m: "d", i: "7" },
    { ...draw(1, 1_000_000, 49_000_000), m: "d", i: "7" },
    { ...draw(2, 1_000_000, 48_000_000), m: "d", i: "7" },
  ];
  assert.deepEqual(byEnvelope(rs).get("d/7").map((r) => r.seq), [1, 2, 3]);
});

/* ------------------------------------------------ grants, split the same ---
 * The split that keeps a re-granted envelope from reading as a gap lives in
 * two places — splitGrants in hedera/anchor.mjs and byEnvelope in
 * web/chain.js — so it is two things that can drift. A browser that shows a
 * judge "3 of 4 envelope(s) verify" while the terminal shows 5 of 5 is the
 * exact failure this file exists to prevent, and it is the one a judge is
 * more likely to see: the page is the thing linked from the README.
 */
const at = (seq, i = "7") => ({ ...draw(seq, 1_000_000, 40_000_000), i });

/** Both implementations, reduced to the same shape: a list of seq lists. */
const shapes = (rs) => ({
  node: splitGrants(rs).map((g) => g.map((r) => r.seq)),
  web: [...byEnvelope(rs).values()].map((g) => g.map((r) => r.seq)),
});

test("one grant is one group, in both", () => {
  const { node, web } = shapes([at(1), at(2), at(3)]);
  assert.deepEqual(node, [[1, 2, 3]]);
  assert.deepEqual(web, node);
});

test("the same terms granted twice split the same way in both", () => {
  const { node, web } = shapes([at(1), at(2), at(1)]);
  assert.deepEqual(node, [[1, 2], [1]]);
  assert.deepEqual(web, node);
});

test("a topic returned out of order is still one grant, in both", () => {
  // The distinguisher is a repeated sequence number, not a 1. Shuffled
  // arrival has no repeat, so it must not become two grants — which would
  // turn a fine chain into two, each with a hole.
  const { node, web } = shapes([at(3), at(1), at(2)]);
  assert.deepEqual(node, [[3, 1, 2]]);
  assert.deepEqual(web, [[1, 2, 3]], "the browser sorts within a grant");
});

test("a gap is a gap in both, not a grant boundary", () => {
  const { node, web } = shapes([at(1), at(4)]);
  assert.deepEqual(node, [[1, 4]]);
  assert.deepEqual(web, node);
  // And it still fails, which is the point of not splitting it.
  assert.ok(nodeCheck([at(1), at(4)]).some(([ok, why]) => !ok && /no gap/.test(why)));
});

test("both name the grant when there is more than one", () => {
  const keys = [...byEnvelope([at(1), at(2), at(1)]).keys()];
  assert.deepEqual(keys, ["d/7@1of2", "d/7@2of2"]);
  // One grant keeps the plain key, so nothing changes for every other chain.
  assert.deepEqual([...byEnvelope([at(1), at(2)]).keys()], ["d/7"]);
});
