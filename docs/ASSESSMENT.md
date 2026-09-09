# Honest assessment — what is built, and what is missing

Written four days before the deadline, deliberately unflattering. A status
report that only lists what works is a report nobody can act on.

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

### 1. There is no agent

The largest gap, and the one that matters most on a track called *AI Agents x
Ledger*. Everything here is called an agent and nothing reasons: they screen
three hardcoded accounts and buy one inference. What exists is an
**authorisation and payment substrate for agents**, not agents.

A judge will ask where the AI is, and today the honest answer is nowhere.

### 2. The Key Ring is not on a remote host

Ledger's second ask, verbatim: *"Bring the Key Ring to hosts with no USB port:
enroll a VPS, a CI runner, or a hosted agent."*

What exists: `ring init` on **this** machine. The container talks to a broker
running here; it is not itself a ring member. `host/ring/enroll.cjs` was
started and never finished.

We are describing a capability we have not completed. That is worse than not
having it.

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

In order, stopping after the second if it runs out:

1. **An agent that actually reasons.** It does not need an expensive API — a
   local model, or even a planner that makes real decisions from real signals
   rather than a hardcoded list. What matters is that it chooses, is sometimes
   wrong, and is stopped by the chip.
2. **Finish remote Key Ring enrolment.** Ledger's explicit ask, the brick is
   half-built, and without it we describe something we do not have.

The rest — a real VPS, recovery, more slots — is bonus.
