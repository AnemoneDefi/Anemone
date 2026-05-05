"use client";

import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  useAnchorWallet,
  useWallet,
} from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  SwapDirection,
  type Market,
  type Protocol,
} from "@anemone/sdk";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { RevealOnScroll } from "@/components/RevealOnScroll";
import { useMarkets, useMarket, useProtocol } from "@/lib/hooks";
import { useTokenBalance } from "@/lib/balance";
import { buildClient } from "@/lib/anemone";
import {
  calculateApyBps,
  formatApy,
  formatBps,
  formatUsdc,
  formatUsdcCompact,
  utilizationPct,
} from "@/lib/format";
import {
  calculateInitialMargin,
  calculateMaintenanceMargin,
  calculateSpread,
  calculateSpreadWithNewSwap,
  effectiveLeverage,
  openingFee,
} from "@/lib/risk";
import s from "./trade.module.css";

const USDC_DECIMALS = 6;
const USDC_DIVISOR = 10n ** BigInt(USDC_DECIMALS);
const SLIPPAGE_BPS_DEFAULT = 50n;
// u64::MAX — used as the "no upper bound" cap for ReceiveFixed slippage.
const U64_MAX = 18_446_744_073_709_551_615n;

function parseUsdcInput(value: string): bigint | null {
  const trimmed = value.replace(/,/g, "").trim();
  if (!trimmed) return null;
  if (!/^\d+(\.\d{0,6})?$/.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = (frac + "000000").slice(0, USDC_DECIMALS);
  try {
    return BigInt(whole) * USDC_DIVISOR + BigInt(fracPadded);
  } catch {
    return null;
  }
}

function explorerTxUrl(signature: string): string {
  const network = process.env.NEXT_PUBLIC_NETWORK || "surfpool";
  if (network === "mainnet") return `https://explorer.solana.com/tx/${signature}`;
  if (network === "devnet")
    return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
  return `https://explorer.solana.com/tx/${signature}?cluster=custom&customUrl=${encodeURIComponent(
    process.env.NEXT_PUBLIC_RPC_URL || "http://127.0.0.1:8899"
  )}`;
}

function timeAgo(unixSec: bigint | null): string {
  if (unixSec == null || unixSec === 0n) return "—";
  const now = BigInt(Math.floor(Date.now() / 1000));
  const diff = Number(now - unixSec);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3_600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3_600)}h ago`;
  return `${Math.floor(diff / 86_400)}d ago`;
}

function maturityDateFrom(tenorSeconds: bigint): string {
  const ms = Date.now() + Number(tenorSeconds) * 1000;
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function settlementCadence(seconds: bigint): string {
  const n = Number(seconds);
  if (n >= 86_400) return `Every ${Math.round(n / 86_400)}d`;
  if (n >= 3_600) return `Every ${Math.round(n / 3_600)}h`;
  return `Every ${Math.round(n / 60)}m`;
}

function randomNonce(): number {
  return Math.floor(Math.random() * 254) + 1;
}

interface MarketDerived {
  variableApyBps: bigint;
  fixedOfferedBps: bigint;
  spreadBps: bigint;
  spread: ReturnType<typeof calculateSpread>;
  utilization: number;
  totalNotional: bigint;
}

function deriveMarket(
  market: Market,
  direction: SwapDirection,
  newNotional: bigint
): MarketDerived {
  const elapsed =
    market.lastRateUpdateTs > market.previousRateUpdateTs
      ? market.lastRateUpdateTs - market.previousRateUpdateTs
      : 0n;
  const variableApyBps = calculateApyBps(
    market.previousRateIndex,
    market.currentRateIndex,
    elapsed
  );
  const spread =
    newNotional > 0n
      ? calculateSpreadWithNewSwap(
          market.baseSpreadBps,
          market.maxUtilizationBps,
          market.lpNav,
          market.totalFixedNotional,
          market.totalVariableNotional,
          direction,
          newNotional
        )
      : calculateSpread(
          market.baseSpreadBps,
          market.maxUtilizationBps,
          market.lpNav,
          market.totalFixedNotional,
          market.totalVariableNotional
        );

  const fixedOfferedBps =
    direction === SwapDirection.PayFixed
      ? variableApyBps + spread.totalBps
      : variableApyBps > spread.totalBps
        ? variableApyBps - spread.totalBps
        : 0n;

  const totalNotional = market.totalFixedNotional + market.totalVariableNotional;
  return {
    variableApyBps,
    fixedOfferedBps,
    spreadBps: spread.totalBps,
    spread,
    utilization: utilizationPct(totalNotional, market.lpNav),
    totalNotional,
  };
}

// ─── MarketStrip ───────────────────────────────────────────────────────────

function MarketStrip({ market }: { market: Market | null | undefined }) {
  if (!market) {
    return (
      <div className={s.strip}>
        <div className={`wrap ${s.stripWrap}`}>
          <span style={{ color: "var(--text-2)" }}>
            {market === null ? "Market not found on this RPC" : "Loading market…"}
          </span>
        </div>
      </div>
    );
  }
  const d = deriveMarket(market, SwapDirection.PayFixed, 0n);
  return (
    <div className={s.strip}>
      <div className={`wrap ${s.stripWrap}`}>
        <button className={s.marketSelect} type="button">
          <span className={s.mktBadgeSm}>USDC</span>
          <span>Kamino USDC · {Number(market.tenorSeconds) / 86_400}D</span>
          <span className={s.chev}>▾</span>
        </button>
        <div className={s.vDiv} />
        <div className={s.statsRow}>
          <div className={s.statPill}>
            <span className={s.statPillKey}>Variable</span>
            <span className={s.statPillRow}>
              <span className={s.dotBlue} />
              {formatBps(d.variableApyBps)}
            </span>
          </div>
          <div className={s.statPill}>
            <span className={s.statPillKey}>Fixed Offered</span>
            <span className={s.statPillRow}>
              <span className="dot-pink" style={{ animation: "none" }} />
              {formatBps(d.fixedOfferedBps)}
            </span>
          </div>
          <div className={s.statPill}>
            <span className={s.statPillKey}>Spread</span>
            <span className={`${s.statPillRow} ${s.muted}`}>
              {formatBps(d.spreadBps)}
            </span>
          </div>
          <div className={s.statPill}>
            <span className={s.statPillKey}>Open Interest</span>
            <span className={s.statPillRow}>{formatUsdcCompact(d.totalNotional)}</span>
          </div>
          <div className={s.statPill}>
            <span className={s.statPillKey}>TVL</span>
            <span className={s.statPillRow}>{formatUsdcCompact(market.lpNav)}</span>
          </div>
          <div className={s.statPill}>
            <span className={s.statPillKey}>Utilization</span>
            <span className={s.statPillRow}>
              {d.utilization}%
              <span className={s.miniBar}>
                <span className={s.miniBarFill} style={{ width: `${d.utilization}%` }} />
              </span>
            </span>
          </div>
        </div>
        <div className={s.stripRight}>
          LAST UPDATE {timeAgo(market.lastRateUpdateTs)} · OPEN POS{" "}
          {market.totalOpenPositions.toString()}
        </div>
      </div>
    </div>
  );
}

// ─── LeftColumn (KPI grid wired, chart kept mocked) ────────────────────────

const SERIES = [
  6.2, 6.4, 6.1, 5.9, 6.3, 6.7, 7.1, 6.9, 6.6, 6.4,
  6.8, 7.2, 7.5, 7.3, 7.0, 6.8, 7.1, 7.4, 7.8, 8.1,
  8.4, 8.2, 7.9, 7.7, 8.0, 8.3, 8.6, 8.9, 9.2, 9.0,
  8.7, 8.5, 8.8, 9.1, 9.4, 9.7, 10.1, 10.4, 10.8, 11.2,
  11.6, 11.9, 12.0, 12.1, 11.7, 11.0, 10.2, 9.6, 9.3, 9.1,
  9.0, 9.1, 9.2, 9.3, 9.4, 9.3, 9.2, 9.3, 9.4, 9.42,
];

function RateChart() {
  const W = 800, H = 360, PADL = 8, PADR = 48, PADT = 16, PADB = 30;
  const data = useMemo(() => SERIES.map((y, i) => ({ x: i, y })), []);
  const xMin = 0;
  const xMax = data.length - 1;
  const yMin = 2;
  const yMax = 14;
  const xScale = (x: number) =>
    PADL + ((x - xMin) / (xMax - xMin)) * (W - PADL - PADR);
  const yScale = (y: number) =>
    PADT + (1 - (y - yMin) / (yMax - yMin)) * (H - PADT - PADB);
  const linePath = data
    .map((p, i) => `${i === 0 ? "M" : "L"}${xScale(p.x).toFixed(2)},${yScale(p.y).toFixed(2)}`)
    .join(" ");
  const areaPath = `${linePath} L${xScale(xMax).toFixed(2)},${yScale(yMin).toFixed(2)} L${xScale(xMin).toFixed(2)},${yScale(yMin).toFixed(2)} Z`;
  const yTicks = [2, 6, 10, 14];
  const xTickIdx = [0, 15, 29, 44, 59];
  const xTickLabels = ["−60D", "−45D", "−30D", "−15D", "TODAY"];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>
      <defs>
        <linearGradient id="rate-grad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="rgba(59,130,246,.16)" />
          <stop offset="100%" stopColor="rgba(59,130,246,0)" />
        </linearGradient>
      </defs>
      {yTicks.map((y) => (
        <g key={y}>
          <line x1={PADL} x2={W - PADR} y1={yScale(y)} y2={yScale(y)} stroke="#1e1f2a" strokeWidth={1} />
          <text x={W - PADR + 6} y={yScale(y) + 3} fill="#5b6070" fontSize="10" fontFamily="JetBrains Mono, monospace">
            {y}%
          </text>
        </g>
      ))}
      {xTickIdx.map((i, k) => (
        <text key={i} x={xScale(i)} y={H - 8} fill="#5b6070" fontSize="9" fontFamily="JetBrains Mono, monospace" textAnchor="middle" letterSpacing={1}>
          {xTickLabels[k]}
        </text>
      ))}
      <path d={areaPath} fill="url(#rate-grad)" />
      <path d={linePath} fill="none" stroke="#3b82f6" strokeWidth={1.4} strokeLinejoin="round" />
    </svg>
  );
}

function LeftColumn({
  market,
  derived,
}: {
  market: Market | null | undefined;
  derived: MarketDerived | null;
}) {
  return (
    <div className={`${s.card} ${s.chartCard} reveal`}>
      <div className={s.chartHead}>
        <div className={s.chartTitle}>
          {market
            ? `KAMINO USDC · ${Number(market.tenorSeconds) / 86_400}-DAY RATE (60d historical mock — partner refresh)`
            : "KAMINO USDC RATE"}
        </div>
        <div className={s.tfRow}>
          {(["1D", "7D", "30D", "90D", "ALL"] as const).map((tf) => (
            <button key={tf} className={`${s.tf} ${tf === "30D" ? s.active : ""}`} type="button">
              {tf}
            </button>
          ))}
        </div>
      </div>

      <div className={s.priceRow}>
        <div>
          <span className={s.priceLbl} style={{ marginRight: 8 }}>VAR</span>
          <span className={`${s.priceValue} ${s.blue}`}>
            {derived ? formatBps(derived.variableApyBps) : "—"}
          </span>
        </div>
        <span className={s.priceSep}>·</span>
        <div>
          <span className={s.priceLbl} style={{ marginRight: 8 }}>FIX</span>
          <span
            className={`${s.priceValue} pink-text`}
            style={{ fontSize: 28, fontWeight: 300, letterSpacing: "-.02em" }}
          >
            {derived ? formatBps(derived.fixedOfferedBps) : "—"}
          </span>
        </div>
      </div>

      <RateChart />

      <div className={s.kpiGrid}>
        <div className={s.kpiTile}>
          <span className={s.kpiKey}>Current Variable</span>
          <span className={`${s.kpiValue} ${s.blue}`}>
            {derived ? formatBps(derived.variableApyBps) : "—"}
          </span>
          <span className={s.kpiSub}>
            {market ? `Updated ${timeAgo(market.lastRateUpdateTs)}` : "—"}
          </span>
        </div>
        <div className={s.kpiTile}>
          <span className={s.kpiKey}>Anemone Fixed</span>
          <span className={`${s.kpiValue} ${s.pink}`}>
            {derived ? formatBps(derived.fixedOfferedBps) : "—"}
          </span>
          <span className={s.kpiSub}>Locked at open</span>
        </div>
        <div className={s.kpiTile}>
          <span className={s.kpiKey}>Spread</span>
          <span className={s.kpiValue}>
            {derived ? formatBps(derived.spreadBps) : "—"}
          </span>
          <span className={s.kpiSub}>
            {derived
              ? `Base ${formatBps(derived.spread.baseBps)} + Util ${formatBps(
                  derived.spread.utilizationBps
                )} + Imbal ${formatBps(derived.spread.imbalanceBps)}`
              : "—"}
          </span>
        </div>
        <div className={s.kpiTile}>
          <span className={s.kpiKey}>Time to Maturity</span>
          <span className={s.kpiValue}>
            {market ? `${Number(market.tenorSeconds) / 86_400}D` : "—"}
          </span>
          <span className={s.kpiSub}>
            {market ? `Maturity ${maturityDateFrom(market.tenorSeconds)}` : "—"}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── OrderTicket ───────────────────────────────────────────────────────────

function LockGlyph() {
  return (
    <svg viewBox="0 0 12 12" fill="none">
      <rect x={2} y={5.5} width={8} height={5.5} rx={1} stroke="#8a8f9c" strokeWidth={1.2} />
      <path
        d="M3.5 5.5V3.5a2.5 2.5 0 0 1 5 0v2"
        stroke="#8a8f9c"
        strokeWidth={1.2}
        strokeLinecap="round"
      />
    </svg>
  );
}


// ─── ImpactStrip (recompute spread/util with proposed new notional) ────────

function ImpactStrip({
  market,
  derived,
  notional,
  direction,
}: {
  market: Market | null | undefined;
  derived: MarketDerived | null;
  notional: bigint | null;
  direction: SwapDirection;
}) {
  if (!market || !derived) {
    return (
      <div className={s.impactStrip}>
        <div className={`wrap ${s.impactGrid}`}>
          <span style={{ color: "var(--text-2)" }}>Loading impact…</span>
        </div>
      </div>
    );
  }

  const baseSpread = calculateSpread(
    market.baseSpreadBps,
    market.maxUtilizationBps,
    market.lpNav,
    market.totalFixedNotional,
    market.totalVariableNotional
  );
  const utilBefore = utilizationPct(
    market.totalFixedNotional + market.totalVariableNotional,
    market.lpNav
  );
  const utilAfter =
    notional && notional > 0n
      ? utilizationPct(
          market.totalFixedNotional + market.totalVariableNotional + notional,
          market.lpNav
        )
      : utilBefore;
  const sharePct =
    notional && market.lpNav > 0n
      ? Number((notional * 10_000n) / market.lpNav) / 100
      : 0;
  const spreadDelta =
    notional && notional > 0n
      ? derived.spreadBps - baseSpread.totalBps
      : 0n;

  return (
    <div className={s.impactStrip}>
      <div className={`wrap ${s.impactGrid}`}>
        <div className={s.impactItem}>
          <span className={s.impactKey}>Your notional share</span>
          <span className={s.impactValue}>{sharePct.toFixed(2)}% of pool</span>
        </div>
        <div className={s.impactItem}>
          <span className={s.impactKey}>Pool utilization</span>
          <span className={s.impactValue}>
            {utilBefore}% <span className={s.arrowRight}>→</span> {utilAfter}%
          </span>
        </div>
        <div className={s.impactItem}>
          <span className={s.impactKey}>Spread impact</span>
          <span className={s.impactValue}>
            {spreadDelta === 0n
              ? "0 bps"
              : `${spreadDelta > 0n ? "+" : ""}${spreadDelta.toString()} bps`}
          </span>
        </div>
        <div className={s.impactItem}>
          <span className={s.impactKey}>Direction bias</span>
          <span className={s.impactValue}>
            {direction === SwapDirection.PayFixed ? "Adds Pay-side" : "Adds Recv-side"}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── RecentTrades — kept mocked (no indexer yet) ───────────────────────────

const TRADES = [
  { t: "2s ago",  side: "pay", notional: "$25,000", rate: "8.22%", mat: "30D", tx: "3F9k…a21c" },
  { t: "14s ago", side: "rec", notional: "$8,000",  rate: "8.18%", mat: "30D", tx: "7BcQ…f830" },
  { t: "42s ago", side: "pay", notional: "$12,500", rate: "8.21%", mat: "30D", tx: "9Ht2…e44a" },
  { t: "1m ago",  side: "pay", notional: "$5,000",  rate: "8.20%", mat: "30D", tx: "5Gp8…b11f" },
  { t: "3m ago",  side: "rec", notional: "$18,000", rate: "8.17%", mat: "30D", tx: "2Mn6…0d9e" },
];

function TxGlyph() {
  return (
    <svg width={11} height={11} viewBox="0 0 11 11" fill="none">
      <path d="M4 7L7 4M7 4H4.5M7 4V6.5" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" />
      <rect x={1} y={1} width={9} height={9} rx={1.5} stroke="currentColor" strokeWidth={1} opacity={0.5} />
    </svg>
  );
}

function RecentTrades() {
  return (
    <section className={s.trades}>
      <div className="wrap">
        <div className={s.tradesHead}>
          <div className={s.tradesTitle}>
            Recent Trades · Kamino USDC 30D (mock — indexer pending)
          </div>
          <div className={s.live}>
            <span className="dot-pink" />
            Live
          </div>
        </div>
        <table className={s.tradesTable}>
          <thead>
            <tr>
              <th style={{ width: "12%" }}>Time</th>
              <th style={{ width: "18%" }}>Side</th>
              <th style={{ width: "18%" }}>Notional</th>
              <th style={{ width: "16%" }}>Fixed Rate</th>
              <th style={{ width: "14%" }}>Maturity</th>
              <th style={{ width: "22%" }}>Tx</th>
            </tr>
          </thead>
          <tbody>
            {TRADES.map((r, i) => (
              <tr key={i}>
                <td className={s.muted}>{r.t}</td>
                <td>
                  <span className={`${s.sideTag} ${r.side === "pay" ? s.pay : s.rec}`}>
                    {r.side === "pay" ? "PayFixed" : "ReceiveFixed"}
                  </span>
                </td>
                <td>{r.notional}</td>
                <td>{r.rate}</td>
                <td className={s.muted}>{r.mat}</td>
                <td>
                  <a className={s.txGlyph} href="#">
                    <TxGlyph /> {r.tx}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── Page wrapper ──────────────────────────────────────────────────────────

function TradePageContent() {
  const searchParams = useSearchParams();
  const { data: markets } = useMarkets();
  const { data: protocol } = useProtocol();

  const marketAddress = useMemo(() => {
    const fromUrl = searchParams.get("market");
    if (fromUrl) return fromUrl;
    if (markets && markets.length > 0) return markets[0].publicKey;
    return null;
  }, [searchParams, markets]);

  const { data: market, mutate: refetchMarket } = useMarket(marketAddress);

  // Lift OrderTicket state up so ImpactStrip can reflect the proposed swap.
  const [direction, setDirection] = useState<SwapDirection>(SwapDirection.PayFixed);
  const [notionalInput, setNotionalInput] = useState("");
  const notional = useMemo(() => parseUsdcInput(notionalInput), [notionalInput]);
  const derived = useMemo<MarketDerived | null>(() => {
    if (!market) return null;
    return deriveMarket(market, direction, notional ?? 0n);
  }, [market, direction, notional]);

  return (
    <>
      <RevealOnScroll />
      <Nav />
      <MarketStrip market={market} />
      <section className={s.workspace}>
        <div className={`wrap ${s.workspaceGrid}`}>
          <LeftColumn market={market} derived={derived} />
          <ControlledOrderTicket
            market={market}
            protocol={protocol}
            direction={direction}
            setDirection={setDirection}
            notionalInput={notionalInput}
            setNotionalInput={setNotionalInput}
            refresh={refetchMarket}
          />
        </div>
      </section>
      <ImpactStrip
        market={market}
        derived={derived}
        notional={notional}
        direction={direction}
      />
      <RecentTrades />
      <Footer />
    </>
  );
}

// Lifted version of OrderTicket where direction + notional are controlled by parent
// (so ImpactStrip can react to the same state).
function ControlledOrderTicket({
  market,
  protocol,
  direction,
  setDirection,
  notionalInput,
  setNotionalInput,
  refresh,
}: {
  market: Market | null | undefined;
  protocol: Protocol | null | undefined;
  direction: SwapDirection;
  setDirection: (d: SwapDirection) => void;
  notionalInput: string;
  setNotionalInput: (v: string) => void;
  refresh: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);

  const wallet = useWallet();
  const anchorWallet = useAnchorWallet();

  const { data: usdcBalance } = useTokenBalance(
    wallet.publicKey?.toBase58(),
    market?.underlyingMint
  );

  const notional = useMemo(() => parseUsdcInput(notionalInput), [notionalInput]);

  const derived = useMemo<MarketDerived | null>(() => {
    if (!market) return null;
    return deriveMarket(market, direction, notional ?? 0n);
  }, [market, direction, notional]);

  const initialMargin = useMemo(
    () => (market && notional ? calculateInitialMargin(notional, market.tenorSeconds) : 0n),
    [market, notional]
  );
  const maintenanceMargin = useMemo(
    () => (market && notional ? calculateMaintenanceMargin(notional, market.tenorSeconds) : 0n),
    [market, notional]
  );
  const fee = useMemo(
    () => (notional && protocol ? openingFee(notional, protocol.openingFeeBps) : 0n),
    [notional, protocol]
  );
  const totalToLock = initialMargin + fee;
  const leverage = useMemo(
    () => (market && notional ? effectiveLeverage(notional, market.tenorSeconds) : 0),
    [market, notional]
  );

  const reset = () => {
    setError(null);
    setSignature(null);
  };

  const handleQuickPick = (pct: number | "max") => {
    if (!usdcBalance) return;
    const value = pct === "max" ? usdcBalance : (usdcBalance * BigInt(pct)) / 100n;
    setNotionalInput(formatUsdc(value, { withSymbol: false, maxFractionDigits: 6 }));
  };

  const handleOpen = async () => {
    if (!anchorWallet || !market || !protocol || !derived) return;
    if (!notional || notional <= 0n) {
      setError("Enter a valid notional in USDC.");
      return;
    }
    if (usdcBalance != null && totalToLock > usdcBalance) {
      setError(
        `Need ${formatUsdc(totalToLock, { withSymbol: true })} (margin + fee) but wallet has only ${formatUsdc(
          usdcBalance,
          { withSymbol: true }
        )}.`
      );
      return;
    }
    reset();
    setPending(true);
    try {
      const slippage = SLIPPAGE_BPS_DEFAULT;
      const maxRateBps =
        direction === SwapDirection.PayFixed
          ? derived.fixedOfferedBps + slippage
          : U64_MAX;
      const minRateBps =
        direction === SwapDirection.ReceiveFixed
          ? derived.fixedOfferedBps > slippage
            ? derived.fixedOfferedBps - slippage
            : 0n
          : 0n;

      const client = buildClient(anchorWallet);
      const result = await client.trader.openSwap.execute({
        trader: anchorWallet.publicKey,
        market: new PublicKey(market.publicKey),
        underlyingMint: new PublicKey(market.underlyingMint),
        treasury: new PublicKey(protocol.treasury),
        collateralVault: new PublicKey(market.collateralVault),
        direction,
        notional,
        nonce: randomNonce(),
        maxRateBps,
        minRateBps,
      });
      setSignature(result.signature);
      setNotionalInput("");
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  const hasWallet = !!wallet.publicKey;
  const canSubmit = hasWallet && !!market && !!protocol && !pending && !!notional;
  const levPct = Math.min((leverage / 50) * 100, 100);
  const warnPct = (40 / 50) * 100;

  return (
    <div className={`${s.ticketWrap} reveal`}>
      <div className={s.ticketGlow} />
      <div className={`${s.card} ${s.ticket}`}>
        <h3>Open Position</h3>

        <div className={s.sideToggle}>
          <button
            className={`${s.sideBtn} ${
              direction === SwapDirection.PayFixed ? s.activePay : s.inactive
            }`}
            onClick={() => {
              setDirection(SwapDirection.PayFixed);
              reset();
            }}
            type="button"
          >
            <span>PAY FIXED ↓</span>
            <span className={s.sideBtnCap}>Hedge your variable yield</span>
          </button>
          <button
            className={`${s.sideBtn} ${
              direction === SwapDirection.ReceiveFixed ? s.activeReceive : s.inactive
            }`}
            onClick={() => {
              setDirection(SwapDirection.ReceiveFixed);
              reset();
            }}
            type="button"
          >
            <span>RECEIVE FIXED ↑</span>
            <span className={s.sideBtnCap}>Speculate on falling rates</span>
          </button>
        </div>

        <div className={s.field}>
          <span className={s.fieldLabel}>Notional</span>
          <div className={s.inputBox}>
            <span className="prefix">$</span>
            <input
              value={notionalInput}
              onChange={(e) => setNotionalInput(e.target.value)}
              placeholder="0.00"
              inputMode="decimal"
            />
            <span className="suffix">USDC</span>
          </div>
          <div className={s.qpRow}>
            {[25, 50, 75].map((p) => (
              <button
                key={p}
                className={s.qp}
                type="button"
                onClick={() => handleQuickPick(p)}
                disabled={!hasWallet || !usdcBalance}
              >
                {p}%
              </button>
            ))}
            <button
              className={s.qp}
              type="button"
              onClick={() => handleQuickPick("max")}
              disabled={!hasWallet || !usdcBalance}
            >
              MAX
            </button>
          </div>
          <div className={s.hint} style={{ marginTop: 8 }}>
            Wallet:{" "}
            <span className={s.muted}>
              {hasWallet
                ? usdcBalance == null
                  ? "—"
                  : `${formatUsdc(usdcBalance, { withSymbol: false })} USDC`
                : "—"}
            </span>
          </div>
        </div>

        <div className={s.field}>
          <span className={s.fieldLabel}>Required collateral</span>
          <div className={s.inputBox}>
            <span className="prefix">$</span>
            <input
              value={initialMargin > 0n ? formatUsdc(initialMargin, { withSymbol: false }) : ""}
              readOnly
              placeholder="—"
            />
            <span className="suffix">USDC</span>
          </div>
          <div className={s.hint}>
            Auto-locked by the program — notional × tenor with 1.5× safety on a 20% adverse move.
          </div>
        </div>

        <div className={s.field}>
          <span className={s.fieldLabel}>Effective Leverage</span>
          <div className={s.levRow}>
            <div className={s.levBar}>
              <div className={s.levBarFill} style={{ width: `${levPct}%` }} />
              <div className={s.levTick} style={{ left: `calc(${warnPct}% - 1px)` }} />
              <div className={s.levWarn} style={{ left: `${warnPct}%` }}>
                HIGH
              </div>
            </div>
            <span className={s.levVal}>{leverage > 0 ? `${leverage.toFixed(1)}×` : "—"}</span>
          </div>
          <div className={s.levScale} style={{ marginTop: 22 }}>
            <span>1×</span>
            <span>10×</span>
            <span>20×</span>
            <span>30×</span>
            <span>50×</span>
          </div>
        </div>

        <div className={s.preview}>
          <span className={s.eyebrow}>Position Preview</span>
          <div className={s.previewRow}>
            <span className={s.previewKey}>Locked fixed rate</span>
            <span className={`${s.previewValue} pink-text`}>
              {derived ? formatBps(derived.fixedOfferedBps) : "—"}
            </span>
          </div>
          <div className={s.previewRow}>
            <span className={s.previewKey}>Variable rate exposure</span>
            <span className={`${s.previewValue} ${s.muted}`}>
              {direction === SwapDirection.PayFixed
                ? "Receive floating"
                : "Pay floating"}
            </span>
          </div>
          <div className={s.previewRow}>
            <span className={s.previewKey}>Maint. margin</span>
            <span className={`${s.previewValue} ${s.muted}`}>
              {maintenanceMargin > 0n
                ? `$${formatUsdc(maintenanceMargin, { withSymbol: false })}`
                : "—"}
            </span>
          </div>
          <div className={s.previewRow}>
            <span className={s.previewKey}>Opening fee</span>
            <span className={`${s.previewValue} ${s.muted}`}>
              {fee > 0n ? `$${formatUsdc(fee, { withSymbol: false })}` : "—"}
              {protocol ? ` (${formatBps(protocol.openingFeeBps)})` : ""}
            </span>
          </div>
          <div className={s.previewRow}>
            <span className={s.previewKey}>Total to lock</span>
            <span className={`${s.previewValue}`}>
              {totalToLock > 0n
                ? `$${formatUsdc(totalToLock, { withSymbol: false })}`
                : "—"}
            </span>
          </div>
          <div className={s.previewRow}>
            <span className={s.previewKey}>Maturity</span>
            <span className={`${s.previewValue} ${s.muted}`}>
              {market ? maturityDateFrom(market.tenorSeconds) : "—"}
            </span>
          </div>
          <div className={s.previewRow}>
            <span className={s.previewKey}>Settlement cadence</span>
            <span className={`${s.previewValue} ${s.muted}`}>
              {market ? settlementCadence(market.settlementPeriodSeconds) : "—"}
            </span>
          </div>
          <div className={s.previewRow}>
            <span className={s.previewKey}>Slippage tolerance</span>
            <span className={`${s.previewValue} ${s.muted}`}>
              ±{formatBps(SLIPPAGE_BPS_DEFAULT)}
            </span>
          </div>
        </div>

        <button
          className={`${s.cta} ${!canSubmit ? s.disabled : ""}`}
          type="button"
          onClick={handleOpen}
          disabled={!canSubmit}
        >
          {pending
            ? "Submitting…"
            : `Open ${
                direction === SwapDirection.PayFixed ? "PayFixed" : "ReceiveFixed"
              } Position →`}
        </button>
        <div className={s.ctaLock}>
          {!hasWallet ? (
            <>
              <LockGlyph /> Connect wallet to open a position
            </>
          ) : !market ? (
            "Loading market…"
          ) : null}
        </div>

        {error ? <div className={s.errorBanner}>{error}</div> : null}
        {signature ? (
          <div className={s.successBanner}>
            <span>Position opened</span>
            <a href={explorerTxUrl(signature)} target="_blank" rel="noreferrer">
              {signature.slice(0, 16)}…{signature.slice(-8)} ↗
            </a>
          </div>
        ) : null}

        <div className={s.fine}>
          By opening, you agree to on-chain settlement at the cadence above and margin
          liquidation when collateral falls below maintenance. The program re-prices
          and re-checks slippage at execution time.
        </div>
      </div>
    </div>
  );
}

export default function TradePage() {
  return (
    <Suspense>
      <TradePageContent />
    </Suspense>
  );
}
