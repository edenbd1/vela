# Secrets

Nothing in here is a secret in the sense that matters.

`*.enc` files are ciphertext produced by the Ledger Key Ring:

```bash
printf '%s' "$THE_ACTUAL_KEY" | wallet-cli ring encrypt --key vela.risk-feed -o secrets/vela.risk-feed.enc
```

The key name is the scope. `wallet-cli ring encrypt --key <name>` derives a
distinct key per name, so a member enrolled for one is not thereby enrolled
for another.

The ring is initialised on this machine: member `vela-broker`, trustchain
`001ed276d64fb6ef…`. Both secrets here are ciphertext, and `/capabilities`
reports `ring` as the backing.

`*.dev` files would be **plaintext**, and the broker still supports them
because it had to be built before a device was available. If one appears, the
server logs a warning on every use and `/capabilities` reports
`plaintext-dev`, so a demo cannot quietly claim hardware it did not use.

**The password is not typed to start the broker.** It is read from the macOS
keychain entry `vela-keyring` at first use, or taken from `WALLET_PASS` if a
deployment delivers it another way. With neither, decryption fails and the
broker refuses — a broker that silently falls back to plaintext is worse than
one that stops.

**What the ring does not buy.** The broker can decrypt while it runs, so a
compromised broker can misuse a secret it currently holds. What changes is
that nothing is at rest on that machine, and membership can be rotated away
without touching the upstream API's key.
