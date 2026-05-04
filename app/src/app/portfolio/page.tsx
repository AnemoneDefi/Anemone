"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  useAnchorWallet,
  useConnection,
  useWallet,
} from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  PositionStatus,
  SwapDirection,
  type LpPosition,
  type Market,
  type Protocol,
  type SwapPosition,
} from "@anemone/sdk";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { RevealOnScroll } from "@/components/RevealOnScroll";
import {
  useLpPositionsByOwner,
  useMarkets,
  useProtocol,
  useTraderPositions,
} from "@/lib/hooks";
import { buildClient } from "@/lib/anemone";
import { resolveKaminoCpiAccounts } from "@/lib/kamino";
import {
  calculateMaintenanceMargin,
  calculateUnrealizedPnl,
} from "@/lib/risk";
import {
  formatBps,
  formatPubkey,
  formatUsdc,
  formatUsdcCompact,
} from "@/lib/format";
import s from "./portfolio.module.css";

const USDC_DECIMALS = 6;
const USDC_DIVISOR = 10n ** BigInt(USDC_DECIMALS);
const SPL_TOKEN_PROGRAM = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

type Tab = "swap" | "lp";
type Filter = "ALL" | "OPEN" | "MATURED" | "LIQUIDATED" | "CLOSED";

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

function statusToBadge(status: PositionStatus): {
  label: string;
  cls: string;
  filter: Filter;
} {
  switch (status) {
    case PositionStatus.Open:
      return { label: "Open", cls: s.open, filter: "OPEN" };
    case PositionStatus.Matured:
      return { label: "Matured", cls: s.matured, filter: "MATURED" };
    case PositionStatus.Liquidated:
      return {
        label: "Liquidated",
        cls: `${s.closed}`,
        filter: "LIQUIDATED",
      };
    case PositionStatus.ClosedEarly:
      return { label: "Closed", cls: s.closed, filter: "CLOSED" };
  }
}

function formatPnlSigned(value: bigint): { text: string; cls: string } {
  if (value > 0n)
    return {
      text: `+$${formatUsdc(value, { withSymbol: false })}`,
      cls: s.pnlPos,
    };
  if (value < 0n)
    return {
      text: `−$${formatUsdc(-value, { withSymbol: false })}`,
      cls: s.pnlNeg,
    };
  return { text: "$0.00", cls: "" };
}

function daysUntil(unixSec: bigint): { date: string; rel: string } {
  const ms = Number(unixSec) * 1000;
  const date = new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const diff = ms - Date.now();
  if (diff <= 0) return { date, rel: "matured" };
  const days = Math.ceil(diff / 86_400_000);
  return { date, rel: `${days}d left` };
}

interface PortfolioContext {
  marketsByAddress: Map<string, Market>;
  protocol: Protocol | null | undefined;
}

interface DerivedSwap {
  position: SwapPosition;
  market: Market | undefined;
  unrealized: bigint;
  collateralValue: bigint;
  maintenance: bigint;
  collateralPct: number;
  totalPlannedSettlements: number;
}

function deriveSwap(position: SwapPosition, market: Market | undefined): DerivedSwap {
  const unrealized =
    market && position.status === PositionStatus.Open
      ? (() => {
          const elapsed =
            BigInt(Math.floor(Date.now() / 1000)) - position.lastSettlementTs;
          return calculateUnrealizedPnl(
            position.direction,
            position.notional,
            position.fixedRateBps,
            position.lastSettledRateIndex,
            market.currentRateIndex,
            elapsed > 0n ? elapsed : 0n
          );
        })()
      : 0n;

  // Collateral_value = collateral_remaining + unrealized (signed). Health is
  // the ratio vs maintenance margin.
  const collateralValue =
    unrealized >= 0n
      ? position.collateralRemaining + unrealized
      : position.collateralRemaining > -unrealized
        ? position.collateralRemaining - -unrealized
        : 0n;

  const maintenance = market
    ? calculateMaintenanceMargin(position.notional, market.tenorSeconds)
    : 0n;

  const collateralPct =
    position.collateralDeposited > 0n
      ? Math.round(
          Number((position.collateralRemaining * 100n) / position.collateralDeposited)
        )
      : 0;

  const totalPlannedSettlements =
    market && market.settlementPeriodSeconds > 0n
      ? Number(market.tenorSeconds / market.settlementPeriodSeconds)
      : 0;

  return {
    position,
    market,
    unrealized,
    collateralValue,
    maintenance,
    collateralPct,
    totalPlannedSettlements,
  };
}

// ─── SummaryStrip ──────────────────────────────────────────────────────────

interface SummaryStats {
  totalValue: bigint;
  realizedPnl: bigint;
  unrealizedPnl: bigint;
  swapCount: number;
  lpCount: number;
  matured: number;
  liquidated: number;
}

function SummaryStrip({
  stats,
  hasWallet,
}: {
  stats: SummaryStats;
  hasWallet: boolean;
}) {
  const wallet = useWallet();
  return (
    <div className={s.summaryStrip}>
      <div className={`wrap ${s.summaryWrap}`}>
        <div className={s.ssCell}>
          <span className={s.ssKey}>Total Value</span>
          <span className={s.ssValue}>
            ${formatUsdc(stats.totalValue, { withSymbol: false })}
          </span>
          <span className={s.ssSub}>
            across {stats.swapCount + stats.lpCount} position
            {stats.swapCount + stats.lpCount === 1 ? "" : "s"}
          </span>
        </div>
        <div className={s.ssCell}>
          <span className={s.ssKey}>Total Realized PnL</span>
          <span
            className={`${s.ssValue} ${
              stats.realizedPnl >= 0n ? s.pos : ""
            }`}
            style={{
              color: stats.realizedPnl < 0n ? "var(--red)" : undefined,
            }}
          >
            {formatPnlSigned(stats.realizedPnl).text}
          </span>
          <span className={s.ssSub}>Across all swaps</span>
        </div>
        <div className={s.ssCell}>
          <span className={s.ssKey}>Unrealized PnL</span>
          <span
            className={s.ssValue}
            style={{
              color:
                stats.unrealizedPnl > 0n
                  ? "#86efac"
                  : stats.unrealizedPnl < 0n
                    ? "var(--red)"
                    : undefined,
            }}
          >
            {formatPnlSigned(stats.unrealizedPnl).text}
          </span>
          <span className={s.ssSub}>Mark-to-market on open positions</span>
        </div>
        <div className={s.ssCell}>
          <span className={s.ssKey}>Active Positions</span>
          <span className={s.ssValue} style={{ fontSize: 20 }}>
            {stats.swapCount} swap{stats.swapCount === 1 ? "" : "s"} ·{" "}
            {stats.lpCount} LP
          </span>
          <span className={s.ssSub}>
            {stats.matured} matured · {stats.liquidated} liquidated
          </span>
        </div>
        <div className={s.ssRight}>
          {hasWallet ? (
            <span className={s.walletPill}>
              <span className={s.walletAv} />
              <span>{formatPubkey(wallet.publicKey!.toBase58())}</span>
            </span>
          ) : (
            <span className={s.walletPill} style={{ opacity: 0.6 }}>
              Wallet disconnected
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── TabsRow ───────────────────────────────────────────────────────────────

function TabsRow({
  tab,
  setTab,
  filter,
  setFilter,
  swapCount,
  lpCount,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  filter: Filter;
  setFilter: (f: Filter) => void;
  swapCount: number;
  lpCount: number;
}) {
  const filterOptions: Filter[] = [
    "ALL",
    "OPEN",
    "MATURED",
    "LIQUIDATED",
    "CLOSED",
  ];
  return (
    <div className={s.tabsRow}>
      <div className={`wrap ${s.tabsWrap}`}>
        <div className={s.tabs}>
          <button
            className={`${s.tab} ${tab === "swap" ? s.active : ""}`}
            onClick={() => setTab("swap")}
            type="button"
          >
            Swap Positions <span className="count">{swapCount}</span>
          </button>
          <button
            className={`${s.tab} ${tab === "lp" ? s.active : ""}`}
            onClick={() => setTab("lp")}
            type="button"
          >
            LP Positions <span className="count">{lpCount}</span>
          </button>
        </div>
        {tab === "swap" ? (
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
        ) : null}
      </div>
    </div>
  );
}

// ─── HealthBar ─────────────────────────────────────────────────────────────

function HealthBar({ pct, alert }: { pct: number; alert?: boolean }) {
  return (
    <div className={`${s.health} ${alert ? s.alert : ""}`}>
      <div className={`${s.healthBar} ${alert ? s.alert : ""}`}>
        <div
          className={s.healthSeg}
          style={{ left: 0, width: "30%", background: "rgba(239,68,68,.55)" }}
        />
        <div
          className={s.healthSeg}
          style={{
            left: "30%",
            width: "30%",
            background: "rgba(138,143,156,.35)",
          }}
        />
        <div
          className={s.healthSeg}
          style={{
            left: "60%",
            width: "40%",
            background: "rgba(59,130,246,.5)",
          }}
        />
        <div
          className={s.healthMarker}
          style={{ left: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      </div>
      <span className={s.healthLbl}>
        {alert ? "Below maintenance" : `${pct}% to liq`}
      </span>
    </div>
  );
}

// ─── Swap row ──────────────────────────────────────────────────────────────

function SwapRow({
  derived,
  onAction,
}: {
  derived: DerivedSwap;
  onAction: (
    action: "addCollateral" | "closeEarly" | "claim",
    position: SwapPosition,
    market: Market
  ) => void;
}) {
  const { position, market, unrealized, collateralValue, maintenance } = derived;
  const status = statusToBadge(position.status);
  const isOpen = position.status === PositionStatus.Open;
  const isMatured = position.status === PositionStatus.Matured;
  const dirCls =
    position.direction === SwapDirection.PayFixed ? s.pay : s.rec;
  const dirLabel =
    position.direction === SwapDirection.PayFixed ? "Pay Fixed" : "Receive Fixed";

  // Health = collateralValue / maintenance, capped at 200% for display.
  const healthPct =
    maintenance > 0n && collateralValue > 0n
      ? Math.min(
          Math.round(Number((collateralValue * 100n) / maintenance) / 2),
          100
        )
      : 0;
  const lowHealth = collateralValue < maintenance && isOpen;

  const tenorDays = market ? Number(market.tenorSeconds) / 86_400 : null;
  const maturity = daysUntil(position.maturityTimestamp);
  const collateralPct =
    position.collateralDeposited > 0n
      ? Math.round(
          Number(
            (position.collateralRemaining * 100n) / position.collateralDeposited
          )
        )
      : 0;

  const realizedDisplay = formatPnlSigned(position.realizedPnl);
  const unrealizedDisplay = isOpen
    ? formatPnlSigned(unrealized)
    : { text: "—", cls: s.pnlDash };

  return (
    <tr
      className={
        lowHealth
          ? s.rowAlert
          : status.label === "Matured"
            ? s.rowMatured
            : !isOpen && !isMatured
              ? s.rowClosed
              : undefined
      }
    >
      <td>
        <div className={s.mktCell}>
          <span className={s.mktIco}>U</span>
          <div style={{ minWidth: 0 }}>
            <div className={s.mktTx}>Kamino USDC</div>
            <div className={s.mktSub}>
              {tenorDays != null ? `${tenorDays}D Tenor` : "Loading…"}
            </div>
          </div>
        </div>
      </td>
      <td>
        <span className={`${s.dirPill} ${dirCls}`}>{dirLabel}</span>
      </td>
      <td className={s.right}>
        ${formatUsdc(position.notional, { withSymbol: false })}
      </td>
      <td
        className={`${s.right} ${
          position.direction === SwapDirection.PayFixed
            ? "pink-text"
            : "blue-text"
        }`}
      >
        {formatBps(position.fixedRateBps)}
      </td>
      <td>
        <div className={`${s.coll} ${lowHealth ? s.warn : ""}`}>
          <span className={s.collTop}>
            {lowHealth ? <span className={s.warnGlyph}>!</span> : null}$
            {formatUsdc(position.collateralRemaining, { withSymbol: false })}
          </span>
          <span className={s.collBot}>
            of ${formatUsdc(position.collateralDeposited, { withSymbol: false })} ·{" "}
            {collateralPct}%
          </span>
        </div>
      </td>
      <td className={`${s.right} ${realizedDisplay.cls}`}>
        {realizedDisplay.text}
      </td>
      <td
        className={`${s.right} ${unrealizedDisplay.cls}`}
        style={isOpen && unrealized < 0n ? { color: "rgba(239,68,68,.75)" } : undefined}
      >
        {unrealizedDisplay.text}
      </td>
      <td>
        {isOpen ? (
          <HealthBar pct={healthPct} alert={lowHealth} />
        ) : (
          <span className={s.pnlDash} style={{ fontSize: 11 }}>—</span>
        )}
      </td>
      <td>
        <div className={s.sett}>
          <span className={s.settValue}>
            {position.numSettlements}
            {derived.totalPlannedSettlements > 0
              ? `/${derived.totalPlannedSettlements}`
              : ""}
          </span>
          <div className={s.settBar}>
            <div
              className={s.settFill}
              style={{
                width:
                  derived.totalPlannedSettlements > 0
                    ? `${Math.min(
                        (position.numSettlements / derived.totalPlannedSettlements) *
                          100,
                        100
                      )}%`
                    : "0%",
                opacity: !isOpen ? 0.4 : 1,
              }}
            />
          </div>
        </div>
      </td>
      <td>
        <div className={`${s.mat} ${isMatured ? s.matured : ""}`}>
          <span className={s.matDate}>{maturity.date}</span>
          <span className={s.matRel}>
            {!isOpen && !isMatured ? "closed early" : maturity.rel}
          </span>
        </div>
      </td>
      <td>
        <span className={`${s.statusBadge} ${status.cls}`}>{status.label}</span>
      </td>
      <td className={s.right}>
        <div className={s.acts}>
          {isOpen && market ? (
            <>
              <button
                className={`${s.miniBtn} ${lowHealth ? s.pink : ""}`}
                type="button"
                onClick={() => onAction("addCollateral", position, market)}
              >
                + Collateral
              </button>
              <button
                className={`${s.miniBtn} ${!lowHealth ? s.pink : ""}`}
                type="button"
                onClick={() => onAction("closeEarly", position, market)}
              >
                Close Early
              </button>
            </>
          ) : isMatured && market ? (
            <button
              className={`${s.miniBtn} ${s.solidPink} ${s.claim}`}
              type="button"
              onClick={() => onAction("claim", position, market)}
            >
              Claim →
            </button>
          ) : (
            <span style={{ fontSize: 11, color: "var(--text-3)" }}>—</span>
          )}
        </div>
      </td>
    </tr>
  );
}

// ─── SwapTable ─────────────────────────────────────────────────────────────

function SwapTable({
  derivedRows,
  filter,
  hasWallet,
  isLoading,
  onAction,
}: {
  derivedRows: DerivedSwap[];
  filter: Filter;
  hasWallet: boolean;
  isLoading: boolean;
  onAction: (
    action: "addCollateral" | "closeEarly" | "claim",
    position: SwapPosition,
    market: Market
  ) => void;
}) {
  const visible = useMemo(() => {
    if (filter === "ALL") return derivedRows;
    return derivedRows.filter(
      (d) => statusToBadge(d.position.status).filter === filter
    );
  }, [derivedRows, filter]);

  if (!hasWallet) {
    return (
      <div className={s.emptyState}>
        Connect a wallet to see your swap positions.
      </div>
    );
  }
  if (isLoading && derivedRows.length === 0) {
    return <div className={s.emptyState}>Loading positions…</div>;
  }
  if (visible.length === 0) {
    return (
      <div className={s.emptyState}>
        {derivedRows.length === 0
          ? "No swap positions yet — open one on /trade."
          : `No positions match "${filter}".`}
      </div>
    );
  }

  return (
    <div className={s.tblWrap}>
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
          {visible.map((d) => (
            <SwapRow key={d.position.publicKey} derived={d} onAction={onAction} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── LP cards ──────────────────────────────────────────────────────────────

function LpCards({
  positions,
  marketsByAddress,
  hasWallet,
  isLoading,
}: {
  positions: LpPosition[];
  marketsByAddress: Map<string, Market>;
  hasWallet: boolean;
  isLoading: boolean;
}) {
  if (!hasWallet) {
    return (
      <div className={s.emptyState}>
        Connect a wallet to see your LP positions.
      </div>
    );
  }
  if (isLoading && positions.length === 0) {
    return <div className={s.emptyState}>Loading LP positions…</div>;
  }
  if (positions.length === 0) {
    return (
      <div className={s.emptyState}>
        No LP positions yet — deposit on{" "}
        <Link href="/lp" style={{ color: "var(--pink)" }}>
          /lp
        </Link>
        .
      </div>
    );
  }

  return (
    <div className={s.lpGrid}>
      {positions.map((pos) => {
        const market = marketsByAddress.get(pos.market);
        const value =
          market && market.totalLpShares > 0n
            ? (pos.shares * market.lpNav) / market.totalLpShares
            : 0n;
        const earned =
          value >= pos.depositedAmount ? value - pos.depositedAmount : 0n;
        const sharePct =
          market && market.totalLpShares > 0n
            ? (Number((pos.shares * 10_000n) / market.totalLpShares) / 100).toFixed(2)
            : "—";
        return (
          <div key={pos.publicKey} className={`${s.card} ${s.lpCard}`}>
            <div className={s.lpHead}>
              <div className={s.lpTitle}>
                <span className={s.mktIco}>K</span>Kamino USDC Pool
              </div>
              <span className={`${s.lpStat} ${s.active}`}>Active</span>
            </div>
            <div className={s.lpValueLbl}>Current Value</div>
            <div className={s.lpValue}>
              ${formatUsdc(value, { withSymbol: false })}
            </div>
            <div className={s.lpDelta}>
              <span className="big">
                {formatPnlSigned(earned).text}
              </span>
              <span className="sub">since deposit</span>
            </div>
            <table className={s.lpTbl}>
              <tbody>
                <tr>
                  <td>Shares</td>
                  <td>{formatUsdc(pos.shares, { withSymbol: false })} aUSDC</td>
                </tr>
                <tr>
                  <td>Deposited</td>
                  <td>${formatUsdc(pos.depositedAmount, { withSymbol: false })}</td>
                </tr>
                <tr>
                  <td>Your share of pool</td>
                  <td>{sharePct}%</td>
                </tr>
                <tr>
                  <td>Pool TVL</td>
                  <td>{market ? formatUsdcCompact(market.lpNav) : "—"}</td>
                </tr>
              </tbody>
            </table>
            <div className={s.lpActs}>
              <Link
                className={s.miniBtn}
                href={`/lp?market=${pos.market}`}
              >
                Deposit
              </Link>
              <Link
                className={`${s.miniBtn} ${s.pink}`}
                href={`/lp?market=${pos.market}`}
              >
                Withdraw
              </Link>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Add-Collateral inline modal ───────────────────────────────────────────

interface AddCollateralModalProps {
  position: SwapPosition;
  market: Market;
  onClose: () => void;
  onSuccess: (sig: string) => void;
}

function AddCollateralModal({
  position,
  market,
  onClose,
  onSuccess,
}: AddCollateralModalProps) {
  const [amount, setAmount] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const anchorWallet = useAnchorWallet();

  const submit = async () => {
    if (!anchorWallet) return;
    const amt = parseUsdcInput(amount);
    if (!amt || amt <= 0n) {
      setError("Enter a positive USDC amount.");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const client = buildClient(anchorWallet);
      const result = await client.trader.addCollateral.execute({
        owner: anchorWallet.publicKey,
        market: new PublicKey(market.publicKey),
        underlyingMint: new PublicKey(market.underlyingMint),
        collateralVault: new PublicKey(market.collateralVault),
        nonce: position.nonce,
        amount: amt,
      });
      onSuccess(result.signature);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        className={s.card}
        style={{
          padding: 24,
          width: "min(420px, calc(100% - 32px))",
          background: "var(--surface)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: 0, marginBottom: 12 }}>Add collateral</h3>
        <div style={{ fontSize: 12, color: "var(--text-2)", marginBottom: 16 }}>
          Position {formatPubkey(position.publicKey)} · current{" "}
          {formatUsdc(position.collateralRemaining, { withSymbol: true })}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00 USDC"
            inputMode="decimal"
            style={{
              padding: "10px 12px",
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text)",
              borderRadius: 8,
              fontSize: 14,
              width: "100%",
            }}
          />
          {error ? <div className={s.errorBanner}>{error}</div> : null}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              className={s.miniBtn}
              type="button"
              onClick={onClose}
              disabled={pending}
              style={{ flex: 1 }}
            >
              Cancel
            </button>
            <button
              className={`${s.miniBtn} ${s.pink}`}
              type="button"
              onClick={submit}
              disabled={pending || !parseUsdcInput(amount)}
              style={{ flex: 1 }}
            >
              {pending ? "Submitting…" : "Confirm"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Page wrapper ──────────────────────────────────────────────────────────

export default function PortfolioPage() {
  const wallet = useWallet();
  const anchorWallet = useAnchorWallet();
  const { connection } = useConnection();
  const owner = wallet.publicKey?.toBase58();

  const { data: protocol } = useProtocol();
  const { data: markets } = useMarkets();
  const {
    data: traderPositions,
    isLoading: loadingTrader,
    mutate: refetchTrader,
  } = useTraderPositions(owner);
  const {
    data: lpPositions,
    isLoading: loadingLp,
    mutate: refetchLp,
  } = useLpPositionsByOwner(owner);

  const [tab, setTab] = useState<Tab>("swap");
  const [filter, setFilter] = useState<Filter>("ALL");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSig, setActionSig] = useState<string | null>(null);
  const [addModalFor, setAddModalFor] = useState<{
    position: SwapPosition;
    market: Market;
  } | null>(null);

  const marketsByAddress = useMemo(() => {
    const m = new Map<string, Market>();
    for (const market of markets ?? []) m.set(market.publicKey, market);
    return m;
  }, [markets]);

  const derivedSwaps = useMemo<DerivedSwap[]>(() => {
    if (!traderPositions) return [];
    return traderPositions.map((p) =>
      deriveSwap(p, marketsByAddress.get(p.market))
    );
  }, [traderPositions, marketsByAddress]);

  const stats = useMemo<SummaryStats>(() => {
    let totalValue = 0n;
    let realized = 0n;
    let unrealized = 0n;
    let openSwaps = 0;
    let matured = 0;
    let liquidated = 0;

    for (const d of derivedSwaps) {
      realized += d.position.realizedPnl;
      if (d.position.status === PositionStatus.Open) {
        unrealized += d.unrealized;
        totalValue += d.collateralValue;
        openSwaps += 1;
      } else if (d.position.status === PositionStatus.Matured) {
        matured += 1;
        totalValue += d.position.collateralRemaining;
      } else if (d.position.status === PositionStatus.Liquidated) {
        liquidated += 1;
      }
    }

    for (const lp of lpPositions ?? []) {
      const market = marketsByAddress.get(lp.market);
      if (market && market.totalLpShares > 0n) {
        totalValue += (lp.shares * market.lpNav) / market.totalLpShares;
      }
    }

    return {
      totalValue,
      realizedPnl: realized,
      unrealizedPnl: unrealized,
      swapCount: openSwaps,
      lpCount: lpPositions?.length ?? 0,
      matured,
      liquidated,
    };
  }, [derivedSwaps, lpPositions, marketsByAddress]);

  const refresh = () => {
    refetchTrader();
    refetchLp();
  };

  const handleAction = async (
    action: "addCollateral" | "closeEarly" | "claim",
    position: SwapPosition,
    market: Market
  ) => {
    if (!anchorWallet || !protocol) return;
    setActionError(null);
    setActionSig(null);

    if (action === "addCollateral") {
      setAddModalFor({ position, market });
      return;
    }

    try {
      const client = buildClient(anchorWallet);
      const kamino = await resolveKaminoCpiAccounts(
        connection,
        new PublicKey(market.underlyingReserve)
      );

      let signature: string;
      if (action === "closeEarly") {
        const result = await client.trader.closePositionEarly.execute({
          owner: anchorWallet.publicKey,
          market: new PublicKey(market.publicKey),
          swapPosition: new PublicKey(position.publicKey),
          underlyingMint: new PublicKey(market.underlyingMint),
          lpVault: new PublicKey(market.lpVault),
          collateralVault: new PublicKey(market.collateralVault),
          treasury: new PublicKey(protocol.treasury),
          kaminoReserve: new PublicKey(market.underlyingReserve),
          kaminoLendingMarket: kamino.kaminoLendingMarket,
          kaminoLendingMarketAuthority: kamino.kaminoLendingMarketAuthority,
          reserveLiquidityMint: new PublicKey(market.underlyingMint),
          reserveLiquiditySupply: kamino.reserveLiquiditySupply,
          reserveCollateralMint: kamino.reserveCollateralMint,
          collateralTokenProgram: SPL_TOKEN_PROGRAM,
          liquidityTokenProgram: SPL_TOKEN_PROGRAM,
        });
        signature = result.signature;
      } else {
        const result = await client.trader.claimMatured.execute({
          owner: anchorWallet.publicKey,
          market: new PublicKey(market.publicKey),
          swapPosition: new PublicKey(position.publicKey),
          underlyingMint: new PublicKey(market.underlyingMint),
          lpVault: new PublicKey(market.lpVault),
          collateralVault: new PublicKey(market.collateralVault),
          kaminoReserve: new PublicKey(market.underlyingReserve),
          kaminoLendingMarket: kamino.kaminoLendingMarket,
          kaminoLendingMarketAuthority: kamino.kaminoLendingMarketAuthority,
          reserveLiquidityMint: new PublicKey(market.underlyingMint),
          reserveLiquiditySupply: kamino.reserveLiquiditySupply,
          reserveCollateralMint: kamino.reserveCollateralMint,
          collateralTokenProgram: SPL_TOKEN_PROGRAM,
          liquidityTokenProgram: SPL_TOKEN_PROGRAM,
        });
        signature = result.signature;
      }
      setActionSig(signature);
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const hasWallet = !!wallet.publicKey;

  return (
    <>
      <RevealOnScroll />
      <Nav />
      <SummaryStrip stats={stats} hasWallet={hasWallet} />
      <TabsRow
        tab={tab}
        setTab={setTab}
        filter={filter}
        setFilter={setFilter}
        swapCount={traderPositions?.length ?? 0}
        lpCount={lpPositions?.length ?? 0}
      />
      <section className={s.sectionBody}>
        <div className={`wrap ${s.sectionWrap}`}>
          <div className={s.hintRow}>
            <span>Rates refresh every 30s</span>
            <span className={s.hintSep}>·</span>
            <span>Settlements posted by keeper as they come due</span>
          </div>
          {actionError ? (
            <div className={s.errorBanner}>{actionError}</div>
          ) : null}
          {actionSig ? (
            <div className={s.successBanner}>
              <span>Transaction confirmed</span>
              <a
                href={explorerTxUrl(actionSig)}
                target="_blank"
                rel="noreferrer"
              >
                {actionSig.slice(0, 16)}…{actionSig.slice(-8)} ↗
              </a>
            </div>
          ) : null}
          {tab === "swap" ? (
            <SwapTable
              derivedRows={derivedSwaps}
              filter={filter}
              hasWallet={hasWallet}
              isLoading={loadingTrader}
              onAction={handleAction}
            />
          ) : (
            <LpCards
              positions={lpPositions ?? []}
              marketsByAddress={marketsByAddress}
              hasWallet={hasWallet}
              isLoading={loadingLp}
            />
          )}
        </div>
      </section>
      {addModalFor ? (
        <AddCollateralModal
          position={addModalFor.position}
          market={addModalFor.market}
          onClose={() => setAddModalFor(null)}
          onSuccess={(sig) => {
            setAddModalFor(null);
            setActionSig(sig);
            refresh();
          }}
        />
      ) : null}
      <Footer />
    </>
  );
}
