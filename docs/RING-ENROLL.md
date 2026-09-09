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
block itself. The library ships an `ApduDevice` that would do exactly that,
and it speaks to the **Ledger Sync** app — a different app on the same
device. Wiring it means the operator quitting Vela, opening Ledger Sync, and
coming back. It is worth doing and it is not something to pretend we did.

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

### Rotation on removal is not implemented

`removeMember` rotating the ring key is the SDK's behaviour and the reason the
asymmetry is worth having. `enroll.cjs` does not do it: it has `forget`, which
deletes *this* host's own identity, and that is deliberately a smaller thing
with a smaller name. Ejecting someone else is the owner's act, it needs
`StreamTree.close` plus re-sharing to everyone who remains, and it is not
written yet. Saying `revoke` for something that only forgets locally would be
the worst of both.

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
