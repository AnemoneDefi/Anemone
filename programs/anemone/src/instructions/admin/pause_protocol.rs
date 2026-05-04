use anchor_lang::prelude::*;
use crate::state::ProtocolState;
use crate::errors::AnemoneError;

#[derive(Accounts)]
pub struct PauseProtocol<'info> {
    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_state.bump,
        has_one = authority @ AnemoneError::InvalidAuthority,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    pub authority: Signer<'info>,
}

pub fn handle_pause_protocol(ctx: Context<PauseProtocol>) -> Result<()> {
    ctx.accounts.protocol_state.paused = true;
    msg!("Protocol paused");
    Ok(())
}

pub fn handle_unpause_protocol(ctx: Context<PauseProtocol>) -> Result<()> {
    ctx.accounts.protocol_state.paused = false;
    msg!("Protocol unpaused");
    Ok(())
}
