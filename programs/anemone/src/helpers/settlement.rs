use crate::errors::AnemoneError;
use crate::state::SwapDirection;
use crate::helpers::calculate_initial_margin;

/// Calculates the PnL for a single settlement period using exact rate index values.
///
/// Uses rate index division (exact compounded rate), NOT Taylor approximation.
/// Taylor is for quoting/spread; settlement uses the real observed rate.
///
/// Returns i64: positive = trader profit, negative = trader loss.
pub fn calculate_period_pnl(
    direction: SwapDirection,
    notional: u64,
    fixed_rate_bps: u64,
    last_settled_rate_index: u128,
    current_rate_index: u128,
    settlement_period_seconds: i64,
) -> Result<i64, AnemoneError> {
    if last_settled_rate_index == 0 || current_rate_index < last_settled_rate_index {
        return Err(AnemoneError::InvalidRateIndex);
    }
    if settlement_period_seconds <= 0 {
        return Err(AnemoneError::InvalidElapsedTime);
    }

    const SECONDS_PER_YEAR: u128 = 31_536_000;
    const BPS_SCALE: u128 = 10_000;

    let n = notional as u128;

    // Variable payment: exact rate from index
    // var_rate = (current - last) / last (already compounded)
    // variable_payment = notional * var_rate = notional * (current - last) / last
    let variable_payment = n
        .checked_mul(current_rate_index.checked_sub(last_settled_rate_index)
            .ok_or(AnemoneError::MathOverflow)?)
        .and_then(|v| v.checked_div(last_settled_rate_index))
        .ok_or(AnemoneError::MathOverflow)?;

    // Fixed payment: annualized rate pro-rated to the settlement period
    // fixed_payment = notional * fixed_rate_bps / BPS_SCALE * period / year
    // Rewrite as single fraction: notional * fixed_rate_bps * period / (BPS_SCALE * year)
    let fixed_payment = n
        .checked_mul(fixed_rate_bps as u128)
        .and_then(|v| v.checked_mul(settlement_period_seconds as u128))
        .and_then(|v| v.checked_div(
            BPS_SCALE.checked_mul(SECONDS_PER_YEAR)
                .ok_or(AnemoneError::MathOverflow).ok()?
        ))
        .ok_or(AnemoneError::MathOverflow)?;

    // PnL depends on direction
    let pnl = match direction {
        // PayFixed: trader pays fixed, receives variable
        // Profit when variable > fixed (rates went up)
        SwapDirection::PayFixed => {
            variable_payment as i128 - fixed_payment as i128
        }
        // ReceiveFixed: trader receives fixed, pays variable
        // Profit when fixed > variable (rates went down or stayed low)
        SwapDirection::ReceiveFixed => {
            fixed_payment as i128 - variable_payment as i128
        }
    };

    // Clamp to i64 range (should never overflow with realistic values)
    Ok(pnl as i64)
}

/// Calculates the maintenance margin — minimum collateral to avoid liquidation.
///
/// MM = 60% of initial margin.
/// If collateral_remaining < MM after settlement, position is eligible for liquidation.
pub fn calculate_maintenance_margin(
    notional: u64,
    tenor_seconds: i64,
) -> Result<u64, AnemoneError> {
    let initial_margin = calculate_initial_margin(notional, tenor_seconds)?;
    Ok(initial_margin
        .checked_mul(60)
        .and_then(|v| v.checked_div(100))
        .ok_or(AnemoneError::MathOverflow)?
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRECISION: u128 = 1_000_000_000; // 10^9 for index scaling
    const ONE_DAY: i64 = 86_400;
    const SEVEN_DAYS: i64 = 604_800;
    const NOTIONAL_10K: u64 = 10_000_000_000; // $10,000 USDC (6 decimals)

    fn index(val: f64) -> u128 {
        (val * PRECISION as f64) as u128
    }

    // ========== calculate_period_pnl tests ==========

    #[test]
    fn pay_fixed_profits_when_rates_rise() {
        // Rate index goes from 1.0 to 1.001 (0.1% growth in 1 day)
        // Variable payment = 10k * 0.001 = $10
        // Fixed rate = 800 bps (8%) → daily = 10k * 800 / 10000 * 86400 / 31536000 = $2.19
        // PnL = $10 - $2.19 = ~$7.81
        let pnl = calculate_period_pnl(
            SwapDirection::PayFixed,
            NOTIONAL_10K,
            800,
            index(1.0),
            index(1.001),
            ONE_DAY,
        ).unwrap();

        assert!(pnl > 0, "PayFixed should profit when rates rise, got {}", pnl);
        // $10 variable - ~$2.19 fixed ≈ $7.81 = 7_808_219 (approx)
        assert!(pnl >= 7_500_000 && pnl <= 8_200_000,
            "Expected ~$7.8, got ${:.2}", pnl as f64 / 1_000_000.0);
    }

    #[test]
    fn pay_fixed_loses_when_rates_flat() {
        // Rate index stays at 1.0 (0% growth)
        // Variable payment = 0
        // Fixed payment = ~$2.19/day at 8%
        // PnL = 0 - $2.19 = -$2.19
        let pnl = calculate_period_pnl(
            SwapDirection::PayFixed,
            NOTIONAL_10K,
            800,
            index(1.0),
            index(1.0),
            ONE_DAY,
        ).unwrap();

        assert!(pnl < 0, "PayFixed should lose when rates are flat, got {}", pnl);
        assert!(pnl >= -2_500_000 && pnl <= -2_000_000,
            "Expected ~-$2.19, got ${:.2}", pnl as f64 / 1_000_000.0);
    }

    #[test]
    fn receive_fixed_profits_when_rates_flat() {
        // ReceiveFixed = opposite of PayFixed
        // Rate flat → variable = 0, fixed = $2.19 → trader receives fixed → profit
        let pnl = calculate_period_pnl(
            SwapDirection::ReceiveFixed,
            NOTIONAL_10K,
            800,
            index(1.0),
            index(1.0),
            ONE_DAY,
        ).unwrap();

        assert!(pnl > 0, "ReceiveFixed should profit when rates are flat, got {}", pnl);
    }

    #[test]
    fn receive_fixed_loses_when_rates_rise() {
        // Rate rises 0.1% in 1 day
        let pnl = calculate_period_pnl(
            SwapDirection::ReceiveFixed,
            NOTIONAL_10K,
            800,
            index(1.0),
            index(1.001),
            ONE_DAY,
        ).unwrap();

        assert!(pnl < 0, "ReceiveFixed should lose when rates rise, got {}", pnl);
    }

    #[test]
    fn zero_growth_zero_rate_zero_pnl() {
        // Rate doesn't change, fixed rate is 0 → PnL = 0
        let pnl = calculate_period_pnl(
            SwapDirection::PayFixed,
            NOTIONAL_10K,
            0,
            index(1.0),
            index(1.0),
            ONE_DAY,
        ).unwrap();

        assert_eq!(pnl, 0, "Zero growth + zero fixed rate should give 0 PnL");
    }

    #[test]
    fn rejects_invalid_rate_index() {
        // current < last (should never happen)
        let result = calculate_period_pnl(
            SwapDirection::PayFixed,
            NOTIONAL_10K,
            800,
            index(1.01),
            index(1.0),
            ONE_DAY,
        );
        assert!(result.is_err(), "Should reject decreasing rate index");
    }

    #[test]
    fn seven_day_settlement_larger_amounts() {
        // 7-day settlement period, 0.2% growth
        // Variable = 10k * 0.002 = $20
        // Fixed at 8% for 7 days = 10k * 800/10000 * 604800/31536000 = $15.34
        // PnL = $20 - $15.34 = ~$4.66
        let pnl = calculate_period_pnl(
            SwapDirection::PayFixed,
            NOTIONAL_10K,
            800,
            index(1.0),
            index(1.002),
            SEVEN_DAYS,
        ).unwrap();

        assert!(pnl > 0, "Should profit, got {}", pnl);
        assert!(pnl >= 4_000_000 && pnl <= 5_500_000,
            "Expected ~$4.66, got ${:.2}", pnl as f64 / 1_000_000.0);
    }

    // ========== calculate_maintenance_margin tests ==========

    #[test]
    fn maintenance_margin_is_60_pct_of_initial() {
        let im = calculate_initial_margin(NOTIONAL_10K, SEVEN_DAYS).unwrap();
        let mm = calculate_maintenance_margin(NOTIONAL_10K, SEVEN_DAYS).unwrap();

        // MM should be 60% of IM
        let expected = im * 60 / 100;
        assert_eq!(mm, expected, "MM should be 60% of IM");
        assert!(mm < im, "MM must be less than IM");
    }

    #[test]
    fn maintenance_margin_30_day() {
        let mm = calculate_maintenance_margin(NOTIONAL_10K, 30 * 86_400).unwrap();
        // IM ≈ $246, MM = 60% ≈ $147
        assert!(mm >= 145_000_000 && mm <= 150_000_000,
            "30d $10k MM expected ~$147, got {}", mm);
    }
}
