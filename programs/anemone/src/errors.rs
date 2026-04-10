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
}
