# Honest assessment — what is built, and what is missing

Written four days before the deadline, deliberately unflattering. A status
report that only lists what works is a report nobody can act on.

*Updated 2026-09-10: gaps 1, 2, 4 and 5 are closed. Gaps 3 and 6 stand,
and the verdict at the bottom has been rewritten rather than left to rot.*

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
- **An agent that decides.** A local model with a toolset derived from the
  mandate, refused by the chip and adapting to it — including a swap whose
  proceeds an injected advisory tried to redirect.
- **Recovery.** An envelope restored onto a replacement device at the position
  the public log says it reached.
- **A fleet console** that draws each agent's reasoning live, with the chip's
  refusals and the broker's shown apart.
- **136 assertions** across five suites — 31 host-side, 45 on the agent loop,
  17 on Key Ring enrolment, 12 on the console in a real browser, 31 against
  the chip — each shown to fail when the thing it checks is broken.
- **The controlled experiment**, which is the strongest single artefact: same
  rules, same attack, one variable — software settles the theft, the chip
  refuses it.

## What is missing

Ranked by how much it costs us.

### ~~1. There is no agent~~ — closed 2026-09-09

`agent/reason.mjs` runs a local model with four tools and a budget it does not
control. It reaches past the per-payment ceiling, is refused, reads the
reason, and comes back with a tier that fits — a branch nobody wrote.

It has since grown past that. Its toolset is derived from the envelope the
chip published, so an agent whose mandate carries no contract clause is never
told that swapping exists. When the mandate does allow calls it builds the
calldata itself — and a compromised risk feed talked it into aiming the
proceeds at an attacker, which the Secure Element refused on the one field
that mattered. Verified on the Flex, 2026-09-10.

Three things came out of building it that are worth more than the feature:

- The first run announced it had 100 HBAR against an envelope holding 0.5 —
  the pitch, stated by the thing the pitch is about.
- `agent/bench.mjs` measures what the chip allowed against what the agent
  asked for: 0.21 HBAR against 1.16 across six runs per model.
- Every model, in every run, routed a swap's proceeds to the attacker — most
  of the time after flagging the advisory as an instruction. Noticing is not
  resisting.

Details, and the tool-calling failure that forced grammar-constrained
decoding, are in [AGENT-LOOP.md](AGENT-LOOP.md). 45 assertions in
`test/agent.test.mjs`, no device and no model needed.

### ~~2. The Key Ring is not on a remote host~~ — closed 2026-09-09

`host/ring/enroll.cjs` does the whole ceremony now: `request` on the host with
no device, `grant` where the ring is, `claim` back on the host. Verified
against the real ring — the bundle carries neither private key, the member
derives the same key the owner does, and a host that was never admitted gets
`Cannot find key in the tree for the current device`.

The trustchain's owner key is sealed under `wallet-cli ring encrypt`, so you
cannot admit a host without the device having admitted you first.

`revoke` ejects a member and rotates the key: the application stream closes,
the next branch opens, everyone who remains is re-shared. The ejected host
derives nothing on the new path. Verified on the real ring.

One thing is still not done and is written down rather than implied: signing
each `AddMember` on the device itself needs the Ledger Sync app rather than
Vela. 17 assertions in `test/ring.test.mjs`.

### 3. "Machines you do not control" are containers on one laptop

Defensible for a demo, and a real VPS costs three euros and would make the
sentence true.

### ~~4. Three slots is three agents~~ — closed 2026-09-10

Eight. Three was never a hardware limit — it was one page of NVRAM and nothing
had asked for a second. `dataSize` is computed by the loader from the linker
symbols around the storage struct, so it grew with it: 512 bytes to 1536. The
cost in SRAM is 228 bytes of bar buffers against roughly 30 KB of stack, and
NBGL pages the fleet screen once it stops fitting.

Granted mandates are listed before free ones, because with three the order did
not matter and with eight it does. Verified on the emulator, screen included;
two of the 31 chip assertions are on the slot count itself, so a future bump
cannot ship slots nothing touches.

**Not yet on hardware.** It needs a reload, and the storage magic changed, so
it wipes what is there. See below.

Eight is not thirty, and the honest reason to stop there is not the one this
document gave. "512 bytes of NVRAM is the ceiling" was wrong: the loader sizes
that section from the struct. What actually bounds it is that every slot costs
NVRAM whether it is used or not, at 152 bytes each, and nobody here has run
more than eight agents at once to find out where the real wall is. Thirty
would be 4.6 KB, which is plausible and untested.

### ~~5. Nothing recovers~~ — closed 2026-09-10

`VELA_RESTORE_MANDATE` puts an envelope back at the position the public log
says it reached, and `hedera/recover.mjs` reads that position off the mirror
node. The terms come from a backup `fleet.mjs` writes; the log carries a
digest of them, so an edited backup matches no envelope the chain ever saw.

The chip does not verify the position and the code says why: it signs whatever
it is handed, so a record fabricated a second ago verifies as well as a real
one. Ed25519 over your own key is not evidence to yourself. What checks it is
the log, which is public, and the person holding the device, who is standing
there anyway — the same trust model as granting.

It refuses more than it accepts. A chain with a gap yields no position, since
every missing draw is spending it would hand back; run against our own topic
it refused `research-1` on the artefact of that morning's topic-rotation bug.
An envelope with no records is refused rather than restored at zero.

9 of the host-side assertions and 9 of the chip's cover recovery alone.

### 6. The broker is a trust point while it runs

Documented rather than solved: it can decrypt while alive, so a compromised
broker can misuse a secret it currently holds. What the ring buys is that
nothing is at rest there and membership rotates away without touching the
upstream key.

## Is the differentiator well served?

*Rewritten 2026-09-10. The version below replaces one that said this project
demonstrates infrastructure rather than showing an agent. That was true when
it was written and is no longer, and leaving it would be a status report
arguing against its own repository.*

The thesis is right and differentiating: **one tap per envelope instead of one
per transaction**, proved by a single command.

What changed is that there is now an agent, and it produced the sharpest
argument in the project rather than merely illustrating one. A local model,
told by a compromised risk feed to route a swap's proceeds elsewhere, did it —
**every model, every run, 6/6 and 6/6** — and most of the time after flagging
the advisory as an instruction. Noticing is not resisting.

That case is also the only one where the chip is genuinely alone. A transfer
names its payee in the transaction body, so an honest host-side policy reaches
the same answer as the Secure Element on every other scenario here. A contract
call names only the contract; the recipient is an ABI word the body does not
interpret, chosen inside the process the injection already reached.

**Legibility.** Better than it was. The controlled experiment and the revoke
gesture landed immediately before; the agent being refused and correcting
itself lands the same way, and the console now shows three agents reasoning
side by side with two kinds of refusal in two colours. Everything else still
needs reading.

**Product readiness.** Closer, and still no. Recovery exists and is tested;
eight slots is not thirty; the broker remains a trust point while it runs;
"machines you do not control" are still containers on one laptop. What is
genuinely missing is written above rather than softened here.

**The one thing that can still lose this outright** is that the video does not
exist. Every gap closed this week is worth nothing if nobody sees it.

## What to do with the time left

Four of the six gaps are closed. What is left, in order:

1. **Record the video.** `docs/DEMO.md` has the shooting plan. Nothing below
   matters if this does not happen, and it is the only item here that cannot
   be recovered from on Sunday morning.

2. **Reload the app onto the Flex.** Eight slots and mandate recovery are
   proved on the emulator and have never run on hardware. The storage magic
   changed, so a reload wipes what is there and needs a regrant after it.
   Reloading has triggered a factory reset on this device three times, which
   is why it is second rather than first: the demo works without it.

3. **Purge `docs/PLAN.md` from git history** with `git filter-repo` before the
   repo goes public. It is out of the working tree and still in the history.

4. **A real VPS**, so "machines you do not control" stops meaning "containers
   on one laptop". Enrolment makes this cheap now: `request` there, `grant`
   here, `claim` there.

Then, if there is time: signing `AddMember` on the device itself, which needs
the Ledger Sync app; and a broker that cannot decrypt while it runs.
