#!/bin/sh
set -e

# ECS secrets injection puts the keypair JSON into env vars.
# Write them to temp files so the keeper can load them via KEYPAIR_PATH / ADMIN_KEYPAIR_PATH.
printf '%s' "${KEEPER_KEYPAIR_JSON}"       > /tmp/keeper-keypair.json
printf '%s' "${KEEPER_ADMIN_KEYPAIR_JSON}" > /tmp/admin-keypair.json

exec node dist/index.js
