# A host with no port to plug a Ledger into.
#
# The point of containerising this is not deployment. It is that the claim
# "this machine holds nothing" can be checked rather than believed: no volume
# mounts, no --device, no environment carrying a key. Everything the agent can
# reach is three URLs passed in at run time — the broker, the payment gateway,
# and the model. Not even the weights are in here.
FROM node:22-alpine

WORKDIR /agent
COPY agent.mjs reason.mjs ./

# No package.json and no dependencies. Anything installed here would be one
# more thing a reader has to audit before believing the inventory the agent
# prints about itself.
USER node

# reason.mjs is the one that decides; agent.mjs is the scripted walk-through
# kept for the parts of the demo that should not depend on a model's mood.
ENTRYPOINT ["node"]
CMD ["reason.mjs"]
