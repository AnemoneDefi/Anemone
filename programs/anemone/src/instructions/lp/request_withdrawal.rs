use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    Mint, TokenAccount, TokenInterface,
    burn, transfer_checked, Burn, TransferChecked,
};
use kamino_lend::state::Reserve;
use crate::state::{SwapMarket, LpPosition, LpStatus, ProtocolState, MAX_NAV_STALENESS_SECS};
use crate::helpers::{cpi_withdraw_from_kamino, read_kamino_liquidity_to_collateral};
use crate::errors::AnemoneError;

/// Audit-trail event for every LP withdrawal. Indexers subscribe to this
/// via Anchor's event listener (or parse program logs by tx) to build the
/// historical record. Replaces the on-chain `withdrawal_requested_at` /
/// `withdrawal_amount` fields that the queued path used to keep — events
/// give a richer log per withdrawal at zero on-chain cost.
#[event]
pub struct LpWithdrawal {
    pub market: Pubkey,
    pub withdrawer: Pubkey,
    pub shares_burned: u64,
    pub gross_amount: u64,
    pub net_amount: u64,
    pub fee: u64,
    pub kamino_redeemed_usdc: u64,
    pub timestamp: i64,
}

#[derive(Accounts)]
pub struct RequestWithdrawal<'info> {
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
        seeds = [b"lp", withdrawer.key().as_ref(), market.key().as_ref()],
        bump = lp_position.bump,
        constraint = lp_position.owner == withdrawer.key() @ AnemoneError::InsufficientShares,
        constraint = lp_position.status == LpStatus::Active @ AnemoneError::InsufficientShares,
    )]
    pub lp_position: Box<Account<'info, LpPosition>>,

    /// LP vault that holds USDC
    #[account(
        mut,
        address = market.lp_vault @ AnemoneError::InvalidVault,
    )]
    pub lp_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// LP token mint — program burns shares
    #[account(
        mut,
        address = market.lp_mint @ AnemoneError::InvalidMint,
    )]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>,

    /// The underlying token mint (e.g. USDC)
    #[account(
        address = market.underlying_mint @ AnemoneError::InvalidMint,
    )]
    pub underlying_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Withdrawer's LP token account (source — burns from here)
    #[account(
        mut,
        token::mint = lp_mint,
        token::authority = withdrawer,
    )]
    pub withdrawer_lp_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Withdrawer's USDC token account (destination)
    #[account(
        mut,
        token::mint = underlying_mint,
        token::authority = withdrawer,
    )]
    pub withdrawer_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Treasury token account — receives withdrawal fee, must match protocol
    #[account(
        mut,
        token::mint = underlying_mint,
        address = protocol_state.treasury @ AnemoneError::InvalidVault,
    )]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub withdrawer: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,

    // ----- Kamino accounts for internal redeem-on-shortfall -----
    //
    // If lp_vault has less than gross_amount, the program redeems the
    // shortfall from Kamino in the same tx. This was previously the
    // claim_withdrawal ix's job (queued path); after Finding 5b, the queue
    // is gone and request_withdrawal is single-shot — accounts must be
    // present on every call. Anchor validates them at deserialization;
    // when the vault has enough cash, the CPI does not fire.

    #[account(
        mut,
        address = market.kamino_deposit_account @ AnemoneError::InvalidVault,
    )]
    pub kamino_deposit_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Kamino reserve — must match `market.underlying_reserve`. Typed as
    /// AccountLoader so we can read the live exchange rate fields needed to
    /// convert the requested USDC shortfall into a k-USDC collateral amount
    /// before invoking `redeem_reserve_collateral`. The CPI also writes back
    /// to the reserve, hence `mut`.
    #[account(
        mut,
        constraint = kamino_reserve.key() == market.underlying_reserve
            @ AnemoneError::InvalidReserve,
    )]
    pub kamino_reserve: AccountLoader<'info, Reserve>,

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

pub fn handle_request_withdrawal(
    ctx: Context<RequestWithdrawal>,
    shares_to_burn: u64,
) -> Result<()> {
    require!(shares_to_burn > 0, AnemoneError::InvalidAmount);

    // C2: NAV staleness gate. See deposit_liquidity for rationale.
    let now = Clock::get()?.unix_timestamp;
    let nav_age = now
        .checked_sub(ctx.accounts.market.last_kamino_sync_ts)
        .ok_or(AnemoneError::MathOverflow)?;
    require!(nav_age < MAX_NAV_STALENESS_SECS, AnemoneError::StaleNav);

    require!(
        ctx.accounts.lp_position.shares >= shares_to_burn,
        AnemoneError::InsufficientShares,
    );

    let market = &ctx.accounts.market;
    let requested_gross = (shares_to_burn as u128)
        .checked_mul(market.lp_nav as u128)
        .and_then(|v| v.checked_div(market.total_lp_shares as u128))
        .ok_or(AnemoneError::MathOverflow)? as u64;

    // Collateralization check on the REQUESTED gross — denying the request
    // outright if it would undercollateralise the pool is fine even if the
    // actual paid amount turns out smaller (the proportional adjustment
    // below only ever reduces the impact, never increases it).
    let total_notional = market.total_fixed_notional
        .max(market.total_variable_notional);
    let remaining_deposits = market.lp_nav
        .checked_sub(requested_gross)
        .ok_or(AnemoneError::MathOverflow)?;
    let max_notional_after = (remaining_deposits as u128)
        .checked_mul(market.max_utilization_bps as u128)
        .and_then(|v| v.checked_div(10_000))
        .ok_or(AnemoneError::MathOverflow)? as u64;
    require!(total_notional <= max_notional_after, AnemoneError::PoolUndercollateralized);

    // PDA signer seeds (used by the Kamino redeem CPI and the transfers).
    let reserve_key = ctx.accounts.market.underlying_reserve;
    let tenor_bytes = ctx.accounts.market.tenor_seconds.to_le_bytes();
    let bump = ctx.accounts.market.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"market",
        reserve_key.as_ref(),
        &tenor_bytes,
        &[bump],
    ]];

    // Internal Kamino redeem on shortfall — replaces the old queued
    // request/claim flow (Finding 5b). Under the JIT model lp_vault is
    // usually drained, so a withdrawal must redeem from Kamino in-line.
    //
    // Finding 10 fix (cap + proportional burn):
    //   1. Convert the USDC shortfall to a k-USDC collateral amount via the
    //      reserve's current exchange rate — `redeem_reserve_collateral`
    //      takes collateral units, not liquidity units.
    //   2. Cap the redemption at the protocol's actual k-USDC balance — we
    //      can never ask Kamino to burn more than what we hold.
    //   3. If the cap binds, the LP receives less than `requested_gross`;
    //      we burn shares and decrement state proportionally so the unpaid
    //      portion remains backed by the LP's residual shares (they can
    //      withdraw it later once a keeper rebalance refills the pool).
    let mut kamino_redeemed_usdc: u64 = 0;
    if requested_gross > ctx.accounts.lp_vault.amount {
        let shortfall_usdc = requested_gross - ctx.accounts.lp_vault.amount;
        let computed_k = read_kamino_liquidity_to_collateral(
            &ctx.accounts.kamino_reserve,
            shortfall_usdc,
        )?;
        let max_held_k = ctx.accounts.kamino_deposit_account.amount;
        let actual_redeem_k = computed_k.min(max_held_k);

        if actual_redeem_k > 0 {
            let lp_vault_before_cpi = ctx.accounts.lp_vault.amount;
            cpi_withdraw_from_kamino(
                &ctx.accounts.kamino_program,
                &ctx.accounts.market.to_account_info(),
                signer_seeds,
                &ctx.accounts.kamino_reserve.to_account_info(),
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
                actual_redeem_k,
            )?;
            ctx.accounts.lp_vault.reload()?;
            ctx.accounts.kamino_deposit_account.reload()?;
            kamino_redeemed_usdc = ctx.accounts.lp_vault.amount
                .saturating_sub(lp_vault_before_cpi);
        }
    }

    // After the (possibly capped) redeem, the actual gross we can pay is
    // bounded by lp_vault. If less than requested, the LP keeps a residual
    // share position equal to the unpaid portion. See compute_partial_burn
    // for the full rationale.
    let (actual_gross, actual_shares_burned) = compute_partial_burn(
        requested_gross,
        ctx.accounts.lp_vault.amount,
        shares_to_burn,
    )?;
    require!(actual_shares_burned > 0, AnemoneError::InvalidAmount);

    burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.lp_mint.to_account_info(),
                from: ctx.accounts.withdrawer_lp_token_account.to_account_info(),
                authority: ctx.accounts.withdrawer.to_account_info(),
            },
        ),
        actual_shares_burned,
    )?;

    let fee = (actual_gross as u128)
        .checked_mul(ctx.accounts.protocol_state.withdrawal_fee_bps as u128)
        .and_then(|v| v.checked_div(10_000))
        .ok_or(AnemoneError::MathOverflow)? as u64;
    let net_amount = actual_gross.checked_sub(fee).ok_or(AnemoneError::MathOverflow)?;

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.lp_vault.to_account_info(),
                to: ctx.accounts.withdrawer_token_account.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
                mint: ctx.accounts.underlying_mint.to_account_info(),
            },
            signer_seeds,
        ),
        net_amount,
        ctx.accounts.underlying_mint.decimals,
    )?;

    if fee > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.lp_vault.to_account_info(),
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

    // Mirror any internal Kamino redeem into market state. Decrement
    // last_kamino_snapshot_usdc by the delivered USDC so the next
    // sync_kamino_yield computes a clean yield delta.
    let kamino_balance_now = ctx.accounts.kamino_deposit_account.amount;
    let market = &mut ctx.accounts.market;
    market.total_kamino_collateral = kamino_balance_now;
    if kamino_redeemed_usdc > 0 {
        market.last_kamino_snapshot_usdc = market.last_kamino_snapshot_usdc
            .saturating_sub(kamino_redeemed_usdc);
    }
    market.lp_nav = market.lp_nav
        .checked_sub(actual_gross)
        .ok_or(AnemoneError::MathOverflow)?;
    market.total_lp_shares = market.total_lp_shares
        .checked_sub(actual_shares_burned)
        .ok_or(AnemoneError::MathOverflow)?;

    let lp_position = &mut ctx.accounts.lp_position;
    lp_position.shares = lp_position.shares
        .checked_sub(actual_shares_burned)
        .ok_or(AnemoneError::MathOverflow)?;
    if lp_position.shares == 0 {
        lp_position.status = LpStatus::Withdrawn;
    }

    emit!(LpWithdrawal {
        market: market.key(),
        withdrawer: ctx.accounts.withdrawer.key(),
        shares_burned: actual_shares_burned,
        gross_amount: actual_gross,
        net_amount,
        fee,
        kamino_redeemed_usdc,
        timestamp: now,
    });

    msg!(
        "Withdrawal: {} shares -> {} USDC (fee: {}, kamino_redeemed: {}, partial: {})",
        actual_shares_burned, net_amount, fee, kamino_redeemed_usdc,
        actual_gross < requested_gross,
    );

    Ok(())
}

/// Pure helper: post-CPI payment math. Extracted so the cap-binds branch of
/// Finding 13's fix can be exercised in cargo unit tests without setting up
/// a Kamino redeem CPI in Surfpool.
///
/// `requested_gross` is what the LP wants in USDC. `lp_vault_after_cpi` is
/// what's actually available after any internal Kamino redeem (which itself
/// is capped at `kamino_deposit_account.amount`). Returns the pair we use
/// for the actual pay-out and burn:
///   `actual_gross`         — bounded by `min(requested, lp_vault)`,
///   `actual_shares_burned` — `shares_to_burn × actual_gross / requested_gross`.
///
/// Proportional burn means the LP exits at exactly the share price they
/// requested even when the pool can't fully pay them; residual shares stay
/// valued the same and can be redeemed once a keeper rebalance refills the
/// pool. Without this fix (Finding 13) the LP would burn all shares but
/// receive only the partial amount — silently overpaying for under-delivery.
pub fn compute_partial_burn(
    requested_gross: u64,
    lp_vault_after_cpi: u64,
    shares_to_burn: u64,
) -> Result<(u64, u64)> {
    let actual_gross = requested_gross.min(lp_vault_after_cpi);
    let actual_shares_burned: u64 = if actual_gross == requested_gross {
        shares_to_burn
    } else {
        ((shares_to_burn as u128)
            .checked_mul(actual_gross as u128)
            .and_then(|v| v.checked_div(requested_gross as u128))
            .ok_or(AnemoneError::MathOverflow)?) as u64
    };
    Ok((actual_gross, actual_shares_burned))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn happy_path_full_pay() {
        // lp_vault has exactly the requested amount → all shares burned, no cap
        let (gross, burned) = compute_partial_burn(
            1_000_000_000, // requested $1k
            1_000_000_000, // lp_vault has $1k
            500_000_000,   // 500M shares
        ).unwrap();
        assert_eq!(gross, 1_000_000_000);
        assert_eq!(burned, 500_000_000, "all shares burned when fully paid");
    }

    #[test]
    fn lp_vault_excess_does_not_overpay() {
        // lp_vault has more than requested — pay only requested, burn all shares
        let (gross, burned) = compute_partial_burn(
            1_000_000_000,
            5_000_000_000, // 5x more than requested
            500_000_000,
        ).unwrap();
        assert_eq!(gross, 1_000_000_000, "pay only what was requested");
        assert_eq!(burned, 500_000_000, "all shares burned (full request honored)");
    }

    #[test]
    fn cap_binds_at_half_proportional_burn() {
        // Cap binds: lp_vault has only 50% of requested → burn 50% of shares
        let (gross, burned) = compute_partial_burn(
            1_000_000_000, // requested $1k
            500_000_000,   // lp_vault has $500
            500_000_000,   // 500M shares
        ).unwrap();
        assert_eq!(gross, 500_000_000, "actual_gross capped at lp_vault");
        assert_eq!(burned, 250_000_000, "exactly 50% of shares burned (proportional)");
        // Residual: 250M shares left, claim = same share price as before
    }

    #[test]
    fn cap_binds_at_zero_returns_zero_gross_and_zero_burned() {
        // lp_vault completely empty → 0 paid, 0 burned (caller must handle this
        // case with require!(actual_shares_burned > 0)).
        let (gross, burned) = compute_partial_burn(
            1_000_000_000,
            0,
            500_000_000,
        ).unwrap();
        assert_eq!(gross, 0);
        assert_eq!(burned, 0, "caller's require! catches this");
    }

    #[test]
    fn cap_binds_with_rounding_truncates_burn() {
        // Integer division means actual_shares_burned rounds DOWN, so the LP
        // keeps slightly more residual shares than the perfect ratio. This
        // direction is safe — the protocol never burns more shares than the
        // proportional amount.
        let (gross, burned) = compute_partial_burn(
            1_000, // requested 1000 raw
            333,   // lp_vault = 333 raw (~33.3%)
            10,    // 10 shares
        ).unwrap();
        assert_eq!(gross, 333);
        // 10 × 333 / 1000 = 3330/1000 = 3.33 → truncates to 3
        assert_eq!(burned, 3, "rounds down — LP keeps residual benefit");
    }

    #[test]
    fn cap_binds_finding_13_scenario_from_audit() {
        // Reconstructs the doc's PRE_MAINNET_LAUNCH Tarefa 3 scenario:
        //   requested_gross = $1k (1_000_000_000 raw)
        //   lp_vault initially 0, kamino had $200 of liquidity
        //   after capped CPI, lp_vault = $236 (200 × 1.18 exchange rate)
        //   total_shares = 1_000_000_000 (LP holds all shares)
        let (gross, burned) = compute_partial_burn(
            1_000_000_000,
            236_000_000,    // post-CPI lp_vault = $236
            1_000_000_000,  // requested all shares
        ).unwrap();
        assert_eq!(gross, 236_000_000, "actual paid is what we redeemed");
        assert_eq!(burned, 236_000_000, "shares burned proportional to paid");
        // Residual: 1B - 236M = 764M shares, valued at the same share price.
    }

    #[test]
    fn small_partial_does_not_lose_precision() {
        // Edge: very small partial pay relative to requested. Verify u128
        // intermediate prevents underflow.
        let (gross, burned) = compute_partial_burn(
            10_000_000_000_000, // $10M requested
            1,                  // lp_vault has 1 raw
            10_000_000_000,     // 10B shares
        ).unwrap();
        assert_eq!(gross, 1);
        // 10B × 1 / 10_000_000_000_000 = 0.001 → 0
        assert_eq!(burned, 0, "rounds to 0 — caller's require! rejects");
    }

    #[test]
    fn overflow_in_proportional_math_returns_error() {
        // shares_to_burn × actual_gross could overflow u128 with extreme
        // values. The checked_mul guard catches it.
        let result = compute_partial_burn(
            u64::MAX,         // requested = max
            u64::MAX,         // lp_vault = max → triggers actual_gross = requested branch
            u64::MAX,         // shares = max
        );
        // Equal branch — no proportional math, just returns shares_to_burn directly
        assert!(result.is_ok());
        let (gross, burned) = result.unwrap();
        assert_eq!(gross, u64::MAX);
        assert_eq!(burned, u64::MAX);
    }

    #[test]
    fn cap_binds_with_extreme_values_stays_in_u128() {
        // u64 × u64 always fits in u128 — the checked_mul path here is
        // defensive code that cannot fire for this signature, but we keep
        // the guard so a future widening of inputs surfaces overflow loudly.
        let (gross, burned) = compute_partial_burn(
            u64::MAX,
            u64::MAX - 1, // cap binds, triggers proportional branch
            u64::MAX,
        ).unwrap();
        assert_eq!(gross, u64::MAX - 1);
        // burned = MAX × (MAX-1) / MAX ≈ MAX-1 (exact within integer division)
        assert_eq!(burned, u64::MAX - 1);
    }
}
