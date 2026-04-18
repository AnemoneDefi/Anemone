use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    Mint, TokenAccount, TokenInterface,
    transfer_checked, TransferChecked,
};
use crate::state::{SwapMarket, SwapPosition, SwapDirection, PositionStatus};
use crate::errors::AnemoneError;

#[derive(Accounts)]
pub struct ClaimMatured<'info> {
    #[account(
        mut,
        seeds = [b"market", market.underlying_reserve.as_ref(), &market.tenor_seconds.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, SwapMarket>,

    #[account(
        mut,
        close = owner,
        seeds = [b"swap", owner.key().as_ref(), market.key().as_ref(), &[swap_position.nonce]],
        bump = swap_position.bump,
        constraint = swap_position.owner == owner.key() @ AnemoneError::InvalidVault,
        constraint = swap_position.market == market.key() @ AnemoneError::InvalidVault,
        constraint = swap_position.status == PositionStatus::Matured @ AnemoneError::PositionNotMatured,
    )]
    pub swap_position: Account<'info, SwapPosition>,

    /// Collateral vault — source of the matured collateral
    #[account(
        mut,
        address = market.collateral_vault @ AnemoneError::InvalidVault,
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Owner's token account — receives collateral_remaining
    #[account(
        mut,
        token::mint = underlying_mint,
        token::authority = owner,
    )]
    pub owner_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The underlying token mint (e.g. USDC)
    #[account(
        address = market.underlying_mint @ AnemoneError::InvalidMint,
    )]
    pub underlying_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_claim_matured(ctx: Context<ClaimMatured>) -> Result<()> {
    let position = &ctx.accounts.swap_position;
    let market = &ctx.accounts.market;

    let amount = position.collateral_remaining;
    let direction = position.direction;
    let notional = position.notional;

    // Transfer collateral_remaining from collateral_vault to owner (market PDA signs)
    if amount > 0 {
        let reserve_key = market.underlying_reserve;
        let tenor_bytes = market.tenor_seconds.to_le_bytes();
        let bump = market.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"market",
            reserve_key.as_ref(),
            &tenor_bytes,
            &[bump],
        ]];

        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.collateral_vault.to_account_info(),
                    to: ctx.accounts.owner_token_account.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                    mint: ctx.accounts.underlying_mint.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
            ctx.accounts.underlying_mint.decimals,
        )?;
    }

    // Update market totals
    let market = &mut ctx.accounts.market;
    match direction {
        SwapDirection::PayFixed => {
            market.total_fixed_notional = market.total_fixed_notional
                .checked_sub(notional)
                .ok_or(AnemoneError::MathOverflow)?;
        }
        SwapDirection::ReceiveFixed => {
            market.total_variable_notional = market.total_variable_notional
                .checked_sub(notional)
                .ok_or(AnemoneError::MathOverflow)?;
        }
    }
    market.total_open_positions = market.total_open_positions
        .checked_sub(1)
        .ok_or(AnemoneError::MathOverflow)?;

    msg!("Claim matured: returned {} to {}", amount, ctx.accounts.owner.key());

    Ok(())
}
