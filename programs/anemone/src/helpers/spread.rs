use crate::errors::AnemoneError;

/// Calculates the total spread in basis points for pricing a swap.
///
/// S_total = S_base + S_util + S_imbal
///
/// - S_base: fixed base spread (e.g. 80 bps = 0.8%)
/// - S_util: utilization-driven spread, scales linearly from 0 to S_base at max utilization
/// - S_imbal: directional imbalance spread, penalizes one-sided markets
pub fn calculate_spread_bps(
    base_spread_bps: u16,
    max_utilization_bps: u16,
    lp_nav: u64,
    total_fixed_notional: u64,
    total_variable_notional: u64,
    pending_withdrawals: u64,
) -> Result<u64, AnemoneError> {
    if lp_nav == 0 {
        return Ok(base_spread_bps as u64);
    }

    let base = base_spread_bps as u128;
    let max_util = max_utilization_bps as u128;
    let deposits = lp_nav as u128;

    // Utilization = (total_notional + pending_withdrawals) / lp_nav
    let total_notional = (total_fixed_notional as u128)
        .checked_add(total_variable_notional as u128)
        .and_then(|v| v.checked_add(pending_withdrawals as u128))
        .ok_or(AnemoneError::MathOverflow)?;

    // utilization_bps = total_notional * 10_000 / deposits
    let utilization_bps = total_notional
        .checked_mul(10_000)
        .and_then(|v| v.checked_div(deposits))
        .ok_or(AnemoneError::MathOverflow)?;

    // S_util = base_spread * utilization / max_utilization
    // Caps at max_utilization to avoid runaway spread
    let capped_util = utilization_bps.min(max_util);
    let s_util = base
        .checked_mul(capped_util)
        .and_then(|v| v.checked_div(max_util))
        .ok_or(AnemoneError::MathOverflow)?;

    // S_imbal = |N_fixed - N_variable| * 100 / lp_nav
    // 100 bps (1%) at full imbalance ratio of 1.0
    let imbalance = if total_fixed_notional >= total_variable_notional {
        (total_fixed_notional - total_variable_notional) as u128
    } else {
        (total_variable_notional - total_fixed_notional) as u128
    };

    let s_imbal = imbalance
        .checked_mul(100)
        .and_then(|v| v.checked_div(deposits))
        .ok_or(AnemoneError::MathOverflow)?;

    let s_total = base
        .checked_add(s_util)
        .and_then(|v| v.checked_add(s_imbal))
        .ok_or(AnemoneError::MathOverflow)?;

    Ok(s_total as u64)
}

/// Calculates the initial margin (collateral) required to open a swap position.
///
/// IM = notional * MAX_RATE_MOVE * (tenor / year) * SAFETY_FACTOR
///
/// All math in u128 to avoid overflow with large notionals.
pub fn calculate_initial_margin(
    notional: u64,
    tenor_seconds: i64,
) -> Result<u64, AnemoneError> {
    const MAX_RATE_MOVE_BPS: u128 = 2_000;   // 20% max adverse rate move
    const SAFETY_FACTOR_X10K: u128 = 15_000;  // 1.5x
    const BPS_PRECISION: u128 = 10_000;
    const SECONDS_PER_YEAR: u128 = 31_536_000;

    let n = notional as u128;
    let tenor = tenor_seconds as u128;

    // IM = notional * 2000/10000 * tenor/31536000 * 15000/10000
    // Rewrite to single fraction to minimize rounding:
    // IM = notional * 2000 * tenor * 15000 / (10000 * 31536000 * 10000)
    let numerator = n
        .checked_mul(MAX_RATE_MOVE_BPS)
        .and_then(|v| v.checked_mul(tenor))
        .and_then(|v| v.checked_mul(SAFETY_FACTOR_X10K))
        .ok_or(AnemoneError::MathOverflow)?;

    let denominator = BPS_PRECISION
        .checked_mul(SECONDS_PER_YEAR)
        .and_then(|v| v.checked_mul(BPS_PRECISION))
        .ok_or(AnemoneError::MathOverflow)?;

    let margin = numerator
        .checked_div(denominator)
        .ok_or(AnemoneError::MathOverflow)?;

    // Minimum margin of 1 token unit to prevent zero-collateral positions
    Ok(margin.max(1) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ========== calculate_spread_bps tests ==========

    #[test]
    fn base_spread_only_no_utilization() {
        // No positions open → S_total = S_base only
        let result = calculate_spread_bps(80, 6000, 1_000_000, 0, 0, 0).unwrap();
        assert_eq!(result, 80, "Empty pool should return base spread");
    }

    #[test]
    fn half_utilization_no_imbalance() {
        // 30% utilization (half of 60% max), balanced
        // S_base = 80, S_util = 80 * 3000/6000 = 40, S_imbal = 0
        let result = calculate_spread_bps(80, 6000, 1_000_000, 150_000, 150_000, 0).unwrap();
        assert_eq!(result, 120, "50% of max util → S_base(80) + S_util(40) = 120");
    }

    #[test]
    fn max_utilization_no_imbalance() {
        // 60% utilization (at max), balanced
        // S_base = 80, S_util = 80, S_imbal = 0
        let result = calculate_spread_bps(80, 6000, 1_000_000, 300_000, 300_000, 0).unwrap();
        assert_eq!(result, 160, "Max util → S_base(80) + S_util(80) = 160");
    }

    #[test]
    fn imbalanced_market() {
        // 20% utilization, fully one-sided (all PayFixed, no ReceiveFixed)
        // S_base = 80, S_util = 80 * 2000/6000 = 26, S_imbal = 200_000 * 100 / 1_000_000 = 20
        let result = calculate_spread_bps(80, 6000, 1_000_000, 200_000, 0, 0).unwrap();
        assert_eq!(result, 126, "Imbalanced: S_base(80) + S_util(26) + S_imbal(20) = 126");
    }

    #[test]
    fn heavily_imbalanced_hot_market() {
        // 50% utilization, all one side
        // S_util = 80 * 5000/6000 = 66, S_imbal = 500_000 * 100 / 1_000_000 = 50
        let result = calculate_spread_bps(80, 6000, 1_000_000, 500_000, 0, 0).unwrap();
        assert_eq!(result, 196, "Hot imbalanced: S_base(80) + S_util(66) + S_imbal(50) = 196");
    }

    #[test]
    fn zero_deposits_returns_base() {
        let result = calculate_spread_bps(80, 6000, 0, 0, 0, 0).unwrap();
        assert_eq!(result, 80, "Zero deposits should return base spread");
    }

    #[test]
    fn pending_withdrawals_increase_utilization() {
        // 100k notional + 100k pending = 200k effective / 1M deposits = 20% util
        // vs 100k notional alone = 10% util
        let with_pending = calculate_spread_bps(80, 6000, 1_000_000, 50_000, 50_000, 100_000).unwrap();
        let without_pending = calculate_spread_bps(80, 6000, 1_000_000, 50_000, 50_000, 0).unwrap();
        assert!(with_pending > without_pending, "Pending withdrawals should widen spread");
    }

    // ========== calculate_initial_margin tests ==========

    #[test]
    fn margin_30_day_10k_notional() {
        // $10,000 USDC (6 decimals) = 10_000_000_000
        // IM = 10B * 0.20 * (30*86400/31536000) * 1.5 = ~246_575_342
        let notional = 10_000_000_000u64; // $10,000
        let tenor = 30 * 86_400i64;       // 30 days
        let result = calculate_initial_margin(notional, tenor).unwrap();
        // Expected: ~246_575_342 ($246.58)
        assert!(result >= 245_000_000 && result <= 248_000_000,
            "30d $10k margin expected ~$246, got {}", result);
    }

    #[test]
    fn margin_7_day_10k_notional() {
        // IM = 10B * 0.20 * (7/365) * 1.5 = ~57_534_246
        let notional = 10_000_000_000u64;
        let tenor = 7 * 86_400i64;
        let result = calculate_initial_margin(notional, tenor).unwrap();
        assert!(result >= 56_000_000 && result <= 59_000_000,
            "7d $10k margin expected ~$57.5, got {}", result);
    }

    #[test]
    fn margin_90_day_100k_notional() {
        // $100,000 USDC = 100_000_000_000
        // IM = 100B * 0.20 * (90/365) * 1.5 = ~7_397_260_274
        let notional = 100_000_000_000u64;
        let tenor = 90 * 86_400i64;
        let result = calculate_initial_margin(notional, tenor).unwrap();
        assert!(result >= 7_350_000_000 && result <= 7_450_000_000,
            "90d $100k margin expected ~$7,397, got {}", result);
    }

    #[test]
    fn margin_minimum_is_1() {
        // Very small notional should still return at least 1
        let result = calculate_initial_margin(1, 86_400).unwrap();
        assert_eq!(result, 1, "Minimum margin should be 1");
    }
}
