/**
 * The tab standing in for the bridge.
 *
 * This exists because the bug it covers was invisible in every other suite:
 * connecting the Ledger from the page worked, the device panel said
 * "Connected", and the whole rest of the console went to ECONNREFUSED —
 * because macOS had given the HID interface to the browser and taken it from
 * host/bridge.py.
 *
 * What has to hold is that the browser joins the stack rather than replacing
 * it: something that speaks the bridge's protocol on the bridge's port, and
 * that lets go cleanly enough for the real bridge to start again afterwards.
 * That last one is the property worth guarding — a relay that stays bound to
 * a port with no device behind it is worse than one that never bound.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRelay } from "../web/relay.mjs";

const dir = mkdtempSync(join(tmpdir(), "vela-relay-"));
let next = 18700;
const port = () => next++;

/** Stands in for the EventSource response a browser tab holds open. */
function fakeTab() {
  const sent = [];
  return {
    sent,
    write(chunk) {
      const m = chunk.match(/^event: (\w+)\ndata: (.*)\n\n$/s);
      sent.push(m ? { event: m[1], data: JSON.parse(m[2]) } : { raw: chunk });
    },
    end() {},
    jobs: () => sent.filter((s) => s.event === "apdu").map((s) => s.data),
  };
}

const apdu = (p, body) =>
  fetch(`http://127.0.0.1:${p}/apdu`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("a holding tab answers on the bridge's port, in the bridge's shape", async () => {
  const p = port();
  const journal = join(dir, "held.jsonl");
  const relay = createRelay({ port: p, journal });
  const tab = fakeTab();

  const held = await relay.hold(tab, { app: "Vela", version: "1.0.0" });
  assert.equal(held.ok, true);
  assert.equal(relay.held(), true);
  assert.equal(relay.info().app, "Vela");

  // /health is what callers use to decide the device is reachable at all.
  const health = await (await fetch(`http://127.0.0.1:${p}/health`)).json();
  assert.deepEqual(health, { ok: true, transport: "webhid (browser)" });

  // The call the gateway makes, answered by the tab.
  const inflight = apdu(p, { apdu: "e016000000" });
  await new Promise((r) => setTimeout(r, 20));
  const [job] = tab.jobs();
  assert.equal(job.apdu, "e016000000");
  relay.reply({ id: job.id, data: "0102", sw: 0x9000 });

  const r = await inflight;
  assert.equal(r.status, 200);
  // Same two keys host/bridge.py returns, and sw as a number, not a string.
  assert.deepEqual(await r.json(), { data: "0102", sw: 0x9000 });

  // The journal host/bridge.py writes, written by the thing standing in for
  // it. An hour of APDUs missing because they went through a browser is
  // exactly the hour a fourth device reset would need.
  const lines = readFileSync(journal, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(lines[0].event, "bridge_held");
  const ex = lines.find((l) => l.event === "apdu");
  assert.equal(ex.via, "webhid");
  assert.equal(ex.cla, 0xe0);
  assert.equal(ex.ins, 0x16);
  assert.equal(ex.sw, "9000");

  relay.release();
});

test("a refusal from the tab reaches the caller as the bridge's 502", async () => {
  const p = port();
  const relay = createRelay({ port: p, journal: join(dir, "refuse.jsonl") });
  const tab = fakeTab();
  await relay.hold(tab, { app: "Vela" });

  const inflight = apdu(p, { apdu: "e006000000" });
  await new Promise((r) => setTimeout(r, 20));
  relay.reply({ id: tab.jobs()[0].id, error: "the device is on 'BOLOS', not Vela" });

  const r = await inflight;
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /not Vela/);
  relay.release();
});

test("two APDUs do not interleave on the wire", async () => {
  const p = port();
  const relay = createRelay({ port: p, journal: join(dir, "queue.jsonl") });
  const tab = fakeTab();
  await relay.hold(tab, { app: "Vela" });

  const a = apdu(p, { apdu: "e016000000" });
  const b = apdu(p, { apdu: "e018000000" });
  await new Promise((r) => setTimeout(r, 30));

  // Only the first has been handed to the tab: a device is one conversation.
  assert.equal(tab.jobs().length, 1);
  relay.reply({ id: tab.jobs()[0].id, data: "aa", sw: 0x9000 });
  assert.deepEqual(await (await a).json(), { data: "aa", sw: 0x9000 });

  await new Promise((r) => setTimeout(r, 30));
  assert.equal(tab.jobs().length, 2);
  relay.reply({ id: tab.jobs()[1].id, data: "bb", sw: 0x9000 });
  assert.deepEqual(await (await b).json(), { data: "bb", sw: 0x9000 });
  relay.release();
});

test("a second tab is refused rather than quietly taking over", async () => {
  const p = port();
  const relay = createRelay({ port: p, journal: join(dir, "second.jsonl") });
  await relay.hold(fakeTab(), { app: "Vela" });

  const second = await relay.hold(fakeTab(), { app: "Vela" });
  assert.equal(second.ok, false);
  assert.match(second.why, /another tab/);
  relay.release();
});

test("a running host/bridge.py keeps its port, and is named", async () => {
  const p = port();
  const bridge = createServer((_, res) => res.end("{}"));
  await new Promise((r) => bridge.listen(p, "127.0.0.1", r));

  const relay = createRelay({ port: p, journal: join(dir, "taken.jsonl") });
  const held = await relay.hold(fakeTab(), { app: "Vela" });
  assert.equal(held.ok, false);
  assert.match(held.why, /host\/bridge\.py/);
  // And nothing was taken: the tab must not end up holding a device it
  // cannot share, which is the state the whole relay exists to avoid.
  assert.equal(relay.held(), false);

  await new Promise((r) => bridge.close(r));
});

test("releasing frees the port so the real bridge can start again", async () => {
  const p = port();
  const relay = createRelay({ port: p, journal: join(dir, "free.jsonl") });
  await relay.hold(fakeTab(), { app: "Vela" });
  relay.release();
  assert.equal(relay.held(), false);

  // If the listener outlived the tab, this throws EADDRINUSE — and on a real
  // machine that is host/bridge.py refusing to start after a browser refresh.
  const after = createServer((_, res) => res.end("{}"));
  await new Promise((ok, no) => {
    after.once("error", no);
    after.listen(p, "127.0.0.1", ok);
  });
  await new Promise((r) => after.close(r));
});

test("a tab that disappears mid-call fails the call instead of hanging", async () => {
  const p = port();
  const relay = createRelay({ port: p, journal: join(dir, "gone.jsonl") });
  const tab = fakeTab();
  await relay.hold(tab, { app: "Vela" });

  const inflight = apdu(p, { apdu: "e016000000" });
  await new Promise((r) => setTimeout(r, 20));
  relay.release();                       // the browser was closed

  const r = await inflight;
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /disconnected/);
});

test("the port carries APDUs and nothing else", async () => {
  const p = port();
  const relay = createRelay({ port: p, journal: join(dir, "bad.jsonl") });
  const tab = fakeTab();
  await relay.hold(tab, { app: "Vela" });

  for (const body of [{ apdu: "zz00" }, { apdu: "e01" }, { apdu: "e016" }, {}]) {
    const r = await apdu(p, body);
    assert.equal(r.status, 400, `should refuse ${JSON.stringify(body)}`);
  }
  // None of it reached the device.
  assert.equal(tab.jobs().length, 0);

  assert.equal((await fetch(`http://127.0.0.1:${p}/`)).status, 404);
  relay.release();
});

test("with no tab holding it, nothing is listening at all", async () => {
  const p = port();
  createRelay({ port: p, journal: join(dir, "idle.jsonl") });
  // Importing the console must not squat the bridge's port for people who
  // have never opened the page.
  await assert.rejects(() => fetch(`http://127.0.0.1:${p}/health`));
  assert.equal(existsSync(join(dir, "idle.jsonl")), false);
});
