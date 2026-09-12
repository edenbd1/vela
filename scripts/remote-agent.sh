#!/usr/bin/env bash
# The half of "machines you do not control" that used to be on this laptop.
#
# Enrolment already runs somewhere neither of us owns: a GitHub Actions runner
# joins the Key Ring on every push and the log is public. Spending did not.
# The agent container has no device, no volume and no key — but it ran here,
# on the same machine as the chip, and a reader is entitled to ask whether
# that was doing any work.
#
# It was not. The container reaches the gateway over HTTP and does not care
# where it is. This puts the gateway on a public URL so an agent anywhere can
# spend inside a mandate held in a Secure Element it has never seen.
#
# WHAT THIS EXPOSES, stated plainly, because it is a decision and not a detail
#
#   One loopback service becomes reachable from the internet for as long as
#   this runs. Three things bound what that is worth to somebody who finds
#   the URL:
#
#     every write path needs a token. Draws need a bearer token whose SHA-256
#     is registered against a slot; the operator paths need x-vela-operator.
#     There is no unauthenticated write.
#
#     the URL dies with this process.
#
#     and the part that is the whole project: even a leaked agent token buys
#     only what its mandate allows. One payee, a ceiling per draw, a budget,
#     and a rate. The blast radius of a fully compromised token is the
#     envelope — which is the claim this repository exists to make, tested
#     here rather than asserted.
#
#   What it does NOT bound: availability. Anyone with the URL can burn an
#   envelope down to zero against its allowlisted payee. Grant a disposable
#   one — hedera/grant-one.mjs — rather than pointing this at the fleet.
#
# WHICH TUNNEL
#
#   ngrok, because cloudflared's quick tunnels did not work here: the tunnel
#   registered, the hostname resolved, and every request came back 404 from
#   Cloudflare's edge. ngrok needs an authtoken and gives a stable free
#   hostname, which is better for a demo anyway.
#
#   Its inspector wants port 4040, and so does hedera/risk.mjs. ngrok wins the
#   race silently, and every screen_counterparty call then gets ngrok's 404
#   instead of the risk feed. So it is moved here rather than debugged again
#   at midnight.
#
#   ./scripts/remote-agent.sh            # open the tunnel, print the URL
#   ./scripts/remote-agent.sh --stop     # close it
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

GATEWAY_PORT="${GATEWAY_PORT:-4030}"
CONF=/tmp/vela-ngrok.yml
LOG=/tmp/vela-ngrok.log
PIDFILE=/tmp/vela-ngrok.pid

stop() {
  # Only ours. `pkill -f ngrok` would also take a tunnel the operator happens
  # to be running for something else, which is a thing that has happened.
  if [ -f "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null && echo "tunnel closed"
    rm -f "$PIDFILE"
  else
    echo "no tunnel of ours is running"
  fi
  rm -f "$CONF"
}

[ "${1:-}" = "--stop" ] && { stop; exit 0; }

command -v ngrok >/dev/null || {
  echo "ngrok is not installed:  brew install ngrok"
  echo "then:  ngrok config add-authtoken <token>"
  exit 1
}

lsof -tiTCP:"$GATEWAY_PORT" -sTCP:LISTEN >/dev/null 2>&1 || {
  echo "nothing is listening on :$GATEWAY_PORT — ./scripts/up.sh first"
  exit 1
}

AUTH=$(python3 -c 'import re,pathlib,sys
for p in ("~/Library/Application Support/ngrok/ngrok.yml", "~/.config/ngrok/ngrok.yml"):
    f = pathlib.Path(p).expanduser()
    if f.exists():
        m = re.search(r"authtoken:\s*(\S+)", f.read_text())
        if m:
            print(m.group(1)); break')

[ -n "$AUTH" ] || { echo "no ngrok authtoken:  ngrok config add-authtoken <token>"; exit 1; }

stop >/dev/null 2>&1

umask 077
{
  echo 'version: "3"'
  echo 'agent:'
  echo "  authtoken: $AUTH"
  echo '  web_addr: 127.0.0.1:4141'
  echo 'endpoints:'
  echo '  - name: gateway'
  echo '    upstream:'
  echo "      url: $GATEWAY_PORT"
} > "$CONF"

echo
echo "opening a tunnel — this makes the gateway reachable from the internet"
ngrok start --all --config "$CONF" --log stdout > "$LOG" 2>&1 &
echo $! > "$PIDFILE"

GW=""
for _ in $(seq 1 30); do
  GW=$(grep -oE 'url=https://[a-z0-9.-]+' "$LOG" 2>/dev/null | tail -1 | cut -d= -f2-)
  [ -n "$GW" ] && break
  sleep 1
done
[ -n "$GW" ] || { echo "  the tunnel did not come up:"; tail -5 "$LOG"; stop; exit 1; }

echo
echo "  gateway   $GW"
echo

code=$(curl -s -m 30 -o /dev/null -w "%{http_code}" \
       -H "ngrok-skip-browser-warning: 1" "$GW/mandates")
if [ "$code" = "200" ]; then
  echo "  the chip answers through the tunnel."
else
  echo "  the tunnel is up but the gateway answered $code through it."
fi

# The risk feed and ngrok's inspector both want 4040. If this ever prints, the
# config above stopped working rather than the feed breaking on its own.
if [ "$(lsof -tiTCP:4040 -sTCP:LISTEN | wc -l | tr -d ' ')" != "1" ]; then
  echo
  echo "  WARNING: something else is on :4040 next to hedera/risk.mjs."
  echo "  screen_counterparty will get its 404 instead of the risk feed."
fi

# scripts/runner-spend.sh does every one of these steps itself, so printing
# them there tells the reader to go and do by hand what the thing they just
# ran is three seconds from doing for them.
[ -n "${VELA_TUNNEL_QUIET:-}" ] && exit 0

cat <<TXT

Run the workflow against it — GitHub's hardware, not this laptop:

    gh workflow run "spend from a machine we do not control" \\
       -f gateway=$GW

It needs a disposable envelope and a token registered for it:

    node hedera/grant-one.mjs remote-1 0.05 0.01     # one tap
    node broker/enroll.mjs remote-1                  # prints the token once
    gh secret set VELA_REMOTE_TOKEN

That runner holds no key, no device and no envelope. The ceiling it cannot
exceed is in NVRAM on a Flex it has no address for.

    ./scripts/remote-agent.sh --stop      when you are done
TXT
