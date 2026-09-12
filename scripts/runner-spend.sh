#!/usr/bin/env bash
# Put an agent on GitHub's hardware and let the chip refuse it, in one step.
#
# All the pieces existed. Doing it meant opening a tunnel in one terminal,
# copying an ngrok URL out of its output, pasting it into a `gh workflow run`,
# and then going to find the run in a browser — four moves, one of them a
# copy-paste, and the URL changes every time. That is a demo that breaks on
# stage, and it is why the most interesting thing this project does was the
# hardest thing in it to show.
#
# So: one command, and the console has a button for it.
#
#   1. check the things that fail slowly if they are wrong
#   2. open the tunnel
#   3. dispatch the workflow against that URL
#   4. follow the run
#   5. close the tunnel, whatever happened
#
# What actually gets proven is in .github/workflows/remote-spend.yml: a job
# with no USB bus, no Ledger tooling, no seed and no envelope buys one triage
# and is then refused — by the Secure Element, for exceeding a per-draw
# ceiling that job cannot read, raise, or route around.
#
#   ./scripts/runner-spend.sh            # the whole chain
#   ./scripts/runner-spend.sh --keep     # leave the tunnel open afterwards
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

WORKFLOW="remote-spend.yml"
AGENT="remote-1"                 # the label the workflow asserts on
KEEP=""
[ "${1:-}" = "--keep" ] && KEEP=1

GATEWAY_PORT="${GATEWAY_PORT:-4030}"
LOG=/tmp/vela-ngrok.log
PIDFILE=/tmp/vela-ngrok.pid

die() { echo; echo "  $1"; [ -n "${2:-}" ] && echo "  fix: $2"; exit 1; }

# --- 1. the things that fail slowly if they are wrong ----------------------
#
# Every one of these has cost a run that went red four minutes in for a reason
# visible in four seconds here.

command -v gh >/dev/null || die "gh is not installed" "brew install gh"
gh auth status >/dev/null 2>&1 || die "gh is not logged in" "gh auth login"

gh secret list 2>/dev/null | grep -q VELA_REMOTE_TOKEN ||
  die "the repository has no VELA_REMOTE_TOKEN" \
      "node broker/enroll.mjs $AGENT, then: gh secret set VELA_REMOTE_TOKEN"

lsof -tiTCP:"$GATEWAY_PORT" -sTCP:LISTEN >/dev/null 2>&1 ||
  die "nothing is listening on :$GATEWAY_PORT" "./scripts/up.sh"

# The mandate has to be on the chip, and in the slot the broker expects — the
# runner's token names an agent, and the gateway resolves that to a slot. A
# regrant that lands somewhere else authenticates fine and reads the wrong
# envelope.
echo "checking the envelope"
WANT=$(python3 -c "
import json
d = json.load(open('broker/fleet.json'))
for a in d['agents'].values():
    if a['label'] == '$AGENT':
        print(a['slot']); break
" 2>/dev/null)
[ -n "$WANT" ] || die "the broker has no agent called $AGENT" \
                      "node broker/enroll.mjs $AGENT"

OP=$(cat .vela-operator-token 2>/dev/null)
SLOTS=$(curl -s -m 25 -H "x-vela-operator: $OP" \
        "http://127.0.0.1:$GATEWAY_PORT/mandates") ||
  die "the gateway did not answer" "./scripts/up.sh"

HAVE=$(printf '%s' "$SLOTS" | python3 -c "
import json, sys
try: d = json.load(sys.stdin)
except Exception: sys.exit(0)
for s in d.get('slots', []):
    if s.get('label') == '$AGENT':
        print(s['slot']); break
")
if [ -z "$HAVE" ]; then
  die "'$AGENT' has no envelope on the chip" \
      "grant one — it is one tap: node hedera/grant-one.mjs $AGENT 0.05 0.01"
fi
if [ "$HAVE" != "$WANT" ]; then
  die "'$AGENT' is in slot $HAVE on the chip but slot $WANT in the broker" \
      "node broker/enroll.mjs $AGENT   (re-registers the slot, prints a new token)"
fi
echo "  $AGENT is in slot $HAVE, on the chip and in the broker"

# --- 2. the tunnel --------------------------------------------------------
#
# Reused if one is already up, because opening a second would change the URL
# under an agent that is mid-run.
OURS=""
GW=""
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  GW=$(grep -oE 'url=https://[a-z0-9.-]+' "$LOG" 2>/dev/null | tail -1 | cut -d= -f2-)
  [ -n "$GW" ] && echo "reusing the open tunnel"
fi
if [ -z "$GW" ]; then
  VELA_TUNNEL_QUIET=1 ./scripts/remote-agent.sh || exit 1
  OURS=1
  GW=$(grep -oE 'url=https://[a-z0-9.-]+' "$LOG" 2>/dev/null | tail -1 | cut -d= -f2-)
fi
[ -n "$GW" ] || die "the tunnel did not come up" "./scripts/remote-agent.sh"

# Close it on the way out however we leave — a tunnel that outlives a failed
# run is a loopback gateway quietly left on the internet.
cleanup() {
  if [ -n "$OURS" ] && [ -z "$KEEP" ]; then
    echo
    ./scripts/remote-agent.sh --stop
  fi
}
trap cleanup EXIT

# --- 3. dispatch ----------------------------------------------------------
echo
echo "dispatching to GitHub — the runner is not this laptop"
BEFORE=$(gh run list --workflow="$WORKFLOW" --limit 1 --json databaseId \
         --jq '.[0].databaseId' 2>/dev/null)
gh workflow run "$WORKFLOW" -f gateway="$GW" || die "gh could not dispatch"

# The run does not exist the instant dispatch returns.
ID=""
for _ in $(seq 1 30); do
  sleep 2
  ID=$(gh run list --workflow="$WORKFLOW" --limit 1 --json databaseId \
       --jq '.[0].databaseId' 2>/dev/null)
  [ -n "$ID" ] && [ "$ID" != "$BEFORE" ] && break
  ID=""
done
[ -n "$ID" ] || die "the run never appeared" "gh run list --workflow=$WORKFLOW"

echo "  run $ID  ·  $(gh run view "$ID" --json url --jq .url 2>/dev/null)"
echo

# --- 4. follow it ---------------------------------------------------------
gh run watch "$ID" --interval 5 --exit-status
STATUS=$?

# --- 5. what the chip did -------------------------------------------------
#
# The run's own log, filtered to the two lines that are the point. Reading a
# GitHub log in a browser to find out whether a Secure Element said no is the
# thing this script exists to remove.
echo
echo "what happened on hardware we do not own:"
gh run view "$ID" --log 2>/dev/null |
  grep -E '"paid"|"refused"|"reason"|over_per_call|Secure Element|no address' |
  sed 's/^[^ ]*Z //' | sed 's/^/  /' | head -20

echo
if [ "$STATUS" = "0" ]; then
  echo "  the runner paid inside the ceiling and was refused above it."
  echo "  neither decision was made on this machine."
else
  echo "  the run did not pass — the log is above, in full at:"
  echo "  $(gh run view "$ID" --json url --jq .url 2>/dev/null)"
fi
exit $STATUS
