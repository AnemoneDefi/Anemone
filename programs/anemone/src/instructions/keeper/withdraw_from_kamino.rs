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

    /// Permissionless signer — anyone can pay gas to redeem k-tokens back
    /// into `lp_vault`. The destination is a protocol-owned PDA, not the
    /// caller, so there is no exfiltration risk and no incentive to grief
    /// (every call costs the caller their own gas + CU).
    ///
    /// Why this matters: traders bundling `close_position_early` /
    /// `claim_matured` need `lp_vault` to have cash to clear any
    /// `unpaid_pnl` against their position. Without permissionless
    /// withdraw, the trader is held hostage to keeper liveness — keeper
    /// dies, position can never close. With permissionless withdraw, the
    /// trader just bundles a `withdraw_from_kamino` preInstruction,
    /// pays the extra ~85k CU + Kamino CPI gas themselves, and exits
    /// atomically.
    ///
    /// The keeper still calls this from its own jobs in the happy path —
    /// the constraint removal just adds a fallback path for self-service.
    pub caller: Signer<'info>,

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

    // Update tracking — read new k-token balance
    ctx.accounts.kamino_deposit_account.reload()?;
    let market = &mut ctx.accounts.market;
    market.total_kamino_collateral = ctx.accounts.kamino_deposit_account.amount;

    msg!("Withdrew {} k-tokens from Kamino", collateral_amount);

    Ok(())
}
