use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    Mint, TokenAccount, TokenInterface,
    transfer_checked, TransferChecked,
};
use crate::state::{SwapMarket, SwapPosition, SwapDirection, PositionStatus, ProtocolState};
use crate::helpers::{calculate_spread_bps, calculate_initial_margin, calculate_current_apy_from_index};
use crate::errors::AnemoneError;

/// Maximum age of `market.last_rate_update_ts` that `open_swap` will price
/// a swap against. A stale rate index means the quote is still being offered
/// against yesterday's APY — an obvious MEV/arbitrage lane, especially right
/// after a lending rate spike (e.g. April 2026 Kamino contagion: 4%→12% in
/// hours). If this trips, the keeper missed too many `update_rate_index`
/// ticks — fix the keeper, don't weaken the guard.
///
/// Set to 10 min so we tolerate 2–3 missed keeper ticks (keeper cadence is
/// every 3 min per the README). Raising this weakens the MEV protection;
/// lowering it risks DoSing `open_swap` when Solana fee markets are hot.
pub const MAX_QUOTE_STALENESS_SECS: i64 = 600;

/// Minimum swap notional in underlying base units. With 6-decimal USDC this
/// is $10. Each open position consumes per-settle keeper CU/RPC roughly
/// independent of size, so positions below this threshold burn keeper
/// resources for negligible fee revenue and can be used to grief settlement.
/// See SECURITY.md Finding 9.
pub const MIN_NOTIONAL: u64 = 10_000_000;

#[derive(Accounts)]
#[instruction(direction: SwapDirection, notional: u64, nonce: u8, max_rate_bps: u64, min_rate_bps: u64)]
pub struct OpenSwap<'info> {
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
        constraint = market.status == 0 @ AnemoneError::MarketPaused,
    )]
    pub market: Box<Account<'info, SwapMarket>>,

    #[account(
        init,
        payer = trader,
        space = SwapPosition::SIZE,
        seeds = [b"swap", trader.key().as_ref(), market.key().as_ref(), &[nonce]],
        bump,
    )]
    pub swap_position: Account<'info, SwapPosition>,

    /// Collateral vault — holds trader margin deposits
    #[account(
        mut,
        address = market.collateral_vault @ AnemoneError::InvalidVault,
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Treasury — receives opening fee
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

    /// Trader's token account (source of collateral + fee)
    #[account(
        mut,
        token::mint = underlying_mint,
        token::authority = trader,
    )]
    pub trader_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub trader: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handle_open_swap(
    ctx: Context<OpenSwap>,
    direction: SwapDirection,
    notional: u64,
    nonce: u8,
    max_rate_bps: u64,
    min_rate_bps: u64,
) -> Result<()> {
    require!(notional > 0, AnemoneError::InvalidAmount);
    // Finding 9: block dust positions that would grief settlement.
    require!(notional >= MIN_NOTIONAL, AnemoneError::InvalidAmount);

    let market = &ctx.accounts.market;
    let protocol_state = &ctx.accounts.protocol_state;

    require!(!protocol_state.paused, AnemoneError::ProtocolPaused);

    // 1. Validate rate index has been initialized by keeper
    require!(
        market.current_rate_index > 0 && market.previous_rate_index > 0,
        AnemoneError::RateIndexNotInitialized
    );

    // 1b. Reject stale quotes. See MAX_QUOTE_STALENESS_SECS doc for rationale.
    let now = Clock::get()?.unix_timestamp;
    let rate_age = now
        .checked_sub(market.last_rate_update_ts)
        .ok_or(AnemoneError::MathOverflow)?;
    require!(rate_age < MAX_QUOTE_STALENESS_SECS, AnemoneError::StaleOracle);

    // 2. Calculate current APY from the two rate index snapshots
    let elapsed = market.last_rate_update_ts
        .checked_sub(market.previous_rate_update_ts)
        .ok_or(AnemoneError::MathOverflow)?;

    // Layer 3 of the rate-index-collapse defense (see SECURITY.md Finding 2).
    // If `elapsed <= 0` or `current == previous`, the keeper's two snapshots
    // collapsed and we cannot derive a real APY. Layers 1 and 2 in
    // update_rate_index prevent this from happening, but we keep the third
    // layer here as a hard reject so any future regression surfaces as a
    // clear `RateIndexNotInitialized` instead of silently quoting PayFixed
    // at `fixed_rate = 0 + spread`. Belt and suspenders.
    require!(
        elapsed > 0 && market.current_rate_index > market.previous_rate_index,
        AnemoneError::RateIndexNotInitialized,
    );

    let current_apy_bps = calculate_current_apy_from_index(
        market.previous_rate_index,
        market.current_rate_index,
        elapsed,
    )?;

    // 3. Calculate spread (including the new swap's impact on utilization/imbalance)
    let (fixed_with_new, variable_with_new) = match direction {
        SwapDirection::PayFixed => (
            market.total_fixed_notional.checked_add(notional).ok_or(AnemoneError::MathOverflow)?,
            market.total_variable_notional,
        ),
        SwapDirection::ReceiveFixed => (
            market.total_fixed_notional,
            market.total_variable_notional.checked_add(notional).ok_or(AnemoneError::MathOverflow)?,
        ),
    };

    let spread_bps = calculate_spread_bps(
        market.base_spread_bps,
        market.max_utilization_bps,
        market.lp_nav,
        fixed_with_new,
        variable_with_new,
    )?;

    // 4. Calculate offered fixed rate
    let fixed_rate_bps = match direction {
        SwapDirection::PayFixed => {
            current_apy_bps.checked_add(spread_bps)
                .ok_or(AnemoneError::MathOverflow)?
        }
        SwapDirection::ReceiveFixed => {
            require!(current_apy_bps > spread_bps, AnemoneError::InvalidAmount);
            current_apy_bps.checked_sub(spread_bps)
                .ok_or(AnemoneError::MathOverflow)?
        }
    };

    // 4b. Slippage protection (MEV defense)
    // PayFixed: trader pays the fixed rate → wants it capped from above (max_rate_bps)
    // ReceiveFixed: trader receives the fixed rate → wants it floored (min_rate_bps)
    match direction {
        SwapDirection::PayFixed => {
            require!(fixed_rate_bps <= max_rate_bps, AnemoneError::SlippageExceeded);
        }
        SwapDirection::ReceiveFixed => {
            require!(fixed_rate_bps >= min_rate_bps, AnemoneError::SlippageExceeded);
        }
    }

    // 5. Calculate initial margin
    let margin = calculate_initial_margin(notional, market.tenor_seconds)?;

    // 6. Calculate opening fee (0.05% of notional)
    let fee = (notional as u128)
        .checked_mul(protocol_state.opening_fee_bps as u128)
        .and_then(|v| v.checked_div(10_000))
        .ok_or(AnemoneError::MathOverflow)? as u64;

    // 7. Validate utilization after this new position
    let new_total_notional = (market.total_fixed_notional as u128)
        .checked_add(market.total_variable_notional as u128)
        .and_then(|v| v.checked_add(notional as u128))
        .ok_or(AnemoneError::MathOverflow)?;

    let utilization_bps = new_total_notional
        .checked_mul(10_000)
        .and_then(|v| v.checked_div(market.lp_nav as u128))
        .ok_or(AnemoneError::MathOverflow)?;

    require!(
        utilization_bps <= market.max_utilization_bps as u128,
        AnemoneError::UtilizationExceeded
    );

    // 8. Validate trader has enough funds
    let total_required = margin.checked_add(fee).ok_or(AnemoneError::MathOverflow)?;
    require!(
        ctx.accounts.trader_token_account.amount >= total_required,
        AnemoneError::InsufficientCollateral
    );

    // 9. Transfer opening fee: trader → treasury
    if fee > 0 {
        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.trader_token_account.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                    authority: ctx.accounts.trader.to_account_info(),
                    mint: ctx.accounts.underlying_mint.to_account_info(),
                },
            ),
            fee,
            ctx.accounts.underlying_mint.decimals,
        )?;
    }

    // 10. Transfer margin: trader → collateral_vault
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.trader_token_account.to_account_info(),
                to: ctx.accounts.collateral_vault.to_account_info(),
                authority: ctx.accounts.trader.to_account_info(),
                mint: ctx.accounts.underlying_mint.to_account_info(),
            },
        ),
        margin,
        ctx.accounts.underlying_mint.decimals,
    )?;

    // 11. Initialize SwapPosition (reuse `now` captured at staleness check)
    let position = &mut ctx.accounts.swap_position;
    position.owner = ctx.accounts.trader.key();
    position.market = ctx.accounts.market.key();
    position.direction = direction;
    position.notional = notional;
    position.fixed_rate_bps = fixed_rate_bps;
    position.spread_bps_at_open = spread_bps;
    position.collateral_deposited = margin;
    position.collateral_remaining = margin;
    position.entry_rate_index = market.current_rate_index;
    position.last_settled_rate_index = market.current_rate_index;
    position.realized_pnl = 0;
    position.num_settlements = 0;
    position.open_timestamp = now;
    position.maturity_timestamp = now + market.tenor_seconds;
    position.next_settlement_ts = now + market.settlement_period_seconds;
    position.last_settlement_ts = now;
    position.status = PositionStatus::Open;
    position.nonce = nonce;
    position.bump = ctx.bumps.swap_position;

    // 12. Update market totals
    let market = &mut ctx.accounts.market;
    match direction {
        SwapDirection::PayFixed => {
            market.total_fixed_notional = market.total_fixed_notional
                .checked_add(notional)
                .ok_or(AnemoneError::MathOverflow)?;
        }
        SwapDirection::ReceiveFixed => {
            market.total_variable_notional = market.total_variable_notional
                .checked_add(notional)
                .ok_or(AnemoneError::MathOverflow)?;
        }
    }
    market.total_open_positions = market.total_open_positions
        .checked_add(1)
        .ok_or(AnemoneError::MathOverflow)?;

    msg!(
        "Swap opened: {:?} notional={} fixed_rate={}bps margin={} fee={}",
        direction, notional, fixed_rate_bps, margin, fee
    );

    Ok(())
}
