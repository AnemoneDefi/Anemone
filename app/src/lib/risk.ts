/**
 * Client-side ports of the Rust spread + margin helpers used by the program.
 * These are quotes for the UI; the program re-computes everything on-chain
 * before opening a swap, so the worst case here is a stale preview that the
 * user can see refresh on resubmit.
 *
 * Sources mirrored:
 *   - programs/anemone/src/helpers/spread.rs::calculate_spread_components
 *   - programs/anemone/src/helpers/spread.rs::effective_spread_bps
 *   - programs/anemone/src/helpers/spread.rs::calculate_initial_margin
 *   - programs/anemone/src/helpers/settlement.rs::calculate_maintenance_margin
 */

import { SwapDirection } from "@anemonedefi/sdk";

const SECONDS_PER_YEAR = 31_536_000n;
const BPS = 10_000n;
const MAX_RATE_MOVE_BPS = 2_000n; // 20% max adverse rate move (Rust constant)
const SAFETY_FACTOR_X10K = 15_000n; // 1.5x (Rust constant)
const MM_NUM = 60n;
const MM_DEN = 100n;

/** Skew sensitivity coefficient — mirrors `SKEW_K_BPS` in spread.rs. */
const SKEW_K_BPS = 200n;

export interface SpreadBreakdown {
  /**
   * Effective spread between offered fixed rate and current_apy_bps for the
   * caller's direction. Always >= base_spread_bps (the LP earnings floor).
   */
  totalBps: bigint;
  /** Static base spread set at market creation. */
  baseBps: bigint;
  /** Utilization-driven component (scales linearly to baseBps at max util). */
  utilizationBps: bigint;
  /**
   * Signed midpoint shift driven by directional imbalance. Positive when
   * fixed dominates, negative when variable dominates. Applied with the
   * SAME sign in both directions — it shifts the quoted midpoint, not the
   * bilateral spread (AMM-style).
   */
  skewBps: bigint;
  /** Resulting utilization in bps (informational). */
  utilizationLevelBps: bigint;
}

/**
 * Mirrors `calculate_spread_components` + `effective_spread_bps`
 * (programs/anemone/src/helpers/spread.rs). Returns the per-direction
 * effective spread plus the breakdown for the UI.
 */
export function calculateSpread(
  baseSpreadBps: number,
  maxUtilizationBps: number,
  lpNav: bigint,
  totalFixedNotional: bigint,
  totalVariableNotional: bigint,
  direction: SwapDirection
): SpreadBreakdown {
  const base = BigInt(baseSpreadBps);
  const maxUtil = BigInt(maxUtilizationBps);

  if (lpNav === 0n) {
    return {
      totalBps: base,
      baseBps: base,
      utilizationBps: 0n,
      skewBps: 0n,
      utilizationLevelBps: 0n,
    };
  }

  const total = totalFixedNotional + totalVariableNotional;
  const utilizationLevelBps = (total * BPS) / lpNav;
  const cappedUtil = utilizationLevelBps > maxUtil ? maxUtil : utilizationLevelBps;
  const utilizationBps = maxUtil === 0n ? 0n : (base * cappedUtil) / maxUtil;

  // Signed imbalance (positive when fixed dominates).
  const imbalance = totalFixedNotional - totalVariableNotional;
  const skewBps = (imbalance * SKEW_K_BPS) / lpNav;

  const basePlusUtil = base + utilizationBps;
  // Direction-aware effective spread; clamp at base_spread_bps as LP floor.
  const raw =
    direction === SwapDirection.PayFixed
      ? basePlusUtil + skewBps
      : basePlusUtil - skewBps;
  const totalBps = raw < base ? base : raw;

  return {
    totalBps,
    baseBps: base,
    utilizationBps,
    skewBps,
    utilizationLevelBps,
  };
}

/**
 * Spread including the impact of a hypothetical new swap (open_swap quotes
 * with the new notional already added to the matching side).
 */
export function calculateSpreadWithNewSwap(
  baseSpreadBps: number,
  maxUtilizationBps: number,
  lpNav: bigint,
  totalFixedNotional: bigint,
  totalVariableNotional: bigint,
  direction: SwapDirection,
  newNotional: bigint
): SpreadBreakdown {
  const fixed =
    direction === SwapDirection.PayFixed
      ? totalFixedNotional + newNotional
      : totalFixedNotional;
  const variable =
    direction === SwapDirection.ReceiveFixed
      ? totalVariableNotional + newNotional
      : totalVariableNotional;
  return calculateSpread(
    baseSpreadBps,
    maxUtilizationBps,
    lpNav,
    fixed,
    variable,
    direction
  );
}

/** Mirrors `calculate_initial_margin` — collateral the program will lock. */
export function calculateInitialMargin(
  notional: bigint,
  tenorSeconds: bigint
): bigint {
  if (notional <= 0n || tenorSeconds <= 0n) return 1n;
  const numerator = notional * MAX_RATE_MOVE_BPS * tenorSeconds * SAFETY_FACTOR_X10K;
  const denominator = BPS * SECONDS_PER_YEAR * BPS;
  const margin = numerator / denominator;
  return margin > 0n ? margin : 1n;
}

/** Mirrors `calculate_maintenance_margin` — 60% of initial margin. */
export function calculateMaintenanceMargin(
  notional: bigint,
  tenorSeconds: bigint
): bigint {
  return (calculateInitialMargin(notional, tenorSeconds) * MM_NUM) / MM_DEN;
}

/**
 * Effective leverage = notional / initial_margin. Useful for "safe" framing
 * (smaller is safer) when notional is the user's input.
 */
export function effectiveLeverage(
  notional: bigint,
  tenorSeconds: bigint
): number {
  const margin = calculateInitialMargin(notional, tenorSeconds);
  if (margin === 0n) return 0;
  // Convert via integer-scaled ratio to keep precision for small notionals.
  const SCALE = 1_000_000n;
  return Number((notional * SCALE) / margin) / Number(SCALE);
}

export function openingFee(notional: bigint, openingFeeBps: number): bigint {
  return (notional * BigInt(openingFeeBps)) / BPS;
}

/**
 * Mirrors `helpers/settlement.rs::calculate_period_pnl`. Used for unrealized
 * PnL preview between settlements.
 *
 * Returns signed bigint: positive = trader profit, negative = trader loss.
 * Returns 0n on degenerate inputs (zero elapsed, missing index, etc.) instead
 * of throwing — quotes should fall back gracefully.
 */
export function calculateUnrealizedPnl(
  direction: SwapDirection,
  notional: bigint,
  fixedRateBps: bigint,
  lastSettledRateIndex: bigint,
  currentRateIndex: bigint,
  elapsedSeconds: bigint
): bigint {
  if (
    notional <= 0n ||
    elapsedSeconds <= 0n ||
    lastSettledRateIndex <= 0n ||
    currentRateIndex < lastSettledRateIndex
  ) {
    return 0n;
  }

  const variablePayment =
    (notional * (currentRateIndex - lastSettledRateIndex)) / lastSettledRateIndex;
  const fixedPayment =
    (notional * fixedRateBps * elapsedSeconds) / (BPS * SECONDS_PER_YEAR);

  return direction === SwapDirection.PayFixed
    ? variablePayment - fixedPayment
    : fixedPayment - variablePayment;
}
