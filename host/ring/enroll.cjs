/**
 * vela ring enroll — bring the Key Ring to a host with no USB port.
 *
 * Ledger's ask, verbatim: *"Bring the Key Ring to hosts with no USB port:
 * enroll a VPS, a CI runner, or a hosted agent."* This is that, end to end.
 *
 * Three commands, on two machines:
 *
 *   node enroll.cjs request <name>        on the host with no device
 *   node enroll.cjs grant <pubkey> <name> where the ring is
 *   node enroll.cjs claim <bundle.json>   back on the host with no device
 *
 * The remote host generates a keypair and sends only the public half. The
 * granting machine admits it to a trustchain and seals the agent's broker
 * token to a key both can derive and nobody else can. The host reads its
 * token out. The private key never travels in either direction — which is
 * the whole difference between enrolment and copying credentials around.
 *
 * What roots this in hardware
 * ---------------------------
 * The trustchain's owner key is not kept in the clear. It is sealed with
 * `wallet-cli ring encrypt --key vela-trustchain`, so granting membership
 * requires the ability to decrypt under the Key Ring — which requires this
 * machine to be a ring member, which required a physical Ledger at
 * `ring init`. You cannot admit a host to the fleet without the device
 * having admitted you first.
 *
 * That is one level of indirection from the device signing each AddMember
 * itself. The library ships an `ApduDevice` that would do exactly that, and
 * it speaks to the **Ledger Sync** app rather than to Vela — a different app
 * on the same device. Wiring it would mean the operator quitting Vela,
 * opening Ledger Sync, and coming back, which is worth doing and is not worth
 * pretending we did. See docs/RING-ENROLL.md.
 *
 * Built on @ledgerhq/hw-ledger-key-ring-protocol, the protocol layer rather
 * than the Live wrapper. The wrapper (@ledgerhq/ledger-key-ring-protocol)
 * cannot be installed from npm as published: it pulls
 * @ledgerhq/speculos-transport@0.10.6, which depends on
 * @ledgerhq/live-dmk-speculos@0.10.0, which is not on the registry. The
 * protocol package installs cleanly on its own.
 */
const { execFileSync } = require("node:child_process");
const { writeFileSync, readFileSync, existsSync, unlinkSync } = require("node:fs");
const { join } = require("node:path");

// The CommonJS build. lib-es/ uses extensionless relative imports, which
// bundlers accept and native Node ESM does not, so `import` of this package
// fails with ERR_MODULE_NOT_FOUND on a path inside the package itself.
const {
  StreamTree,
  SoftwareDevice,
  Permissions,
  DerivationPath,
  crypto,
} = require("@ledgerhq/hw-ledger-key-ring-protocol");

const HERE = __dirname;
const MEMBER_FILE = join(HERE, ".member.json");     // the remote host's identity
const CHAIN_FILE = join(HERE, "trustchain.enc");    // the ring's, sealed
const RING_KEY = process.env.VELA_TRUSTCHAIN_KEY ?? "vela-trustchain";

// 16 is arbitrary and only has to be stable: it is the application index
// under the trustchain root, so every Vela member derives the same key and a
// future application can have its own without colliding.
const APP_INDEX = 16;

const hex = (u8) => Buffer.from(u8).toString("hex");
const unhex = (s) => Uint8Array.from(Buffer.from(s.replace(/^0x/, ""), "hex"));

/* ------------------------------------------------------------ the ring --- */

/**
 * The Key Ring password, from the OS keychain rather than the environment.
 *
 * Same rule as broker/secrets.mjs, and for the same reason: a password passed
 * as an environment variable is in the shell history, in the parent's
 * environment, and in anything that dumps `ps -E`. Here it lives for the
 * length of one call.
 */
function ringPassword() {
  if (process.env.WALLET_PASS) return process.env.WALLET_PASS;
  const service = process.env.VELA_KEYRING_SERVICE ?? "vela-keyring";
  try {
    return execFileSync("security", ["find-generic-password", "-s", service, "-w"],
                        { encoding: "utf8" }).replace(/\n$/, "");
  } catch {
    return "";
  }
}

function ring(args, input) {
  const pass = ringPassword();
  if (!pass) {
    throw new Error(
      "the Key Ring is locked: no WALLET_PASS and no keychain entry. " +
      "Run `wallet-cli ring init` with the device attached — enrolment is " +
      "meant to require that, so this refuses rather than inventing a key.");
  }
  return execFileSync("wallet-cli", ["ring", ...args], {
    input, encoding: "utf8", maxBuffer: 1 << 22,
    env: { ...process.env, WALLET_PASS: pass },
  });
}

/** Read the trustchain, or say there isn't one yet. */
function loadChain() {
  if (!existsSync(CHAIN_FILE)) return null;
  return JSON.parse(ring(["decrypt", "--key", RING_KEY, "-i", CHAIN_FILE]));
}

function saveChain(state) {
  ring(["encrypt", "--key", RING_KEY, "-o", CHAIN_FILE], JSON.stringify(state));
}

/** The owner device, rebuilt from the sealed private key. */
function ownerOf(state) {
  return new SoftwareDevice(crypto.keypairFromSecretKey(unhex(state.ownerKey)));
}

/* ----------------------------------------------------------- the host ---- */

/**
 * Run on the host that has no device.
 *
 * Generates this machine's member identity. The private key stays here; only
 * the public half is meant to leave.
 */
function request(name) {
  if (existsSync(MEMBER_FILE)) {
    const existing = JSON.parse(readFileSync(MEMBER_FILE, "utf8"));
    console.log(`already has an identity: ${existing.name}`);
    console.log(`public key: ${existing.publicKey}`);
    console.log();
    console.log("hand this to the machine that holds the Ledger:");
    console.log();
    console.log(`   node host/ring/enroll.cjs grant ${existing.publicKey} '${existing.name}'`);
    return;
  }

  const kp = crypto.randomKeypair();
  const pub = hex(kp.publicKey);

  writeFileSync(MEMBER_FILE,
    JSON.stringify({ name, publicKey: pub, privateKey: hex(kp.privateKey) }, null, 2),
    { mode: 0o600 });

  console.log(`member identity created for '${name}'`);
  console.log(`  private key stays in ${MEMBER_FILE} (0600) and does not travel`);
  console.log(`  public key  ${pub}`);
  console.log();
  console.log("hand this to the machine that holds the Ledger:");
  console.log();
  console.log(`   node host/ring/enroll.cjs grant ${pub} '${name}'`);
}

/* ---------------------------------------------------------- the ring ----- */

/**
 * Run where the ring is, by a machine the device already admitted.
 *
 * Creates the trustchain on first use and admits the requesting host to it.
 * The member is a KEY_READER: it may derive the application key and read what
 * was sealed to it, and it has no authority over the ring and none over money.
 * Money lives in the Secure Element and is not something ring membership can
 * reach at all.
 *
 * Whatever `--seal` is given — in practice the agent's broker token — is
 * encrypted to that key. Today that token is handed to a container as
 * `-e AGENT_TOKEN=…`, in the clear, in an environment anything on the host
 * can read. After this it arrives sealed to a key the host derives from its
 * own membership.
 */
async function grant(pubkeyHex, name, seal) {
  const publicKey = unhex(String(pubkeyHex ?? ""));
  if (publicKey.length !== 33) {
    throw new Error(`a member public key is 33 bytes, got ${publicKey.length}`);
  }

  let state = loadChain();
  let tree;

  if (!state) {
    const kp = crypto.randomKeypair();
    state = { ownerKey: hex(kp.privateKey), members: {} };
    const owner = new SoftwareDevice(kp);
    tree = await StreamTree.createNewTree(owner, { topic: crypto.randomBytes(32) });
    state.path = tree.getApplicationRootPath(APP_INDEX);
    console.log(`new trustchain, sealed under the Key Ring as '${RING_KEY}'`);
  } else {
    tree = StreamTree.deserialize(state.tree);
  }

  const owner = ownerOf(state);
  tree = await tree.share(state.path, owner, publicKey, name, Permissions.KEY_READER);

  state.tree = tree.serialize();
  state.members[name] = { publicKey: hex(publicKey), at: new Date().toISOString() };
  saveChain(state);

  const bundle = {
    trustchain: state.tree,
    path: state.path,
    member: name,
  };

  if (seal) {
    const key = await owner.readKey(tree, DerivationPath.toIndexArray(state.path));
    const nonce = crypto.randomBytes(16);
    bundle.sealed = {
      nonce: hex(nonce),
      data: hex(crypto.encrypt(key.slice(0, 32), nonce, Buffer.from(seal, "utf8"))),
    };
  }

  const out = join(HERE, `bundle-${name}.json`);
  writeFileSync(out, JSON.stringify(bundle, null, 2));

  console.log(`'${name}' admitted as a key reader`);
  console.log(`  member      ${hex(publicKey).slice(0, 24)}…`);
  console.log(`  path        ${state.path}`);
  console.log(`  in the ring ${Object.keys(state.members).join(", ")}`);
  console.log();
  console.log(`bundle written to ${out}`);
  console.log(seal
    ? "  it carries the trustchain and one sealed secret. Neither the ring's\n" +
      "  private key nor the member's is in it — send it over anything."
    : "  it carries the trustchain and no secret. Pass --seal <value> to put\n" +
      "  one in, sealed to a key only members can derive.");
  console.log();
  console.log(`on the other host:   node host/ring/enroll.cjs claim ${out}`);
}

/* ------------------------------------------------------ back on the host -- */

/**
 * Run on the host that has no device, once the bundle arrives.
 *
 * Derives the application key from membership and opens what was sealed to
 * it. Nothing here contacts the granting machine, and nothing here has ever
 * held the ring's private key: the derivation works because this host is a
 * member of the trustchain, and it stops working the moment it is not.
 */
async function claim(bundlePath, quiet) {
  if (!existsSync(MEMBER_FILE)) {
    throw new Error("no member identity here — run `enroll.cjs request <name>` first");
  }
  if (!bundlePath || !existsSync(bundlePath)) {
    throw new Error(`no bundle at ${bundlePath ?? "(none given)"}`);
  }

  const me = JSON.parse(readFileSync(MEMBER_FILE, "utf8"));
  const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));

  const device = new SoftwareDevice(crypto.keypairFromSecretKey(unhex(me.privateKey)));
  const tree = StreamTree.deserialize(bundle.trustchain);

  let key;
  try {
    key = await device.readKey(tree, DerivationPath.toIndexArray(bundle.path));
  } catch (e) {
    throw new Error(
      `this host cannot derive the key: ${e.message}\n` +
      `It is either not a member of this trustchain, or it was removed.`);
  }

  if (!quiet) {
    console.log(`'${me.name}' is a member of this trustchain`);
    console.log(`  path        ${bundle.path}`);
    console.log(`  key         ${hex(key).slice(0, 24)}…  derived, not received`);
  }

  if (!bundle.sealed) {
    if (!quiet) console.log("\nnothing was sealed into this bundle.");
    else process.exit(1);
    return;
  }

  const value = Buffer.from(crypto.decrypt(
    key.slice(0, 32), unhex(bundle.sealed.nonce), unhex(bundle.sealed.data))).toString("utf8");

  // --quiet writes the secret and nothing else, so a caller can do
  // AGENT_TOKEN=$(… claim … --quiet). Everything explanatory goes to stdout
  // in the normal mode and would corrupt that.
  if (quiet) { process.stdout.write(value); return; }

  console.log();
  console.log("the sealed secret opens:");
  console.log();
  console.log(`   ${value}`);
  console.log();
  console.log("It was never on the wire in the clear, and this host's private");
  console.log("key never left it. Remove the member and the key rotates.");
}

/* --------------------------------------------------------------- rest ---- */

function members() {
  const state = loadChain();
  if (!state) return console.log("no trustchain yet — grant someone first");
  console.log(`trustchain sealed under the Key Ring as '${RING_KEY}'`);
  console.log(`path ${state.path}`);
  console.log();
  for (const [name, m] of Object.entries(state.members)) {
    console.log(`  ${name.padEnd(16)} ${m.publicKey.slice(0, 24)}…  ${m.at.slice(0, 10)}`);
  }
  if (!Object.keys(state.members).length) console.log("  (nobody)");
}

/**
 * Forget this machine's identity.
 *
 * Not a revocation: revoking a member is the ring owner's act and rotates the
 * application key, which this tool does not yet do — see docs/RING-ENROLL.md.
 * This is the honest smaller thing, so that `forget` cannot be mistaken for
 * ejecting someone.
 */
function forget() {
  if (!existsSync(MEMBER_FILE)) return console.log("no identity here to forget");
  unlinkSync(MEMBER_FILE);
  console.log("member identity deleted. Anything sealed to it is now unreadable here.");
  console.log("Note: this does not eject the member from the ring — that is the");
  console.log("owner's act, and it rotates the key. See docs/RING-ENROLL.md.");
}

async function main() {
  const [, , verb, ...rest] = process.argv;
  // With no --seal, indexOf gives -1 and `i !== sealIdx + 1` becomes
  // `i !== 0`, which silently eats the first positional argument. Found by
  // `request vps-frankfurt` creating an identity called eden-agent.
  const sealIdx = rest.indexOf("--seal");
  const seal = sealIdx === -1 ? null : rest[sealIdx + 1];
  const args = sealIdx === -1
    ? rest
    : rest.filter((_, i) => i !== sealIdx && i !== sealIdx + 1);

  switch (verb) {
    case "request": return request(args[0] ?? `${process.env.USER ?? "host"}-agent`);
    case "grant":   return grant(args[0], args[1] ?? "enrolled-host", seal);
    case "claim":   return claim(args[0], rest.includes("--quiet"));
    case "members": return members();
    case "forget":  return forget();
    default:
      console.log("usage:");
      console.log("  enroll.cjs request <name>                  on the host with no device");
      console.log("  enroll.cjs grant <pubkey> <name> [--seal V] where the ring is");
      console.log("  enroll.cjs claim <bundle.json> [--quiet]   back on the host");
      console.log("  enroll.cjs members                         who is in");
      console.log("  enroll.cjs forget                          drop this host's identity");
      process.exit(2);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
