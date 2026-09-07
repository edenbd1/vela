# ENSv2 — an agent is a name with permissions

> **Not part of the submission.** Kept because the interface is verified
> against the deployed contracts and it is a credible direction afterwards.
> The reason it was dropped is in [`../docs/DIRECTION.md`](../docs/DIRECTION.md):
> remove it and this project works identically, which is what "cosmetic"
> means.

ENS's own framing for this track:

> *think agents as namespaces, each with their own identity and permissions*

That is the fleet. Each agent gets a subname, and Enhanced Access Control
expresses what it may do — reversible, and scoped to that one name, which is
the difference from ENSv1's one-way fuses and the reason an agent's authority
can be taken back rather than only expired.

## Where each fact lives

The project already keeps an agent's three halves apart on purpose:

| | holds | editable by |
|---|---|---|
| the chip | what it may spend | nobody, including the host |
| the broker | what it may invoke | whoever holds that host |
| **ENSv2** | **who it is, and what it is entitled to** | **whoever holds the parent name, publicly** |

ENS is the layer a stranger can read. The broker's roster is a JSON file on a
machine; a subname with roles is a fact anyone can resolve without being given
access to anything.

## What is verified

`test/AgentNames.t.sol` forks Sepolia and calls the deployed ENSv2
`ETHRegistry` at `0xBDC85dD5b15D7ecb354cd7cb6f2c50b4f2c4F0E2`:

```console
$ forge test --fork-url $SEPOLIA_RPC -vv
[PASS] test_registryIsDeployed()      ETHRegistry bytecode size: 14730
[PASS] test_stateOfAnUnusedLabel()    status: 0 (AVAILABLE)
[PASS] test_rolesOnAnUnusedLabel()
```

The addresses came out of documentation, and documentation is a claim. The
interface in `src/IENSv2.sol` is hand-written rather than pulled in as a
dependency — compiling the whole of `ensdomains/contracts-v2` to call four
functions is a lot of build for no extra certainty, and a fork test against
the deployed bytecode is a stronger guarantee than a matching source tree.

## What is blocked

Issuing subnames needs two things this repository does not have:

1. **Sepolia ETH.** A throwaway address is generated into `.env` as
   `SEPOLIA_ADDRESS`. Fund it from any Sepolia faucet.
2. **A parent name** on ENSv2 Sepolia to issue under, or our own
   `PermissionedRegistry` deployed as the agents' subregistry — which the
   prize text explicitly allows: *"deploy your own subname registry to
   tokenize and manage subnames under your own rules."*

Both are one transaction each once the address has gas. Nothing else is
waiting on them: the interface is verified, and the mapping from capability
to role bitmap is a pure function of the broker's roster.
