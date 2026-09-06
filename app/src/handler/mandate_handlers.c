/*****************************************************************************
 *   Vela — APDU handlers for the mandate surface.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *****************************************************************************/

#include <string.h>

#include "os.h"
#include "io.h"
#include "buffer.h"
#include "write.h"

#include "mandate_handlers.h"
#include "globals.h"
#include "sw.h"
#include "display.h"
#include "menu.h"
#include "mandate/mandate.h"
#include "hedera/tx.h"
#include "hedera/sign.h"

/**
 * Read exactly `n` bytes and advance.
 *
 * Not buffer_move(): despite its signature, that one copies the *entire*
 * remaining buffer and fails when more bytes follow than the destination
 * holds. It suits a payload whose last field is the rest of the message,
 * which is how the boilerplate uses it, but not a multi-field one like
 * ours, where it refuses on the very first field.
 */
static bool read_bytes(buffer_t *b, uint8_t *out, size_t n) {
    if (!buffer_can_read(b, n)) {
        return false;
    }
    memmove(out, b->ptr + b->offset, n);
    return buffer_seek_cur(b, n);
}

/** Map a policy verdict onto the status word the host will see. */
static uint16_t sw_for(mandate_status_t st) {
    switch (st) {
        case MANDATE_OK:
            return SWO_SUCCESS;
        case MANDATE_ERR_NO_SLOT:
            return SW_VELA_NO_SLOT;
        case MANDATE_ERR_NOT_FOUND:
            return SW_VELA_NOT_FOUND;
        case MANDATE_ERR_EXPIRED:
            return SW_VELA_EXPIRED;
        case MANDATE_ERR_PAYEE:
            return SW_VELA_PAYEE;
        case MANDATE_ERR_PER_CALL:
            return SW_VELA_PER_CALL;
        case MANDATE_ERR_BUDGET:
            return SW_VELA_BUDGET;
        case MANDATE_ERR_SETTLE_AMOUNT:
            return SW_VELA_SETTLE_AMOUNT;
        default:
            return SW_VELA_ARGS;
    }
}

int handler_get_mandate(uint8_t id) {
    const mandate_t *m = mandate_get(id);
    if (m == NULL) {
        return io_send_sw(SW_VELA_ARGS);
    }
    if (m->in_use == MANDATE_SLOT_FREE) {
        return io_send_sw(SW_VELA_NOT_FOUND);
    }

    // in_use (1) || agent_id (20) || budget (8) || reserved (8) || spent (8)
    // || per_call_max (8) || available (8) || expiry (4) || seq (4)
    //
    // Static, not stack. io_send_response_pointer keeps the pointer rather
    // than copying, so a buffer that dies with this frame is read after it
    // is gone — the host sees one stale byte and a success status, which
    // looks like a protocol mismatch rather than a dangling pointer.
    static uint8_t out[1 + AGENT_ID_LEN + 8 * 5 + 4 + 4];
    memset(out, 0, sizeof(out));
    size_t off = 0;

    out[off++] = m->in_use;
    memcpy(out + off, m->agent_id, AGENT_ID_LEN);
    off += AGENT_ID_LEN;

    write_u64_be(out, off, m->budget_total);
    off += 8;
    write_u64_be(out, off, m->reserved);
    off += 8;
    write_u64_be(out, off, m->spent);
    off += 8;
    write_u64_be(out, off, m->per_call_max);
    off += 8;
    write_u64_be(out, off, mandate_available(id));
    off += 8;
    write_u32_be(out, off, m->expiry);
    off += 4;
    write_u32_be(out, off, m->seq);
    off += 4;

    return io_send_response_pointer(out, off, SWO_SUCCESS);
}

int handler_create_mandate(buffer_t *cdata) {
    // Parse straight into the pending slot rather than a local. A mandate_t
    // is 96 bytes, and this frame is still live when NBGL is called — enough,
    // on the physical device, to take the app down. Speculos tolerated it,
    // which is exactly the kind of divergence that costs an evening.
    mandate_t *m = &G_context.pending_mandate;
    memset(m, 0, sizeof(*m));

    if (!read_bytes(cdata, m->agent_id, AGENT_ID_LEN)) {
        return io_send_sw(SW_VELA_ARGS);
    }
    if (!buffer_read_u8(cdata, &m->n_payees)) {
        return io_send_sw(SW_VELA_ARGS);
    }
    if (m->n_payees == 0 || m->n_payees > MANDATE_MAX_PAYEES) {
        return io_send_sw(SW_VELA_ARGS);
    }
    for (uint8_t i = 0; i < m->n_payees; i++) {
        if (!buffer_read_u64(cdata, &m->payees[i], BE)) {
            return io_send_sw(SW_VELA_ARGS);
        }
    }
    if (!buffer_read_u64(cdata, &m->budget_total, BE)) {
        return io_send_sw(SW_VELA_ARGS);
    }
    if (!buffer_read_u64(cdata, &m->per_call_max, BE)) {
        return io_send_sw(SW_VELA_ARGS);
    }
    if (!buffer_read_u32(cdata, &m->expiry, BE)) {
        return io_send_sw(SW_VELA_ARGS);
    }
    if (m->budget_total == 0 || m->per_call_max == 0 ||
        m->per_call_max > m->budget_total) {
        return io_send_sw(SW_VELA_ARGS);
    }

    // It reaches NVRAM only if the user taps.
    return ui_display_create_mandate();
}

void validate_create_mandate(bool approved) {
    if (!approved) {
        explicit_bzero(&G_context.pending_mandate, sizeof(G_context.pending_mandate));
        io_send_sw(SWO_CONDITIONS_NOT_SATISFIED);
        return;
    }

    uint8_t id = 0;
    mandate_status_t st = mandate_create(&G_context.pending_mandate, &id);
    explicit_bzero(&G_context.pending_mandate, sizeof(G_context.pending_mandate));

    if (st != MANDATE_OK) {
        io_send_sw(sw_for(st));
        return;
    }
    io_send_response_pointer(&id, 1, SWO_SUCCESS);
}

int handler_authorize_spend(buffer_t *cdata) {
    uint8_t id = 0;
    hedera_transfer_t t = {0};
    uint32_t now = 0;

    if (!buffer_read_u8(cdata, &id) ||                        //
        !buffer_read_u64(cdata, &t.fee_payer, BE) ||          //
        !buffer_read_u64(cdata, &t.from, BE) ||               //
        !buffer_read_u64(cdata, &t.payee, BE) ||              //
        !buffer_read_u64(cdata, &t.node, BE) ||               //
        !buffer_read_u64(cdata, &t.amount, BE) ||             //
        !buffer_read_u64(cdata, &t.fee, BE) ||                //
        !buffer_read_u64(cdata, &t.valid_start_sec, BE) ||    //
        !buffer_read_u32(cdata, &t.valid_start_nanos, BE) ||  //
        !buffer_read_u32(cdata, &t.valid_duration_sec, BE) || //
        !buffer_read_u32(cdata, &now, BE)) {
        return io_send_sw(SW_VELA_ARGS);
    }

    // The payee checked here is the same value that goes into the body two
    // lines down. The host does not get to name one account and have another
    // one paid.
    uint32_t seq = 0;
    mandate_status_t st = mandate_authorize(id, t.payee, t.amount, now, &seq);
    if (st != MANDATE_OK) {
        PRINTF("VELA: draw refused on mandate %d, code %d\n", id, st);
        return io_send_sw(sw_for(st));
    }

    // Static, like the response buffer below. Ed25519 signing needs a lot of
    // stack of its own, and a couple of hundred bytes of locals still live in
    // this frame when it is called — enough to take the app down.
    static uint8_t body[HEDERA_BODY_MAX];
    int body_len = hedera_build_transfer_body(&t, body, sizeof(body));
    if (body_len <= 0) {
        return io_send_sw(SW_VELA_ARGS);
    }

    static uint8_t sig[HEDERA_SIG_LEN];
    if (!hedera_sign_body(0, body, (size_t) body_len, sig)) {
        return io_send_sw(SWO_SECURITY_ISSUE);
    }

    // seq (4) || available (8) || body_len (1) || body || signature (64)
    //
    // The body travels back with the signature because the host must submit
    // exactly these bytes. It never built them and cannot alter them without
    // the signature ceasing to match.
    //
    // Static, not stack: a couple of hundred bytes of locals is enough to
    // trip the stack protector here, which surfaces as EXCEPTION_OVERFLOW
    // (0x5303) from a handler that looks perfectly innocent.
    static uint8_t out[4 + 8 + 1 + HEDERA_BODY_MAX + HEDERA_SIG_LEN];
    memset(out, 0, sizeof(out));
    size_t off = 0;
    write_u32_be(out, off, seq);
    off += 4;
    write_u64_be(out, off, mandate_available(id));
    off += 8;
    out[off++] = (uint8_t) body_len;
    memcpy(out + off, body, (size_t) body_len);
    off += (size_t) body_len;
    memcpy(out + off, sig, HEDERA_SIG_LEN);
    off += HEDERA_SIG_LEN;

    return io_send_response_pointer(out, off, SWO_SUCCESS);
}

int handler_settle_confirm(buffer_t *cdata) {
    uint8_t id = 0;
    uint64_t quoted = 0;
    uint64_t actual = 0;

    if (!buffer_read_u8(cdata, &id) ||             //
        !buffer_read_u64(cdata, &quoted, BE) ||    //
        !buffer_read_u64(cdata, &actual, BE)) {
        return io_send_sw(SW_VELA_ARGS);
    }

    mandate_status_t st = mandate_settle(id, quoted, actual);
    if (st != MANDATE_OK) {
        return io_send_sw(sw_for(st));
    }

    const mandate_t *m = mandate_get(id);
    static uint8_t out[16];
    memset(out, 0, sizeof(out));
    write_u64_be(out, 0, m->spent);
    write_u64_be(out, 8, mandate_available(id));

    return io_send_response_pointer(out, sizeof(out), SWO_SUCCESS);
}

int handler_revoke_mandate(buffer_t *cdata) {
    uint8_t id = 0;
    if (!buffer_read_u8(cdata, &id)) {
        return io_send_sw(SW_VELA_ARGS);
    }

    const mandate_t *m = mandate_get(id);
    if (m == NULL) {
        return io_send_sw(SW_VELA_ARGS);
    }
    if (m->in_use == MANDATE_SLOT_FREE) {
        return io_send_sw(SW_VELA_NOT_FOUND);
    }

    G_context.pending_revoke_id = id;
    return ui_display_revoke_mandate(id);
}

void validate_revoke_mandate(bool approved) {
    if (!approved) {
        io_send_sw(SWO_CONDITIONS_NOT_SATISFIED);
        return;
    }

    mandate_status_t st = mandate_revoke(G_context.pending_revoke_id);
    io_send_sw(sw_for(st));
}

int handler_get_pubkey(uint8_t index) {
    // Static, like every other response buffer here. io_send_response_pointer
    // keeps the pointer rather than copying it, so a buffer that dies with
    // this frame is read after it is gone — the reply looks plausible, and
    // the app falls over shortly afterwards.
    static uint8_t pk[HEDERA_PUBKEY_LEN];
    if (!hedera_pubkey(index, pk)) {
        return io_send_sw(SWO_SECURITY_ISSUE);
    }
    return io_send_response_pointer(pk, sizeof(pk), SWO_SUCCESS);
}
