/**
 * A mandate, read off the chip in the browser.
 *
 * hedera/gateway.mjs parses these same 69-plus bytes on the host, and this
 * page has always read them through it. That is the right arrangement when
 * there is a host: the gateway is the thing holding the device, and one
 * parser is one parser.
 *
 * It stops being possible on a static copy of this console. There is no
 * gateway on vercel.app — and yet a browser there can open a Ledger over
 * WebHID, because WebHID needs a secure origin and a click and nothing else.
 * So a reader with a Flex can point a public URL at their own device, with
 * nothing installed, if the page can read what the chip sends back.
 *
 * Two parsers of one wire format is one parser that can drift, and the way
 * that drift shows up is a number on a page that is wrong in a way nobody
 * checks. So test/mandate-parity.test.mjs runs this over responses recorded
 * off a Flex and compares every field against what the gateway made of the
 * same bytes.
 *
 *   slot(1) agent(20) budget(8) reserved(8) spent(8) per_call(8) available(8)
 *   expiry(4) draws(4) | payees | contracts | selectors | recipient_arg
 *   | velocity(12) | label
 */
const STATE_LEN = 69;

const u8 = (v, at) => v.getUint8(at);
const u16 = (v, at) => v.getUint16(at);
const u32 = (v, at) => v.getUint32(at);
const u64 = (v, at) => v.getBigUint64(at);

/**
 * Where each variable-length section starts.
 *
 * Everything after the fixed header is length-prefixed, so the only way to
 * find the label is to walk past the payees, the contracts and the selectors.
 * Kept as one function because three callers walking it separately is three
 * places to get the same arithmetic wrong.
 */
function sections(b, v) {
  if (b.length < 70) return null;
  const payees = 69;
  let off = 70 + u8(v, payees) * 8;
  if (b.length < off + 1) return null;
  const contracts = off;
  off += 1 + u8(v, off) * 8;
  if (b.length < off + 1) return null;
  const selectors = off;
  off += 1 + u8(v, off) * 4;
  const recipientArg = off;
  off += 1;
  const velocity = off;
  if (b.length < off + 12 + 1) {
    return { payees, contracts, selectors, recipientArg, velocity: null, label: off };
  }
  off += 12;
  return { payees, contracts, selectors, recipientArg, velocity, label: off };
}

/**
 * The whole envelope, or null when the slot is empty or the reply is short.
 *
 * `self` is the buyer's account, which the chip does not carry in this reply —
 * the caller passes it, exactly as the gateway passes it from its own
 * environment. Everything else comes off the wire.
 */
export function readMandate(bytes, { self = null } = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < STATE_LEN) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const at = sections(b, v);

  const hex = [...b.subarray(1, 21)]
    .map((x) => x.toString(16).padStart(2, "0")).join("");

  let payees = null;
  if (b.length >= 70) {
    const n = u8(v, 69);
    if (b.length >= 70 + n * 8) {
      payees = Array.from({ length: n }, (_, i) => `0.0.${u64(v, 70 + i * 8)}`);
    }
  }

  let label = null;
  if (at && b.length >= at.label + 1) {
    const n = u8(v, at.label);
    if (b.length >= at.label + 1 + n) {
      label = String.fromCharCode(...b.subarray(at.label + 1, at.label + 1 + n));
    }
  }

  let velocity = null;
  if (at?.velocity !== null && at) {
    const o = at.velocity;
    const windowSecs = u32(v, o);
    const cap = u16(v, o + 4);
    if (windowSecs !== 0 && cap !== 0) {
      velocity = {
        window_seconds: windowSecs,
        max_per_window: cap,
        used_in_window: u16(v, o + 6),
        window_started: u32(v, o + 8),
        note: "draws, not HBAR. The budget bounds how much; this bounds how fast.",
      };
    }
  }

  let calls = null;
  if (at) {
    let off = at.contracts;
    const nContracts = u8(v, off++);
    if (b.length >= off + nContracts * 8 + 1) {
      const contracts = Array.from({ length: nContracts },
                                   (_, i) => `0.0.${u64(v, off + i * 8)}`);
      off += nContracts * 8;
      const nSelectors = u8(v, off++);
      if (b.length >= off + nSelectors * 4 + 1) {
        const selectors = Array.from({ length: nSelectors }, (_, i) =>
          `0x${u32(v, off + i * 4).toString(16).padStart(8, "0")}`);
        off += nSelectors * 4;
        const recipientArg = u8(v, off);
        calls = {
          contracts, selectors,
          recipient_arg: recipientArg === 0xff ? null : recipientArg,
          proceeds: nContracts === 0 || recipientArg === 0xff
            ? "no contract calls permitted"
            : "must return to this account",
        };
      }
    }
  }

  return {
    agent: hex,
    budget_total: u64(v, 21),
    reserved: u64(v, 29),
    spent: u64(v, 37),
    per_call_max: u64(v, 45),
    available: u64(v, 53),
    expiry: u32(v, 61),
    draws_so_far: u32(v, 65),
    label, payees, calls, velocity,
    self,
    asset: "HBAR, in tinybars",
  };
}
