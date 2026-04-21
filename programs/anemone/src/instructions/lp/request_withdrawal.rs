use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    Mint, TokenAccount, TokenInterface,
    burn, transfer_checked, Burn, TransferChecked,
};
use crate::state::{SwapMarket, LpPosition, LpStatus, ProtocolState};
use crate::errors::AnemoneError;

#[derive(Accounts)]
pub struct RequestWithdrawal<'info> {
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
        constraint = lp_position.status == LpStatus::Active @ AnemoneError::NoPendingWithdrawal,
    )]
    pub lp_position: Account<'info, LpPosition>,

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

    /// Withdrawer's USDC token account (destination — only used on fast path)
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
}

pub fn handle_request_withdrawal(
    ctx: Context<RequestWithdrawal>,
    shares_to_burn: u64,
) -> Result<()> {
    require!(shares_to_burn > 0, AnemoneError::InvalidAmount);

    let market = &ctx.accounts.market;
    let lp_position = &ctx.accounts.lp_position;
    let protocol_state = &ctx.accounts.protocol_state;

    require!(lp_position.shares >= shares_to_burn, AnemoneError::InsufficientShares);

    // Share-price uses effective deposits (total - already pending) so that
    // consecutive queue-path requests stay consistent with the USDC actually
    // available to be paid out.
    let effective_deposits = market.total_lp_deposits
        .checked_sub(market.pending_withdrawals)
        .ok_or(AnemoneError::MathOverflow)?;
    let gross_amount = (shares_to_burn as u128)
        .checked_mul(effective_deposits as u128)
        .and_then(|v| v.checked_div(market.total_lp_shares as u128))
        .ok_or(AnemoneError::MathOverflow)? as u64;

    // Collateralization check — must hold even if withdrawal is queued,
    // because once the USDC leaves the pool (eventually) it can no longer
    // back open positions.
    let total_notional = market.total_fixed_notional
        .max(market.total_variable_notional);
    let remaining_deposits = effective_deposits
        .checked_sub(gross_amount)
        .ok_or(AnemoneError::MathOverflow)?;
    let max_notional_after = (remaining_deposits as u128)
        .checked_mul(market.max_utilization_bps as u128)
        .and_then(|v| v.checked_div(10_000))
        .ok_or(AnemoneError::MathOverflow)? as u64;
    require!(total_notional <= max_notional_after, AnemoneError::PoolUndercollateralized);

    // Burn shares immediately in both paths — prevents the LP from transferring
    // the LP tokens elsewhere and double-spending the withdrawal claim.
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

    let vault_balance = ctx.accounts.lp_vault.amount;
    let can_pay_now = vault_balance >= gross_amount;

    if can_pay_now {
        // Fast path — vault has the USDC on hand, deliver immediately.
        let fee = (gross_amount as u128)
            .checked_mul(protocol_state.withdrawal_fee_bps as u128)
            .and_then(|v| v.checked_div(10_000))
            .ok_or(AnemoneError::MathOverflow)? as u64;
        let net_amount = gross_amount.checked_sub(fee).ok_or(AnemoneError::MathOverflow)?;

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
        market.total_lp_deposits = market.total_lp_deposits
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

        msg!("Withdrawal fast path: {} shares -> {} USDC (fee: {})", shares_to_burn, net_amount, fee);
    } else {
        // Queue path — vault is short. Lock in the gross amount and wait for
        // the keeper to refill the vault from Kamino. LP calls claim_withdrawal
        // once the balance is back up.
        let market = &mut ctx.accounts.market;
        market.total_lp_shares = market.total_lp_shares
            .checked_sub(shares_to_burn)
            .ok_or(AnemoneError::MathOverflow)?;
        market.pending_withdrawals = market.pending_withdrawals
            .checked_add(gross_amount)
            .ok_or(AnemoneError::MathOverflow)?;

        let lp_position = &mut ctx.accounts.lp_position;
        lp_position.shares = lp_position.shares
            .checked_sub(shares_to_burn)
            .ok_or(AnemoneError::MathOverflow)?;
        lp_position.status = LpStatus::PendingWithdrawal;
        lp_position.withdrawal_amount = gross_amount;
        lp_position.withdrawal_requested_at = Clock::get()?.unix_timestamp;

        msg!(
            "Withdrawal queued: {} shares -> {} USDC pending (vault had {})",
            shares_to_burn,
            gross_amount,
            vault_balance,
        );
    }

    Ok(())
}
