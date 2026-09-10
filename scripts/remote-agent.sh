#!/usr/bin/env bash
# The half of "machines you do not control" that is still on this laptop.
#
# Enrolment already runs somewhere neither of us owns: a GitHub Actions runner
# joins the Key Ring on every push and the log is public. Spending does not.
# The agent container has no device, no volume and no key — but it runs here,
# on the same machine as the chip, and a reader is entitled to ask whether
# that is doing any work.
#
# It is not. The container reaches the gateway over HTTP and does not care
# where it is. This puts the gateway and the broker on a public URL so an
# agent anywhere can spend inside a mandate held in a Secure Element it has
# never seen.
#
# WHAT THIS EXPOSES, stated plainly, because it is a decision and not a detail
#
#   Two loopback services become reachable from the internet for as long as
#   this runs. Three things bound what that is worth to somebody who finds
#   the URL:
#
#     every write path needs a token. Draws need a bearer token whose SHA-256
#     is registered against a slot; the operator paths need x-vela-operator.
#     There is no unauthenticated write.
#
#     the URL is a random *.trycloudflare.com name, not a guessable one, and
#     it dies with this process.
#
#     and the part that is the whole project: even a leaked agent token buys
#     only what its mandate allows. One payee, a ceiling per draw, a budget,
#     and a rate. The blast radius of a fully compromised token is the
#     envelope — which is the claim this repository exists to make, tested
#     here rather than asserted.
#
#   What it does NOT bound: availability. Anyone with the URL can burn an
#   envelope down to zero against its allowlisted payee. Do not run this
#   against mandates you care about, and revoke when you are done.
#
#   ./scripts/remote-agent.sh            # open the tunnels, print the URLs
#   ./scripts/remote-agent.sh --stop     # close them
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

GATEWAY_PORT="${GATEWAY_PORT:-4030}"
BROKER_PORT="${BROKER_PORT:-4060}"
RUN=/tmp/vela-tunnel

stop() {
  local n=0
  for f in "$RUN"-*.pid; do
    [ -f "$f" ] || continue
    kill "$(cat "$f")" 2>/dev/null && n=$((n + 1))
    rm -f "$f"
  done
  rm -f "$RUN"-*.log
  echo "closed $n tunnel(s)"
}

[ "${1:-}" = "--stop" ] && { stop; exit 0; }

command -v cloudflared >/dev/null || {
  echo "cloudflared is not installed:  brew install cloudflared"
  exit 1
}

# A tunnel to a port nothing is listening on is a URL that 502s, and the
# failure would land on the agent as an unreachable gateway rather than as
# "you forgot to start it".
for p in "$GATEWAY_PORT" "$BROKER_PORT"; do
  lsof -tiTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 || {
    echo "nothing is listening on :$p — ./scripts/up.sh first"
    exit 1
  }
done

stop >/dev/null

open_tunnel() {
  local name="$1" port="$2" log="$RUN-$1.log"
  cloudflared tunnel --url "http://127.0.0.1:$port" --no-autoupdate > "$log" 2>&1 &
  echo $! > "$RUN-$name.pid"
  for _ in $(seq 1 40); do
    local url
    url=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$log" 2>/dev/null | head -1)
    [ -n "$url" ] && { echo "$url"; return 0; }
    sleep 1
  done
  echo ""
  return 1
}

echo
echo "opening tunnels — this makes two loopback services public"
GW=$(open_tunnel gateway "$GATEWAY_PORT") || { echo "  gateway tunnel did not come up"; stop; exit 1; }
BK=$(open_tunnel broker  "$BROKER_PORT")  || { echo "  broker tunnel did not come up";  stop; exit 1; }

echo
echo "  gateway   $GW"
echo "  broker    $BK"
echo

# Prove it before telling anyone it works. /mandates is a read and needs no
# token, which makes it the right liveness check and the wrong thing to leave
# running longer than a demo.
if curl -s -m 20 "$GW/mandates" | grep -q '"slots"'; then
  echo "  the chip answers through the tunnel."
else
  echo "  the tunnel is up but the gateway did not answer through it."
fi

cat <<TXT

From any machine, with a token minted for one of these envelopes:

    docker run --rm \\
      -e AGENT_NAME=research-1 -e AGENT_TOKEN=<token> \\
      -e GATEWAY=$GW \\
      -e BROKER=$BK \\
      -e OLLAMA=<a model runtime that host can reach> \\
      vela-agent

That host holds no key, no device and no envelope. The ceiling it cannot
exceed is in NVRAM on a Flex it has no address for.

    ./scripts/remote-agent.sh --stop      when you are done
TXT
