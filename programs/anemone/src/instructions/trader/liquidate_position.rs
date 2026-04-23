use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    Mint, TokenAccount, TokenInterface,
    transfer_checked, TransferChecked,
};
use crate::state::{SwapMarket, SwapPosition, SwapDirection, PositionStatus, ProtocolState};
use crate::helpers::{calculate_maintenance_margin, calculate_period_pnl};
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

    /// LP vault — source/dest for mark-to-market PnL settled on liquidation
    #[account(
        mut,
        address = market.lp_vault @ AnemoneError::InvalidVault,
    )]
    pub lp_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Collateral vault — source of fee + remainder, and dest/source for MtM
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
    let now = Clock::get()?.unix_timestamp;

    let direction = position.direction;
    let notional = position.notional;

    // PDA signer seeds for vault transfers (also needed by MtM block)
    let reserve_key = market.underlying_reserve;
    let tenor_bytes = market.tenor_seconds.to_le_bytes();
    let bump = market.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"market",
        reserve_key.as_ref(),
        &tenor_bytes,
        &[bump],
    ]];

    // H3: mark-to-market PnL since last settlement, *before* the maintenance
    // margin check. Using the raw `collateral_remaining` field (stale between
    // settlements) lets a keeper race settle_period — liquidating a position
    // that is stale-underwater / MtM-healthy (trader loses profit they never
    // got) or skipping one that is stale-healthy / MtM-underwater (LP bleeds
    // while keeper waits for the field to update). Replicates the pattern
    // from close_position_early.
    let elapsed = now
        .checked_sub(position.last_settlement_ts)
        .ok_or(AnemoneError::MathOverflow)?;

    let pnl: i64 = if elapsed <= 0
        || market.current_rate_index == position.last_settled_rate_index
    {
        0
    } else {
        calculate_period_pnl(
            direction,
            notional,
            position.fixed_rate_bps,
            position.last_settled_rate_index,
            market.current_rate_index,
            elapsed,
        )?
    };

    // Execute the MtM transfer between vaults. Capped by available balances —
    // we never try to move more than the source holds. `actual_delta` is the
    // real amount moved, which is what we then apply to the in-memory
    // collateral for the MM check and fee calc.
    let actual_delta: i64 = if pnl > 0 {
        let transfer_amount = (pnl as u64).min(ctx.accounts.lp_vault.amount);
        if transfer_amount > 0 {
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
                transfer_amount,
                ctx.accounts.underlying_mint.decimals,
            )?;
        }
        transfer_amount as i64
    } else if pnl < 0 {
        let loss = ((-pnl) as u64).min(position.collateral_remaining);
        if loss > 0 {
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.collateral_vault.to_account_info(),
                        to: ctx.accounts.lp_vault.to_account_info(),
                        authority: ctx.accounts.market.to_account_info(),
                        mint: ctx.accounts.underlying_mint.to_account_info(),
                    },
                    signer_seeds,
                ),
                loss,
                ctx.accounts.underlying_mint.decimals,
            )?;
        }
        -(loss as i64)
    } else {
        0
    };

    // Apply delta to the in-memory collateral (the vault was physically updated
    // above, so collateral_mtm matches what's actually in collateral_vault).
    let collateral_mtm: u64 = if actual_delta >= 0 {
        position.collateral_remaining
            .checked_add(actual_delta as u64)
            .ok_or(AnemoneError::MathOverflow)?
    } else {
        position.collateral_remaining
            .checked_sub((-actual_delta) as u64)
            .ok_or(AnemoneError::MathOverflow)?
    };

    // NOW check maintenance margin with the MtM-adjusted collateral. If the
    // position is actually healthy after MtM, the whole tx reverts — including
    // the MtM transfer above. The LP only keeps the PnL if the position is
    // truly underwater.
    let maintenance = calculate_maintenance_margin(notional, market.tenor_seconds)?;
    require!(
        collateral_mtm < maintenance,
        AnemoneError::AboveMaintenanceMargin
    );

    // Liquidation fee on the MtM collateral (not the stale field).
    let fee = (collateral_mtm as u128)
        .checked_mul(protocol_state.liquidation_fee_bps as u128)
        .and_then(|v| v.checked_div(10_000))
        .ok_or(AnemoneError::MathOverflow)? as u64;
    let remainder = collateral_mtm.checked_sub(fee).ok_or(AnemoneError::MathOverflow)?;

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
