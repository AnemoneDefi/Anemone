use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use crate::state::{SwapMarket, ProtocolState};
use crate::errors::AnemoneError;
use crate::helpers::cpi_deposit_to_kamino;

#[derive(Accounts)]
pub struct DepositToKamino<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_state.bump,
        has_one = authority,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"market", market.underlying_reserve.as_ref(), &market.tenor_seconds.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, SwapMarket>,

    /// Our LP vault — source of USDC
    #[account(
        mut,
        address = market.lp_vault @ AnemoneError::InvalidVault,
    )]
    pub lp_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Our kamino deposit account — receives k-tokens
    #[account(
        mut,
        address = market.kamino_deposit_account @ AnemoneError::InvalidVault,
    )]
    pub kamino_deposit_account: Box<InterfaceAccount<'info, TokenAccount>>,

    // --- Kamino accounts ---

    /// Kamino Reserve (e.g. USDC Reserve)
    /// CHECK: Validated by Kamino program during CPI
    #[account(mut)]
    pub kamino_reserve: AccountInfo<'info>,

    /// Kamino LendingMarket
    /// CHECK: Validated by Kamino program during CPI
    pub kamino_lending_market: AccountInfo<'info>,

    /// Kamino LendingMarket authority PDA
    /// CHECK: Validated by Kamino program during CPI
    pub kamino_lending_market_authority: AccountInfo<'info>,

    /// USDC mint (reserve liquidity mint)
    pub reserve_liquidity_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Kamino's USDC vault
    /// CHECK: Validated by Kamino program during CPI
    #[account(mut)]
    pub reserve_liquidity_supply: AccountInfo<'info>,

    /// k-USDC mint (reserve collateral mint)
    /// CHECK: Validated by Kamino program during CPI
    #[account(mut)]
    pub reserve_collateral_mint: AccountInfo<'info>,

    /// Token program for k-tokens
    pub collateral_token_program: Interface<'info, TokenInterface>,

    /// Token program for USDC
    pub liquidity_token_program: Interface<'info, TokenInterface>,

    /// Instructions sysvar
    /// CHECK: Fixed address, validated by Kamino
    pub instruction_sysvar_account: AccountInfo<'info>,

    /// Kamino K-Lend program — must match market.underlying_protocol
    #[account(
        constraint = kamino_program.key() == market.underlying_protocol @ AnemoneError::InvalidReserve
    )]
    /// CHECK: Validated by constraint above
    pub kamino_program: AccountInfo<'info>,
}

pub fn handle_deposit_to_kamino(
    ctx: Context<DepositToKamino>,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, AnemoneError::InvalidAmount);

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

    // CPI: deposit USDC from lp_vault → Kamino
    cpi_deposit_to_kamino(
        &ctx.accounts.kamino_program,
        &ctx.accounts.market.to_account_info(),
        signer_seeds,
        &ctx.accounts.kamino_reserve,
        &ctx.accounts.kamino_lending_market,
        &ctx.accounts.kamino_lending_market_authority,
        &ctx.accounts.reserve_liquidity_mint.to_account_info(),
        &ctx.accounts.reserve_liquidity_supply,
        &ctx.accounts.reserve_collateral_mint,
        &ctx.accounts.lp_vault.to_account_info(),
        &ctx.accounts.kamino_deposit_account.to_account_info(),
        &ctx.accounts.collateral_token_program.to_account_info(),
        &ctx.accounts.liquidity_token_program.to_account_info(),
        &ctx.accounts.instruction_sysvar_account,
        amount,
    )?;

    // Update tracking — read new k-token balance
    ctx.accounts.kamino_deposit_account.reload()?;
    let market = &mut ctx.accounts.market;
    market.total_kamino_collateral = ctx.accounts.kamino_deposit_account.amount;

    msg!("Deposited {} USDC to Kamino", amount);

    Ok(())
}
