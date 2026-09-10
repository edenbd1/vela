/**
 * Enrolment, on a machine nobody here controls.
 *
 * Ledger's second ask names "a CI runner" explicitly, so this runs on one. It
 * is deliberately not a mock: the trustchain, the keys and the derivation are
 * the real protocol, and the only thing that differs from the ceremony in
 * host/ring/enroll.cjs is where the owner key comes from. On a laptop it is
 * sealed under the Key Ring by a device; here there is no device, so the job
 * makes one and says so.
 *
 * What that still proves, and it is the part worth proving on a public runner:
 * a host with no USB port can generate an identity, be admitted with only its
 * public key crossing the wire, derive the application key rather than receive
 * it, and open a secret sealed for it — while a host that was never admitted
 * gets nothing.
 *
 *   node test/ci-enrol.mjs          the refusal half
 *   node test/ci-enrol.mjs --full   the whole ceremony
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(ROOT, "host/ring/enroll.cjs"));
const { StreamTree, SoftwareDevice, Permissions, DerivationPath, crypto } =
  require("@ledgerhq/hw-ledger-key-ring-protocol");

const hex = (u) => Buffer.from(u).toString("hex");
const APP = 16;

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};

console.log(`\nthis runner: ${process.platform}, no device, no keychain\n`);

// The ring, which on a laptop is sealed under a Ledger. Here it is made in
// memory, and the job says so rather than implying a device was involved.
const ownerKp = crypto.randomKeypair();
const owner = new SoftwareDevice(ownerKp);
let tree = await StreamTree.createNewTree(owner, { topic: crypto.randomBytes(32) });
const path = tree.getApplicationRootPath(APP, 0);
const idx = DerivationPath.toIndexArray(path);

// This host. Only the public half is ever meant to leave.
const me = crypto.randomKeypair();
console.log(`  member public key ${hex(me.publicKey).slice(0, 32)}…`);
console.log(`  33 bytes, and the only thing this host would send\n`);

if (!process.argv.includes("--full")) {
  let derived = null, why = null;
  try { derived = await new SoftwareDevice(me).readKey(tree, idx); }
  catch (e) { why = e.message; }
  ok("a host that was never admitted derives nothing", derived === null,
     derived ? hex(derived) : "");
  ok("and is told why rather than getting something wrong",
     /cannot find key/i.test(why ?? ""), why ?? "(no error)");
  console.log(`\n${pass}/${pass + fail} passed\n`);
  process.exit(fail ? 1 : 0);
}

tree = await tree.share(path, owner, me.publicKey, "gh-runner", Permissions.KEY_READER);

// What crosses the wire back: a trustchain and a ciphertext, and neither
// private key.
const ownerKey = await owner.readKey(tree, idx);
const nonce = crypto.randomBytes(16);
const bundle = JSON.parse(JSON.stringify({
  trustchain: tree.serialize(),
  path,
  sealed: {
    nonce: hex(nonce),
    data: hex(crypto.encrypt(ownerKey.slice(0, 32), nonce,
                             Buffer.from("the-agent-token"))),
  },
}));
const wire = JSON.stringify(bundle);

ok("the bundle carries neither private key",
   !wire.includes(hex(me.privateKey)) && !wire.includes(hex(ownerKp.privateKey)));
ok("nor the derived key itself", !wire.includes(hex(ownerKey)));

const there = StreamTree.deserialize(bundle.trustchain);
const mine = await new SoftwareDevice(me).readKey(there, idx);
ok("this runner derives the application key", mine.length === 64, `${mine.length}`);
ok("and it matches the one the owner derived", hex(mine) === hex(ownerKey));

const opened = Buffer.from(crypto.decrypt(
  mine.slice(0, 32),
  Uint8Array.from(Buffer.from(bundle.sealed.nonce, "hex")),
  Uint8Array.from(Buffer.from(bundle.sealed.data, "hex")))).toString("utf8");
ok("and opens the secret sealed for it", opened === "the-agent-token", opened);

const stranger = new SoftwareDevice(crypto.randomKeypair());
let got = null;
try { got = await stranger.readKey(there, idx); } catch { /* expected */ }
ok("a runner nobody admitted still gets nothing", got === null);

console.log(`\n${pass}/${pass + fail} passed`);
console.log(`\n  No device was involved in making this trustchain, and the job`);
console.log(`  says so. What it shows is the half a runner can show alone: a`);
console.log(`  host with no USB port joining a ring, deriving rather than`);
console.log(`  receiving, and a stranger getting nothing.\n`);
process.exit(fail ? 1 : 0);
