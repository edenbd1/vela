#pragma once
#include "status_words.h"

/**
 * Vela refusals.
 *
 * Every reason the chip can say no gets its own status word, so the host can
 * hand the agent a concrete correction instead of a generic failure — a
 * blocked agent adjusts rather than retry-loops.
 */
#define SW_VELA_NO_SLOT       0xB101  /// every mandate slot is occupied
#define SW_VELA_NOT_FOUND     0xB102  /// no mandate in that slot
#define SW_VELA_EXPIRED       0xB103  /// the envelope has expired
#define SW_VELA_PAYEE         0xB104  /// payee is not on the allowlist
#define SW_VELA_PER_CALL      0xB105  /// over the per-call ceiling
#define SW_VELA_BUDGET        0xB106  /// over what is left in the envelope
#define SW_VELA_SETTLE_AMOUNT 0xB107  /// settling more than was authorised
#define SW_VELA_ARGS          0xB108  /// malformed request

/**
 * Status word for dynamic token TLV parsing/validation failed.
 */
#define SW_INVALID_DYNAMIC_TOKEN 0xB009
/**
 * Status word for swap failure
 */
#define SW_SWAP_FAIL 0xC000

/**
 * Application specific swap error code context
 */
typedef enum swap_error_application_specific_code_t {
    SWAP_ERROR_CODE = 0x00,
    SWAP_ERROR_WRONG_TOKEN_INFO = 0x01,
} swap_error_application_specific_code_t;
