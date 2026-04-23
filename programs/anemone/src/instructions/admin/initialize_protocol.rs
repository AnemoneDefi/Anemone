use anchor_lang::prelude::*;
use crate::state::ProtocolState;
use crate::errors::AnemoneError;

// H5 fee caps. Calibrated against real DeFi comps (GMX, Pendle, Aave)
// plus a healthy safety factor so an admin typo can't render the
// protocol insolvent or DoS liquidations.
//
//   protocol_fee_bps    max 2000 = 20%  (perf fee on LP yield — generous)
//   opening_fee_bps     max  100 = 1%   (paid by trader up-front)
//   liquidation_fee_bps max 1000 = 10%  (keeper incentive — above 10%
//                                       and liquidations become a
//                                       profit center that destabilizes)
//   withdrawal_fee_bps  max  100 = 1%   (LP exit friction)
//   early_close_fee_bps max 2000 = 20%  (discourages churn without
//                                       making exits punitive)
pub const MAX_PROTOCOL_FEE_BPS: u16 = 2_000;
pub const MAX_OPENING_FEE_BPS: u16 = 100;
pub const MAX_LIQUIDATION_FEE_BPS: u16 = 1_000;
pub const MAX_WITHDRAWAL_FEE_BPS: u16 = 100;
pub const MAX_EARLY_CLOSE_FEE_BPS: u16 = 2_000;

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(
        init,
        payer = authority,
        space = ProtocolState::SIZE,
        seeds = [b"protocol"],
        bump
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Treasury token account, validated by admin off-chain
    pub treasury: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_protocol(
    ctx: Context<InitializeProtocol>,
    protocol_fee_bps: u16,
    opening_fee_bps: u16,
    liquidation_fee_bps: u16,
    withdrawal_fee_bps: u16,
    early_close_fee_bps: u16,
) -> Result<()> {
    require!(protocol_fee_bps    <= MAX_PROTOCOL_FEE_BPS,    AnemoneError::ParamOutOfRange);
    require!(opening_fee_bps     <= MAX_OPENING_FEE_BPS,     AnemoneError::ParamOutOfRange);
    require!(liquidation_fee_bps <= MAX_LIQUIDATION_FEE_BPS, AnemoneError::ParamOutOfRange);
    require!(withdrawal_fee_bps  <= MAX_WITHDRAWAL_FEE_BPS,  AnemoneError::ParamOutOfRange);
    require!(early_close_fee_bps <= MAX_EARLY_CLOSE_FEE_BPS, AnemoneError::ParamOutOfRange);

    let protocol_state = &mut ctx.accounts.protocol_state;

    protocol_state.authority = ctx.accounts.authority.key();
    // Default keeper = authority. Admin can rotate later via `set_keeper`.
    protocol_state.keeper_authority = ctx.accounts.authority.key();
    protocol_state.treasury = ctx.accounts.treasury.key();
    protocol_state.total_markets = 0;
    protocol_state.protocol_fee_bps = protocol_fee_bps;
    protocol_state.opening_fee_bps = opening_fee_bps;
    protocol_state.liquidation_fee_bps = liquidation_fee_bps;
    protocol_state.withdrawal_fee_bps = withdrawal_fee_bps;
    protocol_state.early_close_fee_bps = early_close_fee_bps;
    protocol_state.bump = ctx.bumps.protocol_state;

    msg!("Protocol initialized with fees: opening={}bps, perf={}bps, liq={}bps, withdraw={}bps, early_close={}bps",
        opening_fee_bps, protocol_fee_bps, liquidation_fee_bps, withdrawal_fee_bps, early_close_fee_bps);

    Ok(())
}
