use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    Mint, TokenAccount, TokenInterface,
    transfer_checked, TransferChecked,
};
use crate::state::{SwapMarket, SwapPosition, PositionStatus};
use crate::helpers::{calculate_period_pnl, calculate_maintenance_margin};
use crate::errors::AnemoneError;

#[derive(Accounts)]
pub struct SettlePeriod<'info> {
    #[account(
        mut,
        seeds = [b"market", market.underlying_reserve.as_ref(), &market.tenor_seconds.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, SwapMarket>>,

    #[account(
        mut,
        seeds = [b"swap", swap_position.owner.as_ref(), market.key().as_ref(), &[swap_position.nonce]],
        bump = swap_position.bump,
        constraint = swap_position.market == market.key() @ AnemoneError::InvalidVault,
    )]
    pub swap_position: Account<'info, SwapPosition>,

    /// LP vault — pays trader profits / receives trader losses
    #[account(
        mut,
        address = market.lp_vault @ AnemoneError::InvalidVault,
    )]
    pub lp_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Collateral vault — holds trader margin
    #[account(
        mut,
        address = market.collateral_vault @ AnemoneError::InvalidVault,
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The underlying token mint (e.g. USDC) — needed for transfer_checked
    #[account(
        address = market.underlying_mint @ AnemoneError::InvalidMint,
    )]
    pub underlying_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Anyone can call settlement (permissionless — incentivizes keepers)
    pub caller: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_settle_period(ctx: Context<SettlePeriod>) -> Result<()> {
    let position = &ctx.accounts.swap_position;
    let market = &ctx.accounts.market;
    let now = Clock::get()?.unix_timestamp;

    // 1. Validate position is open
    require!(
        position.status == PositionStatus::Open,
        AnemoneError::PositionNotOpen
    );

    // 2. Validate settlement period has elapsed
    require!(
        now >= position.next_settlement_ts,
        AnemoneError::SettlementNotDue
    );

    // 3. Validate rate index has been updated since last settlement
    require!(
        market.current_rate_index >= position.last_settled_rate_index,
        AnemoneError::InvalidRateIndex
    );

    // 4. Calculate PnL using the REAL elapsed time since the last settlement,
    //    not `market.settlement_period_seconds`. Passing the nominal period
    //    to `calculate_period_pnl` was the C1 bug: a PayFixed trader could
    //    skip the permissionless settle_period calls for hours/days, then
    //    trigger one call. `variable_payment` naturally reflects the full
    //    elapsed growth (rate_index is monotonic and time-embedded), while
    //    `fixed_payment` only charged the nominal period — the difference
    //    came out of the LP vault. Using `elapsed` keeps both legs
    //    symmetric regardless of call timing.
    let elapsed = now
        .checked_sub(position.last_settlement_ts)
        .ok_or(AnemoneError::MathOverflow)?;
    require!(elapsed > 0, AnemoneError::InvalidElapsedTime);

    let pnl = calculate_period_pnl(
        position.direction,
        position.notional,
        position.fixed_rate_bps,
        position.last_settled_rate_index,
        market.current_rate_index,
        elapsed,
    )?;

    // 5. Transfer tokens between vaults based on PnL
    // Market PDA signs as authority for both vaults
    let reserve_key = market.underlying_reserve;
    let tenor_bytes = market.tenor_seconds.to_le_bytes();
    let bump = market.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"market",
        reserve_key.as_ref(),
        &tenor_bytes,
        &[bump],
    ]];

    // H1 phase 1 — catchup on any existing unpaid_pnl. The trader's prior
    // credit against the LP vault is paid first (before new PnL) so the
    // oldest debt gets settled whenever the vault has room. Caps by current
    // vault balance — if still short, unpaid stays on the position.
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

    // Remaining lp_vault balance after catchup drained part of it.
    let vault_after_catchup = ctx.accounts.lp_vault.amount.saturating_sub(catchup_amount);

    // H1 phase 2 — execute the new PnL transfer. Tracks `shortfall`: the
    // portion of `pnl > 0` that the vault could not cover, which becomes
    // new unpaid_pnl. `actual_delta` is what *physically* moved to the
    // trader's collateral side (post-catchup, post-PnL).
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

        let shortfall = (pnl as u64).saturating_sub(transfer_amount);
        (transfer_amount as i64, shortfall)
    } else if pnl < 0 {
        // Trader loses — capped by collateral_remaining (trader can never
        // lose more than they have). No unpaid_pnl accrues on this side;
        // the protocol-LP relationship is asymmetric by design.
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

    // Capture immutable reads before taking any &mut borrow on market.
    let current_rate_index = market.current_rate_index;
    let settlement_period_seconds = market.settlement_period_seconds;
    let tenor_seconds = market.tenor_seconds;

    // 6. Update lp_nav to mirror the USDC that physically moved between vaults.
    //    `catchup_amount` is lp_vault → collateral (LP paying old debt),
    //    `actual_delta` is this period's PnL transfer. Combined they are the
    //    net change in lp_vault → lp_nav moves by -(catchup + actual_delta).
    //    Shortfall accrues to unpaid_pnl but does NOT touch lp_nav — lp_nav
    //    tracks "vault+kamino" state, and the trader credit is a separate
    //    liability tracked on the position (summed by the keeper refill job).
    let combined_out: i64 = (catchup_amount as i64)
        .checked_add(actual_delta.max(0))
        .ok_or(AnemoneError::MathOverflow)?;
    let combined_in: i64 = if actual_delta < 0 { -actual_delta } else { 0 };

    let market_mut = &mut ctx.accounts.market;
    if combined_out > 0 {
        market_mut.lp_nav = market_mut.lp_nav
            .checked_sub(combined_out as u64)
            .ok_or(AnemoneError::MathOverflow)?;
    }
    if combined_in > 0 {
        market_mut.lp_nav = market_mut.lp_nav
            .checked_add(combined_in as u64)
            .ok_or(AnemoneError::MathOverflow)?;
    }

    // 7. Update position state. Catchup raises collateral (trader got paid
    //    old debt); unpaid_pnl drops by the same amount. New PnL transfer
    //    then adjusts collateral by actual_delta, and shortfall accrues to
    //    unpaid_pnl for the next catchup window.
    let position = &mut ctx.accounts.swap_position;

    // Apply catchup
    if catchup_amount > 0 {
        position.collateral_remaining = position.collateral_remaining
            .checked_add(catchup_amount)
            .ok_or(AnemoneError::MathOverflow)?;
        position.unpaid_pnl = position.unpaid_pnl
            .checked_sub(catchup_amount as i64)
            .ok_or(AnemoneError::MathOverflow)?;
    }

    // Apply this period's PnL
    if actual_delta > 0 {
        position.collateral_remaining = position.collateral_remaining
            .checked_add(actual_delta as u64)
            .ok_or(AnemoneError::MathOverflow)?;
    } else if actual_delta < 0 {
        position.collateral_remaining = position.collateral_remaining
            .checked_sub((-actual_delta) as u64)
            .ok_or(AnemoneError::MathOverflow)?;
    }

    // Accrue shortfall (pnl > actual transferred) as new unpaid_pnl.
    if shortfall > 0 {
        position.unpaid_pnl = position.unpaid_pnl
            .checked_add(shortfall as i64)
            .ok_or(AnemoneError::MathOverflow)?;
    }

    position.last_settled_rate_index = current_rate_index;
    // realized_pnl tracks what was actually paid/received, not the theoretical PnL
    position.realized_pnl = position.realized_pnl
        .checked_add(actual_delta)
        .ok_or(AnemoneError::MathOverflow)?;
    position.num_settlements = position.num_settlements
        .checked_add(1)
        .ok_or(AnemoneError::MathOverflow)?;
    position.last_settlement_ts = now;
    position.next_settlement_ts = now
        .checked_add(settlement_period_seconds)
        .ok_or(AnemoneError::MathOverflow)?;

    // 7. Check maturity
    if now >= position.maturity_timestamp {
        position.status = PositionStatus::Matured;
        msg!("Position matured — collateral_remaining: {}", position.collateral_remaining);
    }

    // 8. Check maintenance margin (warning only — liquidation in Day 13-14)
    let maintenance = calculate_maintenance_margin(position.notional, tenor_seconds)?;
    if position.collateral_remaining < maintenance && position.status == PositionStatus::Open {
        msg!(
            "WARNING: Below maintenance margin! remaining={} < maintenance={}",
            position.collateral_remaining, maintenance
        );
    }

    msg!(
        "Settlement #{}: pnl={} actual={} collateral_remaining={}",
        position.num_settlements, pnl, actual_delta, position.collateral_remaining
    );

    Ok(())
}
