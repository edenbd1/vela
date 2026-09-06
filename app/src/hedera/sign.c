/*****************************************************************************
 *   Vela — Hedera signing, inside the Secure Element.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *****************************************************************************/

#include <string.h>

#include "os.h"
#include "crypto_helpers.h"

#include "sign.h"

/** m/44'/3030'/0'/0'/index' — the path Ledger's Hedera app uses. */
static void hedera_path(uint32_t index, uint32_t path[5]) {
    path[0] = 44 | 0x80000000;
    path[1] = 3030 | 0x80000000;
    path[2] = 0 | 0x80000000;
    path[3] = 0 | 0x80000000;
    path[4] = index | 0x80000000;
}

/**
 * Compress a curve point into an Ed25519 public key.
 *
 * The SDK hands back an uncompressed point: 0x04 || x || y, 65 bytes. An
 * Ed25519 public key is 32 — y in little endian, carrying x's parity in the
 * top bit. Reading the first 32 bytes instead gives you 0x04 followed by
 * most of x, which looks like a key, is accepted by every tool that only
 * checks the length, and produces signatures nothing can verify.
 */
static void compress_ed25519(const uint8_t raw[65], uint8_t out[HEDERA_PUBKEY_LEN]) {
    for (int i = 0; i < 32; i++) {
        out[i] = raw[64 - i];
    }
    if (raw[32] & 1) {
        out[31] |= 0x80;
    }
}

bool hedera_pubkey(uint32_t index, uint8_t out[HEDERA_PUBKEY_LEN]) {
    uint32_t path[5];
    hedera_path(index, path);

    // 65 bytes, not 32: the SDK writes an uncompressed point here, and a
    // 32-byte destination is a buffer overrun as well as a wrong answer.
    uint8_t raw[65] = {0};

    if (CX_OK != bip32_derive_with_seed_get_pubkey_256(HDW_ED25519_SLIP10,
                                                       CX_CURVE_Ed25519,
                                                       path,
                                                       5,
                                                       raw,
                                                       NULL,
                                                       CX_SHA512,
                                                       NULL,
                                                       0)) {
        return false;
    }

    compress_ed25519(raw, out);
    explicit_bzero(raw, sizeof(raw));
    return true;
}

bool hedera_sign_body(uint32_t index,
                      const uint8_t *body,
                      size_t body_len,
                      uint8_t out[HEDERA_SIG_LEN]) {
    uint32_t path[5];
    size_t sig_len = HEDERA_SIG_LEN;

    hedera_path(index, path);

    return CX_OK == bip32_derive_with_seed_eddsa_sign_hash_256(HDW_ED25519_SLIP10,
                                                               CX_CURVE_Ed25519,
                                                               path,
                                                               5,
                                                               CX_SHA512,
                                                               body,
                                                               body_len,
                                                               out,
                                                               &sig_len,
                                                               NULL,
                                                               0);
}
