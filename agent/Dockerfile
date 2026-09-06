# A host with no port to plug a Ledger into.
#
# The point of containerising this is not deployment. It is that the claim
# "this machine holds nothing" can be checked rather than believed: no volume
# mounts, no --device, no environment carrying a key. Everything the agent can
# reach is two URLs passed in at run time.
FROM node:22-alpine

WORKDIR /agent
COPY agent.mjs .

# No package.json and no dependencies. Anything installed here would be one
# more thing a reader has to audit before believing the inventory the agent
# prints about itself.
USER node

ENTRYPOINT ["node", "agent.mjs"]
