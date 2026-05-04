/**
 * Sanity tests for the off-chain margin math. Numbers must match the Rust
 * `calculate_initial_margin` / `calculate_maintenance_margin` helpers;
 * otherwise the liquidation job will misfire.
 *
 * Run with: npx ts-node src/utils/margin.test.ts
 */
import { calculateInitialMargin, calculateMaintenanceMargin } from "./margin";

let failures = 0;

function expect(label: string, actual: bigint, min: bigint, max: bigint) {
  if (actual < min || actual > max) {
    console.error(`FAIL ${label}: expected ${min}..${max}, got ${actual}`);
    failures++;
  } else {
    console.log(`ok   ${label}: ${actual}`);
  }
}

// Mirror test cases from programs/anemone/src/helpers/spread.rs tests.
// $10_000 USDC (6 decimals) = 10_000_000_000

const NOTIONAL_10K = 10_000_000_000n;

// 7 days → ~$57.5 initial margin
expect(
  "IM 10k / 7d",
  calculateInitialMargin(NOTIONAL_10K, 7n * 86_400n),
  56_000_000n,
  59_000_000n,
);

// 30 days → ~$246 initial margin
expect(
  "IM 10k / 30d",
  calculateInitialMargin(NOTIONAL_10K, 30n * 86_400n),
  245_000_000n,
  248_000_000n,
);

// 100k / 90 days → ~$7_397
expect(
  "IM 100k / 90d",
  calculateInitialMargin(100_000_000_000n, 90n * 86_400n),
  7_350_000_000n,
  7_450_000_000n,
);

// MM = 60% of IM
const im30 = calculateInitialMargin(NOTIONAL_10K, 30n * 86_400n);
const mm30 = calculateMaintenanceMargin(NOTIONAL_10K, 30n * 86_400n);
expect("MM = 60% IM (10k / 30d)", mm30, (im30 * 60n) / 100n, (im30 * 60n) / 100n);

// Minimum margin of 1
expect("IM minimum 1", calculateInitialMargin(1n, 86_400n), 1n, 1n);

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("all margin tests passed");
}
