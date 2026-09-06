# Lean Canvas & go-to-market

Written to be argued with. Where the honest answer is unflattering it is
written down as such — a canvas that survives only because nobody read it
closely is not worth the page.

---

## 1. Problem

**An agent that pays for things needs a key, and every control around that key
runs in the process being attacked.**

Three specific pains, in the order operators actually feel them:

1. **A compromised agent has no ceiling.** Prompt injection, a poisoned tool
   result, a bad plan — the failure mode is the same, and the spend limit is a
   variable in the same address space the attacker just reached.
2. **The only accepted alternative destroys the product.** Hardware custody
   asks a human to approve each transaction. Approve every payment and you do
   not have an agent; hand over the key and you do not have a limit.
3. **Nobody can prove what an agent was allowed to do.** After an incident, the
   evidence is the logs of the host that misbehaved. That is not evidence.

### Existing alternatives

| what people do today | why it fails |
|---|---|
| Spend caps in the agent framework | Same process as the attacker |
| API keys with per-key budgets at the provider | Only binds one provider; nothing binds the agent |
| A separate hot wallet, topped up manually | The float is the limit, and refilling it is a human in the loop |
| Multisig / policy co-signer service | Real, but the co-signer is a server: a compromise of it is a compromise of the limit |
| MPC wallet with policy engine | Policy lives in software the operator does not run |

## 2. Customer segments

**Early adopters (who we can reach now):** teams shipping agents that spend —
agent framework maintainers, x402 service builders, crypto-native funds running
ops or trading agents. They already feel pain 1 and have no answer for it.

**Economic buyer (who signs):** whoever is accountable for the money. Treasury
ops, or the finance lead who has to explain a €40k invoice from an agent.

**The distinction matters.** A framework maintainer adopts in an afternoon and
pays nothing. A treasury team pays but needs a fleet, an audit export, and a
recovery story. Selling to the first and invoicing the second is the whole
sequencing problem below.

**Explicitly not our segment:** consumer agents. A €249 device per operator is
correct for a treasury and absurd for a hobbyist. Saying otherwise would be the
easiest way to build the wrong product.

## 3. Unique value proposition

> **A spending limit your agent cannot argue with.**

The mandate lives in a Secure Element. The agent has no key, the host has no
key, and the chip refuses in silicon — so the limit survives the agent being
compromised, which is the only condition under which a limit matters.

**High-level concept:** hardware custody, minus the human in the loop.

## 4. Solution

| pain | what answers it | proven |
|---|---|---|
| No ceiling under compromise | Mandate in NVRAM; five checks before a signature exists | `payee_not_allowed`, `over_per_call`, `over_budget` on real hardware |
| Autonomy vs. control | One human tap grants an envelope; the agent then runs unattended | 4 paid draws, no taps, real HBAR |
| No provable record | Every draw anchored on HCS with a statement the chip signed | `1 of 1 envelope(s) verify` from the mirror node alone |
| The chip cannot see the world | Chainlink CRE confidential workflow narrows the mandate; it can never widen it | enclave allowed `0.0.77777777`, chip answered `payee_not_allowed` |

## 5. Channels

1. **Agent frameworks.** A gateway with three tools (`/envelope`, `/pay`,
   `/receipts`) and a guide. Integration is a day, not a quarter.
2. **Ledger's developer ecosystem.** The app is a native BOLOS application. The
   distribution question is whether it reaches Ledger Live's catalogue — which
   is a partnership, not a growth channel we control.
3. **The x402 / Hedera ecosystem.** Every priced service is a place a mandated
   agent can spend.

Channel honesty: (2) is the one that matters and the one we do not own.

## 6. Revenue streams

**The uncomfortable part first: the hardware is Ledger's business, not ours.**
We do not make money on the device, and pretending otherwise would put a
margin in this canvas that does not exist.

What is actually sellable is everything around the chip:

| stream | who pays | why they would |
|---|---|---|
| **Fleet console** (many devices, many agents, one view of live mandates) | treasury / platform teams | Managing three mandates is a script; managing three hundred is a product |
| **Compliance export** — signed, third-party-verifiable statements of what each agent was authorised to spend and did spend | finance, audit, insurers | The verifier already produces this; packaging it is the work |
| **Enrolment and recovery** built on the Ledger Key Ring Protocol | anyone past their first device | Losing a device must not mean losing the envelope |
| **Support and integration** | enterprise | Standard, unglamorous, real |

Not taking a cut of payments. A take-rate on x402 draws would make us a party
to every transaction, which is exactly the position the design exists to
eliminate.

## 7. Cost structure

- **Firmware maintenance.** The real recurring cost. Ledger's SDK moves, API
  levels change, and a BOLOS app that stops loading is a dead product. Budget
  this as continuous, not a one-off.
- **Hardware, per operator.** ~€249 (Flex). Borne by the customer.
- **On-chain.** HCS messages are fractions of a cent; the x402 network fee is
  carried by the facilitator. Negligible, and it should stay negligible —
  anchoring every draw only works because it is nearly free.
- **Enclave execution.** Chainlink CRE, per workflow run. Scales with payee
  count and cadence, not with payment volume.
- **Audit.** Anything holding spending authority in a Secure Element needs a
  real security review before it holds anyone's real money.

## 8. Key metrics

The one that matters:

> **Draws per human approval.** How many payments an agent makes per tap.

It is the product in a single number. At 1 it is a hardware wallet. In this
demo it is 4 and bounded only by the envelope. If that ratio does not rise in
production, nothing else is worth measuring.

Supporting:

- **Refusals per 1 000 draws** — near zero means the envelopes are too loose to
  be doing anything; too high means agents are planning blind.
- **Time-to-first-mandate** for a new integrator. Target: one afternoon.
- **Envelopes that verify** from the public log alone. Anything below 100% is a
  bug in us, not in the operator.
- **Revoke-to-effect latency.** How long between a human revoking and the next
  draw failing.

## 9. Unfair advantage

**Real:** the mandate runs *inside* the Secure Element. Not a policy server,
not an MPC quorum, not a co-signer — a native BOLOS application with its own
NVRAM state and its own protobuf serialiser, so the chip signs bytes it built
from fields it checked. Very few teams write BOLOS apps at all, and the
[eleven developer-experience findings](FEEDBACK-LEDGER.md) collected building
this are a fair proxy for why.

**Not an advantage, and worth naming:** the *idea*. Agent spend controls are a
crowded space — `spendveto`, `hedera-agentpay-guard` and others do policy in
software. The defensible part is only ever the boundary, never the concept.

**The strategic honesty:** this looks less like a standalone company than a
feature Ledger should ship. That is not a weakness of the product; it is a
statement about the right exit, and it should shape who we talk to first.

---

## Go-to-market

### Phase 1 — be adopted before being sold (0–3 months)

Open source, free, one afternoon to integrate. The goal is not revenue, it is
**one agent framework whose docs mention hardware mandates as an option.**

Doing: ship the gateway and the agent guide, get a mandate running inside two
or three real agent projects, publish the verifier output for every one of them.

Success: a mandate somebody else granted, spending money we never touched, with
a public log anyone can check.

### Phase 2 — one operator with real money (3–9 months)

A single design partner — most likely a crypto-native fund or an x402 service
operator, because they already hold hardware and already have agents.

What they will demand, and none of it exists yet:

- more than one device, with recovery (the Key Ring work is started, not
  finished)
- mandate templates and rotation, rather than hand-built APDUs
- an export their auditor will accept

That list is the product roadmap. It is also the honest answer to "why can't
this be sold today".

### Phase 3 — distribution (9–18 months)

Ledger Live's catalogue, or Ledger Enterprise. This is the step that decides
whether the thing is a company or a very good demo, and it does not depend on
engineering.

### What would falsify this

Written down first, so it cannot be quietly forgotten:

- **Agents do not actually get compromised often enough to pay for.** If the
  loss rate stays theoretical, this is insurance nobody buys. Watch real
  incidents, not think-pieces.
- **Software policy is good enough for the buyer.** If treasury teams accept an
  MPC policy engine, the hardware boundary is a distinction without a purchase
  order.
- **The hardware requirement kills it.** One device per operator may simply be
  too much friction, whatever it buys.
- **Ledger ships it themselves.** The most likely outcome, and not the worst
  one.
