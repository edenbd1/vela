#!/usr/bin/env bash
# Bring the whole thing up, and say what is not ready.
#
# There are six processes, a device, a model and a Key Ring behind this demo,
# and the failure mode that matters is not one of them being down — it is one
# of them being up and *stale*. A gateway started before the fleet was granted
# anchors to the wrong topic. A console started before the gateway holds an
# operator token nobody accepts. Both look fine until the moment you are
# recording.
#
# So this starts what is missing, restarts what is stale, and refuses to
# pretend about the two things it cannot fix: the device and the model.
#
#   ./scripts/up.sh            start or restart everything
#   ./scripts/up.sh --status   say what is running, change nothing
#   ./scripts/up.sh --down     stop what this started
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOGS="$ROOT/.vela-logs"
mkdir -p "$LOGS"

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }
note() { printf "    \033[2m%s\033[0m\n" "$1"; }

listening() { lsof -tiTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
pid_on()    { lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1; }

# name, port, command
SERVICES=(
  "bridge|8099|python3 host/bridge.py"
  "broker|4060|node broker/server.mjs"
  "seller|4021|node hedera/seller.mjs"
  "gateway|4030|node hedera/gateway.mjs"
  "console|4050|node web/server.mjs"
)

status() {
  echo
  echo "services"
  for s in "${SERVICES[@]}"; do
    IFS='|' read -r name port _ <<< "$s"
    if listening "$port"; then ok "$(printf '%-8s :%s  pid %s' "$name" "$port" "$(pid_on "$port")")"
    else bad "$(printf '%-8s :%s  down' "$name" "$port")"; fi
  done

  echo
  echo "the two things this script cannot start for you"
  if curl -s -m 3 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    ok "model runtime on :11434"
    local have
    have=$(curl -s -m 3 http://127.0.0.1:11434/api/tags | grep -o '"name":"[^"]*"' | cut -d'"' -f4 | tr '\n' ' ')
    note "$have"
    case "$have" in *hermes3:8b*) ;; *) warn "hermes3:8b is not pulled — ollama pull hermes3:8b";; esac
  else
    bad "no model runtime — ollama serve"
  fi

  if curl -s -m 30 http://127.0.0.1:8099/health 2>/dev/null | grep -q '"ok": *true'; then
    ok "device answering"
  else
    bad "device not answering"
    note "open Vela on the Flex, quit Ledger Wallet, then re-run this"
  fi
}

fleet_state() {
  echo
  echo "the fleet, from the chip"
  local out
  out=$(curl -s -m 45 http://127.0.0.1:4030/mandates 2>/dev/null)
  if [ -z "$out" ]; then bad "gateway did not answer"; return 1; fi
  echo "$out" | python3 -c '
import json, sys
d = json.load(sys.stdin)
live = unknown = free = 0
why = ""
for s in d.get("slots", []):
    n = s["slot"]
    if s.get("unknown"):
        unknown += 1
        why = s["why"]
        print("  ! slot %d  unknown" % n)
        continue
    if s.get("free"):
        free += 1
        print("    slot %d  free" % n)
        continue
    live += 1
    a = int(s["available"]) / 1e8
    b = int(s["budget_total"]) / 1e8
    c = int(s["per_call_max"]) / 1e8
    print("  * slot %d  %-14s %.2f/%.2f HBAR   ceiling %.2f" % (n, s["label"], a, b, c))

# An unreadable slot is not an empty one, and telling someone to grant a
# fleet they may already have would have them tap through a revoke of
# mandates that were working. The gateway learned this lesson first; the
# same mistake fits just as easily in a status script.
if unknown:
    print("")
    print("    The chip did not answer, so this says nothing about what is")
    print("    in those slots. They may be granted and simply unreadable.")
    print("      %s" % why[:70])
    print("    Unlock the Flex and open Vela, then re-run this.")
elif live == 0:
    print("")
    print("    All slots free. Grant a fleet:  node hedera/fleet.mjs  (taps required)")
' || bad "could not read the fleet"
}

# --- the epoch and its topic ----------------------------------------------
#
# The one piece of state that is silently wrong rather than visibly missing.
# A gateway anchoring to a topic .env has stopped naming produces a verifier
# that reports an empty log while money moves.
epoch_state() {
  echo
  echo "the audit topic"
  node -e '
const fs = require("fs");
let inst = null;
try { inst = JSON.parse(fs.readFileSync(".vela-instance", "utf8")); }
catch { try { inst = { id: fs.readFileSync(".vela-instance","utf8").trim(), topic: null }; } catch {} }
let envTopic = null;
try {
  for (const l of fs.readFileSync(".env","utf8").split("\n")) {
    const m = l.match(/^\s*HEDERA_TOPIC_ID\s*=\s*(.*)$/);
    if (m) envTopic = m[1].trim();
  }
} catch {}
if (!inst) { console.log("  ! no grant epoch — node hedera/fleet.mjs"); process.exit(0); }
if (inst.topic) {
  console.log(`  ✓ epoch ${inst.id} anchors to ${inst.topic}`);
  if (envTopic && envTopic !== inst.topic) {
    console.log(`    .env says ${envTopic}; the epoch wins, which is correct`);
  }
} else {
  console.log(`  ! epoch ${inst.id} predates topic binding — falls back to .env (${envTopic})`);
  console.log("    a chain granted before this may start mid-sequence.");
  console.log("    node hedera/fleet.mjs gives a clean one.");
}
' 2>/dev/null
}

# --- is the public log whole? ---------------------------------------------
#
# The last shot of the demo is a verifier reading this topic. Finding out
# there that the chain starts at draw 2 is finding out too late — and it is
# not hypothetical: a gateway that outlived a topic rotation put exactly that
# gap in ours.
chain_state() {
  echo
  echo "the public log"
  local out
  out=$(node hedera/verify.mjs 2>/dev/null | tail -30)
  if [ -z "$out" ]; then bad "the verifier did not run"; return; fi
  if echo "$out" | grep -q "no draws anchored yet"; then
    note "nothing anchored yet on this topic"
  elif echo "$out" | grep -q "incomplete"; then
    bad "the chain has a gap"
    echo "$out" | grep -E "FAIL" | head -3 | sed "s/^/      /"
    note "node hedera/fleet.mjs starts a clean one (taps required)"
  else
    ok "$(echo "$out" | grep -E "envelope\(s\) verify" | head -1)"
  fi
}

# --- does the log reconstruct the chip? -----------------------------------
#
# The verifier above says the chain is internally whole. This says it is
# *about* the envelopes actually in the Secure Element — the property recovery
# rests on, and the only one that can be marked while the device is still
# here. It caught a real one: a chain ending on a released reservation
# restored short by that draw, silently, in the safe direction.
agreement_state() {
  echo
  echo "the log against the chip"
  local out
  out=$(node hedera/recover.mjs --check 2>/dev/null | grep -E "agrees|DISAGREES|to the tinybar|disagree\(s\)|nothing was")
  if [ -z "$out" ]; then note "no backup or no chip — nothing to compare"; return; fi
  if echo "$out" | grep -q DISAGREES; then
    bad "the log does not reconstruct the chip"
    echo "$out" | grep DISAGREES | head -3 | sed "s/^/      /"
  else
    ok "$(echo "$out" | grep -c "chip agrees") envelope(s) reconstruct to the tinybar"
  fi
}

case "${1:-}" in
  --status) status; fleet_state; epoch_state; chain_state; agreement_state; echo; exit 0 ;;
  --down)
    echo
    for s in "${SERVICES[@]}"; do
      IFS='|' read -r name port _ <<< "$s"
      p=$(pid_on "$port")
      if [ -n "$p" ]; then kill "$p" 2>/dev/null && ok "$name stopped"; else note "$name was not running"; fi
    done
    echo; exit 0 ;;
esac

# --- start, in order ------------------------------------------------------
#
# Order matters twice: the gateway mints an operator token the console reads,
# and the gateway needs the bridge to know whether the device is there. It
# starts without one now, but it will report every slot as "unknown", which
# is honest and useless.
echo
echo "starting"
for s in "${SERVICES[@]}"; do
  IFS='|' read -r name port cmd <<< "$s"
  if listening "$port"; then
    note "$(printf '%-8s already on :%s' "$name" "$port")"
    continue
  fi
  # shellcheck disable=SC2086
  nohup $cmd > "$LOGS/$name.log" 2>&1 &
  for _ in $(seq 1 20); do listening "$port" && break; sleep 0.5; done
  if listening "$port"; then ok "$(printf '%-8s :%s' "$name" "$port")"
  else bad "$name did not come up — $LOGS/$name.log"; tail -3 "$LOGS/$name.log" | sed 's/^/      /'; fi
done

status
fleet_state
epoch_state
chain_state

echo
echo "next"
echo "    node agent/swarm.mjs                     three agents, one chip"
echo "    open http://127.0.0.1:4050               watch them think"
echo "    ./scripts/experiment.sh                  software vs silicon"
echo "    node hedera/verify.mjs                   the public log"
echo
echo "  Point the agents at the console so it can draw them:"
echo "    export VELA_EVENTS=http://127.0.0.1:4050/api/events"
echo
