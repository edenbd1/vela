/*****************************************************************************
 *   Vela — mandate storage and policy, resident in the Secure Element.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *****************************************************************************/

#include <string.h>

#include "os.h"

#include "mandate.h"
#include "globals.h"

/** Is this Hedera account on the mandate's allowlist? */
static bool payee_allowed(const mandate_t *m, uint64_t payee) {
    for (uint8_t i = 0; i < m->n_payees && i < MANDATE_MAX_PAYEES; i++) {
        if (m->payees[i] == payee) {
            return true;
        }
    }
    return false;
}

static bool contract_allowed(const mandate_t *m, uint64_t contract) {
    for (uint8_t i = 0; i < m->n_contracts && i < MANDATE_MAX_CONTRACTS; i++) {
        if (m->contracts[i] == contract) {
            return true;
        }
    }
    return false;
}

static bool selector_allowed(const mandate_t *m, uint32_t selector) {
    for (uint8_t i = 0; i < m->n_selectors && i < MANDATE_MAX_SELECTORS; i++) {
        if (m->selectors[i] == selector) {
            return true;
        }
    }
    return false;
}

/**
 * Is the address in argument `idx` this device's own account?
 *
 * Hedera renders an account as a long-zero EVM address: twenty-four zero
 * bytes then the eight-byte account number, left-padded again to the
 * thirty-two byte ABI word. So the word is twenty-four zeros followed by the
 * number, and anything else — a real EVM address, an attacker's account,
 * padding games — fails the zero check before the comparison is reached.
 *
 * This is the whole anti-exfiltration rule. The agent may pick the contract,
 * the function and the amount; it may not pick who ends up holding the
 * proceeds. Under prompt injection that is the parameter the attacker
 * reaches for, and it is the one the chip will not sign away.
 */
static bool recipient_is_self(const uint8_t *calldata,
                              size_t len,
                              uint8_t idx,
                              uint64_t self_account) {
    if (idx == MANDATE_ARG_NONE) {
        return false;
    }
    // 4-byte selector, then 32-byte words.
    size_t off = 4 + (size_t) idx * 32;
    if (len < off + 32) {
        return false;
    }
    for (size_t i = 0; i < 24; i++) {
        if (calldata[off + i] != 0) {
            return false;
        }
    }
    uint64_t got = 0;
    for (size_t i = 0; i < 8; i++) {
        got = (got << 8) | calldata[off + 24 + i];
    }
    return got == self_account;
}

bool mandate_storage_init(void) {
    if (N_storage.magic == MANDATE_STORAGE_MAGIC) {
        return false;
    }

    // Zero every slot, then stamp the magic last: if we are interrupted
    // mid-write the magic is still absent and the next boot re-initialises.
    mandate_t empty;
    memset(&empty, 0, sizeof(empty));
    for (uint8_t i = 0; i < MANDATE_COUNT; i++) {
        nvm_write((void *) &N_storage.mandates[i], (void *) &empty, sizeof(empty));
    }

    uint32_t magic = MANDATE_STORAGE_MAGIC;
    nvm_write((void *) &N_storage.magic, (void *) &magic, sizeof(magic));
    return true;
}

const mandate_t *mandate_get(uint8_t id) {
    if (id >= MANDATE_COUNT) {
        return NULL;
    }
    return (const mandate_t *) &N_storage.mandates[id];
}

uint8_t mandate_active_count(void) {
    uint8_t n = 0;
    for (uint8_t i = 0; i < MANDATE_COUNT; i++) {
        if (N_storage.mandates[i].in_use != MANDATE_SLOT_FREE) {
            n++;
        }
    }
    return n;
}

uint64_t mandate_available(uint8_t id) {
    const mandate_t *m = mandate_get(id);
    if (m == NULL || m->in_use == MANDATE_SLOT_FREE) {
        return 0;
    }
    uint64_t committed = m->reserved + m->spent;
    if (committed >= m->budget_total) {
        return 0;
    }
    return m->budget_total - committed;
}

mandate_status_t mandate_create(const mandate_t *m, uint8_t *out_id) {
    if (m == NULL || out_id == NULL) {
        return MANDATE_ERR_ARGS;
    }
    if (m->n_payees == 0 || m->n_payees > MANDATE_MAX_PAYEES) {
        return MANDATE_ERR_ARGS;
    }
    if (m->budget_total == 0 || m->per_call_max == 0) {
        return MANDATE_ERR_ARGS;
    }
    if (m->per_call_max > m->budget_total) {
        return MANDATE_ERR_ARGS;
    }

    for (uint8_t i = 0; i < MANDATE_COUNT; i++) {
        if (N_storage.mandates[i].in_use != MANDATE_SLOT_FREE) {
            continue;
        }

        mandate_t fresh;
        memcpy(&fresh, m, sizeof(fresh));
        fresh.in_use = 1;
        fresh.reserved = 0;
        fresh.spent = 0;
        fresh.seq = 0;

        nvm_write((void *) &N_storage.mandates[i], (void *) &fresh, sizeof(fresh));
        explicit_bzero(&fresh, sizeof(fresh));

        *out_id = i;
        return MANDATE_OK;
    }

    return MANDATE_ERR_NO_SLOT;
}

mandate_status_t mandate_authorize(uint8_t id,
                                   uint64_t payee,
                                   uint64_t amount,
                                   uint32_t now,
                                   uint32_t *out_seq) {
    if (out_seq == NULL || amount == 0) {
        return MANDATE_ERR_ARGS;
    }

    const mandate_t *m = mandate_get(id);
    if (m == NULL || m->in_use == MANDATE_SLOT_FREE) {
        return MANDATE_ERR_NOT_FOUND;
    }

    // Order matters: the cheapest and most specific refusals first, so the
    // reason the agent gets back is the most actionable one.
    if (m->expiry != 0 && now >= m->expiry) {
        return MANDATE_ERR_EXPIRED;
    }
    if (!payee_allowed(m, payee)) {
        return MANDATE_ERR_PAYEE;
    }
    if (amount > m->per_call_max) {
        return MANDATE_ERR_PER_CALL;
    }
    if (amount > mandate_available(id)) {
        return MANDATE_ERR_BUDGET;
    }

    // Commit the reservation before returning. The caller signs only after
    // this write has landed, so a crash in between loses the draw rather
    // than letting the same headroom be spent twice.
    uint64_t reserved = m->reserved + amount;
    uint32_t seq = m->seq + 1;
    nvm_write((void *) &N_storage.mandates[id].reserved, (void *) &reserved, sizeof(reserved));
    nvm_write((void *) &N_storage.mandates[id].seq, (void *) &seq, sizeof(seq));

    *out_seq = seq;
    return MANDATE_OK;
}

/**
 * Authorise a contract call.
 *
 * Deliberately a separate entry point rather than a flag on
 * mandate_authorize(). The two are not the same question. A transfer asks
 * "may I pay this account this much"; a call asks "may I hand this contract
 * this much and let its arguments decide where it lands", and answering the
 * second with the first's checks is how blank cheques get signed.
 *
 * Order matters, as it does for transfers: the most specific refusal first,
 * so the agent is told the thing it can act on.
 */
mandate_status_t mandate_authorize_call(uint8_t id,
                                        uint64_t contract,
                                        uint64_t self_account,
                                        const uint8_t *calldata,
                                        size_t calldata_len,
                                        uint64_t amount,
                                        uint32_t now,
                                        uint32_t *out_seq) {
    if (out_seq == NULL || calldata == NULL || calldata_len < 4) {
        return MANDATE_ERR_ARGS;
    }

    const mandate_t *m = mandate_get(id);
    if (m == NULL || m->in_use == MANDATE_SLOT_FREE) {
        return MANDATE_ERR_NOT_FOUND;
    }
    if (m->expiry != 0 && now >= m->expiry) {
        return MANDATE_ERR_EXPIRED;
    }
    if (!contract_allowed(m, contract)) {
        return MANDATE_ERR_CONTRACT;
    }

    uint32_t selector = ((uint32_t) calldata[0] << 24) | ((uint32_t) calldata[1] << 16) |
                        ((uint32_t) calldata[2] << 8) | (uint32_t) calldata[3];
    if (!selector_allowed(m, selector)) {
        return MANDATE_ERR_SELECTOR;
    }

    // The check that makes the rest worth having.
    if (!recipient_is_self(calldata, calldata_len, m->recipient_arg, self_account)) {
        return MANDATE_ERR_RECIPIENT;
    }

    // A call with no value attached still consumes a sequence number, because
    // it still moved the agent's authority; it just does not draw budget.
    if (amount > m->per_call_max) {
        return MANDATE_ERR_PER_CALL;
    }
    if (amount > mandate_available(id)) {
        return MANDATE_ERR_BUDGET;
    }

    uint64_t reserved = m->reserved + amount;
    uint32_t seq = m->seq + 1;
    nvm_write((void *) &N_storage.mandates[id].reserved, (void *) &reserved, sizeof(reserved));
    nvm_write((void *) &N_storage.mandates[id].seq, (void *) &seq, sizeof(seq));

    *out_seq = seq;
    return MANDATE_OK;
}

mandate_status_t mandate_settle(uint8_t id, uint64_t quoted, uint64_t actual) {
    const mandate_t *m = mandate_get(id);
    if (m == NULL || m->in_use == MANDATE_SLOT_FREE) {
        return MANDATE_ERR_NOT_FOUND;
    }
    if (actual > quoted) {
        return MANDATE_ERR_SETTLE_AMOUNT;
    }
    if (quoted > m->reserved) {
        return MANDATE_ERR_SETTLE_AMOUNT;
    }

    uint64_t reserved = m->reserved - quoted;
    uint64_t spent = m->spent + actual;
    nvm_write((void *) &N_storage.mandates[id].reserved, (void *) &reserved, sizeof(reserved));
    nvm_write((void *) &N_storage.mandates[id].spent, (void *) &spent, sizeof(spent));

    return MANDATE_OK;
}

mandate_status_t mandate_revoke(uint8_t id) {
    const mandate_t *m = mandate_get(id);
    if (m == NULL || m->in_use == MANDATE_SLOT_FREE) {
        return MANDATE_ERR_NOT_FOUND;
    }

    mandate_t empty;
    memset(&empty, 0, sizeof(empty));
    nvm_write((void *) &N_storage.mandates[id], (void *) &empty, sizeof(empty));

    return MANDATE_OK;
}
