use anchor_lang::prelude::*;
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

    /// Kamino Reserve account — read-only, raw bytes.
    /// Must match the reserve this market was created with.
    /// CHECK: We read raw bytes at the known offset for cumulative_borrow_rate_bsf.
    ///        The address is validated against market.underlying_reserve.
    #[account(
        constraint = kamino_reserve.key() == market.underlying_reserve
            @ AnemoneError::InvalidReserve
    )]
    pub kamino_reserve: AccountInfo<'info>,
}

pub fn handle_update_rate_index(ctx: Context<UpdateRateIndex>) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let rate_index = read_kamino_rate_index(&ctx.accounts.kamino_reserve)?;

    require!(rate_index > 0, AnemoneError::InvalidRateIndex);

    market.current_rate_index = rate_index;
    market.last_rate_update_ts = Clock::get()?.unix_timestamp;

    msg!("Rate index updated: {}", rate_index);

    Ok(())
}
