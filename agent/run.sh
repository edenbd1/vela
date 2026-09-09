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
