use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    Mint, TokenAccount, TokenInterface,
    transfer_checked, TransferChecked,
};
use crate::state::{SwapMarket, SwapPosition, SwapDirection, PositionStatus, ProtocolState};
use crate::helpers::{calculate_maintenance_margin, calculate_period_pnl, cpi_withdraw_from_kamino};
use crate::errors::AnemoneError;

#[derive(Accounts)]
pub struct LiquidatePosition<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(
        mut,
        seeds = [b"market", market.underlying_reserve.as_ref(), &market.tenor_seconds.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, SwapMarket>>,

    #[account(
        mut,
        close = owner,
        seeds = [b"swap", swap_position.owner.as_ref(), market.key().as_ref(), &[swap_position.nonce]],
        bump = swap_position.bump,
        constraint = swap_position.market == market.key() @ AnemoneError::InvalidVault,
        constraint = swap_position.status == PositionStatus::Open @ AnemoneError::PositionNotOpen,
    )]
    pub swap_position: Box<Account<'info, SwapPosition>>,

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

    // ----- Kamino accounts for internal redeem-on-shortfall -----
    //
    // liquidate_position drains lp_vault for catchup_unpaid_pnl + max(mtm_pnl,
    // 0). If lp_vault is short, the program redeems the difference from
    // Kamino in the same tx. Without this, a liquidator would have to bundle
    // a separate withdraw_from_kamino preInstruction (or wait for the keeper),
    // which re-introduces the grief vector PR #25 opened. See claim_matured.rs
    // for the full design rationale; this is the keeper-side mirror.

    #[account(
        mut,
        address = market.kamino_deposit_account @ AnemoneError::InvalidVault,
    )]
    pub kamino_deposit_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: Validated by Kamino program during CPI
    #[account(mut)]
    pub kamino_reserve: AccountInfo<'info>,

    /// CHECK: Validated by Kamino program during CPI
    pub kamino_lending_market: AccountInfo<'info>,

    /// CHECK: Validated by Kamino program during CPI
    pub kamino_lending_market_authority: AccountInfo<'info>,

    /// CHECK: Validated by Kamino program during CPI; must match underlying_mint
    pub reserve_liquidity_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: Validated by Kamino program during CPI
    #[account(mut)]
    pub reserve_liquidity_supply: AccountInfo<'info>,

    /// CHECK: Validated by Kamino program during CPI
    #[account(mut)]
    pub reserve_collateral_mint: AccountInfo<'info>,

    pub collateral_token_program: Interface<'info, TokenInterface>,

    pub liquidity_token_program: Interface<'info, TokenInterface>,

    /// CHECK: Fixed address validated by Kamino
    pub instruction_sysvar_account: AccountInfo<'info>,

    /// CHECK: Validated against market.underlying_protocol below
    #[account(
        constraint = kamino_program.key() == market.underlying_protocol @ AnemoneError::InvalidReserve,
    )]
    pub kamino_program: AccountInfo<'info>,
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

    // Internal Kamino redeem on shortfall — mirror of close_position_early
    // (see claim_matured.rs for design rationale). Total potential drain on
    // lp_vault = unpaid_pnl + max(pnl, 0); if lp_vault has less, redeem the
    // difference from Kamino now so the liquidation is atomic.
    let total_lp_drain: u64 = (position.unpaid_pnl.max(0) as u64)
        .checked_add(pnl.max(0) as u64)
        .ok_or(AnemoneError::MathOverflow)?;
    let lp_vault_balance = ctx.accounts.lp_vault.amount;
    let mut kamino_redeemed_usdc: u64 = 0;
    if total_lp_drain > lp_vault_balance {
        let shortfall_k = total_lp_drain.saturating_sub(lp_vault_balance);
        let lp_vault_before_cpi = ctx.accounts.lp_vault.amount;
        cpi_withdraw_from_kamino(
            &ctx.accounts.kamino_program,
            &ctx.accounts.market.to_account_info(),
            signer_seeds,
            &ctx.accounts.kamino_reserve,
            &ctx.accounts.kamino_lending_market,
            &ctx.accounts.kamino_lending_market_authority,
            &ctx.accounts.reserve_liquidity_mint.to_account_info(),
            &ctx.accounts.reserve_liquidity_supply,
            &ctx.accounts.reserve_collateral_mint,
            &ctx.accounts.kamino_deposit_account.to_account_info(),
            &ctx.accounts.lp_vault.to_account_info(),
            &ctx.accounts.collateral_token_program.to_account_info(),
            &ctx.accounts.liquidity_token_program.to_account_info(),
            &ctx.accounts.instruction_sysvar_account,
            shortfall_k,
        )?;
        ctx.accounts.lp_vault.reload()?;
        ctx.accounts.kamino_deposit_account.reload()?;
        kamino_redeemed_usdc = ctx.accounts.lp_vault.amount
            .saturating_sub(lp_vault_before_cpi);
    }

    // H1 catchup on existing unpaid_pnl BEFORE the MtM so that a trader
    // who is "stale underwater" only because the LP owed them money gets
    // credited first and is no longer subject to liquidation.
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

    let vault_after_catchup = ctx.accounts.lp_vault.amount.saturating_sub(catchup_amount);

    // Execute the MtM transfer between vaults. Capped by available balances.
    // Shortfall tracking same as settle_period (H1): new unpaid_pnl accrues
    // if vault short, but we later reject the whole liquidation if anything
    // is still unpaid — liquidation is final, can't leave trader with a
    // residual credit.
    let (actual_delta, shortfall): (i64, u64) = if pnl > 0 {
        let transfer_amount = (pnl as u64).min(vault_after_catchup);
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
        let s = (pnl as u64).saturating_sub(transfer_amount);
        (transfer_amount as i64, s)
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
        (-(loss as i64), 0u64)
    } else {
        (0, 0)
    };

    // Reject liquidation if anything remains unpaid — LP still owes the
    // trader but can't cover. Wait for keeper to refill and retry.
    let unpaid_after: i64 = position.unpaid_pnl
        .checked_sub(catchup_amount as i64)
        .ok_or(AnemoneError::MathOverflow)?
        .checked_add(shortfall as i64)
        .ok_or(AnemoneError::MathOverflow)?;
    require!(unpaid_after == 0, AnemoneError::UnpaidPnlOutstanding);

    // Apply catchup + delta to in-memory collateral.
    let collateral_after_catchup: u64 = position.collateral_remaining
        .checked_add(catchup_amount)
        .ok_or(AnemoneError::MathOverflow)?;

    let collateral_mtm: u64 = if actual_delta >= 0 {
        collateral_after_catchup
            .checked_add(actual_delta as u64)
            .ok_or(AnemoneError::MathOverflow)?
    } else {
        collateral_after_catchup
            .checked_sub((-actual_delta) as u64)
            .ok_or(AnemoneError::MathOverflow)?
    };

    // NOW check maintenance margin with the MtM-adjusted collateral (post-
    // catchup). If the position is healthy after we paid the old debt, the
    // whole tx reverts — including both transfers. Liquidation only
    // succeeds when trader is genuinely underwater.
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

    // Update market totals + lp_nav to mirror the MtM + catchup transfers
    // (C2 + H1). Total out of lp_vault = catchup + positive actual_delta.
    // Also mirror any internal Kamino redeem from above into
    // total_kamino_collateral and decrement last_kamino_snapshot_usdc by
    // the delivered USDC so the next sync_kamino_yield computes a clean
    // yield delta.
    let kamino_balance_now = ctx.accounts.kamino_deposit_account.amount;
    let market = &mut ctx.accounts.market;
    market.total_kamino_collateral = kamino_balance_now;
    if kamino_redeemed_usdc > 0 {
        market.last_kamino_snapshot_usdc = market.last_kamino_snapshot_usdc
            .saturating_sub(kamino_redeemed_usdc);
    }
    let combined_out: i64 = (catchup_amount as i64)
        .checked_add(actual_delta.max(0))
        .ok_or(AnemoneError::MathOverflow)?;
    if combined_out > 0 {
        market.lp_nav = market.lp_nav
            .checked_sub(combined_out as u64)
            .ok_or(AnemoneError::MathOverflow)?;
    }
    if actual_delta < 0 {
        market.lp_nav = market.lp_nav
            .checked_add((-actual_delta) as u64)
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

    msg!(
        "Liquidated: fee={} to liquidator={}, remainder={} to owner={}",
        fee, ctx.accounts.liquidator.key(), remainder, ctx.accounts.owner.key()
    );

    Ok(())
}
