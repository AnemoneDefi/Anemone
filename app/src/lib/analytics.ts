"use client";

import useSWR, { type SWRResponse } from "swr";
import { calculateApyBps } from "./format";

const API_URL = (process.env.NEXT_PUBLIC_ANALYTICS_API_URL ?? "").replace(/\/+$/, "");
const REFRESH_MS = 30_000;

export const ANALYTICS_API_ENABLED = API_URL.length > 0;

export interface ProtocolStats {
  total_tvl_usdc: number;
  total_volume_usdc: number;
  total_markets: number;
  total_transactions: number;
  total_lp_deposits: number;
  total_lp_withdrawals: number;
  total_kamino_deployed: number;
}

export interface RateSnapshot {
  rate_index: string;
  slot: number;
  timestamp: number;
}

export interface MarketStats {
  market: string;
  tvl_usdc: number;
  total_lp_deposits: number;
  total_lp_withdrawals: number;
  total_kamino_deployed: number;
  current_rate_index: string;
  last_rate_update_ts: number | null;
  rate_history: RateSnapshot[];
  transaction_count: number;
  volume_usdc: number;
}

export interface TransactionSummary {
  signature: string;
  slot: number;
  block_time: number | null;
  event_type: string;
  market: string | null;
  amount_usdc: number | null;
  description: string;
}

export interface TransactionsPage {
  items: TransactionSummary[];
  next_key: string | null;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`analytics ${path} → ${res.status}`);
  return res.json();
}

export function useProtocolStats(): SWRResponse<ProtocolStats | null, Error> {
  return useSWR<ProtocolStats | null>(
    ANALYTICS_API_ENABLED ? "analytics:protocol" : null,
    () => getJson<ProtocolStats>("/dashboard"),
    { refreshInterval: REFRESH_MS }
  );
}

export function useMarketStats(
  market: string | null | undefined
): SWRResponse<MarketStats | null, Error> {
  return useSWR<MarketStats | null>(
    ANALYTICS_API_ENABLED && market ? ["analytics:market", market] : null,
    ([, addr]) => getJson<MarketStats>(`/markets/${addr}`),
    { refreshInterval: REFRESH_MS }
  );
}

export function useRecentTransactions(
  limit: number = 50
): SWRResponse<TransactionsPage | null, Error> {
  return useSWR<TransactionsPage | null>(
    ANALYTICS_API_ENABLED ? ["analytics:transactions", limit] : null,
    ([, lim]) => getJson<TransactionsPage>(`/transactions?limit=${lim}`),
    { refreshInterval: REFRESH_MS }
  );
}

export interface RateChartPoint {
  /** APY at this snapshot, in percent (e.g. 7.42 = 7.42%). */
  apyPct: number;
  /** Unix seconds. */
  timestamp: number;
}

/**
 * Convert the API's `rate_history` (descending order, raw rate_index values)
 * into ascending APY-percent points suitable for charting.
 *
 * For each consecutive pair (i-1, i) we compute APY between them using the
 * same Taylor series the on-chain program uses. Returns up to N-1 points.
 */
export function rateHistoryToApyPoints(history: RateSnapshot[] | undefined): RateChartPoint[] {
  if (!history || history.length < 2) return [];
  const asc = [...history].sort((a, b) => a.timestamp - b.timestamp);
  const points: RateChartPoint[] = [];
  for (let i = 1; i < asc.length; i++) {
    const prev = asc[i - 1];
    const curr = asc[i];
    const elapsed = BigInt(Math.max(0, curr.timestamp - prev.timestamp));
    let prevIdx = 0n;
    let currIdx = 0n;
    try {
      prevIdx = BigInt(prev.rate_index);
      currIdx = BigInt(curr.rate_index);
    } catch {
      continue;
    }
    const apyBps = calculateApyBps(prevIdx, currIdx, elapsed);
    if (apyBps === 0n) continue;
    points.push({
      apyPct: Number(apyBps) / 100,
      timestamp: curr.timestamp,
    });
  }
  return points;
}
