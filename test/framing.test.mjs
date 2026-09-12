/**
 * Ledger's HID framing, as web/ledger.js does it.
 *
 * This suite exists because the page connected to a Flex, said "Connected",
 * reported the app and the version — and read every mandate short. The panel
 * only ever asks b001, whose reply is fourteen bytes and fits in one packet,
 * so the one call anyone could see working was the one call that could not
 * expose the bug. Everything over 57 bytes came back truncated with two bytes
 * of a budget parsed as the status word.
 *
 * The sizes below are chosen around the boundaries: one packet, exactly one
 * packet, one byte over, and a mandate-sized reply.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { frame, unframe } from "../web/ledger.js";

/** What a device sends back: the same framing, in the other direction. */
const bytes = (n, seed = 1) =>
  Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 0xff);

test("a reply that fits in one packet round-trips", () => {
  const apdu = bytes(14);
  assert.deepEqual(unframe(frame(apdu)), apdu);
});

test("a reply spanning packets round-trips", () => {
  // 57 is what fits in the first packet; 59 in each one after.
  for (const n of [56, 57, 58, 59, 116, 117, 255, 1024]) {
    const apdu = bytes(n, n);
    assert.deepEqual(unframe(frame(apdu)), apdu, `${n} bytes`);
  }
});

test("an incomplete reply is null, not a short one", () => {
  // The bug. A caller that resolves on anything truthy would have taken this
  // 57-byte fragment as a 300-byte mandate and read the status word out of
  // the middle of it.
  const packets = frame(bytes(300));
  assert.ok(packets.length > 1);
  for (let i = 1; i < packets.length; i++) {
    assert.equal(unframe(packets.slice(0, i)), null, `${i} of ${packets.length}`);
  }
  assert.equal(unframe(packets).length, 300);
});

test("a mandate-sized reply keeps its status word at the end", () => {
  // How web/ledger.js reads a reply: the last two bytes are the status word
  // and everything before them is the answer. Off by one packet and the
  // status word comes out of the payload — which is how "0x2d31" happened,
  // the two bytes being the tail of the label "research-1".
  const payload = bytes(180, 3);
  const reply = Uint8Array.from([...payload, 0x90, 0x00]);
  const got = unframe(frame(reply));
  const sw = (got[got.length - 2] << 8) | got[got.length - 1];
  assert.equal(sw, 0x9000);
  assert.deepEqual(got.subarray(0, got.length - 2), payload);
});

test("traffic that is not this answer is skipped", () => {
  // Tag 0x02 is a ping on the same channel. Counting it as payload shifts
  // everything after it.
  const apdu = bytes(120, 9);
  const packets = frame(apdu);
  const ping = new Uint8Array(64);
  ping[0] = 0x01; ping[1] = 0x01; ping[2] = 0x02;
  assert.deepEqual(unframe([ping, ...packets]), apdu);
  assert.deepEqual(unframe([packets[0], ping, ...packets.slice(1)]), apdu);
});

test("a first packet too short to hold a length is not guessed at", () => {
  assert.equal(unframe([new Uint8Array([0x01, 0x01, 0x05, 0, 0])]), null);
  assert.equal(unframe([]), null);
});
