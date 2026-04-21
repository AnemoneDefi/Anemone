use anchor_lang::prelude::*;
use crate::state::{ProtocolState, SwapMarket};
use crate::errors::AnemoneError;

/// Admin-only stub for environments where Kamino K-Lend is not deployed
/// (notably devnet). Sets the market's rate index directly with the same
/// rotate pattern as `update_rate_index`. Intended for testing/demo; in
/// production this should be disabled or guarded by a feature flag.
#[derive(Accounts)]
pub struct SetRateIndexOracle<'info> {
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

pub fn handle_set_rate_index_oracle(
    ctx: Context<SetRateIndexOracle>,
    rate_index: u128,
) -> Result<()> {
    require!(rate_index > 0, AnemoneError::InvalidRateIndex);

    let market = &mut ctx.accounts.market;

    // Rotate: current -> previous (same pattern as update_rate_index.rs:48-54)
    if market.current_rate_index > 0 {
        market.previous_rate_index = market.current_rate_index;
        market.previous_rate_update_ts = market.last_rate_update_ts;
    }
    market.current_rate_index = rate_index;
    market.last_rate_update_ts = Clock::get()?.unix_timestamp;

    msg!("Rate index oracle set to {}", rate_index);
    Ok(())
}
