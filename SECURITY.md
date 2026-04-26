# Anemone Security Audit

Date: 2026-04-26
Scope: `programs/anemone/` (Rust on-chain program), commit `2fec665` + open PR #27.
Auditor: internal review pass before mainnet hardening.

This is **not** a third-party audit and should not be treated as one. It captures known risks and dead code that the team should track before shipping to mainnet at meaningful TVL.

---

## Severity legend

- **CRITICAL** — direct loss/theft of user funds, bricks the protocol, or bypasses a core invariant
- **HIGH** — credibly exploitable for a meaningful drift of value (or blocks all users on mainnet)
- **MEDIUM** — bounded griefing, accounting drift, or a path that requires a specific (but plausible) sequence
- **LOW** — foot-guns, missed best-practices, or attack surface with no clear payoff
- **INFO** — observation, design notes, dead code

Each finding lists where in the code it lives and what would close it.

---

## Findings — ordered by severity

### 1. [HIGH] `sync_kamino_yield` mainnet path is a stub that always errors

[programs/anemone/src/instructions/keeper/sync_kamino_yield.rs:82-88](programs/anemone/src/instructions/keeper/sync_kamino_yield.rs#L82-L88)

The non-stub-oracle build returns `Err(AnemoneError::InvalidAmount)` unconditionally. `last_kamino_sync_ts` is therefore frozen at the value seeded by `create_market` (the wall clock at market creation). After `MAX_NAV_STALENESS_SECS = 600s`, every LP-facing handler trips the `StaleNav` require and reverts:

- [deposit_liquidity.rs:89-93](programs/anemone/src/instructions/lp/deposit_liquidity.rs#L89-L93)
- [request_withdrawal.rs:90-94](programs/anemone/src/instructions/lp/request_withdrawal.rs#L90-L94)
- [claim_withdrawal.rs:69-73](programs/anemone/src/instructions/lp/claim_withdrawal.rs#L69-L73)

**Effect on mainnet**: 10 minutes after market launch, no LP can deposit, request, or claim. The protocol is bricked from the LP side until the mainnet handler is wired.

**Close**: implement the mainnet path described in the file's TODO block — refresh_reserve CPI → read collateral exchange rate → credit `(kamino_value_usdc - last_kamino_snapshot_usdc)` into `lp_nav` → update `last_kamino_snapshot_usdc` and `last_kamino_sync_ts`. Until that ships, the `stub-oracle` feature must remain enabled even on mainnet, which defeats the staleness gate's purpose.

Related: see Finding 6 (lp_nav double-count after first deposit_to_kamino).

---

### 2. [CRITICAL — RESOLVED in `feat/rate-index-collapse-fix`] `update_rate_index` permissionless → atomic same-tx APY-collapse → free PayFixed PnL

[programs/anemone/src/instructions/keeper/update_rate_index.rs:7-22](programs/anemone/src/instructions/keeper/update_rate_index.rs#L7-L22)

The struct declares no `Signer` and no keeper constraint. Anyone can call it, paying their own gas. In open_swap, the quoted APY is derived from `(current_rate_index - previous_rate_index) / elapsed`:

[open_swap.rs:113-130](programs/anemone/src/instructions/trader/open_swap.rs#L113-L130)

```rust
let current_apy_bps = if elapsed <= 0
    || market.current_rate_index == market.previous_rate_index
{
    0u64
} else { calculate_current_apy_from_index(...)? };
```

**The attack is single-transaction atomic**, no timing race required. Three instructions in one tx:

```
ix 1: update_rate_index       // prev=0,   curr=bsf, last_ts=T
ix 2: update_rate_index       // prev=bsf, curr=bsf, last_ts=T   ← rotation collapses snapshots
ix 3: open_swap PayFixed       // sees current==previous → apy=0
                                // fixed_rate = 0 + spread (~80 bps)
```

Between ix 1 and ix 2 nothing invokes Kamino's `refresh_reserve`, so `cumulative_borrow_rate_bsf` does not change. Both reads return the same value. The rotation in ix 2 overwrites `previous_rate_index` with that same value, collapsing the snapshot pair. Open_swap then sees `current == previous` (or `elapsed == 0` on same-second tx) and returns `current_apy_bps = 0`.

**Economic impact**. PayFixed locks in `fixed_rate = spread ≈ 80 bps`. At settlement, `variable_payment` compounds against the **real** Kamino rate index growth (not the manipulated APY), while `fixed_payment` is computed off the locked 80 bps. The trader profits the spread between real APY and the locked rate, every period, until close.

  - At Kamino USDC ~12% APY, PayFixed pays ~0.8% fixed, receives ~12% variable → +11.2% / year of notional, all extracted from `lp_vault`.
  - At $100k notional held 1 year: ~$11.2k LP loss, no protocol fee captures it.
  - Bounded only by `max_utilization_bps` — attacker can stack positions until the cap.

**Slippage protection does not block this**. `max_rate_bps` is an upper bound on the fixed rate; PayFixed wants the rate **low**, so a tiny quoted rate passes the check trivially. ReceiveFixed *is* naturally guarded by the require at [open_swap.rs:160](programs/anemone/src/instructions/trader/open_swap.rs#L160) (`current_apy_bps > spread_bps`), which reverts when `apy = 0`. The asymmetric exposure is on PayFixed only.

**Resolution**. Three-layer defense shipped in this PR. All layers are independently sufficient to close the atomic-collapse path; together they survive bug-or-regression in any single layer.

1. **Layer 1 — keeper-gate** [update_rate_index.rs](programs/anemone/src/instructions/keeper/update_rate_index.rs). Adds `protocol_state` + `keeper: Signer` with `keeper.key() == protocol_state.keeper_authority`. A random caller can no longer touch the rate index.
2. **Layer 2 — strict-monotonic + min-elapsed in the rotation handler.** Rejects any second call where `rate_index == current_rate_index` (Kamino bsf has not moved) and any call within `MIN_RATE_UPDATE_ELAPSED_SECS = 8s` of the previous one. Defense-in-depth against keeper-bot bugs (cron retries, double-firing) that would otherwise collapse the snapshot pair.
3. **Layer 3 — open_swap hard reject** at [open_swap.rs:120-130](programs/anemone/src/instructions/trader/open_swap.rs#L120-L130). The previous "default to apy=0 if collapsed" branch is now `require!(elapsed > 0 && current > previous, RateIndexNotInitialized)`. Belt-and-suspenders: if a future change ever lets layers 1/2 regress, the swap reverts loudly instead of silently quoting `spread` against PayFixed.

Tests added: `rejects update_rate_index from non-keeper signer` and `rejects no-op rotation (Kamino bsf has not moved)`. Existing tests that called `update_rate_index` twice against a static Kamino fixture were migrated to `set_rate_index_oracle` with two distinct values 8s apart — the previous test pattern was passing only because it implicitly hit the same APY-collapse path that this PR closes.

---

### 3. [MEDIUM] `withdraw_from_kamino` spam can drag protocol yield (residual grief vector)

[programs/anemone/src/instructions/keeper/withdraw_from_kamino.rs:31](programs/anemone/src/instructions/keeper/withdraw_from_kamino.rs#L31)

After PRs #26 and #27, no user-facing exit path depends on `withdraw_from_kamino` being pre-called — every trader/LP exit now redeems internally on shortfall. Despite that, the instruction itself remains permissionless. An attacker can spam it to keep funds parked in `lp_vault` instead of earning Kamino yield.

The original PR #25 design rationale (trader self-rescue) is now obsolete because the internal CPI in the exit handlers fully replaces it. Leaving the instruction permissionless is a residual attack surface with no compensating user benefit.

**Effect**: bounded yield drag — at TVL `T` and Kamino APY `r`, attacker drags `T × r × idle_fraction` per year, paying their own per-tx CU cost. Becomes ROI-positive for the attacker once `T × r > attack_cost_per_period × periods_per_year`. At low TVL not worth attacking; at $50k+ TVL plausibly worth it.

**Close**: gate to `keeper_authority` (same constraint as `deposit_to_kamino`). The internal CPIs in [claim_matured](programs/anemone/src/instructions/trader/claim_matured.rs), [close_position_early](programs/anemone/src/instructions/trader/close_position_early.rs), [liquidate_position](programs/anemone/src/instructions/trader/liquidate_position.rs), and [claim_withdrawal](programs/anemone/src/instructions/lp/claim_withdrawal.rs) already cover liveness for users; the keeper is the only legitimate caller for happy-path rebalances.

---

### 4. [MEDIUM] `lp_nav` ignores Kamino yield for utilization checks

[open_swap.rs:194-202](programs/anemone/src/instructions/trader/open_swap.rs#L194-L202)

Open_swap's utilization gate divides total notional by `market.lp_nav`. `lp_nav` is only credited via `sync_kamino_yield`, which is currently a stub on mainnet (Finding 1). On the stub path, `lp_nav` only reflects USDC actually deposited, not the Kamino yield earned on it.

**Effect**: utilization is overestimated. New positions get blocked even when the pool has more redeemable capital than `lp_nav` shows. Not a fund-loss issue, but degrades capacity. Once Finding 1 is closed, this resolves naturally.

There is also an inverse case to watch: if `sync_kamino_yield` is implemented but a snapshot lags Kamino's real value, utilization is underestimated → market can be over-filled relative to actual collateral. The 600s staleness gate caps this drift.

**Close**: ship Finding 1.

---

### 5. [MEDIUM] No minimum-elapsed enforcement between request_withdrawal and claim_withdrawal

[programs/anemone/src/instructions/lp/request_withdrawal.rs](programs/anemone/src/instructions/lp/request_withdrawal.rs), [programs/anemone/src/instructions/lp/claim_withdrawal.rs](programs/anemone/src/instructions/lp/claim_withdrawal.rs)

`request_withdrawal` writes `withdrawal_requested_at = now`; `claim_withdrawal` reads `withdrawal_amount` but does not check the requested timestamp. The two can be bundled in the same transaction.

The 2-step pattern was originally a liveness workaround — give the keeper time to refill `lp_vault` from Kamino. PR #27's internal CPI removed that need. As-is, the queued path provides no risk-circuit-breaker (e.g. "admin gets N hours to pause if a withdrawal looks suspicious") and no economic effect — a single-tx bundle is functionally equivalent to a fast-path withdrawal, just with more compute.

**Close (pick one)**:
- Enforce a minimum cooldown (`now - withdrawal_requested_at >= MIN_WITHDRAWAL_COOLDOWN`) and document it as the protocol's risk-management window.
- Or remove the queued path entirely now that internal Kamino redeem covers the liveness story. `request_withdrawal` becomes a one-shot `withdraw_liquidity`.

Either choice is fine; the current "two ix that do the same thing" surface is just noise.

---

### 6. [MEDIUM] `last_kamino_snapshot_usdc` not updated on deposit_to_kamino / withdraw_from_kamino

[programs/anemone/src/instructions/keeper/deposit_to_kamino.rs:127-131](programs/anemone/src/instructions/keeper/deposit_to_kamino.rs#L127-L131), [programs/anemone/src/instructions/keeper/withdraw_from_kamino.rs:128-131](programs/anemone/src/instructions/keeper/withdraw_from_kamino.rs#L128-L131)

When the keeper moves USDC into Kamino, the new k-USDC has a USDC-equivalent value equal to the deposited amount at the moment of deposit. `last_kamino_snapshot_usdc` should be set to that value so the next `sync_kamino_yield` computes a delta of *yield only*, not deposited principal.

Today it stays at `0` (or whatever the previous sync left it at). Once Finding 1 ships, the first sync after a fresh `deposit_to_kamino` would credit `(kamino_value_usdc - 0) = kamino_value_usdc` as yield, **double-counting** the principal that `lp_nav` already includes from `deposit_liquidity`.

**Effect**: LPs collectively get an `lp_nav` credit equal to the total USDC ever deposited into Kamino, on top of the deposit they already received. Share price spikes; new depositors after the spike get a smaller share for the same USDC; first-out LPs withdraw against an inflated pool.

The bug is dormant today only because the mainnet sync handler doesn't run.

**Close**: in `deposit_to_kamino` and `withdraw_from_kamino`, after the CPI and `total_kamino_collateral` mirror, also set `last_kamino_snapshot_usdc` to the post-CPI USDC-equivalent value. Tie this fix to Finding 1 — both must land in the same release.

---

### 7. [LOW] First-deposit share-price math relies on `lp_nav`, not vault state

[deposit_liquidity.rs:102-112](programs/anemone/src/instructions/lp/deposit_liquidity.rs#L102-L112)

The share-price calculation uses `effective_deposits = lp_nav - pending_withdrawals`. An attacker who transfers raw USDC directly to `lp_vault` (an SPL receive does not need permission) does not affect `lp_nav` and so cannot inflate the share price for the next depositor — the classic ERC4626 first-depositor attack does not apply here.

The donated USDC gets eventually credited as Kamino yield once it cycles through `deposit_to_kamino` and `sync_kamino_yield`, which distributes proportionally to all LPs (including the attacker's). The attacker burns their donation. No exploit, but worth knowing the pattern was considered.

**No close required.** Documented for future reviewers.

---

### 8. [LOW] `protocol_state.treasury` not validated as a token account at init

[initialize_protocol.rs:37-41](programs/anemone/src/instructions/admin/initialize_protocol.rs#L37-L41)

The init handler stores `treasury.key()` from an `AccountInfo` without checking that the account is a token account on the underlying mint. Downstream handlers (`open_swap`, `request_withdrawal`, `close_position_early`, etc.) assert `address = protocol_state.treasury` and `token::mint = underlying_mint`, so a wrong setup is detected at the *first* user-facing handler call — not at init.

**Effect**: admin foot-gun. If the deployer passes the wrong treasury at init, the protocol appears to deploy fine but every later fee transfer reverts. No fund loss; UX issue.

**Close**: validate at init that `treasury` deserializes as a token account on `system_program.token::ID` and matches the protocol's underlying mint(s). Since markets are added later, the cleanest gate is to compare the treasury's mint against the *first* market's mint at `create_market` time and reject mismatches.

---

### 9. [LOW] No minimum margin enforced — dust positions can exist

[helpers/spread.rs:102-103](programs/anemone/src/helpers/spread.rs#L102-L103)

`calculate_initial_margin` returns `margin.max(1)` to avoid zero-collateral positions. For very small notional or short tenor, the floor of 1 token-unit (1e-6 USDC) becomes the actual margin. Dust positions consume rent (the position account ~200 bytes), pollute `total_open_positions`, and cost `settle_period` callers gas to clear.

**Effect**: griefing the keeper / settlement caller. Attacker opens many dust positions to inflate the keeper's settlement workload. Each costs the attacker ~$0.002 in opening fee + ~$0.005 rent (recovered on close).

**Close**: enforce a protocol-level minimum margin (e.g. `margin >= 1_000_000` = $1) inside `calculate_initial_margin` or as a require in `open_swap`.

---

### 10. [LOW] `position.num_settlements: u16` overflows at 65,535 settlements

[state/position.rs:37](programs/anemone/src/state/position.rs#L37)

[settle_period.rs:263-265](programs/anemone/src/instructions/trader/settle_period.rs#L263-L265) uses `checked_add(1)`. Once num_settlements reaches u16::MAX, every future settle reverts with `MathOverflow`. The position is stuck unable to settle, but the trader can still close via `close_position_early` or `claim_matured` (both ignore num_settlements).

**Effect**: trader can DoS settlement on their own position by holding it past 65k settlements. With a 10-minute settlement period that's ~15 months. With a 1-second period (test fixtures only) it's 18 hours. Real-world impact: low, since long-tenor markets settle slowly and the trader cannot self-grief profitably (they'd just close early).

**Close**: widen to `u32` or `u64` (saves one byte today vs. ~4-8 bytes new), or saturate instead of checked_add.

---

### 11. [INFO] Pause switch is intentionally narrow

[programs/anemone/src/state/protocol.rs:20-25](programs/anemone/src/state/protocol.rs#L20-L25)

`protocol_state.paused` is checked only in `open_swap` and `deposit_liquidity`. Settlement, liquidation, claim_matured, close_position_early, request_withdrawal, claim_withdrawal, sync_kamino_yield, and the keeper Kamino ops all run during pause. This is by design (the comment is explicit) so admin cannot trap user funds. Worth re-asserting in the audit because it's the kind of thing a third party would flag.

**No close required.** Document the design choice in user-facing docs.

---

### 12. [INFO] Kamino layout drift detection is feature-gated to mainnet

[update_rate_index.rs:45-49](programs/anemone/src/instructions/keeper/update_rate_index.rs#L45-L49)

The check that `reserve.liquidity.mint_pubkey == market.underlying_mint` only runs when `stub-oracle` is disabled (i.e., mainnet). On localnet/devnet with the stub feature, the test harness uses fake mints paired with a real Kamino reserve fixture and would fail this check. The trade-off is reasonable but worth understanding: tests do not exercise this defense.

**No close required.** Surfpool integration tests exercise the live Kamino read path.

---

## Dead code

These are tracked as TECH-DEBT, not bugs. They bloat account size or provide a misleading API surface; none affects security directly.

| Item | File | Status |
|---|---|---|
| `AnemoneError::InsufficientVaultLiquidity` | [errors.rs:48](programs/anemone/src/errors.rs#L48) | 0 references after PR #27. Remove. |
| `protocol_state.protocol_fee_bps` | [state/protocol.rs:10](programs/anemone/src/state/protocol.rs#L10) | Set in init, never read. Performance fee was scoped but never wired to settle. Remove or implement. |
| `market.cumulative_fees_earned` | [state/market.rs:55](programs/anemone/src/state/market.rs#L55) | Set to 0 on create, never updated/read. Remove or wire to fee transfers. |
| `market.status` field | [state/market.rs:71](programs/anemone/src/state/market.rs#L71) | Constraint reads `== 0` in deposit_liquidity / open_swap, but no setter exists. Per-market pause is implicitly absent. Remove the field + constraint, or implement an admin setter and use it. |
| `AnemoneError::MarketPaused` | [errors.rs:14](programs/anemone/src/errors.rs#L14) | Tied to the dead `market.status`. Remove together. |
| `position.collateral_deposited` | [state/position.rs:28](programs/anemone/src/state/position.rs#L28) | Set in open_swap, never read on-chain. Off-chain analytics field — keep if indexers consume it, otherwise remove. |
| `position.realized_pnl` | [state/position.rs:36](programs/anemone/src/state/position.rs#L36) | Incremented in settle, never read. Same as above. |
| `position.num_settlements` | [state/position.rs:37](programs/anemone/src/state/position.rs#L37) | Incremented, only used in `msg!`. Off-chain field. |
| `position.open_timestamp` | [state/position.rs:51](programs/anemone/src/state/position.rs#L51) | Set in open_swap, never read. Off-chain field. |
| `lp_position.deposited_amount` | [state/lp.rs:18](programs/anemone/src/state/lp.rs#L18) | Incremented in deposit_liquidity, never read. Off-chain field. |
| `lp_position.withdrawal_requested_at` | [state/lp.rs:22](programs/anemone/src/state/lp.rs#L22) | Set/cleared but never enforced as a cooldown — see Finding 5. |

The five `position.*` and `lp_position.*` fields amount to ~58 extra bytes per position account. At 10k positions that's ~580 KB of rent. Worth deciding explicitly whether they exist for indexers (then keep + document) or are leftovers (then drop in a v2 migration).

---

## What is working well

Documenting the defenses that already landed, so future reviewers don't accidentally regress them:

1. **C1 fix** — `settle_period` and `close_position_early` use real elapsed time, not the nominal settlement period, in `calculate_period_pnl`. Makes the fixed leg symmetric with the variable leg under late-settle. Tests at [settlement.rs:332-374](programs/anemone/src/helpers/settlement.rs#L332-L374) lock the invariant.

2. **C2 NAV staleness** — LP handlers gate on `last_kamino_sync_ts`. Once Finding 1 ships, this becomes a real freshness invariant.

3. **C3 oracle staleness** — `update_rate_index` rejects Kamino reserves with `current_slot - reserve_slot > 750`. open_swap rejects quotes against an oracle older than 600s.

4. **H1 unpaid_pnl catchup** — settlement, claim, close_early, and liquidate all attempt to drain accrued debt before booking new PnL. Combined with the internal Kamino redeem (PR #26 + #27), the protocol can always pay out an exiting trader/LP.

5. **H2 Kamino layout drift detection** — mainnet builds verify `reserve.liquidity.mint_pubkey == market.underlying_mint` to catch silent struct-layout changes after a Kamino program upgrade.

6. **H4 rate-move circuit breaker** — `MAX_PERIOD_GROWTH_BPS = 500` aborts settlements that report > 5% per-period growth, blocking oracle manipulation / Kamino bugs from paying phantom PnL.

7. **H5 fee/param caps** — `initialize_protocol` and `create_market` reject out-of-range fees, max_utilization, and base_spread to keep an admin typo from making the protocol insolvent.

8. **H7 Token-2022 lockout** — `create_market` requires the underlying mint to be classic SPL Token. Closes TransferHook reentrancy, PermanentDelegate drains, and TransferFee NAV desync.

9. **2-of-N upgrade authority** (off-chain) — production deployment uses a Squads V4 multisig as upgrade authority. Single-key compromise does not yield a malicious program upgrade.

10. **PR #26 + #27 — internal Kamino redeem** — `claim_matured`, `close_position_early`, `liquidate_position`, and `claim_withdrawal` now redeem from Kamino atomically when `lp_vault` is short. Eliminates the PR #25 grief vector for every user-facing exit. Liveness is protocol-guaranteed, not keeper-dependent.

---

## Out of scope

- **Anchor compiler / framework bugs**: trust 0.32.1 as-is.
- **kamino-lend crate**: pinned at `=0.4.1` ([Cargo.toml](programs/anemone/Cargo.toml)). Drift detection lives in update_rate_index. Audit Kamino itself separately.
- **Off-chain keeper bot**: under [keeper/](keeper/). Compromise of the keeper key cannot cause direct fund loss (PR #26 + #27 removed the dependency), but a compromised keeper could withhold rebalancing forever. Documented in [keeper/SECURITY.md] (TODO if not present).
- **Front-running / MEV at the slot level**: Solana's leader scheduling and Jito bundle dynamics. Slippage protection in open_swap (`max_rate_bps` / `min_rate_bps`) is the local defense. Lateral mitigation (private mempool, etc.) is outside scope.
- **Token decimals other than 6**: assumed via USDC. Anything else needs review of fee math, share math, and circuit breaker calibrations.

---

## Recommended pre-mainnet checklist

Ordered by what would block a launch.

1. **~~CRITICAL — Close Finding 2~~** — resolved in `feat/rate-index-collapse-fix`. Layer 1+2+3 defense shipped.
2. **HIGH — Implement mainnet `sync_kamino_yield`** (Finding 1). Without it the protocol is bricked 10 minutes post-launch.
3. **HIGH — Pair Finding 1 with the snapshot fix** (Finding 6) so the first sync does not double-count principal.
4. **MEDIUM — Gate `withdraw_from_kamino`** to keeper (Finding 3) — internal CPIs cover all user paths now.
5. **MEDIUM — Decide on the queued-withdrawal pattern** (Finding 5): cooldown or remove.
6. **LOW — Trim dead code** — at minimum `InsufficientVaultLiquidity`, `protocol_fee_bps` (or wire it), `cumulative_fees_earned` (or wire it), and `market.status` + `MarketPaused` (or implement per-market pause).
7. **LOW — Add minimum-margin enforcement** (Finding 9) so dust positions cannot grief the keeper.
8. **LOW — Validate `treasury` at init** (Finding 8) — defense-in-depth against admin typos.
9. **Third-party audit** at the level of OtterSec / Sec3 / Neodyme before any TVL beyond a guarded beta cap (e.g. $50k notional cap enforced at the program level).

Items 1–3 are launch blockers. Items 4–8 are hardening that should land before audit.
