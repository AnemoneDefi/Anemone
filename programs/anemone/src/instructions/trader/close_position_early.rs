use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    Mint, TokenAccount, TokenInterface,
    transfer_checked, TransferChecked,
};
use crate::state::{SwapMarket, SwapPosition, SwapDirection, PositionStatus, ProtocolState};
use crate::helpers::calculate_period_pnl;
use crate::errors::AnemoneError;

#[derive(Accounts)]
pub struct ClosePositionEarly<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_state.bump,
        has_one = treasury @ AnemoneError::InvalidVault,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

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
        constraint = swap_position.status == PositionStatus::Open @ AnemoneError::PositionNotOpen,
    )]
    pub swap_position: Account<'info, SwapPosition>,

    /// LP vault — source/dest for mark-to-market PnL settlement
    #[account(
        mut,
        address = market.lp_vault @ AnemoneError::InvalidVault,
    )]
    pub lp_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Collateral vault — holds the trader margin
    #[account(
        mut,
        address = market.collateral_vault @ AnemoneError::InvalidVault,
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Treasury — receives the 5% early close fee
    #[account(
        mut,
        token::mint = underlying_mint,
        address = protocol_state.treasury @ AnemoneError::InvalidVault,
    )]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The underlying token mint (e.g. USDC)
    #[account(
        address = market.underlying_mint @ AnemoneError::InvalidMint,
    )]
    pub underlying_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Owner's token account — receives remainder after fee
    #[account(
        mut,
        token::mint = underlying_mint,
        token::authority = owner,
    )]
    pub owner_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handle_close_position_early(ctx: Context<ClosePositionEarly>) -> Result<()> {
    let position = &ctx.accounts.swap_position;
    let market = &ctx.accounts.market;
    let protocol_state = &ctx.accounts.protocol_state;
    let now = Clock::get()?.unix_timestamp;

    let direction = position.direction;
    let notional = position.notional;

    // Build PDA signer seeds once (market PDA signs all vault transfers)
    let reserve_key = market.underlying_reserve;
    let tenor_bytes = market.tenor_seconds.to_le_bytes();
    let bump = market.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"market",
        reserve_key.as_ref(),
        &tenor_bytes,
        &[bump],
    ]];

    // 1. Mark-to-market PnL using real elapsed time since last settlement.
    //    If elapsed <= 0 or indices match, PnL is 0 (no partial period to settle).
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

    // 2a. H1 catchup on existing unpaid_pnl before booking new MtM. Closing
    //     is a final action — if we can't settle the old debt AND the new
    //     PnL, we refuse (require at the end). Catchup first so the debt
    //     has priority on the remaining lp_vault.
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

    // 2b. Transfer mark-to-market PnL with shortfall tracking (same pattern
    //     as settle_period). Shortfall from `pnl > 0` + vault short becomes
    //     new unpaid_pnl — but we reject the close at the end if anything
    //     remains unpaid.
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

    // 2c. Close must not leave a debt: require that all unpaid_pnl (prior +
    //     new shortfall) has been cleared. If it hasn't, abort — the tx
    //     reverts, catchup/MtM transfers included. Trader waits for keeper
    //     to refill lp_vault and retries.
    let unpaid_after: i64 = position.unpaid_pnl
        .checked_sub(catchup_amount as i64)
        .ok_or(AnemoneError::MathOverflow)?
        .checked_add(shortfall as i64)
        .ok_or(AnemoneError::MathOverflow)?;
    require!(unpaid_after == 0, AnemoneError::UnpaidPnlOutstanding);

    // 3. Apply (catchup + actual_delta) to the in-memory collateral value.
    let collateral_after_catchup: u64 = position.collateral_remaining
        .checked_add(catchup_amount)
        .ok_or(AnemoneError::MathOverflow)?;

    let collateral_after_mtm: u64 = if actual_delta >= 0 {
        collateral_after_catchup
            .checked_add(actual_delta as u64)
            .ok_or(AnemoneError::MathOverflow)?
    } else {
        collateral_after_catchup
            .checked_sub((-actual_delta) as u64)
            .ok_or(AnemoneError::MathOverflow)?
    };

    // 4. Compute early close fee (5% of the adjusted collateral)
    let fee = (collateral_after_mtm as u128)
        .checked_mul(protocol_state.early_close_fee_bps as u128)
        .and_then(|v| v.checked_div(10_000))
        .ok_or(AnemoneError::MathOverflow)? as u64;

    let remainder = collateral_after_mtm
        .checked_sub(fee)
        .ok_or(AnemoneError::MathOverflow)?;

    // 5. Transfer fee → treasury
    if fee > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.collateral_vault.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                    mint: ctx.accounts.underlying_mint.to_account_info(),
                },
                signer_seeds,
            ),
            fee,
            ctx.accounts.underlying_mint.decimals,
        )?;
    }

    // 6. Transfer remainder → owner_token_account
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

    // 7. Update market totals + lp_nav to mirror the MtM + catchup transfers
    //    (C2 + H1). Total out of lp_vault = catchup + positive actual_delta.
    let market = &mut ctx.accounts.market;
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
        "Early close: pnl={} fee={} remainder={} to owner={}",
        pnl, fee, remainder, ctx.accounts.owner.key()
    );

    Ok(())
}
