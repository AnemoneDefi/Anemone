use anchor_lang::prelude::*;
use crate::state::{ProtocolState, SwapMarket};
use crate::errors::AnemoneError;

/// Per-market pause switch. Mirrors the global `pause_protocol` design but
/// scoped to one market — admin can freeze a single market (e.g. Kamino USDC
/// went volatile, want to stop new positions there) without halting other
/// markets. Same narrowness as the global pause: only `open_swap` and
/// `deposit_liquidity` reject when a market is paused; settlement,
/// liquidation, claim, close_early, and request_withdrawal stay live so
/// admin cannot trap user funds in-flight.
///
/// `market.status` values: 0 = active, 1 = paused. The constraint
/// `market.status == 0` already lives in `open_swap` and `deposit_liquidity`;
/// these handlers just flip the field.
#[derive(Accounts)]
pub struct PauseMarket<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_state.bump,
        has_one = authority @ AnemoneError::InvalidAuthority,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(
        mut,
        seeds = [b"market", market.underlying_reserve.as_ref(), &market.tenor_seconds.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, SwapMarket>,

    pub authority: Signer<'info>,
}

pub fn handle_pause_market(ctx: Context<PauseMarket>) -> Result<()> {
    ctx.accounts.market.status = 1;
    msg!("Market paused: {}", ctx.accounts.market.key());
    Ok(())
}

pub fn handle_unpause_market(ctx: Context<PauseMarket>) -> Result<()> {
    ctx.accounts.market.status = 0;
    msg!("Market unpaused: {}", ctx.accounts.market.key());
    Ok(())
}
