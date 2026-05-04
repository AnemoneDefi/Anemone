"use client";

import { useMemo, useState } from "react";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { RevealOnScroll } from "@/components/RevealOnScroll";
import s from "./lp.module.css";

function PoolStrip() {
  return (
    <div className={s.poolStrip}>
      <div className={`wrap ${s.poolStripWrap}`}>
        <button className={s.mktSelect} type="button">
          <span className={s.mkDot}>K</span>
          <span>Kamino USDC Pool · 30D tenor</span>
          <span className={s.chev}>▾</span>
        </button>
        <div className={s.vDiv} />
        <div className={s.psStat}>
          <span className={s.psStatKey}>TVL</span>
          <span className={s.psStatValue}>$2.4M</span>
        </div>
        <div className={s.psStat}>
          <span className={s.psStatKey}>Estimated APY</span>
          <span className={`${s.psStatValue} ${s.pink}`}>9.3%</span>
        </div>
        <div className={s.psStat}>
          <span className={s.psStatKey}>Kamino base</span>
          <span className={s.psStatValue}>
            <span className={s.dotBlue} />6.8%
          </span>
        </div>
        <div className={s.psStat}>
          <span className={s.psStatKey}>Spread yield</span>
          <span className={s.psStatValue}>
            <span className={s.dotPinkStatic} />2.5%
          </span>
        </div>
        <div className={s.psStat}>
          <span className={s.psStatKey}>Utilization</span>
          <div className={s.utilMini}>
            <span className={s.psStatValue} style={{ fontSize: 14 }}>34%</span>
            <span className={s.utilBar}>
              <span className={s.utilBarFill} style={{ width: "34%" }} />
            </span>
          </div>
        </div>
        <div className={s.psStat}>
          <span className={s.psStatKey}>Pool direction</span>
          <div className={s.utilMini}>
            <span className={s.dirBar}>
              <span className={s.dirBarPay} style={{ width: "55%" }} />
              <span className={s.dirBarReceive} style={{ width: "45%" }} />
            </span>
            <span className={s.psStatValue} style={{ fontSize: 13 }}>Balanced</span>
          </div>
        </div>
        <div className={s.psRight}>
          <span>Last settlement 2h ago</span>
          <span>·</span>
          <span>
            <span className="dot-pink" style={{ animationDuration: "2.4s" }} />
            Keeper online
          </span>
        </div>
      </div>
    </div>
  );
}

function HeroChart() {
  const W = 720, H = 200, PADL = 44, PADR = 16, PADT = 8, PADB = 26;
  const yMin = 0, yMax = 12;
  const kamY = 6.8;
  const days = 30;
  const series = [
    8.4, 8.7, 9.1, 8.8, 9.0, 8.5, 7.9, 8.2, 8.6, 9.2,
    9.4, 9.1, 8.8, 8.3, 7.7, 7.1, 6.4, 5.2, 3.8, 2.4,
    1.5, 2.8, 4.6, 6.1, 7.3, 8.0, 8.6, 9.0, 9.1, 9.2, 9.3,
  ];
  const dates = ["Mar 24", "Mar 31", "Apr 07", "Apr 14", "Apr 21"];
  const xS = (i: number) => PADL + (i / days) * (W - PADL - PADR);
  const yS = (v: number) =>
    PADT + (1 - (v - yMin) / (yMax - yMin)) * (H - PADT - PADB);

  const linePath = series
    .map((v, i) => `${i === 0 ? "M" : "L"}${xS(i).toFixed(2)},${yS(v).toFixed(2)}`)
    .join(" ");

  const aboveFill = (() => {
    const pts: string[] = [`M${xS(0).toFixed(2)},${yS(kamY).toFixed(2)}`];
    for (let i = 0; i <= days; i++) {
      const y = Math.min(series[i], yMax);
      pts.push(`L${xS(i).toFixed(2)},${yS(Math.max(y, kamY)).toFixed(2)}`);
    }
    pts.push(`L${xS(days).toFixed(2)},${yS(kamY).toFixed(2)} Z`);
    return pts.join(" ");
  })();

  const belowFill = (() => {
    const pts: string[] = [`M${xS(0).toFixed(2)},${yS(kamY).toFixed(2)}`];
    for (let i = 0; i <= days; i++) {
      pts.push(`L${xS(i).toFixed(2)},${yS(Math.min(series[i], kamY)).toFixed(2)}`);
    }
    pts.push(`L${xS(days).toFixed(2)},${yS(kamY).toFixed(2)} Z`);
    return pts.join(" ");
  })();

  const ticks = [0, 3, 6, 9, 12];
  const lpEnd = series[days];
  const dipI = 20;
  const dipV = series[dipI];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", overflow: "visible", maxWidth: W }}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PADL} x2={W - PADR} y1={yS(t)} y2={yS(t)} stroke="#1e1f2a" strokeWidth={1} />
          <text x={PADL - 10} y={yS(t) + 3} fill="#5b6070" fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="end" letterSpacing={0.5}>
            {t}%
          </text>
        </g>
      ))}
      <path d={belowFill} fill="rgba(138,143,156,.12)" />
      <path d={aboveFill} fill="rgba(236,72,153,.10)" />
      <line x1={PADL} x2={W - PADR} y1={yS(kamY)} y2={yS(kamY)} stroke="#3b82f6" strokeWidth={1} strokeDasharray="4 4" opacity={0.85} />
      <text x={W - PADR} y={yS(kamY) - 7} fill="#3b82f6" fontSize="11" fontFamily="JetBrains Mono, monospace" textAnchor="end" fontWeight="500" letterSpacing=".06em">
        KAMINO DIRECT 6.8%
      </text>
      <path d={linePath} fill="none" stroke="#ec4899" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <text x={xS(4)} y={yS(10.2)} fill="#ec4899" fontSize="10" fontFamily="JetBrains Mono, monospace" opacity={0.7} letterSpacing=".08em">
        OUTPERFORMING KAMINO
      </text>
      <circle cx={xS(dipI)} cy={yS(dipV)} r={4} fill="#07080f" stroke="#8a8f9c" strokeWidth={1.5} />
      <line x1={xS(dipI)} x2={xS(dipI) + 36} y1={yS(dipV)} y2={yS(dipV) - 18} stroke="#5b6070" strokeWidth={1} />
      <text x={xS(dipI) + 40} y={yS(dipV) - 22} fill="#8a8f9c" fontSize="10" fontFamily="JetBrains Mono, monospace" letterSpacing=".06em">
        APR 14 · 1.5%
      </text>
      <text x={xS(dipI) + 40} y={yS(dipV) - 10} fill="#5b6070" fontSize="10" fontFamily="JetBrains Mono, monospace" letterSpacing=".06em">
        rate spike
      </text>
      <circle cx={xS(days)} cy={yS(lpEnd)} r={5} fill="#ec4899" stroke="#07080f" strokeWidth={2} />
      {dates.map((d, idx) => {
        const i = idx * 7;
        return (
          <text key={d} x={xS(i)} y={H - 6} fill="#5b6070" fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="middle" letterSpacing=".06em">
            {d.toUpperCase()}
          </text>
        );
      })}
    </svg>
  );
}

function Hero() {
  return (
    <section className={s.heroPitch}>
      <div className={`${s.heroInner} reveal`}>
        <div className="eyebrow">Provide Liquidity</div>
        <h1>Kamino yield, plus swap spread.</h1>

        <div className={s.apyHero}>
          <div className={s.apyChartCol}>
            <div className={s.apyChartHead}>
              <span className={s.apyEyebrow}>Realized APY · Last 30 Days</span>
              <div className={s.apyToggle}>
                <button className={s.apyTg} type="button">7D</button>
                <button className={`${s.apyTg} ${s.active}`} type="button">30D</button>
                <button className={s.apyTg} type="button">ALL</button>
              </div>
            </div>
            <HeroChart />
            <div className={s.apyFoot}>
              LP yield moves above and below Kamino direct as swap exposure settles.
            </div>
          </div>
          <div className={s.apySummary}>
            <div className={s.apySumBlock}>
              <span className={s.apySumLbl}>30D Average</span>
              <span className={s.apySumValue}>
                <span className="tilde">~</span>7.4%
              </span>
              <span className={s.apySumSub}>range 1.5% – 10.1%</span>
            </div>
            <div className={s.apySumSep} />
            <div className={s.apySumBlock}>
              <span className={s.apySumLbl}>Current</span>
              <span className={s.apySumValue}>
                <span className="tilde">~</span>9.3%
              </span>
              <span className={`${s.apySumSub} ${s.pink}`}>+2.5% vs Kamino</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function DepositCard() {
  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const share = 9847.23;

  return (
    <div className={`${s.card} ${s.depCard} reveal`}>
      <div className={s.staleBanner}>Pool NAV sync required — will auto-include in transaction.</div>
      <div className={s.depTabs}>
        <button
          className={`${s.depTab} ${tab === "deposit" ? s.active : ""}`}
          onClick={() => setTab("deposit")}
          type="button"
        >
          Deposit
        </button>
        <button
          className={`${s.depTab} ${tab === "withdraw" ? s.active : ""}`}
          onClick={() => setTab("withdraw")}
          type="button"
        >
          Withdraw
        </button>
      </div>
      <div className={s.depBody}>
        <div className={s.depRow}>
          <span className="eyebrow" style={{ display: "block", marginBottom: 10 }}>Amount</span>
          <div className={s.amountBox}>
            <span className="prefix">$</span>
            <input defaultValue="10,000" />
            <span className="suffix">USDC</span>
          </div>
          <div className={s.balHint}>
            Wallet balance: <span style={{ color: "var(--text-2)" }}>$24,500 USDC</span>
          </div>
          <div className={s.qpRow}>
            {["25%", "50%", "75%", "MAX"].map((q) => (
              <button key={q} className={s.qp} type="button">{q}</button>
            ))}
          </div>
        </div>

        <div className={s.depRow}>
          <span className="eyebrow" style={{ display: "block", marginBottom: 10 }}>You receive</span>
          <div className={s.receive}>
            <div className={s.receiveBig}>
              {share.toFixed(2)} <span style={{ color: "var(--text-2)", fontSize: 18 }}>aUSDC-A</span>
            </div>
            <div className={s.receiveSub}>
              Share price: $1.0155 · <span className="up">+1.55% since launch</span>
            </div>
          </div>
        </div>

        <div className={s.depRow}>
          <div className={s.proj}>
            <span className="eyebrow">Projected earnings (at current 9.3% APY)</span>
            <div className={s.projGrid}>
              <div className={s.projCell}>
                <span className={s.projCellKey}>30 days</span>
                <span className={s.projCellValue}>+$76.44</span>
              </div>
              <div className={s.projCell}>
                <span className={s.projCellKey}>90 days</span>
                <span className={s.projCellValue}>+$232.19</span>
              </div>
              <div className={s.projCell}>
                <span className={s.projCellKey}>1 year</span>
                <span className={s.projCellValue}>+$974.35</span>
              </div>
            </div>
          </div>
        </div>

        <div className={s.depRow}>
          <button className={`${s.ctaPrimary} ${s.disabled}`} type="button">
            {tab === "deposit" ? "Deposit →" : "Withdraw →"}
          </button>
          <div className={s.ctaHint}>Connect wallet to {tab}</div>
          <div className={s.finePrint}>Withdrawal fee 0.05% · May queue if pool committed.</div>
        </div>
      </div>
    </div>
  );
}

function LpChart() {
  const W = 420, H = 200, PADL = 10, PADR = 70, PADT = 14, PADB = 16;
  const days = 30;

  const lpSeries = useMemo(() => {
    const arr: number[] = [];
    for (let i = 0; i <= days; i++) arr.push(10000 * Math.pow(1 + 0.093 / 365, i));
    return arr;
  }, []);

  const kamSeries = useMemo(() => {
    const arr: number[] = [];
    for (let i = 0; i <= days; i++) arr.push(10000 * Math.pow(1 + 0.068 / 365, i));
    return arr;
  }, []);

  const yMin = 9995;
  const yMax = Math.max(...lpSeries) + 5;
  const xS = (i: number) => PADL + (i / days) * (W - PADL - PADR);
  const yS = (v: number) => PADT + (1 - (v - yMin) / (yMax - yMin)) * (H - PADT - PADB);
  const pathOf = (arr: number[]) =>
    arr.map((v, i) => `${i === 0 ? "M" : "L"}${xS(i).toFixed(2)},${yS(v).toFixed(2)}`).join(" ");

  const lpPath = pathOf(lpSeries);
  const kamPath = pathOf(kamSeries);

  const gapPath = `${lpPath} L${xS(days).toFixed(2)},${yS(kamSeries[days]).toFixed(2)} ${kamSeries
    .slice()
    .reverse()
    .map((v, j) => `L${xS(days - j).toFixed(2)},${yS(v).toFixed(2)}`)
    .join(" ")} Z`;

  const lpEnd = lpSeries[days];
  const kamEnd = kamSeries[days];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: "auto", display: "block", overflow: "visible" }}>
      <path d={gapPath} fill="rgba(236,72,153,.1)" />
      <path d={kamPath} fill="none" stroke="#3b82f6" strokeWidth={1.5} strokeDasharray="4 3" opacity={0.85} />
      <path d={lpPath} fill="none" stroke="#ec4899" strokeWidth={2} />
      <circle cx={xS(days)} cy={yS(lpEnd)} r={3.5} fill="#ec4899" />
      <circle cx={xS(days)} cy={yS(kamEnd)} r={3} fill="#3b82f6" />
      <text x={xS(days) + 8} y={yS(lpEnd) + 4} fill="#ec4899" fontSize="10" fontFamily="JetBrains Mono, monospace" fontWeight="600">
        ${lpEnd.toFixed(2)}
      </text>
      <text x={xS(days) + 8} y={yS(kamEnd) + 4} fill="#3b82f6" fontSize="10" fontFamily="JetBrains Mono, monospace">
        ${kamEnd.toFixed(2)}
      </text>
      <text x={PADL} y={H - 4} fill="#5b6070" fontSize="9" fontFamily="JetBrains Mono, monospace" letterSpacing={1}>
        DAY 0
      </text>
      <text x={xS(days) - 8} y={H - 4} fill="#5b6070" fontSize="9" fontFamily="JetBrains Mono, monospace" letterSpacing={1} textAnchor="end">
        DAY 30
      </text>
    </svg>
  );
}

function PositionCard() {
  return (
    <div className={`${s.card} ${s.posCard} reveal`}>
      <div className={s.posHead}>
        <h3>Your Position</h3>
        <span className={s.posPill}>
          <span className="tok">A</span>aUSDC-A
        </span>
      </div>
      <table className={s.posTbl}>
        <tbody>
          <tr><td>Shares held</td><td>9,847.23 aUSDC-A</td></tr>
          <tr><td>Current value</td><td>$10,152.80</td></tr>
          <tr><td>Deposited</td><td>$10,000.00</td></tr>
          <tr className={s.totalEarn}><td>Total earned</td><td>+$152.80</td></tr>
          <tr className={s.indent}>
            <td>
              <span className={s.withDot}>
                <span className={s.dotBlue} />Kamino base
              </span>
            </td>
            <td>+$112.34</td>
          </tr>
          <tr className={s.indent}>
            <td>
              <span className={s.withDot}>
                <span className={s.dotPinkStatic} />Spread yield
              </span>
            </td>
            <td>+$40.46</td>
          </tr>
          <tr><td>Your share of pool</td><td>0.42%</td></tr>
        </tbody>
      </table>

      <div className={s.posChart}>
        <div className={s.posChartTitle}>Your LP value vs Kamino direct</div>
        <LpChart />
        <div className={s.posChartCaption}>
          Spread yield has added <span className="earn">+$40.46</span> beyond Kamino base.
        </div>
      </div>

      <div className={s.posStatus}>
        <span className={s.posStatusLabel}>Withdraw status</span>
        <span className={s.posStatusValue}>
          <span className={s.posStatusOk}>
            <span className="dot-pink" />Instant withdrawal available
          </span>
          · $2.4M free in Kamino
        </span>
      </div>
    </div>
  );
}

function Gauge({ pct = 34, cap = 60 }: { pct?: number; cap?: number }) {
  const R = 90, CX = 110, CY = 100, SW = 16;
  const angle = (p: number) => Math.PI * (1 - p / 100);
  const polar = (p: number) => ({ x: CX + R * Math.cos(angle(p)), y: CY - R * Math.sin(angle(p)) });
  const arcPath = (from: number, to: number, color: string) => {
    const a = polar(from), b = polar(to);
    const large = to - from > 50 ? 1 : 0;
    return (
      <path
        d={`M${a.x},${a.y} A${R},${R} 0 ${large} 1 ${b.x},${b.y}`}
        stroke={color}
        strokeWidth={SW}
        fill="none"
        strokeLinecap="round"
      />
    );
  };
  const needle = polar(pct);

  return (
    <div className={s.gaugeWrap}>
      <svg viewBox="0 0 220 120" style={{ width: "100%", height: "auto", display: "block" }}>
        <path
          d={`M${polar(0).x},${polar(0).y} A${R},${R} 0 0 1 ${polar(cap).x},${polar(cap).y}`}
          stroke="#1e1f2a"
          strokeWidth={SW}
          fill="none"
          strokeLinecap="round"
        />
        <path
          d={`M${polar(cap).x},${polar(cap).y} A${R},${R} 0 0 1 ${polar(100).x},${polar(100).y}`}
          stroke="rgba(239,68,68,.35)"
          strokeWidth={SW}
          fill="none"
          strokeLinecap="round"
        />
        {arcPath(0, pct, "#ec4899")}
        <circle cx={needle.x} cy={needle.y} r={5} fill="#ec4899" stroke="#07080f" strokeWidth={2} />
        <text x={polar(0).x} y={polar(0).y + 16} fill="#5b6070" fontSize="9" fontFamily="JetBrains Mono, monospace" textAnchor="start">0%</text>
        <text x={polar(cap).x - 4} y={polar(cap).y - 10} fill="#5b6070" fontSize="9" fontFamily="JetBrains Mono, monospace" textAnchor="middle">{cap}% CAP</text>
        <text x={polar(100).x} y={polar(100).y + 16} fill="#5b6070" fontSize="9" fontFamily="JetBrains Mono, monospace" textAnchor="end">100%</text>
      </svg>
      <div className={s.gaugeRead}>
        <div className={s.gaugeReadValue}>{pct}%</div>
        <div className={s.gaugeReadCap}>of {cap}% cap</div>
      </div>
    </div>
  );
}

function Spark() {
  const W = 240, H = 60, PADT = 4, PADB = 4;
  const vals = [1.9, 2.1, 2.4, 2.2, 2.0, 1.8, 2.3, 2.6, 2.9, 3.1, 2.8, 2.5, 2.3, 2.5];
  const yMin = 1.6, yMax = 3.3;
  const xS = (i: number) => (i / (vals.length - 1)) * W;
  const yS = (v: number) => PADT + (1 - (v - yMin) / (yMax - yMin)) * (H - PADT - PADB);
  const path = vals.map((v, i) => `${i === 0 ? "M" : "L"}${xS(i).toFixed(1)},${yS(v).toFixed(1)}`).join(" ");
  const area = `${path} L${W},${H} L0,${H} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={s.sparkBox}>
      <path d={area} fill="rgba(236,72,153,.08)" />
      <path d={path} fill="none" stroke="#ec4899" strokeWidth={1.8} />
      <circle cx={xS(vals.length - 1)} cy={yS(vals[vals.length - 1])} r={2.5} fill="#ec4899" />
    </svg>
  );
}

function Health() {
  return (
    <section className={s.health}>
      <div className={`wrap ${s.healthGrid}`}>
        <div className={`${s.card} ${s.healthCard} reveal`}>
          <div className={s.hTitle}>Pool Utilization</div>
          <Gauge pct={34} cap={60} />
        </div>
        <div className={`${s.card} ${s.healthCard} reveal`}>
          <div className={s.hTitle}>Pool Direction</div>
          <div className={s.dir}>
            <div className={s.dirChart} style={{ marginTop: 18 }}>
              <div className={`${s.dirSeg} ${s.pay}`} style={{ flexBasis: "54%" }}>
                PayFixed $4.4M
              </div>
              <div className={`${s.dirSeg} ${s.receive}`} style={{ flexBasis: "46%" }}>
                ReceiveFixed $3.7M
              </div>
              <div className={s.dirMarker} style={{ left: "54%" }} />
            </div>
            <div className={s.dirLegend}>
              <span>
                <span className={s.dotPinkStatic} style={{ marginRight: 6 }} />
                PayFixed counterparty
              </span>
              <span>
                ReceiveFixed counterparty
                <span className={s.dotBlue} style={{ marginLeft: 6 }} />
              </span>
            </div>
            <div className={s.dirSummary} style={{ marginTop: 10 }}>
              Net exposure: $700K PayFixed · Balanced market
            </div>
          </div>
        </div>
        <div className={`${s.card} ${s.healthCard} reveal`}>
          <div className={s.hTitle}>Spread APY (7D)</div>
          <div className={s.sparkWrap}>
            <div className={s.sparkRead}>
              <span className={s.sparkReadValue}>2.5%</span>
              <span className={s.sparkReadAvg}>avg: 2.4%</span>
            </div>
          </div>
          <Spark />
        </div>
      </div>
    </section>
  );
}

export default function LpPage() {
  return (
    <>
      <RevealOnScroll />
      <Nav />
      <PoolStrip />
      <Hero />
      <section className={s.workspace}>
        <div className={`wrap ${s.workspaceGrid}`}>
          <DepositCard />
          <PositionCard />
        </div>
      </section>
      <Health />
      <Footer />
    </>
  );
}
