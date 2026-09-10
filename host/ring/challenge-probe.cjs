/**
 * Where a device-rooted Key Ring actually stops, in two APDUs.
 *
 * `@ledgerhq/hw-ledger-key-ring-protocol` ships `SoftwareDevice` and
 * `ApduDevice` side by side as implementations of the same `Device`
 * interface. They are not interchangeable, and nothing in the package says
 * so. This walks the two gates that separate them, on a real Flex, and prints
 * the status word each one answers with.
 *
 * Run it with the **Ledger Sync** app open — the trustchain instructions live
 * there, not in Vela — and the bridge guarding that app:
 *
 *     pkill -f host/bridge.py
 *     VELA_BRIDGE_APP="Ledger Sync" python3 host/bridge.py &
 *     node host/ring/challenge-probe.cjs
 *
 * Nothing is written. Both calls are reads that fail; the point is *how*.
 */
const { createHash, randomBytes } = require("node:crypto");
const { join } = require("node:path");

const HERE = __dirname;
const PKG = "@ledgerhq/hw-ledger-key-ring-protocol";
const { APDU } = require(join(HERE, "node_modules", PKG, "lib/ApduDevice"));
const { Challenge, PubKeyCredential } =
  require(join(HERE, "node_modules", PKG, "lib/SeedId"));
const { secp256k1 } = require(join(HERE, "node_modules/@noble/curves/secp256k1"));
const { BridgeTransport } = require("./bridge-transport.cjs");

const swOf = (e) =>
  e?.statusCode ?? Number((String(e?.message).match(/0x([0-9a-f]{4})/i) ?? [])[1] ?? NaN);

// From the app's own src/sw.h, so a reader does not have to look them up.
const NAMES = {
  0xb00d: "SW_PARSER_INVALID_FORMAT",
  0xb00e: "SW_PARSER_INVALID_VALUE",
  0xb00f: "SW_CHALLENGE_NOT_VERIFIED",
  0x6d00: "INS not supported — wrong app",
  0x6a87: "wrong length",
};

// src/challenge_parser.h. Every one of these is checked by value, in order,
// before the signature is looked at — which is why getting one wrong answers
// SW_PARSER_INVALID_VALUE and tells you nothing about the real gate.
const TYPE_SEED_ID_AUTHENTIFICATION_CHALLENGE = 0x07;
const SEED_ID_VERSION = 0x00;
const ECDSA_SHA256 = 0x01;
const CX_CURVE_256K1 = 0x21;
const CHALLENGE_DATA_LENGTH = 16;

const show = (label, sw) => {
  const hex = Number.isNaN(sw) ? "??" : `0x${sw.toString(16).padStart(4, "0")}`;
  console.log(`  ${label.padEnd(42)} ${hex}  ${NAMES[sw] ?? ""}`);
};

async function main() {
  const t = new BridgeTransport(60_000);

  console.log();
  console.log("two gates between SoftwareDevice and ApduDevice");
  console.log();

  // Gate 1. What every caller tries first, because it is the only way to
  // learn the device's trustchain key. It sends `e0 05 00 00 00` — an empty
  // payload — and INS 0x05 in Ledger Sync is the *challenge* instruction, so
  // the app's TLV parser rejects an empty body. The failure points at the
  // library/app contract, not at anything the caller did.
  try {
    await APDU.getPublicKey(t);
    show("APDU.getPublicKey — empty payload", 0x9000);
  } catch (e) {
    show("APDU.getPublicKey — empty payload", swOf(e));
  }

  // Gate 2. The same instruction with a challenge that parses: every field
  // the library's own `Challenge.fromBytes` requires, in the order its
  // `toBytes` writes them, signed over `getUnsignedTLV()`. The signature is
  // ours, which is the whole point — the device holds Ledger's attestation
  // keys in `src/crypto_data.h` and trusts nothing else.
  const kp = secp256k1.utils.randomPrivateKey();
  const pub = secp256k1.getPublicKey(kp, true);

  const challenge = new Challenge({
    payloadType: TYPE_SEED_ID_AUTHENTIFICATION_CHALLENGE,
    version: SEED_ID_VERSION,
    protocolVersion: { major: 1, minor: 0, patch: 0 },
    challengeData: new Uint8Array(randomBytes(CHALLENGE_DATA_LENGTH)),
    challengeExpiry: new Date(Date.now() + 3600_000),
    host: "trustchain-backend.api.aws.stg.ldg-tech.com",
    rpCredential: new PubKeyCredential({
      version: 0x00, curveId: CX_CURVE_256K1,
      signAlgorithm: ECDSA_SHA256, publicKey: pub,
    }),
    rpSignature: new Uint8Array(0),
  });

  const digest = createHash("sha256").update(challenge.getUnsignedTLV()).digest();
  challenge.rpSignature = secp256k1.sign(digest, kp).toDERRawBytes();

  try {
    await APDU.getSeedId(t, Buffer.from(challenge.toBytes()));
    show("APDU.getSeedId — well-formed, self-signed", 0x9000);
  } catch (e) {
    show("APDU.getSeedId — well-formed, self-signed", swOf(e));
  }

  console.log();
  console.log("  The first is a library/app mismatch. The second is the answer:");
  console.log("  the parser accepted the structure and the device refused the");
  console.log("  signature, because a trustchain rooted in the Secure Element");
  console.log("  needs a challenge issued by Ledger's hosted backend. That is a");
  console.log("  design decision. What is missing is anyone writing it down.");
  console.log();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
