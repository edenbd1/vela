/**
 * What enrolment must be true of, asserted rather than demonstrated.
 *
 * The claim being made is specific: a host with no USB port can be admitted
 * to the Key Ring, read a secret sealed for it, and be unable to read one
 * that was not — while its private key never travels and the ring's never
 * leaves the machine that holds it. Every one of those is checkable without a
 * device, because the trustchain arithmetic is the same whether the owner key
 * came out of the Key Ring or out of this file.
 *
 * The device's part — that you cannot become the owner without having been
 * admitted to the ring first — is not testable here and is not claimed here.
 * It is `wallet-cli ring decrypt` failing, and it is exercised by running
 * host/ring/enroll.cjs for real.
 *
 *   node test/ring.test.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(ROOT, "host/ring/enroll.cjs"));

let kr;
try {
  kr = require("@ledgerhq/hw-ledger-key-ring-protocol");
} catch {
  console.log("\n  @ledgerhq/hw-ledger-key-ring-protocol is not installed —");
  console.log("  run `npm i` in host/ring/. Skipping.\n");
  process.exit(0);
}
const { StreamTree, SoftwareDevice, Permissions, DerivationPath, crypto } = kr;

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};
const hex = (u) => Buffer.from(u).toString("hex");

console.log("\nbringing the Key Ring to a host with no USB port\n");

const APP = 16;

/** The machine that holds the ring. */
const ownerKp = crypto.randomKeypair();
const owner = new SoftwareDevice(ownerKp);
let tree = await StreamTree.createNewTree(owner, { topic: crypto.randomBytes(32) });
const path = tree.getApplicationRootPath(APP);
const idx = DerivationPath.toIndexArray(path);

/** The host with no device. It generates its identity and sends 33 bytes. */
const memberKp = crypto.randomKeypair();
ok("a member public key is 33 bytes", memberKp.publicKey.length === 33,
   `${memberKp.publicKey.length}`);

tree = await tree.share(path, owner, memberKp.publicKey, "vps-1", Permissions.KEY_READER);

// The bundle: everything that travels, and nothing else.
const bundle = JSON.parse(JSON.stringify({ trustchain: tree.serialize(), path }));
const wire = JSON.stringify(bundle);

ok("the bundle does not carry the member's private key",
   !wire.includes(hex(memberKp.privateKey)));
ok("the bundle does not carry the ring owner's private key",
   !wire.includes(hex(ownerKp.privateKey)));

/* --------------------------------------------------------------------- */
{
  // The whole point: the remote host *derives* the key rather than receiving
  // it. Nothing in the bundle is the key.
  const there = StreamTree.deserialize(bundle.trustchain);
  const member = new SoftwareDevice(memberKp);
  const memberKey = await member.readKey(there, idx);
  const ownerKey = await owner.readKey(there, idx);

  ok("a member derives the application key", memberKey.length === 64,
     `${memberKey.length} bytes`);
  ok("and it is the same key the owner derives", hex(memberKey) === hex(ownerKey));
  ok("the key itself is not in the bundle", !wire.includes(hex(memberKey)));

  // A secret sealed on one machine, opened on the other.
  const nonce = crypto.randomBytes(16);
  const sealed = crypto.encrypt(ownerKey.slice(0, 32), nonce, Buffer.from("the-agent-token"));
  ok("the sealed secret is not the plaintext",
     !Buffer.from(sealed).toString("utf8").includes("the-agent-token"));

  const opened = Buffer.from(
    crypto.decrypt(memberKey.slice(0, 32), nonce, sealed)).toString("utf8");
  ok("the member opens what was sealed for it", opened === "the-agent-token", opened);
}

/* --------------------------------------------------------------------- */
{
  // Somebody who was never admitted. This is the property that makes the
  // bundle safe to send over anything at all.
  const stranger = new SoftwareDevice(crypto.randomKeypair());
  const there = StreamTree.deserialize(bundle.trustchain);
  let derived = null, err = null;
  try { derived = await stranger.readKey(there, idx); }
  catch (e) { err = e.message; }
  ok("a host that was never admitted cannot derive the key",
     derived === null, derived ? hex(derived) : "");
  ok("and is told why rather than getting something wrong",
     /cannot find key/i.test(err ?? ""), err ?? "(no error)");
}

/* --------------------------------------------------------------------- */
{
  // Two members, one ring. Both read the same application key — that is what
  // makes it a fleet rather than a set of pairwise channels.
  const secondKp = crypto.randomKeypair();
  const t2 = await tree.share(path, owner, secondKp.publicKey, "ci-runner",
                              Permissions.KEY_READER);
  const there = StreamTree.deserialize(JSON.parse(JSON.stringify(t2.serialize())));
  const a = await new SoftwareDevice(memberKp).readKey(there, idx);
  const b = await new SoftwareDevice(secondKp).readKey(there, idx);
  ok("a second host can be admitted to the same ring", hex(a) === hex(b));
}

/* --------------------------------------------------------------------- */
{
  // A different application index is a different key. This is what keeps a
  // host enrolled for one thing from reading another — the same scoping
  // `wallet-cli ring encrypt --key <name>` gives, one level down.
  const otherPath = tree.getApplicationRootPath(APP + 1);
  ok("a different application path is a different derivation",
     otherPath !== path, `${otherPath} vs ${path}`);
}

/* --------------------------------------------------------------------- */
{
  // Eviction, which is the half that makes enrolment worth having. Adding a
  // member is cheap; removing one has to actually remove them, or the whole
  // asymmetry is decoration.
  const kept = crypto.randomKeypair();
  const evicted = crypto.randomKeypair();

  const oKp = crypto.randomKeypair();
  const o = new SoftwareDevice(oKp);
  let t = await StreamTree.createNewTree(o, { topic: crypto.randomBytes(32) });
  const p0 = t.getApplicationRootPath(APP, 0);
  t = await t.share(p0, o, kept.publicKey, "keeps", Permissions.KEY_READER);
  t = await t.share(p0, o, evicted.publicKey, "goes", Permissions.KEY_READER);

  const i0 = DerivationPath.toIndexArray(p0);
  const before = await new SoftwareDevice(evicted).readKey(t, i0);
  ok("before eviction, both members read the same key",
     hex(before) === hex(await new SoftwareDevice(kept).readKey(t, i0)));

  // Close the current application stream and open the next branch, re-shared
  // to whoever remains.
  t = await t.close(p0, o);
  const p1 = t.getApplicationRootPath(APP, 1);
  t = await t.share(p1, o, kept.publicKey, "keeps", Permissions.KEY_READER);
  const i1 = DerivationPath.toIndexArray(p1);

  const after = await new SoftwareDevice(kept).readKey(t, i1);
  ok("eviction rotates the key", hex(after) !== hex(before));
  ok("the member who stayed reads the new one", after.length === 64);

  let got = null;
  try { got = await new SoftwareDevice(evicted).readKey(t, i1); } catch { /* expected */ }
  ok("the evicted member derives nothing on the new path", got === null,
     got ? hex(got) : "");

  // Stated rather than hidden: rotation is forward-only. A host that could
  // read yesterday's data can still read the copy it already has, and no
  // later act reaches into it.
  const old = await new SoftwareDevice(evicted).readKey(t, i0).catch(() => null);
  ok("and can still open what was sealed to it before — forward-only",
     old !== null && hex(old) === hex(before));
}

console.log(`\n${pass}/${pass + fail} passed\n`);
process.exit(fail ? 1 : 0);
