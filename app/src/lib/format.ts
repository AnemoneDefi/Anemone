const USDC_DECIMALS = 6n;
const USDC_DIVISOR = 10n ** USDC_DECIMALS;

const BPS_SCALE = 10_000n;
const PRECISION = 1_000_000_000n;
const SECONDS_PER_YEAR = 31_536_000n;

export function formatUsdc(
  lamports: bigint,
  opts: { withSymbol?: boolean; maxFractionDigits?: number } = {}
): string {
  const { withSymbol = true, maxFractionDigits = 2 } = opts;
  const whole = lamports / USDC_DIVISOR;
  const frac = lamports % USDC_DIVISOR;
  const fracStr = frac.toString().padStart(Number(USDC_DECIMALS), "0");
  const fracTrimmed =
    maxFractionDigits === 0
      ? ""
      : "." + fracStr.slice(0, maxFractionDigits);
  const wholeFormatted = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${withSymbol ? "$" : ""}${wholeFormatted}${fracTrimmed}`;
}

export function formatUsdcCompact(lamports: bigint): string {
  const usdc = lamports / USDC_DIVISOR;
  const n = Number(usdc);
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export function formatBps(bps: number | bigint, fractionDigits = 2): string {
  const n = typeof bps === "bigint" ? Number(bps) : bps;
  return `${(n / 100).toFixed(fractionDigits)}%`;
}

export function formatPubkey(pk: string | { toBase58: () => string }): string {
  const s = typeof pk === "string" ? pk : pk.toBase58();
  if (s.length <= 8) return s;
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

export function formatTenor(seconds: bigint): string {
  const n = Number(seconds);
  const days = Math.round(n / 86_400);
  if (days >= 1) return `${days}-day tenor`;
  const hours = Math.round(n / 3_600);
  return `${hours}h tenor`;
}

/**
 * Annualizes a Kamino rate-index delta using the same Taylor expansion the on-chain
 * program uses (see `helpers/kamino.rs::calculate_current_apy_from_index`).
 *
 * Returns APY in basis points (e.g. 532n = 5.32%). Returns 0n if inputs are unusable.
 */
// Reject extrapolations from very-short windows where Taylor evaluation can
// be dominated by floor noise (sub-second elapsed). The output cap below
// handles the real failure mode (huge delta in a tight window producing
// astronomical APY); this floor is just a degenerate-input guard.
const MIN_RATE_WINDOW_SECONDS = 5n;

// Anything above this is the Taylor series exploding rather than a real APY;
// 10_000_000 bps = 100_000% APY. Real lending markets sit well below 1_000%.
const APY_BPS_SANITY_CAP = 10_000_000n;

export function calculateApyBps(
  previousRateIndex: bigint,
  currentRateIndex: bigint,
  elapsedSeconds: bigint
): bigint {
  if (
    elapsedSeconds < MIN_RATE_WINDOW_SECONDS ||
    previousRateIndex <= 0n ||
    currentRateIndex < previousRateIndex
  ) {
    return 0n;
  }
  if (currentRateIndex === previousRateIndex) {
    return 0n;
  }

  const r = ((currentRateIndex - previousRateIndex) * PRECISION) / previousRateIndex;
  const n = (SECONDS_PER_YEAR * PRECISION) / elapsedSeconds;

  const term1 = (n * r) / PRECISION;

  const nMinus1 = n > PRECISION ? n - PRECISION : 0n;
  const rSquared = (r * r) / PRECISION;
  const term2 = ((n * nMinus1) / PRECISION) * rSquared / PRECISION / 2n;

  const nMinus2 = n > 2n * PRECISION ? n - 2n * PRECISION : 0n;
  const rCubed = (rSquared * r) / PRECISION;
  const term3 =
    ((((n * nMinus1) / PRECISION) * nMinus2) / PRECISION) * rCubed / PRECISION / 6n;

  const apyScaled = term1 + term2 + term3;
  const apyBps = (apyScaled * BPS_SCALE) / PRECISION;
  return apyBps > APY_BPS_SANITY_CAP ? 0n : apyBps;
}

export function formatApy(
  previousRateIndex: bigint,
  currentRateIndex: bigint,
  elapsedSeconds: bigint
): string {
  const bps = calculateApyBps(previousRateIndex, currentRateIndex, elapsedSeconds);
  return formatBps(bps);
}

/** Clamp to [0..100]. */
export function utilizationPct(notional: bigint, lpNav: bigint): number {
  if (lpNav <= 0n) return 0;
  const raw = Number((notional * 10_000n) / lpNav) / 100;
  if (Number.isNaN(raw) || raw < 0) return 0;
  if (raw > 100) return 100;
  return Math.round(raw * 10) / 10;
}
