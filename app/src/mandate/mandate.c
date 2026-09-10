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

/**
 * Shared body for granting and restoring.
 *
 * `keep_position` is the only difference, and it is the whole reason this is
 * not one function with a default argument: a grant must start at zero, and
 * that guarantee is worth more than the duplication saved by making it
 * optional somewhere a caller could get it wrong. mandate_create() cannot
 * produce a mandate that is already part-spent, whatever it is handed.
 */
static mandate_status_t mandate_write(const mandate_t *m,
                                      uint8_t *out_id,
                                      bool keep_position) {
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
        // Never carried over. A reservation is an authorisation in flight,
        // and nothing is in flight on a device that has just been restored.
        fresh.reserved = 0;
        if (!keep_position) {
            fresh.spent = 0;
            fresh.seq = 0;
        }

        nvm_write((void *) &N_storage.mandates[i], (void *) &fresh, sizeof(fresh));
        explicit_bzero(&fresh, sizeof(fresh));

        *out_id = i;
        return MANDATE_OK;
    }

    return MANDATE_ERR_NO_SLOT;
}

mandate_status_t mandate_create(const mandate_t *m, uint8_t *out_id) {
    return mandate_write(m, out_id, false);
}

/**
 * Put an envelope back where the audit log says it had got to.
 *
 * The position is not checked here and cannot be: this chip signs whatever it
 * is handed, so a record it "signed" is not evidence to itself. It was
 * checked by a person reading it off the trusted display and comparing it
 * with a log anyone can verify. See handler_create_mandate.
 */
mandate_status_t mandate_restore(const mandate_t *m, uint8_t *out_id) {
    if (m != NULL && m->spent > m->budget_total) {
        return MANDATE_ERR_ARGS;
    }
    return mandate_write(m, out_id, true);
}


/**
 * Has this envelope drawn too many times too quickly?
 *
 * Returns the window state the caller should commit, so the check and the
 * bookkeeping stay in one place. A mandate with no velocity terms — every
 * mandate written before this field existed — skips it entirely.
 *
 * There is no clock in the Secure Element, so `now` comes from the host. A
 * host that lies forwards can only reset a counter it could have waited out;
 * a host that lies backwards is refused, because time going backwards is the
 * one thing this can catch without a clock of its own.
 */
static mandate_status_t velocity_check(const mandate_t *m,
                                       uint32_t now,
                                       uint32_t *out_start,
                                       uint16_t *out_draws) {
    *out_start = m->window_start;
    *out_draws = m->window_draws;

    if (m->window_secs == 0 || m->max_per_window == 0) {
        return MANDATE_OK;
    }
    if (now < m->window_start) {
        return MANDATE_ERR_VELOCITY;
    }
    if (m->window_start == 0 || now - m->window_start >= m->window_secs) {
        *out_start = now;
        *out_draws = 0;
    }
    if (*out_draws >= m->max_per_window) {
        return MANDATE_ERR_VELOCITY;
    }
    *out_draws = (uint16_t) (*out_draws + 1);
    return MANDATE_OK;
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

    // Last of the refusals, and before anything is written. A draw refused on
    // velocity must not consume the sequence number it was refused for.
    uint32_t window_start = 0;
    uint16_t window_draws = 0;
    mandate_status_t v = velocity_check(m, now, &window_start, &window_draws);
    if (v != MANDATE_OK) {
        return v;
    }

    // Commit the reservation before returning. The caller signs only after
    // this write has landed, so a crash in between loses the draw rather
    // than letting the same headroom be spent twice.
    uint64_t reserved = m->reserved + amount;
    uint32_t seq = m->seq + 1;
    nvm_write((void *) &N_storage.mandates[id].reserved, (void *) &reserved, sizeof(reserved));
    nvm_write((void *) &N_storage.mandates[id].seq, (void *) &seq, sizeof(seq));
    nvm_write((void *) &N_storage.mandates[id].window_start, (void *) &window_start,
              sizeof(window_start));
    nvm_write((void *) &N_storage.mandates[id].window_draws, (void *) &window_draws,
              sizeof(window_draws));

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

    // A call counts against velocity exactly as a transfer does. It moved the
    // agent's authority, and forty of them in a minute is the thing the limit
    // exists to notice — whether or not each one drew budget.
    uint32_t window_start = 0;
    uint16_t window_draws = 0;
    mandate_status_t v = velocity_check(m, now, &window_start, &window_draws);
    if (v != MANDATE_OK) {
        return v;
    }

    uint64_t reserved = m->reserved + amount;
    uint32_t seq = m->seq + 1;
    nvm_write((void *) &N_storage.mandates[id].reserved, (void *) &reserved, sizeof(reserved));
    nvm_write((void *) &N_storage.mandates[id].seq, (void *) &seq, sizeof(seq));
    nvm_write((void *) &N_storage.mandates[id].window_start, (void *) &window_start,
              sizeof(window_start));
    nvm_write((void *) &N_storage.mandates[id].window_draws, (void *) &window_draws,
              sizeof(window_draws));

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
