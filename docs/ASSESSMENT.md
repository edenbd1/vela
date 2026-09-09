# Honest assessment — what is built, and what is missing

Written four days before the deadline, deliberately unflattering. A status
report that only lists what works is a report nobody can act on.

*Updated 2026-09-09: gaps 1 and 2 are closed. The rest stands.*

---

## The idea, in plain terms

You want to run agents that spend money and use credentials, on machines you
do not control. Today that means copying a credential and a private key onto
those machines, and every guardrail then runs **in the process being
attacked**. The machine becomes as valuable as everything on it, and
revocation means rotating a key everywhere and hoping you got every copy.

Hardware custody solves the adjacent problem — it proves *you* approved. One
tap per transaction. That works for a human signing three transfers a month,
not an agent making forty in a night.

**Vela moves the decision instead of the human.** One tap per *envelope*: a
human grants "this agent, this budget, this ceiling, these payees" once, and
from then on the chip decides each payment against terms no host can read or
edit. The device becomes the console for a fleet running elsewhere.

## What is genuinely built

Verified on hardware, not asserted:

- **The BOLOS application.** C inside the Secure Element with its own NVRAM
  state, an on-chip protobuf serialiser, five ordered refusals, contract-call
  argument binding, a fleet screen, and revocation by finger. Very few people
  write these.
- **Payments.** Real HBAR over x402 on Hedera, signed inside the chip.
- **The audit log.** Every draw anchored on HCS with a 29-byte statement the
  chip signed, verifiable from the mirror node by someone who trusts nobody
  here.
- **Secrets under the Key Ring**, with the broker refusing rather than falling
  back to plaintext.
- **The Chainlink enclave**, narrowing what the gateway will ask for and
  provably unable to widen it.
- **Thirty-four assertions**, seventeen host-side and seventeen against the
  chip, both shown to fail when the thing they check is broken.
- **The controlled experiment**, which is the strongest single artefact: same
  rules, same attack, one variable — software settles the theft, the chip
  refuses it.

## What is missing

Ranked by how much it costs us.

### ~~1. There is no agent~~ — closed 2026-09-09

`agent/reason.mjs` runs a local model with four tools and a budget it does not
control. It reaches past the per-payment ceiling, is refused, reads the
reason, and comes back with a tier that fits — a branch nobody wrote.

Two things came out of building it that are worth more than the feature. The
first run announced it had 100 HBAR against an envelope holding 0.5, which is
the pitch stated by the thing the pitch is about. And `agent/bench.mjs` now
measures the gap between what the chip allowed and what the agent asked for:
across eight runs per model, 0.13 HBAR against 1.27.

Details and the tool-calling failure that forced grammar-constrained decoding
are in [AGENT-LOOP.md](AGENT-LOOP.md). 17 assertions in `test/agent.test.mjs`,
no device and no model needed.

### ~~2. The Key Ring is not on a remote host~~ — closed 2026-09-09

`host/ring/enroll.cjs` does the whole ceremony now: `request` on the host with
no device, `grant` where the ring is, `claim` back on the host. Verified
against the real ring — the bundle carries neither private key, the member
derives the same key the owner does, and a host that was never admitted gets
`Cannot find key in the tree for the current device`.

The trustchain's owner key is sealed under `wallet-cli ring encrypt`, so you
cannot admit a host without the device having admitted you first.

Two things are still not done and are now written down rather than implied:
signing each `AddMember` on the device itself needs the Ledger Sync app rather
than Vela, and rotate-on-eviction is not implemented — which is why the
command that drops a local identity is called `forget` and not `revoke`.
12 assertions in `test/ring.test.mjs`.

### 3. "Machines you do not control" are containers on one laptop

Defensible for a demo, and a real VPS costs three euros and would make the
sentence true.

### 4. Three slots is three agents

A fleet is thirty. The canvas says so; the demo cannot show it. 512 bytes of
NVRAM is the ceiling, and a real answer needs a different storage story.

### 5. Nothing recovers

Lose the device and every envelope is gone. The Key Ring has recovery.
Mandates do not.

### 6. The broker is a trust point while it runs

Documented rather than solved: it can decrypt while alive, so a compromised
broker can misuse a secret it currently holds. What the ring buys is that
nothing is at rest there and membership rotates away without touching the
upstream key.

## Is the differentiator well served?

The thesis is right and differentiating: **one tap per envelope instead of one
per transaction**, proved by a single command. The technical depth is real.

But the project **demonstrates infrastructure rather than showing an agent**,
and on this track that is the wrong edge of the knife.

**Legibility.** The controlled experiment and the revoke gesture land
immediately. Everything else needs reading — fine for a technical judge, thin
for a product one.

**Product readiness.** No. No recovery, three agents maximum, a broker that
remains a trust point while running, and no fleet console beyond a
three-inch screen. The canvas already says this; it is repeated here so the
two documents cannot drift.

## What to do with the time left

The first two are done — see the strikethroughs above. What is left, in order:

1. **Record the video.** `docs/DEMO.md` has the shooting plan and the
   benchmark takes ten minutes, so run it before the camera is on. Nothing
   below matters if this does not happen.
2. **Purge `docs/PLAN.md` from git history** with `git filter-repo` before the
   repo goes public. It is out of the working tree and still in the history.
3. **A real VPS**, so "machines you do not control" stops meaning "containers
   on one laptop". Enrolment now makes this cheap: `request` there, `grant`
   here, `claim` there.

Then, if there is time: rotate-on-eviction, recovery for mandates, more than
three slots.
