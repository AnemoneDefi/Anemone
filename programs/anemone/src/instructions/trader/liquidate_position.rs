use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    Mint, TokenAccount, TokenInterface,
    transfer_checked, TransferChecked,
};
use crate::state::{SwapMarket, SwapPosition, SwapDirection, PositionStatus, ProtocolState};
use crate::helpers::calculate_maintenance_margin;
use crate::errors::AnemoneError;

#[derive(Accounts)]
pub struct LiquidatePosition<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(
        mut,
        seeds = [b"market", market.underlying_reserve.as_ref(), &market.tenor_seconds.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, SwapMarket>,

    #[account(
        mut,
        close = owner,
        seeds = [b"swap", swap_position.owner.as_ref(), market.key().as_ref(), &[swap_position.nonce]],
        bump = swap_position.bump,
        constraint = swap_position.market == market.key() @ AnemoneError::InvalidVault,
        constraint = swap_position.status == PositionStatus::Open @ AnemoneError::PositionNotOpen,
    )]
    pub swap_position: Account<'info, SwapPosition>,

    /// Collateral vault — source of fee + remainder
    #[account(
        mut,
        address = market.collateral_vault @ AnemoneError::InvalidVault,
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Owner of the position — receives rent on close, no signer required
    /// CHECK: Validated via swap_position.owner constraint and close = owner
    #[account(
        mut,
        constraint = owner.key() == swap_position.owner @ AnemoneError::InvalidVault,
    )]
    pub owner: UncheckedAccount<'info>,

    /// Owner's token account — receives remainder after liquidation fee
    #[account(
        mut,
        token::mint = underlying_mint,
        constraint = owner_token_account.owner == swap_position.owner @ AnemoneError::InvalidVault,
    )]
    pub owner_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Liquidator's token account — receives the liquidation fee
    #[account(
        mut,
        token::mint = underlying_mint,
        token::authority = liquidator,
    )]
    pub liquidator_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The underlying token mint (e.g. USDC)
    #[account(
        address = market.underlying_mint @ AnemoneError::InvalidMint,
    )]
    pub underlying_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Anyone can liquidate (permissionless — earns 3% as incentive)
    pub liquidator: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_liquidate_position(ctx: Context<LiquidatePosition>) -> Result<()> {
    let position = &ctx.accounts.swap_position;
    let market = &ctx.accounts.market;
    let protocol_state = &ctx.accounts.protocol_state;

    // Validate: position is below maintenance margin
    let maintenance = calculate_maintenance_margin(position.notional, market.tenor_seconds)?;
    require!(
        position.collateral_remaining < maintenance,
        AnemoneError::AboveMaintenanceMargin
    );

    let collateral = position.collateral_remaining;
    let direction = position.direction;
    let notional = position.notional;

    // Calculate liquidation fee (default 3% of collateral_remaining)
    let fee = (collateral as u128)
        .checked_mul(protocol_state.liquidation_fee_bps as u128)
        .and_then(|v| v.checked_div(10_000))
        .ok_or(AnemoneError::MathOverflow)? as u64;
    let remainder = collateral.checked_sub(fee).ok_or(AnemoneError::MathOverflow)?;

    // PDA signer seeds for vault transfers
    let reserve_key = market.underlying_reserve;
    let tenor_bytes = market.tenor_seconds.to_le_bytes();
    let bump = market.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"market",
        reserve_key.as_ref(),
        &tenor_bytes,
        &[bump],
    ]];

    // Transfer fee to liquidator
    if fee > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.collateral_vault.to_account_info(),
                    to: ctx.accounts.liquidator_token_account.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                    mint: ctx.accounts.underlying_mint.to_account_info(),
                },
                signer_seeds,
            ),
            fee,
            ctx.accounts.underlying_mint.decimals,
        )?;
    }

    // Transfer remainder to owner
    if remainder > 0 {
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
            remainder,
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

    msg!(
        "Liquidated: fee={} to liquidator={}, remainder={} to owner={}",
        fee, ctx.accounts.liquidator.key(), remainder, ctx.accounts.owner.key()
    );

    Ok(())
}
