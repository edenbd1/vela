#!/usr/bin/env bash
# Two boundaries, and the direction they compose in.
#
# Vela puts a spending mandate in a Secure Element: hard, but static. The chip
# has no network and no clock beyond an expiry, so it cannot learn that an
# account which was reputable when the human granted the envelope is a drainer
# today. A Chainlink CRE workflow running in an AWS Nitro enclave supplies that
# missing half — it decides whether a payment *should* happen, somewhere the
# host cannot reach either.
#
# The claim this script exists to test is that the composition is
# one-directional:
#
#     the enclave can narrow what the chip allows, and can never widen it.
#
# Both halves are demonstrated, because only proving the first would be
# marketing.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

GATEWAY=http://127.0.0.1:4030
SELLER=http://127.0.0.1:4021
BRIDGE=http://127.0.0.1:8099

need() {
  curl -s -m 3 "$1" >/dev/null 2>&1 || { echo "not up: $1 — $2" >&2; exit 1; }
}
need "$BRIDGE/apdu" "python3 host/bridge.py"
need "$SELLER/health" "node hedera/seller.mjs"
need "$GATEWAY/envelope" "node hedera/gateway.mjs"

restart_risk() {
  lsof -ti :4040 | xargs kill -9 2>/dev/null
  sleep 1
  # disowned so the shell does not print "Killed: 9" over the demo output
  # when the next phase replaces this feed.
  if [ -n "${1:-}" ]; then RISK_FLAG="$1" node hedera/risk.mjs >/tmp/risk.log 2>&1 &
  else node hedera/risk.mjs >/tmp/risk.log 2>&1 & fi
  disown 2>/dev/null
  sleep 2
}

rule() { printf '─%.0s' {1..70}; echo; }

PAYEE=$(grep -m1 '^HEDERA_TREASURY_ID=' .env | cut -d= -f2)

echo "════════════════════════════════════════════════════════════════════"
echo "  Two boundaries. The enclave narrows; only the chip authorises."
echo "════════════════════════════════════════════════════════════════════"

echo
echo "A. The enclave turns against a payee the chip still allows."
rule
restart_risk "$PAYEE"
./scripts/advisor.sh 2>&1 | sed 's/^/  /'
echo
echo "  the agent asks for the cheap tier, exactly as before:"
curl -s -m 150 -X POST "$GATEWAY/pay" -H 'content-type: application/json' \
  -d '{"service":"triage"}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('   ', d.get('reason') or ('paid, tx '+str(d.get('tx'))))"
echo "  nothing changed on the device. Only what the enclave knows."

echo
echo "B. The same request, once the enclave clears the payee."
rule
restart_risk
./scripts/advisor.sh 2>&1 | tail -3 | sed 's/^/  /'
curl -s -m 150 -X POST "$GATEWAY/pay" -H 'content-type: application/json' \
  -d '{"service":"triage"}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('   ', d.get('reason') or ('paid, tx '+str(d.get('tx'))))"

echo
echo "C. The enclave blesses an account the chip has never heard of."
rule
python3 - <<'PY'
import json
p = "cre/spend-advisor/config.staging.json"
c = json.load(open(p))
if "0.0.77777777" not in c["payees"]:
    c["payees"].append("0.0.77777777")
    json.dump(c, open(p, "w"), indent=2)
PY
./scripts/advisor.sh >/dev/null 2>&1
python3 -c "
import json; a=json.load(open('cre/advice.json'))
for v in a['allow']:
    if v['payee'] == '0.0.77777777':
        print(f\"  enclave: allow {v['payee']}  {v['reason']} (score {v['score']})\")"

python3 - <<'PY'
import json, os, re, struct, time, urllib.request

def apdu(h):
    r = urllib.request.Request("http://127.0.0.1:8099/apdu",
        data=json.dumps({"apdu": h}).encode(),
        headers={"content-type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=60))

# Read the buyer rather than remember it. It changes whenever the device's
# seed does, and a hardcoded account here fails as a bridge error several
# layers away from the reason.
env = open(".env").read()
buyer = int(re.search(r"^HEDERA_BUYER_ID=0\.0\.(\d+)", env, re.M).group(1))

SW = {0xb103: "expired", 0xb104: "payee_not_allowed", 0xb105: "over_per_call",
      0xb106: "over_budget", 0x9000: "AUTHORIZED"}
now = int(time.time())
body = bytes([0]) + struct.pack(">QQQQQQQIII",
    7162784, buyer, 77777777, 3, 1_000_000, 100_000_000, now, 0, 120, now)
try:
    sw = apdu((bytes([0xe0, 0x12, 0, 0, len(body)]) + body).hex())["sw"]
except urllib.error.HTTPError as e:
    print(f"  chip:    bridge said {e.code} — is the Vela app open?")
else:
    print(f"  chip:    0x{sw:04x}  {SW.get(sw, 'unknown')}")
PY

echo
rule
echo "  The advisor removed a payee the chip would have signed for, and"
echo "  could not add one it would not. A compromised advisor costs"
echo "  availability. It never costs authority."
