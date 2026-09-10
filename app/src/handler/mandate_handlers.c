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
/// The last contract-call body, kept between AUTHORIZE_CALL and GET_LAST_BODY.
static uint8_t g_call_body[HEDERA_CALL_BODY_MAX];
/// Whether the mandate awaiting a tap is a restore rather than a fresh grant.
/// Cleared on every exit from validate_create_mandate, approved or not: a flag
/// that survives a rejection would make the next grant a silent restore.
static bool g_pending_restore;
static uint16_t g_last_body_len;

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
        case MANDATE_ERR_CONTRACT:
            return SW_VELA_CONTRACT;
        case MANDATE_ERR_SELECTOR:
            return SW_VELA_SELECTOR;
        case MANDATE_ERR_RECIPIENT:
            return SW_VELA_RECIPIENT;
        case MANDATE_ERR_VELOCITY:
            return SW_VELA_VELOCITY;
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
    // || n_payees (1) || payees (8 each)
    //
    // The allowlist is appended last, so a host built against the earlier
    // fixed-size layout still reads every field it knew about at the same
    // offset. An agent cannot plan against a ceiling it cannot see, and it
    // cannot reconstruct the envelope's digest without the payees — so the
    // chip publishes them rather than making the host keep a second copy
    // that could disagree.
    //
    // Static, not stack. io_send_response_pointer keeps the pointer rather
    // than copying, so a buffer that dies with this frame is read after it
    // is gone — the host sees one stale byte and a success status, which
    // looks like a protocol mismatch rather than a dangling pointer.
    static uint8_t out[1 + AGENT_ID_LEN + 8 * 5 + 4 + 4 + 1 + 8 * MANDATE_MAX_PAYEES +
                      1 + 8 * MANDATE_MAX_CONTRACTS + 1 + 4 * MANDATE_MAX_SELECTORS + 1 +
                      1 + MANDATE_LABEL_LEN];
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

    out[off++] = m->n_payees;
    for (uint8_t i = 0; i < m->n_payees && i < MANDATE_MAX_PAYEES; i++) {
        write_u64_be(out, off, m->payees[i]);
        off += 8;
    }

    // Contract terms, appended after the payees for the same reason the
    // payees were appended after seq: a reader built against the earlier
    // layout finds every field it knows at the offset it expects.
    //
    // An agent cannot plan against a boundary it cannot see, and a human
    // cannot audit one either. The chip is the only place these are true,
    // so it is the only honest place to read them from.
    out[off++] = m->n_contracts;
    for (uint8_t i = 0; i < m->n_contracts && i < MANDATE_MAX_CONTRACTS; i++) {
        write_u64_be(out, off, m->contracts[i]);
        off += 8;
    }
    out[off++] = m->n_selectors;
    for (uint8_t i = 0; i < m->n_selectors && i < MANDATE_MAX_SELECTORS; i++) {
        write_u32_be(out, off, m->selectors[i]);
        off += 4;
    }
    out[off++] = m->recipient_arg;

    // The label last, length-prefixed, so a reader built against any earlier
    // layout finds every field it knew where it expects it.
    uint8_t n_label = (uint8_t) strnlen(m->label, MANDATE_LABEL_LEN - 1);
    out[off++] = n_label;
    memcpy(out + off, m->label, n_label);
    off += n_label;

    return io_send_response_pointer(out, off, SWO_SUCCESS);
}

/**
 * Grant an envelope, or put one back after a device is replaced.
 *
 * `restore` reads two extra fields — the sequence number and the amount
 * already spent — and the screen says so. Same terms, different question:
 * granting asks whether an agent may have 0.5 HBAR, restoring asks whether
 * it had already spent 0.38 of it.
 *
 * The chip cannot check that position itself, and pretending otherwise would
 * be the dangerous version of this feature. It could verify a signature it
 * made over the last draw — and that would prove nothing, because this chip
 * will sign whatever it is handed, including a record fabricated a second
 * ago. Ed25519 over your own key is not evidence to yourself.
 *
 * What can check it is the audit log, which is public, and the person holding
 * the device, who is standing there anyway because they are restoring it. So
 * the position is shown on the trusted display in the same units the log
 * publishes, and `node hedera/recover.mjs` reads it off the mirror node so
 * nobody has to remember a number. The trust model is exactly the grant path:
 * a human reads a screen and taps.
 */
static int handler_create_or_restore(buffer_t *cdata, bool restore);

int handler_create_mandate(buffer_t *cdata) {
    return handler_create_or_restore(cdata, false);
}

int handler_restore_mandate(buffer_t *cdata) {
    return handler_create_or_restore(cdata, true);
}

static int handler_create_or_restore(buffer_t *cdata, bool restore) {
    // Set before anything can fail, so a rejected parse cannot leave the flag
    // reading true for whatever arrives next.
    g_pending_restore = restore;

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

    // --- label, optional --------------------------------------------------
    //
    // Read before the contract terms because it is the field most callers
    // will set and fewest will omit. Absent means the screen falls back to
    // the slot number, which is honest but useless for telling two agents
    // apart — so the default is derived from the agent id rather than left
    // blank.
    uint8_t label_len = 0;
    if (buffer_can_read(cdata, 1)) {
        if (!buffer_read_u8(cdata, &label_len) || label_len >= MANDATE_LABEL_LEN) {
            return io_send_sw(SW_VELA_ARGS);
        }
        if (label_len > 0 && !read_bytes(cdata, (uint8_t *) m->label, label_len)) {
            return io_send_sw(SW_VELA_ARGS);
        }
        m->label[label_len] = '\0';
        // Anything that is not plain printable ASCII is refused rather than
        // rendered. A label is shown on a trusted display, and a trusted
        // display that renders whatever it is handed is not one.
        for (uint8_t i = 0; i < label_len; i++) {
            if (m->label[i] < 0x20 || m->label[i] > 0x7e) {
                return io_send_sw(SW_VELA_ARGS);
            }
        }
    }
    if (m->label[0] == '\0') {
        snprintf(m->label, MANDATE_LABEL_LEN, "agent %02x%02x",
                 m->agent_id[0], m->agent_id[1]);
    }

    // --- contract terms, optional -----------------------------------------
    //
    // Absent means this envelope allows transfers only, which is what every
    // mandate written before this layout existed meant. Present means the
    // agent may also call contracts — and then the recipient argument is not
    // optional, because a contract allowlist without it permits any of those
    // contracts to send the proceeds anywhere.
    m->recipient_arg = MANDATE_ARG_NONE;
    if (buffer_can_read(cdata, 1)) {
        if (!buffer_read_u8(cdata, &m->n_contracts) ||
            m->n_contracts > MANDATE_MAX_CONTRACTS) {
            return io_send_sw(SW_VELA_ARGS);
        }
        for (uint8_t i = 0; i < m->n_contracts; i++) {
            if (!buffer_read_u64(cdata, &m->contracts[i], BE)) {
                return io_send_sw(SW_VELA_ARGS);
            }
        }
        if (!buffer_read_u8(cdata, &m->n_selectors) ||
            m->n_selectors > MANDATE_MAX_SELECTORS) {
            return io_send_sw(SW_VELA_ARGS);
        }
        for (uint8_t i = 0; i < m->n_selectors; i++) {
            if (!buffer_read_u32(cdata, &m->selectors[i], BE)) {
                return io_send_sw(SW_VELA_ARGS);
            }
        }
        if (!buffer_read_u8(cdata, &m->recipient_arg)) {
            return io_send_sw(SW_VELA_ARGS);
        }
        if (m->n_contracts > 0) {
            if (m->n_selectors == 0 || m->recipient_arg == MANDATE_ARG_NONE) {
                return io_send_sw(SW_VELA_ARGS);
            }
        }
    }

    // --- velocity, optional -----------------------------------------------
    //
    // Read after the contract terms and before the restore position, so every
    // earlier layout still parses byte for byte. Absent means no rate limit,
    // which is what every mandate written before this field meant.
    // On a restore it is not optional, and that is a parsing rule rather than
    // a policy one: the position follows immediately, so "absent" and "six
    // bytes of sequence number" would be the same bytes. A restore always
    // carries the block, zeroed when there is no limit.
    if (restore || buffer_can_read(cdata, 1)) {
        if (!buffer_read_u32(cdata, &m->window_secs, BE) ||
            !buffer_read_u16(cdata, &m->max_per_window, BE)) {
            return io_send_sw(SW_VELA_ARGS);
        }
        // Half a limit is not a limit, and a window of zero seconds would
        // reset on every draw. Either both are set or neither is.
        if ((m->window_secs == 0) != (m->max_per_window == 0)) {
            return io_send_sw(SW_VELA_ARGS);
        }
    }

    // --- the position, on a restore only ----------------------------------
    //
    // Read last so the terms parse identically either way: a restore is a
    // grant that also says where the counter had got to.
    if (restore) {
        if (!buffer_read_u32(cdata, &m->seq, BE) ||
            !buffer_read_u64(cdata, &m->spent, BE)) {
            return io_send_sw(SW_VELA_ARGS);
        }
        // A restore that claims more spent than the envelope ever held is
        // not a restore of anything this device could have issued.
        if (m->spent > m->budget_total) {
            return io_send_sw(SW_VELA_ARGS);
        }
    }

    // It reaches NVRAM only if the user taps.
    return ui_display_create_mandate(restore);
}

void validate_create_mandate(bool approved) {
    if (!approved) {
        g_pending_restore = false;
        explicit_bzero(&G_context.pending_mandate, sizeof(G_context.pending_mandate));
        io_send_sw(SWO_CONDITIONS_NOT_SATISFIED);
        return;
    }

    uint8_t id = 0;
    const bool restore = g_pending_restore;
    g_pending_restore = false;
    mandate_status_t st = restore ? mandate_restore(&G_context.pending_mandate, &id)
                                  : mandate_create(&G_context.pending_mandate, &id);
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

    // The chip's own statement about this draw, so the public log is not
    // something the host asserts about the chip. Built from values the chip
    // holds, never from the request.
    //
    //   mandate_id (1) || seq (4) || payee (8) || amount (8) || remaining (8)
    static uint8_t anchor[29];
    anchor[0] = id;
    write_u32_be(anchor, 1, seq);
    write_u64_be(anchor, 5, t.payee);
    write_u64_be(anchor, 13, t.amount);
    write_u64_be(anchor, 21, mandate_available(id));

    static uint8_t anchor_sig[HEDERA_SIG_LEN];
    if (!hedera_sign_anchor(0, anchor, sizeof(anchor), anchor_sig)) {
        return io_send_sw(SWO_SECURITY_ISSUE);
    }

    // seq (4) || available (8) || body_len (1) || body || signature (64)
    //         || anchor (29) || anchor signature (64)
    //
    // The body travels back with the signature because the host must submit
    // exactly these bytes. It never built them and cannot alter them without
    // the signature ceasing to match.
    //
    // Static, not stack: a couple of hundred bytes of locals is enough to
    // trip the stack protector here, which surfaces as EXCEPTION_OVERFLOW
    // (0x5303) from a handler that looks perfectly innocent.
    static uint8_t out[4 + 8 + 1 + HEDERA_BODY_MAX + HEDERA_SIG_LEN + 29 + HEDERA_SIG_LEN];
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
    memcpy(out + off, anchor, sizeof(anchor));
    off += sizeof(anchor);
    memcpy(out + off, anchor_sig, HEDERA_SIG_LEN);
    off += HEDERA_SIG_LEN;

    return io_send_response_pointer(out, off, SWO_SUCCESS);
}

/**
 * Authorise a contract call.
 *
 * The transfer handler above checks a payee the protobuf will name. This one
 * checks a payee the protobuf will *not* name: a call's value goes wherever
 * its arguments say, so the mandate reads the calldata and binds the address
 * argument to this device's own account before anything is signed.
 *
 * That is the whole difference, and it is the point of the feature. An agent
 * under prompt injection reaches for the recipient parameter, because it is
 * the only field that turns a legitimate-looking swap into a theft. The chip
 * will encode the call, the contract, the function and the amount the agent
 * asked for — and refuse the one thing that would let the proceeds leave.
 */
int handler_authorize_call(buffer_t *cdata) {
    uint8_t id = 0;
    hedera_call_t c = {0};
    uint32_t now = 0;
    uint16_t calldata_len = 0;

    // The calldata is copied out of the APDU buffer rather than pointed into
    // it: io_send_response_pointer keeps a pointer, and the request buffer is
    // reused before the response is transmitted.
    static uint8_t calldata[HEDERA_CALLDATA_MAX];

    if (!buffer_read_u8(cdata, &id) ||                        //
        !buffer_read_u64(cdata, &c.fee_payer, BE) ||          //
        !buffer_read_u64(cdata, &c.from, BE) ||               //
        !buffer_read_u64(cdata, &c.contract, BE) ||           //
        !buffer_read_u64(cdata, &c.node, BE) ||               //
        !buffer_read_u64(cdata, &c.amount, BE) ||             //
        !buffer_read_u64(cdata, &c.fee, BE) ||                //
        !buffer_read_u64(cdata, &c.gas, BE) ||                //
        !buffer_read_u64(cdata, &c.valid_start_sec, BE) ||    //
        !buffer_read_u32(cdata, &c.valid_start_nanos, BE) ||  //
        !buffer_read_u32(cdata, &c.valid_duration_sec, BE) || //
        !buffer_read_u32(cdata, &now, BE)) {
        return io_send_sw(SW_VELA_ARGS);
    }

    uint8_t hi = 0, lo = 0;
    if (!buffer_read_u8(cdata, &hi) || !buffer_read_u8(cdata, &lo)) {
        return io_send_sw(SW_VELA_ARGS);
    }
    calldata_len = (uint16_t) ((hi << 8) | lo);
    if (calldata_len < 4 || calldata_len > HEDERA_CALLDATA_MAX) {
        return io_send_sw(SW_VELA_ARGS);
    }
    if (!read_bytes(cdata, calldata, calldata_len)) {
        return io_send_sw(SW_VELA_ARGS);
    }
    c.calldata = calldata;
    c.calldata_len = calldata_len;

    // `c.from` is what the host claims this device controls. The mandate is
    // given that value to bind the recipient against, and the signature will
    // only be accepted by Hedera if it really is this device's account — so a
    // host that lies here produces a transaction nobody can submit.
    uint32_t seq = 0;
    mandate_status_t st = mandate_authorize_call(id, c.contract, c.from, calldata,
                                                 calldata_len, c.amount, now, &seq);
    if (st != MANDATE_OK) {
        PRINTF("VELA: call refused on mandate %d, code %d\n", id, st);
        return io_send_sw(sw_for(st));
    }

    int body_len = hedera_encode_call(&c, g_call_body, sizeof(g_call_body));
    if (body_len <= 0) {
        return io_send_sw(SW_VELA_ARGS);
    }

    static uint8_t sig[HEDERA_SIG_LEN];
    if (!hedera_sign_body(0, g_call_body, (size_t) body_len, sig)) {
        return io_send_sw(SWO_SECURITY_ISSUE);
    }

    // The contract stands where the payee stands for a transfer: it is what
    // the chip agreed to hand value to. The recipient is not in the anchor
    // because the chip already refused to sign any recipient but its own —
    // recording it would be recording a constant.
    static uint8_t anchor[29];
    anchor[0] = id;
    write_u32_be(anchor, 1, seq);
    write_u64_be(anchor, 5, c.contract);
    write_u64_be(anchor, 13, c.amount);
    write_u64_be(anchor, 21, mandate_available(id));

    static uint8_t anchor_sig[HEDERA_SIG_LEN];
    if (!hedera_sign_anchor(0, anchor, sizeof(anchor), anchor_sig)) {
        return io_send_sw(SWO_SECURITY_ISSUE);
    }

    // The body does not travel with this response, and that is not a design
    // preference.
    //
    // Flex gives an app a 272-byte APDU buffer. Sequence, balance, a call
    // body, its signature and the chip's anchor statement with its own
    // signature come to well over three hundred, and the app-side Makefile
    // knob for raising it — DISABLE_DEFAULT_IO_SEPROXY_BUFFER_SIZE — is no
    // longer read by the SDK. Setting it changes nothing, the oversized
    // response overruns the buffer, and the application dies with no status
    // word at all. Written up as finding 12 in docs/FEEDBACK-LEDGER.md.
    //
    // So the body is kept here and fetched with VELA_GET_LAST_BODY. The host
    // holds a signature for bytes it has not seen yet for exactly one round
    // trip, which costs nothing: the signature is over those bytes, so a body
    // that does not match is a body that will not verify.
    g_last_body_len = (uint16_t) body_len;

    // seq (4) || available (8) || body_len (2) || signature (64)
    //         || anchor (29) || anchor signature (64)   = 171 bytes
    static uint8_t out[4 + 8 + 2 + HEDERA_SIG_LEN + 29 + HEDERA_SIG_LEN];
    memset(out, 0, sizeof(out));
    size_t off = 0;
    write_u32_be(out, off, seq);
    off += 4;
    write_u64_be(out, off, mandate_available(id));
    off += 8;
    out[off++] = (uint8_t) ((body_len >> 8) & 0xFF);
    out[off++] = (uint8_t) (body_len & 0xFF);
    memcpy(out + off, sig, HEDERA_SIG_LEN);
    off += HEDERA_SIG_LEN;
    memcpy(out + off, anchor, sizeof(anchor));
    off += sizeof(anchor);
    memcpy(out + off, anchor_sig, HEDERA_SIG_LEN);
    off += HEDERA_SIG_LEN;

    return io_send_response_pointer(out, off, SWO_SUCCESS);
}

/**
 * The body of the last call this chip signed.
 *
 * Empty until a call has been authorised, and overwritten by the next one.
 * Nothing is protected by keeping it: the body is public the moment it is
 * submitted, and it is worthless without the signature that came back with
 * the authorisation.
 */
int handler_get_last_body(void) {
    if (g_last_body_len == 0) {
        return io_send_sw(SW_VELA_NOT_FOUND);
    }
    return io_send_response_pointer(g_call_body, g_last_body_len, SWO_SUCCESS);
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
