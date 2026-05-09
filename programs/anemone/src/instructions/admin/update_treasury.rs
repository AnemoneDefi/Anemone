use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;
use crate::state::ProtocolState;
use crate::errors::AnemoneError;

/// Admin-only: rotate the protocol treasury account. The new account is
/// validated as a SPL token account at this boundary so that admin typos
/// surface here instead of at the first fee transfer (mirrors the same
/// pattern used by `initialize_protocol`). Mint is not checked here — each
/// market's `open_swap`, `request_withdrawal`, etc. enforce
/// `token::mint = underlying_mint` against this address downstream.
#[derive(Accounts)]
pub struct UpdateTreasury<'info> {
    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_state.bump,
        has_one = authority @ AnemoneError::InvalidAuthority,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    pub new_treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    pub authority: Signer<'info>,
}

pub fn handle_update_treasury(ctx: Context<UpdateTreasury>) -> Result<()> {
    let protocol_state = &mut ctx.accounts.protocol_state;
    protocol_state.treasury = ctx.accounts.new_treasury.key();

    msg!("Treasury updated to {}", ctx.accounts.new_treasury.key());
    Ok(())
}
