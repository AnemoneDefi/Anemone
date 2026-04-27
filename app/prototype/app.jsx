const { useEffect, useRef, useState } = React;

const injectTemplate = (tplId, target) => {
  const tpl = document.getElementById(tplId);
  if (!tpl || !target) return;
  target.innerHTML = "";
  target.appendChild(tpl.content.cloneNode(true));
};

const useReveal = () => {
  useEffect(() => {
    const els = document.querySelectorAll(".reveal");
    const fallback = setTimeout(() => els.forEach(el => el.classList.add("in")), 1000);
    let io;
    try {
      io = new IntersectionObserver(
        entries => entries.forEach(e => { if (e.isIntersecting) e.target.classList.add("in"); }),
        { threshold: 0.05, rootMargin: "0px 0px -40px 0px" }
      );
      requestAnimationFrame(() => els.forEach(el => io.observe(el)));
    } catch(e) { els.forEach(el => el.classList.add("in")); }
    return () => { clearTimeout(fallback); if (io) io.disconnect(); };
  }, []);
};

const LogoMark = ({size=24}) => {
  const ref = useRef(null);
  useEffect(() => { injectTemplate("tpl-logo", ref.current); }, []);
  return <span className="a-mark" ref={ref} style={{width:size,height:size}}/>;
};

const Tick = () => {
  const ref = useRef(null);
  useEffect(() => { injectTemplate("tpl-tick", ref.current); }, []);
  return <span ref={ref} style={{display:"inline-flex",width:12,height:12}}/>;
};

/* NAV */
const Nav = () => (
  <nav className="top">
    <div className="wrap">
      <a className="brand" href="landing.html">
        <span>Anemone</span>
      </a>
      <div className="navlinks">
        <a href="markets.html">Markets</a><a href="trade.html">Trade</a><a href="lp.html">LP</a><a href="portfolio.html">Portfolio</a>
      </div>
      <div className="nav-right">
        <div className="badge"><span className="dot-pink"/>Live on Solana Devnet</div>
        <a href="markets.html" className="btn btn-primary">Launch App</a>
      </div>
    </div>
  </nav>
);

/* HERO */
const Hero = () => {
  const chartRef = useRef(null);
  useEffect(() => { injectTemplate("tpl-hero-chart", chartRef.current); }, []);
  return (
    <section className="hero">
      <div className="wrap">
        <div className="hero-grid">
          <div className="card-anchor-line"/>
          <div className="hero-left reveal">
            <div className="eyebrow">Interest Rate Swaps · Solana</div>
            <h1 className="h1" style={{marginTop:24}}>
              Lock your <span className="grad-text">yield</span>.<br/>
              Trade the rest.
            </h1>
            <p className="sub" style={{marginTop:28, maxWidth:520}}>
              The first on-chain interest rate swap built for Solana speed. Hedge Kamino lending rates with daily settlement, or provide liquidity and earn enhanced yield on 100% deployed capital.
            </p>
            <div className="hero-ctas">
              <a href="markets.html" className="btn btn-primary lg">Launch App →</a>
              <a href="#" className="btn btn-ghost">Read the whitepaper</a>
            </div>
            <div className="trust-bar">
              <span>Built on</span>
              <span className="logo-slot" style={{width:80}}>LOGO · SOLANA</span>
              <span className="muted-2">·</span>
              <span>Integrated with</span>
              <span className="logo-slot" style={{width:80}}>LOGO · KAMINO</span>
              <span className="muted-2">·</span>
              <span className="logo-slot" style={{width:90}}>LOGO · COLOSSEUM</span>
              <span>2026</span>
            </div>
          </div>

          <div className="hero-right reveal">
            <div className="hero-mock">
              <div className="frame-label mono">[ HERO DASHBOARD MOCK · 560×420 ]</div>
              <div className="frame"/>
              <div className="dashcard card-edge">
                <div className="dc-head">
                  <span className="mono" style={{fontSize:11,letterSpacing:".1em"}}>KAMINO USDC · 30D</span>
                  <span className="live"><span className="dot-pink"/>Live</span>
                </div>
                <div className="dc-chart" ref={chartRef}>
                  <div className="tag">[ RATE CHART — 7D ]</div>
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
              <div className="hero-foot mono">Last settlement: 2 min ago · Block 312,445,890<br/>Next settlement in 23h 58m</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

/* SUPPORTED PROTOCOLS */
const Protocols = () => {
  const items = [
    { key:'kamino',   name:'Kamino K-Lend', glyph:'K', active:true,  slabel:'USDC · 30-day tenor',      apy:'5.32%', apyLabel:'Supply APY', href:'trade.html?market=kamino-usdc-30d' },
    { key:'solend',   name:'Solend',        glyph:'S', active:false, slabel:'Rolling out Q3 2026',       tooltip:'Expected Q3 2026' },
    { key:'marginfi', name:'MarginFi',      glyph:'M', active:false, slabel:'Rolling out Q3 2026',       tooltip:'Expected Q3 2026' },
    { key:'drift',    name:'Drift',         glyph:'D', active:false, slabel:'Rolling out Q3 2026',       tooltip:'Expected Q3 2026' },
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
            <div key={p.key} className={`proto-row ${p.active ? 'active' : 'inactive'}`}>
              <div className="proto-id">
                <div className="logo">{p.glyph}</div>
                <div style={{minWidth:0}}>
                  <div className="name">{p.name}</div>
                  <div className="slabel">{p.slabel}</div>
                </div>
              </div>
              <span className={`proto-badge ${p.active ? 'live' : 'soon'}`}>{p.active ? 'LIVE' : 'SOON'}</span>
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
                {p.active ? (
                  <a href={p.href} className="proto-cta primary">Open Swap →</a>
                ) : (
                  <button className="proto-cta disabled" aria-disabled="true">
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
};

/* STATS BAR */
const StatsBar = () => (
  <div className="stats-bar">
    <div className="grid">
      <div className="stat"><div className="v num">$2.4M</div><div className="underline"/><div className="k">Protocol TVL</div></div>
      <div className="stat"><div className="v num">$8.1M</div><div className="underline"/><div className="k">Open Notional</div></div>
      <div className="stat"><div className="v num">9.3%</div><div className="underline"/><div className="k">Avg LP APY</div></div>
      <div className="stat gradient">
        <div className="v num">$3.6B</div>
        <div className="underline"/>
        <div className="k">Solana Lending TVL</div>
        <div className="sub">the addressable rate market</div>
      </div>
    </div>
  </div>
);

/* PROBLEM */
const Problem = () => {
  const ref = useRef(null);
  useEffect(() => {
    injectTemplate("tpl-problem-chart", ref.current);
    const pin1 = document.createElement("div");
    pin1.className = "pin blue";
    pin1.textContent = "VARIABLE PEAK · 12.1%";
    pin1.style.top = "54px"; pin1.style.left = "22%";
    const pin2 = document.createElement("div");
    pin2.className = "pin blue";
    pin2.textContent = "VARIABLE TROUGH · 3.4%";
    pin2.style.bottom = "48px"; pin2.style.right = "32%";
    ref.current.appendChild(pin1);
    ref.current.appendChild(pin2);
  }, []);
  return (
    <section>
      <div className="wrap">
        <div className="reveal">
          <div className="eyebrow">The Problem</div>
          <h2 className="h2" style={{marginTop:20, maxWidth:880}}>
            DeFi lending rates are unpredictable. You have no way to hedge.
          </h2>
        </div>
        <div className="problem-chart reveal" ref={ref}>
          <div className="tag">[ ILLUSTRATIVE · SOLANA USDC LENDING RATE VOLATILITY ]</div>
        </div>
        <div className="problem-caption reveal">
          Solana lending rates routinely swing from <span className="num">12%</span> to <span className="num">3%</span> within a week. A <span className="num">$100K</span> position can lose hundreds in expected monthly yield, with no recourse.
        </div>
        <div className="problem-close reveal">
          <div>Traders had no way to lock their rate.</div>
          <div>LPs had no way to earn on the volatility.</div>
        </div>
      </div>
    </section>
  );
};

/* SOLUTION */
const Solution = () => {
  const cards = [
    { theme:"pink",   ph:"ICON · LOCK", t:"Pay Fixed",        d:"Hedge your variable yield. Pay a fixed rate, receive the floating Kamino rate. Certainty for 7, 14, or 30 days." },
    { theme:"blue",   ph:"ICON · WAVE", t:"Receive Fixed",    d:"Speculate on falling rates. Receive fixed, pay floating. Leverage up to 10x on your rate view." },
    { theme:"purple", ph:"ICON · FLOW", t:"Provide Liquidity", d:"Deposit USDC. 100% of capital is deployed to yield-bearing strategies, plus every swap spread accrues to you." }
  ];
  return (
    <section>
      <div className="wrap">
        <div className="reveal">
          <div className="eyebrow">The Solution</div>
          <h2 className="h2" style={{marginTop:20}}>Interest rate swaps. Native to Solana.</h2>
        </div>
        <div className="sol-grid">
          {cards.map((c,i)=>(
            <div key={i} className={`card card-edge themed-${c.theme} reveal`}>
              <div className="icon-ph">{c.ph}</div>
              <h3><Tick/>{c.t}</h3>
              <p>{c.d}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

/* HOW */
const How = () => (
  <section>
    <div className="wrap">
      <div className="reveal">
        <div className="eyebrow">Under the Hood</div>
        <h2 className="h2" style={{marginTop:20}}>No oracles. No vAMMs. Just Solana.</h2>
      </div>
      <div className="how-wrap">
        <div className="how-connector"/>
        <div className="how-grid">
          {[
            { n:"01", t:<><b>LPs deposit USDC</b> into yield-bearing strategies (100% deployed)</> },
            { n:"02", t:<><b>Traders open swaps</b> against the LP pool, posting margin</> },
            { n:"03", t:<><b>Keeper reads</b> on-chain lending rates and settles P&L daily</> },
            { n:"04", t:<><b>At maturity</b>, principal stays with LPs, P&L distributed</> }
          ].map((s,i)=>(
            <div key={i} className="step reveal">
              <div className="step-ph">[ STEP {s.n} · 200×120 ]</div>
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

/* SHOWCASE */
const Showcase = () => {
  const rows = [
    { reverse:false, label:"SCREENSHOT · TRADE PAGE · 640×440",
      t:"A trading surface built for rates.",
      p:"Execute PayFixed or ReceiveFixed in two clicks. See your effective fixed rate, maintenance margin, and liquidation price before signing." },
    { reverse:true, label:"SCREENSHOT · LP PAGE · 640×440",
      t:"LPs earn on both sides of the book.",
      p:"Base Kamino yield plus swap spreads from every position. Dynamic spread widens when demand is imbalanced — LPs are paid more when risk is higher." },
    { reverse:false, label:"SCREENSHOT · PORTFOLIO PAGE · 640×440",
      t:"Real-time P&L. On-chain settlement.",
      p:"Every 24 hours your positions settle against the actual Kamino rate. No oracle manipulation, no off-chain dependencies, no trust." }
  ];
  return (
    <section>
      <div className="wrap">
        {rows.map((r,i)=>(
          <div key={i} className={`show-row reveal ${r.reverse ? "reverse":""}`}>
            <div className="shot">
              <div style={{fontSize:18,color:"#3b4760"}}>⊡</div>
              <div>[ {r.label} ]</div>
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
};

/* MARKET — Solana lending focus */
const Market = () => {
  const [n, setN] = useState(0);
  const bgRef = useRef(null);
  useEffect(() => {
    let v = 0;
    const target = 3.6;
    const id = setInterval(() => {
      v += 0.09;
      if (v >= target) { v = target; clearInterval(id); }
      setN(v);
    }, 22);
    // Build anemone bg motif
    const tpl = document.getElementById("tpl-anemone-bg");
    if (tpl && bgRef.current){
      bgRef.current.innerHTML = "";
      bgRef.current.appendChild(tpl.content.cloneNode(true));
      // inject rays
      const svg = bgRef.current.querySelector("svg");
      const g = svg && svg.querySelector("#rays");
      if (g){
        g.id = "rays-inject";
        if (window.__buildAnemoneRays) window.__buildAnemoneRays();
      }
    }
    return () => clearInterval(id);
  }, []);
  return (
    <section>
      <div className="wrap market">
        <div className="anemone-bg" ref={bgRef}/>
        <div className="inner">
          <div className="eyebrow reveal">Market Opportunity</div>
          <div className="big blue-text reveal">${n.toFixed(1)}B</div>
          <div className="cap reveal">Total lending TVL on Solana — every dollar of floating-rate exposure that could be hedged or traded.</div>

          <div className="bars reveal">
            <div className="bar-row">
              <div className="lbl">Solana Lending TVL</div>
              <div className="track"><div className="fill grad" style={{width:"100%"}}/></div>
              <div className="val">$3.6B</div>
            </div>
            <div className="bar-row">
              <div className="lbl">Floating-Rate Exposure</div>
              <div className="track"><div className="fill purple" style={{width:"78%"}}/></div>
              <div className="val">~$2.8B</div>
            </div>
            <div className="bar-row">
              <div className="lbl">Hedged On-Chain</div>
              <div className="track"><div className="fill blue" style={{width:"0.3%"}}/></div>
              <div className="val">&lt;$10M</div>
            </div>
          </div>

          <div className="close reveal">
            Less than <span className="num">0.4%</span> of Solana's floating-rate lending has any hedge available. We're building the rest.
          </div>
        </div>
      </div>
    </section>
  );
};

/* COMPARE — no competitor names */
const Compare = () => (
  <section>
    <div className="wrap">
      <div className="reveal">
        <div className="eyebrow">Why Anemone</div>
        <h2 className="h2" style={{marginTop:20}}>Designed for what the others got wrong.</h2>
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
            <tr>
              <td className="row-k">Chain</td>
              <td>Ethereum L1</td>
              <td>Ethereum L1</td>
              <td className="col-us">Solana</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
);

/* TRUST */
const Trust = () => (
  <section>
    <div className="wrap">
      <div className="trust-intro reveal">
        Open source · Security-audited · Multisig-controlled upgrades · Built during Colosseum Frontier Hackathon 2026
      </div>
      <div className="trust-strip reveal card-edge">
        <span className="logo-slot" style={{width:100}}>LOGO · SOLANA</span>
        <span className="logo-slot" style={{width:100}}>LOGO · ANCHOR</span>
        <span className="logo-slot" style={{width:100}}>LOGO · KAMINO</span>
        <span className="logo-slot" style={{width:100}}>LOGO · SQUADS</span>
        <span className="logo-slot" style={{width:110}}>LOGO · COLOSSEUM</span>
      </div>
    </div>
  </section>
);

/* FINAL */
const Final = () => (
  <section className="final">
    <div className="wrap">
      <h2 className="reveal">Stop guessing your <span className="grad-text">yield</span>.</h2>
      <div className="sub reveal">Launch Anemone on Solana devnet.</div>
      <a href="markets.html" className="btn btn-primary lg reveal">Open the app →</a>
      <div className="note reveal mono">Available on devnet. Mainnet coming soon.</div>
    </div>
  </section>
);

/* FOOTER */
const Footer = () => (
  <footer>
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
          <ul><li><a href="markets.html">Markets</a></li><li><a href="trade.html">Trade</a></li><li><a href="lp.html">LP</a></li><li><a href="portfolio.html">Portfolio</a></li><li><a href="#">Docs</a></li></ul>
        </div>
        <div className="foot-col">
          <h4>Protocol</h4>
          <ul><li><a href="#">Whitepaper</a></li><li><a href="#">GitHub</a></li><li><a href="#">Audits</a></li><li><a href="#">Governance</a></li></ul>
        </div>
        <div className="foot-col">
          <h4>Community</h4>
          <ul><li><a href="#">X / Twitter</a></li><li><a href="#">Discord</a></li><li><a href="#">Telegram</a></li><li><a href="#">Mirror</a></li></ul>
        </div>
        <div className="foot-col">
          <h4>Legal</h4>
          <ul><li><a href="#">Terms</a></li><li><a href="#">Privacy</a></li><li><a href="#">Risk Disclosures</a></li></ul>
        </div>
      </div>
      <div className="foot-bot">
        <span>Anemone Protocol · 2026 · Built on Solana</span>
        <div className="foot-social">
          <span className="s">X</span><span className="s">D</span><span className="s">T</span><span className="s">M</span>
        </div>
      </div>
      <div className="disclaimer">
        Anemone is experimental software. Interest rate swaps carry liquidation risk. Do your own research.
      </div>
    </div>
  </footer>
);

const App = () => {
  useReveal();
  return (
    <>
      <Nav />
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
      <Footer />
    </>
  );
};

ReactDOM.createRoot(document.getElementById("app")).render(<App />);
