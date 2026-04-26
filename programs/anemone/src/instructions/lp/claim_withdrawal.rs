use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    Mint, TokenAccount, TokenInterface,
    transfer_checked, TransferChecked,
};
use crate::state::{SwapMarket, LpPosition, LpStatus, ProtocolState, MAX_NAV_STALENESS_SECS};
use crate::helpers::cpi_withdraw_from_kamino;
use crate::errors::AnemoneError;

#[derive(Accounts)]
pub struct ClaimWithdrawal<'info> {
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
        constraint = lp_position.status == LpStatus::PendingWithdrawal @ AnemoneError::NoPendingWithdrawal,
    )]
    pub lp_position: Box<Account<'info, LpPosition>>,

    #[account(
        mut,
        address = market.lp_vault @ AnemoneError::InvalidVault,
    )]
    pub lp_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        address = market.underlying_mint @ AnemoneError::InvalidMint,
    )]
    pub underlying_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        token::mint = underlying_mint,
        token::authority = withdrawer,
    )]
    pub withdrawer_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

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
    // claim_withdrawal pays the LP their gross_amount from lp_vault. If
    // lp_vault is short (the keeper hasn't refilled, or 100% of capital sits
    // in Kamino under the JIT model), the program redeems the difference from
    // Kamino in the same tx. Without this, the LP would have to bundle a
    // separate withdraw_from_kamino preInstruction (or wait for the keeper),
    // re-introducing the grief vector PR #25 opened. See claim_matured.rs for
    // the full design rationale; this is the LP-side mirror.

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

pub fn handle_claim_withdrawal(ctx: Context<ClaimWithdrawal>) -> Result<()> {
    // C2: NAV staleness gate. gross_amount was locked at request time so the
    // payout is already fixed, but pending_withdrawals reservation still
    // tracks lp_nav — keeping the gate consistent across all LP handlers
    // avoids surprises and exercises the same bundle-sync pattern.
    let now = Clock::get()?.unix_timestamp;
    let nav_age = now
        .checked_sub(ctx.accounts.market.last_kamino_sync_ts)
        .ok_or(AnemoneError::MathOverflow)?;
    require!(nav_age < MAX_NAV_STALENESS_SECS, AnemoneError::StaleNav);

    let gross_amount = ctx.accounts.lp_position.withdrawal_amount;
    require!(gross_amount > 0, AnemoneError::NoPendingWithdrawal);

    // PDA signer seeds (also needed by the Kamino redeem CPI below).
    let reserve_key = ctx.accounts.market.underlying_reserve;
    let tenor_bytes = ctx.accounts.market.tenor_seconds.to_le_bytes();
    let bump = ctx.accounts.market.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"market",
        reserve_key.as_ref(),
        &tenor_bytes,
        &[bump],
    ]];

    // Internal Kamino redeem on shortfall — replaces the old
    // `require!(lp_vault.amount >= gross_amount, InsufficientVaultLiquidity)`
    // gate. Under the JIT model, lp_vault is usually 0 and the LP can't get
    // their funds without first asking someone to refill it. Redeeming
    // inline removes that dependency: the LP signs one ix, the program
    // redeems just enough k-USDC to cover the gross amount, and the LP gets
    // paid in the same tx.
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

    // Fee is computed with the current bps; shares were already burned at
    // request time and the gross amount is locked in the LpPosition.
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

    // Mirror any internal Kamino redeem from above into market state so
    // subsequent reads see the post-CPI balance (read before the &mut borrow
    // takes over the market account). When the CPI fired, decrement
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
    market.pending_withdrawals = market.pending_withdrawals
        .checked_sub(gross_amount)
        .ok_or(AnemoneError::MathOverflow)?;

    let lp_position = &mut ctx.accounts.lp_position;
    lp_position.withdrawal_amount = 0;
    lp_position.withdrawal_requested_at = 0;
    lp_position.status = if lp_position.shares == 0 {
        LpStatus::Withdrawn
    } else {
        LpStatus::Active
    };

    msg!(
        "Withdrawal claimed: {} USDC (fee: {}, pending_withdrawals now {})",
        net_amount,
        fee,
        market.pending_withdrawals,
    );

    Ok(())
}
