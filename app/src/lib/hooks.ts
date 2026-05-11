"use client";

import useSWR, { type SWRResponse } from "swr";
import type {
  LpPosition,
  Market,
  Protocol,
  SwapPosition,
} from "@anemonedefi/sdk";
import { getReadonlyClient } from "./anemone";

const REFRESH_MS = 30_000;

export function useProtocol(): SWRResponse<Protocol | null, Error> {
  return useSWR<Protocol | null>(
    "anemone:protocol",
    () => getReadonlyClient().query.protocol.fetch(),
    { refreshInterval: REFRESH_MS }
  );
}

// Optional whitelist of market PDAs (comma-separated). When set, fetchAll
// results are filtered down to this set. Used on devnet to hide ghost markets
// from previous program deployments whose stored bytes deserialize as garbage
// under the current IDL (see devnet upgrade 2026-05-05). Empty/unset = no
// filter (production default).
const MARKET_WHITELIST: ReadonlySet<string> = new Set(
  (process.env.NEXT_PUBLIC_MARKET_WHITELIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
);

function passesWhitelist(m: Market): boolean {
  if (MARKET_WHITELIST.size === 0) return true;
  return MARKET_WHITELIST.has(m.publicKey);
}

export function useMarkets(): SWRResponse<Market[], Error> {
  return useSWR<Market[]>(
    "anemone:markets",
    async () => {
      const all = await getReadonlyClient().query.markets.fetchAll();
      return all.filter(passesWhitelist);
    },
    { refreshInterval: REFRESH_MS }
  );
}

export function useMarket(
  address: string | null | undefined
): SWRResponse<Market | null, Error> {
  return useSWR<Market | null>(
    address ? ["anemone:market", address] : null,
    ([, addr]) => getReadonlyClient().query.markets.fetchByAddress(addr as string),
    { refreshInterval: REFRESH_MS }
  );
}

export function useLpPosition(
  owner: string | null | undefined,
  market: string | null | undefined
): SWRResponse<LpPosition | null, Error> {
  return useSWR<LpPosition | null>(
    owner && market ? ["anemone:lp-position", owner, market] : null,
    ([, ownerAddr, marketAddr]) =>
      getReadonlyClient().query.positions.fetchLpPosition(
        ownerAddr as string,
        marketAddr as string
      ),
    { refreshInterval: REFRESH_MS }
  );
}

export function useLpPositionsByOwner(
  owner: string | null | undefined
): SWRResponse<LpPosition[], Error> {
  return useSWR<LpPosition[]>(
    owner ? ["anemone:lp-positions", owner] : null,
    ([, ownerAddr]) =>
      getReadonlyClient().query.positions.fetchLpPositionsByOwner(
        ownerAddr as string
      ),
    { refreshInterval: REFRESH_MS }
  );
}

export function useTraderPositions(
  owner: string | null | undefined
): SWRResponse<SwapPosition[], Error> {
  return useSWR<SwapPosition[]>(
    owner ? ["anemone:trader-positions", owner] : null,
    ([, ownerAddr]) =>
      getReadonlyClient().query.positions.fetchSwapPositionsByOwner(
        ownerAddr as string
      ),
    { refreshInterval: REFRESH_MS }
  );
}
