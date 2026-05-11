"use client";

import Link from "next/link";
import Image from "next/image";
import { useMemo } from "react";
import { RevealOnScroll } from "@/components/RevealOnScroll";
import { useMarkets } from "@/lib/hooks";
import {
  calculateApyBps,
  formatBps,
  formatUsdcCompact,
} from "@/lib/format";
import { calculateSpread } from "@/lib/risk";
import { MarketStatus, SwapDirection, type Market } from "@anemonedefi/sdk";

interface LandingDerived {
  variableBps: bigint;
  fixedBps: bigint;
  spreadBps: bigint;
  marketTvlText: string;
  totalTvlText: string;
  openNotionalText: string;
  avgApyText: string;
  liveCount: number;
}

function deriveLandingStats(markets: Market[] | undefined): LandingDerived {
  const fallback: LandingDerived = {
    variableBps: 0n,
    fixedBps: 0n,
    spreadBps: 0n,
    marketTvlText: "—",
    totalTvlText: "—",
    openNotionalText: "—",
    avgApyText: "—",
    liveCount: 0,
  };
  if (!markets || markets.length === 0) return fallback;

  const live = markets.filter((m) => m.status === MarketStatus.Active);
  if (live.length === 0) return fallback;

  // Pick the first live market for the hero dashcard.
  const focus = live[0];
  const elapsed =
    focus.lastRateUpdateTs > focus.previousRateUpdateTs
      ? focus.lastRateUpdateTs - focus.previousRateUpdateTs
      : 0n;
  const variableBps = calculateApyBps(
    focus.previousRateIndex,
    focus.currentRateIndex,
    elapsed
  );
  // Landing page shows the PayFixed quote as a default headline rate.
  const spread = calculateSpread(
    focus.baseSpreadBps,
    focus.maxUtilizationBps,
    focus.lpNav,
    focus.totalFixedNotional,
    focus.totalVariableNotional,
    SwapDirection.PayFixed
  );
  const fixedBps = variableBps + spread.totalBps;

  const totalTvl = live.reduce((sum, m) => sum + m.lpNav, 0n);
  const totalNotional = live.reduce(
    (sum, m) => sum + m.totalFixedNotional + m.totalVariableNotional,
    0n
  );
  // Avg APY across markets weighted equally — simplification, fine for landing.
  const avgApyBps =
    live.length > 0
      ? live.reduce((sum, m) => {
          const e =
            m.lastRateUpdateTs > m.previousRateUpdateTs
              ? m.lastRateUpdateTs - m.previousRateUpdateTs
              : 0n;
          return sum + calculateApyBps(m.previousRateIndex, m.currentRateIndex, e);
        }, 0n) / BigInt(live.length)
      : 0n;

  return {
    variableBps,
    fixedBps,
    spreadBps: spread.totalBps,
    marketTvlText: formatUsdcCompact(focus.lpNav),
    totalTvlText: formatUsdcCompact(totalTvl),
    openNotionalText: formatUsdcCompact(totalNotional),
    avgApyText: formatBps(avgApyBps),
    liveCount: live.length,
  };
}

function LandingNav() {
  return (
    <nav className="top">
      <div className="wrap">
        <Link className="brand" href="/">
          <span>Anemone</span>
        </Link>
        <div className="navlinks">
          <a href="#problem">Problem</a>
          <a href="#solution">Solution</a>
          <a href="#how">How</a>
          <a href="#market">Market</a>
        </div>
        <div className="nav-right">
          <div className="badge">
            <span className="dot-pink" />
            Live on Solana Devnet
          </div>
          <Link href="/markets" className="btn btn-primary">
            Launch App
          </Link>
        </div>
      </div>
    </nav>
  );
}

function HeroChartSvg() {
  return (
    <svg viewBox="0 0 480 200" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
      <defs>
        <linearGradient id="gfill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="rgba(59,130,246,.18)" />
          <stop offset="100%" stopColor="rgba(59,130,246,0)" />
        </linearGradient>
      </defs>
      <g opacity={0.22} stroke="#1e1f2a">
        <line x1={36} y1={40} x2={470} y2={40} />
        <line x1={36} y1={100} x2={470} y2={100} />
        <line x1={36} y1={160} x2={470} y2={160} />
      </g>
      <g fontFamily="JetBrains Mono, monospace" fontSize="8" fill="#5b6070">
        <text x={30} y={43} textAnchor="end">12%</text>
        <text x={30} y={103} textAnchor="end">8%</text>
        <text x={30} y={163} textAnchor="end">4%</text>
      </g>
      {/* Anemone Fixed reference: a thin dashed line at the 8% mark so the
          viewer can see what locking in fixed looks like vs the Kamino
          variable curve. The variable line genuinely oscillates above and
          below — the value of fixed comes from removing volatility, not
          from being numerically higher every minute. */}
      <line x1={36} y1={100} x2={470} y2={100} stroke="#ec4899" strokeWidth={1} strokeDasharray="4 4" opacity={0.85} />
      <text x={44} y={94} fill="#ec4899" fontFamily="JetBrains Mono, monospace" fontSize="9" letterSpacing={0.5}>
        ANEMONE FIXED 8.20%
      </text>
      {/* Variable rate (Kamino) — starts near fixed, then drops materially
          and stays below. Tells the rate-cut story that makes locking the
          fixed rate ahead of the drop the right call. */}
      <path
        d="M36 108 L60 100 L84 94 L108 98 L132 92 L156 100 L180 112 L204 124 L228 136 L252 142 L276 138 L300 130 L324 124 L348 130 L372 136 L396 130 L420 125 L444 132 L470 130"
        fill="none"
        stroke="#3b82f6"
        strokeWidth={1.4}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path
        d="M36 108 L60 100 L84 94 L108 98 L132 92 L156 100 L180 112 L204 124 L228 136 L252 142 L276 138 L300 130 L324 124 L348 130 L372 136 L396 130 L420 125 L444 132 L470 130 L470 178 L36 178 Z"
        fill="url(#gfill)"
        opacity={0.55}
      />
      <circle cx={470} cy={130} r={2.5} fill="#3b82f6" />
    </svg>
  );
}

function Hero({ derived }: { derived: LandingDerived }) {
  return (
    <section className="hero">
      <div className="wrap">
        <div className="hero-grid">
          <div className="card-anchor-line" />
          <div className="hero-left reveal">
            <div className="eyebrow">
              Interest Rate Swaps · Solana
              <span className="version-chip">v0.1</span>
            </div>
            <h1 className="h1" style={{ marginTop: 24 }}>
              Lock your <span className="grad-text">yield</span>.
              <br />
              Trade the rest.
            </h1>
            <p className="sub" style={{ marginTop: 28, maxWidth: 520 }}>
              On-chain interest rate swaps built for Solana speed. Lock in a
              fixed rate against any major lending protocol, or provide
              liquidity and earn the spread on 100% deployed capital.
            </p>
            <div className="hero-ctas">
              <Link href="/markets" className="btn btn-primary lg">
                Launch App →
              </Link>
            </div>
            <div className="trust-bar">
              <span className="logo-img">
                <Image src="/logos/colosseum.png" alt="Colosseum" width={24} height={24} />
              </span>
              <span>2026</span>
              <span className="muted-2">·</span>
              <span>Built on</span>
              <span className="logo-img">
                <Image src="/logos/solana.png" alt="Solana" width={88} height={22} />
              </span>
              <span className="muted-2">·</span>
              <span>Integrated with</span>
              <span className="logo-img">
                <Image src="/logos/kamino.png" alt="Kamino" width={24} height={24} />
              </span>
            </div>
          </div>

          <div className="hero-right reveal">
            <div className="hero-mock">
              <div className="dashcard card-edge">
                <div className="dc-head">
                  <span className="mono" style={{ fontSize: 11, letterSpacing: ".1em" }}>
                    KAMINO USDC · 30D
                  </span>
                  <span className="live">
                    <span className="dot-pink" />Live
                  </span>
                </div>
                <div className="dc-chart">
                  <HeroChartSvg />
                </div>
                <div className="dc-stats">
                  <div className="dc-tile variable">
                    <div className="k">Variable</div>
                    <div className="v num">
                      {derived.variableBps > 0n ? formatBps(derived.variableBps) : "—"}
                    </div>
                  </div>
                  <div className="dc-tile fixed">
                    <div className="k">Fixed</div>
                    <div className="v num">
                      {derived.fixedBps > 0n ? formatBps(derived.fixedBps) : "—"}
                    </div>
                  </div>
                  <div className="dc-tile">
                    <div className="k">Spread</div>
                    <div className="v num">
                      {derived.spreadBps > 0n ? formatBps(derived.spreadBps) : "—"}
                    </div>
                  </div>
                </div>
              </div>
              <div className="hero-foot mono">
                {derived.liveCount > 0
                  ? `Live on Solana · TVL ${derived.marketTvlText} · ${derived.liveCount} active market${derived.liveCount === 1 ? "" : "s"}`
                  : "Connect to RPC to see live rates"}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Protocols({ derived }: { derived: LandingDerived }) {
  const kaminoApy =
    derived.variableBps > 0n ? formatBps(derived.variableBps) : "—";
  const items = [
    {
      key: "kamino",
      name: "Kamino K-Lend",
      glyph: "K",
      active: true,
      slabel: "USDC · 30-day tenor",
      apy: kaminoApy,
      apyLabel: "Variable APY",
      href: "/trade",
    },
    { key: "solend",   name: "Solend",   glyph: "S", active: false, slabel: "Rolling out Q3 2026", tooltip: "Expected Q3 2026" },
    { key: "marginfi", name: "MarginFi", glyph: "M", active: false, slabel: "Rolling out Q3 2026", tooltip: "Expected Q3 2026" },
    { key: "drift",    name: "Drift",    glyph: "D", active: false, slabel: "Rolling out Q3 2026", tooltip: "Expected Q3 2026" },
  ];

  return (
    <section className="protocols">
      <div className="wrap">
        <div className="head reveal">
          <h2 className="title">Supported protocols</h2>
          <p className="sub">Start with Kamino on devnet — Solend, MarginFi, and Drift rolling out next.</p>
        </div>
        <div className="proto-list reveal">
          {items.map((p) => (
            <div key={p.key} className={`proto-row ${p.active ? "active" : "inactive"}`}>
              <div className="proto-id">
                <div className="logo">{p.glyph}</div>
                <div style={{ minWidth: 0 }}>
                  <div className="name">{p.name}</div>
                  <div className="slabel">{p.slabel}</div>
                </div>
              </div>
              <span className={`proto-badge ${p.active ? "live" : "soon"}`}>
                {p.active ? "LIVE" : "SOON"}
              </span>
              <div className="proto-apy-col">
                {p.active ? (
                  <>
                    <div className="proto-apy">{p.apy}</div>
                    <div className="proto-apy-label">{p.apyLabel}</div>
                  </>
                ) : (
                  <>
                    <div className="proto-apy placeholder">—</div>
                    <div className="proto-apy-label">Rolling out</div>
                  </>
                )}
              </div>
              <div className="proto-action">
                {p.active && p.href ? (
                  <Link href={p.href} className="proto-cta primary">Open Swap →</Link>
                ) : (
                  <button className="proto-cta disabled" aria-disabled type="button">
                    Coming soon
                    <span className="tooltip">{p.tooltip}</span>
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="foot reveal">
          More protocols added based on community demand — suggest one on <a href="#">Discord</a>.
        </div>
      </div>
    </section>
  );
}

function StatsBar({ derived }: { derived: LandingDerived }) {
  return (
    <div className="stats-bar">
      <div className="grid">
        <div className="stat">
          <div className="v num">{derived.totalTvlText}</div>
          <div className="underline" />
          <div className="k">Protocol TVL</div>
        </div>
        <div className="stat">
          <div className="v num">{derived.openNotionalText}</div>
          <div className="underline" />
          <div className="k">Open Notional</div>
        </div>
        <div className="stat">
          <div className="v num">{derived.avgApyText}</div>
          <div className="underline" />
          <div className="k">Avg LP APY</div>
        </div>
        <div className="stat">
          <div className="v num">$3.6B</div>
          <div className="underline" />
          <div className="k">Solana Lending TVL</div>
          <div className="sub">the addressable rate market</div>
        </div>
      </div>
    </div>
  );
}

function ProblemChartSvg() {
  return (
    <svg viewBox="0 0 1200 300" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
      <defs>
        <linearGradient id="pfill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="rgba(59,130,246,.16)" />
          <stop offset="100%" stopColor="rgba(59,130,246,0)" />
        </linearGradient>
      </defs>
      <g opacity={0.2} stroke="#1e1f2a">
        <line x1={0} y1={60} x2={1200} y2={60} />
        <line x1={0} y1={140} x2={1200} y2={140} />
        <line x1={0} y1={220} x2={1200} y2={220} />
      </g>
      <text x={24} y={56} fill="#5b6070" fontFamily="JetBrains Mono, monospace" fontSize="10">14%</text>
      <text x={24} y={146} fill="#5b6070" fontFamily="JetBrains Mono, monospace" fontSize="10">8%</text>
      <text x={24} y={226} fill="#5b6070" fontFamily="JetBrains Mono, monospace" fontSize="10">2%</text>

      <line x1={80} y1={140} x2={1160} y2={140} stroke="#ec4899" strokeWidth={1} strokeDasharray="5 5" opacity={0.75} />
      <text x={1150} y={134} fill="#ec4899" fontFamily="JetBrains Mono, monospace" fontSize="10" textAnchor="end" letterSpacing={0.5}>
        ANEMONE FIXED
      </text>

      <path
        d="M 80 190 C 160 150, 220 110, 280 85 C 340 65, 410 70, 480 110 C 540 145, 600 230, 700 240 C 800 250, 920 200, 1000 165 C 1080 135, 1130 165, 1160 190"
        fill="none"
        stroke="#3b82f6"
        strokeWidth={1.6}
      />
      <path
        d="M 80 190 C 160 150, 220 110, 280 85 C 340 65, 410 70, 480 110 C 540 145, 600 230, 700 240 C 800 250, 920 200, 1000 165 C 1080 135, 1130 165, 1160 190 L 1160 300 L 80 300 Z"
        fill="url(#pfill)"
        opacity={0.55}
      />

      <circle cx={310} cy={72} r={4} fill="#3b82f6" />
      <circle cx={720} cy={243} r={4} fill="#3b82f6" />
    </svg>
  );
}

function Problem() {
  return (
    <section id="problem">
      <div className="wrap">
        <div className="reveal">
          <div className="eyebrow">The Problem</div>
          <h2 className="h2" style={{ marginTop: 20, maxWidth: 880 }}>
            DeFi lending rates are unpredictable. You have no way to hedge.
          </h2>
        </div>
        <div className="problem-chart reveal">
          <ProblemChartSvg />
        </div>
        <div className="problem-caption reveal">
          Solana lending rates routinely swing from <span className="num">12%</span> to{" "}
          <span className="num">3%</span> within a week. A <span className="num">$100K</span>{" "}
          position can lose hundreds in expected monthly yield, with no recourse.
        </div>
        <div className="problem-close reveal">
          <div>Traders had no way to lock their rate.</div>
          <div>LPs had no way to earn on the volatility.</div>
        </div>
      </div>
    </section>
  );
}

function Solution() {
  const cards = [
    { theme: "pink",   t: "Pay Fixed",         d: "Hedge your variable yield. Pay a fixed rate, receive the floating Kamino rate. Certainty for 7, 14, or 30 days." },
    { theme: "blue",   t: "Receive Fixed",     d: "Speculate on falling rates. Receive fixed, pay floating. Leverage up to 10x on your rate view." },
    { theme: "pink",   t: "Provide Liquidity", d: "Deposit USDC. 100% of capital is deployed to yield-bearing strategies, plus every swap spread accrues to you." },
  ];
  return (
    <section id="solution">
      <div className="wrap">
        <div className="reveal">
          <div className="eyebrow">The Solution</div>
          <h2 className="h2" style={{ marginTop: 20 }}>Interest rate swaps. Native to Solana.</h2>
        </div>
        <div className="sol-grid">
          {cards.map((c, i) => (
            <div key={i} className={`sol-card card-edge themed-${c.theme} reveal`}>
              <h3>{c.t}</h3>
              <p>{c.d}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function How() {
  const steps: { n: string; t: React.ReactNode }[] = [
    { n: "01", t: <><b>LPs deposit USDC</b> into yield-bearing strategies (100% deployed)</> },
    { n: "02", t: <><b>Traders open swaps</b> against the LP pool, posting margin</> },
    { n: "03", t: <><b>Keeper reads</b> on-chain lending rates and settles P&L daily</> },
    { n: "04", t: <><b>At maturity</b>, principal stays with LPs, P&L distributed</> },
  ];
  return (
    <section id="how">
      <div className="wrap">
        <div className="reveal">
          <div className="eyebrow">Under the Hood</div>
          <h2 className="h2" style={{ marginTop: 20 }}>No oracles. No vAMMs. Just Solana.</h2>
        </div>
        <div className="how-wrap">
          <div className="how-connector" />
          <div className="how-grid">
            {steps.map((s) => (
              <div key={s.n} className="step reveal">
                <div className="n">{s.n} ·</div>
                <div className="t">{s.t}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="callout reveal card-edge">
          <div className="k">Why this only works on Solana</div>
          <div className="v">
            Daily settlement costs <b>$0.002</b> per position. The same transaction on Ethereum would cost <b>$50+</b>.
          </div>
        </div>
      </div>
    </section>
  );
}

function TradeMock() {
  // Sparkline mimicking the live rate chart on the trade page.
  const pts = [6.2, 6.5, 6.4, 6.9, 7.3, 7.1, 7.0, 7.4, 7.8, 7.5, 7.6, 7.42];
  const W = 360;
  const H = 64;
  const yMin = 5.5;
  const yMax = 8.5;
  const xS = (i: number) => (i / (pts.length - 1)) * W;
  const yS = (v: number) => H - ((v - yMin) / (yMax - yMin)) * H;
  const line = pts.map((v, i) => `${i === 0 ? "M" : "L"}${xS(i).toFixed(1)},${yS(v).toFixed(1)}`).join(" ");
  return (
    <div className="mock mock-trade">
      <div className="mock-head">
        <span className="mock-tag">KAMINO USDC · 30D</span>
        <div className="mock-rates">
          <div><span className="lbl">VAR</span><span className="val blue">7.42%</span></div>
          <div><span className="lbl">FIX</span><span className="val pink">8.36%</span></div>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="mock-spark" preserveAspectRatio="none">
        <defs>
          <linearGradient id="mock-trade-grad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgba(59,130,246,.30)" />
            <stop offset="100%" stopColor="rgba(59,130,246,0)" />
          </linearGradient>
        </defs>
        <path d={`${line} L${W},${H} L0,${H} Z`} fill="url(#mock-trade-grad)" />
        <path d={line} fill="none" stroke="#3b82f6" strokeWidth="1.4" />
      </svg>
      <div className="mock-buttons">
        <div className="mock-btn pink">PAY FIXED</div>
        <div className="mock-btn ghost">RECEIVE FIXED</div>
      </div>
      <div className="mock-meta">
        <span>Notional <b>$5,000</b></span>
        <span className="dot">·</span>
        <span>Margin <b>$123.29</b></span>
        <span className="dot">·</span>
        <span>Liq @ <b>11.8%</b></span>
      </div>
    </div>
  );
}

function LpMock() {
  return (
    <div className="mock mock-lp">
      <div className="mock-stream">
        <span className="stream-lbl">KAMINO BASE</span>
        <div className="stream-bar"><div className="stream-fill blue" style={{ width: "62%" }} /></div>
        <span className="stream-val blue">6.8%</span>
      </div>
      <div className="mock-plus">+</div>
      <div className="mock-stream">
        <span className="stream-lbl">SWAP SPREAD</span>
        <div className="stream-bar"><div className="stream-fill pink" style={{ width: "40%" }} /></div>
        <span className="stream-val pink">4.4%</span>
      </div>
      <div className="mock-total">
        <span className="total-lbl">TOTAL LP APY</span>
        <span className="total-val">11.2%</span>
        <span className="total-sub">blended on 100% of capital</span>
      </div>
    </div>
  );
}

function PortfolioMock() {
  return (
    <div className="mock mock-portfolio">
      <div className="pos-head">
        <span className="pos-tag pink">PAY FIXED</span>
        <span className="pos-meta">$5,000 · 30D · Kamino USDC</span>
      </div>
      <div className="pos-row">
        <span className="pos-k">P&amp;L</span>
        <span className="pos-v positive">+$4.18</span>
        <span className="pos-sub">settled 23h ago</span>
      </div>
      <div className="pos-row">
        <span className="pos-k">Collateral</span>
        <span className="pos-v">$119.77 / $123.29</span>
        <span className="pos-sub">healthy</span>
      </div>
      <div className="pos-row">
        <span className="pos-k">Next settlement</span>
        <span className="pos-v">18h 24m</span>
        <span className="pos-sub">automatic</span>
      </div>
      <div className="pos-progress">
        <div className="pos-progress-fill" style={{ width: "76%" }} />
      </div>
    </div>
  );
}

function Showcase() {
  const rows: { reverse: boolean; t: string; p: string; mock: React.ReactNode }[] = [
    {
      reverse: false,
      t: "A trading surface built for rates.",
      p: "Execute PayFixed or ReceiveFixed in two clicks. See your effective fixed rate, maintenance margin, and liquidation price before signing.",
      mock: <TradeMock />,
    },
    {
      reverse: true,
      t: "LPs earn on both sides of the book.",
      p: "Base Kamino yield plus swap spreads from every position. Dynamic spread widens when demand is imbalanced — LPs are paid more when risk is higher.",
      mock: <LpMock />,
    },
    {
      reverse: false,
      t: "Real-time P&L. On-chain settlement.",
      p: "Every 24 hours your positions settle against the actual Kamino rate. No oracle manipulation, no off-chain dependencies, no trust.",
      mock: <PortfolioMock />,
    },
  ];
  return (
    <section>
      <div className="wrap">
        {rows.map((r, i) => (
          <div key={i} className={`show-row reveal ${r.reverse ? "reverse" : ""}`}>
            <div className="shot">{r.mock}</div>
            <div className="show-copy">
              <h3>{r.t}</h3>
              <p>{r.p}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Market() {
  return (
    <section id="market">
      <div className="wrap market">
        <div className="inner">
          <div className="eyebrow reveal">Market Opportunity</div>
          <div className="big blue-text reveal">$3.6B</div>
          <div className="cap reveal">
            Total lending TVL on Solana — every dollar of floating-rate exposure that could be hedged or traded.
          </div>

          <div className="bars reveal">
            <div className="bar-row">
              <div className="lbl">Solana Lending TVL</div>
              <div className="track"><div className="fill lendingTvl" style={{ width: "100%" }} /></div>
              <div className="val">$3.6B</div>
            </div>
            <div className="bar-row">
              <div className="lbl">Floating-Rate Exposure</div>
              <div className="track"><div className="fill exposure" style={{ width: "78%" }} /></div>
              <div className="val">~$2.8B</div>
            </div>
            <div className="bar-row">
              <div className="lbl">Hedged On-Chain</div>
              <div className="track"><div className="fill hedged" style={{ width: "0.3%" }} /></div>
              <div className="val">&lt;$10M</div>
            </div>
          </div>

          <div className="close reveal">
            Less than <span className="num">0.4%</span> of Solana&apos;s floating-rate lending has any hedge available. We&apos;re building the rest.
          </div>
        </div>
      </div>
    </section>
  );
}

function Compare() {
  // Anemone is always [true, ...]; the two competitor columns mirror the
  // differentiator chart with Kamino dropped (no like-for-like product) and
  // names anonymized.
  // values: [Competitor 1, Competitor 2]   (was: Exponential, Port Finance)
  const features: { label: string; values: [boolean, boolean] }[] = [
    { label: "Pure IR Swap",               values: [false, true]  },
    { label: "100% LP Capital Efficiency", values: [true,  false] },
    { label: "Daily Settlement",           values: [false, false] },
    { label: "Unified Liquidity Pool",     values: [false, false] },
    { label: "Dynamic Spread",             values: [true,  false] },
  ];
  const competitors = ["Competitor 1", "Competitor 2"];
  return (
    <section>
      <div className="wrap">
        <div className="reveal">
          <div className="eyebrow">Why Anemone</div>
          <h2 className="h2" style={{ marginTop: 20 }}>Designed for what the others got wrong.</h2>
        </div>
        <div className="cmp reveal">
          <table>
            <thead>
              <tr>
                <th></th>
                <th className="col-us">Anemone</th>
                {competitors.map((c) => <th key={c}>{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {features.map((f) => (
                <tr key={f.label}>
                  <td className="row-k">{f.label}</td>
                  <td className="col-us"><CmpMark on /></td>
                  {f.values.map((v, i) => (
                    <td key={i}><CmpMark on={v} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function CmpMark({ on }: { on: boolean }) {
  if (on) {
    return (
      <span className="cmp-mark cmp-yes" aria-label="yes">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
          <path d="M3.5 8.5l3 3 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  return (
    <span className="cmp-mark cmp-no" aria-label="no">
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
        <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function Final() {
  return (
    <section className="final">
      <div className="wrap">
        <h2 className="reveal">
          Stop guessing your <span className="grad-text">yield</span>.
        </h2>
        <div className="sub reveal">Launch Anemone on Solana devnet.</div>
        <Link href="/markets" className="btn btn-primary lg reveal">
          Open the app →
        </Link>
        <div className="note reveal mono">Available on devnet. Mainnet coming soon.</div>
      </div>
    </section>
  );
}

function LandingFooter() {
  return (
    <footer className="foot">
      <div className="wrap">
        <div className="foot-bot">
          <span>Anemone Protocol · 2026 · Built on Solana</span>
        </div>
        <div className="disclaimer">
          Anemone is experimental software. Interest rate swaps carry liquidation risk.
          Do your own research.
        </div>
      </div>
    </footer>
  );
}

// Landing page lives at `/`. All landing CSS is scoped under `.landing-root`
// in globals.css so it can't leak into the dApp routes (/markets, /trade, etc).
export default function LandingPage() {
  const { data: markets } = useMarkets();
  const derived = useMemo(() => deriveLandingStats(markets), [markets]);

  return (
    <div className="landing-root">
      <RevealOnScroll />
      {/* atmospheric glows */}
      <div className="glow glow-hero-1" />
      <div className="glow glow-s1" />
      <div className="glow glow-s2" />
      <div className="glow glow-s3" />
      <div className="glow glow-s4" />

      <LandingNav />
      <Hero derived={derived} />
      <Protocols derived={derived} />
      <StatsBar derived={derived} />
      <Problem />
      <Solution />
      <How />
      <Showcase />
      <Market />
      <Compare />
      <Final />
      <LandingFooter />
    </div>
  );
}
