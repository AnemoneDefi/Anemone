use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    Mint, TokenAccount, TokenInterface,
    burn, transfer_checked, Burn, TransferChecked,
};
use crate::state::{SwapMarket, LpPosition, LpStatus, ProtocolState, MAX_NAV_STALENESS_SECS};
use crate::helpers::cpi_withdraw_from_kamino;
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
    let gross_amount = (shares_to_burn as u128)
        .checked_mul(market.lp_nav as u128)
        .and_then(|v| v.checked_div(market.total_lp_shares as u128))
        .ok_or(AnemoneError::MathOverflow)? as u64;

    // Collateralization check — once the USDC leaves the pool it can no
    // longer back open positions, so the remaining lp_nav must still cover
    // the worst-side notional after this exit.
    let total_notional = market.total_fixed_notional
        .max(market.total_variable_notional);
    let remaining_deposits = market.lp_nav
        .checked_sub(gross_amount)
        .ok_or(AnemoneError::MathOverflow)?;
    let max_notional_after = (remaining_deposits as u128)
        .checked_mul(market.max_utilization_bps as u128)
        .and_then(|v| v.checked_div(10_000))
        .ok_or(AnemoneError::MathOverflow)? as u64;
    require!(total_notional <= max_notional_after, AnemoneError::PoolUndercollateralized);

    // Burn shares first — prevents the LP from transferring the LP tokens
    // elsewhere mid-tx and double-spending the withdrawal.
    burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.lp_mint.to_account_info(),
                from: ctx.accounts.withdrawer_lp_token_account.to_account_info(),
                authority: ctx.accounts.withdrawer.to_account_info(),
            },
        ),
        shares_to_burn,
    )?;

    // PDA signer seeds (used both by the optional Kamino redeem and by the
    // transfers below).
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
    // request/claim flow (Finding 5b). Under the JIT model, lp_vault is
    // usually 0 and the LP can't get their funds without first asking
    // someone to refill it. Redeeming inline removes that dependency: the
    // LP signs one ix, the program redeems just enough k-USDC to cover the
    // gross amount, and the LP gets paid in the same tx.
    let mut kamino_redeemed_usdc: u64 = 0;
    if gross_amount > ctx.accounts.lp_vault.amount {
        let shortfall_k = gross_amount.saturating_sub(ctx.accounts.lp_vault.amount);
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

    let fee = (gross_amount as u128)
        .checked_mul(ctx.accounts.protocol_state.withdrawal_fee_bps as u128)
        .and_then(|v| v.checked_div(10_000))
        .ok_or(AnemoneError::MathOverflow)? as u64;
    let net_amount = gross_amount.checked_sub(fee).ok_or(AnemoneError::MathOverflow)?;

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
        .checked_sub(gross_amount)
        .ok_or(AnemoneError::MathOverflow)?;
    market.total_lp_shares = market.total_lp_shares
        .checked_sub(shares_to_burn)
        .ok_or(AnemoneError::MathOverflow)?;

    let lp_position = &mut ctx.accounts.lp_position;
    lp_position.shares = lp_position.shares
        .checked_sub(shares_to_burn)
        .ok_or(AnemoneError::MathOverflow)?;
    if lp_position.shares == 0 {
        lp_position.status = LpStatus::Withdrawn;
    }

    emit!(LpWithdrawal {
        market: market.key(),
        withdrawer: ctx.accounts.withdrawer.key(),
        shares_burned: shares_to_burn,
        gross_amount,
        net_amount,
        fee,
        kamino_redeemed_usdc,
        timestamp: now,
    });

    msg!(
        "Withdrawal: {} shares -> {} USDC (fee: {}, kamino_redeemed: {})",
        shares_to_burn, net_amount, fee, kamino_redeemed_usdc,
    );

    Ok(())
}
