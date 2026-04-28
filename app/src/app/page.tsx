"use client";

import Link from "next/link";
import { RevealOnScroll } from "@/components/RevealOnScroll";

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
      <line x1={36} y1={100} x2={470} y2={100} stroke="#ec4899" strokeWidth={1} strokeDasharray="4 4" opacity={0.85} />
      <text x={44} y={94} fill="#ec4899" fontFamily="JetBrains Mono, monospace" fontSize="9" letterSpacing={0.5}>
        ANEMONE FIXED 8.20%
      </text>
      <path
        d="M36 118 L52 110 L68 116 L84 104 L100 98 L116 96 L132 98 L148 97 L164 96 L180 99 L196 96 L210 94 L224 152 L238 128 L254 108 L270 92 L288 82 L306 90 L322 74 L340 86 L358 70 L376 82 L394 76 L412 94 L430 86 L450 96 L470 90"
        fill="none"
        stroke="#3b82f6"
        strokeWidth={1.4}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path
        d="M36 118 L52 110 L68 116 L84 104 L100 98 L116 96 L132 98 L148 97 L164 96 L180 99 L196 96 L210 94 L224 152 L238 128 L254 108 L270 92 L288 82 L306 90 L322 74 L340 86 L358 70 L376 82 L394 76 L412 94 L430 86 L450 96 L470 90 L470 178 L36 178 Z"
        fill="url(#gfill)"
        opacity={0.55}
      />
      <circle cx={470} cy={90} r={2.5} fill="#3b82f6" />
    </svg>
  );
}

function Hero() {
  return (
    <section className="hero">
      <div className="wrap">
        <div className="hero-grid">
          <div className="card-anchor-line" />
          <div className="hero-left reveal">
            <div className="eyebrow">Interest Rate Swaps · Solana</div>
            <h1 className="h1" style={{ marginTop: 24 }}>
              Lock your <span className="grad-text">yield</span>.
              <br />
              Trade the rest.
            </h1>
            <p className="sub" style={{ marginTop: 28, maxWidth: 520 }}>
              The first on-chain interest rate swap built for Solana speed.
              Hedge Kamino lending rates with daily settlement, or provide
              liquidity and earn enhanced yield on 100% deployed capital.
            </p>
            <div className="hero-ctas">
              <Link href="/markets" className="btn btn-primary lg">
                Launch App →
              </Link>
              <a href="#" className="btn btn-ghost">Read the whitepaper</a>
            </div>
            <div className="trust-bar">
              <span>Built on</span>
              <span className="logo-slot" style={{ width: 80 }}>SOLANA</span>
              <span className="muted-2">·</span>
              <span>Integrated with</span>
              <span className="logo-slot" style={{ width: 80 }}>KAMINO</span>
              <span className="muted-2">·</span>
              <span className="logo-slot" style={{ width: 90 }}>COLOSSEUM</span>
              <span>2026</span>
            </div>
          </div>

          <div className="hero-right reveal">
            <div className="hero-mock">
              <div className="frame" />
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
                    <div className="v num">9.4%</div>
                  </div>
                  <div className="dc-tile fixed">
                    <div className="k">Fixed</div>
                    <div className="v num">8.20%</div>
                  </div>
                  <div className="dc-tile">
                    <div className="k">Spread</div>
                    <div className="v num">1.2%</div>
                  </div>
                </div>
              </div>
              <div className="hero-foot mono">
                Last settlement: 2 min ago · Block 312,445,890
                <br />
                Next settlement in 23h 58m
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Protocols() {
  const items = [
    {
      key: "kamino",
      name: "Kamino K-Lend",
      glyph: "K",
      active: true,
      slabel: "USDC · 30-day tenor",
      apy: "5.32%",
      apyLabel: "Supply APY",
      href: "/trade?market=kamino-usdc-30d",
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

function StatsBar() {
  return (
    <div className="stats-bar">
      <div className="grid">
        <div className="stat">
          <div className="v num">$2.4M</div>
          <div className="underline" />
          <div className="k">Protocol TVL</div>
        </div>
        <div className="stat">
          <div className="v num">$8.1M</div>
          <div className="underline" />
          <div className="k">Open Notional</div>
        </div>
        <div className="stat">
          <div className="v num">9.3%</div>
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
    { theme: "pink",   icon: "🔒", t: "Pay Fixed",        d: "Hedge your variable yield. Pay a fixed rate, receive the floating Kamino rate. Certainty for 7, 14, or 30 days." },
    { theme: "blue",   icon: "📈", t: "Receive Fixed",    d: "Speculate on falling rates. Receive fixed, pay floating. Leverage up to 10x on your rate view." },
    { theme: "purple", icon: "💧", t: "Provide Liquidity", d: "Deposit USDC. 100% of capital is deployed to yield-bearing strategies, plus every swap spread accrues to you." },
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
              <div className="icon-ph">{c.icon}</div>
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
                <div className="step-ph">{s.n}</div>
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

function Showcase() {
  const rows = [
    { reverse: false, label: "TRADE PAGE",     t: "A trading surface built for rates.",     p: "Execute PayFixed or ReceiveFixed in two clicks. See your effective fixed rate, maintenance margin, and liquidation price before signing." },
    { reverse: true,  label: "LP PAGE",         t: "LPs earn on both sides of the book.",    p: "Base Kamino yield plus swap spreads from every position. Dynamic spread widens when demand is imbalanced — LPs are paid more when risk is higher." },
    { reverse: false, label: "PORTFOLIO PAGE",  t: "Real-time P&L. On-chain settlement.",    p: "Every 24 hours your positions settle against the actual Kamino rate. No oracle manipulation, no off-chain dependencies, no trust." },
  ];
  return (
    <section>
      <div className="wrap">
        {rows.map((r, i) => (
          <div key={i} className={`show-row reveal ${r.reverse ? "reverse" : ""}`}>
            <div className="shot">
              <div style={{ fontSize: 18, color: "#3b4760" }}>⊡</div>
              <div>[ SCREENSHOT · {r.label} ]</div>
            </div>
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
                <th>Generation 1</th>
                <th>Generation 2</th>
                <th className="col-us">Anemone</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="row-k">Model</td>
                <td>vAMM · virtual liquidity</td>
                <td>Pooled · active vaults</td>
                <td className="col-us">Pooled · yield-bearing</td>
              </tr>
              <tr>
                <td className="row-k">Capital Efficiency</td>
                <td>Partially deployed</td>
                <td>Rebalancing via bots</td>
                <td className="col-us">100% deployed, no buffer</td>
              </tr>
              <tr>
                <td className="row-k">Settlement</td>
                <td>Maturity only</td>
                <td>Periodic · high gas cost</td>
                <td className="col-us">Daily · $0.002 per position</td>
              </tr>
              <tr>
                <td className="row-k">LP Economics</td>
                <td><span className="strike-red">Spread only · net negative</span></td>
                <td>Base yield + spread</td>
                <td className="col-us">Native yield + spread</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function Trust() {
  return (
    <section>
      <div className="wrap">
        <div className="trust-intro reveal">
          Open source · Security-audited · Multisig-controlled upgrades · Built during Colosseum Frontier Hackathon 2026
        </div>
        <div className="trust-strip reveal card-edge">
          <span className="logo-slot" style={{ width: 100 }}>SOLANA</span>
          <span className="logo-slot" style={{ width: 100 }}>ANCHOR</span>
          <span className="logo-slot" style={{ width: 100 }}>KAMINO</span>
          <span className="logo-slot" style={{ width: 100 }}>SQUADS</span>
          <span className="logo-slot" style={{ width: 110 }}>COLOSSEUM</span>
        </div>
      </div>
    </section>
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
        <div className="foot-grid">
          <div className="foot-brand">
            <div className="brand">
              <span className="wordmark">Anemone</span>
            </div>
            <p>Interest rate swaps on Solana.</p>
          </div>
          <div className="foot-col">
            <h4>Product</h4>
            <ul>
              <li><Link href="/markets">Markets</Link></li>
              <li><Link href="/trade">Trade</Link></li>
              <li><Link href="/lp">LP</Link></li>
              <li><Link href="/portfolio">Portfolio</Link></li>
              <li><a href="#">Docs</a></li>
            </ul>
          </div>
          <div className="foot-col">
            <h4>Protocol</h4>
            <ul>
              <li><a href="#">Whitepaper</a></li>
              <li><a href="#">GitHub</a></li>
              <li><a href="#">Audits</a></li>
              <li><a href="#">Governance</a></li>
            </ul>
          </div>
          <div className="foot-col">
            <h4>Community</h4>
            <ul>
              <li><a href="#">X / Twitter</a></li>
              <li><a href="#">Discord</a></li>
              <li><a href="#">Telegram</a></li>
              <li><a href="#">Mirror</a></li>
            </ul>
          </div>
          <div className="foot-col">
            <h4>Legal</h4>
            <ul>
              <li><a href="#">Terms</a></li>
              <li><a href="#">Privacy</a></li>
              <li><a href="#">Risk Disclosures</a></li>
            </ul>
          </div>
        </div>
        <div className="foot-bot">
          <span>Anemone Protocol · 2026 · Built on Solana</span>
          <div className="foot-social">
            <span className="s">X</span>
            <span className="s">D</span>
            <span className="s">T</span>
            <span className="s">M</span>
          </div>
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
      <Hero />
      <Protocols />
      <StatsBar />
      <Problem />
      <Solution />
      <How />
      <Showcase />
      <Market />
      <Compare />
      <Trust />
      <Final />
      <LandingFooter />
    </div>
  );
}
