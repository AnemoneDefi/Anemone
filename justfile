# Anemone — single task runner for the program AND the SDK.
#
# Install just once:  cargo install just  (or  brew/apt install just)
#
# Always run from the anemone/ directory:
#   just <recipe>     e.g. `just test-e2e`
#   just              # list all recipes
#
# The SDK lives at ../SDK and is invoked here via `cd {{SDK_DIR}}`.

set shell := ["bash", "-cu"]
set dotenv-load := false

PROGRAM_ID := "KQs6ci5FtedFKPVJThAZSMMXyosK4TvnF7kcDSx5Jwd"
RPC_URL    := "http://127.0.0.1:8899"
SDK_DIR    := "../SDK"

# Default — list available recipes.
default:
    @just --list

# ============================================================================
# program — build / lint / unit tests (Rust + Anchor)
# ============================================================================

# Build with the dev-tools feature (exposes set_rate_index_oracle). Required
# for the SDK's organic-liquidation + multi-settlement E2E tests. Surfpool /
# devnet / localnet only — never mainnet.
build-dev:
    anchor build -- --no-default-features --features dev-tools

# Mainnet build: no dev-tools, no stub-oracle. Excludes set_rate_index_oracle
# from both the IDL and the program binary.
build-mainnet:
    anchor build -- --no-default-features

# Pure-Rust unit tests for the program. ~30 tests covering math helpers
# (calculate_period_pnl, calculate_initial_margin, spread_bps, etc.).
test-rust:
    cargo test -p anemone

# Anchor TypeScript tests against solana-test-validator (NOT surfpool).
# Uses the kamino-lend fixture in tests/fixtures/.
test-anchor:
    anchor test

# ============================================================================
# surfpool lifecycle
# ============================================================================

# Start surfpool in the background. Logs to /tmp/surfpool.log. Blocks until
# RPC is reachable so chained recipes can rely on it.
surfpool-start:
    @if pgrep -af "^surfpool start" > /dev/null; then \
       echo "surfpool already running (pid $(pgrep -f '^surfpool start'))"; \
     else \
       nohup surfpool start --no-tui > /tmp/surfpool.log 2>&1 & \
       echo "surfpool starting (logs: /tmp/surfpool.log)"; \
       until curl -sf -o /dev/null -X POST -H 'Content-Type: application/json' \
         -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' {{RPC_URL}}; do sleep 1; done; \
       echo "surfpool ready at {{RPC_URL}}"; \
     fi

# Kill the surfpool process.
surfpool-stop:
    @pkill -f "^surfpool start" && echo "surfpool stopped" || echo "no surfpool running"

# Tail surfpool's log.
surfpool-logs:
    tail -f /tmp/surfpool.log

# ============================================================================
# deploy + setup (surfpool only)
# ============================================================================

# Upload the built program to surfpool. Uses --use-rpc + 200 retries because
# the default TPU path is flaky against surfpool's slow slot production.
deploy-surfpool:
    solana program deploy target/deploy/anemone.so \
      --program-id target/deploy/anemone-keypair.json \
      --url {{RPC_URL}} \
      --use-rpc \
      --max-sign-attempts 200

# Initialize protocol + market on the deployed program.
setup-surfpool:
    yarn ts-node scripts/setup-surfpool.ts

# Full pipeline: build → start surfpool → deploy → setup. Idempotent: skips
# surfpool start if already running, deploy still re-uploads.
bootstrap-surfpool: build-dev surfpool-start deploy-surfpool setup-surfpool

# Verify the deployed program (sanity check before running E2E).
verify-deploy:
    solana program show {{PROGRAM_ID}} --url {{RPC_URL}}

# ============================================================================
# SDK — unit + E2E (delegates to ../SDK)
# ============================================================================

# 99 mocked unit tests for the SDK. No chain required.
test-sdk-unit:
    cd {{SDK_DIR}} && npx vitest run

# Type-check the SDK. Cheap sanity gate.
typecheck-sdk:
    cd {{SDK_DIR}} && npx tsc --noEmit

# Run the SDK's E2E suite against surfpool (15 files / 37 tests / ~15 min).
# Assumes surfpool is running with the dev-tools program deployed.
test-e2e: _check-rpc
    cd {{SDK_DIR}} && npx vitest run --config e2e/vitest.e2e.config.ts

# Run a single E2E file. Usage:
#   just test-e2e-one liquidation-organic
#   just test-e2e-one multi-settlement
test-e2e-one TEST: _check-rpc
    cd {{SDK_DIR}} && npx vitest run --config e2e/vitest.e2e.config.ts e2e/{{TEST}}.e2e.test.ts

# Run E2E excluding the 3 slow tests (claim-matured 305s, settle-period 65s,
# multi-settlement 250s). ~2 min instead of ~15.
test-e2e-fast: _check-rpc
    cd {{SDK_DIR}} && npx vitest run --config e2e/vitest.e2e.config.ts \
      --exclude e2e/claim-matured.e2e.test.ts \
      --exclude e2e/settle-period.e2e.test.ts \
      --exclude e2e/multi-settlement.e2e.test.ts

# ============================================================================
# top-level aggregations
# ============================================================================

# Full pipeline from cold: builds the program, starts/deploys to surfpool,
# initializes protocol, runs ALL tests (Rust + SDK unit + 37 E2E).
# Expect ~25 min total.
test-everything: bootstrap-surfpool test-rust test-sdk-unit test-e2e

# Quick local sanity: Rust unit tests + SDK unit tests + typecheck.
# No chain required, ~5s.
test-local: test-rust test-sdk-unit typecheck-sdk

# ============================================================================
# internal helpers (prefixed with _ — hidden by `just --list`)
# ============================================================================

# Reachability check for surfpool — fails fast with a clear message if down.
_check-rpc:
    @curl -sf -o /dev/null -X POST -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' {{RPC_URL}} \
      || (echo "ERROR: {{RPC_URL}} is not responding. Run:" \
          && echo "       just surfpool-start" \
          && echo "       just bootstrap-surfpool   (if program is also missing)" \
          && exit 1)
