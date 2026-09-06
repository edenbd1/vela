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

/**
 * Enough for a two-party HBAR transfer body with an empty memo.
 *
 * Real ones come out at 62 bytes; the margin covers large account numbers
 * and a far-future timestamp. Kept tight because this sits in a response
 * buffer on a device with very little room.
 */
#define HEDERA_BODY_MAX 128

/** Longest calldata the chip will accept. Four ABI words and a selector. */
#define HEDERA_CALLDATA_MAX 132

/**
 * Enough for a contract call body carrying HEDERA_CALLDATA_MAX of arguments.
 *
 * Larger than a transfer body for the obvious reason, and sized from the
 * pieces rather than guessed: the header fields come to about forty bytes,
 * the ContractCall submessage adds the contract id, gas and value, and then
 * the calldata verbatim.
 */
#define HEDERA_CALL_BODY_MAX 224

/**
 * A single HBAR transfer.
 *
 * Shard and realm are 0 on every public Hedera network, so accounts reduce to
 * their number. The shape stays this narrow on purpose: within this path the
 * chip can only ever produce a plain two-party transfer, so an agent cannot
 * talk *this* encoder into emitting anything else. Contract calls have their
 * own encoder and their own mandate checks, next to it rather than folded in.
 */
typedef struct {
    /**
     * The account named in the transaction id, which pays Hedera's network
     * fee. Under x402 that is the facilitator, not the buyer — the paying
     * agent never has to reason about gas. It is distinct from `from`, and
     * conflating the two produces a transaction the network rejects.
     */
    uint64_t fee_payer;
    uint64_t from;              /// account debited — the one this device controls
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

/**
 * A contract call.
 *
 * `calldata` is passed through verbatim, which is exactly why the mandate has
 * to have read it first. The protobuf names the contract and the value; where
 * that value ends up is decided by bytes this encoder does not interpret.
 */
typedef struct {
    uint64_t fee_payer;
    uint64_t from;              /// the account this device controls
    uint64_t contract;          /// Hedera contract number being called
    uint64_t node;
    uint64_t amount;            /// tinybars sent with the call
    uint64_t fee;
    uint64_t gas;
    uint64_t valid_start_sec;
    uint32_t valid_start_nanos;
    uint32_t valid_duration_sec;
    uint16_t calldata_len;
    const uint8_t *calldata;
} hedera_call_t;

/**
 * Serialise a ContractCall TransactionBody.
 *
 * @param[in]  c        the call, already checked against a mandate
 * @param[out] out      destination, at least HEDERA_CALL_BODY_MAX bytes
 * @param[in]  out_len  size of `out`
 * @return bytes written, or -1 if it did not fit
 */
int hedera_encode_call(const hedera_call_t *c, uint8_t *out, size_t out_len);
