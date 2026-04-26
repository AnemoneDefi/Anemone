use anchor_lang::prelude::*;
use kamino_lend::state::Reserve;
use crate::state::{SwapMarket, ProtocolState};
use crate::helpers::read_kamino_rate_index;
use crate::errors::AnemoneError;

#[derive(Accounts)]
pub struct UpdateRateIndex<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(
        mut,
        seeds = [b"market", market.underlying_reserve.as_ref(), &market.tenor_seconds.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, SwapMarket>,

    /// Kamino Reserve account — must match what the market was created with.
    #[account(
        constraint = kamino_reserve.key() == market.underlying_reserve
            @ AnemoneError::InvalidReserve
    )]
    pub kamino_reserve: AccountLoader<'info, Reserve>,

    /// Layer 1 of the rate-index-collapse defense (see SECURITY.md Finding 2).
    /// Permissionless update_rate_index lets an attacker bundle two calls in
    /// a single tx so both reads see the same Kamino bsf — the rotation then
    /// collapses `previous_rate_index == current_rate_index`, and the next
    /// open_swap quotes apy = 0 against PayFixed for ~spread bps. Gating to
    /// the keeper closes the trivial path; layer 2 (no-op rotation reject)
    /// and layer 3 (open_swap apy=0 reject) cover keeper-bot misfires and
    /// future regressions.
    #[account(
        constraint = keeper.key() == protocol_state.keeper_authority
            @ AnemoneError::InvalidAuthority,
    )]
    pub keeper: Signer<'info>,
}

/// Maximum slots a Reserve can be stale before we reject the update (~5 minutes)
pub const MAX_STALE_SLOTS: u64 = 750;

/// Layer 2 of the rate-index-collapse defense. Even with keeper-only access,
/// a buggy cron / retry could double-fire and collapse the snapshots. We
/// require at least this many seconds between updates so the snapshot pair
/// stays well-separated. Set conservatively low — keeper cadence is minutes,
/// not seconds, so this is just a floor against same-second double-fires.
pub const MIN_RATE_UPDATE_ELAPSED_SECS: i64 = 8;

pub fn handle_update_rate_index(ctx: Context<UpdateRateIndex>) -> Result<()> {
    let reserve = ctx.accounts.kamino_reserve.load()?;
    let current_slot = Clock::get()?.slot;

    // H2: defense-in-depth against Kamino struct layout drift. If a future
    // kamino-lend bump changes field offsets without us noticing, reading
    // `cumulative_borrow_rate_bsf` returns garbage — the Cargo.toml pin
    // (Fase 0) stops silent version upgrades but does not catch a Kamino
    // mainnet program upgrade that keeps the crate version. Cross-check
    // that the reserve's underlying mint matches what the market was
    // created with; if the offsets moved, this field almost certainly
    // deserializes as something else and the compare fails loudly
    // instead of us computing PnL against a junk rate index.
    //
    // Only enforced on mainnet builds (stub-oracle disabled). Devnet and
    // localnet tests use fake mints paired with the Kamino mainnet reserve
    // fixture, which would fail this check without undermining the actual
    // safety property (there is no Kamino program to mis-read in stub mode).
    #[cfg(not(feature = "stub-oracle"))]
    require!(
        reserve.liquidity.mint_pubkey == ctx.accounts.market.underlying_mint,
        AnemoneError::InvalidReserve,
    );

    // Reject stale reserve data — attacker could exploit outdated rates.
    // Only enforce when current_slot > reserve slot (skip on localnet where slots start at 0)
    let reserve_slot = reserve.last_update.slot;
    if current_slot > reserve_slot {
        require!(
            current_slot - reserve_slot < MAX_STALE_SLOTS,
            AnemoneError::StaleOracle
        );
    }
    drop(reserve);

    let market = &mut ctx.accounts.market;
    let rate_index = read_kamino_rate_index(&ctx.accounts.kamino_reserve)?;
    let now = Clock::get()?.unix_timestamp;

    require!(rate_index > 0, AnemoneError::InvalidRateIndex);

    // Layer 2 of the rate-index-collapse defense (see SECURITY.md Finding 2).
    // Two checks:
    //
    //   (a) Strictly-monotonic rotation. Kamino's `cumulative_borrow_rate_bsf`
    //       is monotonically non-decreasing. If our read equals the existing
    //       `current_rate_index`, the bsf has not moved and we would just
    //       collapse the snapshot pair (prev = curr after rotation). Reject.
    //
    //   (b) Minimum elapsed since last update. Prevents same-slot/same-second
    //       double-fires where elapsed in open_swap collapses to zero. Also
    //       guards `calculate_current_apy_from_index` against the term3
    //       overflow path that fires when n = year/elapsed grows past u128.
    //
    // First-init path: when current_rate_index == 0 the market has never
    // been seeded — we accept any positive rate_index without the (a) check.
    if market.current_rate_index > 0 {
        require!(
            rate_index > market.current_rate_index,
            AnemoneError::InvalidRateIndex,
        );
        let elapsed_since_last = now
            .checked_sub(market.last_rate_update_ts)
            .ok_or(AnemoneError::MathOverflow)?;
        require!(
            elapsed_since_last >= MIN_RATE_UPDATE_ELAPSED_SECS,
            AnemoneError::InvalidElapsedTime,
        );
    }

    // Rotate: current → previous (keeps two snapshots for APY calculation)
    if market.current_rate_index > 0 {
        market.previous_rate_index = market.current_rate_index;
        market.previous_rate_update_ts = market.last_rate_update_ts;
    }

    market.current_rate_index = rate_index;
    market.last_rate_update_ts = now;

    msg!("Rate index updated: {}", rate_index);

    Ok(())
}
