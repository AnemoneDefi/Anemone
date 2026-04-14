use anchor_lang::prelude::*;
use crate::state::SwapMarket;
use crate::helpers::read_kamino_rate_index;
use crate::errors::AnemoneError;

/// Byte offset of `last_update.slot` within a Kamino Reserve account.
/// Layout: 8 (discriminator) + 1 (version) + 7 (padding) = 16.
const LAST_UPDATE_SLOT_OFFSET: usize = 16;

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

/// Maximum slots a Reserve can be stale before we reject the update (~5 minutes)
pub const MAX_STALE_SLOTS: u64 = 750;

pub fn handle_update_rate_index(ctx: Context<UpdateRateIndex>) -> Result<()> {
    let current_slot = Clock::get()?.slot;

    // Read last_update.slot directly from raw bytes at the known offset.
    // Consistent with read_kamino_rate_index — no kamino-lend borsh dependency.
    let reserve_slot = {
        let data = ctx.accounts.kamino_reserve.try_borrow_data()?;
        require!(data.len() >= LAST_UPDATE_SLOT_OFFSET + 8, AnemoneError::InvalidRateIndex);
        u64::from_le_bytes(
            data[LAST_UPDATE_SLOT_OFFSET..LAST_UPDATE_SLOT_OFFSET + 8]
                .try_into()
                .map_err(|_| AnemoneError::MathOverflow)?,
        )
    };

    // Reject stale reserve data — attacker could exploit outdated rates.
    // Only enforce when current_slot > reserve slot (skip on localnet where slots start at 0)
    if current_slot > reserve_slot {
        require!(
            current_slot - reserve_slot < MAX_STALE_SLOTS,
            AnemoneError::StaleOracle
        );
    }

    let market = &mut ctx.accounts.market;
    let rate_index = read_kamino_rate_index(&ctx.accounts.kamino_reserve)?;

    require!(rate_index > 0, AnemoneError::InvalidRateIndex);

    market.current_rate_index = rate_index;
    market.last_rate_update_ts = Clock::get()?.unix_timestamp;

    msg!("Rate index updated: {}", rate_index);

    Ok(())
}
