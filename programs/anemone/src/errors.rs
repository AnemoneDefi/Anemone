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
    #[msg("Pool utilization would exceed maximum allowed")]
    UtilizationExceeded,
    #[msg("Insufficient collateral for required initial margin")]
    InsufficientCollateral,
    #[msg("Rate index not initialized — keeper must update rate first")]
    RateIndexNotInitialized,
    #[msg("Settlement period has not elapsed yet")]
    SettlementNotDue,
    #[msg("Position is not open")]
    PositionNotOpen,
    #[msg("Offered rate exceeds trader's slippage tolerance")]
    SlippageExceeded,
    #[msg("Position is not matured — cannot claim yet")]
    PositionNotMatured,
    #[msg("Position is above maintenance margin — cannot liquidate")]
    AboveMaintenanceMargin,
    #[msg("Invalid authority — caller is not the protocol keeper")]
    InvalidAuthority,
}
