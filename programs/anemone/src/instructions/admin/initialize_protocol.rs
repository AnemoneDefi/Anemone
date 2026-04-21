use anchor_lang::prelude::*;
use crate::state::ProtocolState;

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
