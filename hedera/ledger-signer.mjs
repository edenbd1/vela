/**
 * A ClientHederaSigner whose key is in a Secure Element.
 *
 * @x402/hedera asks for an account id and one method returning a partially
 * signed TransferTransaction. That is the whole seam, and it is where the
 * device belongs: the chip checks the draw against its mandate, builds the
 * transaction body itself, signs it, and hands back both. This file only
 * wraps those bytes in the envelope Hedera expects.
 *
 * Nothing here can produce a signature, and nothing here can widen a limit.
 * Delete this file and rewrite it however you like — the chip still refuses.
 */
import net from "node:net";

const CLA = 0xe0;
const INS_AUTHORIZE = 0x12;
const INS_SETTLE = 0x13;
const INS_PUBKEY = 0x16;

// --- protobuf, only the four wrappers Hedera needs ------------------------

function varint(n) {
  const out = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

/** field = length-delimited bytes */
function bytesField(field, payload) {
  return Buffer.concat([varint((field << 3) | 2), varint(payload.length), payload]);
}

/**
 * Wrap a signed body the way the network expects.
 *
 *   TransactionList { Transaction { SignedTransaction { bodyBytes, sigMap } } }
 *
 * The SDK emits one entry per consensus node so it can retry; one is enough
 * here, and the facilitator submits it to the node the body names.
 */
function wrapTransaction(bodyBytes, publicKey, signature) {
  const sigPair = Buffer.concat([
    bytesField(1, publicKey), // pubKeyPrefix — the full key is a valid prefix
    bytesField(3, signature), // ed25519
  ]);
  const sigMap = bytesField(1, sigPair);
  const signed = Buffer.concat([bytesField(1, bodyBytes), bytesField(2, sigMap)]);
  const transaction = bytesField(5, signed); // signedTransactionBytes
  return bytesField(1, transaction); // TransactionList.transactionList
}

// --- transport ------------------------------------------------------------

/**
 * Speculos speaks length-prefixed APDUs over TCP. Kept deliberately small:
 * swapping in USB is one class, and the rest of this file does not care.
 */
class SpeculosTransport {
  constructor(host = "127.0.0.1", port = 9999) {
    this.host = host;
    this.port = port;
  }

  async open() {}
  close() {}

  /**
   * One connection per APDU.
   *
   * Speculos closes the socket as soon as it has answered — the `end` and
   * `close` events land immediately after the response. Holding the socket
   * open and writing a second command sends it into the void, and the
   * symptom is a hang on a command that looks perfectly ordinary.
   */
  exchange(apdu) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      let buf = Buffer.alloc(0);
      let done = false;

      const finish = (fn, arg) => {
        if (done) return;
        done = true;
        socket.destroy();
        fn(arg);
      };

      socket.on("connect", () => {
        const header = Buffer.alloc(4);
        header.writeUInt32BE(apdu.length);
        socket.write(Buffer.concat([header, apdu]));
      });

      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len + 2) return;
        const data = buf.subarray(4, 4 + len);
        const sw = buf.readUInt16BE(4 + len);
        if (sw === 0x9000) {
          finish(resolve, data);
        } else {
          finish(reject, Object.assign(new Error(`device refused: 0x${sw.toString(16)}`), { sw }));
        }
      });

      socket.on("error", (e) => finish(reject, e));
      socket.on("close", () => finish(reject, new Error("device closed the connection")));
    });
  }
}

/**
 * The physical device over USB.
 *
 * This is the transport that matters. Speculos is fine for screens and for
 * single commands, but it drops the APDU connection after answering and
 * exits with it, which makes a multi-command flow — grant, draw, settle —
 * impossible to run against the emulator.
 */
export class BridgeTransport {
  constructor(url = process.env.VELA_BRIDGE ?? "http://127.0.0.1:8099") {
    this.url = url;
  }

  async open() {
    const r = await fetch(`${this.url}/health`).catch(() => null);
    if (!r?.ok) {
      throw new Error(`no device bridge at ${this.url} — start host/bridge.py`);
    }
  }

  close() {}

  async exchange(apdu) {
    const r = await fetch(`${this.url}/apdu`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apdu: Buffer.from(apdu).toString("hex") }),
    });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error ?? `bridge failed: ${r.status}`);
    if (body.sw !== 0x9000) {
      throw Object.assign(new Error(`device refused: 0x${body.sw.toString(16)}`), { sw: body.sw });
    }
    return Buffer.from(body.data, "hex");
  }
}

/** Why the chip said no, in words the agent can act on. */
export const REFUSALS = {
  0xb101: "no free mandate slot",
  0xb102: "no mandate in that slot",
  0xb103: "the envelope has expired",
  0xb104: "payee is not on the allowlist",
  0xb105: "over the per-call ceiling",
  0xb106: "over what is left in the envelope",
  0xb107: "settling more than was authorised",
  0xb108: "malformed request",
};

// --- the signer -----------------------------------------------------------

export async function createLedgerHederaSigner({
  accountId,
  slot = 0,
  feePayerFallback = "0.0.7162784",
  transport = new BridgeTransport(),
  onDraw = () => {},
}) {
  await transport.open();
  const publicKey = await transport.exchange(Buffer.from([CLA, INS_PUBKEY, 0, 0, 0]));

  const num = (id) => BigInt(String(id).split(".").pop());

  return {
    accountId,
    publicKey,
    transport,

    async createPartiallySignedTransferTransaction(requirements) {
      const amount = BigInt(requirements.amount);
      const feePayer = requirements.extra?.feePayer ?? feePayerFallback;
      const now = Math.floor(Date.now() / 1000);

      // Everything the chip needs to build the body and judge the draw. It
      // takes none of it on trust: the payee it checks against the mandate is
      // the same value it encodes into the transfer.
      //
      //   slot 1 | fee_payer 8 | from 8 | payee 8 | node 8 | amount 8 |
      //   fee 8 | valid_start_sec 8 | nanos 4 | duration 4 | now 4  = 69
      const req = Buffer.alloc(69);
      let o = 0;
      const u64 = (v) => { req.writeBigUInt64BE(BigInt(v), o); o += 8; };
      const u32 = (v) => { req.writeUInt32BE(Number(v), o); o += 4; };

      req.writeUInt8(slot, o); o += 1;
      u64(num(feePayer));           // pays the network fee: the facilitator
      u64(num(accountId));          // debited: the account this device controls
      u64(num(requirements.payTo)); // credited: checked against the mandate
      u64(3n);                      // consensus node
      u64(amount);
      u64(100_000_000n);            // max network fee
      u64(now);                     // transaction id timestamp
      u32(0);                       // nanos
      u32(120);                     // valid duration
      // The chip has no clock. It judges expiry on the time the host gives
      // it, which sounds worse than it is: a lying host can make a mandate
      // look expired, never make an expired one live again.
      u32(now);

      const apdu = Buffer.concat([
        Buffer.from([CLA, INS_AUTHORIZE, 0, 0, req.length]),
        req,
      ]);

      let reply;
      try {
        reply = await transport.exchange(apdu);
      } catch (e) {
        e.message = REFUSALS[e.sw] ? `refused by the device: ${REFUSALS[e.sw]}` : e.message;
        throw e;
      }

      const seq = reply.readUInt32BE(0);
      const available = reply.readBigUInt64BE(4);
      const bodyLen = reply.readUInt8(12);
      const bodyBytes = reply.subarray(13, 13 + bodyLen);
      const signature = reply.subarray(13 + bodyLen, 13 + bodyLen + 64);

      onDraw({ seq, available, bodyLen, amount });

      this.lastDraw = { seq, quoted: amount };
      return wrapTransaction(bodyBytes, publicKey, signature).toString("base64");
    },

    /** Release the unused headroom once the network has spoken. */
    async settle(actual) {
      if (!this.lastDraw) return;
      const d = Buffer.alloc(17);
      d.writeUInt8(slot, 0);
      d.writeBigUInt64BE(this.lastDraw.quoted, 1);
      d.writeBigUInt64BE(BigInt(actual), 9);
      await transport.exchange(Buffer.concat([Buffer.from([CLA, INS_SETTLE, 0, 0, 17]), d]));
      this.lastDraw = null;
    },

    close() {
      transport.close();
    },
  };
}
