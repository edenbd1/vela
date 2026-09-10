/**
 * @ledgerhq/hw-transport over the APDU bridge this project already runs.
 *
 * The Key Ring protocol's ApduDevice wants a Transport, and node-hid is not
 * something to add to a repository whose whole claim is that you can audit
 * what it holds. host/bridge.py already owns the USB handle — everything else
 * here speaks to it over HTTP — so this is the same shim, wearing the
 * interface the library expects.
 *
 * Only `exchange` is implemented. The base class turns it into `send`, which
 * is all ApduDevice calls.
 *
 * Long timeouts on purpose: every one of these APDUs may put a screen in
 * front of a person, and a person reading a screen is not a stalled request.
 */
const Transport = require("@ledgerhq/hw-transport").default;

const URL = process.env.VELA_BRIDGE ?? "http://127.0.0.1:8099";

class BridgeTransport extends Transport {
  constructor(timeout = 300_000) {
    super();
    this.timeout = timeout;
  }

  async exchange(apdu) {
    const r = await fetch(`${URL}/apdu`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apdu: Buffer.from(apdu).toString("hex") }),
      signal: AbortSignal.timeout(this.timeout),
    });
    const body = await r.json();
    if (body.error) throw new Error(body.error);
    // The bridge returns data and status word separately; hw-transport wants
    // them concatenated, and reads the status word off the end itself.
    const data = Buffer.from(body.data ?? "", "hex");
    const sw = Buffer.alloc(2);
    sw.writeUInt16BE(body.sw ?? 0x9000);
    return Buffer.concat([data, sw]);
  }

  async close() {}
}

module.exports = { BridgeTransport, BRIDGE_URL: URL };
