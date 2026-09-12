/**
 * The Flex, from the page, over WebHID.
 *
 * Ledger devices are HID devices, and Chromium-family browsers can open them
 * from a secure context after a user gesture. That is how Ledger's own web
 * tooling talks to them, and it means this console does not need the Python
 * bridge to read the chip — the button in the corner opens the device rather
 * than telling someone to go and run a command in a terminal.
 *
 * What the browser cannot do is hold the device at the same time as something
 * else. macOS hands the HID interface to one process, so if host/bridge.py is
 * up it already has the Flex and `open()` here fails. That is not a bug to
 * paper over: it is the same exclusivity the bridge exists to manage, and the
 * caller is told which process to stop.
 *
 * The framing below is Ledger's HID protocol, not WebHID's: 64-byte packets,
 * a two-byte channel, tag 0x05, and a sequence counter, with the APDU length
 * in the first packet only.
 */
const VENDOR_LEDGER = 0x2c97;
const CHANNEL = 0x0101;
const TAG = 0x05;
const PACKET = 64;

export const supported = () =>
  typeof navigator !== "undefined" && !!navigator.hid && window.isSecureContext;

export function frame(apdu) {
  const body = new Uint8Array(2 + apdu.length);
  new DataView(body.buffer).setUint16(0, apdu.length);
  body.set(apdu, 2);

  const packets = [];
  for (let seq = 0, at = 0; at < body.length || seq === 0; seq++) {
    const head = new Uint8Array(PACKET);
    const dv = new DataView(head.buffer);
    dv.setUint16(0, CHANNEL);
    head[2] = TAG;
    dv.setUint16(3, seq);
    const chunk = body.subarray(at, at + PACKET - 5);
    head.set(chunk, 5);
    packets.push(head);
    at += chunk.length;
  }
  return packets;
}

/**
 * Reassemble, or say that it cannot yet.
 *
 * `null` while packets are still in flight, and that return is the whole
 * point of this function. It used to hand back whatever had arrived so far —
 * `out.slice(0, expected)` on a 57-byte array is a 57-byte array, not a short
 * read anyone would notice — and the caller resolved on it. Everything under
 * 58 bytes worked, which is every reply the device panel makes, so the pill
 * said "Connected" while every mandate read came back truncated with two
 * bytes of somebody's budget parsed as the status word.
 */
export function unframe(packets) {
  let expected = null;
  const out = [];
  for (let i = 0; i < packets.length; i++) {
    const p = packets[i];
    // Ledger's transport multiplexes: tag 0x05 is APDU traffic, and a ping
    // reply on the same channel is not part of this answer.
    if (p.length < 5 || p[2] !== TAG) continue;
    if (expected === null) {
      if (p.length < 7) return null;
      expected = new DataView(p.buffer, p.byteOffset).getUint16(5);
      out.push(...p.subarray(7));
    } else {
      out.push(...p.subarray(5));
    }
    if (out.length >= expected) break;
  }
  if (expected === null || out.length < expected) return null;
  return new Uint8Array(out.slice(0, expected));
}

export class WebHidLedger {
  constructor(device) { this.device = device; }

  /**
   * Ask for a device. Must be called from a click: browsers refuse the
   * picker otherwise, and silently, which looks like the button is broken.
   */
  static async request() {
    const [device] = await navigator.hid.requestDevice({
      filters: [{ vendorId: VENDOR_LEDGER }],
    });
    if (!device) return null;              // the picker was dismissed
    return new WebHidLedger(device);
  }

  /** A device already granted in an earlier session, if there is one. */
  static async existing() {
    const devices = await navigator.hid.getDevices();
    const d = devices.find((x) => x.vendorId === VENDOR_LEDGER);
    return d ? new WebHidLedger(d) : null;
  }

  async open() {
    if (this.device.opened) return;
    try {
      await this.device.open();
    } catch (e) {
      // The message browsers give here names nothing useful, and the cause is
      // almost always the bridge holding the same interface.
      throw new Error(
        "the device is open elsewhere — stop host/bridge.py, or use it instead");
    }
  }

  async close() { if (this.device.opened) await this.device.close(); }

  /** One APDU in, one APDU out, status word included. */
  exchange(apdu, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const packets = [];
      const done = (fn, arg) => {
        clearTimeout(timer);
        this.device.removeEventListener("inputreport", onReport);
        fn(arg);
      };
      const timer = setTimeout(
        () => done(reject, new Error("the device did not answer")), timeout);

      const onReport = (e) => {
        packets.push(new Uint8Array(e.data.buffer));
        const full = unframe(packets);
        if (full) done(resolve, full);
      };

      this.device.addEventListener("inputreport", onReport);
      (async () => {
        for (const p of frame(apdu)) await this.device.sendReport(0, p);
      })().catch((e) => done(reject, e));
    });
  }

  /** BOLOS get-app-name: the one call that answers whatever app is open. */
  async appInfo() {
    const r = await this.exchange(new Uint8Array([0xb0, 0x01, 0, 0, 0]));
    const sw = (r[r.length - 2] << 8) | r[r.length - 1];
    if (sw !== 0x9000) throw new Error(`the device answered 0x${sw.toString(16)}`);
    const nameLen = r[1];
    const name = new TextDecoder().decode(r.subarray(2, 2 + nameLen));
    const verLen = r[2 + nameLen];
    const version = new TextDecoder().decode(
      r.subarray(3 + nameLen, 3 + nameLen + verLen));
    return { app: name, version };
  }
}

/**
 * Lend the device to the rest of the console.
 *
 * Opening the Flex here takes it away from host/bridge.py, and everything on
 * this page that is not the device panel reads the chip through that bridge.
 * The first version of this button therefore connected the Ledger and broke
 * the page it was on: every fleet slot went to `ECONNREFUSED`.
 *
 * So the tab does not keep what it opened. It subscribes here, and answers
 * APDUs on the bridge's behalf — the server binds the bridge's port and
 * forwards. The gateway, the grant script and the agents carry on talking to
 * :8099 and never learn that a browser is at the other end.
 *
 * Returns a handle with `stop()`. Call it before `close()`, or the console
 * will offer a device that is no longer open.
 */
export function lend(ledger, { expect = "Vela", on = () => {} } = {}) {
  let stream = null;
  let stopped = false;
  let queue = Promise.resolve();

  const answer = (body) =>
    fetch("/api/hid/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => { /* the console went away; the tab is about to hear so */ });

  /**
   * One exchange, with host/bridge.py's guard in front of it.
   *
   * The dashboard answers app APDUs with plausible bytes and a success
   * status, so an app closed mid-session does not surface as "the app is
   * closed" — it surfaces as a wrong number nobody questions. The bridge asks
   * who is listening before every command for that reason, and this has to
   * ask too, or lending the device would quietly drop a safety check.
   */
  async function serve({ id, apdu }) {
    const ins = parseInt(apdu.slice(2, 4), 16);
    // Which command is on the wire, while it is on the wire. The page draws a
    // banner from this: three of the app's instructions put a screen up and
    // wait for a finger, and the tab holding the device is the only thing
    // that knows one is in flight. Guessing from how long a call is taking
    // would call a slow USB write an approval.
    on({ working: true, ins });
    try {
      const bytes = Uint8Array.from(apdu.match(/../g).map((h) => parseInt(h, 16)));
      if (!(bytes[0] === 0xb0 && bytes[1] === 0x01)) {
        const { app } = await ledger.appInfo();
        if (app !== expect) {
          return answer({ id, error:
            `the device is on '${app}', not ${expect} — open the app and stay on it` });
        }
      }
      // Long enough for four pages and a held button, as the bridge allows.
      const r = await ledger.exchange(bytes, 180000);
      const sw = (r[r.length - 2] << 8) | r[r.length - 1];
      const data = [...r.subarray(0, r.length - 2)]
        .map((b) => b.toString(16).padStart(2, "0")).join("");
      await answer({ id, data, sw });
    } catch (e) {
      await answer({ id, error: String(e.message ?? e) });
    } finally {
      on({ working: false, ins });
    }
  }

  const start = async () => {
    // The console wants to show which app it is lending, and asking now
    // means a wrong app is reported before anything downstream trips on it.
    let about = { app: "", version: "" };
    try { about = await ledger.appInfo(); } catch { /* said below */ }
    if (stopped) return;

    stream = new EventSource(
      `/api/hid/stream?app=${encodeURIComponent(about.app)}` +
      `&version=${encodeURIComponent(about.version)}`);

    stream.addEventListener("holding", (e) => on({ lending: true, ...JSON.parse(e.data) }));
    stream.addEventListener("refused", (e) => {
      on({ lending: false, ...JSON.parse(e.data) });
      stream.close();
    });
    stream.addEventListener("apdu", (e) => {
      const job = JSON.parse(e.data);
      // Serialised: two APDUs interleaved on the wire corrupt both, and
      // EventSource will happily deliver the second before the first is done.
      queue = queue.then(() => serve(job)).catch(() => {});
    });
    stream.onerror = () => {
      // EventSource retries on its own, which is what we want: a restarted
      // console should get the device back without anyone pressing anything.
      // So this is reported as a blip, not as the end of the lend — the tab
      // must not drop the device every time the console is reloaded.
      if (!stopped) {
        on({ lending: false, transient: true,
             why: "the console is not answering — retrying" });
      }
    };
  };
  start();

  return {
    stop() {
      stopped = true;
      if (stream) stream.close();
      stream = null;
    },
  };
}
