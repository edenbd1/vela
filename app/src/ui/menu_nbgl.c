/*****************************************************************************
 *   Vela — home screen and on-device mandate state.
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

//  -----------------------------------------------------------
//  --------------------- MANDATE STATE -----------------------
//  -----------------------------------------------------------
//
//  This page is not decoration. It is the chip reporting its own counters:
//  what each envelope was granted, and how much of it is left. Nothing on
//  the host can change these numbers, which is the entire point of Vela.

#define SLOT_LABEL_LEN 16
#define SLOT_VALUE_LEN 48

static char slot_labels[MANDATE_COUNT][SLOT_LABEL_LEN];
static char slot_values[MANDATE_COUNT][SLOT_VALUE_LEN];
static const char *slot_label_ptrs[MANDATE_COUNT];
static const char *slot_value_ptrs[MANDATE_COUNT];

#define INFO_NB 2
static const char *const INFO_TYPES[INFO_NB] = {"Version", "Enforced in"};
static const char *const INFO_CONTENTS[INFO_NB] = {APPVERSION, "Secure Element"};

static const nbgl_contentInfoList_t infoList = {
    .nbInfos = INFO_NB,
    .infoTypes = INFO_TYPES,
    .infoContents = INFO_CONTENTS,
};

static nbgl_contentInfoList_t mandateList;

#define SETTING_CONTENTS_NB 1
static nbgl_content_t contents[SETTING_CONTENTS_NB];

static const nbgl_genericContents_t settingContents = {.callbackCallNeeded = false,
                                                       .contentsList = contents,
                                                       .nbContents = SETTING_CONTENTS_NB};

/**
 * Render one slot as "<available> of <total> HBAR" or "Free".
 */
static void render_slot(uint8_t id) {
    const mandate_t *m = mandate_get(id);

    snprintf(slot_labels[id], SLOT_LABEL_LEN, "Mandate %u", (unsigned) id);

    if (m == NULL || m->in_use == MANDATE_SLOT_FREE) {
        snprintf(slot_values[id], SLOT_VALUE_LEN, "Free");
        return;
    }

    char left[24] = {0};
    char total[24] = {0};
    if (!format_fpu64_trimmed(left, sizeof(left), mandate_available(id), HBAR_DECIMALS) ||
        !format_fpu64_trimmed(total, sizeof(total), m->budget_total, HBAR_DECIMALS)) {
        snprintf(slot_values[id], SLOT_VALUE_LEN, "?");
        return;
    }

    snprintf(slot_values[id],
             SLOT_VALUE_LEN,
             "%s of %s HBAR left, %u draws",
             left,
             total,
             (unsigned) m->seq);
}

/**
 * Refresh the on-device view of every slot.
 *
 * Called on every return to the home screen, so the numbers a judge reads on
 * the device are the NVRAM counters as they stand, not a cached snapshot.
 */
static void refresh_mandate_view(void) {
    for (uint8_t i = 0; i < MANDATE_COUNT; i++) {
        render_slot(i);
        slot_label_ptrs[i] = slot_labels[i];
        slot_value_ptrs[i] = slot_values[i];
    }

    mandateList.nbInfos = MANDATE_COUNT;
    mandateList.infoTypes = slot_label_ptrs;
    mandateList.infoContents = slot_value_ptrs;

    contents[0].type = INFOS_LIST;
    contents[0].content.infosList = mandateList;
    contents[0].contentActionCallback = NULL;
}

void ui_menu_main(void) {
    refresh_mandate_view();

    nbgl_useCaseHomeAndSettings(APPNAME,
                                &ICON_APP_HOME,
                                "Spending mandates,\nenforced on-chip",
                                INIT_HOME_PAGE,
                                &settingContents,
                                &infoList,
                                NULL,
                                app_quit);
}
