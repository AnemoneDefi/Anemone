use anchor_lang::prelude::*;
use crate::errors::AnemoneError;

/// Byte offset of `liquidity.cumulative_borrow_rate_bsf` within a Kamino Reserve account.
///
/// Layout verified against mainnet Kamino USDC Reserve fixture using decode_reserve.ts.
/// The field is a BigFractionBytes = [u64; 4] (32 bytes, little-endian).
///
/// Offset 296 = 8 (discriminator) + layout of all preceding fields.
/// Only value[0] and value[1] (lower 128 bits) are used for rate calculations.
const CUMULATIVE_BORROW_RATE_OFFSET: usize = 296;

/// Reads the cumulative borrow rate index from a Kamino Reserve account.
///
/// Reads the BigFractionBytes value directly from raw account data at the known
/// byte offset, avoiding a dependency on the kamino-lend crate which has
/// borsh/rustc compatibility issues.
///
/// Returns the lower 128 bits (value[0] | value[1] << 64) as u128.
pub fn read_kamino_rate_index(reserve_info: &AccountInfo) -> Result<u128> {
    let data = reserve_info.try_borrow_data()?;

    let min_len = CUMULATIVE_BORROW_RATE_OFFSET + 16; // we need value[0] + value[1]
    require!(data.len() >= min_len, AnemoneError::InvalidRateIndex);

    let offset = CUMULATIVE_BORROW_RATE_OFFSET;

    // value[0]: bytes [offset..offset+8], little-endian u64
    let v0 = u64::from_le_bytes(
        data[offset..offset + 8]
            .try_into()
            .map_err(|_| AnemoneError::MathOverflow)?,
    );

    // value[1]: bytes [offset+8..offset+16], little-endian u64
    let v1 = u64::from_le_bytes(
        data[offset + 8..offset + 16]
            .try_into()
            .map_err(|_| AnemoneError::MathOverflow)?,
    );

    let lower = v0 as u128;
    let upper = (v1 as u128) << 64;

    Ok(lower | upper)
}

/// Converts a rate index delta over a time period into an annualized APY in basis points.
/// Uses Taylor expansion with 3 terms for >99.6% precision vs true compound.
///
/// Formula: (1 + r)^n ≈ 1 + n*r + n*(n-1)*r²/2 + n*(n-1)*(n-2)*r³/6
/// Where r = rate delta in period, n = year / elapsed
///
/// All math uses fixed-point scaled by PRECISION to avoid floating point.
pub fn calculate_current_apy_from_index(
    previous_rate_index: u128,
    current_rate_index: u128,
    elapsed_seconds: i64,
) -> Result<u64> {
    require!(elapsed_seconds > 0, AnemoneError::InvalidElapsedTime);
    require!(previous_rate_index > 0, AnemoneError::InvalidRateIndex);
    require!(current_rate_index >= previous_rate_index, AnemoneError::InvalidRateIndex);

    const SECONDS_PER_YEAR: u128 = 31_536_000;
    const PRECISION: u128 = 1_000_000_000; // 10^9 for fixed-point math
    const BPS_SCALE: u128 = 10_000;

    // r = (current - previous) * PRECISION / previous
    // r is the rate delta scaled by 10^9
    let r = current_rate_index
        .checked_sub(previous_rate_index)
        .and_then(|diff| diff.checked_mul(PRECISION))
        .and_then(|scaled| scaled.checked_div(previous_rate_index))
        .ok_or(AnemoneError::MathOverflow)?;

    // n = SECONDS_PER_YEAR * PRECISION / elapsed_seconds
    // n is the annualization factor scaled by 10^9
    let n = SECONDS_PER_YEAR
        .checked_mul(PRECISION)
        .and_then(|scaled| scaled.checked_div(elapsed_seconds as u128))
        .ok_or(AnemoneError::MathOverflow)?;

    // Term 1: n * r / PRECISION
    let term1 = n
        .checked_mul(r)
        .and_then(|v| v.checked_div(PRECISION))
        .ok_or(AnemoneError::MathOverflow)?;

    // Term 2: n * (n - PRECISION) * r² / (2 * PRECISION³)
    let n_minus_1 = n.saturating_sub(PRECISION);
    let r_squared = r.checked_mul(r)
        .and_then(|v| v.checked_div(PRECISION))
        .ok_or(AnemoneError::MathOverflow)?;
    let term2 = n
        .checked_mul(n_minus_1)
        .and_then(|v| v.checked_div(PRECISION))
        .and_then(|v| v.checked_mul(r_squared))
        .and_then(|v| v.checked_div(PRECISION))
        .and_then(|v| v.checked_div(2))
        .ok_or(AnemoneError::MathOverflow)?;

    // Term 3: n * (n-1) * (n-2) * r³ / (6 * PRECISION⁵)
    let n_minus_2 = n.saturating_sub(2 * PRECISION);
    let r_cubed = r_squared.checked_mul(r)
        .and_then(|v| v.checked_div(PRECISION))
        .ok_or(AnemoneError::MathOverflow)?;
    let term3 = n
        .checked_mul(n_minus_1)
        .and_then(|v| v.checked_div(PRECISION))
        .and_then(|v| v.checked_mul(n_minus_2))
        .and_then(|v| v.checked_div(PRECISION))
        .and_then(|v| v.checked_mul(r_cubed))
        .and_then(|v| v.checked_div(PRECISION))
        .and_then(|v| v.checked_div(6))
        .ok_or(AnemoneError::MathOverflow)?;

    let apy_scaled = term1
        .checked_add(term2)
        .and_then(|v| v.checked_add(term3))
        .ok_or(AnemoneError::MathOverflow)?;

    let apy_bps = apy_scaled
        .checked_mul(BPS_SCALE)
        .and_then(|v| v.checked_div(PRECISION))
        .ok_or(AnemoneError::MathOverflow)?;

    Ok(apy_bps as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRECISION: u128 = 1_000_000_000;
    const SEVEN_DAYS: i64 = 604_800;
    const THIRTY_DAYS: i64 = 2_592_000;

    fn index(val: f64) -> u128 {
        (val * PRECISION as f64) as u128
    }

    #[test]
    fn calm_market_005_pct_in_7_days() {
        let result = calculate_current_apy_from_index(index(1.0), index(1.0005), SEVEN_DAYS).unwrap();
        assert!(result >= 257 && result <= 267, "Expected ~262 bps, got {} bps", result);
    }

    #[test]
    fn normal_market_02_pct_in_7_days() {
        let result = calculate_current_apy_from_index(index(1.0), index(1.002), SEVEN_DAYS).unwrap();
        assert!(result >= 1085 && result <= 1105, "Expected ~1095 bps, got {} bps", result);
    }

    #[test]
    fn hot_market_05_pct_in_7_days() {
        let result = calculate_current_apy_from_index(index(1.0), index(1.005), SEVEN_DAYS).unwrap();
        assert!(result >= 2930 && result <= 2980, "Expected ~2964 bps, got {} bps", result);
    }

    #[test]
    fn extreme_market_1_pct_in_7_days() {
        let result = calculate_current_apy_from_index(index(1.0), index(1.01), SEVEN_DAYS).unwrap();
        assert!(result >= 6750 && result <= 6850, "Expected ~6800 bps, got {} bps", result);
    }

    #[test]
    fn moderate_growth_1_pct_in_30_days() {
        let result = calculate_current_apy_from_index(index(1.0), index(1.01), THIRTY_DAYS).unwrap();
        assert!(result >= 1270 && result <= 1295, "Expected ~1281 bps, got {} bps", result);
    }

    #[test]
    fn zero_growth_returns_zero() {
        let result = calculate_current_apy_from_index(index(1.0), index(1.0), SEVEN_DAYS).unwrap();
        assert_eq!(result, 0, "Zero growth should return 0 bps");
    }

    #[test]
    fn rejects_zero_elapsed_time() {
        let result = calculate_current_apy_from_index(index(1.0), index(1.001), 0);
        assert!(result.is_err(), "Should reject zero elapsed time");
    }

    #[test]
    fn rejects_decreasing_rate_index() {
        let result = calculate_current_apy_from_index(index(1.01), index(1.0), SEVEN_DAYS);
        assert!(result.is_err(), "Should reject decreasing rate index");
    }
}
