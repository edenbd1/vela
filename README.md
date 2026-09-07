<p align="center">
  <img src="brand/vela-mark-256.png" width="96" alt="Vela">
</p>

<h1 align="center">Vela</h1>

<p align="center">
  <em>Your agents run on machines you do not control.<br>
  The only thing that sees all of them, and can take any of them back,<br>
  is an object in your pocket.</em>
</p>

<p align="center">
  <a href="#the-fleet">The fleet</a> ·
  <a href="#capabilities-not-credentials">Capabilities, not credentials</a> ·
  <a href="#the-experiment">The experiment</a> ·
  <a href="#run-it">Run it</a>
</p>

---

## The problem

An agent that does real work needs two things you would rather not give it: a
credential, and a way to spend money.

Today you copy both onto whatever machine it runs on. The API key sits in an
environment variable. The private key sits in a keystore beside it. Every
control around them is host software — a spend cap in the same process a
prompt injection just reached, an allowlist in a config file that process can
edit, a rate limiter the agent could be talked into ignoring.

That is not a limit. It is a suggestion, enforced by the thing being attacked.
And it makes the machine as valuable as everything on it: revocation means
rotating a key somewhere else and hoping you got every copy.

Hardware custody solves the adjacent problem — it proves *you* approved a
transaction. Ledger's own [Agent Stack](https://blog.thirdweb.com/ledger-agent-stack-hardware-gated-wallet-security-for-ai-agents/)
puts it plainly: **"Agents propose. Humans approve."** One tap per
transaction, and no limit enforced by the device at all. That assumes a human
at the screen for every action, which is exactly what an autonomous agent
cannot have. Approve every payment and you do not have an agent. Hand over the
key and you do not have a limit.

## What Vela is

A native BOLOS application for the Ledger Flex that turns the device into the
console for a fleet of agents running somewhere else.

```
    Ledger Key Ring   what it may use           encrypted; it gets results, not keys
    Secure Element    what it may spend         NVRAM; no host can read or edit it
    Chainlink CRE     whether it should         an enclave that narrows, and cannot widen
    Hedera + HCS      what it actually did      signed by the chip, checkable by anyone
```

You grant an envelope once, with a tap. After that the agent runs unattended
on a VPS, a CI runner, a container — anywhere, with nothing on it worth
stealing. And the device stays the one component every agent depends on and
none can modify, which is what makes it a console rather than a dashboard. A
dashboard shows you what a server says. This shows you what the chip knows.

## How it fits together

<p align="center">
  <img src="docs/architecture.png" alt="Vela architecture" width="880">
</p>

The diagram is drawn around one question: **who can edit what.** The agents
hold nothing. The broker and gateway are hosts you control, and they still
hold nothing at rest. The chip holds the only figures nobody can change, and
the two layers along the bottom can narrow what an agent may do without ever
widening it.

## The fleet

Three agents, three envelopes, one object:

```
research-1    -  0.5/0.5 HBAR   ›
ops-nightly   -  0.2/0.2 HBAR   ›
watcher       -  0.1/0.1 HBAR   ›
Revoke all mandates             ›
```

Tap one and the device asks:

> **Revoke ops-nightly?**
> It loses every remaining draw immediately. Nothing on any host has to be
> rotated.

That last sentence is the product. Revocation is a finger on a screen, not a
key rotation across every machine that ever held a copy.

Everything on that screen comes out of NVRAM. The host is never consulted and
cannot be — an agent reporting its own state to this screen would be an agent
describing itself to the one thing meant to check it. Which is also why the
device shows what it *authorised* rather than where anything runs: if the host
says "I am `vps-paris-1`", the screen would be displaying a claim dressed as a
hardware fact. The sequence counter says something the chip owns instead —
that an agent is alive, not where it is sleeping.

## Capabilities, not credentials

The agent never receives the API key. It invokes a **named action** and
receives the **result**; the secret is decrypted under the Ledger Key Ring for
one upstream request and dropped.

The decision that matters is not the encryption. It is that the URL lives in
the manifest and not in the request:

```console
$ POST /do/risk.screen  {"params": {"account": "0.0.66666666"}}
  → score 97, sanctioned counterparty          49 calls left

$ POST /do/risk.screen  {"params": {"account": "0.0.1",
                                    "url": "http://attacker.example/collect"}}
  → 'url' is not part of this capability

$ POST /do/risk.screen  {"params": {"account": "../../admin"}}
  → does not match ^0\.0\.[0-9]{1,12}$
```

A broker that took a URL from an agent and attached a credential to it would
be a confused deputy with an API key. So an agent supplies only declared
parameters, each matched against a pattern before it reaches a template, and
an invalid request never gets far enough to have a credential attached.

`wallet-cli ring encrypt --key <name>` derives a distinct key per name, so the
ring itself carries the scoping: a member enrolled for `vela.risk-feed` is not
thereby enrolled for `vela.market-data`. That boundary survives the filesystem
being copied, which a permission bit does not.

## A host with nothing on it

[`agent/`](agent) runs in a container with no `--device`, no volume and no
secret in its environment, so the claim is checkable rather than asserted. The
first thing it prints is its own inventory:

```
everything on this machine:
  api keys                   none
  private keys               none
  recovery phrase            none
  broker token               one — scoped to this agent, revocable, useless elsewhere
  usb devices                none — this is a container
  reachable                  :4060  (actions)
                             :4030  (payments)
```

Then it screens three counterparties with a credential it has never seen, and
pays for an inference with a signature made in a chip it cannot reach.

The token is not nothing, and the inventory says so. It authenticates to one
broker, unlocks one agent's grants, and is revoked by deleting a line. Key
Ring membership replaces it once a device can enrol the host.

## The experiment

Same rules. Same agent. Same attack. One variable: where the ceiling lives.

```console
$ ./scripts/experiment.sh
```

A policy of *100 HBAR total, 20 max per draw, may only pay 0.0.10365984* is
loaded twice — once into `host/software/policy.py`, an honest and correct
host-side implementation of exactly the same checks, and once into the chip.
Then the same agent tries to send 100 HBAR to an account that is not on the
list.

| | where the rules live | outcome |
|---|---|---|
| **software** | `host/software/policy.py`, same process as the agent | `[3/3] paying 100 HBAR to 0.0.66666666 … SETTLED` |
| **device** | Ledger Flex Secure Element | `[3/3] … REFUSED (payee_not_allowed)` |

The software policy is not a straw man. It is not buggy, it is not weaker than
the chip's, and it is the same shape as the mature spend-governance layers
being built in this space — caps, budgets, allowlists, a kill switch, enforced
before settlement. It loses because it is reachable: the attacker in this
scenario has already reached the agent's process, and a rule that lives in the
process being attacked is a rule the attacker owns. The chip's copy is behind
a boundary the host cannot cross.

That is the whole thesis, and it is one command.

## What the chip enforces

```c
typedef struct {
    uint8_t  in_use;
    uint8_t  n_payees;
    uint8_t  agent_id[AGENT_ID_LEN];      // 20
    uint64_t payees[MANDATE_MAX_PAYEES];  // Hedera account numbers, not hashes
    uint64_t budget_total, reserved, spent, per_call_max;
    uint32_t expiry, seq;
} mandate_t;                              // 96 bytes; 3 slots fit in NVRAM
```

Every `AUTHORIZE` runs five checks in the Secure Element, in order, before a
signature exists:

1. **expiry** — has the envelope run out of time
2. **payee** — is the credited account on the allowlist, matched as a full
   Hedera account number, not a truncated hash
3. **per-draw ceiling** — is this single payment under `per_call_max`
4. **budget** — is it under `budget_total − reserved − spent`
5. **reserve, then sign** — `reserved` is committed to NVRAM *before* the
   signature is produced, so a host that takes a signature and never reports
   back has still spent the budget

Refuse and the host gets a status word and nothing else. There is no signature
to salvage, because none was ever computed.

The chip also builds the Hedera transaction body itself — `app/src/hedera/tx.c`
is a protobuf serialiser running on-chip. It does not sign bytes the host hands
it. It signs bytes it constructed from fields it checked, which is what makes
the checks mean anything: a host that lies about the payee in its own
serialisation is signing a payee the chip already rejected.

Signing is domain-separated. `hedera_sign_anchor()` prefixes `vela.anchor.v1`
before signing, so an audit-log statement can never be replayed as a transfer.

## Verified on Hedera testnet

Not mocked. Not on an emulator. Real HBAR, real consensus, from a physical
Ledger Flex.

| what | evidence |
|---|---|
| Payment signed in the Secure Element | account [`0.0.10392125`](https://hashscan.io/testnet/account/0.0.10392125) — its private key exists on no disk here |
| x402 settlement | Blocky402 facilitator, `CRYPTOTRANSFER`, `result: SUCCESS` |
| Public audit log | topic [`0.0.10393818`](https://hashscan.io/testnet/topic/0.0.10393818) |
| On-chip refusals | `payee_not_allowed`, `over_per_call`, `over_budget` |
| NVRAM persistence | *IDENTICAL — the envelope survived a full application restart* |

The buyer account is controlled by the key derived on the device at
`m/44'/3030'/0'/0'/0'`. Nothing on this machine can spend from it. The only
path to a signature runs through a mandate check in the chip.

### Anyone can check it

`hedera/verify.mjs` reads the Hedera mirror node and **nothing else** — no
local state, no trust in this repo, no trust in the host that produced the log.

```console
$ node hedera/verify.mjs 0.0.10393818

topic   0.0.10393818
source  https://testnet.mirrornode.hedera.com/api/v1 — and nothing else

mandate 0f39b1086dbf4421…  granted 1788707364  8 draw(s)
  ok    seq 1 follows 0 with no gap
  ok    remaining 49000000 is not negative
  ok    seq 2 follows 1 with no gap
  ok    remaining 48000000 = 49000000 - 1000000
  ok    remaining 48000000 is not negative
  ok    seq 3 follows 2 with no gap
  ok    remaining 40000000 = 48000000 - 8000000
  ok    remaining 40000000 is not negative
  ok    seq 4 follows 3 with no gap
  ok    draw 4 released within the envelope (30000000 <= 40000000)
  ok    remaining 30000000 is not negative
  ok    seq 5 follows 4 with no gap
  ok    draw 5 released within the envelope (20000000 <= 40000000)
  ok    remaining 20000000 is not negative
  ok    seq 6 follows 5 with no gap
  ok    draw 6 released within the envelope (10000000 <= 40000000)
  …
  → complete and consistent
```

Each anchored record carries a 29-byte statement the chip signed —
`mandate_id ‖ seq ‖ payee ‖ amount ‖ remaining` — plus its Ed25519 signature.
Without those the log would be the host's account of what the chip decided.
With them it is the chip's own, and the host is only the courier.

What the verifier proves: every anchored draw settled on Hedera exactly as
recorded, in order, against one fixed envelope, and never past its ceiling.

What it does not prove: that the service delivered anything, that the envelope
was a sensible size, or that the agent did anything useful. It is stated that
way in the output too. A verifier that overclaims is worse than none.

## The pieces

```
app/         BOLOS application for Ledger Flex — the mandates, the fleet
             screen, the on-chip Hedera serialiser  (~4.6k lines of C)
broker/      the capability broker: secrets under the Key Ring, agents get
             named actions and results
agent/       an agent in a container with no device and no credentials
hedera/      x402-gated seller, the Ledger-backed signer, HCS anchoring, the
             public verifier, the multi-tenant gateway
cre/         Chainlink CRE confidential workflow, running in an AWS Nitro
             enclave
ens/         ENSv2 — an agent as a namespace with permissions
web/         the console: the whole fleet, and the button that stops one
host/        APDU bridge, device journal, Key Ring enrolment, the software
             control arm
docs/        Ledger developer-experience feedback, the direction, the canvas
```

### On-device control panel

The app is not a dialog that appears when the host asks. Opening Vela lands
directly on the list of live mandates — what each agent may spend, what is
left, who it may pay — with per-mandate detail and revocation, plus a
*Revoke all mandates* button. Authority you cannot see is not authority you
control, so it is the home screen rather than a settings sub-page.

### Key Ring enrolment

`host/ring/enroll.cjs` runs the Ledger Key Ring Protocol ceremony: an agent
*requests* membership, and a human *grants* it on the device. Removal requires
the device and rotates the key, so revocation is not a database update someone
can undo.

## Run it

Requires a Ledger Flex in developer mode, Docker, Node 20+, and Python 3.9+.

```bash
./scripts/build.sh                # build the BOLOS app
./scripts/load.sh                 # sideload it (quit Ledger Wallet first)

python3 host/bridge.py &          # APDU shim on :8099
node broker/server.mjs &          # capability broker on :4060
node hedera/seller.mjs &          # x402-gated service on :4021
node hedera/gateway.mjs &         # payments, one slot per agent, on :4030
node web/server.mjs &             # the console on :4050

./agent/run.sh                    # an agent, in a container, with nothing on it
```

Open `http://127.0.0.1:4050` to see the fleet and stop one of them.

`./scripts/experiment.sh` runs the controlled experiment.
`./scripts/composition.sh` shows the enclave narrowing a mandate, and failing
to widen it.
`node hedera/refusals.mjs` exercises every refusal without damaging the audit
log.
`./scripts/persistence-test.sh` tears the app down and proves the envelopes
survived.

**Develop on Speculos, not on the device.** It runs the same ELF and found a
segfault in three iterations after a morning wasted on hardware. It cannot
tell you anything about persistence, timing, or what the silicon considers an
attack — see [`docs/PROTECTION-MODE.md`](docs/PROTECTION-MODE.md), which
exists because this Flex factory-reset itself three times.

Two things that will cost you an hour if nobody tells you: **quit Ledger
Wallet** before touching the device, and note that `scripts/build.sh` mounts
the *repository root* — the Ledger SDK calls `git rev-parse --show-toplevel`
and silently drops every source file if it does not find a git repository.

## The second boundary

The mandate in the chip is hard, and it is static. The Secure Element has no
network and no clock beyond an expiry, so it cannot learn that an account which
was reputable when the human granted the envelope is a drainer today. That is a
real gap — and closing it on the host would close it in the one place this
whole project argues you cannot trust.

So it is closed in an enclave instead. [`cre/spend-advisor`](cre/spend-advisor)
is a Chainlink CRE workflow declared with `handlerInTee` against AWS Nitro in
`us-west-2`. It screens the mandate's payees against a private risk feed and
returns a verdict.

Two sensitive things meet in that handler, and the second is the one that is
easy to miss:

- **The feed's API key.** It belongs to the operator, not to whichever node
  happens to pick up the trigger.
- **The questions.** Even against a feed with public answers, asking about four
  specific accounts tells a listener exactly which accounts an autonomous agent
  is authorised to pay — the shortlist an attacker wants in order to know where
  to aim. Confidential HTTP keeps the query pattern inside the enclave, not
  just the key.

**The composition is one-directional, and that is the whole point:**

> The enclave can narrow what the chip allows. It can never widen it.

`./scripts/composition.sh` tests both halves, because proving only the first
would be marketing:

```console
A. The enclave turns against a payee the chip still allows.
     enclave: deny 0.0.10388937: adverse media, under review (score 88)
     the agent asks for the cheap tier, exactly as before:
       advisor_denied
     nothing changed on the device. Only what the enclave knows.

B. The same request, once the enclave clears the payee.
       paid, tx 0.0.7162784@1788702885.000000000

C. The enclave blesses an account the chip has never heard of.
     enclave: allow 0.0.77777777  no adverse signal (score 3)
     chip:    0xb104  payee_not_allowed
```

C is the one that matters. A compromised advisor costs availability. It never
costs authority — the mandate lives in NVRAM behind a hardware boundary, and
nothing the enclave emits is an input to it.

The gateway reports advisor refusals as `terminal: false`, unlike the chip's.
The chip is deterministic and will refuse identically forever; the advisor
holds a live opinion the next run may reverse. Marking it terminal would have
an agent abandon a counterparty for good over a signal that was true for one
afternoon.

## Notes for Ledger

Building this surfaced fourteen concrete developer-experience problems,
written up with reproductions in
[`docs/FEEDBACK-LEDGER.md`](docs/FEEDBACK-LEDGER.md).

**The one that cost the most is still unexplained, and that is the finding.**
The Flex factory-reset itself three times over two days, taking the seed with
it. It was protection mode: the device interprets some event as an attack and
resets. It knows which event. It never says, and neither does the loader
talking to it — the device comes back showing *"Welcome to Ledger Flex"* and
passes its genuine check, because it is genuine and empty. A development loop
of repeated sideloads over an untrusted channel, crashing apps and wedged USB
pipes resembles the thing that protection exists to catch. We diagnosed it
wrong twice before reading the device's own screen, and the write-up records
both wrong answers because the reasoning is the lesson.

Most of the rest are one error string away from being fine. Three more are
real bugs:

- **`bip32_derive_with_seed_get_pubkey_256` writes 65 bytes for Ed25519.**
  The documented output is a 32-byte key; the SDK writes an uncompressed point.
  A caller sizing the buffer from the documentation gets a 33-byte stack
  overrun and a wrong public key beginning `04`. Downstream this produced a
  Hedera account nobody could ever spend from, failing as `INVALID_SIGNATURE`
  a long way from the cause.
- **`buffer_move()` copies the entire remaining buffer**, not the requested
  length, so any multi-field APDU fails on its first field.
- **`DISABLE_DEFAULT_IO_SEPROXY_BUFFER_SIZE` is documented in the boilerplate
  Makefile and read by nothing.** Setting it changes no buffer size, the build
  succeeds in silence, and the app dies at runtime with no status word when a
  response exceeds the size it thought it had raised.

A twelfth finding was drafted and then dropped: a crash we first blamed on our
own 64px glyph turned out to be the buffer overrun above. The correlation was
real and the conclusion was wrong, so the write-up records that rather than
shipping a false report.

## Built on

[Ledger](https://developers.ledger.com) BOLOS/NBGL, the Agent Stack and
`wallet-cli ring` · [Hedera](https://hedera.com) for settlement and consensus ·
[x402](https://x402.org) with the Blocky402 facilitator ·
[Chainlink CRE](https://docs.chain.link/cre) Confidential Workflows for the
enclave half.

An [ENSv2](https://docs.ens.domains/ensv2/overview) integration is sketched in
[`ens/`](ens) with its interface verified against the deployed Sepolia
contracts. It is not part of this submission: removing it would change
nothing here, which is its own answer to whether it belongs.

`app/` derives from [`LedgerHQ/app-boilerplate`](https://github.com/LedgerHQ/app-boilerplate), Apache-2.0.
