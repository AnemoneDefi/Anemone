// Mirror of `helpers/spread.rs::calculate_initial_margin` +
// `helpers/settlement.rs::calculate_maintenance_margin`.
// Used off-chain so the liquidation job can decide whether a position is
// below maintenance margin without doing an on-chain dry-run.

const MAX_RATE_MOVE_BPS = 2_000n; // 20% max rate move
const SAFETY_FACTOR_X10K = 15_000n; // 1.5x
const BPS_PRECISION = 10_000n;
const SECONDS_PER_YEAR = 31_536_000n;

export function calculateInitialMargin(
  notional: bigint,
  tenorSeconds: bigint,
): bigint {
  const numerator =
    notional * MAX_RATE_MOVE_BPS * tenorSeconds * SAFETY_FACTOR_X10K;
  const denominator = BPS_PRECISION * SECONDS_PER_YEAR * BPS_PRECISION;
  const margin = numerator / denominator;
  return margin > 0n ? margin : 1n;
}

export function calculateMaintenanceMargin(
  notional: bigint,
  tenorSeconds: bigint,
): bigint {
  return (calculateInitialMargin(notional, tenorSeconds) * 60n) / 100n;
}
