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

function frame(apdu) {
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

/** Reassemble, and stop at the length the first packet declared. */
function unframe(packets) {
  let expected = null;
  const out = [];
  for (let i = 0; i < packets.length; i++) {
    const p = packets[i];
    if (i === 0) {
      expected = new DataView(p.buffer, p.byteOffset).getUint16(5);
      out.push(...p.subarray(7));
    } else {
      out.push(...p.subarray(5));
    }
    if (out.length >= expected) break;
  }
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
        const p = new Uint8Array(e.data.buffer);
        packets.push(p);
        try {
          const full = unframe(packets);
          if (full.length) done(resolve, full);
        } catch { /* more packets to come */ }
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
