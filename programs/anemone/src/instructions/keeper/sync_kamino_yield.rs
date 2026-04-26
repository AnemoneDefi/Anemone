use anchor_lang::prelude::*;
use crate::state::SwapMarket;
#[cfg(not(feature = "stub-oracle"))]
use {
    anchor_spl::token_interface::{TokenAccount, TokenInterface},
    kamino_lend::state::Reserve,
    crate::errors::AnemoneError,
    crate::helpers::{cpi_refresh_reserve, read_kamino_collateral_to_liquidity},
};

/// Refreshes the LP NAV against the current value of the k-tokens held in
/// `kamino_deposit_account`. The delta since the previous sync becomes new
/// yield credited to `lp_nav` — this is how Kamino-earned interest reaches
/// LP share price.
///
/// Permissionless. Frontends bundle this before user-facing LP ops (see the
/// staleness require in deposit_liquidity / request_withdrawal /
/// claim_withdrawal). The keeper also runs it on a periodic cron to keep
/// the snapshot warm for callers who do not bundle.
///
/// Feature-gated by `stub-oracle`:
///   * with feature: no Kamino CPI — just bumps `last_kamino_sync_ts` so the
///     staleness gate passes in devnet/localnet demos where Kamino isn't
///     deployed. `lp_nav` stays untouched because the lp_vault holds all
///     USDC directly in this mode.
///   * without feature (mainnet): refresh_reserve CPI + read collateral
///     exchange rate + credit the delta. Will be wired alongside the
///     Surfpool integration (Day 21) when we can actually exercise the
///     Kamino read path end-to-end.
#[cfg(feature = "stub-oracle")]
#[derive(Accounts)]
pub struct SyncKaminoYield<'info> {
    #[account(
        mut,
        seeds = [b"market", market.underlying_reserve.as_ref(), &market.tenor_seconds.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, SwapMarket>,
}

#[cfg(feature = "stub-oracle")]
pub fn handle_sync_kamino_yield(ctx: Context<SyncKaminoYield>) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let now = Clock::get()?.unix_timestamp;

    // Stub mode: no Kamino to read. lp_vault holds all USDC in this mode, so
    // lp_nav does not drift between calls — we only refresh the timestamp so
    // the staleness gate in deposit/withdrawal passes.
    market.last_kamino_sync_ts = now;

    msg!("sync_kamino_yield (stub): last_sync_ts = {}", now);
    Ok(())
}

// --- Mainnet path (stub-oracle disabled) -------------------------------
//
// Refreshes the Kamino reserve, reads the collateral-to-liquidity exchange
// rate, computes the USDC value of our k-token balance, and credits the
// delta since `last_kamino_snapshot_usdc` into `lp_nav`. Permissionless —
// frontends bundle this before LP ops so they pass the staleness gate; the
// keeper also runs it on a periodic cron.

#[cfg(not(feature = "stub-oracle"))]
#[derive(Accounts)]
pub struct SyncKaminoYield<'info> {
    #[account(
        mut,
        seeds = [b"market", market.underlying_reserve.as_ref(), &market.tenor_seconds.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, SwapMarket>,

    /// Kamino Reserve — must match the market's underlying_reserve. The
    /// AccountLoader handles deserialization for the post-refresh read.
    #[account(
        mut,
        constraint = kamino_reserve.key() == market.underlying_reserve
            @ AnemoneError::InvalidReserve,
    )]
    pub kamino_reserve: AccountLoader<'info, Reserve>,

    /// Our k-token balance — the input to the USDC-value math.
    #[account(
        address = market.kamino_deposit_account @ AnemoneError::InvalidVault,
    )]
    pub kamino_deposit_account: Box<InterfaceAccount<'info, TokenAccount>>,

    // --- Accounts the refresh_reserve CPI needs ---

    /// CHECK: Validated by Kamino during CPI
    pub kamino_lending_market: AccountInfo<'info>,

    /// CHECK: Pyth oracle. Pass kamino_program as placeholder when reserve
    /// is configured for a different price source.
    pub pyth_oracle: AccountInfo<'info>,

    /// CHECK: Switchboard price oracle. Same placeholder convention.
    pub switchboard_price_oracle: AccountInfo<'info>,

    /// CHECK: Switchboard TWAP oracle. Same placeholder convention.
    pub switchboard_twap_oracle: AccountInfo<'info>,

    /// CHECK: Scope prices oracle. Required for USDC reserve (Scope is the
    /// configured price source).
    pub scope_prices: AccountInfo<'info>,

    /// CHECK: Validated against market.underlying_protocol below.
    #[account(
        constraint = kamino_program.key() == market.underlying_protocol @ AnemoneError::InvalidReserve,
    )]
    pub kamino_program: AccountInfo<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[cfg(not(feature = "stub-oracle"))]
pub fn handle_sync_kamino_yield(ctx: Context<SyncKaminoYield>) -> Result<()> {
    // 1. Refresh the reserve so subsequent reads see post-accrual values.
    cpi_refresh_reserve(
        &ctx.accounts.kamino_program,
        &ctx.accounts.kamino_reserve.to_account_info(),
        &ctx.accounts.kamino_lending_market,
        &ctx.accounts.pyth_oracle,
        &ctx.accounts.switchboard_price_oracle,
        &ctx.accounts.switchboard_twap_oracle,
        &ctx.accounts.scope_prices,
    )?;

    // 2. Compute our k-token balance's USDC value at the post-refresh rate.
    let our_k_balance = ctx.accounts.kamino_deposit_account.amount;
    let kamino_value_usdc = read_kamino_collateral_to_liquidity(
        &ctx.accounts.kamino_reserve,
        our_k_balance,
    )?;

    // 3. Credit the yield delta to lp_nav. Saturating sub: if the value went
    //    DOWN since last snapshot (Kamino bad debt event), we don't subtract
    //    from lp_nav — that would burn LP shares for an event the LP didn't
    //    cause. The protocol absorbs the loss silently in this case; admin
    //    response is to halt new positions and investigate.
    let market = &mut ctx.accounts.market;
    let delta = kamino_value_usdc.saturating_sub(market.last_kamino_snapshot_usdc);
    if delta > 0 {
        market.lp_nav = market.lp_nav
            .checked_add(delta)
            .ok_or(AnemoneError::MathOverflow)?;
    }
    market.last_kamino_snapshot_usdc = kamino_value_usdc;
    market.last_kamino_sync_ts = Clock::get()?.unix_timestamp;

    msg!(
        "sync_kamino_yield: kamino_value_usdc={}, credited_delta={}",
        kamino_value_usdc, delta,
    );
    Ok(())
}
