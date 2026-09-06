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

// ContractCall. The body's oneof puts it at 7, well before cryptoTransfer's
// 14 — different wire tags entirely, so a call can never be mistaken for a
// transfer by a node, nor by a verifier reading back what was signed.
#define F_BODY_CONTRACT_CALL 7
#define F_CC_CONTRACT_ID 1
#define F_CC_GAS 2
#define F_CC_AMOUNT 3
#define F_CC_PARAMS 4
// ContractID.contractNum shares field 3 with AccountID.accountNum, so
// account_id() serialises both.
#define F_CONTRACT_NUM 3

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

/** Bytes a varint occupies, so a sub-message length can be known before writing. */
static size_t varint_len(uint64_t v) {
    size_t n = 1;
    while (v >= 0x80) {
        v >>= 7;
        n++;
    }
    return n;
}

/** Bytes pb_uint would write. Zero writes nothing, as proto3 omits defaults. */
static size_t uint_len(uint32_t field, uint64_t v) {
    return v == 0 ? 0 : varint_len(((uint64_t) field << 3) | WIRE_VARINT) + varint_len(v);
}

int hedera_encode_call(const hedera_call_t *c, uint8_t *out, size_t out_len) {
    if (c == NULL || out == NULL || c->calldata == NULL) {
        return -1;
    }
    if (c->calldata_len < 4 || c->calldata_len > HEDERA_CALLDATA_MAX) {
        return -1;
    }
    if (c->amount > (uint64_t) INT64_MAX) {
        return -1;
    }

    // Small stack buffers only, as the transfer encoder does.
    //
    // The first version staged the ContractCall in a 224-byte scratch array
    // so it could be measured before being framed. That array, plus the body
    // buffer the response needs, pushed the app's static data into the stack
    // and the application faulted on a write that had succeeded moments
    // earlier — which reads as memory corruption and sends you looking at the
    // wrong code entirely.
    //
    // A length-prefixed sub-message does not need staging: its length is
    // computable from the parts. So the parts are measured, the frame is
    // written, and each part goes straight into the output.
    uint8_t inner[64];
    int n;

    // --- TransactionID ----------------------------------------------------
    pb_t ts = {inner, sizeof(inner), 0};
    if (!pb_uint(&ts, F_TS_SECONDS, c->valid_start_sec) ||
        !pb_uint(&ts, F_TS_NANOS, c->valid_start_nanos)) {
        return -1;
    }

    uint8_t txbuf[48];
    pb_t txid = {txbuf, sizeof(txbuf), 0};
    if (!pb_submsg(&txid, F_TXID_START, inner, ts.len)) {
        return -1;
    }
    n = account_id(inner, sizeof(inner), c->fee_payer);
    if (n < 0 || !pb_submsg(&txid, F_TXID_ACCOUNT, inner, (size_t) n)) {
        return -1;
    }

    pb_t body = {out, out_len, 0};
    if (!pb_submsg(&body, F_BODY_TX_ID, txbuf, txid.len)) {
        return -1;
    }

    // --- nodeAccountID, fee, validDuration --------------------------------
    n = account_id(inner, sizeof(inner), c->node);
    if (n < 0 || !pb_submsg(&body, F_BODY_NODE, inner, (size_t) n)) {
        return -1;
    }
    if (!pb_uint(&body, F_BODY_FEE, c->fee)) {
        return -1;
    }
    pb_t dur = {inner, sizeof(inner), 0};
    if (!pb_uint(&dur, F_DUR_SECONDS, c->valid_duration_sec) ||
        !pb_submsg(&body, F_BODY_DURATION, inner, dur.len)) {
        return -1;
    }

    // --- contractCall, measured then streamed -----------------------------
    uint8_t cid[24];
    int cid_len = account_id(cid, sizeof(cid), c->contract);  // ContractID.contractNum
    if (cid_len < 0) {
        return -1;
    }

    size_t call_len = varint_len(((uint64_t) F_CC_CONTRACT_ID << 3) | WIRE_LEN) +
                      varint_len((uint64_t) cid_len) + (size_t) cid_len +
                      uint_len(F_CC_GAS, c->gas) +
                      uint_len(F_CC_AMOUNT, c->amount) +
                      varint_len(((uint64_t) F_CC_PARAMS << 3) | WIRE_LEN) +
                      varint_len(c->calldata_len) + c->calldata_len;

    if (!pb_tag(&body, F_BODY_CONTRACT_CALL, WIRE_LEN) ||
        !pb_varint(&body, call_len)) {
        return -1;
    }
    size_t call_start = body.len;

    if (!pb_submsg(&body, F_CC_CONTRACT_ID, cid, (size_t) cid_len) ||
        !pb_uint(&body, F_CC_GAS, c->gas) ||
        !pb_uint(&body, F_CC_AMOUNT, c->amount) ||
        !pb_tag(&body, F_CC_PARAMS, WIRE_LEN) ||
        !pb_varint(&body, c->calldata_len)) {
        return -1;
    }
    // Byte for byte. Every claim about where this call sends value was made
    // by mandate_authorize_call() reading these same bytes; nothing here
    // re-interprets them.
    for (uint16_t i = 0; i < c->calldata_len; i++) {
        if (!pb_byte(&body, c->calldata[i])) {
            return -1;
        }
    }

    // The length was written before the contents. If they disagree the body
    // is malformed, and a malformed body that carries a valid signature is
    // worse than no body at all.
    if (body.len - call_start != call_len) {
        return -1;
    }
    return (int) body.len;
}
