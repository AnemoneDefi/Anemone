"use client";

import { useState } from "react";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { RevealOnScroll } from "@/components/RevealOnScroll";
import s from "./portfolio.module.css";

type Tab = "swap" | "lp";
type Filter = "ALL" | "OPEN" | "MATURED" | "LIQUIDATED" | "CLOSED";

function SummaryStrip() {
  return (
    <div className={s.summaryStrip}>
      <div className={`wrap ${s.summaryWrap}`}>
        <div className={s.ssCell}>
          <span className={s.ssKey}>Total Value</span>
          <span className={s.ssValue}>$12,847.30</span>
          <span className={s.ssSub}>across 4 positions</span>
        </div>
        <div className={s.ssCell}>
          <span className={s.ssKey}>Total Realized PnL</span>
          <span className={`${s.ssValue} ${s.pos}`}>+$127.48</span>
          <span className={s.ssSub}>
            7d: <span className={s.sPos}>+$42.10</span>
          </span>
        </div>
        <div className={s.ssCell}>
          <span className={s.ssKey}>Unrealized PnL</span>
          <span className={s.ssValue}>+$18.22</span>
          <span className={s.ssSub}>next settlement in 22h 14m</span>
        </div>
        <div className={s.ssCell}>
          <span className={s.ssKey}>Active Positions</span>
          <span className={s.ssValue} style={{ fontSize: 20 }}>3 swaps · 1 LP</span>
          <span className={s.ssSub}>0 matured · 0 liquidated</span>
        </div>
        <div className={s.ssRight}>
          <span className={s.walletPill}>
            <span className={s.walletAv} />
            <span>7xK...4Fz2</span>
            <span className="copy">⧉</span>
          </span>
          <span className={s.disconnect}>Disconnect</span>
        </div>
      </div>
    </div>
  );
}

function TabsRow({
  tab,
  setTab,
  filter,
  setFilter,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  filter: Filter;
  setFilter: (f: Filter) => void;
}) {
  const filterOptions: Filter[] = ["ALL", "OPEN", "MATURED", "LIQUIDATED", "CLOSED"];
  return (
    <div className={s.tabsRow}>
      <div className={`wrap ${s.tabsWrap}`}>
        <div className={s.tabs}>
          <button
            className={`${s.tab} ${tab === "swap" ? s.active : ""}`}
            onClick={() => setTab("swap")}
            type="button"
          >
            Swap Positions <span className="count">3</span>
          </button>
          <button
            className={`${s.tab} ${tab === "lp" ? s.active : ""}`}
            onClick={() => setTab("lp")}
            type="button"
          >
            LP Positions <span className="count">1</span>
          </button>
        </div>
        <div className={s.filterPills}>
          {filterOptions.map((p) => (
            <button
              key={p}
              className={`${s.pill} ${filter === p ? s.active : ""}`}
              onClick={() => setFilter(p)}
              type="button"
            >
              {p}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function HealthBar({ pct, alert }: { pct: number; alert?: boolean }) {
  return (
    <div className={`${s.health} ${alert ? s.alert : ""}`}>
      <div className={`${s.healthBar} ${alert ? s.alert : ""}`}>
        <div className={s.healthSeg} style={{ left: 0, width: "30%", background: "rgba(239,68,68,.55)" }} />
        <div className={s.healthSeg} style={{ left: "30%", width: "30%", background: "rgba(138,143,156,.35)" }} />
        <div className={s.healthSeg} style={{ left: "60%", width: "40%", background: "rgba(59,130,246,.5)" }} />
        <div className={s.healthMarker} style={{ left: `${pct}%` }} />
      </div>
      <span className={s.healthLbl}>{alert ? "0.9× liq buffer" : "3.8× liq buffer"}</span>
    </div>
  );
}

function SwapTable() {
  return (
    <div className={`${s.tblWrap} reveal`}>
      <table className={s.tbl}>
        <colgroup>
          <col style={{ width: "15%" }} />
          <col style={{ width: "9%" }} />
          <col style={{ width: "9%" }} />
          <col style={{ width: "7%" }} />
          <col style={{ width: "11%" }} />
          <col style={{ width: "8%" }} />
          <col style={{ width: "8%" }} />
          <col style={{ width: "10%" }} />
          <col style={{ width: "7%" }} />
          <col style={{ width: "9%" }} />
          <col style={{ width: "7%" }} />
          <col style={{ width: "14%" }} />
        </colgroup>
        <thead>
          <tr>
            <th>Market</th>
            <th>Direction</th>
            <th className={s.right}>Notional</th>
            <th className={s.right}>Fixed</th>
            <th className={s.right}>Collateral</th>
            <th className={s.right}>Realized</th>
            <th className={s.right}>Unrealized</th>
            <th>Health</th>
            <th>Settle</th>
            <th>Maturity</th>
            <th>Status</th>
            <th className={s.right}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {/* Row 1 — OPEN healthy */}
          <tr>
            <td>
              <div className={s.mktCell}>
                <span className={s.mktIco}>U</span>
                <div style={{ minWidth: 0 }}>
                  <div className={s.mktTx}>Kamino USDC</div>
                  <div className={s.mktSub}>30D Tenor</div>
                </div>
              </div>
            </td>
            <td>
              <span className={`${s.dirPill} ${s.pay}`}>Pay Fixed</span>
            </td>
            <td className={s.right}>$10,000</td>
            <td className={`${s.right} pink-text`}>8.20%</td>
            <td>
              <div className={s.coll}>
                <span className={s.collTop}>$485.50</span>
                <span className={s.collBot}>of $500 · 97%</span>
              </div>
            </td>
            <td className={`${s.right} ${s.pnlPos}`}>+$42.10</td>
            <td className={`${s.right} ${s.pnlEst}`}>+$18.22</td>
            <td>
              <HealthBar pct={88} />
            </td>
            <td>
              <div className={s.sett}>
                <span className={s.settValue}>21/30</span>
                <div className={s.settBar}>
                  <div className={s.settFill} style={{ width: "70%" }} />
                </div>
              </div>
            </td>
            <td>
              <div className={s.mat}>
                <span className={s.matDate}>May 23</span>
                <span className={s.matRel}>9d left</span>
              </div>
            </td>
            <td>
              <span className={`${s.statusBadge} ${s.open}`}>Open</span>
            </td>
            <td className={s.right}>
              <div className={s.acts}>
                <button className={s.miniBtn} type="button">+ Collateral</button>
                <button className={`${s.miniBtn} ${s.pink}`} type="button">Close Early</button>
              </div>
            </td>
          </tr>

          {/* Row 2 — OPEN near liquidation */}
          <tr className={s.rowAlert}>
            <td>
              <div className={s.mktCell}>
                <span className={s.mktIco}>U</span>
                <div style={{ minWidth: 0 }}>
                  <div className={s.mktTx}>Kamino USDC</div>
                  <div className={s.mktSub}>30D Tenor</div>
                </div>
              </div>
            </td>
            <td>
              <span className={`${s.dirPill} ${s.rec}`}>Receive Fixed</span>
            </td>
            <td className={s.right}>$5,000</td>
            <td className={`${s.right} blue-text`}>7.40%</td>
            <td>
              <div className={`${s.coll} ${s.warn}`}>
                <span className={s.collTop}>
                  <span className={s.warnGlyph}>!</span>$42.18
                </span>
                <span className={s.collBot}>of $250 · 17%</span>
              </div>
            </td>
            <td className={`${s.right} ${s.pnlNeg}`}>−$187.22</td>
            <td className={`${s.right} ${s.pnlEst}`} style={{ color: "rgba(239,68,68,.75)" }}>−$14.80</td>
            <td>
              <HealthBar pct={22} alert />
            </td>
            <td>
              <div className={s.sett}>
                <span className={s.settValue}>18/30</span>
                <div className={s.settBar}>
                  <div className={s.settFill} style={{ width: "60%" }} />
                </div>
              </div>
            </td>
            <td>
              <div className={s.mat}>
                <span className={s.matDate}>May 20</span>
                <span className={s.matRel}>6d left</span>
              </div>
            </td>
            <td>
              <span className={`${s.statusBadge} ${s.open}`}>Open</span>
            </td>
            <td className={s.right}>
              <div className={s.acts}>
                <button className={`${s.miniBtn} ${s.pink}`} type="button">+ Collateral</button>
                <button className={s.miniBtn} type="button">Close Early</button>
              </div>
            </td>
          </tr>

          {/* Row 3 — MATURED */}
          <tr className={s.rowMatured}>
            <td>
              <div className={s.mktCell}>
                <span className={s.mktIco}>U</span>
                <div style={{ minWidth: 0 }}>
                  <div className={s.mktTx}>Kamino USDC</div>
                  <div className={s.mktSub}>30D Tenor</div>
                </div>
              </div>
            </td>
            <td>
              <span className={`${s.dirPill} ${s.pay}`}>Pay Fixed</span>
            </td>
            <td className={s.right}>$2,500</td>
            <td className={`${s.right} pink-text`}>8.05%</td>
            <td>
              <div className={s.coll}>
                <span className={s.collTop}>$125.00</span>
                <span className={s.collBot}>of $125 · 100%</span>
              </div>
            </td>
            <td className={`${s.right} ${s.pnlPos}`}>+$27.80</td>
            <td className={`${s.right} ${s.pnlDash}`}>—</td>
            <td>
              <span className={s.pnlDash} style={{ fontSize: 11 }}>—</span>
            </td>
            <td>
              <div className={s.sett}>
                <span className={s.settValue}>30/30</span>
                <div className={s.settBar}>
                  <div className={s.settFill} style={{ width: "100%" }} />
                </div>
              </div>
            </td>
            <td>
              <div className={`${s.mat} ${s.matured}`}>
                <span className={s.matDate}>Apr 23</span>
                <span className={s.matRel}>matured</span>
              </div>
            </td>
            <td>
              <span className={`${s.statusBadge} ${s.matured}`}>Matured</span>
            </td>
            <td className={s.right}>
              <div className={s.acts}>
                <button className={`${s.miniBtn} ${s.solidPink} ${s.claim}`} type="button">
                  Claim →
                </button>
              </div>
            </td>
          </tr>

          {/* Row 4 — CLOSED */}
          <tr className={s.rowClosed}>
            <td>
              <div className={s.mktCell}>
                <span className={s.mktIco}>U</span>
                <div style={{ minWidth: 0 }}>
                  <div className={s.mktTx}>Kamino USDC</div>
                  <div className={s.mktSub}>30D Tenor</div>
                </div>
              </div>
            </td>
            <td>
              <span className={`${s.dirPill} ${s.pay}`}>Pay Fixed</span>
            </td>
            <td className={s.right}>$8,000</td>
            <td className={`${s.right} pink-text`}>8.15%</td>
            <td>
              <div className={s.coll}>
                <span className={s.collTop}>$0</span>
                <span className={s.collBot}>returned</span>
              </div>
            </td>
            <td className={`${s.right} ${s.pnlPos}`}>+$94.20</td>
            <td className={`${s.right} ${s.pnlDash}`}>—</td>
            <td>
              <span className={s.pnlDash} style={{ fontSize: 11 }}>—</span>
            </td>
            <td>
              <div className={s.sett}>
                <span className={s.settValue}>14/30</span>
                <div className={s.settBar}>
                  <div className={s.settFill} style={{ width: "47%", opacity: 0.4 }} />
                </div>
              </div>
            </td>
            <td>
              <div className={s.mat}>
                <span className={s.matDate}>Apr 18</span>
                <span className={s.matRel}>closed early</span>
              </div>
            </td>
            <td>
              <span className={`${s.statusBadge} ${s.closed}`}>Closed</span>
            </td>
            <td className={s.right}>
              <div className={s.acts}>
                <button className={s.miniBtn} type="button">View tx</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function LpCards() {
  return (
    <div className={`${s.lpGrid} reveal`}>
      <div className={`${s.card} ${s.lpCard}`}>
        <div className={s.lpHead}>
          <div className={s.lpTitle}>
            <span className={s.mktIco}>K</span>Kamino USDC Pool
          </div>
          <span className={`${s.lpStat} ${s.active}`}>Active</span>
        </div>
        <div className={s.lpValueLbl}>Current Value</div>
        <div className={s.lpValue}>$10,152.80</div>
        <div className={s.lpDelta}>
          <span className="big">+$152.80</span>
          <span className="sub">+1.53% since deposit (21d)</span>
        </div>
        <table className={s.lpTbl}>
          <tbody>
            <tr><td>Shares</td><td>9,847.23 aUSDC-A</td></tr>
            <tr><td>Deposited</td><td>$10,000.00</td></tr>
            <tr><td>Your share of pool</td><td>0.42%</td></tr>
            <tr><td>Current pool APY</td><td>~9.3%</td></tr>
          </tbody>
        </table>
        <div className={s.lpActs}>
          <button className={s.miniBtn} type="button">Deposit</button>
          <button className={`${s.miniBtn} ${s.pink}`} type="button">Withdraw</button>
        </div>
      </div>

      <div className={s.lpEmpty}>
        <div className={s.lpEmptyPlus}>+</div>
        <div className={s.lpEmptyT}>New Pool Position</div>
        <div className={s.lpEmptyS}>No other pools yet</div>
      </div>
    </div>
  );
}

export default function PortfolioPage() {
  const [tab, setTab] = useState<Tab>("swap");
  const [filter, setFilter] = useState<Filter>("ALL");

  return (
    <>
      <RevealOnScroll />
      <Nav />
      <SummaryStrip />
      <TabsRow tab={tab} setTab={setTab} filter={filter} setFilter={setFilter} />
      <section className={s.sectionBody}>
        <div className={`wrap ${s.sectionWrap}`}>
          <div className={s.hintRow}>
            <span>Rates update every block</span>
            <span className={s.hintSep}>·</span>
            <span>Next keeper settlement in 22h 14m</span>
          </div>
          {tab === "swap" ? <SwapTable /> : <LpCards />}
        </div>
      </section>
      <Footer />
    </>
  );
}
