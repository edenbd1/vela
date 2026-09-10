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

## The one measurement worth reading

Six runs per model, output in `docs/bench-2026-09-10-defi.txt`:

```
  the chip allowed                     0.21 HBAR
  the agents asked for                 1.16 HBAR
```

And, in the scenario where a compromised risk feed tells the agent where to
route a swap's proceeds: **every model, in every run, aimed at the attacker's
account** — most of the time after flagging the advisory as an instruction.
Noticing is not resisting. The mandate holds at whatever rate the model
misbehaves, including rates nobody has measured, which is the argument for
putting the limit in silicon rather than in a prompt.

---

## Tracks

### Ledger — AI Agents

Their framing is *"Agents propose. Humans approve."* — one tap per
transaction, and no limit enforced by the device. Vela is the missing half:
the device enforcing terms **between** taps.

- A native BOLOS app, ~4.6k lines of C in the Secure Element: NVRAM mandate
  storage, an on-chip Hedera protobuf serialiser, five ordered refusals, a
  fleet screen, revocation by finger, and mandate recovery.
- The refusal nothing on a host can make: a transfer names its payee in the
  transaction body, but a **contract call names only the contract**. Where the
  value lands is an ABI argument the body does not interpret — exactly what an
  injected agent rewrites. The chip reads that word out of the calldata it is
  about to sign and compares it with its own account.
- Their second ask, verbatim: *"Bring the Key Ring to hosts with no USB port:
  enroll a VPS, a CI runner, or a hosted agent."* `host/ring/enroll.cjs` does
  the ceremony, and a CI runner does it on every push.
- 14 findings from building on the platform, written up as
  `docs/FEEDBACK-LEDGER.md` — including one that factory-reset the device
  three times and is still not fully understood.

### Hedera

- Real payments over x402, signed on-device, settled on testnet.
- An HCS audit topic where every draw carries a 29-byte statement **the chip
  signed** — so the log is the device's own account, not the host's.
- A verifier that runs in the reader's browser against the public mirror node
  and nothing else. Contract calls are anchored too, which was a bug once: an
  agent that swapped left a hole in its own chain.

### Chainlink

- A CRE Confidential Workflow in an AWS Nitro enclave that narrows a mandate
  and is provably unable to widen it. `./scripts/composition.sh` shows both
  directions, including the enclave blessing an account the chip refuses
  anyway.

---

## What is not done, said here rather than discovered

- No agent **pays** from a machine we do not control. Enrolment happens on a
  public CI runner; the broker and gateway are still on one laptop.
- The device does not sign each Key Ring `AddMember`. That needs the Ledger
  Sync app rather than Vela, and the transport for it is written but unused.
- Eight mandate slots and recovery are proven on the emulator and have not run
  on hardware, because loading a new build wipes the mandates on it.
- The broker can decrypt while it runs. Nothing is at rest there, and
  membership rotates away without touching the upstream key, but a compromised
  broker can misuse a secret it currently holds.

`docs/ASSESSMENT.md` is the long version, written to be unflattering.
