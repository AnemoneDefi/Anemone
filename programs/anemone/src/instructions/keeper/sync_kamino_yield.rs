use anchor_lang::prelude::*;
use crate::state::SwapMarket;
#[cfg(not(feature = "stub-oracle"))]
use crate::errors::AnemoneError;

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
// The real implementation needs:
//   1. kamino_reserve: AccountLoader<Reserve>  — to read exchange rate
//   2. kamino_deposit_account: token account   — to read our k-token balance
//   3. kamino_program: the K-Lend program      — for refresh_reserve CPI
//
// Flow:
//   refresh_reserve CPI → read reserve.liquidity.total_liquidity and
//   reserve.collateral.mint_total_supply → compute exchange_rate →
//   kamino_value_usdc = kamino_deposit_account.amount * exchange_rate →
//   delta = kamino_value_usdc - market.last_kamino_snapshot_usdc →
//   market.lp_nav += delta (saturating at 0 if delta < 0) →
//   market.last_kamino_snapshot_usdc = kamino_value_usdc →
//   market.last_kamino_sync_ts = now
//
// Defer to Day 21 Surfpool work so the implementation can be validated
// against a live Kamino reserve.

#[cfg(not(feature = "stub-oracle"))]
#[derive(Accounts)]
pub struct SyncKaminoYield<'info> {
    #[account(
        mut,
        seeds = [b"market", market.underlying_reserve.as_ref(), &market.tenor_seconds.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, SwapMarket>,
    // TODO(mainnet): kamino_reserve, kamino_deposit_account, kamino_program
    // — wired in Day 21 Surfpool pass.
}

#[cfg(not(feature = "stub-oracle"))]
pub fn handle_sync_kamino_yield(_ctx: Context<SyncKaminoYield>) -> Result<()> {
    // Mainnet implementation pending — see TODO(mainnet) above. Returning
    // an error here instead of silently noop'ing so callers on a mainnet
    // build know the work is not yet wired.
    Err(AnemoneError::InvalidAmount.into())
}
