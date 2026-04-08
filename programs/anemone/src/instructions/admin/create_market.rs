use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use crate::state::{ProtocolState, SwapMarket};

#[derive(Accounts)]
#[instruction(tenor_seconds: i64)]
pub struct CreateMarket<'info> {
    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_state.bump,
        has_one = authority,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(
        init,
        payer = authority,
        space = SwapMarket::SIZE,
        seeds = [b"market", underlying_reserve.key().as_ref(), &tenor_seconds.to_le_bytes()],
        bump
    )]
    pub market: Account<'info, SwapMarket>,

    /// LP vault: holds USDC in transit during settlements
    #[account(
        init,
        payer = authority,
        seeds = [b"lp_vault", market.key().as_ref()],
        bump,
        token::mint = underlying_mint,
        token::authority = market,
    )]
    pub lp_vault: InterfaceAccount<'info, TokenAccount>,

    /// Collateral vault: holds trader collateral
    #[account(
        init,
        payer = authority,
        seeds = [b"collateral_vault", market.key().as_ref()],
        bump,
        token::mint = underlying_mint,
        token::authority = market,
    )]
    pub collateral_vault: InterfaceAccount<'info, TokenAccount>,

    /// LP token mint: receipt tokens for liquidity providers
    #[account(
        init,
        payer = authority,
        seeds = [b"lp_mint", market.key().as_ref()],
        bump,
        mint::decimals = 6,
        mint::authority = market,
    )]
    pub lp_mint: InterfaceAccount<'info, Mint>,

    /// The lending protocol's reserve account (e.g. Kamino USDC Reserve)
    /// CHECK: Validated off-chain, used to derive PDA and read rates
    pub underlying_reserve: AccountInfo<'info>,

    /// The lending protocol's program ID (e.g. Kamino K-Lend program)
    /// CHECK: Stored as reference for future CPI calls
    pub underlying_protocol: AccountInfo<'info>,

    /// The token mint for this market (e.g. USDC mint)
    pub underlying_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_create_market(
    ctx: Context<CreateMarket>,
    tenor_seconds: i64,
    settlement_period_seconds: i64,
    max_utilization_bps: u16,
    base_spread_bps: u16,
    max_leverage: u8,
) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let protocol_state = &mut ctx.accounts.protocol_state;

    // Identity
    market.protocol_state = protocol_state.key();
    market.underlying_protocol = ctx.accounts.underlying_protocol.key();
    market.underlying_reserve = ctx.accounts.underlying_reserve.key();
    market.underlying_mint = ctx.accounts.underlying_mint.key();

    // Vaults
    market.lp_vault = ctx.accounts.lp_vault.key();
    market.kamino_deposit_account = Pubkey::default();
    market.collateral_vault = ctx.accounts.collateral_vault.key();
    market.lp_mint = ctx.accounts.lp_mint.key();

    // Parameters
    market.tenor_seconds = tenor_seconds;
    market.settlement_period_seconds = settlement_period_seconds;
    market.max_utilization_bps = max_utilization_bps;
    market.base_spread_bps = base_spread_bps;
    market.max_leverage = max_leverage;

    // State (all zeros on creation)
    market.total_lp_deposits = 0;
    market.total_lp_shares = 0;
    market.total_fixed_notional = 0;
    market.total_variable_notional = 0;
    market.pending_withdrawals = 0;
    market.current_rate_index = 0;
    market.last_rate_update_ts = 0;
    market.cumulative_fees_earned = 0;
    market.total_open_positions = 0;

    // Meta
    market.status = 0;
    market.bump = ctx.bumps.market;

    // Increment market counter
    protocol_state.total_markets += 1;

    msg!("Market created: tenor={}s, spread={}bps, max_util={}bps, max_lev={}x",
        tenor_seconds, base_spread_bps, max_utilization_bps, max_leverage);

    Ok(())
}