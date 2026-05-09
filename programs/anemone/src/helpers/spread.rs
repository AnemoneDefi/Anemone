use crate::errors::AnemoneError;
use crate::state::SwapDirection;

/// Skew sensitivity coefficient. At full directional imbalance
/// (|N_fixed - N_variable| == lp_nav), the skew shifts the midpoint by this
/// many basis points. Tunable per-market in v0.2; v0.1 ships with a
/// program-wide constant.
pub const SKEW_K_BPS: i128 = 200;

/// Returns the symmetric and skew components of the quoted spread.
///
/// - `base_plus_util_bps`: positive — base spread plus utilization premium.
///   Applied symmetrically (PayFixed adds it above APY, ReceiveFixed
///   subtracts it below APY). Always paid by the trader, always earned by LP.
/// - `skew_bps_signed`: signed — positive when fixed dominates, negative
///   when variable dominates. Applied with the SAME sign in both directions
///   (it is a midpoint shift, not a bilateral spread). This shifts the
///   quoted rates so the dominant side pays more and the rebalancing side
///   gets a relative discount.
pub fn calculate_spread_components(
    base_spread_bps: u16,
    max_utilization_bps: u16,
    lp_nav: u64,
    total_fixed_notional: u64,
    total_variable_notional: u64,
) -> Result<(u64, i64), AnemoneError> {
    if lp_nav == 0 {
        return Ok((base_spread_bps as u64, 0));
    }

    let base = base_spread_bps as u128;
    let max_util = max_utilization_bps as u128;
    let deposits = lp_nav as u128;

    let total_notional = (total_fixed_notional as u128)
        .checked_add(total_variable_notional as u128)
        .ok_or(AnemoneError::MathOverflow)?;

    let utilization_bps = total_notional
        .checked_mul(10_000)
        .and_then(|v| v.checked_div(deposits))
        .ok_or(AnemoneError::MathOverflow)?;

    let capped_util = utilization_bps.min(max_util);
    let s_util = if max_util == 0 {
        0u128
    } else {
        base.checked_mul(capped_util)
            .and_then(|v| v.checked_div(max_util))
            .ok_or(AnemoneError::MathOverflow)?
    };

    let base_plus_util = base
        .checked_add(s_util)
        .ok_or(AnemoneError::MathOverflow)?;
    let base_plus_util_u64 = u64::try_from(base_plus_util)
        .map_err(|_| AnemoneError::MathOverflow)?;

    let n_fixed = total_fixed_notional as i128;
    let n_variable = total_variable_notional as i128;
    let imbalance = n_fixed
        .checked_sub(n_variable)
        .ok_or(AnemoneError::MathOverflow)?;
    let skew = imbalance
        .checked_mul(SKEW_K_BPS)
        .and_then(|v| v.checked_div(deposits as i128))
        .ok_or(AnemoneError::MathOverflow)?;
    let skew_i64 = i64::try_from(skew).map_err(|_| AnemoneError::MathOverflow)?;

    Ok((base_plus_util_u64, skew_i64))
}

/// Per-direction effective spread `bps` between the offered fixed rate and
/// `current_apy_bps`. Always >= `base_spread_bps` (LP earnings floor) — the
/// floor caps the rebalancing discount in extreme imbalance so the LP is
/// never asked to give up its base premium.
pub fn effective_spread_bps(
    base_plus_util_bps: u64,
    skew_bps: i64,
    direction: SwapDirection,
    base_spread_bps: u16,
) -> Result<u64, AnemoneError> {
    // PayFixed quote = APY + base_plus_util + skew → effective spread = base_plus_util + skew
    // ReceiveFixed quote = APY - base_plus_util + skew → effective spread = base_plus_util - skew
    let raw: i128 = match direction {
        SwapDirection::PayFixed => (base_plus_util_bps as i128) + (skew_bps as i128),
        SwapDirection::ReceiveFixed => (base_plus_util_bps as i128) - (skew_bps as i128),
    };
    let floor = base_spread_bps as i128;
    let clamped = raw.max(floor);
    u64::try_from(clamped).map_err(|_| AnemoneError::MathOverflow)
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

    // ========== calculate_spread_components tests ==========

    #[test]
    fn components_balanced_no_utilization() {
        let (bpu, skew) = calculate_spread_components(80, 6000, 1_000_000, 0, 0).unwrap();
        assert_eq!(bpu, 80, "Empty pool: base_plus_util = base");
        assert_eq!(skew, 0, "Empty pool: skew = 0");
    }

    #[test]
    fn components_balanced_half_utilization() {
        // 30% utilization (half of 60% max), balanced
        let (bpu, skew) = calculate_spread_components(80, 6000, 1_000_000, 150_000, 150_000).unwrap();
        assert_eq!(bpu, 120, "50% of max util → base(80) + util(40) = 120");
        assert_eq!(skew, 0, "Balanced → skew = 0");
    }

    #[test]
    fn components_fixed_dominant() {
        // 20% utilization, fully PayFixed (200_000 fixed, 0 variable, 1M lp_nav)
        // skew = (200_000 - 0) * 200 / 1_000_000 = 40 bps
        let (bpu, skew) = calculate_spread_components(80, 6000, 1_000_000, 200_000, 0).unwrap();
        assert_eq!(bpu, 106, "20% util → base(80) + util(26) = 106");
        assert_eq!(skew, 40, "Fixed dominant → skew = +40 bps");
    }

    #[test]
    fn components_variable_dominant() {
        let (bpu, skew) = calculate_spread_components(80, 6000, 1_000_000, 0, 200_000).unwrap();
        assert_eq!(bpu, 106, "20% util → base(80) + util(26) = 106");
        assert_eq!(skew, -40, "Variable dominant → skew = -40 bps");
    }

    #[test]
    fn components_zero_deposits_returns_base() {
        let (bpu, skew) = calculate_spread_components(80, 6000, 0, 0, 0).unwrap();
        assert_eq!(bpu, 80);
        assert_eq!(skew, 0);
    }

    // ========== effective_spread_bps tests ==========

    #[test]
    fn effective_spread_payfixed_dominant_charges_more() {
        // skew=+40, bpu=106 → PayFixed effective = 106 + 40 = 146
        let s = effective_spread_bps(106, 40, SwapDirection::PayFixed, 80).unwrap();
        assert_eq!(s, 146);
    }

    #[test]
    fn effective_spread_receivefixed_into_imbalance_gets_discount() {
        // Fixed dominant (skew=+40), ReceiveFixed rebalances:
        // RF effective = 106 - 40 = 66 → clamped to floor 80
        let s = effective_spread_bps(106, 40, SwapDirection::ReceiveFixed, 80).unwrap();
        assert_eq!(s, 80, "Floor enforces LP earns at least base_spread");
    }

    #[test]
    fn effective_spread_receivefixed_no_clamp_when_mild() {
        // Mild imbalance: bpu=200, skew=+50, RF = 200 - 50 = 150 (above floor 80)
        let s = effective_spread_bps(200, 50, SwapDirection::ReceiveFixed, 80).unwrap();
        assert_eq!(s, 150, "Mild imbalance: rebalancing trader gets reduced spread, no clamp");
    }

    #[test]
    fn effective_spread_payfixed_into_variable_dominant_gets_discount() {
        // Variable dominant (skew=-40), PayFixed rebalances:
        // PF effective = 106 - 40 = 66 → clamped to floor 80
        let s = effective_spread_bps(106, -40, SwapDirection::PayFixed, 80).unwrap();
        assert_eq!(s, 80);
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
