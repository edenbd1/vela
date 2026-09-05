#pragma once

#include <stdint.h>

#include "ux.h"

#include "io.h"
#include "types.h"
#include "constants.h"
#include "mandate/mandate.h"

#include "os_pic.h"

/**
 * Global context for user requests.
 */
extern global_ctx_t G_context;

/**
 * Global structure for NVM data storage.
 */
typedef struct internal_storage_t {
    uint32_t magic;                      /// MANDATE_STORAGE_MAGIC once initialised
    mandate_t mandates[MANDATE_COUNT];   /// the envelopes, persisted across reboots
} internal_storage_t;

#ifdef TEST
extern internal_storage_t N_storage_real;
#else
extern const internal_storage_t N_storage_real;
#endif
#define N_storage (*(volatile internal_storage_t *) PIC(&N_storage_real))
