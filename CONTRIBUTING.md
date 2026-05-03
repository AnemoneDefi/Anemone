# Contributing — local dev setup

This doc gets you from a clean machine to running the full Anemone test suite (program + 37 SDK E2E tests against a local mainnet fork) in one sitting.

If you already have Rust + Solana + Anchor + Node installed, skip to [Repo layout](#repo-layout).

---

## Tools to install

### Rust toolchain

Required by the program build (`anchor build`) and by `just`.

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### `just`

The single task runner this repo uses. Install once:

```bash
cargo install just
```

### Solana CLI

The program deploy tool. Anchor 0.32 expects Solana 1.18+.

```bash
sh -c "$(curl -sSfL https://release.solana.com/stable/install)"
```

Verify: `solana --version`

### Anchor

Version-specific. The IDL format and compiled bytecode are tied to the Anchor minor version.

```bash
cargo install --git https://github.com/coral-xyz/anchor avm
avm install 0.32.1
avm use 0.32.1
```

Verify: `anchor --version` should print `0.32.1`.

### Surfpool

A mainnet-fork Solana validator. We use it for E2E because it lets us hit Kamino's real on-chain reserves without spending mainnet SOL.

Install per the [surfpool repo](https://github.com/txtx/surfpool). Verify: `surfpool --version`.

### Node + Yarn

`anemone/` uses yarn, `SDK/` uses npm. Node 18+.

```bash
npm install -g yarn
```

---

## Solana wallet

Create a keypair and point the CLI at the local validator:

```bash
solana-keygen new --outfile ~/.config/solana/id.json
solana config set --url http://127.0.0.1:8899
```

The wallet needs SOL on whatever cluster you're targeting. Surfpool can airdrop:

```bash
solana airdrop 100 --url http://127.0.0.1:8899
```

---

## Repo layout

The justfile assumes the program repo and the SDK repo are **siblings** in the same parent directory:

```
~/projects/
  ├── Anemone/    # clone of AnemoneDefi/Anemone — has the program, justfile, scripts
  └── SDK/        # clone of AnemoneDefi/SDK     — has the TypeScript client + E2E
```

Clone both:

```bash
mkdir ~/projects && cd ~/projects
git clone https://github.com/AnemoneDefi/Anemone.git
git clone https://github.com/AnemoneDefi/SDK.git
```

If you clone into different folder names (e.g. `anemone-program/` and `anemone-sdk/`), you'll need to edit `Anemone/justfile`'s `SDK_DIR := "../SDK"` to match.

---

## Install dependencies

```bash
cd ~/projects/Anemone && yarn install
cd ~/projects/SDK && npm install
```

---

## First sanity check (no chain)

From `Anemone/`:

```bash
just test-local
```

Runs `cargo test -p anemone` (program math), the SDK's 99 unit tests, and a TypeScript type-check. Total ~5 seconds. If this fails, something in the toolchain is wrong; fix that before moving on.

---

## Full E2E pipeline (with surfpool)

From `Anemone/`:

```bash
just bootstrap-surfpool
```

This chains: `build-dev` → `surfpool-start` → `deploy-surfpool` → `setup-surfpool`. Idempotent — skips surfpool start if already running.

Then:

```bash
just test-e2e        # 37 tests, ~15 min
# or
just test-e2e-fast   # 37 minus the 3 long-wait tests, ~2 min
# or
just test-everything # bootstrap + Rust + SDK unit + 37 E2E, ~25 min from cold
```

Run `just` (no args) for the full menu of recipes.

---

## Things to know before you panic

### The deploy step is slow and looks frozen

`solana program deploy` on surfpool can take 5-10 minutes and the CLI sits silent for long stretches. **It's not stuck.** Surfpool processes program-data uploads on a single thread; the CLI sends ~720 small transactions and surfpool drains them at ~6 TPS.

If it looks really stuck (>15 min with no progress), check whether the upgrade actually landed:

```bash
solana program show KQs6ci5FtedFKPVJThAZSMMXyosK4TvnF7kcDSx5Jwd --url http://127.0.0.1:8899
```

If `Last Deployed In Slot` is recent and `Data Length` matches `target/deploy/anemone.so`'s size, the program is up — kill the CLI (Ctrl+C) and continue. The CLI's stuck phase is buffer cleanup, not the actual code upgrade.

### Surfpool reset wipes your program

If you stop and restart surfpool, the deployed program is gone. You'll need to `just bootstrap-surfpool` again.

### Orphan buffer accounts cost SOL

Every interrupted deploy leaves a ~5 SOL buffer account hanging on-chain. To list and recover them:

```bash
solana program show --buffers --url http://127.0.0.1:8899
solana program close <BUFFER_ADDRESS> --bypass-warning --url http://127.0.0.1:8899
```

### Pyth staleness after long surfpool sessions

If surfpool runs for several hours without restart, Kamino's internal Pyth/Switchboard staleness check (180s threshold) can start failing. Symptom: `Price is too old token=[USDC]` in test logs. Fix: restart surfpool, run `just bootstrap-surfpool` again.

### Don't accidentally deploy to mainnet/devnet

The justfile recipes hardcode `RPC_URL := "http://127.0.0.1:8899"`. If you run a raw `solana program deploy` without `--url`, the Solana CLI uses whatever's in `solana config get` — could be mainnet if you forgot to switch back. **Always check `solana config get` before running raw CLI commands.**

### `build-mainnet` vs `build-dev`

| Recipe | Features | Use for |
|---|---|---|
| `just build-dev` | `dev-tools` | local testing, surfpool E2E (exposes `set_rate_index_oracle` for tests) |
| `just build-mainnet` | none | mainnet/devnet (`set_rate_index_oracle` is **excluded** from the IDL and binary) |

Never deploy a `build-dev` artifact to mainnet — it would let the admin push arbitrary rate indices.

### First E2E run is slower

When surfpool is fresh, the first E2E suite takes ~25 min instead of ~15 because it needs to lazy-fork Kamino's reserve, lending market, and Scope price accounts from mainnet on demand. Subsequent runs reuse the fork and are faster.

---

## Quick reference

```bash
# Cold start, full validation
just bootstrap-surfpool   # ~5-10 min (deploy is the slow part)
just test-e2e             # ~15 min

# Single test for a specific area
just test-e2e-one liquidation-organic

# No-chain sanity (every commit)
just test-local           # ~5 sec

# Verify deploy
just verify-deploy

# Surfpool lifecycle
just surfpool-start
just surfpool-stop
just surfpool-logs        # tails /tmp/surfpool.log
```

---

## Reach out if

- You hit a TypeScript error in the SDK after pulling — likely the program IDL drifted; check whether the SDK has a re-sync PR open.
- Tests pass individually but fail in the suite — surfpool state pollution; restart surfpool.
- Setup-surfpool fails with `AccountOwnedByWrongProgram` on `treasury` — your wallet's USDC ATA isn't created yet; the SDK's `bootstrapEnvironment` creates it idempotently, so just running `just test-e2e` once is enough to populate it (the bootstrap will leave the protocol initialized for next time).
