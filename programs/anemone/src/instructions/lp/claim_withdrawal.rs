use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    Mint, TokenAccount, TokenInterface,
    transfer_checked, TransferChecked,
};
use crate::state::{SwapMarket, LpPosition, LpStatus, ProtocolState, MAX_NAV_STALENESS_SECS};
use crate::errors::AnemoneError;

#[derive(Accounts)]
pub struct ClaimWithdrawal<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(
        mut,
        seeds = [b"market", market.underlying_reserve.as_ref(), &market.tenor_seconds.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, SwapMarket>,

    #[account(
        mut,
        seeds = [b"lp", withdrawer.key().as_ref(), market.key().as_ref()],
        bump = lp_position.bump,
        constraint = lp_position.owner == withdrawer.key() @ AnemoneError::InsufficientShares,
        constraint = lp_position.status == LpStatus::PendingWithdrawal @ AnemoneError::NoPendingWithdrawal,
    )]
    pub lp_position: Account<'info, LpPosition>,

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

    // Vault must be refilled by the keeper before the LP can claim.
    require!(
        ctx.accounts.lp_vault.amount >= gross_amount,
        AnemoneError::InsufficientVaultLiquidity,
    );

    // Fee is computed with the current bps; shares were already burned at
    // request time and the gross amount is locked in the LpPosition.
    let fee = (gross_amount as u128)
        .checked_mul(ctx.accounts.protocol_state.withdrawal_fee_bps as u128)
        .and_then(|v| v.checked_div(10_000))
        .ok_or(AnemoneError::MathOverflow)? as u64;
    let net_amount = gross_amount.checked_sub(fee).ok_or(AnemoneError::MathOverflow)?;

    let market = &ctx.accounts.market;
    let reserve_key = market.underlying_reserve;
    let tenor_bytes = market.tenor_seconds.to_le_bytes();
    let bump = market.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"market",
        reserve_key.as_ref(),
        &tenor_bytes,
        &[bump],
    ]];

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

    let market = &mut ctx.accounts.market;
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
