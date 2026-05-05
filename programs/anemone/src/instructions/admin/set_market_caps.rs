use anchor_lang::prelude::*;
use crate::state::{ProtocolState, SwapMarket};
use crate::errors::AnemoneError;

/// Updates the v0.1 mainnet caps on an existing market. Both must be > 0;
/// pass `u64::MAX` to effectively disable a cap.
///
/// Same authority gate as the rest of admin (`has_one = authority`). Existing
/// LP positions and open trades are unaffected — only future deposits and
/// `open_swap` calls see the new limits.
#[derive(Accounts)]
pub struct SetMarketCaps<'info> {
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

pub fn handle_set_market_caps(
    ctx: Context<SetMarketCaps>,
    max_lp_nav: u64,
    max_position_notional: u64,
) -> Result<()> {
    require!(max_lp_nav > 0, AnemoneError::ParamOutOfRange);
    require!(max_position_notional > 0, AnemoneError::ParamOutOfRange);

    let market = &mut ctx.accounts.market;
    market.max_lp_nav = max_lp_nav;
    market.max_position_notional = max_position_notional;

    msg!(
        "Market caps updated: max_lp_nav={}, max_position_notional={}",
        max_lp_nav, max_position_notional,
    );
    Ok(())
}
