# Bringing the Key Ring to a host with no USB port

Ledger's track asks for this directly:

> Bring the Key Ring to hosts with no USB port: enroll a VPS, a CI runner, or
> a hosted agent.

It is worth saying plainly that this is not a wiring exercise. `wallet-cli
ring init` is documented as *"Set up this machine as a Ledger Key Ring member
… (device required)"*, and a VPS has nowhere to plug a device in. Taken at
face value, the CLI has no answer here.

The protocol does.

## What the trustchain actually requires

From the Ledger Sync SDK reference:

| Operation | Hardware |
| --- | --- |
| `initMemberCredentials()` | — |
| `addMember(trustchain, creds, member)` | — *(uses a `SoftwareDevice`)* |
| `removeMember(deviceId, trustchain, creds, member)` | **required** |

**Adding a member needs no device. Removing one does.**

That asymmetry is the whole design, and it points the right way: it is easy to
grant a machine access, and it takes the physical device to take it away.

## The flow, as built

Three commands on two machines. This is a real run.

**On the host with no device** — it makes its identity and sends 33 bytes:

```console
$ node host/ring/enroll.cjs request vps-frankfurt
member identity created for 'vps-frankfurt'
  private key stays in host/ring/.member.json (0600) and does not travel
  public key  028b209a51be33ed26f913159abffeea40cc51d263c4d529c6444eae1a9cee6fa9
```

**Where the ring is** — it admits the host and seals that agent's broker token
to a key both of them can derive:

```console
$ node host/ring/enroll.cjs grant 028b209a…6fa9 vps-frankfurt --seal "$AGENT_TOKEN"
Fetching key from your Ledger Key Ring…
Encrypting with key "vela-trustchain"…
'vps-frankfurt' admitted as a key reader
  member      028b209a51be33ed26f91315…
  path        m/0'/16'/0'
  in the ring vps-frankfurt

bundle written to host/ring/bundle-vps-frankfurt.json
  it carries the trustchain and one sealed secret. Neither the ring's
  private key nor the member's is in it — send it over anything.
```

**Back on the host** — it derives the key from its own membership:

```console
$ node host/ring/enroll.cjs claim host/ring/bundle-vps-frankfurt.json
'vps-frankfurt' is a member of this trustchain
  path        m/0'/16'/0'
  key         c7a1954f928a23efaf6f5b09…  derived, not received

the sealed secret opens:

   L1xVsaV9p4EJb-Xi0N1nG_f7VoxOGDG2
```

Two things travelled: a public key one way, and a bundle the other. The bundle
carries the trustchain and one ciphertext. It carries neither private key, and
it does not carry the derived key either — `readKey` computes it from the
tree and the member's own secret.

A host that was never admitted gets:

```
Cannot find key in the tree for the current device
```

which is why the bundle is safe to send over anything at all.

### What roots this in the device

The trustchain's owner key is not kept in the clear. It is sealed with
`wallet-cli ring encrypt --key vela-trustchain`, so admitting a host requires
being able to decrypt under the Key Ring — which requires this machine to be a
ring member, which required a physical Ledger at `ring init`.

You cannot admit a host to the fleet without the device having admitted you
first.

That is one level of indirection from the device signing each `AddMember`
block itself. `--device` closes it.

### Rooted in the Secure Element

`enroll.cjs grant <pubkey> <name> --device` makes the chip the trustchain
owner: every admission is a block signed on the device with a person approving
it. It speaks to the **Ledger Sync** app rather than to Vela — different app,
same device — so the bridge is told which app to expect:

```bash
pkill -f host/bridge.py
VELA_BRIDGE_APP="Ledger Sync" python3 host/bridge.py &
node host/ring/enroll.cjs grant 03a6e2ab…01d8 ci-runner-test --device
```

```console
>>> approve the SeedID screen on the device <<<
device key   039fdeb5d17beccb506dbf15e2b23848…
>>> approve the new trustchain on the device <<<
new trustchain, rooted in the Secure Element
>>> approve admitting 'ci-runner-test' on the device <<<
    the device signs owners only — this member will be an owner
'ci-runner-test' admitted as an owner
```

Getting there took four status words and none of them names what is wrong.
The trail is [finding 17](FEEDBACK-LEDGER.md); the two entry gates are
reproducible on a real Flex with `node host/ring/challenge-probe.cjs`. The
three things worth knowing here:

**`ApduDevice.getPublicKey()` cannot succeed.** It sends `e0 05 00 00 00`, and
`INS 0x05` in Ledger Sync is the *challenge* instruction, so an empty payload
is a malformed TLV: `0xB00D SW_PARSER_INVALID_FORMAT`. The route the app
implements is `getSeedId(challenge)`, which answers with the trustchain public
key derived from the seed after showing a screen.

**The challenge does not have to come from Ledger.** We had this wrong.
`verify_challenge_signature()` in `src/challenge_sign.c` binds the challenge to
Ledger's certificate only when `HAVE_LEDGER_PKI` is set *and* a SEED_ID
certificate is loaded. With none loaded it takes the path the source calls
legacy and verifies against the public key carried in the challenge itself — so
a challenge we sign here is accepted. `host/ring/seed-id-challenge.cjs` builds
one, and eleven assertions in `test/ring.test.mjs` hold its shape, because
every field is checked *by value* and any one of them wrong comes back as
`0xB00E SW_PARSER_INVALID_VALUE` without naming the field.

**The device signs owners only.** `signer_inject_add_member` in
`src/block/signer.c` displays and signs an `AddMember` when the permissions are
`OWNER`, or `OWNER` without `CAN_ADD_BLOCK`, and returns `SW_WRONG_DATA` for
anything else — which `handler_sign_block` reports as `0xB007 SW_BAD_STATE`.
`Permissions.KEY_READER`, the least-privilege value the library offers and the
obvious one for a CI runner, is refused.

A second member works too, and it is worth saying because it is a different
path: creating the tree signs one block, admitting into an existing one makes
the device re-parse its own prior blocks before it will sign. Device-rooted
enrolment does not stop at the first host.

Eviction is `revoke --device`, and it is **written but not proven**. `revoke`
used to load the software-rooted chain unconditionally, so a member admitted
by a tap could not be ejected at all — it answered "'second-runner' is not a
member. In the ring: vps-frankfurt" while `members --device` listed exactly
that name. Two rosters, two files, one of them addressable.

The device path closes the stream, opens the next branch and re-admits
everyone who remains, all signed on the chip, with OWNER permissions for the
same reason admission uses them. Where it stops: SeedID passes, the close
times out with no screen tapped, and the device then answers 0x6901 — busy,
not one of the app's own status words — to a plain get-app-name. Whether
`COMMAND_CLOSE_STREAM` displays at all on Ledger Sync 1.2.2 is the open
question. Nothing is written when it fails: the roster is saved last.

So the two paths differ, and the difference is on the screen and in the
listing rather than buried:

| | software-rooted | `--device` |
|---|---|---|
| owner | key sealed under the Key Ring | the Secure Element |
| admission | decrypt and sign, no tap | a tap per member |
| member gets | `KEY_READER` | `OWNER` — the only thing the app signs |
| `--seal` | yes | refused: `ApduDevice.readKey` throws by design |
| eviction | `revoke <name>` | `revoke <name> --device`, written, not proven |
| stored in | `trustchain.enc` | `trustchain.device.json` |

Two files, because they are two chains with two roots. Mixing them would put a
member admitted by a tap and a member admitted by a decryptable key in one
list, indistinguishable. `enroll.cjs members --device` lists the second.

The device-rooted chain holds no private key, so there is nothing to seal — and
sealing it under the Key Ring would reintroduce the very ring dependency that
`--device` exists to remove.

### What it replaces

Before this, the agent's token reached its container as
`-e AGENT_TOKEN=<plaintext>`: in the shell history, in the container's
environment, and in anything on the host that reads `/proc`. Now it arrives
sealed to a key the host derives from membership it can lose.

## Why revocation is the interesting half

`removeMember` **rotates** the ring's encryption key: the SDK opens a new
branch of the derivation tree and re-adds everyone except the removed member.
An ejected host cannot read anything sealed after its removal, even if it kept
every byte it ever held.

So the two ends of a host's life have different costs on purpose:

- **enrol** — cheap, no device, do it for every runner you spin up
- **eject** — needs the physical device, and invalidates the key

This is the same shape as the mandate itself: granting is deliberate and
bounded, and the only way to take something away for good runs through
hardware.

### Eviction, as built

```console
$ node host/ring/enroll.cjs revoke ci-runner
'ci-runner' ejected
  was         m/0'/16'/0'
  now         m/0'/16'/1'   (the key rotated)
  remaining   vps-frankfurt
```

Closing the current application stream and opening the next branch of the
derivation tree, re-shared to everyone who remains. Then, on the ejected host:

```console
$ node host/ring/enroll.cjs claim bundle-vps-frankfurt.json
this host cannot derive the key: Cannot find key in the tree for the current device
```

and on the one that stayed:

```console
  path        m/0'/16'/1'
  key         c233765b786a33beed18d16a…  derived, not received
```

**Rotation is forward-only, and pretending otherwise would be the dishonest
version of this feature.** A host that was a member yesterday can still open
what was sealed to it yesterday: it could already read that, and no later act
reaches into a copy someone already has. What eviction buys is everything from
now on. Anything long-lived has to be re-sealed on the new path —
`grant <pubkey> <name> --seal <value>` for a member who is staying.

`revoke` rotates and re-issues bundles **without** secrets in them. Quietly
re-sealing a token during an eviction is the sort of thing that should have to
be typed.

`forget` is the smaller, local thing: it deletes *this* host's own identity
and ejects nobody. Two names, because one of them needs the owner and one does
not.

## The cost, stated plainly

Rotation is not free. Data encrypted before a removal cannot be decrypted
after it — the CLI reports `⚠ Ledger Key Ring rotated` and decrypt fails.
Anything long-lived has to be re-sealed under the new ring after an eviction.

For Vela that is acceptable, because what the ring holds is operational
credentials — a Hedera operator key, facilitator settings — which are
rotatable by nature. It would not be acceptable for an archive.

## What this does not do

It does not give the VPS a signing key, and it is not meant to. The ring
carries the agent's *operational* secrets so they never sit in plaintext on a
rented machine. The ability to move funds stays where it belongs: in the
Secure Element, behind a mandate.

A host enrolled this way can read the credentials it needs to do its job. It
still cannot spend a tinybar.
