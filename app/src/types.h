#pragma once

#include <stddef.h>  // size_t
#include <stdint.h>  // uint*_t

#include "bip32.h"

#include "constants.h"
#include "tx_types.h"
#include "mandate/mandate.h"

/**
 * Enumeration with expected INS of APDU commands.
 */
typedef enum {
    GET_VERSION = 0x03,        /// version of the application
    GET_APP_NAME = 0x04,       /// name of the application
    GET_PUBLIC_KEY = 0x05,     /// public key of corresponding BIP32 path
    SIGN_TX = 0x06,            /// sign transaction with BIP32 path
    SIGN_TOKEN_TX = 0x07,      /// sign token transaction with BIP32 path and token address
    PROVIDE_TOKEN_INFO = 0x22,  /// provide dynamic token info via CAL TLV descriptor

    // Vela: the mandate surface. A mandate is granted once with a physical
    // tap, then drawn against without one for as long as it holds.
    VELA_GET_MANDATE = 0x10,      /// read a slot's counters back
    VELA_CREATE_MANDATE = 0x11,   /// grant an envelope (requires approval)
    VELA_AUTHORIZE_SPEND = 0x12,  /// the hot path: check, reserve, no tap
    VELA_SETTLE_CONFIRM = 0x13,   /// release the unused headroom
    VELA_REVOKE_MANDATE = 0x14,   /// kill switch (requires approval)
    VELA_QUIT_APP = 0x15,         /// return to the dashboard, so a host can reload
    VELA_GET_PUBKEY = 0x16,       /// the buyer's Ed25519 key, to derive its account
    VELA_AUTHORIZE_CALL = 0x18,   /// the DeFi path: a contract call, bound to this account
    VELA_GET_LAST_BODY = 0x19     /// the body of that call, which does not fit in one response
} command_e;
/**
 * Enumeration with parsing state.
 */
typedef enum {
    STATE_NONE,     /// No state
    STATE_PARSED,   /// Transaction data parsed
    STATE_APPROVED  /// Transaction data approved
} state_e;

/**
 * Enumeration with user request type.
 */
typedef enum {
    CONFIRM_ADDRESS,           /// confirm address derived from public key
    CONFIRM_TRANSACTION,       /// confirm transaction information
    CONFIRM_TOKEN_TRANSACTION  /// confirm token transaction information
} request_type_e;

/**
 * Structure for public key context information.
 */
typedef struct {
    uint8_t raw_public_key[65];  /// format (1), x-coordinate (32), y-coodinate (32)
    uint8_t chain_code[32];      /// for public key derivation
} pubkey_ctx_t;

#define TOKEN_ADDRESS_LEN 32

/**
 * Structure for token information.
 */
typedef struct {
    const char *ticker;  /// token ticker
    uint8_t decimals;    /// number of decimals
} token_info_t;

/**
 * Structure for transaction information context.
 */
typedef struct {
    uint8_t raw_tx[MAX_TRANSACTION_LEN];  /// raw transaction serialized
    size_t raw_tx_len;                    /// length of raw transaction
    transaction_t transaction;            /// structured transaction

    // Token related
    bool is_token_tx;         /// flag to indicate if this is a token transaction
    token_info_t token_info;  /// token information retrieved using the token address

    // Signature related
    uint8_t m_hash[32];                  /// message hash digest
    uint8_t signature[MAX_DER_SIG_LEN];  /// transaction signature encoded in DER
    uint8_t signature_len;               /// length of transaction signature
    uint8_t v;                           /// parity of y-coordinate of R in ECDSA signature
} transaction_ctx_t;

/**
 * Structure for global context.
 */
typedef struct {
    state_e state;  /// state of the context
    union {
        pubkey_ctx_t pk_info;       /// public key context
        transaction_ctx_t tx_info;  /// transaction context
    };
    request_type_e req_type;              /// user request
    uint32_t bip32_path[MAX_BIP32_PATH];  /// BIP32 path
    uint8_t bip32_path_len;               /// length of BIP32 path

    /// Mandate awaiting the user's physical approval. Held in RAM only: it
    /// reaches NVRAM if and only if the tap happens.
    mandate_t pending_mandate;
    uint8_t pending_revoke_id;
} global_ctx_t;
