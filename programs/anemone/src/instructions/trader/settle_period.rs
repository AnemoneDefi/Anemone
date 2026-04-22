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

    // Track the actual amount moved between vaults — used to update collateral_remaining
    // This ensures accounting matches the real vault balance (bug fix: H1)
    let actual_delta: i64 = if pnl > 0 {
        // Trader profits — transfer from lp_vault to collateral_vault
        // Capped by lp_vault balance (LP cannot pay more than it has)
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
        // Trader loses — transfer from collateral_vault to lp_vault
        // Capped by collateral_remaining (trader cannot lose more than they have)
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

    // Capture immutable reads before taking any &mut borrow on market.
    let current_rate_index = market.current_rate_index;
    let settlement_period_seconds = market.settlement_period_seconds;
    let tenor_seconds = market.tenor_seconds;

    // 6. Update lp_nav to mirror the USDC that physically moved between vaults.
    //    When trader profits (actual_delta > 0), USDC left the lp_vault → lp_nav
    //    shrinks. When trader loses, USDC came into the lp_vault → lp_nav grows.
    //    Keeping lp_nav in sync here is what makes share price reflect
    //    realized PnL (C2).
    let market_mut = &mut ctx.accounts.market;
    if actual_delta > 0 {
        market_mut.lp_nav = market_mut.lp_nav
            .checked_sub(actual_delta as u64)
            .ok_or(AnemoneError::MathOverflow)?;
    } else if actual_delta < 0 {
        market_mut.lp_nav = market_mut.lp_nav
            .checked_add((-actual_delta) as u64)
            .ok_or(AnemoneError::MathOverflow)?;
    }

    // 7. Update position state using the actual transferred amount
    let position = &mut ctx.accounts.swap_position;

    if actual_delta > 0 {
        position.collateral_remaining = position.collateral_remaining
            .checked_add(actual_delta as u64)
            .ok_or(AnemoneError::MathOverflow)?;
    } else if actual_delta < 0 {
        position.collateral_remaining = position.collateral_remaining
            .checked_sub((-actual_delta) as u64)
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
