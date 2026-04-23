use anchor_lang::prelude::*;
use kamino_lend::state::Reserve;
use crate::state::SwapMarket;
use crate::helpers::read_kamino_rate_index;
use crate::errors::AnemoneError;

#[derive(Accounts)]
pub struct UpdateRateIndex<'info> {
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
}

/// Maximum slots a Reserve can be stale before we reject the update (~5 minutes)
pub const MAX_STALE_SLOTS: u64 = 750;

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

    require!(rate_index > 0, AnemoneError::InvalidRateIndex);

    // Rotate: current → previous (keeps two snapshots for APY calculation)
    if market.current_rate_index > 0 {
        market.previous_rate_index = market.current_rate_index;
        market.previous_rate_update_ts = market.last_rate_update_ts;
    }

    market.current_rate_index = rate_index;
    market.last_rate_update_ts = Clock::get()?.unix_timestamp;

    msg!("Rate index updated: {}", rate_index);

    Ok(())
}
