#!/usr/bin/env bash
# Run the agent as a host with no device.
#
# Deliberately explicit about what is *not* passed: no --device, no volume,
# no secret. If this command grew any of those the demonstration would be
# over, so it is worth being able to read the whole thing at once.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

docker build -q -t vela-agent . >/dev/null

exec docker run --rm \
  -e AGENT_NAME="${AGENT_NAME:-research-1}" \
  -e AGENT_TOKEN="${AGENT_TOKEN:?set AGENT_TOKEN — mint one with: node broker/enroll.mjs <label>}" \
  -e BROKER="http://host.docker.internal:${BROKER_PORT:-4060}" \
  -e GATEWAY="http://host.docker.internal:${GATEWAY_PORT:-4030}" \
  -e COUNTERPARTIES="${COUNTERPARTIES:-0.0.10388937,0.0.66666666,0.0.10365984}" \
  --add-host=host.docker.internal:host-gateway \
  vela-agent
