# Anemone Keeper

Off-chain bot that keeps the Anemone IR swap protocol alive. Calls the program's
permissionless keeper-oriented instructions on a schedule so traders don't have
to manually trigger settlements.

## Jobs

| Job | Instruction | Frequency | Purpose |
|-----|-------------|-----------|---------|
| updateRate | `update_rate_index` (mainnet) / `set_rate_index_oracle` (devnet) | 3 min | Keeps `current_rate_index` fresh (MAX_STALE_SLOTS = 750 slots ≈ 5 min). |
| settlement | `settle_period` | 10 min | Pops every Open position whose `next_settlement_ts` has passed. |
| liquidation | `liquidate_position` | 5 min | Liquidates positions below maintenance margin; keeper earns 3%. |

## Setup

1. Install deps: `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `RPC_URL`
   - `PROGRAM_ID` (the deployed Anemone program)
   - `MARKET_PDA` (the market being monitored)
   - `KEYPAIR_PATH` — wallet configured as the protocol's `keeper_authority`
   - `ADMIN_KEYPAIR_PATH` — only needed in stub-oracle mode (devnet)
   - `USE_STUB_ORACLE=true` on devnet, `false` on mainnet/Surfpool
3. Build the Anemone program so the IDL is available:
   ```
   cd .. && anchor build
   ```
4. Bootstrap the market (first time only, after a fresh deploy):
   ```
   npm run bootstrap
   ```
   This pushes two rate-index updates with a 30s gap so `open_swap` can accept
   trades (it needs both `previous_rate_index` and `current_rate_index` > 0).
5. Run the keeper:
   ```
   npm run dev     # watch mode
   npm run build && npm start   # compiled
   ```

## Architecture

- `src/client.ts` — Anchor `Program` + wallets (keeper + optional admin for stub oracle)
- `src/config.ts` — env loading and keypair resolution
- `src/bootstrap.ts` — one-shot seeding of the rate index
- `src/jobs/updateRate.ts` — pushes rate index from Kamino or stub
- `src/jobs/settlement.ts` — `getProgramAccounts` filtered by `status==Open`,
  batches settlements for positions past their next_settlement_ts
- `src/jobs/liquidation.ts` — computes maintenance margin off-chain and calls
  `liquidate_position` when collateral falls below it
- `src/utils/` — PDA helpers, pino logger, margin math mirroring the on-chain Rust

## Stub oracle mode

On devnet, Kamino K-Lend isn't deployed. The keeper instead calls the admin-only
`set_rate_index_oracle` with a linearly incrementing value (configured via
`STUB_RATE_INCREMENT`). This gives realistic-looking APY numbers for the demo
without depending on a live lending protocol.

The default increment (1e12) bumps the rate index enough per 3-minute tick
that `calculate_current_apy_from_index` produces an APY on the order of 10-15%.

### Feature gating (mainnet safety)

`set_rate_index_oracle` only exists in builds that include the `stub-oracle`
Cargo feature. That feature is **default-on** for dev/devnet. Mainnet deploys
must explicitly opt out:

```
anchor build -- --no-default-features   # or: yarn build:mainnet
```

Belt-and-suspenders: the keeper refuses to start with `USE_STUB_ORACLE=true` if
`RPC_URL` looks like mainnet (see `MAINNET_RPC_SUBSTRINGS` in `src/config.ts`).
A mainnet program simply does not contain the instruction — calling it returns
`InstructionFallbackNotFound`.
