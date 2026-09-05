#!/usr/bin/env bash
# Build the Vela BOLOS app for Ledger Flex.
#
# The SDK derives object paths from `git rev-parse --show-toplevel`, so the
# repository root must be mounted — not just app/. Mounting only the app
# directory makes the SDK silently skip every application source file and
# fail at link time with "undefined symbol: app_main".
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
docker run --rm -v "$ROOT":/repo -w /repo/app \
  -e BOLOS_SDK=/opt/flex-secure-sdk \
  ghcr.io/ledgerhq/ledger-app-builder/ledger-app-builder:latest \
  make -j4 "$@"
