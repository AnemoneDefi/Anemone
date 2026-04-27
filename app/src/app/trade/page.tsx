"use client";

import { useMemo, useState } from "react";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { RevealOnScroll } from "@/components/RevealOnScroll";
import s from "./trade.module.css";

// MOCK SERIES — variable rate over the last 60 days, with a spike to ~12.1%
// near the end. Replace with on-chain rate-index history.
const SERIES = [
  6.2, 6.4, 6.1, 5.9, 6.3, 6.7, 7.1, 6.9, 6.6, 6.4,
  6.8, 7.2, 7.5, 7.3, 7.0, 6.8, 7.1, 7.4, 7.8, 8.1,
  8.4, 8.2, 7.9, 7.7, 8.0, 8.3, 8.6, 8.9, 9.2, 9.0,
  8.7, 8.5, 8.8, 9.1, 9.4, 9.7, 10.1, 10.4, 10.8, 11.2,
  11.6, 11.9, 12.0, 12.1, 11.7, 11.0, 10.2, 9.6, 9.3, 9.1,
  9.0, 9.1, 9.2, 9.3, 9.4, 9.3, 9.2, 9.3, 9.4, 9.42,
];

function MarketStrip() {
  return (
    <div className={s.strip}>
      <div className={`wrap ${s.stripWrap}`}>
        <button className={s.marketSelect} type="button">
          <span className={s.mktBadgeSm}>USDC</span>
          <span>Kamino USDC · 30D</span>
          <span className={s.chev}>▾</span>
        </button>
        <div className={s.vDiv} />
        <div className={s.statsRow}>
          <div className={s.statPill}>
            <span className={s.statPillKey}>Variable</span>
            <span className={s.statPillRow}>
              <span className={s.dotBlue} />
              9.42%
              <span className={`${s.statPillDelta} ${s.up}`}>↑ +0.12% 24h</span>
            </span>
          </div>
          <div className={s.statPill}>
            <span className={s.statPillKey}>Fixed Offered</span>
            <span className={s.statPillRow}>
              <span className="dot-pink" style={{ animation: "none" }} />
              8.20%
              <span className={`${s.statPillDelta} ${s.down}`}>↓ −0.04% 24h</span>
            </span>
          </div>
          <div className={s.statPill}>
            <span className={s.statPillKey}>Spread</span>
            <span className={`${s.statPillRow} ${s.muted}`}>1.22%</span>
          </div>
          <div className={s.statPill}>
            <span className={s.statPillKey}>Open Interest</span>
            <span className={s.statPillRow}>$8.1M</span>
          </div>
          <div className={s.statPill}>
            <span className={s.statPillKey}>TVL</span>
            <span className={s.statPillRow}>$2.4M</span>
          </div>
          <div className={s.statPill}>
            <span className={s.statPillKey}>Utilization</span>
            <span className={s.statPillRow}>
              34%
              <span className={s.miniBar}>
                <span className={s.miniBarFill} style={{ width: "34%" }} />
              </span>
            </span>
          </div>
        </div>
        <div className={s.stripRight}>LAST UPDATE 2s ago · BLOCK 312,445,890</div>
      </div>
    </div>
  );
}

function RateChart() {
  const W = 800;
  const H = 360;
  const PADL = 8;
  const PADR = 48;
  const PADT = 16;
  const PADB = 30;

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
    .map(
      (p, i) => `${i === 0 ? "M" : "L"}${xScale(p.x).toFixed(2)},${yScale(p.y).toFixed(2)}`,
    )
    .join(" ");

  const areaPath = `${linePath} L${xScale(xMax).toFixed(2)},${yScale(yMin).toFixed(2)} L${xScale(xMin).toFixed(2)},${yScale(yMin).toFixed(2)} Z`;

  const yTicks = [2, 6, 10, 14];
  const xTickIdx = [0, 15, 29, 44, 59];
  const xTickLabels = ["Mar 24", "Mar 31", "Apr 07", "Apr 14", "Apr 21"];

  const spikeIdx = 43;
  const spike = data[spikeIdx];
  const sx = xScale(spike.x);
  const sy = yScale(spike.y);

  const chIdx = 44;
  const ch = data[chIdx];
  const chX = xScale(ch.x);
  const chYvar = yScale(ch.y);
  const chYfix = yScale(8.2);

  return (
    <div className={s.chartBox}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height: "100%", display: "block", overflow: "visible" }}
      >
        <defs>
          <linearGradient id="varFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="rgba(59,130,246,.18)" />
            <stop offset="1" stopColor="rgba(59,130,246,0)" />
          </linearGradient>
        </defs>

        {yTicks.map((y) => (
          <line
            key={y}
            x1={PADL}
            x2={W - PADR}
            y1={yScale(y)}
            y2={yScale(y)}
            stroke="#1e1f2a"
            strokeWidth={1}
          />
        ))}

        <path d={areaPath} fill="url(#varFill)" opacity={0.5} />

        <line
          x1={PADL}
          x2={W - PADR}
          y1={yScale(8.2)}
          y2={yScale(8.2)}
          stroke="#ec4899"
          strokeWidth={2}
          strokeDasharray="6 5"
          opacity={0.9}
        />

        <path
          d={linePath}
          fill="none"
          stroke="#3b82f6"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        <line
          x1={chX}
          x2={chX}
          y1={PADT}
          y2={H - PADB}
          stroke="#2a2c3a"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
        <circle cx={chX} cy={chYvar} r={4} fill="#3b82f6" stroke="#07080f" strokeWidth={2} />
        <circle cx={chX} cy={chYfix} r={3} fill="#ec4899" stroke="#07080f" strokeWidth={2} />

        <circle cx={sx} cy={sy} r={3} fill="#3b82f6" stroke="#07080f" strokeWidth={2} />
        <line x1={sx} x2={sx + 28} y1={sy} y2={sy - 24} stroke="#2a2c3a" strokeWidth={1} />
        <text
          x={sx + 32}
          y={sy - 22}
          fill="#8a8f9c"
          fontSize="10"
          fontFamily="JetBrains Mono, monospace"
          letterSpacing={1}
        >
          APR 14 · 12.1%
        </text>

        {yTicks.map((y) => (
          <text
            key={`yl-${y}`}
            x={W - PADR + 8}
            y={yScale(y) + 4}
            fill="#5b6070"
            fontSize="10"
            fontFamily="JetBrains Mono, monospace"
          >
            {y}%
          </text>
        ))}

        {xTickIdx.map((i, k) => (
          <text
            key={`xl-${k}`}
            x={xScale(i)}
            y={H - 8}
            fill="#5b6070"
            fontSize="10"
            fontFamily="JetBrains Mono, monospace"
            textAnchor={k === 0 ? "start" : k === xTickIdx.length - 1 ? "end" : "middle"}
          >
            {xTickLabels[k]}
          </text>
        ))}

        <circle
          cx={xScale(xMax)}
          cy={yScale(data[data.length - 1].y)}
          r={4}
          fill="#3b82f6"
        />
        <circle
          cx={xScale(xMax)}
          cy={yScale(data[data.length - 1].y)}
          r={8}
          fill="#3b82f6"
          opacity={0.25}
        />
      </svg>

      <div
        style={{
          position: "absolute",
          left: `${(chX / W) * 100}%`,
          top: `${(chYvar / H) * 100 + 4}%`,
          transform: "translate(-50%,16px)",
          background: "#0b0d14",
          border: "1px solid #2a2c3a",
          borderRadius: 8,
          padding: "10px 14px",
          fontFamily: "JetBrains Mono, monospace",
          fontSize: 11,
          whiteSpace: "nowrap",
          pointerEvents: "none",
          boxShadow: "0 8px 24px rgba(0,0,0,.5)",
          zIndex: 2,
        }}
      >
        <div style={{ color: "#8a8f9c", marginBottom: 6, letterSpacing: ".08em" }}>
          APR 14 · 14:00 UTC
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#f5f5f7", marginBottom: 4 }}>
          <span style={{ width: 8, height: 8, background: "#3b82f6", borderRadius: "50%", display: "inline-block" }} />
          Variable <span style={{ marginLeft: "auto", fontWeight: 600 }}>12.10%</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#f5f5f7", marginBottom: 4 }}>
          <span style={{ width: 8, height: 8, background: "#ec4899", borderRadius: "50%", display: "inline-block" }} />
          Fixed <span style={{ marginLeft: "auto", fontWeight: 600 }}>8.20%</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#8a8f9c" }}>
          Spread <span style={{ marginLeft: "auto" }}>3.90%</span>
        </div>
      </div>
    </div>
  );
}

function LeftColumn() {
  return (
    <div className={`${s.card} ${s.chartCard} reveal`}>
      <div className={s.chartHead}>
        <div className={s.chartTitle}>KAMINO USDC · 30-DAY RATE</div>
        <div className={s.tfRow}>
          {(["1D", "7D", "30D", "90D", "ALL"] as const).map((tf) => (
            <button
              key={tf}
              className={`${s.tf} ${tf === "30D" ? s.active : ""}`}
              type="button"
            >
              {tf}
            </button>
          ))}
        </div>
      </div>

      <div className={s.priceRow}>
        <div>
          <span className={s.priceLbl} style={{ marginRight: 8 }}>VAR</span>
          <span className={`${s.priceValue} ${s.blue}`}>9.42%</span>
        </div>
        <span className={s.priceSep}>·</span>
        <div>
          <span className={s.priceLbl} style={{ marginRight: 8 }}>FIX</span>
          <span className={`${s.priceValue} pink-text`} style={{ fontSize: 28, fontWeight: 300, letterSpacing: "-.02em" }}>
            8.20%
          </span>
        </div>
      </div>

      <RateChart />

      <div className={s.kpiGrid}>
        <div className={s.kpiTile}>
          <span className={s.kpiKey}>Current Variable</span>
          <span className={`${s.kpiValue} ${s.blue}`}>9.42%</span>
          <span className={`${s.kpiSub} ${s.up}`}>↑ +0.12% 24h</span>
        </div>
        <div className={s.kpiTile}>
          <span className={s.kpiKey}>Anemone Fixed</span>
          <span className={`${s.kpiValue} ${s.pink}`}>8.20%</span>
          <span className={s.kpiSub}>Locked at open</span>
        </div>
        <div className={s.kpiTile}>
          <span className={s.kpiKey}>Spread</span>
          <span className={s.kpiValue}>1.22%</span>
          <span className={s.kpiSub}>Base 0.8 + Util 0.27 + Imbal 0.15</span>
        </div>
        <div className={s.kpiTile}>
          <span className={s.kpiKey}>Time to Maturity</span>
          <span className={s.kpiValue}>30D 00h</span>
          <span className={s.kpiSub}>Maturity May 23, 2026</span>
        </div>
      </div>

      <div className={s.disclosure}>
        <span className={s.disclosureText}>Advanced · Spread Decomposition</span>
        <span className={s.chev}>›</span>
      </div>
    </div>
  );
}

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

type Side = "pay" | "receive";

function OrderTicket() {
  const [side, setSide] = useState<Side>("pay");
  const lev = 4.2;
  const levPct = (lev / 10) * 100;
  const warnPct = (8.0 / 10) * 100;

  return (
    <div className={`${s.ticketWrap} reveal`}>
      <div className={s.ticketGlow} />
      <div className={`${s.card} ${s.ticket}`}>
        <h3>Open Position</h3>

        <div className={s.sideToggle}>
          <button
            className={`${s.sideBtn} ${side === "pay" ? s.activePay : s.inactive}`}
            onClick={() => setSide("pay")}
            type="button"
          >
            <span>PAY FIXED ↓</span>
            <span className={s.sideBtnCap}>Hedge your variable yield</span>
          </button>
          <button
            className={`${s.sideBtn} ${side === "receive" ? s.activeReceive : s.inactive}`}
            onClick={() => setSide("receive")}
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
            <input defaultValue="10,000" />
            <span className="suffix">USDC</span>
          </div>
          <div className={s.qpRow}>
            {["25%", "50%", "75%", "MAX"].map((q) => (
              <button key={q} className={s.qp} type="button">
                {q}
              </button>
            ))}
          </div>
        </div>

        <div className={s.field}>
          <span className={s.fieldLabel}>Collateral</span>
          <div className={s.inputBox}>
            <span className="prefix">$</span>
            <input defaultValue="500" />
            <span className="suffix">USDC</span>
          </div>
          <div className={s.hint}>
            Minimum: <span className={s.muted}>$247.50</span> · Current:{" "}
            <span className="pink-text">2.02×</span> initial margin
          </div>
        </div>

        <div className={s.field}>
          <span className={s.fieldLabel}>Effective Leverage</span>
          <div className={s.levRow}>
            <div className={s.levBar}>
              <div className={s.levBarFill} style={{ width: `${levPct}%` }} />
              <div className={s.levTick} style={{ left: `calc(${warnPct}% - 1px)` }} />
              <div className={s.levWarn} style={{ left: `${warnPct}%` }}>
                HIGH RISK
              </div>
            </div>
            <span className={s.levVal}>{lev.toFixed(1)}×</span>
          </div>
          <div className={s.levScale} style={{ marginTop: 22 }}>
            <span>1×</span>
            <span>2.5×</span>
            <span>5×</span>
            <span>7.5×</span>
            <span>10×</span>
          </div>
        </div>

        <div className={s.preview}>
          <span className={s.eyebrow}>Position Preview</span>
          <div className={s.previewRow}>
            <span className={s.previewKey}>Locked fixed rate</span>
            <span className={`${s.previewValue} pink-text`}>8.20%</span>
          </div>
          <div className={s.previewRow}>
            <span className={s.previewKey}>Variable rate exposure</span>
            <span className={`${s.previewValue} ${s.muted}`}>Floating</span>
          </div>
          <div className={s.previewRow}>
            <span className={s.previewKey}>Effective leverage</span>
            <span className={`${s.previewValue} pink-text`}>4.2×</span>
          </div>
          <div className={s.previewRow}>
            <span className={s.previewKey}>Maint. margin</span>
            <span className={`${s.previewValue} ${s.muted}`}>$247.50</span>
          </div>
          <div className={s.previewRow}>
            <span className={s.previewKey}>Liquidation rate</span>
            <span className={`${s.previewValue} red-text`} style={{ color: "var(--red)" }}>15.8%</span>
          </div>
          <div className={s.previewRow}>
            <span className={s.previewKey}>Est. max loss</span>
            <span className={`${s.previewValue}`} style={{ color: "var(--red)" }}>−$500</span>
          </div>
          <div className={s.previewRow}>
            <span className={s.previewKey}>Maturity</span>
            <span className={`${s.previewValue} ${s.muted}`}>May 23, 2026</span>
          </div>
          <div className={s.previewRow}>
            <span className={s.previewKey}>Daily settlement</span>
            <span className={`${s.previewValue} ${s.muted}`}>Every 24h</span>
          </div>
        </div>

        <button className={`${s.cta} ${s.disabled}`} type="button">
          Open {side === "pay" ? "PayFixed" : "ReceiveFixed"} Position →
        </button>
        <div className={s.ctaLock}>
          <LockGlyph /> Connect wallet to open a position
        </div>

        <div className={s.fine}>
          By opening, you agree to daily on-chain settlement and margin liquidation rules.
          Slippage tolerance 0.5%. Estimated gas: 0.00008 SOL.
        </div>
      </div>
    </div>
  );
}

function ImpactStrip() {
  return (
    <div className={s.impactStrip}>
      <div className={`wrap ${s.impactGrid}`}>
        <div className={s.impactItem}>
          <span className={s.impactKey}>Your notional share</span>
          <span className={s.impactValue}>0.12% of pool</span>
        </div>
        <div className={s.impactItem}>
          <span className={s.impactKey}>New pool utilization</span>
          <span className={s.impactValue}>
            34% <span className={s.arrowRight}>→</span> 36%
          </span>
        </div>
        <div className={s.impactItem}>
          <span className={s.impactKey}>Spread impact</span>
          <span className={s.impactValue}>+0.03 bps</span>
        </div>
        <div className={s.impactItem}>
          <span className={s.impactKey}>Slippage</span>
          <span className={s.impactValue}>&lt; 0.1%</span>
        </div>
      </div>
    </div>
  );
}

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
          <div className={s.tradesTitle}>Recent Trades · Kamino USDC 30D</div>
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

export default function TradePage() {
  return (
    <>
      <RevealOnScroll />
      <Nav />
      <MarketStrip />
      <section className={s.workspace}>
        <div className={`wrap ${s.workspaceGrid}`}>
          <LeftColumn />
          <OrderTicket />
        </div>
      </section>
      <ImpactStrip />
      <RecentTrades />
      <Footer />
    </>
  );
}
