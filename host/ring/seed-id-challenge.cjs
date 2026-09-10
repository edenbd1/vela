/**
 * A challenge the Ledger Sync app will accept, built here.
 *
 * The app verifies a challenge in two ways and the difference is the whole
 * story. With a SEED_ID certificate loaded — `HAVE_LEDGER_PKI`, and
 * `os_pki_get_info` returning one — it binds the challenge's trusted name and
 * public key to that certificate, and only Ledger's backend can issue it.
 * With no certificate loaded it takes what the app's own source calls the
 * "legacy path" (`src/challenge_sign.c`) and verifies the signature against
 * the public key carried *in the challenge itself*.
 *
 * So on a device with no certificate loaded, a self-signed challenge is
 * valid, the device shows a screen, and it answers with its SeedID public key
 * — the trustchain root derived from the seed. No backend involved.
 *
 * Every constant below is checked by value, in order, by
 * `src/challenge_parser.c` before the signature is looked at. Get one wrong
 * and the device answers SW_PARSER_INVALID_VALUE (0xB00E), which says nothing
 * about the signature and sends you looking in the wrong place.
 */
const { createHash, randomBytes } = require("node:crypto");
const { join } = require("node:path");

const PKG = join(__dirname, "node_modules", "@ledgerhq/hw-ledger-key-ring-protocol");
const { Challenge, PubKeyCredential } = require(join(PKG, "lib/SeedId"));
const { secp256k1 } = require(join(__dirname, "node_modules/@noble/curves/secp256k1"));

// src/challenge_parser.h
const TYPE_SEED_ID_AUTHENTIFICATION_CHALLENGE = 0x07;
const SEED_ID_VERSION = 0x00;
const ECDSA_SHA256 = 0x01;
const CX_CURVE_256K1 = 0x21;
const CHALLENGE_DATA_LENGTH = 16;

/** A well-formed, self-signed challenge. Returns the bytes to send. */
function selfSignedChallenge(host = "vela.local") {
  const priv = secp256k1.utils.randomPrivateKey();
  const pub = secp256k1.getPublicKey(priv, true);

  const challenge = new Challenge({
    payloadType: TYPE_SEED_ID_AUTHENTIFICATION_CHALLENGE,
    version: SEED_ID_VERSION,
    protocolVersion: { major: 1, minor: 0, patch: 0 },
    challengeData: new Uint8Array(randomBytes(CHALLENGE_DATA_LENGTH)),
    challengeExpiry: new Date(Date.now() + 3600_000),
    host,
    rpCredential: new PubKeyCredential({
      version: 0x00, curveId: CX_CURVE_256K1,
      signAlgorithm: ECDSA_SHA256, publicKey: pub,
    }),
    rpSignature: new Uint8Array(0),
  });

  // The app hashes exactly the fields getUnsignedTLV writes, in that order —
  // structure type, version, challenge, valid-until, trusted name, protocol
  // version. Signer algo, signature, curve and public key are read but not
  // hashed, which is why the signature can cover the rest of its own record.
  const digest = createHash("sha256").update(challenge.getUnsignedTLV()).digest();
  challenge.rpSignature = secp256k1.sign(digest, priv).toDERRawBytes();

  return Buffer.from(challenge.toBytes());
}

module.exports = { selfSignedChallenge };
