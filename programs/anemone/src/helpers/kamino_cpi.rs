use anchor_lang::prelude::*;
use kamino_lend::cpi::{
    deposit_reserve_liquidity,
    redeem_reserve_collateral,
    accounts::{
        DepositReserveLiquidity,
        RedeemReserveCollateral,
    },
};

/// CPI: Deposit USDC from our lp_vault into Kamino, receiving k-tokens
pub fn cpi_deposit_to_kamino<'info>(
    kamino_program: &AccountInfo<'info>,
    market_signer: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
    reserve: &AccountInfo<'info>,
    lending_market: &AccountInfo<'info>,
    lending_market_authority: &AccountInfo<'info>,
    reserve_liquidity_mint: &AccountInfo<'info>,
    reserve_liquidity_supply: &AccountInfo<'info>,
    reserve_collateral_mint: &AccountInfo<'info>,
    user_source_liquidity: &AccountInfo<'info>,
    user_destination_collateral: &AccountInfo<'info>,
    collateral_token_program: &AccountInfo<'info>,
    liquidity_token_program: &AccountInfo<'info>,
    instruction_sysvar: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let cpi_accounts = DepositReserveLiquidity {
        owner: market_signer.clone(),
        reserve: reserve.clone(),
        lending_market: lending_market.clone(),
        lending_market_authority: lending_market_authority.clone(),
        reserve_liquidity_mint: reserve_liquidity_mint.clone(),
        reserve_liquidity_supply: reserve_liquidity_supply.clone(),
        reserve_collateral_mint: reserve_collateral_mint.clone(),
        user_source_liquidity: user_source_liquidity.clone(),
        user_destination_collateral: user_destination_collateral.clone(),
        collateral_token_program: collateral_token_program.clone(),
        liquidity_token_program: liquidity_token_program.clone(),
        instruction_sysvar_account: instruction_sysvar.clone(),
    };

    let cpi_ctx = CpiContext::new_with_signer(
        kamino_program.clone(),
        cpi_accounts,
        signer_seeds,
    );

    deposit_reserve_liquidity(cpi_ctx, amount)
}

/// CPI: Redeem k-tokens from Kamino, receiving USDC back to lp_vault
pub fn cpi_withdraw_from_kamino<'info>(
    kamino_program: &AccountInfo<'info>,
    market_signer: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
    reserve: &AccountInfo<'info>,
    lending_market: &AccountInfo<'info>,
    lending_market_authority: &AccountInfo<'info>,
    reserve_liquidity_mint: &AccountInfo<'info>,
    reserve_liquidity_supply: &AccountInfo<'info>,
    reserve_collateral_mint: &AccountInfo<'info>,
    user_source_collateral: &AccountInfo<'info>,
    user_destination_liquidity: &AccountInfo<'info>,
    collateral_token_program: &AccountInfo<'info>,
    liquidity_token_program: &AccountInfo<'info>,
    instruction_sysvar: &AccountInfo<'info>,
    collateral_amount: u64,
) -> Result<()> {
    let cpi_accounts = RedeemReserveCollateral {
        owner: market_signer.clone(),
        lending_market: lending_market.clone(),
        reserve: reserve.clone(),
        lending_market_authority: lending_market_authority.clone(),
        reserve_liquidity_mint: reserve_liquidity_mint.clone(),
        reserve_collateral_mint: reserve_collateral_mint.clone(),
        reserve_liquidity_supply: reserve_liquidity_supply.clone(),
        user_source_collateral: user_source_collateral.clone(),
        user_destination_liquidity: user_destination_liquidity.clone(),
        collateral_token_program: collateral_token_program.clone(),
        liquidity_token_program: liquidity_token_program.clone(),
        instruction_sysvar_account: instruction_sysvar.clone(),
    };

    let cpi_ctx = CpiContext::new_with_signer(
        kamino_program.clone(),
        cpi_accounts,
        signer_seeds,
    );

    redeem_reserve_collateral(cpi_ctx, collateral_amount)
}
