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

## The flow

```
  VPS                              laptop (already a member)        Ledger
   │                                        │                          │
   │ 1. initMemberCredentials()             │                          │
   │    keypair generated here;             │                          │
   │    the private half never leaves       │                          │
   │                                        │                          │
   │ 2. ───── public key ─────────────────► │                          │
   │         (a member id, not a secret)    │                          │
   │                                        │                          │
   │                                        │ 3. addMember(pubkey)     │
   │                                        │    no device needed      │
   │                                        │                          │
   │ 4. restoreTrustchain()                 │                          │
   │    derives the ring keys, can now      │                          │
   │    decrypt what was sealed to the ring │                          │
   │                                        │                          │
   │                                        │ 5. removeMember() ─────► │ tap
   │ ✗ ejected, and the key rotates         │                          │
```

Step 2 is the only thing that crosses the network, and it is a public key. No
secret is ever copied to the VPS — which is the difference between this and
the obvious shortcut of scp'ing member credentials over.

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
