use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use crate::state::{ProtocolState, SwapMarket};
use crate::errors::AnemoneError;

// H5 market param caps. See also `initialize_protocol` for the fee caps.
//
//   max_utilization_bps  <= 9500 (95%) — leaves a 5% buffer so LP can
//                                        always exit even at peak usage
//   base_spread_bps      <=  500 (5%)  — any real rate-swap market has
//                                        base spread < 1% (Pendle 0.2%,
//                                        IPOR 0.3%). 500 bps is 10x that
//                                        so admin mistakes are caught
//                                        without flagging exotic designs.
//   tenor_seconds        >=    1       — reject zero/negative; longer
//                                        minimums are market policy, not
//                                        safety. Real markets use 1d+.
//   settlement_period    <=  tenor     — correctness: one settlement
//                                        per tenor at minimum.
pub const MAX_UTILIZATION_BPS_CAP: u16 = 9_500;
pub const MAX_BASE_SPREAD_BPS: u16 = 500;

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
    pub market: Box<Account<'info, SwapMarket>>,

    /// LP vault: holds USDC in transit during settlements
    #[account(
        init,
        payer = authority,
        seeds = [b"lp_vault", market.key().as_ref()],
        bump,
        token::mint = underlying_mint,
        token::authority = market,
    )]
    pub lp_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Collateral vault: holds trader collateral
    #[account(
        init,
        payer = authority,
        seeds = [b"collateral_vault", market.key().as_ref()],
        bump,
        token::mint = underlying_mint,
        token::authority = market,
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// LP token mint: receipt tokens for liquidity providers
    #[account(
        init,
        payer = authority,
        seeds = [b"lp_mint", market.key().as_ref()],
        bump,
        mint::decimals = 6,
        mint::authority = market,
    )]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Kamino deposit account: holds k-tokens (collateral from Kamino deposits)
    #[account(
        init,
        payer = authority,
        seeds = [b"kamino_deposit", market.key().as_ref()],
        bump,
        token::mint = kamino_collateral_mint,
        token::authority = market,
    )]
    pub kamino_deposit_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The Kamino collateral mint (k-token, e.g. k-USDC)
    /// CHECK: Validated off-chain. Used as mint for kamino_deposit_account.
    pub kamino_collateral_mint: AccountInfo<'info>,

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
) -> Result<()> {
    require!(tenor_seconds > 0, AnemoneError::ParamOutOfRange);
    require!(
        settlement_period_seconds > 0 && settlement_period_seconds <= tenor_seconds,
        AnemoneError::ParamOutOfRange,
    );
    require!(
        max_utilization_bps > 0 && max_utilization_bps <= MAX_UTILIZATION_BPS_CAP,
        AnemoneError::ParamOutOfRange,
    );
    require!(base_spread_bps <= MAX_BASE_SPREAD_BPS, AnemoneError::ParamOutOfRange);

    // H7: restrict the underlying to classic SPL Token mints. Token-2022
    // extensions (TransferHook, PermanentDelegate, TransferFee, DefaultAccountState
    // = Frozen, NonTransferable, …) break invariants the protocol relies on —
    // a malicious TransferHook could re-enter `claim_withdrawal` mid-transfer;
    // PermanentDelegate lets an external pubkey drain `lp_vault` without the
    // market PDA ever signing; TransferFee silently desyncs `lp_nav`
    // from `lp_vault.amount`. USDC on Solana is still classic SPL, so this
    // constraint does not block the intended use case. Lift to a per-extension
    // allowlist only when we actually want to onboard a Token-2022 mint.
    require!(
        ctx.accounts.underlying_mint.to_account_info().owner == &anchor_spl::token::ID,
        AnemoneError::UnsupportedMintExtensions,
    );

    let market = &mut ctx.accounts.market;
    let protocol_state = &mut ctx.accounts.protocol_state;

    // Identity
    market.protocol_state = protocol_state.key();
    market.underlying_protocol = ctx.accounts.underlying_protocol.key();
    market.underlying_reserve = ctx.accounts.underlying_reserve.key();
    market.underlying_mint = ctx.accounts.underlying_mint.key();

    // Vaults
    market.lp_vault = ctx.accounts.lp_vault.key();
    market.kamino_deposit_account = ctx.accounts.kamino_deposit_account.key();
    market.collateral_vault = ctx.accounts.collateral_vault.key();
    market.lp_mint = ctx.accounts.lp_mint.key();

    // Parameters
    market.tenor_seconds = tenor_seconds;
    market.settlement_period_seconds = settlement_period_seconds;
    market.max_utilization_bps = max_utilization_bps;
    market.base_spread_bps = base_spread_bps;

    // State (all zeros on creation)
    market.lp_nav = 0;
    market.total_lp_shares = 0;
    market.total_fixed_notional = 0;
    market.total_variable_notional = 0;
    market.pending_withdrawals = 0;
    market.previous_rate_index = 0;
    market.previous_rate_update_ts = 0;
    market.current_rate_index = 0;
    market.last_rate_update_ts = 0;
    market.cumulative_fees_earned = 0;
    market.total_open_positions = 0;
    market.total_kamino_collateral = 0;
    market.last_kamino_snapshot_usdc = 0;
    // Seed with the clock so a fresh market is not instantly "stale" —
    // callers have the full MAX_NAV_STALENESS_SECS window before the first
    // sync_kamino_yield is required.
    market.last_kamino_sync_ts = Clock::get()?.unix_timestamp;

    // Meta
    market.status = 0;
    market.bump = ctx.bumps.market;

    // Increment market counter
    protocol_state.total_markets += 1;

    msg!("Market created: tenor={}s, spread={}bps, max_util={}bps",
        tenor_seconds, base_spread_bps, max_utilization_bps);

    Ok(())
}