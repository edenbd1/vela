/*****************************************************************************
 *   Vela — APDU handlers for the mandate surface.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *****************************************************************************/

#pragma once

#include <stdint.h>
#include "buffer.h"

/**
 * Read a slot's counters back.
 *
 * Lets the host — and the agent's own prompt — see how much envelope is
 * left, straight from NVRAM. Nothing on the host can move these numbers.
 *
 * @param[in] id  slot index
 */
int handler_get_mandate(uint8_t id);

/**
 * Grant an envelope. Requires the user's physical approval.
 *
 * data = agent_id (20) || n_payees (1) || payees (n * 8, BE) ||
 *        budget_total (8, BE) || per_call_max (8, BE) || expiry (4, BE)
 */
int handler_create_mandate(buffer_t *cdata);

/**
 * The hot path. Check the draw against the envelope and reserve it.
 *
 * No approval: the tap already happened, once, when the mandate was granted.
 * Skipping it here is exactly what that mandate authorised — and it is the
 * chip, not the host, that holds the bounds.
 *
 * data = mandate_id (1) || fee_payer (8) || from (8) || payee (8) ||
 *        node (8) || amount (8) ||
 *        fee (8) || valid_start_sec (8) || valid_start_nanos (4) ||
 *        valid_duration_sec (4) || now (4)   — all big endian
 *
 * reply = seq (4) || available (8) || body_len (1) || body || signature (64)
 */
int handler_authorize_spend(buffer_t *cdata);

/**
 * Close a draw: release the unused headroom, record what settled.
 *
 * data = mandate_id (1) || quoted (8, BE) || actual (8, BE)
 */
int handler_settle_confirm(buffer_t *cdata);

/**
 * Kill switch. Requires the user's physical approval.
 *
 * data = mandate_id (1)
 */
int handler_revoke_mandate(buffer_t *cdata);

/** Called from the UI once the user has answered a create prompt. */
void validate_create_mandate(bool approved);

/** Called from the UI once the user has answered a revoke prompt. */
void validate_revoke_mandate(bool approved);

/** The buyer's Ed25519 public key, so the host can derive its account. */
int handler_get_pubkey(uint8_t index);
