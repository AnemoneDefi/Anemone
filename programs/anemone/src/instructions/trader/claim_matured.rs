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
    pub market: Box<Account<'info, SwapMarket>>,

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

    /// LP vault — source of any unpaid_pnl catchup before claim.
    #[account(
        mut,
        address = market.lp_vault @ AnemoneError::InvalidVault,
    )]
    pub lp_vault: Box<InterfaceAccount<'info, TokenAccount>>,

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

    let direction = position.direction;
    let notional = position.notional;

    let reserve_key = market.underlying_reserve;
    let tenor_bytes = market.tenor_seconds.to_le_bytes();
    let bump = market.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"market",
        reserve_key.as_ref(),
        &tenor_bytes,
        &[bump],
    ]];

    // H1 catchup: after maturity, settle_period no longer runs (status is
    // Matured, not Open), so any unpaid_pnl from the final settle can only
    // be paid here. If the lp_vault is still short, the claim reverts with
    // UnpaidPnlOutstanding — trader waits for the keeper to refill.
    let catchup_amount: u64 = if position.unpaid_pnl > 0 && ctx.accounts.lp_vault.amount > 0 {
        let amount = (position.unpaid_pnl as u64).min(ctx.accounts.lp_vault.amount);
        if amount > 0 {
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.lp_vault.to_account_info(),
                        to: ctx.accounts.collateral_vault.to_account_info(),
                        authority: ctx.accounts.market.to_account_info(),
                        mint: ctx.accounts.underlying_mint.to_account_info(),
                    },
                    signer_seeds,
                ),
                amount,
                ctx.accounts.underlying_mint.decimals,
            )?;
        }
        amount
    } else {
        0
    };

    let unpaid_after: i64 = position.unpaid_pnl
        .checked_sub(catchup_amount as i64)
        .ok_or(AnemoneError::MathOverflow)?;
    require!(unpaid_after == 0, AnemoneError::UnpaidPnlOutstanding);

    let amount = position.collateral_remaining
        .checked_add(catchup_amount)
        .ok_or(AnemoneError::MathOverflow)?;

    // Transfer (collateral_remaining + catchup) from collateral_vault to owner.
    if amount > 0 {
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

    // Update market totals + lp_nav for the catchup drain.
    let market = &mut ctx.accounts.market;
    if catchup_amount > 0 {
        market.lp_nav = market.lp_nav
            .checked_sub(catchup_amount)
            .ok_or(AnemoneError::MathOverflow)?;
    }
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
