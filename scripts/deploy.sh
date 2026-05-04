#!/usr/bin/env bash
#
# scripts/deploy.sh — defensive deploy wrapper for Anemone
#
# Why this exists: `anchor deploy` has zero guardrails. Typing the wrong
# cluster in solana config, forgetting to run `yarn build:mainnet`, or
# leaving the upgrade authority on the dev wallet are all one-command
# routes to an unrecoverable mistake. This script fails loudly before any
# of those reach the runtime.
#
# Usage:
#   yarn deploy:devnet                        # deploys, rejects unless UPGRADE_AUTHORITY or ALLOW_SINGLE_SIG=1
#   yarn deploy:mainnet                       # deploys, rejects unless UPGRADE_AUTHORITY set AND != local wallet
#   UPGRADE_AUTHORITY=<SQUAD_ADDR> yarn deploy:devnet
#   ALLOW_SINGLE_SIG=1 yarn deploy:devnet     # iteration mode — single-sig deploy, no guardrail on authority
#
# Assumptions:
#   - Run from the `anemone/` directory (yarn resolves it that way)
#   - `solana` and `anchor` CLIs are on PATH
#   - target/deploy/anemone-keypair.json and target/idl/anemone.json exist
#     (i.e. `anchor build` or `yarn build:mainnet` already ran)

set -euo pipefail

PROGRAM_NAME="anemone"
IDL_PATH="target/idl/${PROGRAM_NAME}.json"
PROGRAM_KEYPAIR="target/deploy/${PROGRAM_NAME}-keypair.json"

fail() {
    echo "ERROR: $*" >&2
    exit 1
}

require_file() {
    [ -f "$1" ] || fail "$1 not found — run \`anchor build\` (devnet) or \`yarn build:mainnet\` (mainnet) first"
}

confirm() {
    local prompt="$1"
    read -r -p "$prompt [y/N]: " reply
    [[ "$reply" =~ ^[Yy]$ ]] || fail "Aborted by operator"
}

# Cluster detection via solana config
SOLANA_CONFIG=$(solana config get)
CLUSTER_URL=$(echo "$SOLANA_CONFIG" | awk '/RPC URL:/ {print $3}')
WALLET_PATH=$(echo "$SOLANA_CONFIG" | awk '/Keypair Path:/ {print $3}')

[ -n "$CLUSTER_URL" ] || fail "Could not parse RPC URL from \`solana config get\`"
[ -f "$WALLET_PATH" ] || fail "Local wallet not found at $WALLET_PATH"

LOCAL_PUBKEY=$(solana-keygen pubkey "$WALLET_PATH")

# Classify cluster
if [[ "$CLUSTER_URL" == *"mainnet"* ]]; then
    CLUSTER="mainnet"
elif [[ "$CLUSTER_URL" == *"devnet"* ]]; then
    CLUSTER="devnet"
elif [[ "$CLUSTER_URL" == *"localhost"* ]] || [[ "$CLUSTER_URL" == *"127.0.0.1"* ]]; then
    fail "Refusing to use deploy.sh against localnet — use \`anchor deploy\` directly for local testing"
else
    fail "Unrecognised cluster URL: $CLUSTER_URL"
fi

require_file "$IDL_PATH"
require_file "$PROGRAM_KEYPAIR"
PROGRAM_ID=$(solana-keygen pubkey "$PROGRAM_KEYPAIR")

echo
echo "================================================================"
echo "  Anemone deploy"
echo "  Cluster:      $CLUSTER ($CLUSTER_URL)"
echo "  Program ID:   $PROGRAM_ID"
echo "  Local wallet: $LOCAL_PUBKEY"
echo "================================================================"

if [ "$CLUSTER" = "mainnet" ]; then
    # ---- MAINNET: hard guardrails, no exceptions
    [ -n "${UPGRADE_AUTHORITY:-}" ] || \
        fail "UPGRADE_AUTHORITY env var required for mainnet — point it at the Squads multisig address"

    [ "$UPGRADE_AUTHORITY" != "$LOCAL_PUBKEY" ] || \
        fail "UPGRADE_AUTHORITY equals local wallet — that is single-sig disguised as multisig. Refusing."

    # Mainnet must be built via `yarn build:mainnet` (no stub-oracle).
    # If setRateIndexOracle appears in the IDL, the feature flag leaked in.
    if grep -q "setRateIndexOracle" "$IDL_PATH"; then
        fail "IDL contains setRateIndexOracle — stub-oracle feature leaked into a mainnet build. Run \`yarn build:mainnet\` and retry."
    fi

    echo "  Upgrade auth: $UPGRADE_AUTHORITY (multisig)"
    echo
    confirm "DEPLOY TO MAINNET with upgrade authority $UPGRADE_AUTHORITY?"

    anchor deploy --provider.cluster mainnet-beta
    echo
    echo "Transferring upgrade authority to $UPGRADE_AUTHORITY..."
    solana program set-upgrade-authority "$PROGRAM_ID" --new-upgrade-authority "$UPGRADE_AUTHORITY" --skip-new-upgrade-authority-signer-check
    echo "Mainnet deploy complete. Verify with: solana program show $PROGRAM_ID --url mainnet-beta"

elif [ "$CLUSTER" = "devnet" ]; then
    # ---- DEVNET: either multisig OR explicit opt-in to single-sig
    if [ "${ALLOW_SINGLE_SIG:-0}" = "1" ]; then
        echo "  Upgrade auth: $LOCAL_PUBKEY (SINGLE-SIG — ALLOW_SINGLE_SIG=1)"
    elif [ -n "${UPGRADE_AUTHORITY:-}" ]; then
        [ "$UPGRADE_AUTHORITY" != "$LOCAL_PUBKEY" ] || \
            fail "UPGRADE_AUTHORITY equals local wallet. Set ALLOW_SINGLE_SIG=1 for intentional single-sig devnet deploys."
        echo "  Upgrade auth: $UPGRADE_AUTHORITY (Squads)"
    else
        fail "Set UPGRADE_AUTHORITY=<SQUAD_ADDR> for multisig deploy, or ALLOW_SINGLE_SIG=1 for single-sig iteration."
    fi

    echo
    confirm "Deploy to DEVNET?"

    anchor deploy --provider.cluster devnet

    if [ -n "${UPGRADE_AUTHORITY:-}" ] && [ "$UPGRADE_AUTHORITY" != "$LOCAL_PUBKEY" ]; then
        echo
        echo "Transferring upgrade authority to $UPGRADE_AUTHORITY..."
        solana program set-upgrade-authority "$PROGRAM_ID" --new-upgrade-authority "$UPGRADE_AUTHORITY" --skip-new-upgrade-authority-signer-check
    fi

    echo "Devnet deploy complete. Verify with: solana program show $PROGRAM_ID --url devnet"
fi
