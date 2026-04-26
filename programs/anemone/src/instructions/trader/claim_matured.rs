use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    Mint, TokenAccount, TokenInterface,
    transfer_checked, TransferChecked,
};
use crate::state::{SwapMarket, SwapPosition, SwapDirection, PositionStatus};
use crate::errors::AnemoneError;
use crate::helpers::cpi_withdraw_from_kamino;

#[derive(Accounts)]
pub struct ClaimMatured<'info> {
    #[account(
        mut,
        seeds = [b"market", market.underlying_reserve.as_ref(), &market.tenor_seconds.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, SwapMarket>>,

    #[account(
        mut,
        close = owner,
        seeds = [b"swap", owner.key().as_ref(), market.key().as_ref(), &[swap_position.nonce]],
        bump = swap_position.bump,
        constraint = swap_position.owner == owner.key() @ AnemoneError::InvalidVault,
        constraint = swap_position.market == market.key() @ AnemoneError::InvalidVault,
        constraint = swap_position.status == PositionStatus::Matured @ AnemoneError::PositionNotMatured,
    )]
    pub swap_position: Account<'info, SwapPosition>,

    /// LP vault — source of any unpaid_pnl catchup before claim.
    #[account(
        mut,
        address = market.lp_vault @ AnemoneError::InvalidVault,
    )]
    pub lp_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Collateral vault — source of the matured collateral
    #[account(
        mut,
        address = market.collateral_vault @ AnemoneError::InvalidVault,
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Owner's token account — receives collateral_remaining
    #[account(
        mut,
        token::mint = underlying_mint,
        token::authority = owner,
    )]
    pub owner_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The underlying token mint (e.g. USDC)
    #[account(
        address = market.underlying_mint @ AnemoneError::InvalidMint,
    )]
    pub underlying_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,

    // ----- Kamino accounts for internal redeem-on-shortfall -----
    //
    // claim_matured does an internal `withdraw_from_kamino` CPI when the LP
    // owes the trader unpaid PnL but the lp_vault is short. This avoids
    // forcing the trader to bundle a separate `withdraw_from_kamino` ix
    // (which is permissionless but spammable — see PR #25 grief vector).
    //
    // All Kamino accounts must be passed at every claim_matured call. The
    // CPI only fires when shortfall > 0; if lp_vault already has enough
    // cash, these accounts are read-only inputs that go untouched.

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

pub fn handle_claim_matured(ctx: Context<ClaimMatured>) -> Result<()> {
    let position = &ctx.accounts.swap_position;
    let market = &ctx.accounts.market;

    let direction = position.direction;
    let notional = position.notional;

    let reserve_key = market.underlying_reserve;
    let tenor_bytes = market.tenor_seconds.to_le_bytes();
    let bump = market.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"market",
        reserve_key.as_ref(),
        &tenor_bytes,
        &[bump],
    ]];

    // Internal Kamino redeem on shortfall — fixes the grief vector that
    // PR #25's permissionless `withdraw_from_kamino` opened. If LP owes
    // the trader unpaid PnL and the lp_vault doesn't have enough cash,
    // redeem just enough k-USDC from Kamino to cover the catchup IN THIS
    // SAME TX. Trader gets atomic exit — no bundling, no waiting on the
    // keeper, no externally-callable rebalance surface for attackers to
    // grief.
    //
    // Amount logic: k-USDC redeems for >= 1.0 USDC per unit (Kamino's
    // `collateral_to_liquidity_exchange_rate` is monotonic for stablecoin
    // reserves), so requesting `shortfall` k-USDC always yields >=
    // `shortfall` USDC. The excess (if any) stays in lp_vault as a small
    // unintended buffer that the keeper rebalances on its next cycle.
    let mut kamino_redeemed_usdc: u64 = 0;
    if position.unpaid_pnl > 0 {
        let needed = position.unpaid_pnl as u64;
        let lp_vault_balance = ctx.accounts.lp_vault.amount;
        if needed > lp_vault_balance {
            let shortfall_k = needed.saturating_sub(lp_vault_balance);
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
            // Refresh balance after CPI so the catchup below sees the new state.
            ctx.accounts.lp_vault.reload()?;
            ctx.accounts.kamino_deposit_account.reload()?;
            // Capture the actual USDC Kamino delivered for the snapshot
            // accounting at the bottom of the handler (mirrors the keeper's
            // withdraw_from_kamino bookkeeping).
            kamino_redeemed_usdc = ctx.accounts.lp_vault.amount
                .saturating_sub(lp_vault_before_cpi);
        }
    }

    // H1 catchup: after maturity, settle_period no longer runs (status is
    // Matured, not Open), so any unpaid_pnl from the final settle can only
    // be paid here. With the internal Kamino redeem above, lp_vault now
    // has enough cash unless Kamino itself is insolvent.
    let catchup_amount: u64 = if position.unpaid_pnl > 0 && ctx.accounts.lp_vault.amount > 0 {
        let amount = (position.unpaid_pnl as u64).min(ctx.accounts.lp_vault.amount);
        if amount > 0 {
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.lp_vault.to_account_info(),
                        to: ctx.accounts.collateral_vault.to_account_info(),
                        authority: ctx.accounts.market.to_account_info(),
                        mint: ctx.accounts.underlying_mint.to_account_info(),
                    },
                    signer_seeds,
                ),
                amount,
                ctx.accounts.underlying_mint.decimals,
            )?;
        }
        amount
    } else {
        0
    };

    let unpaid_after: i64 = position.unpaid_pnl
        .checked_sub(catchup_amount as i64)
        .ok_or(AnemoneError::MathOverflow)?;
    require!(unpaid_after == 0, AnemoneError::UnpaidPnlOutstanding);

    let amount = position.collateral_remaining
        .checked_add(catchup_amount)
        .ok_or(AnemoneError::MathOverflow)?;

    // Transfer (collateral_remaining + catchup) from collateral_vault to owner.
    if amount > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.collateral_vault.to_account_info(),
                    to: ctx.accounts.owner_token_account.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                    mint: ctx.accounts.underlying_mint.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
            ctx.accounts.underlying_mint.decimals,
        )?;
    }

    // Update market totals + lp_nav for the catchup drain.
    // Also mirror any internal Kamino redeem that happened above into
    // market.total_kamino_collateral so subsequent reads see the truth.
    // When the CPI fired, decrement last_kamino_snapshot_usdc by the
    // delivered USDC — same bookkeeping the keeper's withdraw_from_kamino
    // does, so future sync_kamino_yield can isolate yield without
    // double-counting principal exits.
    let kamino_balance_now = ctx.accounts.kamino_deposit_account.amount;
    let market = &mut ctx.accounts.market;
    if catchup_amount > 0 {
        market.lp_nav = market.lp_nav
            .checked_sub(catchup_amount)
            .ok_or(AnemoneError::MathOverflow)?;
    }
    market.total_kamino_collateral = kamino_balance_now;
    if kamino_redeemed_usdc > 0 {
        market.last_kamino_snapshot_usdc = market.last_kamino_snapshot_usdc
            .saturating_sub(kamino_redeemed_usdc);
    }
    match direction {
        SwapDirection::PayFixed => {
            market.total_fixed_notional = market.total_fixed_notional
                .checked_sub(notional)
                .ok_or(AnemoneError::MathOverflow)?;
        }
        SwapDirection::ReceiveFixed => {
            market.total_variable_notional = market.total_variable_notional
                .checked_sub(notional)
                .ok_or(AnemoneError::MathOverflow)?;
        }
    }
    market.total_open_positions = market.total_open_positions
        .checked_sub(1)
        .ok_or(AnemoneError::MathOverflow)?;

    msg!("Claim matured: returned {} to {}", amount, ctx.accounts.owner.key());

    Ok(())
}
