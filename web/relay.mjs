/**
 * The browser, standing in for host/bridge.py.
 *
 * WebHID let the page open the Flex itself, which removed the terminal from
 * the story and immediately broke everything else on the page: macOS gives
 * the HID interface to one process, so the moment the browser took the
 * device the bridge lost it, and the gateway — and therefore the fleet, the
 * envelope, every number on the console — went to `ECONNREFUSED`. Pressing
 * Connect blanked the screen.
 *
 * Handing the device back and forth would have made Connect a heavy, stateful
 * action. Teaching the page to read the chip itself would have given the
 * console a second implementation of every APDU, disagreeing with the first.
 *
 * So instead of taking the device away from the stack, the browser joins it.
 * This speaks host/bridge.py's protocol on host/bridge.py's port, and answers
 * by asking the page that is holding the device. Nothing downstream knows the
 * difference: the gateway still POSTs to :8099, `grant` still works, and a
 * page that opened the Flex is no longer a page that broke the console.
 *
 *     no browser holding it   bridge.py binds :8099, as it always did
 *     a browser holding it    this binds :8099, and the tab answers
 *
 * It carries bytes and nothing else — same as the thing it replaces. It
 * cannot approve, cannot widen a limit, and holds no key.
 */
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

// A grant waits for a human to read four pages and hold a button, so the
// wait here is the bridge's, not a web request's. Same number as
// host/bridge.py's APPROVAL_TIMEOUT_MS, and for the same reason.
const APPROVAL_TIMEOUT_MS = 180_000;

// One device, one caller at a time. Bytes for two APDUs interleaved on the
// wire corrupt both, so a second request waits rather than racing.
export function createRelay({ port, journal }) {
  let holder = null;        // the SSE response of the tab holding the device
  let listener = null;      // our stand-in for the bridge, once bound
  let meta = null;          // what the tab said it had: app, version, since
  let seq = 0;
  const pending = new Map();
  let queue = Promise.resolve();

  /**
   * The same journal host/bridge.py writes.
   *
   * Not optional. That file exists because three factory resets produced
   * three sets of half-remembered evidence, and an hour of APDUs missing
   * from it because they happened to go through a browser is exactly the
   * hour someone will want back.
   */
  const note = (event, fields = {}) => {
    try {
      appendFileSync(journal, JSON.stringify({
        t: Date.now() / 1000,
        iso: new Date().toISOString().slice(0, 19),
        event, via: "webhid", ...fields,
      }) + "\n");
    } catch { /* instrumentation must not break the run */ }
  };

  /** Ask the tab for one exchange. Queued: one conversation at a time. */
  function exchange(hex) {
    const run = () => new Promise((resolve, reject) => {
      if (!holder) return reject(new Error("no browser is holding the device"));
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        // The tab was closed mid-approval, or the user walked away from a
        // screen. Either way the caller gets a bridge-shaped error.
        reject(new Error("the page holding the device did not answer"));
      }, APPROVAL_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      try {
        holder.write(`event: apdu\ndata: ${JSON.stringify({ id, apdu: hex })}\n\n`);
      } catch (e) {
        clearTimeout(timer); pending.delete(id); reject(e);
      }
    });
    // Chain even on failure, so one timeout does not wedge the queue.
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  }

  function handle(req, res) {
    const reply = (code, body) => {
      const raw = JSON.stringify(body);
      res.writeHead(code, { "content-type": "application/json" });
      res.end(raw);
    };
    if (req.method === "GET" && req.url === "/health") {
      return reply(200, { ok: Boolean(holder), transport: "webhid (browser)" });
    }
    if (req.method !== "POST" || req.url !== "/apdu") {
      return reply(404, { error: "not found" });
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1 << 20) req.destroy();
    });
    req.on("end", async () => {
      let hex;
      try { hex = String(JSON.parse(body).apdu).toLowerCase(); }
      catch (e) { return reply(400, { error: `bad request: ${e.message}` }); }
      if (!/^[0-9a-f]*$/.test(hex) || hex.length < 8 || hex.length % 2) {
        return reply(400, { error: "bad request: apdu must be hex" });
      }
      try {
        const r = await exchange(hex);
        note("apdu", {
          cla: parseInt(hex.slice(0, 2), 16), ins: parseInt(hex.slice(2, 4), 16),
          lc: hex.length / 2 - 5, sw: r.sw.toString(16).padStart(4, "0"),
        });
        reply(200, { data: r.data, sw: r.sw });
      } catch (e) {
        note("transport_error", {
          cla: parseInt(hex.slice(0, 2), 16), ins: parseInt(hex.slice(2, 4), 16),
          error: String(e.message ?? e).slice(0, 120),
        });
        // 502 with {error}, which is what host/bridge.py returns and what
        // every caller of it already knows how to read.
        reply(502, { error: String(e.message ?? e) });
      }
    });
  }

  return {
    held: () => Boolean(holder),
    info: () => (holder ? { ...meta } : null),

    /**
     * A tab says it has the device. Bind the bridge's port, or say why not.
     *
     * Refusing loudly matters: the two ways this fails — the real bridge is
     * running, another tab got there first — have different fixes, and both
     * look like "connect did nothing" if the page is not told.
     */
    async hold(res, about) {
      if (holder) {
        return { ok: false,
                 why: "another tab is already holding the device for this console" };
      }
      if (!listener) {
        const bound = await new Promise((resolve) => {
          const s = createServer(handle);
          s.once("error", (e) => resolve({ ok: false, why: e.code === "EADDRINUSE"
            ? `host/bridge.py is already on :${port} — stop it, and this page can take over`
            : `could not listen on :${port}: ${e.message}` }));
          s.listen(port, "127.0.0.1", () => resolve({ ok: true, server: s }));
        });
        if (!bound.ok) return bound;
        listener = bound.server;
      }
      holder = res;
      meta = { ...about, since: Date.now() };
      note("bridge_held", { app: about?.app ?? null, version: about?.version ?? null });
      return { ok: true, port };
    },

    /** The tab is gone, or gave the device back. */
    release() {
      if (!holder) return;
      holder = null;
      meta = null;
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error("the page holding the device disconnected"));
        pending.delete(id);
      }
      // Unbind. Leaving a dead listener on :8099 would be worse than nothing:
      // host/bridge.py could no longer start, and every caller would get a
      // confident refusal from a port with no device behind it.
      if (listener) { listener.close(); listener = null; }
      note("bridge_released");
    },

    /** An answer from the tab, good or bad. */
    reply({ id, data, sw, error }) {
      const p = pending.get(id);
      if (!p) return false;                 // timed out, or not ours
      clearTimeout(p.timer);
      pending.delete(id);
      if (error) p.reject(new Error(String(error)));
      else p.resolve({ data: String(data ?? ""), sw: Number(sw) });
      return true;
    },
  };
}
