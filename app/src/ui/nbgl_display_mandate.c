/*****************************************************************************
 *   Vela — the screens where a mandate is granted or killed.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *****************************************************************************/

#include <stdio.h>
#include <string.h>

#include "os.h"
#include "glyphs.h"
#include "nbgl_use_case.h"
#include "format.h"

#include "display.h"
#include "globals.h"
#include "sw.h"
#include "menu.h"
#include "mandate/mandate.h"
#include "handler/mandate_handlers.h"

#define HBAR_DECIMALS 8

// What the user actually reads before granting an envelope. These are the
// only bounds that will ever apply, and after this screen no software —
// including ours — can widen them.
static char g_agent[2 * AGENT_ID_LEN + 1];
static char g_budget[32];
static char g_per_call[32];
static char g_payees[80];
static char g_expiry[32];
static char g_contracts[96];
static char g_recipient[64];

static nbgl_contentTagValue_t pairs[7];
static nbgl_contentTagValueList_t pairList;

static char g_revoke_title[48];

static void create_choice(bool confirm) {
    validate_create_mandate(confirm);
    nbgl_useCaseReviewStatus(confirm ? STATUS_TYPE_OPERATION_SIGNED : STATUS_TYPE_OPERATION_REJECTED,
                             ui_menu_main);
}

static void revoke_choice(bool confirm) {
    validate_revoke_mandate(confirm);
    nbgl_useCaseReviewStatus(confirm ? STATUS_TYPE_OPERATION_SIGNED : STATUS_TYPE_OPERATION_REJECTED,
                             ui_menu_main);
}

int ui_display_create_mandate(void) {
    const mandate_t *m = &G_context.pending_mandate;

    explicit_bzero(g_agent, sizeof(g_agent));
    explicit_bzero(g_budget, sizeof(g_budget));
    explicit_bzero(g_per_call, sizeof(g_per_call));
    explicit_bzero(g_payees, sizeof(g_payees));
    explicit_bzero(g_expiry, sizeof(g_expiry));
    explicit_bzero(g_contracts, sizeof(g_contracts));
    explicit_bzero(g_recipient, sizeof(g_recipient));

    if (format_hex(m->agent_id, AGENT_ID_LEN, g_agent, sizeof(g_agent)) == -1) {
        return io_send_sw(SW_VELA_ARGS);
    }

    char amount[32] = {0};
    if (!format_fpu64_trimmed(amount, sizeof(amount), m->budget_total, HBAR_DECIMALS)) {
        return io_send_sw(SW_VELA_ARGS);
    }
    snprintf(g_budget, sizeof(g_budget), "%s HBAR", amount);

    if (!format_fpu64_trimmed(amount, sizeof(amount), m->per_call_max, HBAR_DECIMALS)) {
        return io_send_sw(SW_VELA_ARGS);
    }
    snprintf(g_per_call, sizeof(g_per_call), "%s HBAR", amount);

    // Spell the accounts out. "2 accounts allowed" tells the user nothing
    // they can check; the whole purpose of this screen is that they see
    // which accounts the agent will be able to pay.
    size_t off = 0;
    for (uint8_t i = 0; i < m->n_payees && i < MANDATE_MAX_PAYEES; i++) {
        int n = snprintf(g_payees + off,
                         sizeof(g_payees) - off,
                         "%s0.0.%u",
                         i ? "\n" : "",
                         (unsigned) m->payees[i]);
        if (n <= 0 || (size_t) n >= sizeof(g_payees) - off) {
            break;
        }
        off += (size_t) n;
    }

    if (m->expiry == 0) {
        snprintf(g_expiry, sizeof(g_expiry), "Never");
    } else {
        snprintf(g_expiry, sizeof(g_expiry), "unix %u", (unsigned) m->expiry);
    }

    // Contracts get the same treatment as payees: named, not counted. A user
    // approving "2 contracts allowed" has approved nothing they could check.
    size_t coff = 0;
    for (uint8_t i = 0; i < m->n_contracts && i < MANDATE_MAX_CONTRACTS; i++) {
        int n = snprintf(g_contracts + coff,
                         sizeof(g_contracts) - coff,
                         "%s0.0.%u",
                         i ? "\n" : "",
                         (unsigned) m->contracts[i]);
        if (n <= 0 || (size_t) n >= sizeof(g_contracts) - coff) {
            break;
        }
        coff += (size_t) n;
    }
    if (coff == 0) {
        snprintf(g_contracts, sizeof(g_contracts), "None");
    }

    // The sentence that matters most on this screen, so it is a sentence and
    // not a field name. "Argument 1 must equal self" is true and useless; the
    // user needs to know that whatever the agent trades, the proceeds cannot
    // leave this account.
    if (m->recipient_arg == MANDATE_ARG_NONE || m->n_contracts == 0) {
        snprintf(g_recipient, sizeof(g_recipient), "No contract calls");
    } else {
        snprintf(g_recipient, sizeof(g_recipient), "Only back to this account");
    }

    pairs[0].item = "Agent";
    pairs[0].value = g_agent;
    pairs[1].item = "Total budget";
    pairs[1].value = g_budget;
    pairs[2].item = "Max per draw";
    pairs[2].value = g_per_call;
    pairs[3].item = "May pay";
    pairs[3].value = g_payees;
    pairs[4].item = "May call";
    pairs[4].value = g_contracts;
    pairs[5].item = "Proceeds go";
    pairs[5].value = g_recipient;
    pairs[6].item = "Expires";
    pairs[6].value = g_expiry;

    pairList.nbMaxLinesForValue = 0;
    pairList.nbPairs = 7;
    pairList.pairs = pairs;
    pairList.wrapping = true;

    nbgl_useCaseReview(TYPE_OPERATION,
                       &pairList,
                       &ICON_APP_VELA,
                       "Grant a spending\nmandate",
                       NULL,
                       "Grant this mandate?\nThe agent will draw on it\nwithout asking again.",
                       create_choice);
    return 0;
}

int ui_display_revoke_mandate(uint8_t id) {
    snprintf(g_revoke_title, sizeof(g_revoke_title), "Revoke mandate %u?", (unsigned) id);

    nbgl_useCaseChoice(&ICON_APP_VELA,
                       g_revoke_title,
                       "The agent loses every\nremaining draw immediately.",
                       "Revoke",
                       "Cancel",
                       revoke_choice);
    return 0;
}
