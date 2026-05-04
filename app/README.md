# Anemone Frontend

Single Next.js app — landing page (`/`) and the dApp routes (`/markets`, `/trade`, `/lp`, `/portfolio`). All pages read live on-chain state via the SDK.

## Stack

- Next.js 15 (App Router) + React 18 + TypeScript
- Vanilla CSS (CSS Modules per route, shared tokens in [`src/app/globals.css`](src/app/globals.css))
- `@anemone/sdk` (file dep at `../../SDK`) for queries + transactions
- `@solana/wallet-adapter-react` + Phantom + Solflare adapters
- `@coral-xyz/anchor` for the program client
- `swr` for client-side cache + revalidate
- `@kamino-finance/klend-sdk` (deep import) for `Reserve` decoding on the LP withdraw / position close paths

## Local dev

Pre-req: surfpool running locally (`just surfpool-start` from the `anemone/` root) and the program deployed (`just deploy-surfpool`). To populate state with a market + LP seed, run `just bootstrap-surfpool`.

```bash
yarn install
yarn dev
# http://localhost:3000
```

Connect Phantom configured for **Custom RPC `http://127.0.0.1:8899`** to interact with surfpool.

## Network matrix

The frontend is RPC-agnostic — pick the network via `NEXT_PUBLIC_RPC_URL`.

| Environment | RPC                                | When to use                        | Kamino     | Keeper                       |
|-------------|------------------------------------|------------------------------------|------------|------------------------------|
| Surfpool    | `http://127.0.0.1:8899`            | Daily dev — real Kamino fork       | Real       | Manual via `just bootstrap`  |
| Devnet      | `https://api.devnet.solana.com`    | Public demo, judges, partners      | Stub oracle | Cron 24/7                   |
| Mainnet     | TBD (Helius/Triton)                | Post-audit                         | Real       | Cron 24/7 (TBD)             |

Defaults in [`.env.example`](.env.example):

```
NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8899
NEXT_PUBLIC_PROGRAM_ID=KQs6ci5FtedFKPVJThAZSMMXyosK4TvnF7kcDSx5Jwd
NEXT_PUBLIC_NETWORK=surfpool
```

The same program ID is reused across all environments (Anchor convention). Token explorer links auto-adjust based on `NEXT_PUBLIC_NETWORK`.

```bash
cp .env.example .env.local
# Edit values for the env you're targeting
```

## Routes

| Route        | Page file                                  | Wired                                                                                       |
|--------------|--------------------------------------------|---------------------------------------------------------------------------------------------|
| `/`          | [`src/app/page.tsx`](src/app/page.tsx)     | Hero stat tiles, Protocols Kamino row, StatsBar (TVL + Open Notional + Avg APY) — charts mocked. |
| `/markets`   | [`src/app/markets/page.tsx`](src/app/markets/page.tsx) | Live market list via `useMarkets()`; soon-rows hardcoded.                          |
| `/trade`     | [`src/app/trade/page.tsx`](src/app/trade/page.tsx)     | MarketStrip + KPI grid live; OrderTicket calls `openSwap.execute`. RateChart 60d mocked.    |
| `/lp`        | [`src/app/lp/page.tsx`](src/app/lp/page.tsx)           | Deposit + Withdraw flows real; PositionCard real; charts mocked.                            |
| `/portfolio` | [`src/app/portfolio/page.tsx`](src/app/portfolio/page.tsx) | Swap + LP positions real; Add Collateral / Close Early / Claim actions wired.       |

Charts (`HeroChart`, `LpChart`, `RateChart`, `Spark`) and `RecentTrades` stay mocked — depend on a future indexer + partner visual refresh.

## Layout

```
anemone/app/
├── package.json
├── tsconfig.json
├── next.config.ts
├── .env.example
└── src/
    ├── app/
    │   ├── layout.tsx           ← root layout + Providers wrap
    │   ├── globals.css          ← design tokens + Nav + Footer + wallet-adapter overrides
    │   ├── page.tsx             ← landing (live stats wired)
    │   ├── error.tsx            ← global error boundary
    │   ├── not-found.tsx        ← 404
    │   ├── markets/page.tsx
    │   ├── trade/page.tsx
    │   ├── lp/page.tsx
    │   └── portfolio/page.tsx
    ├── components/
    │   ├── Nav.tsx              ← <WalletMultiButton /> dynamic-imported
    │   ├── Footer.tsx
    │   ├── RevealOnScroll.tsx
    │   └── Providers.tsx        ← ConnectionProvider + WalletProvider + WalletModalProvider
    └── lib/
        ├── anemone.ts           ← getReadonlyClient() + buildClient(wallet)
        ├── hooks.ts             ← useProtocol / useMarkets / useMarket / useLpPosition / useTraderPositions
        ├── balance.ts           ← useTokenBalance(owner, mint)
        ├── format.ts            ← formatUsdc / formatBps / formatPubkey / calculateApyBps
        ├── risk.ts              ← calculateSpread / calculateInitialMargin / calculateUnrealizedPnl
        └── kamino.ts            ← resolveKaminoCpiAccounts(connection, reserve)
```

## SDK API surface used

```ts
import { Anemone } from "@anemone/sdk";

// Queries
anemone.query.protocol.fetch();
anemone.query.markets.fetchAll();
anemone.query.markets.fetchByAddress(addr);
anemone.query.positions.fetchLpPosition(owner, market);
anemone.query.positions.fetchLpPositionsByOwner(owner);
anemone.query.positions.fetchSwapPositionsByOwner(owner);

// Transactions
anemone.lp.depositLiquidity.execute({ ... });
anemone.lp.requestWithdrawal.execute({ ... });
anemone.trader.openSwap.execute({ ... });
anemone.trader.addCollateral.execute({ ... });
anemone.trader.closePositionEarly.execute({ ... });
anemone.trader.claimMatured.execute({ ... });
```

## End-to-end test (manual)

1. `just surfpool-start && just deploy-surfpool && just setup-surfpool` (in `anemone/`)
2. `yarn dev` (in `anemone/app/`)
3. Phantom: switch to Custom RPC `http://127.0.0.1:8899`, ensure wallet has USDC (use a USDC ATA airdrop helper if your wallet is fresh)
4. `/markets` → see Kamino USDC 30d live
5. `/lp` → deposit, see shares
6. `/trade` → open PayFixed, see fixed rate locked
7. `/portfolio` → see position. Add collateral or close early. After maturity, claim.

## Build

```bash
yarn build
yarn start
```

## Outstanding work

See the **"Pre-mainnet checklist — Fase 4 (frontend)"** section of [`docs/PLANO_33_DIAS_MVP.md`](../../docs/PLANO_33_DIAS_MVP.md) for the full list of items that need to change before deploying to a mainnet program. Highlights: replace devnet badge with env-driven label, harden RPC config (no localhost fallback in prod), real indexer for charts + RecentTrades, confirmation modals before signing, accessible dialogs for Add Collateral.
