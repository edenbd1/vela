#!/usr/bin/env bash
# The controlled experiment.
#
# Same rules, same agent, same attack. One variable: where enforcement lives.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "════════════════════════════════════════════════════════════════"
echo "  Same rules. Same attack. The only difference is where the"
echo "  ceiling lives."
echo "════════════════════════════════════════════════════════════════"

rm -f /tmp/vela-software-state.json
python3 - <<'PY'
import sys; sys.path.insert(0, "host/software")
import policy
policy.Store().create("analyst", [10365984], 100_000_000, 20_000_000)
PY

python3 host/attack.py software
echo "────────────────────────────────────────────────────────────────"
python3 host/attack.py device
