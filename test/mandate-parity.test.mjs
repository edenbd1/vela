/**
 * The browser's mandate parser against the gateway's.
 *
 * A static copy of this console has no gateway — and a browser there can
 * still open a Ledger over WebHID, because that needs a secure origin and a
 * click and nothing else. So the page reads the chip's reply itself, which
 * means there are two parsers of one wire format.
 *
 * That is the shape of bug this project keeps finding: two readers of the
 * same bytes, and the one nobody checks against a device drifts. The gateway
 * is checked against a device constantly. This one is checked against the
 * gateway, over responses recorded off a Flex — every field, not a spot check.
 *
 *   node --test test/mandate-parity.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readMandate } from "../web/mandate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(join(HERE, "fixtures", "mandate-bytes.json"), "utf8"));

const bytes = (hex) =>
  Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16)));

/** The gateway serialises BigInts as strings; compare like for like. */
const plain = (v) =>
  typeof v === "bigint" ? String(v)
  : Array.isArray(v) ? v.map(plain)
  : v && typeof v === "object" ? Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, plain(x)]))
  : v;

test("the fixture holds real envelopes, not placeholders", () => {
  const slots = Object.keys(FIXTURE);
  assert.ok(slots.length >= 3, `only ${slots.length} slot(s) recorded`);
  for (const s of slots) {
    assert.ok(FIXTURE[s].apdu.length > 140, `slot ${s} is too short to be one`);
    assert.ok(FIXTURE[s].gateway?.label, `slot ${s} has no label`);
  }
});

for (const [slot, rec] of Object.entries(FIXTURE)) {
  test(`slot ${slot} reads the same in a browser as on the host`, () => {
    const said = rec.gateway;
    const mine = plain(readMandate(bytes(rec.apdu), { self: said.self }));

    // Every field the console draws. Listed rather than deep-equalled so a
    // failure names the field, and so adding one to the gateway without
    // adding it here is a visible gap rather than a silent one.
    for (const k of ["agent", "budget_total", "reserved", "spent",
                     "per_call_max", "available", "expiry", "draws_so_far",
                     "label", "asset"]) {
      assert.deepEqual(mine[k], said[k], `${k} on slot ${slot}`);
    }
    assert.deepEqual(mine.payees, said.payees, `payees on slot ${slot}`);
    assert.deepEqual(mine.calls, said.calls ?? null, `calls on slot ${slot}`);
    assert.deepEqual(mine.velocity, said.velocity ?? null,
                     `velocity on slot ${slot}`);
  });
}

test("a reply too short to be an envelope is null, not a guess", () => {
  const real = bytes(Object.values(FIXTURE)[0].apdu);
  for (const n of [0, 1, 40, 68]) {
    assert.equal(readMandate(real.subarray(0, n)), null, `${n} bytes`);
  }
  assert.ok(readMandate(real), "and the whole thing still reads");
});

test("the fields the page shows are never undefined", () => {
  // A missing field renders as "undefined" in a card, which is worse than a
  // dash: it looks like a value.
  const m = readMandate(bytes(Object.values(FIXTURE)[0].apdu), { self: "0.0.1" });
  for (const [k, v] of Object.entries(m)) {
    assert.notEqual(v, undefined, `${k} came back undefined`);
  }
});
