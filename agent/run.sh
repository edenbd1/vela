#!/usr/bin/env bash
# Run the agent as a host with no device.
#
# Deliberately explicit about what is *not* passed: no --device, no volume,
# no secret, no model weights. If this command grew any of those the
# demonstration would be over, so it is worth being able to read the whole
# thing at once.
#
#   ./agent/run.sh              the reasoning agent
#   ./agent/run.sh agent.mjs    the scripted walk-through
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

docker build -q -t vela-agent . >/dev/null

# Where the token comes from.
#
# AGENT_TOKEN in the environment is the direct path and the one that shows up
# in a shell history. If this host has been enrolled in the Key Ring, prefer
# the sealed bundle instead: the token is decrypted here, for the length of
# one docker run, using a key this host derives from its own membership. It
# was never on the wire in the clear and it is not in anyone's history.
# The bundle is named for the *host* that was enrolled, not the agent — one
# enrolled host may run several agents, and it is the host that holds the
# membership. Its own name is in .member.json.
MEMBER="../host/ring/.member.json"
if [ -z "${VELA_BUNDLE:-}" ] && [ -f "$MEMBER" ]; then
  VELA_BUNDLE="../host/ring/bundle-$(node -p "require('$MEMBER').name").json"
fi
BUNDLE="${VELA_BUNDLE:-}"
if [ -z "${AGENT_TOKEN:-}" ] && [ -n "$BUNDLE" ] && [ -f "$BUNDLE" ]; then
  echo "  token from the Key Ring bundle, not from the environment" >&2
  SEALED="$(node ../host/ring/enroll.cjs claim "$BUNDLE" --quiet)"
  # One host, one membership, several agents — so the sealed value is a JSON
  # object from agent label to token. A bare string is what a single-agent
  # host sealed before that and still means "the token, for whoever asks".
  AGENT_TOKEN="$(SEALED="$SEALED" NAME="${AGENT_NAME:-research-1}" node -e '
    const s = process.env.SEALED ?? "";
    try {
      const m = JSON.parse(s);
      process.stdout.write(typeof m === "object" && m
        ? (m[process.env.NAME] ?? "") : s);
    } catch { process.stdout.write(s); }
  ')"
  [ -n "$AGENT_TOKEN" ] || {
    echo "  the bundle carries no token for '${AGENT_NAME:-research-1}'" >&2
    echo "  seal one:  node broker/enroll.mjs ${AGENT_NAME:-research-1}" >&2
    exit 1
  }
  export AGENT_TOKEN
fi

# Ollama binds to 127.0.0.1, and Docker Desktop's host.docker.internal proxies
# through to the host loopback, so this works as written on macOS. On Linux,
# where --add-host points at the real host IP, start it with
# OLLAMA_HOST=0.0.0.0 or run the agent on the host instead.

exec docker run --rm \
  -e AGENT_NAME="${AGENT_NAME:-research-1}" \
  -e AGENT_TOKEN="${AGENT_TOKEN:?set AGENT_TOKEN — mint one with: node broker/enroll.mjs <label>}" \
  -e BROKER="http://host.docker.internal:${BROKER_PORT:-4060}" \
  -e GATEWAY="http://host.docker.internal:${GATEWAY_PORT:-4030}" \
  -e OLLAMA="http://host.docker.internal:${OLLAMA_PORT:-11434}" \
  -e AGENT_MODEL="${AGENT_MODEL:-hermes3:8b}" \
  -e COUNTERPARTIES="${COUNTERPARTIES:-0.0.10388937,0.0.66666666,0.0.10365984}" \
  --add-host=host.docker.internal:host-gateway \
  vela-agent "${@:-reason.mjs}"
