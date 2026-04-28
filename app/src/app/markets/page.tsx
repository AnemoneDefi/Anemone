"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { RevealOnScroll } from "@/components/RevealOnScroll";
import s from "./markets.module.css";

type MarketStatus = "live" | "soon";

type Market = {
  slug: string;
  name: string;
  glyph: string;
  status: MarketStatus;
  slabel: string;
  variable?: string;
  fixed?: string;
  tvl?: string;
  util?: number;
};

// MOCK — replace with on-chain market list (getProgramAccounts on SwapMarket).
const MARKETS: Market[] = [
  {
    slug: "kamino-usdc-30d",
    name: "Kamino K-Lend",
    slabel: "USDC · 30-day tenor",
    glyph: "K",
    status: "live",
    variable: "5.32%",
    fixed: "4.91%",
    tvl: "$2.4M",
    util: 38,
  },
  { slug: "solend",   name: "Solend",   glyph: "S", status: "soon", slabel: "Rolling out Q3 2026" },
  { slug: "marginfi", name: "MarginFi", glyph: "M", status: "soon", slabel: "Rolling out Q3 2026" },
  { slug: "drift",    name: "Drift",    glyph: "D", status: "soon", slabel: "Rolling out Q3 2026" },
];

type Filter = "all" | "live" | "soon";

function StatsBar() {
  return (
    <div className={`${s.stats} reveal`}>
      <div className={s.stat}>
        <span className={s.statKey}>Total TVL</span>
        <span className={s.statValue}>$2.4M</span>
        <span className={`${s.statDelta} ${s.up}`}>↑ 3.2% vs yesterday</span>
      </div>
      <div className={s.stat}>
        <span className={s.statKey}>Live markets</span>
        <span className={s.statValue}>1</span>
        <span className={s.statSub}>3 coming</span>
      </div>
      <div className={s.stat}>
        <span className={s.statKey}>Open positions</span>
        <span className={s.statValue}>47</span>
        <span className={s.statSub}>Across all traders</span>
      </div>
      <div className={s.stat}>
        <span className={s.statKey}>Volume (24h)</span>
        <span className={s.statValue}>$184K</span>
        <span className={`${s.statDelta} ${s.up}`}>↑ 12.4% vs yesterday</span>
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

function MarketRow({ m }: { m: Market }) {
  const router = useRouter();
  const isLive = m.status === "live";

  const onRowClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isLive) return;
    if ((e.target as HTMLElement).closest("button, a")) return;
    router.push(`/trade?market=${m.slug}`);
  };

  return (
    <div className={`${s.row} ${s[m.status]}`} onClick={onRowClick}>
      <div className={s.id}>
        <div className={s.logo}>{m.glyph}</div>
        <div className={s.info}>
          <div className={s.name}>{m.name}</div>
          <div className={s.subLabel}>{m.slabel}</div>
        </div>
      </div>
      <span className={`${s.statusBadge} ${s[m.status]}`}>
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
          <div className={s.utilFill} style={{ width: isLive ? `${m.util}%` : "0%" }} />
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

  const initialFilter = ((): Filter => {
    const p = searchParams.get("filter");
    if (p === "live" || p === "soon") return p;
    return "all";
  })();

  const [filter, setFilter] = useState<Filter>(initialFilter);

  // Reflect the filter in the URL — back/forward works without a remount.
  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (filter === "all") params.delete("filter");
    else params.set("filter", filter);
    const qs = params.toString();
    router.replace(qs ? `/markets?${qs}` : "/markets", { scroll: false });
  }, [filter, router, searchParams]);

  const counts: Record<Filter, number> = {
    all: MARKETS.length,
    live: MARKETS.filter((m) => m.status === "live").length,
    soon: MARKETS.filter((m) => m.status === "soon").length,
  };

  const visible = useMemo(() => {
    if (filter === "live") return MARKETS.filter((m) => m.status === "live");
    if (filter === "soon") return MARKETS.filter((m) => m.status === "soon");
    return MARKETS;
  }, [filter]);

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

          <StatsBar />

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
            {visible.length ? (
              visible.map((m) => <MarketRow key={m.slug} m={m} />)
            ) : (
              <div className={s.empty}>NO MARKETS MATCH THIS FILTER</div>
            )}
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
