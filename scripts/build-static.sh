#!/usr/bin/env bash
# The console as files, for a host with no device behind it.
#
# web/server.mjs proxies /api/* to a gateway that reads a Ledger. None of that
# exists on a static host, and the page already knows: with no gateway on its
# origin it replays web/demo-run.json and says so in a banner. What is left is
# real — every figure in that recording came off a Flex, and verify.html
# checks the public log against Hedera's mirror node from the reader's own
# browser, with no server of ours in the path at all.
#
# So this is not a demo of the console. It is the console, with the half that
# needs hardware honestly marked as a recording.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

OUT="${1:-dist}"
rm -rf "$OUT"
mkdir -p "$OUT"

# Everything the two pages ask for by path, and nothing else. server.mjs is
# left behind on purpose: it is the thing that would need a device.
cp web/index.html web/verify.html "$OUT"/
cp web/app.js web/feed.js web/chain.js web/verify.js web/ledger.js \
   web/mandate.js "$OUT"/
cp web/style.css web/agama.css "$OUT"/
cp web/demo-run.json "$OUT"/
[ -d web/fonts ] && cp -R web/fonts "$OUT"/fonts

# /brand/* is served from the repository root by server.mjs, so it has to be
# copied rather than assumed.
mkdir -p "$OUT/brand"
cp brand/vela-mark.svg brand/vela-mark-white.svg brand/vela-mark-64.png "$OUT/brand"/

echo "  $OUT/ built — $(find "$OUT" -type f | wc -l | tr -d ' ') files"
echo "  check it:  python3 -m http.server -d $OUT 4099"
