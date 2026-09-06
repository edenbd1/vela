/**
 * The claim, on hardware: an agent may trade, and may not exfiltrate.
 *
 * A transfer names its payee in the transaction body, so a mandate can check
 * it without understanding anything. A contract call names only the contract.
 * Where the value lands is decided by ABI-encoded arguments the body does not
 * interpret — and under prompt injection, the recipient argument is precisely
 * what an attacker rewrites, because it turns a legitimate-looking swap into
 * a theft while the contract, the function and the amount all stay plausible.
 *
 * So this exercises the same call four ways against a real Ledger Flex, with
 * one field different each time.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { keccak256, toUtf8Bytes } from "ethers";

import { BridgeTransport } from "./ledger-signer.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(ROOT, ".env") });

const CLA = 0xe0;
const [GET, CREATE, AUTHORIZE_CALL, GET_BODY] = [0x10, 0x11, 0x18, 0x19];
const SLOT = 0;

const SW = {
  0x9000: "AUTHORIZED",
  0xb102: "no_mandate", 0xb103: "expired", 0xb104: "payee_not_allowed",
  0xb105: "over_per_call", 0xb106: "over_budget", 0xb108: "bad_request",
  0xb109: "contract_not_allowed", 0xb10a: "selector_not_allowed",
  0xb10b: "recipient_not_self",
};

/** The router the mandate will allow, and the one it will not. */
const ROUTER = 5_000_001n;
const OTHER_ROUTER = 5_000_002n;

const SELF = BigInt(process.env.HEDERA_BUYER_ID.split(".")[2]);
const ATTACKER = 66_666_666n;

const sel = (sig) => Buffer.from(keccak256(toUtf8Bytes(sig)).slice(2, 10), "hex");
const SWAP = sel("swapExactHBARForTokens(uint256,address)");
const APPROVE = sel("approve(address,uint256)");

/** A Hedera account as a long-zero EVM address, left-padded to an ABI word. */
function addressWord(account) {
  const w = Buffer.alloc(32);
  w.writeBigUInt64BE(account, 24);
  return w;
}

function word(n) {
  const w = Buffer.alloc(32);
  w.writeBigUInt64BE(BigInt(n), 24);
  return w;
}

const t = new BridgeTransport();
await t.open();

async function state() {
  const s = await t.exchange(Buffer.from([CLA, GET, 0, 0, 0]))
    .catch((e) => (e.sw === 0xb102 ? null : Promise.reject(e)));
  if (!s || s.length < 69) return null;
  return {
    available: s.readBigUInt64BE(53),
    seq: s.readUInt32BE(65),
    payees: Array.from({ length: s.readUInt8(69) },
                       (_, i) => s.readBigUInt64BE(70 + i * 8)),
  };
}

async function grant() {
  const payee = BigInt(process.env.HEDERA_TREASURY_ID.split(".")[2]);
  const parts = [
    Buffer.alloc(20, 0xa1),                   // agent id
    Buffer.from([1]),                         // one payee
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(payee); return b; })(),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(50_000_000n); return b; })(),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(10_000_000n); return b; })(),
    Buffer.alloc(4),                          // never expires
    // --- contract terms ---
    Buffer.from([1]),                         // one contract
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(ROUTER); return b; })(),
    Buffer.from([1]),                         // one selector
    SWAP,
    Buffer.from([1]),                         // recipient lives in argument 1
  ];
  const body = Buffer.concat(parts);
  const r = await t.exchange(
    Buffer.concat([Buffer.from([CLA, CREATE, 0, 0, body.length]), body]));
  return r[0];
}

async function call({ contract, calldata, amount = 1_000_000n }) {
  const now = Math.floor(Date.now() / 1000);
  const head = Buffer.alloc(79);
  let o = 0;
  head.writeUInt8(SLOT, o); o += 1;
  for (const v of [7162784n, SELF, contract, 3n, amount, 100_000_000n, 120_000n, BigInt(now)]) {
    head.writeBigUInt64BE(v, o); o += 8;
  }
  head.writeUInt32BE(0, o); o += 4;      // nanos
  head.writeUInt32BE(120, o); o += 4;    // duration
  head.writeUInt32BE(now, o); o += 4;    // now
  head.writeUInt16BE(calldata.length, o);

  const body = Buffer.concat([head, calldata]);
  try {
    const r = await t.exchange(
      Buffer.concat([Buffer.from([CLA, AUTHORIZE_CALL, 0, 0, body.length]), body]));
    const bodyLen = r.readUInt16BE(12);
    const sig = r.subarray(14, 78);

    // The body comes back separately: a call body plus two signatures and the
    // chip's anchor overruns Flex's 272-byte APDU buffer, and the knob for
    // raising it is no longer read by the SDK. Fetching it costs one round
    // trip and nothing else — the signature above is over these bytes, so a
    // body that does not match is a body that will not verify.
    const encoded = await t.exchange(Buffer.from([CLA, GET_BODY, 0, 0, 0]));
    return { sw: 0x9000, seq: r.readUInt32BE(0), bodyLen, sig, body: encoded };
  } catch (e) {
    if (e.sw) return { sw: e.sw };
    throw e;
  }
}

// --------------------------------------------------------------------------

let st = await state();
if (!st) {
  console.log("no mandate in slot 0 — granting one.");
  console.log(`  0.5 HBAR, 0.1 max per call`);
  console.log(`  may call   0.0.${ROUTER}`);
  console.log(`  may invoke swapExactHBARForTokens  (0x${SWAP.toString("hex")})`);
  console.log(`  proceeds   must return to 0.0.${SELF}`);
  console.log("\n  >>> approve it on the device <<<\n");
  const slot = await grant();
  console.log(`  granted in slot ${slot}\n`);
  st = await state();
}

console.log(`envelope  ${Number(st.available) / 1e8} HBAR available, ${st.seq} draws so far\n`);

const cases = [
  ["the agent swaps, proceeds to itself",
   { contract: ROUTER, calldata: Buffer.concat([SWAP, word(1), addressWord(SELF)]) }],
  ["the same swap, proceeds to an attacker",
   { contract: ROUTER, calldata: Buffer.concat([SWAP, word(1), addressWord(ATTACKER)]) }],
  ["approve() on the allowed router",
   { contract: ROUTER, calldata: Buffer.concat([APPROVE, addressWord(ATTACKER), word(1)]) }],
  ["the same swap on a different router",
   { contract: OTHER_ROUTER, calldata: Buffer.concat([SWAP, word(1), addressWord(SELF)]) }],
];

for (const [label, req] of cases) {
  const r = await call(req);
  const name = SW[r.sw] ?? `0x${r.sw.toString(16)}`;
  const extra = r.sw === 0x9000
    ? `  (draw #${r.seq}, ${r.bodyLen}-byte body signed, ${r.body.length} fetched)`
    : "";
  console.log(`  ${label.padEnd(40)} ${name}${extra}`);
}

console.log(`\n  Only one field differed between the first two: the address in`);
console.log(`  argument 1. Same contract, same function, same amount.`);
t.close();
