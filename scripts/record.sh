#!/usr/bin/env bash
# Capture what the console saw, so a reader without a device can see it too.
#
# The recording is the events the page actually received, plus a snapshot of
# the fleet and the selected envelope. Replayed, it is not a mock-up: every
# figure in it came off a Ledger Flex.
#
# Run a swarm first, with VELA_EVENTS pointed at the console, then this.
#
#   export VELA_EVENTS=http://127.0.0.1:4050/api/events
#   node agent/swarm.mjs
#   ./scripts/record.sh
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

OUT="web/demo-run.json"

if ! curl -s -m 3 http://127.0.0.1:4050/api/config >/dev/null 2>&1; then
  echo "no console on :4050 — start it with ./scripts/up.sh" >&2
  exit 1
fi

curl -s -m 90 http://127.0.0.1:4050/api/events/recording > "$OUT"

python3 - "$OUT" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
n = len(d.get("events", []))
if n == 0:
    print("  the feed is empty — run an agent with VELA_EVENTS set first")
    raise SystemExit(1)
agents = sorted({e["agent"] for e in d["events"]})
refused = sum(1 for e in d["events"] if e["kind"] == "refused")
flagged = sum(1 for e in d["events"] if e["kind"] == "flagged")
print(f"  {n} events from {', '.join(agents)}")
print(f"  {refused} refusal(s), {flagged} flagged instruction(s)")
if not d.get("fleet"):
    print("  ! no fleet snapshot — the replay will show empty budget cards")
if refused == 0:
    print("  ! no refusal in this recording, which is the thing worth showing")
PY

echo
echo "  written to $OUT"
echo "  check it: open http://127.0.0.1:4050/?demo"
