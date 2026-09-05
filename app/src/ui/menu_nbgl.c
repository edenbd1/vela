/*****************************************************************************
 *   Vela — the on-device control panel.
 *
 *  Every other control in Vela is *requested* by the host: it sends an APDU,
 *  the chip answers. That leaves one gap. A fully compromised host cannot
 *  spend — it holds no key — but it can quietly drop your revoke command and
 *  let you believe an agent is dead when it is not.
 *
 *  This screen closes it. The mandate list is read from NVRAM and revoking
 *  happens here, on the device, with no host involvement at all. It is the
 *  one control a compromised host cannot intercept.
 *
 *  Derived from Ledger App Boilerplate, (c) 2020 Ledger SAS.
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
#include "os_nvm.h"
#include "os_helpers.h"
#include "format.h"

#include "globals.h"
#include "menu.h"
#include "display.h"
#include "mandate/mandate.h"

/** HBAR has 8 decimals: 1 HBAR = 100 000 000 tinybars. */
#define HBAR_DECIMALS 8

void app_quit(void) {
    os_sched_exit(-1);
}

// ---------------------------------------------------------------------------
// Tokens. One per mandate bar, plus the two destructive actions.
// ---------------------------------------------------------------------------
enum {
    MANDATE_BAR_TOKEN = FIRST_USER_TOKEN,  /// + slot index
    REVOKE_ALL_TOKEN = MANDATE_BAR_TOKEN + MANDATE_COUNT,
    REVOKE_ONE_TOKEN
};

#define BAR_COUNT (MANDATE_COUNT + 1)  /// one per slot, plus "Revoke all"
#define BAR_TEXT_LEN 40

static char bar_texts[BAR_COUNT][BAR_TEXT_LEN];
static const char *bar_text_ptrs[BAR_COUNT];
static uint8_t bar_tokens[BAR_COUNT];

// ---------------------------------------------------------------------------
// Detail page for one mandate.
// ---------------------------------------------------------------------------
#define DETAIL_ROWS 6
#define DETAIL_LABEL_LEN 14
#define DETAIL_VALUE_LEN 46

static char detail_labels[DETAIL_ROWS][DETAIL_LABEL_LEN];
static char detail_values[DETAIL_ROWS][DETAIL_VALUE_LEN];
static const char *detail_label_ptrs[DETAIL_ROWS];
static const char *detail_value_ptrs[DETAIL_ROWS];

static char detail_title[24];
static char confirm_title[48];
static uint8_t selected_slot;

static nbgl_content_t home_contents[1];
static nbgl_content_t detail_contents[2];

#define INFO_NB 2
static const char *const INFO_TYPES[INFO_NB] = {"Version", "Enforced in"};
static const char *const INFO_CONTENTS[INFO_NB] = {APPVERSION, "Secure Element"};
static const nbgl_contentInfoList_t infoList = {
    .nbInfos = INFO_NB,
    .infoTypes = INFO_TYPES,
    .infoContents = INFO_CONTENTS,
};

static const nbgl_genericContents_t homeGenericContents = {.callbackCallNeeded = false,
                                                           .contentsList = home_contents,
                                                           .nbContents = 1};
static const nbgl_genericContents_t detailGenericContents = {.callbackCallNeeded = false,
                                                             .contentsList = detail_contents,
                                                             .nbContents = 2};

static void home_controls(int token, uint8_t index, int page);
static void detail_controls(int token, uint8_t index, int page);
static void open_detail(uint8_t slot);

/** "4.2 of 10 HBAR left" for a live slot, "Free" otherwise. */
static void format_slot_summary(uint8_t id, char *out, size_t out_len) {
    const mandate_t *m = mandate_get(id);
    if (m == NULL || m->in_use == MANDATE_SLOT_FREE) {
        snprintf(out, out_len, "Mandate %u  -  Free", (unsigned) id);
        return;
    }

    char left[24] = {0};
    char total[24] = {0};
    if (!format_fpu64_trimmed(left, sizeof(left), mandate_available(id), HBAR_DECIMALS) ||
        !format_fpu64_trimmed(total, sizeof(total), m->budget_total, HBAR_DECIMALS)) {
        snprintf(out, out_len, "Mandate %u", (unsigned) id);
        return;
    }
    snprintf(out, out_len, "Mandate %u  -  %s/%s HBAR", (unsigned) id, left, total);
}

/**
 * Rebuild the bar list from NVRAM.
 *
 * Called on every return to the home screen, so what a judge reads on the
 * device is the counter as it stands, not a snapshot the host handed us.
 */
static void refresh_bars(void) {
    for (uint8_t i = 0; i < MANDATE_COUNT; i++) {
        format_slot_summary(i, bar_texts[i], BAR_TEXT_LEN);
        bar_text_ptrs[i] = bar_texts[i];
        bar_tokens[i] = MANDATE_BAR_TOKEN + i;
    }

    snprintf(bar_texts[MANDATE_COUNT], BAR_TEXT_LEN, "Revoke all mandates");
    bar_text_ptrs[MANDATE_COUNT] = bar_texts[MANDATE_COUNT];
    bar_tokens[MANDATE_COUNT] = REVOKE_ALL_TOKEN;

    home_contents[0].type = BARS_LIST;
    home_contents[0].content.barsList.barTexts = bar_text_ptrs;
    home_contents[0].content.barsList.tokens = bar_tokens;
    home_contents[0].content.barsList.nbBars = BAR_COUNT;
    home_contents[0].content.barsList.tuneId = NBGL_NO_TUNE;
    home_contents[0].contentActionCallback = home_controls;
}

/** Fill the detail rows for one slot. */
static void refresh_detail(uint8_t id) {
    const mandate_t *m = mandate_get(id);
    char amount[24] = {0};

    for (uint8_t r = 0; r < DETAIL_ROWS; r++) {
        detail_label_ptrs[r] = detail_labels[r];
        detail_value_ptrs[r] = detail_values[r];
        explicit_bzero(detail_values[r], DETAIL_VALUE_LEN);
    }

    snprintf(detail_labels[0], DETAIL_LABEL_LEN, "Agent");
    snprintf(detail_labels[1], DETAIL_LABEL_LEN, "Budget");
    snprintf(detail_labels[2], DETAIL_LABEL_LEN, "Available");
    snprintf(detail_labels[3], DETAIL_LABEL_LEN, "Reserved");
    snprintf(detail_labels[4], DETAIL_LABEL_LEN, "Draws");
    snprintf(detail_labels[5], DETAIL_LABEL_LEN, "Services");

    if (m == NULL || m->in_use == MANDATE_SLOT_FREE) {
        snprintf(detail_values[0], DETAIL_VALUE_LEN, "None");
        for (uint8_t r = 1; r < DETAIL_ROWS; r++) {
            snprintf(detail_values[r], DETAIL_VALUE_LEN, "-");
        }
        return;
    }

    // First four bytes of the agent id are enough to tell agents apart on
    // screen; the host holds the full identifier.
    snprintf(detail_values[0],
             DETAIL_VALUE_LEN,
             "%02x%02x%02x%02x...",
             m->agent_id[0],
             m->agent_id[1],
             m->agent_id[2],
             m->agent_id[3]);

    format_fpu64_trimmed(amount, sizeof(amount), m->budget_total, HBAR_DECIMALS);
    snprintf(detail_values[1], DETAIL_VALUE_LEN, "%s HBAR", amount);

    format_fpu64_trimmed(amount, sizeof(amount), mandate_available(id), HBAR_DECIMALS);
    snprintf(detail_values[2], DETAIL_VALUE_LEN, "%s HBAR", amount);

    format_fpu64_trimmed(amount, sizeof(amount), m->reserved, HBAR_DECIMALS);
    snprintf(detail_values[3], DETAIL_VALUE_LEN, "%s HBAR", amount);

    snprintf(detail_values[4], DETAIL_VALUE_LEN, "%u", (unsigned) m->seq);
    snprintf(detail_values[5], DETAIL_VALUE_LEN, "%u allowed", (unsigned) m->n_services);
}

/** Wipe every slot. The panic button. */
static void revoke_all_choice(bool confirm) {
    if (confirm) {
        for (uint8_t i = 0; i < MANDATE_COUNT; i++) {
            mandate_revoke(i);
        }
    }
    ui_menu_main();
}

/** Wipe the selected slot. No host involvement, by design. */
static void revoke_one_choice(bool confirm) {
    if (confirm) {
        mandate_revoke(selected_slot);
    }
    ui_menu_main();
}

static void home_controls(int token, uint8_t index, int page) {
    UNUSED(index);
    UNUSED(page);

    if (token == REVOKE_ALL_TOKEN) {
        nbgl_useCaseChoice(&ICON_APP_VELA,
                           "Revoke every mandate?",
                           "All agents lose their\nremaining budget at once.",
                           "Revoke all",
                           "Cancel",
                           revoke_all_choice);
        return;
    }

    if (token >= MANDATE_BAR_TOKEN && token < MANDATE_BAR_TOKEN + MANDATE_COUNT) {
        open_detail((uint8_t) (token - MANDATE_BAR_TOKEN));
    }
}

static void detail_controls(int token, uint8_t index, int page) {
    UNUSED(index);
    UNUSED(page);

    if (token != REVOKE_ONE_TOKEN) {
        return;
    }

    const mandate_t *m = mandate_get(selected_slot);
    if (m == NULL || m->in_use == MANDATE_SLOT_FREE) {
        ui_menu_main();
        return;
    }

    snprintf(confirm_title, sizeof(confirm_title), "Revoke mandate %u?", (unsigned) selected_slot);
    nbgl_useCaseChoice(&ICON_APP_VELA,
                       confirm_title,
                       "The agent loses every\nremaining draw immediately.",
                       "Revoke",
                       "Cancel",
                       revoke_one_choice);
}

static void open_detail(uint8_t slot) {
    selected_slot = slot;
    refresh_detail(slot);

    snprintf(detail_title, sizeof(detail_title), "Mandate %u", (unsigned) slot);

    detail_contents[0].type = INFOS_LIST;
    detail_contents[0].content.infosList.nbInfos = DETAIL_ROWS;
    detail_contents[0].content.infosList.infoTypes = detail_label_ptrs;
    detail_contents[0].content.infosList.infoContents = detail_value_ptrs;
    detail_contents[0].contentActionCallback = NULL;

    detail_contents[1].type = INFO_BUTTON;
    detail_contents[1].content.infoButton.text = "Kill this mandate";
    detail_contents[1].content.infoButton.icon = &ICON_APP_VELA;
    detail_contents[1].content.infoButton.buttonText = "Revoke";
    detail_contents[1].content.infoButton.buttonToken = REVOKE_ONE_TOKEN;
    detail_contents[1].content.infoButton.tuneId = NBGL_NO_TUNE;
    detail_contents[1].contentActionCallback = detail_controls;

    nbgl_useCaseGenericConfiguration(detail_title, 0, &detailGenericContents, ui_menu_main);
}

void ui_menu_main(void) {
    refresh_bars();

    nbgl_useCaseHomeAndSettings(APPNAME,
                                &ICON_APP_HOME,
                                "Spending mandates,\nenforced on-chip",
                                INIT_HOME_PAGE,
                                &homeGenericContents,
                                &infoList,
                                NULL,
                                app_quit);
}
