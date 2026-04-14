use anchor_lang::prelude::*;
use kamino_lend::state::Reserve;
use crate::errors::AnemoneError;

/// Reads the cumulative borrow rate index from a Kamino Reserve account.
/// Returns the rate index as u128 (scaled fraction, first 128 bits of the 256-bit value).
pub fn read_kamino_rate_index(reserve_loader: &AccountLoader<Reserve>) -> Result<u128> {
    let reserve = reserve_loader.load()?;
    let bsf = &reserve.liquidity.cumulative_borrow_rate_bsf;

    // BigFractionBytes.value is [u64; 4] representing a 256-bit number in little-endian.
    // We take the lower 128 bits (value[0] and value[1]) which gives us
    // the rate index with sufficient precision for our calculations.
    let lower = bsf.value[0] as u128;
    let upper = (bsf.value[1] as u128) << 64;

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
    // Simplified: (n * (n - PRECISION) / PRECISION) * (r * r / PRECISION) / (2 * PRECISION)
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
    // Simplified step by step to avoid overflow
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

    // APY = term1 + term2 + term3 (all scaled by PRECISION)
    // Convert to basis points: * BPS_SCALE / PRECISION
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
        // 0.05% growth in 7 days → expected ~2.62% APY (262 bps)
        let result = calculate_current_apy_from_index(index(1.0), index(1.0005), SEVEN_DAYS).unwrap();
        assert!(result >= 257 && result <= 267, "Expected ~262 bps, got {} bps", result);
    }

    #[test]
    fn normal_market_02_pct_in_7_days() {
        // 0.2% growth in 7 days → expected ~10.95% APY (1095 bps)
        let result = calculate_current_apy_from_index(index(1.0), index(1.002), SEVEN_DAYS).unwrap();
        assert!(result >= 1085 && result <= 1105, "Expected ~1095 bps, got {} bps", result);
    }

    #[test]
    fn hot_market_05_pct_in_7_days() {
        // 0.5% growth in 7 days → expected ~29.64% APY (2964 bps)
        let result = calculate_current_apy_from_index(index(1.0), index(1.005), SEVEN_DAYS).unwrap();
        assert!(result >= 2930 && result <= 2980, "Expected ~2964 bps, got {} bps", result);
    }

    #[test]
    fn extreme_market_1_pct_in_7_days() {
        // 1% growth in 7 days → expected ~68.00% APY (6800 bps)
        let result = calculate_current_apy_from_index(index(1.0), index(1.01), SEVEN_DAYS).unwrap();
        assert!(result >= 6750 && result <= 6850, "Expected ~6800 bps, got {} bps", result);
    }

    #[test]
    fn moderate_growth_1_pct_in_30_days() {
        // 1% growth in 30 days → expected ~12.81% APY (1281 bps)
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

