use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use crate::state::{SwapMarket, ProtocolState};
use crate::errors::AnemoneError;
use crate::helpers::cpi_withdraw_from_kamino;

#[derive(Accounts)]
pub struct WithdrawFromKamino<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// Keeper-only. After PRs #26+#27 added internal Kamino redeem to every
    /// user-facing exit path (claim_matured, close_position_early,
    /// liquidate_position, claim_withdrawal/request_withdrawal), the
    /// trader/LP no longer needs this ix as a self-rescue lane. Leaving it
    /// permissionless would let an attacker spam-call to keep funds parked
    /// in lp_vault instead of earning Kamino yield (SECURITY.md Finding 3).
    /// Keeper-gated mirrors the existing constraint on deposit_to_kamino.
    #[account(
        constraint = keeper.key() == protocol_state.keeper_authority
            @ AnemoneError::InvalidAuthority,
    )]
    pub keeper: Signer<'info>,

    #[account(
        mut,
        seeds = [b"market", market.underlying_reserve.as_ref(), &market.tenor_seconds.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, SwapMarket>,

    /// Our LP vault — receives USDC back from Kamino
    #[account(
        mut,
        address = market.lp_vault @ AnemoneError::InvalidVault,
    )]
    pub lp_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Our kamino deposit account — source of k-tokens to redeem
    #[account(
        mut,
        address = market.kamino_deposit_account @ AnemoneError::InvalidVault,
    )]
    pub kamino_deposit_account: Box<InterfaceAccount<'info, TokenAccount>>,

    // --- Kamino accounts ---

    /// CHECK: Validated by Kamino program during CPI
    #[account(mut)]
    pub kamino_reserve: AccountInfo<'info>,

    /// CHECK: Validated by Kamino program during CPI
    pub kamino_lending_market: AccountInfo<'info>,

    /// CHECK: Validated by Kamino program during CPI
    pub kamino_lending_market_authority: AccountInfo<'info>,

    pub reserve_liquidity_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: Validated by Kamino program during CPI
    #[account(mut)]
    pub reserve_liquidity_supply: AccountInfo<'info>,

    /// CHECK: Validated by Kamino program during CPI
    #[account(mut)]
    pub reserve_collateral_mint: AccountInfo<'info>,

    pub collateral_token_program: Interface<'info, TokenInterface>,
    pub liquidity_token_program: Interface<'info, TokenInterface>,

    /// CHECK: Fixed address, validated by Kamino
    pub instruction_sysvar_account: AccountInfo<'info>,

    /// Kamino K-Lend program — must match market.underlying_protocol
    #[account(
        constraint = kamino_program.key() == market.underlying_protocol @ AnemoneError::InvalidReserve
    )]
    /// CHECK: Validated by constraint above
    pub kamino_program: AccountInfo<'info>,
}

pub fn handle_withdraw_from_kamino(
    ctx: Context<WithdrawFromKamino>,
    collateral_amount: u64,
) -> Result<()> {
    require!(collateral_amount > 0, AnemoneError::InvalidAmount);

    let market = &ctx.accounts.market;

    // Build PDA signer seeds
    let reserve_key = market.underlying_reserve;
    let tenor_bytes = market.tenor_seconds.to_le_bytes();
    let bump = market.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"market",
        reserve_key.as_ref(),
        &tenor_bytes,
        &[bump],
    ]];

    // Snapshot lp_vault before the CPI so we can record exactly how much
    // USDC Kamino delivered. This is the authoritative source — Kamino's
    // internal exchange-rate math is the only thing that knows the precise
    // amount, and reading the vault delta avoids replicating it here.
    let lp_vault_before = ctx.accounts.lp_vault.amount;

    // CPI: redeem k-tokens from Kamino → USDC to lp_vault
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
        collateral_amount,
    )?;

    // Update tracking — read new k-token balance and the actual USDC
    // delivered. Decrement `last_kamino_snapshot_usdc` by the delivered
    // amount: that USDC is no longer represented by k-tokens we hold, so
    // the snapshot (which represents "USDC value of our k-tokens at the
    // last sync, plus deposits, minus withdrawals") shrinks by exactly the
    // delivered amount. Future sync_kamino_yield can isolate yield without
    // double-counting principal exits.
    ctx.accounts.kamino_deposit_account.reload()?;
    ctx.accounts.lp_vault.reload()?;
    let usdc_delivered = ctx.accounts.lp_vault.amount.saturating_sub(lp_vault_before);
    let market = &mut ctx.accounts.market;
    market.total_kamino_collateral = ctx.accounts.kamino_deposit_account.amount;
    market.last_kamino_snapshot_usdc = market.last_kamino_snapshot_usdc
        .saturating_sub(usdc_delivered);

    msg!(
        "Withdrew {} k-tokens from Kamino ({} USDC delivered)",
        collateral_amount, usdc_delivered,
    );

    Ok(())
}
