# Anemone

**Interest rate swaps on Solana.** Lock a fixed rate on lending yields, or speculate on rate movements — backed by real on-chain interest from external lending markets.

---

## What Anemone is

Anemone is a **Solana-native interest rate swap (IRS) market**. It lets two sides of the same rate trade exist simultaneously without taking liquidity off the table:

- **Traders** open swaps to lock in or speculate on lending rates. PayFixed traders pay a fixed APY and receive the variable rate; ReceiveFixed traders do the opposite. Rates settle periodically against an on-chain rate index pulled from the underlying lending market.

- **LPs** deposit USDC and earn the **base lending yield + spread paid by traders**. Their capital is auto-deployed to the underlying lending market, so it's always working — no idle locked liquidity.

- **Keepers** run a permissionless cron that pulls rate updates, syncs NAV, and rebalances LP capital between the local vault and the lending market. Liquidations are also permissionless (2/3 of the fee goes to the liquidator who calls it).

The first market is built on **Kamino K-Lend (USDC)**. The architecture is designed to extend to other lending protocols and underlying assets — each `(reserve, tenor)` pair becomes its own isolated market.

---

## What you can do with this code

### As a trader

Open a 30-day PayFixed swap to lock in today's 8% APY against tomorrow's possible spike or crash:

```ts
await sdk.trader.openSwap.execute({
  trader: wallet.publicKey,
  market,
  direction: SwapDirection.PayFixed,  // or ReceiveFixed to bet rates fall
  notional: 10_000_000_000n,           // $10,000
  nonce: 1,
  maxRateBps: 1000n,                   // refuse if offered fixed > 10%
  minRateBps: 0n,
  // ...
});
```

Settle periodically (anyone can call), claim at maturity, or close early. Underwater positions (collateral < maintenance margin) get liquidated permissionlessly.

### As an LP

```ts
await sdk.lp.depositLiquidity.execute({ amount: 100_000_000n /* $100 */ });
// USDC flows: lp_vault → Kamino → earns real lending yield
// Trader spreads accrue to lp_nav on every settlement
```

Withdraw any time — `request_withdrawal` is single-shot, redeems Kamino shortfall internally if `lp_vault` is light.

### As a keeper / integrator

```ts
// Every ~3 minutes
await sdk.keeper.updateRateIndex.execute({ /* refresh + read Kamino bsf */ });

// Whenever LP vault drifts vs. ideal Kamino allocation
await sdk.keeper.depositToKamino.execute({ /* idle USDC → Kamino */ });
await sdk.keeper.withdrawFromKamino.execute({ /* refill before settles */ });
```

Or write your own keeper — every operation is permissionless (rate updates, NAV sync, settlements, liquidations) except the Kamino capital moves, which use a rotating `keeper_authority`.

---

## What makes Anemone different

**Dynamic spread pricing.** The fixed rate offered to traders isn't a static number — it's computed live from three components: a base spread, a utilization spread that grows as more LP capital is locked into open positions, and an imbalance spread that grows when the book leans heavily one-sided (lots of PayFixed and few ReceiveFixed, or vice-versa). LPs are compensated more when the book is risky for them; traders pay tighter rates when liquidity is deep and balanced.

**Periodic on-chain settlement.** PnL is realized at a fixed cadence (e.g. daily), not continuously. Each settlement transfers the period's PnL between LP vault and trader collateral based on the actual rate index movement. This makes margin requirements and liquidation rules predictable, and gives keepers a clean window to refill liquidity from the underlying lending market.

**Real yield, not synthetic.** PnL settles against an actual on-chain rate index pulled from the underlying lending market. There's no synthetic peg, oracle wrapper, or off-chain rate feed — the rate trader and the lending market it's tracking are looking at the same byte.

**Capital efficiency for LPs.** LP USDC is never idle. The protocol deploys it to the underlying lending market continuously, so LPs collect the base lending yield AND the spread paid by traders. Most rate-product designs leave LP capital sitting in a reserve.

**Trades the rate itself.** Anemone doesn't tokenize the yield-bearing asset and split it into principal/yield tokens. It exposes a clean interest rate swap: notional × rate delta × time. Closer to traditional rate futures than to fixed-income tokenization.

**Mark-to-market liquidations.** The maintenance-margin check uses MtM-adjusted collateral — collateral remaining plus PnL accrued since the last settlement — not the stale on-account number. This closes a class of griefing where a keeper races settle/liquidate to extract value from a position that's only stale-underwater.

**Atomic redeem-on-shortfall.** When `lp_vault` is light during a claim, close, or liquidation, the program redeems exactly the shortfall from the underlying lending market in the same transaction. Traders never have to wait for a keeper to refill before exiting; griefing the system by draining `lp_vault` doesn't lock anyone in.

**Unpaid PnL catchup.** If the LP vault truly cannot cover a settlement (e.g. mid-spike), the shortfall accrues to the position as `unpaid_pnl`. The next settlement after the keeper refills clears the catchup before applying the new period's PnL. Traders are made whole; LPs absorb timing, not principal.

**Permissionless lifecycle.** Rate updates, NAV sync, settlements, and liquidations can all be triggered by anyone. The keeper bot is a convenience, not a single point of failure. Liquidators earn 2/3 of the liquidation fee, treasury earns 1/3.

**Self-custody by construction.** Trader collateral, LP capital, and lending-market collateral tokens all sit in program-derived addresses. No multi-sig holding user funds, no escrow, no withdrawal queues.

**Layered safety against rate manipulation.** The program rejects rate-index collapse (two updates that produce the same value), stale quotes (>10 min since last update), period growth above a circuit-breaker cap (>5% in one settlement), Token-2022 mints with transfer fees, and dust positions below $10 notional that would grief settlement.

**Fixed-maturity products.** Each market has a tenor (30 days, 90 days, etc.) and a settlement period. Positions claim at maturity with finalized PnL. Perp protocols don't give you that closure; spot lending doesn't give you a forward curve.

**Isolated markets.** Each `(reserve, tenor)` pair is its own PDA-derived market with independent vaults and rate index. A bug or rate spike on one market can't drain another.

---

## Architecture

**Solana program** ([`programs/anemone/`](programs/anemone/)) — Anchor 0.32, 17 instructions, ~3000 lines of Rust with `checked_*` math everywhere, layered defenses against rate-oracle collapse / staleness / circuit-breaker overflow, and feature-gated test utilities (`dev-tools` for surfpool, `stub-oracle` for localnet).

**TypeScript SDK** ([`AnemoneDefi/SDK`](https://github.com/AnemoneDefi/SDK)) — typed `Program<Anemone>` client, 99 unit tests + 37 E2E tests against a real mainnet fork. IDL conformance checked at build time.

**Keeper bot** ([`keeper/`](keeper/)) — Node.js cron worker. Calls `update_rate_index`, `sync_kamino_yield`, manages `lp_vault` ↔ lending market flows. Permissionless settlements + liquidations earn it real fees.

**Frontend** ([`app/`](app/)) — Next.js 15 app: trader UI for opening/closing swaps, LP dashboard, keeper telemetry.

**Markets** are PDAs derived from `[b"market", reserve, tenor_seconds]`. Each market has its own `lp_vault`, `collateral_vault`, `lp_mint`, and lending-market deposit account. The current deployment runs against Kamino's USDC reserve; the same shape supports any reserve from any lending program once the integration is wired (different `(reserve, tenor)` → different PDA → fully isolated market).

---

## Safety model

**LP risk**: counterparty exposure to underwater traders (mitigated by maintenance margin + permissionless liquidation incentive) + Kamino smart contract risk (since capital is deployed there). LPs do NOT lose to bad debt events on Kamino — `sync_kamino_yield` uses saturating subtraction; the protocol absorbs the loss instead of burning LP shares.

**Trader risk**: directional rate exposure capped at collateral. Liquidation fee is 3% of mark-to-market collateral (1/3 to treasury, 2/3 to liquidator).

**Protocol risk**: oracle drift between two `update_rate_index` calls is rejected if growth > 500 bps per period (circuit breaker). Stale `update_rate_index` calls (>10 min) make `open_swap` reject quotes (anti-MEV against a frozen rate oracle).

**Admin powers**: pause protocol, rotate keeper, change fee rates within caps. Cannot drain user funds. Mainnet deploys via `deploy.sh` enforce multisig upgrade authority.

---

## Repository layout

```
anemone/
├── programs/anemone/        # Anchor program (Rust)
├── keeper/                  # Keeper bot (Node.js cron)
├── app/                     # Next.js 15 frontend
├── tests/                   # Anchor test suite (TypeScript via mocha)
├── scripts/                 # setup-surfpool, setup-devnet, deploy.sh
├── runbooks/                # Operational playbooks
├── Anchor.toml              # Anchor build/test config
└── Cargo.toml               # Rust workspace
```

The TypeScript SDK lives in a separate repo: [AnemoneDefi/SDK](https://github.com/AnemoneDefi/SDK).

---

## Build & test

```bash
# Devnet/localnet build (default — includes stub-oracle for tests)
anchor build

# Mainnet build (no test utilities)
anchor build -- --no-default-features
# or: yarn build:mainnet

# Run Anchor test suite
anchor test

# Run against a Kamino mainnet fork (surfpool)
yarn surfpool
yarn ts-node scripts/setup-surfpool.ts
# then in SDK/: npm run test:e2e
```

---

## Program ID

`KQs6ci5FtedFKPVJThAZSMMXyosK4TvnF7kcDSx5Jwd`

This is the program keypair declared in `Anchor.toml` under `[programs.localnet]` and `[programs.devnet]`. It's used for localnet, devnet, and the surfpool mainnet-fork test environment. **Not yet deployed to mainnet.** The mainnet deployment will reuse the same keypair (Anchor convention) — this README will be updated with a confirmed mainnet status once that happens.
