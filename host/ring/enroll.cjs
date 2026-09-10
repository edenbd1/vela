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
// Not re-exported from the package root, despite being the only way to make
// the device itself the trustchain owner.
const { createApduDevice } =
  require("@ledgerhq/hw-ledger-key-ring-protocol/lib/ApduDevice");
const { BridgeTransport } = require("./bridge-transport.cjs");
const { selfSignedChallenge } = require("./seed-id-challenge.cjs");

const HERE = __dirname;
const MEMBER_FILE = join(HERE, ".member.json");     // the remote host's identity
const CHAIN_FILE = join(HERE, "trustchain.enc");        // software-owned, sealed
const CHAIN_FILE_DEVICE = join(HERE, "trustchain.device.json");  // device-owned
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
function loadChain(file = CHAIN_FILE) {
  if (!existsSync(file)) return null;
  // A device-owned chain holds no private key, so there is nothing to seal
  // and nothing the Key Ring needs to unlock. Sealing it would only mean the
  // device could not admit anyone without the ring, which is the dependency
  // --device exists to remove.
  if (file === CHAIN_FILE_DEVICE) return JSON.parse(readFileSync(file, "utf8"));
  return JSON.parse(ring(["decrypt", "--key", RING_KEY, "-i", file]));
}

function saveChain(state, file = CHAIN_FILE) {
  if (file === CHAIN_FILE_DEVICE) {
    writeFileSync(file, JSON.stringify(state, null, 1));
    return;
  }
  ring(["encrypt", "--key", RING_KEY, "-o", file], JSON.stringify(state));
}

/**
 * Who admits a member.
 *
 * Two answers, and the difference is the whole of Ledger's second ask.
 *
 * By default the owner is a software key sealed under the Key Ring, so
 * admitting a host requires being able to decrypt under the ring — which
 * required a physical Ledger at `ring init`. That is real, and it is one
 * level of indirection from the device.
 *
 * With `--device`, the owner is the Secure Element itself: every AddMember
 * block is signed on the chip, with a person approving it. Nobody admits a
 * host to the fleet without a finger on a screen.
 *
 * It speaks to the **Ledger Sync** app rather than to Vela, because that is
 * where the trustchain instruction set lives. Different app, same device,
 * and the operator has to switch — which is a real cost and the reason this
 * is a flag rather than the default.
 */
function ownerOf(state) {
  return new SoftwareDevice(crypto.keypairFromSecretKey(unhex(state.ownerKey)));
}

async function deviceOwner() {
  const t = new BridgeTransport(300_000);
  const device = createApduDevice(t);

  // Not device.getPublicKey(). That calls APDU.getPublicKey, which sends
  // `e0 05 00 00 00` — an empty payload — and INS 0x05 in Ledger Sync is the
  // *challenge* instruction, so the app's TLV parser answers 0xB00D
  // SW_PARSER_INVALID_FORMAT. It is the first call anyone makes on an
  // ApduDevice and it fails in a way that points at the wrong thing.
  //
  // The seed-id route is the one the app implements: hand it a well-formed
  // challenge and it answers with the trustchain public key derived from the
  // seed, after showing a screen. See seed-id-challenge.cjs for why a
  // challenge we signed ourselves is accepted.
  console.log(">>> approve the SeedID screen on the device <<<");
  let seed;
  try {
    seed = await device.getSeedId(selfSignedChallenge());
  } catch (e) {
    const sw = e?.statusCode;
    if (sw === 0x6a87 || /6a87|6d00/i.test(String(e.message))) {
      throw new Error(
        "the device answered, but not to a trustchain instruction.\n" +
        "  Those live in the Ledger Sync app, not in Vela. Open Ledger Sync\n" +
        "  on the Flex and run this again.");
    }
    if (sw === 0xb00f) {
      throw new Error(
        "the device refused the challenge (SW_CHALLENGE_NOT_VERIFIED).\n" +
        "  It has a SEED_ID certificate loaded, so it will only accept a\n" +
        "  challenge signed by Ledger's trustchain backend.");
    }
    throw e;
  }
  console.log(`device key   ${hex(seed.pubkeyCredential.publicKey).slice(0, 32)}…`);
  return device;
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
async function grant(pubkeyHex, name, seal, onDevice = false) {
  const publicKey = unhex(String(pubkeyHex ?? ""));
  if (publicKey.length !== 33) {
    throw new Error(`a member public key is 33 bytes, got ${publicKey.length}`);
  }

  // A device-owned trustchain and a software-owned one are different chains
  // with different roots, so they are kept in different files. Mixing them
  // would mean a member admitted by a tap and a member admitted by a
  // decryptable key sitting in one list, indistinguishable.
  const file = onDevice ? CHAIN_FILE_DEVICE : CHAIN_FILE;
  let state = loadChain(file);
  let tree;
  let owner;

  if (onDevice) {
    owner = await deviceOwner();
    if (!state) {
      console.log(">>> approve the new trustchain on the device <<<");
      tree = await StreamTree.createNewTree(owner, { topic: crypto.randomBytes(32) });
      state = { members: {}, increment: 0, device: true };
      state.path = tree.getApplicationRootPath(APP_INDEX, 0);
      console.log("new trustchain, rooted in the Secure Element");
    } else {
      tree = StreamTree.deserialize(state.tree);
    }
  } else if (!state) {
    const kp = crypto.randomKeypair();
    state = { ownerKey: hex(kp.privateKey), members: {}, increment: 0 };
    owner = new SoftwareDevice(kp);
    tree = await StreamTree.createNewTree(owner, { topic: crypto.randomBytes(32) });
    state.path = tree.getApplicationRootPath(APP_INDEX, 0);
    console.log(`new trustchain, sealed under the Key Ring as '${RING_KEY}'`);
  } else {
    tree = StreamTree.deserialize(state.tree);
    owner = ownerOf(state);
  }

  // Least privilege, except where the device will not sign it.
  //
  // src/block/signer.c, signer_inject_add_member: the app displays and signs
  // an AddMember only when the permissions are OWNER, or OWNER without
  // CAN_ADD_BLOCK. Anything else — KEY_READER included — returns SW_WRONG_DATA
  // from the injector, which handler_sign_block turns into 0xB007
  // SW_BAD_STATE. That status word says nothing about permissions, and the
  // library offers Permissions.KEY_READER with no hint the device refuses it.
  //
  // So the two paths differ, and the difference is worth stating rather than
  // hiding: a member admitted by a tap is an owner of the trustchain. A member
  // admitted by the software owner is a key reader and nothing else.
  const permissions = onDevice ? Permissions.OWNER : Permissions.KEY_READER;
  if (onDevice) {
    console.log(`>>> approve admitting '${name}' on the device <<<`);
    console.log("    the device signs owners only — this member will be an owner");
  }
  tree = await tree.share(state.path, owner, publicKey, name, permissions);

  state.tree = tree.serialize();
  state.members[name] = {
    publicKey: hex(publicKey), at: new Date().toISOString(),
    permissions: onDevice ? "owner" : "key_reader",
    ...(onDevice ? { admitted_on_device: true } : {}),
  };
  saveChain(state, file);

  const bundle = {
    trustchain: state.tree,
    path: state.path,
    member: name,
  };

  if (seal && onDevice) {
    throw new Error(
      "--seal cannot be combined with --device.\n" +
      "  Sealing needs the group key in this process, and ApduDevice.readKey\n" +
      "  throws 'readKey is not supported on hardware devices' by design — the\n" +
      "  chip does not hand out the key it protects. The bundle below carries\n" +
      "  the trustchain; the member derives the key itself from its membership.");
  }
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

  console.log(`'${name}' admitted as ${onDevice ? "an owner" : "a key reader"}`);
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

function members(onDevice = false) {
  const state = loadChain(onDevice ? CHAIN_FILE_DEVICE : CHAIN_FILE);
  if (!state) {
    return console.log(onDevice
      ? "no device-rooted trustchain yet — grant someone with --device"
      : "no trustchain yet — grant someone first");
  }
  console.log(onDevice
    ? "trustchain rooted in the Secure Element — every admission was a tap"
    : `trustchain sealed under the Key Ring as '${RING_KEY}'`);
  console.log(`path ${state.path}${state.increment ? `   (rotated ${state.increment}×)` : ""}`);
  console.log();
  for (const [name, m] of Object.entries(state.members)) {
    console.log(`  ${name.padEnd(16)} ${m.publicKey.slice(0, 24)}…  ${m.at.slice(0, 10)}` +
                `  ${m.permissions ?? (m.admitted_on_device ? "owner" : "key_reader")}`);
  }
  if (!Object.keys(state.members).length) console.log("  (nobody)");
}

/**
 * Eject a member, and rotate the key so it stays ejected.
 *
 * This is the half that makes enrolment worth having. Adding a member needs
 * no device — it is cheap, do it for every runner you spin up. Removing one
 * closes the current application stream and opens the next branch of the
 * derivation tree, re-sharing it to everyone who remains. The ejected host
 * derives nothing on the new path, however many bytes of the old bundle it
 * kept.
 *
 * Rotation is forward-only, and pretending otherwise would be the dishonest
 * version of this feature. A host that was a member yesterday can still open
 * what was sealed to it yesterday, because it could already read that and no
 * later act can reach into a copy it already has. What eviction buys is
 * everything from now on. Anything long-lived has to be re-sealed on the new
 * path — `grant <pubkey> <name> --seal <value>` does that for a member who
 * is staying.
 */
async function revoke(name) {
  const state = loadChain();
  if (!state) throw new Error("no trustchain yet — nobody to eject");
  if (!state.members[name]) {
    throw new Error(
      `'${name}' is not a member. In the ring: ` +
      `${Object.keys(state.members).join(", ") || "(nobody)"}`);
  }

  const remaining = Object.entries(state.members).filter(([n]) => n !== name);
  const owner = ownerOf(state);
  let tree = StreamTree.deserialize(state.tree);

  const oldPath = state.path;
  tree = await tree.close(oldPath, owner);

  const increment = (state.increment ?? 0) + 1;
  const path = tree.getApplicationRootPath(APP_INDEX, increment);

  for (const [n, m] of remaining) {
    tree = await tree.share(path, owner, unhex(m.publicKey), n, Permissions.KEY_READER);
  }

  state.tree = tree.serialize();
  state.path = path;
  state.increment = increment;
  delete state.members[name];
  saveChain(state);

  // Fresh bundles for whoever is left. Without a secret: re-sealing one is a
  // deliberate act, and quietly re-issuing a token during an eviction is the
  // sort of thing that should have to be typed.
  const out = [];
  for (const [n] of remaining) {
    const file = join(HERE, `bundle-${n}.json`);
    writeFileSync(file, JSON.stringify({ trustchain: state.tree, path, member: n }, null, 2));
    out.push(file);
  }

  console.log(`'${name}' ejected`);
  console.log(`  was         ${oldPath}`);
  console.log(`  now         ${path}   (the key rotated)`);
  console.log(`  remaining   ${remaining.map(([n]) => n).join(", ") || "(nobody)"}`);
  console.log();
  if (out.length) {
    console.log("new bundles, without secrets in them:");
    for (const f of out) console.log(`  ${f}`);
    console.log();
    console.log("re-seal anything they still need:");
    console.log(`  node host/ring/enroll.cjs grant <pubkey> <name> --seal <value>`);
  }
  console.log();
  console.log(`'${name}' derives nothing on ${path}, whatever it kept.`);
  console.log(`It can still open what was sealed to it before now — rotation`);
  console.log(`is forward-only, and no later act reaches into a copy someone`);
  console.log(`already has.`);
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
  console.log("Note: this does not eject the member from the ring. That is the");
  console.log("owner's act, on the machine that holds it:");
  console.log("  node host/ring/enroll.cjs revoke <name>");
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
    case "grant":   return grant(args[0], args[1] ?? "enrolled-host", seal,
                                 rest.includes("--device"));
    case "claim":   return claim(args[0], rest.includes("--quiet"));
    case "revoke":  return revoke(args[0]);
    case "members": return members(rest.includes("--device"));
    case "forget":  return forget();
    default:
      console.log("usage:");
      console.log("  enroll.cjs request <name>                  on the host with no device");
      console.log("  enroll.cjs grant <pubkey> <name> [--seal V] [--device]");
  console.log("       --device signs each admission on the Flex (needs Ledger Sync)");
      console.log("  enroll.cjs claim <bundle.json> [--quiet]   back on the host");
      console.log("  enroll.cjs revoke <name>                   eject, and rotate the key");
  console.log("  enroll.cjs members [--device]              who is in");
      console.log("  enroll.cjs forget                          drop this host's identity");
      process.exit(2);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
