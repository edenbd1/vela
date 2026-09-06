/*****************************************************************************
 *   Vela — Hedera transaction bodies, built on the device.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *****************************************************************************/

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "tx.h"

// Protobuf wire types we need.
#define WIRE_VARINT 0
#define WIRE_LEN 2

// Field numbers, from the Hedera protobufs.
//   TransactionBody: transactionID 1, nodeAccountID 2, transactionFee 3,
//                    transactionValidDuration 4, cryptoTransfer 14
//   TransactionID:   transactionValidStart 1, accountID 2
//   AccountID:       shardNum 1, realmNum 2, accountNum 3
//   Timestamp:       seconds 1, nanos 2
//   Duration:        seconds 1
//   CryptoTransfer:  transfers 1
//   TransferList:    accountAmounts 1
//   AccountAmount:   accountID 1, amount 2 (sint64)
#define F_BODY_TX_ID 1
#define F_BODY_NODE 2
#define F_BODY_FEE 3
#define F_BODY_DURATION 4
#define F_BODY_CRYPTO_TRANSFER 14
#define F_TXID_START 1
#define F_TXID_ACCOUNT 2
#define F_ACCOUNT_NUM 3
#define F_TS_SECONDS 1
#define F_TS_NANOS 2
#define F_DUR_SECONDS 1
#define F_CT_TRANSFERS 1
#define F_TL_AMOUNTS 1
#define F_AA_ACCOUNT 1
#define F_AA_AMOUNT 2

/** A bounded append-only writer. Every helper fails closed on overflow. */
typedef struct {
    uint8_t *buf;
    size_t cap;
    size_t len;
} pb_t;

static bool pb_byte(pb_t *w, uint8_t b) {
    if (w->len >= w->cap) {
        return false;
    }
    w->buf[w->len++] = b;
    return true;
}

static bool pb_varint(pb_t *w, uint64_t v) {
    do {
        uint8_t byte = (uint8_t) (v & 0x7F);
        v >>= 7;
        if (v) {
            byte |= 0x80;
        }
        if (!pb_byte(w, byte)) {
            return false;
        }
    } while (v);
    return true;
}

static bool pb_tag(pb_t *w, uint32_t field, uint8_t wire) {
    return pb_varint(w, ((uint64_t) field << 3) | wire);
}

/** field = varint value. Proto3 omits defaults, so zero writes nothing. */
static bool pb_uint(pb_t *w, uint32_t field, uint64_t v) {
    if (v == 0) {
        return true;
    }
    return pb_tag(w, field, WIRE_VARINT) && pb_varint(w, v);
}

/** field = sint64, zigzag encoded. Zero is a default and writes nothing. */
static bool pb_sint64(pb_t *w, uint32_t field, int64_t v) {
    if (v == 0) {
        return true;
    }
    uint64_t zz = (uint64_t) ((v << 1) ^ (v >> 63));
    return pb_tag(w, field, WIRE_VARINT) && pb_varint(w, zz);
}

/** field = an already-serialised sub-message. */
static bool pb_submsg(pb_t *w, uint32_t field, const uint8_t *body, size_t len) {
    if (!pb_tag(w, field, WIRE_LEN) || !pb_varint(w, len)) {
        return false;
    }
    if (w->len + len > w->cap) {
        return false;
    }
    memcpy(w->buf + w->len, body, len);
    w->len += len;
    return true;
}

/**
 * AccountID contents for shard 0, realm 0.
 *
 * Vela only ever addresses accounts on the public networks, where shard and
 * realm are zero and proto3 leaves them out.
 */
static int account_id(uint8_t *out, size_t cap, uint64_t num) {
    pb_t w = {out, cap, 0};
    if (!pb_uint(&w, F_ACCOUNT_NUM, num)) {
        return -1;
    }
    return (int) w.len;
}

/** One leg of the transfer list: an account and a signed delta. */
static int account_amount(uint8_t *out, size_t cap, uint64_t account, int64_t delta) {
    uint8_t acc[16];
    int acc_len = account_id(acc, sizeof(acc), account);
    if (acc_len < 0) {
        return -1;
    }

    pb_t w = {out, cap, 0};
    if (!pb_submsg(&w, F_AA_ACCOUNT, acc, (size_t) acc_len) ||
        !pb_sint64(&w, F_AA_AMOUNT, delta)) {
        return -1;
    }
    return (int) w.len;
}

int hedera_build_transfer_body(const hedera_transfer_t *t, uint8_t *out, size_t out_len) {
    if (t == NULL || out == NULL || t->amount == 0) {
        return -1;
    }
    // A signed 64-bit delta has to hold the amount and its negation.
    if (t->amount > (uint64_t) INT64_MAX) {
        return -1;
    }

    uint8_t scratch[96];
    uint8_t inner[64];
    int n;

    // --- TransactionID: { validStart: Timestamp, accountID: payer } --------
    pb_t ts = {inner, sizeof(inner), 0};
    if (!pb_uint(&ts, F_TS_SECONDS, t->valid_start_sec) ||
        !pb_uint(&ts, F_TS_NANOS, t->valid_start_nanos)) {
        return -1;
    }

    pb_t txid = {scratch, sizeof(scratch), 0};
    if (!pb_submsg(&txid, F_TXID_START, inner, ts.len)) {
        return -1;
    }
    n = account_id(inner, sizeof(inner), t->fee_payer);
    if (n < 0 || !pb_submsg(&txid, F_TXID_ACCOUNT, inner, (size_t) n)) {
        return -1;
    }

    pb_t body = {out, out_len, 0};
    if (!pb_submsg(&body, F_BODY_TX_ID, scratch, txid.len)) {
        return -1;
    }

    // --- nodeAccountID, fee, validDuration --------------------------------
    n = account_id(inner, sizeof(inner), t->node);
    if (n < 0 || !pb_submsg(&body, F_BODY_NODE, inner, (size_t) n)) {
        return -1;
    }
    if (!pb_uint(&body, F_BODY_FEE, t->fee)) {
        return -1;
    }

    pb_t dur = {inner, sizeof(inner), 0};
    if (!pb_uint(&dur, F_DUR_SECONDS, t->valid_duration_sec) ||
        !pb_submsg(&body, F_BODY_DURATION, inner, dur.len)) {
        return -1;
    }

    // --- cryptoTransfer: two legs that sum to zero ------------------------
    pb_t legs = {scratch, sizeof(scratch), 0};
    n = account_amount(inner, sizeof(inner), t->from, -(int64_t) t->amount);
    if (n < 0 || !pb_submsg(&legs, F_TL_AMOUNTS, inner, (size_t) n)) {
        return -1;
    }
    n = account_amount(inner, sizeof(inner), t->payee, (int64_t) t->amount);
    if (n < 0 || !pb_submsg(&legs, F_TL_AMOUNTS, inner, (size_t) n)) {
        return -1;
    }

    // TransferList wraps the legs, CryptoTransferTransactionBody wraps that.
    pb_t list = {inner, sizeof(inner), 0};
    if (!pb_submsg(&list, F_CT_TRANSFERS, scratch, legs.len)) {
        return -1;
    }
    if (!pb_submsg(&body, F_BODY_CRYPTO_TRANSFER, inner, list.len)) {
        return -1;
    }

    return (int) body.len;
}
