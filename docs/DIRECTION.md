# Direction — your agent fleet, in your pocket

The pitch, the architecture, the track choices, and what is honest to claim.
Written to be argued with; where the reasoning is weak it says so.

---

## The sentence

> **You run agents on machines you do not control. The only thing that sees
> all of them, and can take any of them back, is an object in your pocket.**

Not "a device that keeps your agents safe". A device that is the **console**
for a fleet running somewhere else.

## Why this and not what came before

Everything we built until now was a guardrail: bound the spend, refuse the
payee, prove the ceiling held. All true, all defensible, and all the wrong
shape for the thing we are entering. A guardrail is a vitamin. Judges — and
users — reward what *enables*, and the same hardware enables something a
guardrail framing hides:

**You can deploy a powerful agent onto a box you do not own, and take it all
back.** Not by trusting the box. By never having given it anything to keep.

That is the difference between "my agent cannot overspend" and "I can finally
put my agent on a VPS."

## What the device does that nothing else can

Four things live in four places, and the split is the design:

| layer | where it lives | why there |
|---|---|---|
| **Identity & permissions** | the broker's roster | whoever holds that host — and an agent reads only its own |
| **Secrets** | Ledger Key Ring (`wallet-cli ring`) | encrypted at rest under hardware; the agent asks for the *action*, never the key |
| **Money** | mandate in the Secure Element | an envelope the host cannot read, edit or skip |
| **Proof** | HCS, signed by the chip | a record that does not depend on believing the host |
| **Judgement** | a Chainlink CRE enclave | narrows what the gateway will ask for; can never widen it |

The device is the only component **every agent depends on and none can
modify**. That is what makes it a console rather than a dashboard. A dashboard
shows you what a server says. This shows you what the chip knows.

## Is the BOLOS app still worth it? Yes, and it is the point

Without it, this is `wallet-cli ring` plus scripts, and the Ledger is a
passive key store. With it:

- the fleet is **visible on the device** — the NBGL control panel is already
  built: a list, per-agent detail pages, revoke, revoke-all
- each agent's envelope lives in **NVRAM**, surviving unplugging and reboot
- revocation is a **physical tap**, not an API call a compromised host can
  ignore
- almost nobody writes BOLOS apps, which is the moat and the reason a Ledger
  judge will care

Ledger's track asks for projects "where device-backed security is central to
the product". A native application is the strongest available reading of
*central*.

The three NVRAM slots stop being a limit and become the feature: **three
agents, three envelopes, one object.**

---

## What the device may honestly display

The open design question, and the one place this could quietly become
dishonest.

The chip can only show what it knows. If the host tells the device *"I am
`vps-paris-1`"*, the screen is displaying a **claim**, dressed as a hardware
fact. That is exactly the error the rest of this project exists to avoid, and
it would be the easiest one to ship without noticing.

So the device does not show **where** an agent runs. It shows **what it
authorised**, which it owns:

- the agent id, set by the human at grant time
- the envelope: budget, spent, reserved, remaining
- the sequence counter — every draw increments it

That last one replaces *where it runs* with something better: **that it
runs.** A counter that moved is proof of life the chip minted itself. "Last
seen at draw #7" is a fact; "running on vps-paris-1" is a sentence the host
typed.

**Where the host does get attested:** the Key Ring. An enrolled member holds
credentials the trustchain records, and membership is removable with key
rotation. So the honest join is:

> the **device** says what it authorised · the **Key Ring** says who is
> enrolled · together they answer *who is running, and where*

The web console may show host names, because it is a host and may be wrong.
The device screen may not, because it is the device and may not.

---

## Tracks

Three submissions allowed.

**Ledger — $3,500.** The anchor, and the track that dictates the build. Their
own words, in their order:

> *Agents that use secrets they cannot leak: a broker hands out scoped
> capabilities, never the API key.*
> *Bring the Key Ring to hosts with no USB port: enroll a VPS, a CI runner, or
> a hosted agent.*
> ***Both must be built on the Ledger Agent Stack, and in particular on the
> Ledger Key Ring CLI (`wallet-cli ring`).***

x402 payments are their *third* bullet and human approval their fourth. We had
built the third and skipped the two they lead with and make mandatory.

**Hedera — $6,000.** Largest pool, and already satisfied: a live x402-gated
service, a platform consuming it, real paid requests end to end, and an HCS
audit trail anyone can verify from the mirror node.

**Chainlink — $2,000.** A CRE Confidential Workflow with `handlerInTee` on
AWS Nitro, screening payees against a private feed the node operators cannot
read — and not because the key is hidden, but because the *questions* are: a
node watching this workflow ask about four accounts has learned which accounts
an agent may pay.

### Why Chainlink over ENS, having first chosen the other way

ENS was picked first, on the strength of their own sentence — *"think agents
as namespaces, each with their own identity and permissions"* — and a larger
pool: $4,500 across four payouts against $2,000 across two.

Then their own bar was applied honestly: *"central to the product, not a
cosmetic add-on."* Remove ENS tomorrow and this project works identically.
The broker's roster is what decides an agent's capabilities; an ENS subname
would **mirror** that decision without ever making it. That is the definition
of cosmetic, and a judge would see it in thirty seconds.

There is one way to make it central — have the broker read roles from ENS, so
the chain becomes the source of truth for what an agent may invoke. That is
more than a day, it puts a cross-chain read in the hot path of every call, and
it still leaves the question of why identity sits on Sepolia when money
settles on Hedera.

The enclave is already the opposite of that. It is built, it works, and it
**changes behaviour**: it removes a payee the chip would have signed for, and
fails to add one the chip refuses. Tested in both directions. It is a
mechanism, not a mirror, and it sits on the same axis as everything else here
— one more boundary that can only narrow.

A finished, genuinely integrated submission beats a rushed and arguably
decorative one, particularly on a track whose stated bar is "not cosmetic".

`ens/` stays in the repository. It cost an hour, its interface is verified
against the deployed contract on Sepolia, and it is a credible direction after
the hackathon. It is simply not one of the three.

---

## What exists, and what does not

Built and proven on hardware:

- the BOLOS app: mandate in NVRAM, on-chip Hedera serialiser, NBGL control
  panel, on-chip contract-call checks
- Hedera x402 payments signed inside the Secure Element, HCS anchoring with
  chip signatures, a verifier that reads only the mirror node
- the Chainlink CRE confidential workflow
- a web console
- fourteen developer-experience findings written up for Ledger

Not built:

- **the capability broker** — secrets under `wallet-cli ring`, the agent
  receiving results rather than keys
- **enrolment of a host with no USB port** — a VPS or container joining the
  ring
- **the fleet view** on the device, using the three slots for three agents
- **ENSv2 subnames** with Enhanced Access Control — kept as a direction,
  not submitted

The first two are what Ledger asks for and makes mandatory. They come first.

## The demo

1. Three agents, three machines, none with a device attached. They are
   working, and they are paying for what they use.
2. One of them holds an API key it has never seen: it asks the broker for the
   action, and gets the answer.
3. You pick up the Flex. All three are on the screen — what each may spend,
   what each has spent, that each is alive.
4. You tap one. It stops.

No narration required for step four, which is the test of whether the idea is
any good.

---

## What would make this wrong

- **The broker is a host.** If it is compromised it can misuse a secret while
  it holds it decrypted. What the Key Ring buys is that the secret is not
  *at rest* on that machine and can be rotated away — not that a live process
  cannot be abused. Claiming otherwise would be overselling.
- **Three slots is three agents.** A fleet of thirty needs a different
  storage story than 512 bytes of NVRAM. Say so before someone asks.
- **The device shows what it authorised, not what happened.** An agent doing
  useful work and an agent burning its budget on nothing look identical from
  the chip's side.
