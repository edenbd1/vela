#!/usr/bin/env bash
# Run the confidential spend advisor and keep its verdict.
#
# The CRE simulator prints the handler's return value; this pulls that JSON
# out and writes cre/advice.json, which the gateway reads before every
# payment. In a deployed workflow the same object would arrive from the DON
# rather than from a file — what matters for the demo is that the advice is
# produced inside the enclave and consumed outside it.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

CRE="${CRE_BIN:-$HOME/.local/bin/cre}"
OUT="cre/advice.json"

if ! curl -s -m 3 http://127.0.0.1:4040/health >/dev/null; then
  echo "the risk feed is not up — run: node hedera/risk.mjs" >&2
  exit 1
fi

raw=$("$CRE" workflow simulate spend-advisor \
        --project-root cre -e cre/.env --target staging-settings \
        --non-interactive --trigger-index 0 2>&1)

echo "$raw" | grep -F "[USER LOG]" | sed 's/.*\[USER LOG\] /  enclave: /'

# Everything between the result banner and the blank line that follows it.
echo "$raw" \
  | awk '/Workflow Simulation Result:/{f=1;next} f&&/^$/{exit} f' \
  > "$OUT"

if ! python3 -c "import json,sys; json.load(open('$OUT'))" 2>/dev/null; then
  echo "could not parse a verdict out of the simulator:" >&2
  echo "$raw" | tail -20 >&2
  rm -f "$OUT"
  exit 1
fi

python3 - "$OUT" <<'PY'
import json, sys
a = json.load(open(sys.argv[1]))
deny = a.get("deny", [])
print(f"\n  advice written to {sys.argv[1]}")
print(f"  {len(a.get('allow', []))} allowed, {len(deny)} denied")
for d in deny:
    print(f"    deny {d['payee']}  {d['reason']} (score {d['score']})")
PY
