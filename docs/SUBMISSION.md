# Submission

Paste-ready text for the ETHGlobal form, and the evidence behind each claim so
nothing here has to be taken on trust.

---

## Short description

*A spending limit your agent cannot argue with.*

## Long description

An agent that does real work needs a credential and a way to spend money.
Today you copy both onto whatever machine it runs on, and every guardrail then
runs **in the process being attacked** — a spend cap in the same memory a
prompt injection just reached, an allowlist in a file that process can edit.
That is not a limit; it is a suggestion enforced by the thing being attacked.

Hardware custody solves the adjacent problem. It proves *you* approved: one
tap per transaction, with no limit enforced by the device at all. That assumes
a human at the screen for every action, which is exactly what an autonomous
agent cannot have.

**Vela moves the decision instead of the human.** A native BOLOS application
for the Ledger Flex holds a *mandate* in the Secure Element: this agent, this
budget, this ceiling per payment, these payees, these contracts. A human
grants it once with a tap. After that the agent runs unattended on a machine
with no key on it, and every payment is checked inside the chip against terms
no host can read or edit. One tap per **envelope**, not per transaction.

The device becomes the console for a fleet running elsewhere: open the app and
the first screen is the live list of agents and what each has left, read out of
NVRAM. Revocation is a finger on that screen — not a key rotation across every
machine that ever held a copy.

The agents are real. A local model chooses its own actions from a toolset
**derived from the mandate the chip published**, so an agent whose envelope
allows no contract calls is never even told that swapping exists. When the
chip refuses, the refusal comes back as a reason it can act on, and it adapts.

## What is genuinely proven, and where to check

| claim | where |
|---|---|
| Real HBAR, signed in the Secure Element | account [`0.0.10397072`](https://hashscan.io/testnet/account/0.0.10397072) |
| Every draw anchored, and checkable by anyone | `web/verify.html` — reads Hedera in **your** browser, talks to no server of ours |
| An agent refused by the chip, and adapting | `docs/AGENT-LOOP.md`, on hardware |
| Software cannot do this | `./scripts/experiment.sh` — same rules, same attack, one variable |
| A host with no USB port joining the Key Ring | a public GitHub Actions log |
| Every agent **spending** from hardware we do not own | `.github/workflows/remote-spend.yml` — all four, on GitHub runners with no USB bus. Each paid inside its own ceiling and was refused above it, by a chip none of them can address |
| A trustchain whose owner is the Secure Element | `enroll.cjs grant --device` — every admission a tap, two members admitted |
| Losing the device and getting the envelopes back | the fleet revoked and restored from the public log, positions intact to the tinybar |
| A rate limit, not just a budget | four draws paid, the fifth refused `too_fast` with 0.14 HBAR still available |
| A browser talking to the Flex with nothing of ours installed | press **Connect Ledger**: WebHID, no bridge process, no extension |

## The one measurement worth reading

Six runs per model, output in `docs/bench-2026-09-10-defi.txt`:

```
  the chip allowed                     0.28 HBAR
  the agents asked for                 1.12 HBAR
  the difference is the product        0.84 HBAR
```

And, in the scenario where a compromised risk feed tells the agent where to
route a swap's proceeds: **every model, in every run, aimed at the attacker's
account** — half the runs for one model and four in five for the other having
already flagged the advisory as an injected instruction. Noticing is not
resisting. The mandate holds at whatever rate the model misbehaves, including
rates nobody has measured, which is the argument for putting the limit in
silicon rather than in a prompt.

---

## Who else is in this space

Worth naming, because the distinction is the product.

[`krutftw/hedera-agentpay-guard`](https://github.com/krutftw/hedera-agentpay-guard)
is the closest work we found — a policy guard for x402 buyers on Hedera, with
server-signed ALLOW/DENY receipts anchored on HCS and verified from the mirror
node. It is careful, well-documented, and aimed at Hedera's micropayments
bounty rather than the Ledger track.

It also states its own boundary plainly: the receipt-signing key *"has no
Hedera account authority and cannot move funds"*, and HCS attestation is
buyer-side, *"after an x402 settlement response is observed"*. So the guard
answers a question and records the answer. The buyer still holds the key, and
a buyer that ignores a DENY pays anyway — the record proves what the guard
said, not what the buyer did.

That is the gap Vela is built in. Our refusal is not a receipt: it is the
absence of a signature. The key that pays lives in the Secure Element, behind
the check, so an agent that decides to ignore the limit has nothing to sign
with. Detection and prevention are different products, and the difference is
where the key sits.

Their listed future work — *"persistent daily/portfolio caps and multi-signer
policy"* — is budget and velocity, which we enforce in silicon.

We found nothing on the Ledger track building a BOLOS application, and nothing
combining Chainlink CRE with agent spending.

## Tracks

### Ledger — AI Agents

Their framing is *"Agents propose. Humans approve."* — one tap per
transaction, and no limit enforced by the device. Vela is the missing half:
the device enforcing terms **between** taps.

- A native BOLOS app, ~5.4k lines of C in the Secure Element: NVRAM mandate
  storage for eight agents, an on-chip Hedera protobuf serialiser, ordered
  refusals on expiry, payee, ceiling, budget and **rate**, a fleet screen,
  revocation by finger, and mandate recovery from the public log.
- A rate limit enforced in silicon — draws per window, on transfers and
  contract calls alike. A budget bounds the total; this bounds the speed,
  which is where an agent differs from a person.
- The refusal nothing on a host can make: a transfer names its payee in the
  transaction body, but a **contract call names only the contract**. Where the
  value lands is an ABI argument the body does not interpret — exactly what an
  injected agent rewrites. The chip reads that word out of the calldata it is
  about to sign and compares it with its own account.
- The whole fleet runs on hardware nobody here owns. Each agent has its token
  in the repository's secrets, the workflow takes the agent and the tier its
  ceiling forbids as inputs, and `scripts/runner-spend.sh` derives both from
  the chip — research-1's ceiling is 0.10, so it is refused at 0.15; the rest
  at 0.08. One command opens a tunnel, dispatches, follows the run, prints
  what the chip decided and closes the tunnel behind it.
- Their second ask, verbatim: *"Bring the Key Ring to hosts with no USB port:
  enroll a VPS, a CI runner, or a hosted agent."* `host/ring/enroll.cjs` does
  the ceremony, and a CI runner does it on every push. `--device` goes further
  and makes the Secure Element itself the trustchain owner, so every admission
  is a screen — which took four status words to reach, none of which names
  what is wrong.
- The console opens the device itself. Press **Connect Ledger** and the page
  talks to the Flex over WebHID — no bridge process, no extension, nothing of
  ours installed. macOS gives that interface to one process, so the tab then
  *lends* the device back: it answers APDUs on the bridge's port, and the
  gateway, the grant script and the agents never learn there is a browser at
  the other end. A console that took the device and kept it would be a console
  that blanks itself the moment you connect.
- 18 findings from building on the platform, written up as
  `docs/FEEDBACK-LEDGER.md` — including one that factory-reset the device
  three times and is still not fully understood.

### Hedera

- Real payments over x402, signed on-device, settled on testnet.
- An HCS audit topic where every draw carries a 29-byte statement **the chip
  signed** — so the log is the device's own account, not the host's. The
  console shows those bytes decoded under each payment: slot, draw, payee,
  amount, remaining, and the signature. It is the same parser the verifier
  checks signatures with, so the two cannot drift.
- A verifier that runs in the reader's browser against the public mirror node
  and nothing else. Contract calls are anchored too, which was a bug twice:
  the gateway had it, and `hedera/defi.mjs` went straight to the chip and
  skipped it, so running the DeFi demonstration put a hole in the log.
- Recovery from that log alone. The fleet was revoked — the device, as far as
  the envelopes are concerned, lost — and restored from the mirror node with
  every position intact. The one difference is conservative and deliberate: an
  unsettled reservation comes back counted as spent.

### Chainlink

- A CRE Confidential Workflow in an AWS Nitro enclave that narrows a mandate
  and is provably unable to widen it. `./scripts/composition.sh` shows both
  directions, including the enclave blessing an account the chip refuses
  anyway.

---

## What is not done, said here rather than discovered

- **The broker can decrypt while it runs.** Nothing is at rest there, and
  membership rotates away without touching the upstream key, but a compromised
  broker can misuse a secret it currently holds. This is the real remaining
  gap and it is too large for the time left.
- **Ejecting a member from the device-rooted trustchain is written and not
  proven.** `revoke --device` closes the stream and re-admits whoever remains,
  all signed on the chip, and every APDU succeeds up to the last one — a
  two-byte `COMMAND_CLOSE_STREAM` that the Ledger Sync app answers with a
  screen rather than a status word. Three attempts, five minutes of timeout
  each, and the person holding the Flex saw a prompt that did not match what
  the app's own source builds. Finding 18. Admission works; eviction on that
  chain is unverified, and the sealed-key path still has both.
- **The demonstration spends on testnet**, and a mandate denominated in HBAR
  says nothing about what the same envelope would mean against a token whose
  decimals the chip would have to learn.
- **Two envelopes granted on identical terms are one envelope to the public
  log.** The chip signs `slot || seq || payee || amount || remaining`, and
  nothing in there separates one grant from the next; Ed25519 is
  deterministic, so identical draws on identical envelopes are byte-identical
  records. Both verifiers now split a chain where the chip's counter restarts,
  which is the one thing a single envelope cannot produce twice, so an honest
  log verifies and recovery restores the grant the chip is holding. What is
  still open is the other direction: the log cannot show that the second
  segment is a second grant rather than the first one replayed. That needs a
  generation counter inside the chip's statement, and `hedera/verify.mjs` says
  so on any chain where it applies rather than leaving a reader to assume.

Three things that were on this list yesterday are not any more, which is worth
saying because the list is meant to be read as current:

- An agent now pays from hardware we do not own — a GitHub Actions runner,
  through a tunnel, refused `over_per_call` by the chip in a public log.
- The device does sign each Key Ring `AddMember`. It needed a challenge the
  app would accept, not Ledger's backend, which is the opposite of what we
  first concluded.
- Eight slots, velocity and recovery all run on hardware, including the fleet
  being revoked and restored from the public log with its positions intact.

`docs/ASSESSMENT.md` is the long version, written to be unflattering.
