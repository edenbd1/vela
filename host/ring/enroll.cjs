/**
 * vela ring enroll — bring the Key Ring to a host with no USB port.
 *
 * Built on @ledgerhq/hw-ledger-key-ring-protocol, the protocol layer rather
 * than the Live wrapper. The wrapper (@ledgerhq/ledger-key-ring-protocol)
 * cannot be installed from npm as published: it pulls
 * @ledgerhq/speculos-transport@0.10.6, which depends on
 * @ledgerhq/live-dmk-speculos@0.10.0, which is not on the registry. The
 * protocol package installs cleanly on its own and is where AddMember lives.
 *
 * Two roles:
 *
 *   node enroll.cjs request            run on the host with no device
 *   node enroll.cjs grant <pubkey>     run where the Ledger is
 *
 * The request half generates a member keypair and prints only its public
 * half. The private key is written next to it and never travels — which is
 * the difference between enrolment and copying credentials around.
 */
const { writeFileSync, readFileSync, existsSync, mkdirSync } = require("node:fs");
const { dirname, join } = require("node:path");

// The CommonJS build. lib-es/ uses extensionless relative imports, which
// bundlers accept and native Node ESM does not, so `import` of this package
// fails with ERR_MODULE_NOT_FOUND on a path inside the package itself.
const {
  AddMember,
  Permissions,
  crypto,
} = require("@ledgerhq/hw-ledger-key-ring-protocol");

const HERE = __dirname;
const MEMBER_FILE = join(HERE, ".member.json");

const hex = (u8) => Buffer.from(u8).toString("hex");
const unhex = (s) => Uint8Array.from(Buffer.from(s.replace(/^0x/, ""), "hex"));

/**
 * Run on the host that has no device.
 *
 * Generates this machine's member identity. The private key stays here; only
 * the public half is meant to leave.
 */
async function request(name) {
  if (existsSync(MEMBER_FILE)) {
    const existing = JSON.parse(readFileSync(MEMBER_FILE, "utf8"));
    console.log(`already has an identity: ${existing.name}`);
    console.log(`public key: ${existing.publicKey}`);
    return;
  }

  const kp = await crypto.randomKeypair();
  const pub = hex(kp.publicKey);

  mkdirSync(dirname(MEMBER_FILE), { recursive: true });
  writeFileSync(
    MEMBER_FILE,
    JSON.stringify({ name, publicKey: pub, privateKey: hex(kp.privateKey) }, null, 2),
    { mode: 0o600 },
  );

  console.log(`member identity created for '${name}'`);
  console.log(`private key stays in ${MEMBER_FILE} (0600) and does not travel`);
  console.log();
  console.log("hand this to the machine that holds the Ledger:");
  console.log();
  console.log(`   node enroll.cjs grant ${pub} '${name}'`);
}

/**
 * Run where the Ledger is, by a machine already in the ring.
 *
 * Builds the AddMember command that admits the requesting host. Adding needs
 * no hardware — the protocol signs it with a SoftwareDevice. Removing does,
 * and rotates the ring key, so an ejected host cannot read anything sealed
 * afterwards.
 */
async function grant(pubkeyHex, name) {
  const publicKey = unhex(pubkeyHex);
  if (publicKey.length !== 33) {
    throw new Error(`a member public key is 33 bytes, got ${publicKey.length}`);
  }

  // Read-only membership: the enrolled host may derive the ring's keys and
  // decrypt what was sealed to it. It gets no authority over the ring, and
  // no authority over money — that lives in the Secure Element.
  const permissions = Permissions.KEY_READER;

  const command = new AddMember(name, publicKey, permissions);

  console.log("AddMember command prepared");
  console.log(`  member      ${pubkeyHex}`);
  console.log(`  name        ${name}`);
  console.log(`  permissions 0x${permissions.toString(16)} (key reader)`);
  console.log(`  type        ${command.getType()}`);
  console.log();
  console.log("adding a member needs no device; only removing one does, and");
  console.log("that rotates the ring key so an ejected host reads nothing new.");
  return command;
}

async function main() {
  const [, , verb, ...rest] = process.argv;
  if (verb === "request") {
    await request(rest[0] ?? `${process.env.USER ?? "host"}-agent`);
  } else if (verb === "grant") {
    await grant(rest[0], rest[1] ?? "enrolled-host");
  } else {
    console.log("usage: node enroll.cjs request [name] | grant <pubkey> [name]");
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
