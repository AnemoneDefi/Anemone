# Keeper Bot Operations Runbook

Operational guide for the Anemone keeper bot in production.

The keeper is the single point of failure between traders/LPs and a working
protocol — without it positions don't settle, rates don't update, and
withdrawals can't drain Kamino. **This runbook is operational, not aspirational:
follow it and the protocol stays healthy.**

---

## 1. Cron schedule (minimum cadences)

Each job's cadence is bounded by an on-chain staleness gate. Run each job AT
LEAST as often as the gate allows; faster is fine.

| Job                         | Cadence    | On-chain gate                          |
|-----------------------------|------------|----------------------------------------|
| `update_rate_index`         | every 3min | Pyth/Klend max_age ≈ 180 slots (~72s)  |
| `sync_kamino_yield`         | every 5min | NAV staleness check = 600s             |
| Liquidation scan            | every 5min | none — but underwater positions accrue |
| Settlement scan             | every 10min | per-position `next_settlement_ts`     |
| Rebalance (drain Kamino)    | every 10min | drain when lp_vault < 10% of lp_nav    |

**Why 3 min for `update_rate_index`?** Pyth USDC's `max_age = 180 slots`
(~72 seconds). The keeper needs to land *within* that window with the
`refresh_reserve` preInstruction. 3 min cron leaves a wide buffer for retries,
RPC blips, and slot drift.

**Why 600s for `sync_kamino_yield`?** Hard-coded `MAX_NAV_STALENESS_SECS`
in the LP-facing handlers. If you let the snapshot drift past 10 minutes,
`deposit_liquidity` and `request_withdrawal` start rejecting with `StaleNav`.

---

## 2. Refresh prefix pattern (always!)

**Every** Klend CPI on Surfpool / mainnet **MUST** be preceded by a
`refresh_reserve` instruction in the same transaction. This is non-negotiable:
without it, `deposit_reserve_liquidity` / `redeem_reserve_collateral` /
`refresh_reserve_internal` panic with `MathOverflow` once the reserve's
`last_update.slot` falls more than ~150 slots behind current.

Pattern:

```typescript
const refreshIx = refreshReserveIx({
  reserve: KAMINO_USDC_RESERVE,
  lendingMarket,
  scopePrices: SCOPE_PRICES,
  kaminoProgram: KAMINO_PROGRAM,
});

await program.methods
  .updateRateIndex()
  .accountsStrict({ ... })
  .preInstructions([refreshIx])    // ← required, every time
  .rpc();
```

The same applies to `deposit_to_kamino`, `withdraw_from_kamino`, and
`sync_kamino_yield`. Anemone does not bundle the refresh internally — the
keeper owns this responsibility.

---

## 3. Pyth USDC oracle health check

Before any tx that triggers `refresh_reserve` (which calls Pyth/Scope), verify
the oracle is fresh:

```typescript
async function pythHealthCheck(connection: Connection): Promise<{ ok: boolean; ageSlots: number }> {
  const currentSlot = await connection.getSlot();
  const pythAccount = await connection.getAccountInfo(PYTH_USDC_FEED);
  const publishSlot = decodePythPublishSlot(pythAccount!.data);
  const ageSlots = currentSlot - publishSlot;
  return { ok: ageSlots < 150, ageSlots };
}
```

**Branching policy**:
- `ageSlots < 150`: proceed.
- `150 ≤ ageSlots < 200`: warn, but proceed (single retry on failure).
- `ageSlots ≥ 200`: **abort** the cycle, log the incident, page if it persists
  for two consecutive cycles.
- `publishSlot` unchanged for >5 min: Pyth publishers stalled — page oncall
  *immediately*. The protocol path that depends on Pyth (`refresh_reserve`)
  will start failing within seconds.

---

## 4. Recovery scenarios

### Scenario A — Keeper crash + restart

1. Verify the systemd unit (or supervisor) is healthy:
   `systemctl status anemone-keeper`
2. Read the last 200 log lines: which transaction failed, with which error?
3. If the last error was `StaleOracle` or `PriceTooOld`:
   - Wait 60 seconds (let Pyth publishers catch up).
   - Run a manual `update_rate_index` with the refresh prefix; confirm
     it lands.
   - Restart the keeper.
4. If the error persists across multiple manual retries:
   - Likely Pyth incident — see Scenario B.
5. After restart, run `update_rate_index` once manually before letting the
   cron resume. This confirms the system is healthy *before* the loop
   re-engages.

### Scenario B — Pyth USDC stalled (>5 min)

1. Pause new `open_swap` via `pause_market` (admin-only).
2. **Do NOT** pause the exit paths (`request_withdrawal`, `claim_matured`,
   `close_position_early`, `liquidate_position`) — they don't depend on
   Pyth and users need to be able to exit.
3. Wait for Pyth to recover (typically <30 min for major incidents).
4. When `pythHealthCheck()` returns `ok: true` for two consecutive checks:
   - Unpause the market.
   - Resume the keeper cron.

### Scenario C — `lp_vault` drained, withdrawals queued

Symptom: LPs can't withdraw because `lp_vault.amount` is too small to cover
their requested gross.

1. Read `kamino_deposit_account.amount` — protocol's k-USDC holdings.
2. If positive, drain it back to USDC:
   ```bash
   # Drain ALL k-USDC back to lp_vault for liquidity
   anchor invoke withdraw_from_kamino \
     --amount <kamino_deposit_account.amount> \
     --keeper <keeper_keypair>
   ```
   (Bundle with `refresh_reserve` preInstruction.)
3. Run `sync_kamino_yield` immediately after to refresh the snapshot.
4. LPs can now withdraw normally.

If `kamino_deposit_account` is also empty: protocol is genuinely insolvent.
Pause the market and investigate (likely a missed yield decrement or a bug).

### Scenario D — Liquidation queue (positions underwater)

1. Iterate all `SwapPosition` accounts where `status == Open`.
2. For each, compute:
   ```
   maintenance_margin = calculate_maintenance_margin(notional, tenor)
                      = 60% × initial_margin
   ```
3. If `collateral_remaining < maintenance_margin`:
   - Call `liquidate_position` with the keeper as liquidator.
   - The keeper receives **2/3 of the 3% liquidation fee** automatically;
     treasury gets the remaining **1/3**.
4. Liquidations are permissionless — anyone can liquidate. The keeper
   should be the default liquidator to capture the MEV reward, but a
   competing liquidator MEV-snatching is fine: the protocol stays healthy
   either way.

---

## 5. Alerting thresholds

| Metric                                                        | Level  | Action                              |
|---------------------------------------------------------------|--------|-------------------------------------|
| Pyth USDC age > 150 slots                                     | Warn   | Slack notification                  |
| Pyth USDC age > 200 slots                                     | Page   | Oncall responds within 15 min       |
| Last `sync_kamino_yield` > 10 min ago                         | Warn   | Slack — LP ops will fail soon       |
| Last `sync_kamino_yield` > 30 min ago                         | Page   | LP ops failing now                  |
| Open position underwater AND not liquidated within 5 min      | Page   | Manual liquidation needed           |
| `lp_vault.amount` < 5% of `lp_nav` while withdrawals queued   | Page   | Drain Kamino — Scenario C           |
| Keeper RPC error rate > 10% over a 5-min window               | Warn   | Likely RPC degradation, swap node   |
| Keeper hasn't issued ANY transaction in 10 min                | Page   | Process is wedged — restart         |

---

## 6. Manual ops (admin-only)

```bash
# Pause market — emergency only
anchor invoke pause_market --market <pda> --authority <admin>

# Unpause
anchor invoke unpause_market --market <pda> --authority <admin>

# Rotate keeper authority (revokes old keypair, key compromise scenario)
anchor invoke set_keeper --new-keeper <new_pubkey> --authority <admin>

# Drain entire Kamino position back to lp_vault (Kamino emergency)
ts-node scripts/drain-all-kamino.ts

# Emergency: read on-chain state without signing
ts-node scripts/inspect-protocol.ts
```

The keeper keypair must NOT have admin permissions. Only `set_keeper`
(authorized by admin) can rotate the keeper.

---

## 7. Daily monitoring checklist

Run this daily (or every business day) until the protocol has been live
30+ days without incident:

- [ ] Keeper bot uptime > 99% over the last 24h
- [ ] Zero `StaleOracle` errors in the keeper logs
- [ ] All open `SwapPosition` accounts: `collateral_remaining > 1.2 ×
      maintenance_margin` (no imminent liquidations pending)
- [ ] Pyth USDC oracle: age < 100 slots
- [ ] Treasury USDC balance ≈ sum of expected fees
      (opening + protocol + early-close + withdrawal + liquidation slices)
- [ ] `lp_nav` ≈ `lp_vault.amount + kamino_value_at_current_rate`
      (drift < 1% — anything larger means the snapshot is wrong)
- [ ] No support tickets about "couldn't withdraw" or "got wrong amount"

---

## 8. Test the runbook locally before relying on it

1. Spin up Surfpool with the mainnet build.
2. Manually trigger each scenario (drain `lp_vault`, stall the keeper, etc.)
   and execute the recovery steps from this doc.
3. If any step doesn't work as written, **fix the runbook** before fixing
   the protocol — operational docs that drift from reality are worse than
   useless.

---

## References

- `programs/anemone/src/instructions/keeper/update_rate_index.rs` — refresh
  prefix requirement
- `programs/anemone/src/instructions/keeper/sync_kamino_yield.rs` — NAV
  staleness gate
- `programs/anemone/src/instructions/lp/request_withdrawal.rs` —
  `compute_partial_burn` (cap-binds path)
- `programs/anemone/src/helpers/settlement.rs` —
  `calculate_maintenance_margin`
- `scripts/test-mainnet-cycle.ts` — refresh prefix pattern in code
