"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { RevealOnScroll } from "@/components/RevealOnScroll";
import { useMarkets } from "@/lib/hooks";
import { useProtocolStats } from "@/lib/analytics";
import {
  formatApy,
  formatTenor,
  formatUsdcCompact,
  utilizationPct,
} from "@/lib/format";
import { MarketStatus as SdkMarketStatus, type Market as SdkMarket } from "@anemonedefi/sdk";
import s from "./markets.module.css";

type RowStatus = "live" | "soon";

type LiveMarketRow = {
  kind: "live";
  slug: string;
  name: string;
  glyph: string;
  slabel: string;
  variable: string;
  fixed: string;
  tvl: string;
  util: number;
};

type SoonMarketRow = {
  kind: "soon";
  slug: string;
  name: string;
  glyph: string;
  slabel: string;
};

type MarketRow = LiveMarketRow | SoonMarketRow;

const SOON_MARKETS: SoonMarketRow[] = [
  { kind: "soon", slug: "solend",   name: "Solend",   glyph: "S", slabel: "Rolling out Q3 2026" },
  { kind: "soon", slug: "marginfi", name: "MarginFi", glyph: "M", slabel: "Rolling out Q3 2026" },
  { kind: "soon", slug: "drift",    name: "Drift",    glyph: "D", slabel: "Rolling out Q3 2026" },
];

type Filter = "all" | "live" | "soon";

function sdkMarketToRow(m: SdkMarket): LiveMarketRow {
  const elapsed =
    m.lastRateUpdateTs > m.previousRateUpdateTs
      ? m.lastRateUpdateTs - m.previousRateUpdateTs
      : 0n;
  const variable = formatApy(m.previousRateIndex, m.currentRateIndex, elapsed);

  // Fixed offered = variable + base spread (utilization/imbalance components require open
  // interest math from the Rust spread helper; baseSpread alone is a usable preview here).
  const variableBpsRaw = (() => {
    const pct = parseFloat(variable.replace("%", ""));
    return Number.isFinite(pct) ? pct * 100 : 0;
  })();
  const fixedBps = variableBpsRaw + m.baseSpreadBps;
  const fixed = `${(fixedBps / 100).toFixed(2)}%`;

  const totalNotional = m.totalFixedNotional + m.totalVariableNotional;

  return {
    kind: "live",
    slug: m.publicKey,
    name: "Kamino K-Lend",
    glyph: "K",
    slabel: `USDC · ${formatTenor(m.tenorSeconds)}`,
    variable,
    fixed,
    tvl: formatUsdcCompact(m.lpNav),
    util: utilizationPct(totalNotional, m.lpNav),
  };
}

function StatsBar({
  rows,
  totalTvlUsdc,
  totalOpenPositions,
}: {
  rows: MarketRow[];
  totalTvlUsdc: bigint;
  totalOpenPositions: bigint;
}) {
  const live = rows.filter((r) => r.kind === "live").length;
  const soon = rows.filter((r) => r.kind === "soon").length;
  const { data: protocolStats } = useProtocolStats();
  const volumeUsdc =
    protocolStats?.total_volume_usdc != null
      ? BigInt(protocolStats.total_volume_usdc)
      : null;
  return (
    <div className={`${s.stats} reveal`}>
      <div className={s.stat}>
        <span className={s.statKey}>Total TVL</span>
        <span className={s.statValue}>{formatUsdcCompact(totalTvlUsdc)}</span>
        <span className={s.statSub}>across live markets</span>
      </div>
      <div className={s.stat}>
        <span className={s.statKey}>Live markets</span>
        <span className={s.statValue}>{live}</span>
        <span className={s.statSub}>{soon} coming</span>
      </div>
      <div className={s.stat}>
        <span className={s.statKey}>Open positions</span>
        <span className={s.statValue}>{totalOpenPositions.toString()}</span>
        <span className={s.statSub}>Across all traders</span>
      </div>
      <div className={s.stat}>
        <span className={s.statKey}>Lifetime volume</span>
        <span className={s.statValue}>
          {volumeUsdc != null ? formatUsdcCompact(volumeUsdc) : "—"}
        </span>
        <span className={s.statSub}>
          {volumeUsdc != null ? "From event indexer" : "Indexer pending"}
        </span>
      </div>
    </div>
  );
}

function Tabs({
  active,
  onChange,
  counts,
}: {
  active: Filter;
  onChange: (f: Filter) => void;
  counts: Record<Filter, number>;
}) {
  const items: { k: Filter; l: string }[] = [
    { k: "all",  l: "All" },
    { k: "live", l: "Live" },
    { k: "soon", l: "Coming soon" },
  ];
  return (
    <div className={s.tabs} role="tablist">
      {items.map((it) => (
        <button
          key={it.k}
          role="tab"
          aria-selected={active === it.k}
          className={`${s.tab} ${active === it.k ? s.active : ""}`}
          onClick={() => onChange(it.k)}
          type="button"
        >
          {it.l}
          <span className={s.tabCount}>{counts[it.k]}</span>
        </button>
      ))}
    </div>
  );
}

function MarketRowView({ m }: { m: MarketRow }) {
  const router = useRouter();
  const isLive = m.kind === "live";
  const status: RowStatus = isLive ? "live" : "soon";

  const onRowClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isLive) return;
    if ((e.target as HTMLElement).closest("button, a")) return;
    router.push(`/trade?market=${m.slug}`);
  };

  return (
    <div className={`${s.row} ${s[status]}`} onClick={onRowClick}>
      <div className={s.id}>
        <div className={s.logo}>{m.glyph}</div>
        <div className={s.info}>
          <div className={s.name}>{m.name}</div>
          <div className={s.subLabel}>{m.slabel}</div>
        </div>
      </div>
      <span className={`${s.statusBadge} ${s[status]}`}>
        {isLive ? "LIVE" : "SOON"}
      </span>
      <div className={s.rate}>
        <span className={`${s.rateValue} ${isLive ? s.blue : s.placeholder}`}>
          {isLive ? m.variable : "—"}
        </span>
        <span className={s.rateLabel}>Variable APY</span>
      </div>
      <div className={s.rate}>
        <span className={`${s.rateValue} ${isLive ? s.pink : s.placeholder}`}>
          {isLive ? m.fixed : "—"}
        </span>
        <span className={s.rateLabel}>Fixed offered</span>
      </div>
      <div className={`${s.tvl} ${!isLive ? s.placeholder : ""}`}>
        {isLive ? m.tvl : "—"}
      </div>
      <div className={s.util}>
        <div className={`${s.utilRow} ${!isLive ? s.placeholder : ""}`}>
          <span className={s.utilPct}>{isLive ? `${m.util}%` : "—"}</span>
          <span className={s.utilCap}>Util</span>
        </div>
        <div className={`${s.utilBar} ${!isLive ? s.empty : ""}`}>
          <div
            className={s.utilFill}
            style={{ width: isLive ? `${m.util}%` : "0%" }}
          />
        </div>
      </div>
      <div className={s.actions}>
        {isLive ? (
          <>
            <Link href={`/trade?market=${m.slug}`} className={`${s.actionBtn} ${s.primary}`}>
              Trade →
            </Link>
            <Link href={`/lp?market=${m.slug}`} className={`${s.actionBtn} ${s.outline}`}>
              Deposit LP
            </Link>
          </>
        ) : (
          <button className={`${s.actionBtn} ${s.disabled}`} aria-disabled type="button">
            Coming soon
            <span className={s.tooltip}>Expected Q3 2026</span>
          </button>
        )}
      </div>
    </div>
  );
}

function MarketsPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { data: chainMarkets, isLoading, error } = useMarkets();

  const initialFilter = ((): Filter => {
    const p = searchParams.get("filter");
    if (p === "live" || p === "soon") return p;
    return "all";
  })();

  const [filter, setFilter] = useState<Filter>(initialFilter);

  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (filter === "all") params.delete("filter");
    else params.set("filter", filter);
    const qs = params.toString();
    router.replace(qs ? `/markets?${qs}` : "/markets", { scroll: false });
  }, [filter, router, searchParams]);

  const liveRows: LiveMarketRow[] = useMemo(() => {
    if (!chainMarkets) return [];
    return chainMarkets
      .filter((m) => m.status === SdkMarketStatus.Active)
      .map(sdkMarketToRow);
  }, [chainMarkets]);

  const allRows: MarketRow[] = useMemo(
    () => [...liveRows, ...SOON_MARKETS],
    [liveRows]
  );

  const counts: Record<Filter, number> = {
    all: allRows.length,
    live: liveRows.length,
    soon: SOON_MARKETS.length,
  };

  const visible = useMemo<MarketRow[]>(() => {
    if (filter === "live") return liveRows;
    if (filter === "soon") return SOON_MARKETS;
    return allRows;
  }, [filter, allRows, liveRows]);

  const totalTvl = useMemo(
    () => (chainMarkets ?? []).reduce((sum, m) => sum + m.lpNav, 0n),
    [chainMarkets]
  );
  const totalOpen = useMemo(
    () =>
      (chainMarkets ?? []).reduce((sum, m) => sum + m.totalOpenPositions, 0n),
    [chainMarkets]
  );

  return (
    <>
      <RevealOnScroll />
      <Nav />
      <section className="page">
        <div className="wrap">
          <div className="page-head reveal">
            <h1 className="page-title">Markets</h1>
            <p className="page-sub">Hedge or speculate on Solana lending rates.</p>
          </div>

          <StatsBar
            rows={allRows}
            totalTvlUsdc={totalTvl}
            totalOpenPositions={totalOpen}
          />

          <Tabs active={filter} onChange={setFilter} counts={counts} />

          <div className={`${s.list} reveal`}>
            <div className={s.colHeaders}>
              <span>Protocol</span>
              <span>Status</span>
              <span className={s.alignRight}>Variable</span>
              <span className={s.alignRight}>Fixed</span>
              <span className={s.alignRight}>TVL</span>
              <span>Utilization</span>
              <span style={{ textAlign: "right" }}>Actions</span>
            </div>
            {error && filter !== "soon" ? (
              <div className={s.empty}>
                COULDN&apos;T REACH RPC — IS SURFPOOL/DEVNET RUNNING?
              </div>
            ) : null}
            {!error && isLoading && filter !== "soon" && liveRows.length === 0 ? (
              <div className={s.empty}>LOADING ON-CHAIN MARKETS…</div>
            ) : null}
            {visible.length
              ? visible.map((m) => <MarketRowView key={m.slug} m={m} />)
              : !isLoading && !error
                ? <div className={s.empty}>NO MARKETS MATCH THIS FILTER</div>
                : null}
          </div>

          <div className="page-foot reveal">
            More protocols added based on community demand — suggest one on{" "}
            <a href="#">Discord</a>.
          </div>
        </div>
      </section>
      <Footer />
    </>
  );
}

export default function MarketsPage() {
  return (
    <Suspense>
      <MarketsPageContent />
    </Suspense>
  );
}
