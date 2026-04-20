use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    Mint, TokenAccount, TokenInterface,
    transfer_checked, TransferChecked,
};
use crate::state::{SwapMarket, SwapPosition, PositionStatus};
use crate::errors::AnemoneError;

#[derive(Accounts)]
pub struct AddCollateral<'info> {
    #[account(
        seeds = [b"market", market.underlying_reserve.as_ref(), &market.tenor_seconds.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, SwapMarket>,

    #[account(
        mut,
        seeds = [b"swap", owner.key().as_ref(), market.key().as_ref(), &[swap_position.nonce]],
        bump = swap_position.bump,
        constraint = swap_position.owner == owner.key() @ AnemoneError::InvalidVault,
        constraint = swap_position.market == market.key() @ AnemoneError::InvalidVault,
        constraint = swap_position.status == PositionStatus::Open @ AnemoneError::PositionNotOpen,
    )]
    pub swap_position: Account<'info, SwapPosition>,

    /// Collateral vault — destination of the added USDC
    #[account(
        mut,
        address = market.collateral_vault @ AnemoneError::InvalidVault,
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The underlying token mint (e.g. USDC)
    #[account(
        address = market.underlying_mint @ AnemoneError::InvalidMint,
    )]
    pub underlying_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Owner's token account — source of the added collateral
    #[account(
        mut,
        token::mint = underlying_mint,
        token::authority = owner,
    )]
    pub owner_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_add_collateral(ctx: Context<AddCollateral>, amount: u64) -> Result<()> {
    require!(amount > 0, AnemoneError::InvalidAmount);

    // Transfer amount: owner_token_account → collateral_vault (owner signs directly)
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.owner_token_account.to_account_info(),
                to: ctx.accounts.collateral_vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
                mint: ctx.accounts.underlying_mint.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.underlying_mint.decimals,
    )?;

    // Increment collateral_remaining on the position
    let position = &mut ctx.accounts.swap_position;
    position.collateral_remaining = position.collateral_remaining
        .checked_add(amount)
        .ok_or(AnemoneError::MathOverflow)?;

    msg!(
        "Added {} collateral to position (new total: {})",
        amount, position.collateral_remaining
    );

    Ok(())
}
