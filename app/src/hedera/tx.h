/*****************************************************************************
 *   Vela — Hedera transaction bodies, built on the device.
 *
 *  The chip does not verify bytes the host hands it. It builds the transfer
 *  itself, from fields it has checked against the mandate, and signs what it
 *  built. There is nothing to compare because there is only one author.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *****************************************************************************/

#pragma once

#include <stddef.h>
#include <stdint.h>

/** Enough for a two-party HBAR transfer body with an empty memo. */
#define HEDERA_BODY_MAX 192

/**
 * A single HBAR transfer, in the only shape Vela signs.
 *
 * Shard and realm are 0 on every public Hedera network, so accounts reduce to
 * their number. Keeping the shape this narrow is deliberate: the chip can
 * only ever produce a plain two-party transfer, which means an agent cannot
 * talk it into signing a contract call or a token operation.
 */
typedef struct {
    uint64_t payer;             /// account debited, and the transaction's payer
    uint64_t payee;             /// account credited
    uint64_t node;              /// consensus node the transaction is submitted to
    uint64_t amount;            /// tinybars moved
    uint64_t fee;               /// max transaction fee, tinybars
    uint64_t valid_start_sec;   /// transaction id timestamp
    uint32_t valid_start_nanos;
    uint32_t valid_duration_sec;
} hedera_transfer_t;

/**
 * Serialise a CryptoTransfer TransactionBody.
 *
 * @param[in]  t        the transfer, already checked against a mandate
 * @param[out] out      destination, at least HEDERA_BODY_MAX bytes
 * @param[in]  out_len  size of `out`
 *
 * @return number of bytes written, or -1 if the buffer is too small.
 */
int hedera_build_transfer_body(const hedera_transfer_t *t, uint8_t *out, size_t out_len);
