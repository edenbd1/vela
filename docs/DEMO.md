# The demo — a shooting plan

Five minutes is the Hedera limit and the right length anyway. The plan is
built so it can be recorded in one take, and so that the moment that carries
the argument needs no narration.

**What is on screen:** a terminal, the console at `127.0.0.1:4050`, and the
Ledger Flex — filmed, not screenshotted. The device being a physical object is
half the point.

---

## Before recording

```bash
./scripts/build.sh && ./scripts/load.sh      # appFlags must print 0x0
python3 host/bridge.py &
node broker/server.mjs &
node hedera/risk.mjs &
node hedera/seller.mjs &
node hedera/gateway.mjs &
node web/server.mjs &
node hedera/fleet.mjs                         # 5 taps: revoke, revoke, grant ×3
```

`fleet.mjs` creates the audit topic as part of granting, so every chain on it
starts at draw 1. Note the topic id it prints — the last shot needs it.

Check the console shows three agents before you start.

---

## 0:00 — the problem, on the device

Hold the Flex. Three names on the screen.

> "These are three agents. One is on a VPS, one in a CI runner, one in a
> container on this laptop. None of those machines has a Ledger plugged into
> it, and none of them holds an API key or a private key."

Then the line that sets up everything else:

> "Ledger's own Agent Stack says *agents propose, humans approve* — one tap
> per transaction. That is not an agent. This is one tap per **envelope**."

## 0:40 — a host with nothing on it

```bash
./agent/run.sh
```

Let the inventory sit on screen. It is the whole claim, written by the thing
being claimed about:

```
  api keys                   none
  private keys               none
  recovery phrase            none
  broker token               one — scoped to this agent, revocable, useless elsewhere
  usb devices                none — this is a container
```

> "It screens three counterparties using an API key it has never seen, and
> pays for an inference with a signature made in a chip it cannot reach."

Point at the tx hash. It is real HBAR on testnet.

## 1:30 — what the chip refuses

In the console, press **buy the 0.15 tier** against a 0.10 ceiling.

> "Same agent, same service, one tier up. The chip refuses, and the refusal
> comes back as an answer with a reason — not an error to retry."

Then the DeFi pair, side by side:

> "Same contract. Same function. Same amount. One field differs — the address
> the proceeds go to."

```
swap, proceeds to itself     → signed
same swap, to an attacker    → recipient_not_self
```

> "In DeFi the danger is not the amount, it is who ends up holding the
> output. That is the field an injected agent rewrites, and it is the one the
> chip will not sign away."

## 2:40 — the controlled experiment

```bash
./scripts/experiment.sh
```

> "Same rules, same agent, same attack. The only variable is where the ceiling
> lives."

```
software   [3/3] paying 100 HBAR to 0.0.66666666 … SETTLED
device     [3/3] … REFUSED (payee_not_allowed)
```

> "The software policy is not a straw man. It is the same shape as the
> governance layers being built for this — caps, allowlists, a kill switch.
> It loses because it is reachable: it lives in the process the attacker
> already owns."

## 3:20 — the enclave that can only narrow

```bash
./scripts/composition.sh
```

Three results, and the third is the point:

```
A  the feed turns against a payee   → advisor_denied, nothing signed
B  the feed clears it               → paid, real tx
C  the enclave allows an account the chip never knew
                                    → 0xb104 payee_not_allowed
```

> "A Chainlink confidential workflow, in an AWS Nitro enclave, screening
> payees against a feed whose *questions* are the secret — asking about four
> accounts tells you which four an agent may pay. It can take a payee away.
> It cannot add one. A compromised advisor costs availability, never
> authority."

## 4:00 — the gesture

Back to the console. Press **Revoke this agent**. Then hold up the Flex:

> **Revoke ops-nightly?**
> *It loses every remaining draw immediately. Nothing on any host has to be
> rotated.*

Tap it. The agent disappears from the console.

**Say nothing while this happens.** If the gesture needs narration the idea is
not good enough.

Then, once:

> "No key was rotated. Nothing was redeployed. The machine that agent was
> running on never held anything to take away."

## 4:30 — anyone can check it

```bash
node hedera/verify.mjs <topic>
```

> "This reads the Hedera mirror node and nothing else. Every draw carries a
> statement the chip signed. You do not have to believe the host, or us."

End on:

```
2 of 2 envelope(s) verify.
  does not prove   that the service delivered anything, that the envelope
                   was a sensible size, or that the agent did anything useful
```

> "It also says what it does not prove. A verifier that overclaims is worse
> than none."

---

## What to cut if it runs long

In order: the DeFi pair at 1:30 (the refusal before it already lands), then
the enclave at 3:20. **Never cut the revoke.** It is the only thirty seconds
that cannot be replaced by a paragraph.

## What not to do

- Do not run against Speculos. Payments fail there with `INVALID_SIGNATURE`,
  correctly — the emulator signs for a key that does not own the account.
- Do not narrate over the device screens. Let them be read.
- Do not claim the Key Ring is holding the secrets unless `ring init` has run;
  `/capabilities` reports `plaintext-dev` and a viewer can see it.
