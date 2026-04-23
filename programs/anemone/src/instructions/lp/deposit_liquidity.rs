use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    Mint, TokenAccount, TokenInterface,
    mint_to, transfer_checked, MintTo, TransferChecked,
};
use crate::state::{SwapMarket, LpPosition, LpStatus};
use crate::errors::AnemoneError;

#[derive(Accounts)]
pub struct DepositLiquidity<'info> {
    #[account(
        mut,
        seeds = [b"market", market.underlying_reserve.as_ref(), &market.tenor_seconds.to_le_bytes()],
        bump = market.bump,
        constraint = market.status == 0 @ AnemoneError::MarketPaused,
    )]
    pub market: Account<'info, SwapMarket>,

    #[account(
        init_if_needed,
        payer = depositor,
        space = LpPosition::SIZE,
        seeds = [b"lp", depositor.key().as_ref(), market.key().as_ref()],
        bump,
    )]
    pub lp_position: Account<'info, LpPosition>,

    /// LP vault — PDA-controlled token account that holds USDC
    #[account(
        mut,
        address = market.lp_vault @ AnemoneError::InvalidVault,
    )]
    pub lp_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// LP token mint — program mints shares to depositor
    #[account(
        mut,
        address = market.lp_mint @ AnemoneError::InvalidMint,
    )]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>,

    /// The underlying token mint (e.g. USDC) — needed for transfer_checked
    #[account(
        address = market.underlying_mint @ AnemoneError::InvalidMint,
    )]
    pub underlying_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Depositor's USDC token account (source of funds)
    #[account(
        mut,
        token::mint = underlying_mint,
        token::authority = depositor,
    )]
    pub depositor_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Depositor's LP token account (receives minted shares)
    #[account(
        mut,
        token::mint = lp_mint,
        token::authority = depositor,
    )]
    pub depositor_lp_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handle_deposit_liquidity(
    ctx: Context<DepositLiquidity>,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, AnemoneError::InvalidAmount);

    let market = &mut ctx.accounts.market;
    let lp_position = &mut ctx.accounts.lp_position;

    // Step 1: Calculate shares
    // First depositor gets 1:1, subsequent get proportional to pool value.
    // Effective deposits exclude pending withdrawals so that a new LP does
    // not get a discounted share price while another LP is mid-exit.
    let shares = if market.total_lp_shares == 0 {
        amount
    } else {
        let effective_deposits = market.total_lp_deposits
            .checked_sub(market.pending_withdrawals)
            .ok_or(AnemoneError::MathOverflow)?;
        (amount as u128)
            .checked_mul(market.total_lp_shares as u128)
            .and_then(|v| v.checked_div(effective_deposits as u128))
            .ok_or(AnemoneError::MathOverflow)? as u64
    };

    require!(shares > 0, AnemoneError::InvalidAmount);

    // Step 2: Transfer USDC from depositor → lp_vault
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.depositor_token_account.to_account_info(),
                to: ctx.accounts.lp_vault.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
                mint: ctx.accounts.underlying_mint.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.underlying_mint.decimals,
    )?;

    // Step 3: Mint LP tokens to depositor (PDA signs as mint authority)
    let reserve_key = market.underlying_reserve;
    let tenor_bytes = market.tenor_seconds.to_le_bytes();
    let bump = market.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"market",
        reserve_key.as_ref(),
        &tenor_bytes,
        &[bump],
    ]];

    mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.lp_mint.to_account_info(),
                to: ctx.accounts.depositor_lp_token_account.to_account_info(),
                authority: market.to_account_info(),
            },
            signer_seeds,
        ),
        shares,
    )?;

    // Step 4: Update market state
    market.total_lp_deposits = market.total_lp_deposits
        .checked_add(amount)
        .ok_or(AnemoneError::MathOverflow)?;
    market.total_lp_shares = market.total_lp_shares
        .checked_add(shares)
        .ok_or(AnemoneError::MathOverflow)?;

    // Step 5: Create or update LP position
    if !lp_position.is_initialized {
        lp_position.is_initialized = true;
        lp_position.owner = ctx.accounts.depositor.key();
        lp_position.market = market.key();
        lp_position.status = LpStatus::Active;
        lp_position.withdrawal_requested_at = 0;
        lp_position.withdrawal_amount = 0;
        lp_position.bump = ctx.bumps.lp_position;
    }
    lp_position.shares = lp_position.shares
        .checked_add(shares)
        .ok_or(AnemoneError::MathOverflow)?;
    lp_position.deposited_amount = lp_position.deposited_amount
        .checked_add(amount)
        .ok_or(AnemoneError::MathOverflow)?;

    msg!("Deposit: {} USDC -> {} shares", amount, shares);

    Ok(())
}
