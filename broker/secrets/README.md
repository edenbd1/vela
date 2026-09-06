# Secrets

Nothing in here is a secret in the sense that matters.

`*.enc` files are ciphertext produced by the Ledger Key Ring:

```bash
printf '%s' "$THE_ACTUAL_KEY" | wallet-cli ring encrypt --key vela.risk-feed -o secrets/vela.risk-feed.enc
```

The key name is the scope. `wallet-cli ring encrypt --key <name>` derives a
distinct key per name, so a member enrolled for one is not thereby enrolled
for another.

`*.dev` files are **plaintext**, and exist only because `wallet-cli ring init`
requires a physical device and the broker had to be built before one was
available. The server logs a warning on every use and `/capabilities` reports
`plaintext-dev` as the backing, so a demo cannot quietly claim hardware it did
not use. Delete them once the ring is initialised.
