# Honest assessment — what is built, and what is missing

Written four days before the deadline, deliberately unflattering. A status
report that only lists what works is a report nobody can act on.

*Updated 2026-09-10, second pass: gaps 1, 2, 4 and 5 are closed, and 4 and 5
are now confirmed on the physical device rather than the emulator. Gap 3 is
half closed — a CI runner enrols, no agent pays from a host we do not control.
Gap 6 stands. The verdict at the bottom has been rewritten rather than left to
rot.*

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
- **211 assertions** across seven suites — 39 host-side, 11 checking the
  browser verifier agrees with the Node one, 60 on the agent loop, 28 on Key
  Ring enrolment, 22 on the console in a real browser, 6 on a public CI
  runner, and 45 against the chip — each shown to fail when the thing it
  checks is broken.
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
decoding, are in [AGENT-LOOP.md](AGENT-LOOP.md). 60 assertions in
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

And the stronger version is done too, as of 2026-09-10: `grant --device`
makes the Secure Element itself the trustchain owner, so every `AddMember` is
a block signed on the chip with a person approving the screen. Verified on the
Flex — a new trustchain rooted in the device, a member admitted by a tap,
`members --device` listing it.

It took four status words and none of them names what is wrong.
`ApduDevice.getPublicKey()` cannot succeed at all; the challenge does *not*
have to come from Ledger's backend, which is the opposite of what we first
concluded; and the app signs `OWNER` admissions only, refusing
`Permissions.KEY_READER` as `SW_BAD_STATE`. Finding 17 has the trail and
`host/ring/challenge-probe.cjs` reproduces the first two gates on hardware.

So a member admitted by a tap is an owner, and `--seal` is refused on that path
because the chip does not hand out the key it protects. Both are on the screen
and in the listing rather than buried. 28 assertions in `test/ring.test.mjs`,
eleven of them on the shape of the challenge the app accepts.

### ~~3. "Machines you do not control" are containers on one laptop~~ — closed 2026-09-10

Both halves now happen somewhere neither of us owns, and the log is public.

**Enrolment.** A GitHub Actions runner joins the Key Ring on every push:
`.github/workflows/enrol.yml`. It prints that it has no USB bus and no Ledger
tooling, generates its own identity, and shows that a host never admitted
derives nothing while one that was derives the key rather than receiving it.
That is Ledger's ask in Ledger's own words — "a VPS, a CI runner, or a hosted
agent".

**Spending.** `.github/workflows/remote-spend.yml`, run against a gateway on a
tunnel:

```
host      Linux 6.17.0-1022-azure x86_64
usb       no usb bus
ledger    no ledger tooling
seed      none
envelope  none — it is in NVRAM on a device this job cannot address

  "slot": 3, "agent": "remote-1",
  "budget": "5000000", "ceiling": "1000000", "available": "5000000"

  "paid": true, "tx": "0.0.7162784@1789076298.000000000"

  "paid": false, "refused": true, "reason": "over_per_call"
```

Azure hardware asked a Secure Element in a flat in Paris for money, got
0.01 HBAR of it on Hedera testnet, asked for eight times the ceiling, and was
refused. The refusal did not happen on the runner, in the gateway, or in any
policy file: it happened in NVRAM the runner cannot read, cannot raise and
cannot route around. The draw is anchored as message 15 on
`0.0.10463705`, an epoch since superseded — the topic rotates with every
fleet grant, which is why nothing here quotes one as permanent.

The envelope was disposable on purpose — 0.05 HBAR, one payee, granted with
`hedera/grant-one.mjs` into a free slot under the epoch already open, and
revoked afterwards. `fleet.mjs` would have revoked slots 0-2 and rotated the
topic to add a fourth agent, ending three working chains to run an experiment.

The token is still valid and still registered, deliberately, because what it
answers now is the point:

```console
$ curl -H "authorization: Bearer $TOKEN" .../pay -d '{"service":"triage"}'
{ "paid": false, "refused": true, "reason": "no_mandate", "terminal": true,
  "advice": "a human must grant an envelope on the device first" }
```

The credential outlived the authority. Nothing was rotated, no secret was
re-issued, and no host was asked to forget anything — a person held a button
on a device, and a working token became a token that can ask and be told no.
That is the inverse of how revocation usually works, where the credential *is*
the authority and taking it back means chasing every copy.

What this cost while it ran: one loopback service was reachable from the
internet. Three things bounded that — every write path needs a token, the URL
died with the process, and a fully compromised token still buys only its
envelope. `scripts/remote-agent.sh` says all of that in its own header, and it
is not something to leave running.

Two things the first attempt got wrong, kept in the script because the next
person will hit both. cloudflared's quick tunnels registered, resolved, and
answered 404 from Cloudflare's edge to every request; ngrok worked and gives a
stable free hostname. And ngrok's inspector binds port 4040, which
`hedera/risk.mjs` was already using — it wins silently, and every
`screen_counterparty` call then gets ngrok's 404 instead of the risk feed. The
script moves the inspector and warns if anything else lands there.

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

**Confirmed on hardware 2026-09-10.** Eight slots read out of the real Flex's
NVRAM after a reload.

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

**Confirmed on hardware 2026-09-10.** `recover.mjs` read `ops-nightly` off
the mirror node at draw 4, 0.04 HBAR spent, and restored it into a free slot
with the position intact — the agent resumed with what it had left rather
than with a fresh envelope. 9 host-side assertions and 9 on the chip cover
recovery alone.

### A capability nobody asked for: velocity

Added because the gap was real rather than because it was on the list. A
mandate can cap draws per window, checked on chip. `ops-nightly` is granted
four an hour: a nightly job that suddenly wants six a minute is the shape of a
compromised agent, and the budget alone would let it have them.

**Confirmed on hardware 2026-09-10.** Four payments settled, the fifth refused
`too_fast` with 0.16 of 0.20 HBAR still available — the refusal has nothing to
do with money left, which is the whole reason for having it.

Twelve chip assertions, including the three that matter: a refused draw does
not consume the window it was refused for, a host that winds the clock back is
refused, and a restore brings the spend position back while starting a fresh
window. That last one is a decision with a stated cost — velocity bounds the
rate between restores, not across them.

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

Four of the six gaps are closed, three of them confirmed on the physical
device rather than the emulator. What is left, in order:

1. **Record the video.** `docs/DEMO.md` has the shooting plan. Nothing below
   matters if this does not happen, and it is the only item here that cannot
   be recovered from on Sunday morning.

2. **Re-record the replay** with a chip refusal in it. `web/demo-run.json` is
   what a reader with no device sees, and the committed one was captured on a
   nearly-empty envelope — its refusals are the broker's and `over_per_call`
   rather than the contract-call one. `./scripts/record.sh` warns when a
   recording has no refusal in it.

3. **Purge `docs/PLAN.md` from git history** before the repo goes public. It
   is out of the working tree and still in two commits, and a public
   repository publishes its history too. `./scripts/purge-plan.sh --check`
   shows which; `--run` rewrites, after taking a mirror backup. Deliberately
   not automatic: every hash changes, the push is a force push, and a clone
   made beforehand still has the file.

Off this list as of 2026-09-10, both on the same day:

**Signing `AddMember` on the device**, which was here as "written, blocked on
an undocumented status word". It was not blocked. The status word meant
something else, twice.

**A real VPS.** The entry read "what is missing is an agent *paying* from
somewhere we do not own, which needs the broker and gateway reachable from
it" — and it turned out to want a tunnel rather than a host. Azure hardware
running a GitHub Actions job bought an inference on Hedera testnet and was
refused a larger one by the chip, both in a public log. Gap 3 above has it.

And a broker that cannot decrypt while it runs, which is the last honest gap
and too large for the time left.
