/*****************************************************************************
 *   Vela — Hedera signing, inside the Secure Element.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *****************************************************************************/

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/** Ed25519 public key, raw. */
#define HEDERA_PUBKEY_LEN 32
/** Ed25519 signature. */
#define HEDERA_SIG_LEN 64

/**
 * The buyer's public key, for the host to derive the account from.
 *
 * m/44'/3030'/0'/0'/index', the path Ledger's own Hedera app uses.
 */
bool hedera_pubkey(uint32_t index, uint8_t out[HEDERA_PUBKEY_LEN]);

/**
 * Sign a transaction body.
 *
 * Hedera signs the body bytes themselves with Ed25519 — there is no
 * pre-hashing step, which is why the SDK call takes the message where its
 * parameter is named "hash".
 *
 * This is the only place in Vela that can produce a signature, and it is
 * only ever reached after the mandate has cleared the draw. There is no key
 * on the host to bypass it with.
 */
bool hedera_sign_body(uint32_t index,
                      const uint8_t *body,
                      size_t body_len,
                      uint8_t out[HEDERA_SIG_LEN]);

/**
 * Sign an audit record.
 *
 * The chip's own statement about a draw it just authorised, so the public
 * log is not something the host asserts about the chip — the host only
 * carries it.
 *
 * The payload is built here from values the chip already holds, never taken
 * from the request, and it is domain-separated from a transaction body so
 * this can never be turned into a way to sign a transfer.
 */
bool hedera_sign_anchor(uint32_t index,
                        const uint8_t *record,
                        size_t record_len,
                        uint8_t out[HEDERA_SIG_LEN]);
