use anchor_lang::prelude::*;
use crate::state::ProtocolState;
use crate::errors::AnemoneError;

#[derive(Accounts)]
pub struct SetKeeper<'info> {
    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_state.bump,
        has_one = authority @ AnemoneError::InvalidAuthority,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    pub authority: Signer<'info>,
}

pub fn handle_set_keeper(ctx: Context<SetKeeper>, new_keeper: Pubkey) -> Result<()> {
    let protocol_state = &mut ctx.accounts.protocol_state;
    protocol_state.keeper_authority = new_keeper;

    msg!("Keeper authority updated to {}", new_keeper);
    Ok(())
}
