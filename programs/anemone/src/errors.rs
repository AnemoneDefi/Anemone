use anchor_lang::prelude::*;

#[error_code]
pub enum AnemoneError {
    #[msg("Kamino reserve does not match market's underlying_reserve")]
    InvalidReserve,
    #[msg("Rate index cannot be zero")]
    InvalidRateIndex,
    #[msg("Elapsed time must be positive")]
    InvalidElapsedTime,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Market is paused")]
    MarketPaused,
    #[msg("Invalid vault address")]
    InvalidVault,
    #[msg("Invalid mint address")]
    InvalidMint,
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Insufficient shares for withdrawal")]
    InsufficientShares,
    #[msg("Withdrawal would leave pool undercollateralized")]
    PoolUndercollateralized,
    #[msg("Reserve data is stale — refresh before updating rate")]
    StaleOracle,
}
