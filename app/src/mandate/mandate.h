/*****************************************************************************
 *   Vela — a spending mandate enforced inside the Secure Element.
 *
 *  A mandate is an envelope granted once, with a physical tap, that bounds
 *  what an autonomous agent may spend. It lives in NVRAM, so it survives a
 *  reboot, a redeploy, a replaced agent binary, and root on the host.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *****************************************************************************/

#pragma once

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

/**
 * Number of mandates the device can hold at once.
 *
 * Bounded by the 512 bytes of NVRAM the app is loaded with (dataSize).
 * Three is enough to run several competing agents side by side.
 */
#define MANDATE_COUNT 3

/** Payees a single mandate may pay. */
#define MANDATE_MAX_PAYEES 4

/** Contracts a single mandate may call. */
#define MANDATE_MAX_CONTRACTS 2

/** Function selectors a single mandate may invoke on those contracts. */
#define MANDATE_MAX_SELECTORS 4

/**
 * Every address a call could hand value to must be one the chip was told
 * about. For a plain transfer that is the payee. For a contract call it is
 * whatever the calldata names — the `recipient` of a swap, the `to` of a
 * transfer, the `spender` of an approval — and those live inside an
 * ABI-encoded argument, not in a protobuf field.
 *
 * So the mandate says where to look: which 32-byte argument word carries the
 * address, and what the chip must find there.
 */
#define MANDATE_ARG_NONE 0xFF

/** Length of an agent identifier (ERC-8004 / HCS-14 digest, truncated). */
#define AGENT_ID_LEN 20

/**
 * A human-readable name for the agent, including the terminator.
 *
 * The identifier is twenty bytes and reads as `a1a1a1a1...` on a screen,
 * which tells the person holding the device nothing about which agent they
 * are about to cut off. A fleet is only governable if its members are
 * distinguishable, so the mandate carries a label the human chose when they
 * granted it.
 */
#define MANDATE_LABEL_LEN 16

/**
 * Marks NVRAM as initialised, and pins the layout it was written with.
 *
 * Bump the low byte whenever mandate_t changes shape. Without that, an app
 * upgrade finds a magic it recognises, skips initialisation, and reads the
 * old bytes through the new struct — silently, and with real money behind
 * the numbers it gets wrong.
 *
 *   0x...01  services as 16-byte hashes
 *   0x...02  payees as Hedera account numbers
 *   0x...03  contract calls: callee allowlist, selectors, recipient binding
 *   0x...04  a human-readable label per mandate
 */
#define MANDATE_STORAGE_MAGIC 0x56454C04  // "VEL" + layout version

/** No mandate occupies this slot. */
#define MANDATE_SLOT_FREE 0

/**
 * One spending envelope.
 *
 * `budget_total` is split three ways at any instant:
 *   available = budget_total - reserved - spent
 *
 * `reserved` holds authorisations that have been signed but not yet settled.
 * Without it, N open authorisations of X each would all pass a cap of less
 * than N*X, because none of them has settled yet — the same way a card
 * pre-authorisation holds against a balance.
 */
typedef struct {
    uint8_t in_use;                                  /// MANDATE_SLOT_FREE or 1
    uint8_t n_payees;                                /// entries used in `payees`
    uint8_t agent_id[AGENT_ID_LEN];                  /// who this envelope is for
    char label[MANDATE_LABEL_LEN];                   /// what the human calls it
    /// Hedera account numbers this envelope may pay. Not a hash supplied by
    /// the host: the chip reads the payee out of the transfer it is about to
    /// encode and matches it here, so the allowlist describes what is
    /// actually signed rather than what the host claims is being signed.
    uint64_t payees[MANDATE_MAX_PAYEES];
    uint64_t budget_total;                                     /// tinybars
    uint64_t reserved;                                         /// authorised, not yet settled
    uint64_t spent;                                            /// settled
    uint64_t per_call_max;                                     /// ceiling for a single draw
    uint32_t expiry;                                           /// unix seconds, 0 = never
    uint32_t seq;                                              /// monotonic, anchors the audit log

    /// --- contract calls -------------------------------------------------
    ///
    /// A transfer moves value to one place and the protobuf names it. A
    /// contract call moves value wherever its arguments say, and the
    /// protobuf names only the contract. Signing one on the strength of the
    /// callee alone is signing a blank cheque with the payee filled in by
    /// whoever wrote the calldata — which, for an agent under prompt
    /// injection, is the attacker.
    uint8_t n_contracts;                             /// entries used in `contracts`
    uint8_t n_selectors;                             /// entries used in `selectors`
    /// Index of the 32-byte ABI argument holding the address that receives
    /// value, or MANDATE_ARG_NONE if this mandate allows no calls.
    uint8_t recipient_arg;
    uint8_t pad;
    uint64_t contracts[MANDATE_MAX_CONTRACTS];       /// Hedera contract numbers
    /// Big-endian 4-byte function selectors. A callee allowlist without one
    /// of these is far too coarse: the same router that swaps also approves.
    uint32_t selectors[MANDATE_MAX_SELECTORS];
} mandate_t;

/**
 * Why the chip refused.
 *
 * Every refusal is a distinct code so the host can hand the agent a concrete
 * reason instead of a generic failure, and the agent can correct itself
 * rather than retry-loop.
 */
typedef enum {
    MANDATE_OK = 0,
    MANDATE_ERR_NO_SLOT,        /// every slot is occupied
    MANDATE_ERR_NOT_FOUND,      /// no mandate with that id
    MANDATE_ERR_EXPIRED,        /// past its expiry
    MANDATE_ERR_PAYEE,          /// payee is not on the allowlist
    MANDATE_ERR_PER_CALL,       /// amount exceeds the per-call ceiling
    MANDATE_ERR_BUDGET,         /// amount exceeds what is left in the envelope
    MANDATE_ERR_SETTLE_AMOUNT,  /// settling more than was authorised
    MANDATE_ERR_ARGS,           /// malformed request
    MANDATE_ERR_CONTRACT,       /// callee is not on the allowlist
    MANDATE_ERR_SELECTOR,       /// that function is not allowed on it
    MANDATE_ERR_RECIPIENT,      /// the call would hand value to someone else
} mandate_status_t;

/**
 * Initialise NVRAM on first run. Idempotent.
 *
 * @return true if the storage was freshly written, false if it already held a
 *         valid layout from a previous boot.
 */
bool mandate_storage_init(void);

/**
 * Authorise a contract call under a mandate.
 *
 * Separate from mandate_authorize() on purpose: a transfer names its payee
 * in the protobuf, a call names only the contract and lets the calldata
 * decide where value lands. `self_account` is the device's own account, and
 * the call is refused unless the argument the mandate points at holds it.
 */
mandate_status_t mandate_authorize_call(uint8_t id,
                                        uint64_t contract,
                                        uint64_t self_account,
                                        const uint8_t *calldata,
                                        size_t calldata_len,
                                        uint64_t amount,
                                        uint32_t now,
                                        uint32_t *out_seq);

/** Read-only view of a slot, or NULL if the id is out of range. */
const mandate_t *mandate_get(uint8_t id);

/** Slots currently holding a mandate. */
uint8_t mandate_active_count(void);

/**
 * Write a new mandate into a free slot.
 *
 * The caller is responsible for having obtained the user's physical approval
 * first: this function only persists what was approved.
 *
 * @param[in]  m       the mandate to store; `in_use`, `reserved`, `spent` and
 *                     `seq` are set by this function and ignored on input.
 * @param[out] out_id  slot the mandate landed in.
 */
mandate_status_t mandate_create(const mandate_t *m, uint8_t *out_id);

/**
 * The hot path: decide whether a draw is inside the envelope, and reserve it.
 *
 * Runs entirely on-chip. On success the reservation is committed to NVRAM
 * *before* the caller is allowed to sign, so a power loss between the two
 * costs the agent a reservation rather than letting it spend twice.
 *
 * @param[in]  id          mandate slot
 * @param[in]  payee       Hedera account number receiving the funds
 * @param[in]  amount      tinybars
 * @param[in]  now         unix seconds, supplied by the host
 * @param[out] out_seq     sequence number assigned to this draw
 */
mandate_status_t mandate_authorize(uint8_t id,
                                   uint64_t payee,
                                   uint64_t amount,
                                   uint32_t now,
                                   uint32_t *out_seq);

/**
 * Close a draw: release the unused headroom, record what actually settled.
 *
 * @param[in] id        mandate slot
 * @param[in] quoted    amount previously reserved by mandate_authorize
 * @param[in] actual    amount that actually settled; must be <= quoted
 */
mandate_status_t mandate_settle(uint8_t id, uint64_t quoted, uint64_t actual);

/** Kill switch. Frees the slot; the agent is powerless immediately. */
mandate_status_t mandate_revoke(uint8_t id);

/** budget_total - reserved - spent, or 0 if the slot is empty. */
uint64_t mandate_available(uint8_t id);
