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
        case MANDATE_ERR_SERVICE:
            return SW_VELA_SERVICE;
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
    uint8_t out[1 + AGENT_ID_LEN + 8 * 5 + 4 + 4] = {0};
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
    mandate_t m;
    memset(&m, 0, sizeof(m));

    if (!buffer_move(cdata, m.agent_id, AGENT_ID_LEN) ||       //
        !buffer_read_u8(cdata, &m.n_services)) {
        return io_send_sw(SW_VELA_ARGS);
    }
    if (m.n_services == 0 || m.n_services > MANDATE_MAX_SERVICES) {
        return io_send_sw(SW_VELA_ARGS);
    }
    for (uint8_t i = 0; i < m.n_services; i++) {
        if (!buffer_move(cdata, m.services[i], SERVICE_ID_LEN)) {
            return io_send_sw(SW_VELA_ARGS);
        }
    }
    if (!buffer_read_u64(cdata, &m.budget_total, BE) ||   //
        !buffer_read_u64(cdata, &m.per_call_max, BE) ||   //
        !buffer_read_u32(cdata, &m.expiry, BE)) {
        return io_send_sw(SW_VELA_ARGS);
    }
    if (m.budget_total == 0 || m.per_call_max == 0 || m.per_call_max > m.budget_total) {
        return io_send_sw(SW_VELA_ARGS);
    }

    // Park it in RAM. It reaches NVRAM only if the user taps.
    memcpy(&G_context.pending_mandate, &m, sizeof(m));
    explicit_bzero(&m, sizeof(m));

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
    uint8_t service_id[SERVICE_ID_LEN] = {0};
    uint64_t amount = 0;
    uint32_t now = 0;

    if (!buffer_read_u8(cdata, &id) ||                          //
        !buffer_move(cdata, service_id, SERVICE_ID_LEN) ||       //
        !buffer_read_u64(cdata, &amount, BE) ||                  //
        !buffer_read_u32(cdata, &now, BE)) {
        return io_send_sw(SW_VELA_ARGS);
    }

    uint32_t seq = 0;
    mandate_status_t st = mandate_authorize(id, service_id, amount, now, &seq);
    if (st != MANDATE_OK) {
        PRINTF("VELA: draw refused on mandate %d, code %d\n", id, st);
        return io_send_sw(sw_for(st));
    }

    // seq (4) || available after the reservation (8)
    uint8_t out[12] = {0};
    write_u32_be(out, 0, seq);
    write_u64_be(out, 4, mandate_available(id));

    return io_send_response_pointer(out, sizeof(out), SWO_SUCCESS);
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
    uint8_t out[16] = {0};
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
