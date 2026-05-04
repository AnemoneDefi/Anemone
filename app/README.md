# Anemone Frontend

Single Next.js app — landing page (`/`) and the dApp routes
(`/markets`, `/trade`, `/lp`, `/portfolio`).

## Stack

- Next.js 15 (App Router) + React 18 + TypeScript
- Vanilla CSS (CSS Modules per route, shared tokens in
  [`src/app/globals.css`](src/app/globals.css))
- Wallet adapter + Anchor client wiring is **not yet integrated** — pages
  currently render mock data so the visual shell can ship in parallel.

## Routes

| Route        | Page file                                  | Notes                              |
|--------------|--------------------------------------------|------------------------------------|
| `/`          | [`src/app/page.tsx`](src/app/page.tsx)     | Marketing landing — Hero, Final CTA, Footer. 8 prototype sections still pending TSX port (see comment in page.tsx). |
| `/markets`   | [`src/app/markets/page.tsx`](src/app/markets/page.tsx) | Market list with filters. |
| `/trade`     | [`src/app/trade/page.tsx`](src/app/trade/page.tsx)     | Order ticket + rate chart. |
| `/lp`        | [`src/app/lp/page.tsx`](src/app/lp/page.tsx)           | Deposit / withdraw + position. |
| `/portfolio` | [`src/app/portfolio/page.tsx`](src/app/portfolio/page.tsx) | Active positions table. |

The landing's CSS lives at the bottom of [`src/app/globals.css`](src/app/globals.css)
scoped under `.landing-root`, so it cannot leak into the dApp routes (they
use a smaller font-size and different button scale).

The full design reference for the landing (12 sections) is preserved in
[`prototype/`](prototype/) — `landing.html` + `app.jsx` from claude.ai/design.

## Layout

```
anemone/app/
├── package.json
├── tsconfig.json
├── next.config.ts
└── src/
    ├── app/
    │   ├── layout.tsx           ← root layout + fonts
    │   ├── globals.css          ← design tokens + Nav + Footer + buttons
    │   ├── page.tsx             ← redirects to /markets
    │   ├── markets/
    │   │   ├── page.tsx
    │   │   └── markets.module.css
    │   ├── trade/
    │   │   ├── page.tsx
    │   │   └── trade.module.css
    │   ├── lp/
    │   │   ├── page.tsx
    │   │   └── lp.module.css
    │   └── portfolio/
    │       ├── page.tsx
    │       └── portfolio.module.css
    └── components/
        ├── Nav.tsx               ← top nav with active-route highlight
        ├── Footer.tsx            ← mini footer (devnet/version)
        └── RevealOnScroll.tsx    ← fade-in animation on .reveal elements
```

## Local dev

```bash
yarn install
yarn dev
# http://localhost:3000 → /markets
```

## Configuration

```bash
cp .env.example .env.local
# edit NEXT_PUBLIC_RPC_URL / PROGRAM_ID / NETWORK
```

## Next integration steps

1. **Wallet adapter** — `@solana/wallet-adapter-react` + provider in
   [`src/app/layout.tsx`](src/app/layout.tsx), Connect button in
   [`src/components/Nav.tsx`](src/components/Nav.tsx).
2. **Anchor client** — copy IDL from `anemone/target/idl/anemone.json`
   and types from `anemone/target/types/anemone.ts`; instantiate in
   `src/lib/program.ts` (TODO).
3. **Replace mock data** — every `MARKETS`, `SERIES`, `TRADES` constant
   in the page files is mock; swap for `program.account.swapMarket.all()`
   etc.
4. **Transaction flows** — the CTA buttons (`Open PayFixed`, `Deposit`,
   `Close Early`, `Claim`, `Withdraw`) are wired only as visuals. Hook
   each to the corresponding instruction once wallet is connected.
