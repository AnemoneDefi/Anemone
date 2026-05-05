"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  useAnchorWallet,
  useConnection,
  useWallet,
} from "@solana/wallet-adapter-react";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { Market, LpPosition, Protocol } from "@anemone/sdk";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { RevealOnScroll } from "@/components/RevealOnScroll";
import {
  useMarkets,
  useMarket,
  useLpPosition,
  useProtocol,
} from "@/lib/hooks";
import { useTokenBalance } from "@/lib/balance";
import { buildClient } from "@/lib/anemone";
import {
  resolveKaminoCpiAccounts,
  buildRefreshReserveIx,
  KAMINO_USDC_LENDING_MARKET,
  KAMINO_SCOPE_PRICES,
  KAMINO_PROGRAM_ID,
} from "@/lib/kamino";
import {
  calculateApyBps,
  formatApy,
  formatBps,
  formatUsdc,
  formatUsdcCompact,
  utilizationPct,
} from "@/lib/format";
import s from "./lp.module.css";

const USDC_DECIMALS = 6;
const USDC_DIVISOR = 10n ** BigInt(USDC_DECIMALS);

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
  if (network === "mainnet") {
    return `https://explorer.solana.com/tx/${signature}`;
  }
  if (network === "devnet") {
    return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
  }
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

// ─── PoolStrip ─────────────────────────────────────────────────────────────

function PoolStrip({ market }: { market: Market | null | undefined }) {
  if (!market) {
    return (
      <div className={s.poolStrip}>
        <div className={`wrap ${s.poolStripWrap}`}>
          <span className={s.psStatKey} style={{ padding: "20px 0" }}>
            {market === null ? "Market not found on this RPC" : "Loading market…"}
          </span>
        </div>
      </div>
    );
  }

  const elapsed =
    market.lastRateUpdateTs > market.previousRateUpdateTs
      ? market.lastRateUpdateTs - market.previousRateUpdateTs
      : 0n;
  const baseApyBps = calculateApyBps(
    market.previousRateIndex,
    market.currentRateIndex,
    elapsed
  );
  const spreadBps = BigInt(market.baseSpreadBps);
  const estimatedApyBps = baseApyBps + spreadBps;

  const totalNotional = market.totalFixedNotional + market.totalVariableNotional;
  const util = utilizationPct(totalNotional, market.lpNav);

  const payShare =
    market.totalFixedNotional + market.totalVariableNotional === 0n
      ? 50
      : Math.round(
          Number((market.totalFixedNotional * 100n) /
            (market.totalFixedNotional + market.totalVariableNotional))
        );
  const recvShare = 100 - payShare;
  const direction =
    Math.abs(payShare - 50) <= 5 ? "Balanced" : payShare > 50 ? "Pay-heavy" : "Recv-heavy";

  return (
    <div className={s.poolStrip}>
      <div className={`wrap ${s.poolStripWrap}`}>
        <button className={s.mktSelect} type="button">
          <span className={s.mkDot}>K</span>
          <span>Kamino USDC Pool · {Number(market.tenorSeconds) / 86_400}D tenor</span>
          <span className={s.chev}>▾</span>
        </button>
        <div className={s.vDiv} />
        <div className={s.psStat}>
          <span className={s.psStatKey}>TVL</span>
          <span className={s.psStatValue}>{formatUsdcCompact(market.lpNav)}</span>
        </div>
        <div className={s.psStat}>
          <span className={s.psStatKey}>Estimated APY</span>
          <span className={`${s.psStatValue} ${s.pink}`}>{formatBps(estimatedApyBps)}</span>
        </div>
        <div className={s.psStat}>
          <span className={s.psStatKey}>Kamino base</span>
          <span className={s.psStatValue}>
            <span className={s.dotBlue} />{formatBps(baseApyBps)}
          </span>
        </div>
        <div className={s.psStat}>
          <span className={s.psStatKey}>Spread yield</span>
          <span className={s.psStatValue}>
            <span className={s.dotPinkStatic} />{formatBps(spreadBps)}
          </span>
        </div>
        <div className={s.psStat}>
          <span className={s.psStatKey}>Utilization</span>
          <div className={s.utilMini}>
            <span className={s.psStatValue} style={{ fontSize: 14 }}>{util}%</span>
            <span className={s.utilBar}>
              <span className={s.utilBarFill} style={{ width: `${util}%` }} />
            </span>
          </div>
        </div>
        <div className={s.psStat}>
          <span className={s.psStatKey}>Pool direction</span>
          <div className={s.utilMini}>
            <span className={s.dirBar}>
              <span className={s.dirBarPay} style={{ width: `${payShare}%` }} />
              <span className={s.dirBarReceive} style={{ width: `${recvShare}%` }} />
            </span>
            <span className={s.psStatValue} style={{ fontSize: 13 }}>{direction}</span>
          </div>
        </div>
        <div className={s.psRight}>
          <span>Last rate update {timeAgo(market.lastRateUpdateTs)}</span>
          <span>·</span>
          <span>
            <span className="dot-pink" style={{ animationDuration: "2.4s" }} />
            Live on-chain
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Hero / charts (kept mocked per partner spec) ──────────────────────────

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
              <span className={s.apyEyebrow}>Realized APY · Last 30 Days (mock — historical indexer pending)</span>
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

// ─── DepositCard ───────────────────────────────────────────────────────────

type Tab = "deposit" | "withdraw";

interface DepositCardProps {
  market: Market | null | undefined;
  protocol: Protocol | null | undefined;
  lpPosition: LpPosition | null | undefined;
  refresh: () => void;
}

function DepositCard({ market, protocol, lpPosition, refresh }: DepositCardProps) {
  const [tab, setTab] = useState<Tab>("deposit");
  const [amount, setAmount] = useState("");
  const [shares, setShares] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);

  const wallet = useWallet();
  const anchorWallet = useAnchorWallet();
  const { connection } = useConnection();

  const { data: usdcBalance } = useTokenBalance(
    wallet.publicKey?.toBase58(),
    market?.underlyingMint
  );
  const { data: lpBalance } = useTokenBalance(
    wallet.publicKey?.toBase58(),
    market?.lpMint
  );

  const reset = () => {
    setError(null);
    setSignature(null);
  };

  const handleQuickPick = (pct: number | "max") => {
    if (tab === "deposit") {
      const balance = usdcBalance ?? 0n;
      const value = pct === "max" ? balance : (balance * BigInt(pct)) / 100n;
      setAmount(formatUsdc(value, { withSymbol: false, maxFractionDigits: 6 }));
    } else {
      const balance = lpBalance ?? 0n;
      const value = pct === "max" ? balance : (balance * BigInt(pct)) / 100n;
      setShares(formatUsdc(value, { withSymbol: false, maxFractionDigits: 6 }));
    }
  };

  const previewSharesFromAmount = useMemo<bigint | null>(() => {
    if (!market) return null;
    const amt = parseUsdcInput(amount);
    if (amt == null) return null;
    if (market.totalLpShares === 0n || market.lpNav === 0n) return amt;
    return (amt * market.totalLpShares) / market.lpNav;
  }, [amount, market]);

  const previewUsdcFromShares = useMemo<bigint | null>(() => {
    if (!market) return null;
    const sh = parseUsdcInput(shares);
    if (sh == null) return null;
    if (market.totalLpShares === 0n) return 0n;
    const gross = (sh * market.lpNav) / market.totalLpShares;
    const feeBps = BigInt(protocol?.withdrawalFeeBps ?? 0);
    const fee = (gross * feeBps) / 10_000n;
    return gross - fee;
  }, [shares, market, protocol]);

  const handleDeposit = async () => {
    if (!anchorWallet || !market) return;
    const amt = parseUsdcInput(amount);
    if (amt == null || amt <= 0n) {
      setError("Enter a valid USDC amount.");
      return;
    }
    if (usdcBalance != null && amt > usdcBalance) {
      setError(
        `Amount exceeds wallet balance ($${formatUsdc(usdcBalance, { withSymbol: false })} USDC available).`
      );
      return;
    }
    reset();
    setPending(true);
    try {
      const client = buildClient(anchorWallet);
      const lpMint = new PublicKey(market.lpMint);
      const marketPda = new PublicKey(market.publicKey);
      const reserve = new PublicKey(market.underlyingReserve);
      const kaminoDepositAccount = new PublicKey(market.kaminoDepositAccount);
      const preInstructions: TransactionInstruction[] = [];

      // 1. createATA(lp_mint, depositor) — defensive (program also has
      //    init_if_needed). Idempotent.
      const lpAta = getAssociatedTokenAddressSync(lpMint, anchorWallet.publicKey);
      const ataInfo = await connection.getAccountInfo(lpAta);
      if (!ataInfo) {
        preInstructions.push(
          createAssociatedTokenAccountIdempotentInstruction(
            anchorWallet.publicKey,
            lpAta,
            anchorWallet.publicKey,
            lpMint
          )
        );
      }

      // 2. Bundle refresh_reserve + sync_kamino_yield so deposit_liquidity's
      //    MAX_NAV_STALENESS_SECS gate passes. In production the keeper bot
      //    runs sync every 5 min, but in dev the user is the keeper.
      preInstructions.push(buildRefreshReserveIx(reserve));
      const syncIx = await client.program.methods
        .syncKaminoYield()
        .accountsStrict({
          market: marketPda,
          kaminoReserve: reserve,
          kaminoDepositAccount,
          kaminoLendingMarket: KAMINO_USDC_LENDING_MARKET,
          // Reserve uses Scope only — pass kaminoProgram as placeholder for
          // pyth/switchboard slots (per SyncKaminoYield doc).
          pythOracle: KAMINO_PROGRAM_ID,
          switchboardPriceOracle: KAMINO_PROGRAM_ID,
          switchboardTwapOracle: KAMINO_PROGRAM_ID,
          scopePrices: KAMINO_SCOPE_PRICES,
          kaminoProgram: KAMINO_PROGRAM_ID,
          tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        })
        .instruction();
      preInstructions.push(syncIx);

      const result = await client.lp.depositLiquidity.execute({
        depositor: anchorWallet.publicKey,
        market: marketPda,
        underlyingMint: new PublicKey(market.underlyingMint),
        lpMint,
        lpVault: new PublicKey(market.lpVault),
        amount: amt,
        preInstructions,
      });
      setSignature(result.signature);
      setAmount("");
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  const handleWithdraw = async () => {
    if (!anchorWallet || !market || !protocol) return;
    const sh = parseUsdcInput(shares);
    if (sh == null || sh <= 0n) {
      setError("Enter a valid share amount.");
      return;
    }
    if (lpBalance != null && sh > lpBalance) {
      setError(
        `Shares exceed your LP token balance (${formatUsdc(lpBalance, { withSymbol: false })} aUSDC available).`
      );
      return;
    }
    reset();
    setPending(true);
    try {
      const reserve = new PublicKey(market.underlyingReserve);
      const kamino = await resolveKaminoCpiAccounts(connection, reserve);
      const client = buildClient(anchorWallet);
      const marketPda = new PublicKey(market.publicKey);
      const kaminoDepositAccount = new PublicKey(market.kaminoDepositAccount);

      // Bundle refresh_reserve + sync_kamino_yield so request_withdrawal's
      // MAX_NAV_STALENESS_SECS gate passes. Same pattern as deposit.
      const preInstructions: TransactionInstruction[] = [
        buildRefreshReserveIx(reserve),
      ];
      const syncIx = await client.program.methods
        .syncKaminoYield()
        .accountsStrict({
          market: marketPda,
          kaminoReserve: reserve,
          kaminoDepositAccount,
          kaminoLendingMarket: KAMINO_USDC_LENDING_MARKET,
          pythOracle: KAMINO_PROGRAM_ID,
          switchboardPriceOracle: KAMINO_PROGRAM_ID,
          switchboardTwapOracle: KAMINO_PROGRAM_ID,
          scopePrices: KAMINO_SCOPE_PRICES,
          kaminoProgram: KAMINO_PROGRAM_ID,
          tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        })
        .instruction();
      preInstructions.push(syncIx);

      const result = await client.lp.requestWithdrawal.execute({
        withdrawer: anchorWallet.publicKey,
        market: marketPda,
        underlyingMint: new PublicKey(market.underlyingMint),
        lpMint: new PublicKey(market.lpMint),
        lpVault: new PublicKey(market.lpVault),
        treasury: new PublicKey(protocol.treasury),
        sharesToBurn: sh,
        kaminoReserve: reserve,
        kaminoLendingMarket: kamino.kaminoLendingMarket,
        kaminoLendingMarketAuthority: kamino.kaminoLendingMarketAuthority,
        reserveLiquidityMint: new PublicKey(market.underlyingMint),
        reserveLiquiditySupply: kamino.reserveLiquiditySupply,
        reserveCollateralMint: kamino.reserveCollateralMint,
        // Surfpool/mainnet: USDC + Kamino k-tokens are SPL Token (not Token-2022).
        // For Token-2022 underlyings these need to come from market state.
        collateralTokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        liquidityTokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        preInstructions,
      });
      setSignature(result.signature);
      setShares("");
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  const isDeposit = tab === "deposit";
  const balance = isDeposit ? usdcBalance : lpBalance;
  const balanceLabel = isDeposit ? "USDC" : "aUSDC";
  const inputValue = isDeposit ? amount : shares;
  const setInputValue = isDeposit ? setAmount : setShares;
  const hasWallet = !!wallet.publicKey;
  const canSubmit =
    hasWallet && !!market && !pending && !!parseUsdcInput(inputValue);

  return (
    <div className={`${s.card} ${s.depCard} reveal`}>
      <div className={s.depTabs}>
        <button
          className={`${s.depTab} ${tab === "deposit" ? s.active : ""}`}
          onClick={() => { setTab("deposit"); reset(); }}
          type="button"
        >
          Deposit
        </button>
        <button
          className={`${s.depTab} ${tab === "withdraw" ? s.active : ""}`}
          onClick={() => { setTab("withdraw"); reset(); }}
          type="button"
        >
          Withdraw
        </button>
      </div>
      <div className={s.depBody}>
        <div className={s.depRow}>
          <span className="eyebrow" style={{ display: "block", marginBottom: 10 }}>
            {isDeposit ? "Amount" : "Shares to burn"}
          </span>
          <div className={s.amountBox}>
            <span className="prefix">{isDeposit ? "$" : ""}</span>
            <input
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="0.00"
              inputMode="decimal"
            />
            <span className="suffix">{balanceLabel}</span>
          </div>
          <div className={s.balHint}>
            Wallet balance:{" "}
            <span style={{ color: "var(--text-2)" }}>
              {hasWallet
                ? balance == null
                  ? "—"
                  : `${formatUsdc(balance, { withSymbol: false })} ${balanceLabel}`
                : "—"}
            </span>
          </div>
          <div className={s.qpRow}>
            {[25, 50, 75].map((p) => (
              <button
                key={p}
                className={s.qp}
                type="button"
                onClick={() => handleQuickPick(p)}
                disabled={!hasWallet}
              >
                {p}%
              </button>
            ))}
            <button
              className={s.qp}
              type="button"
              onClick={() => handleQuickPick("max")}
              disabled={!hasWallet}
            >
              MAX
            </button>
          </div>
        </div>

        <div className={s.depRow}>
          <span className="eyebrow" style={{ display: "block", marginBottom: 10 }}>
            You receive
          </span>
          <div className={s.receive}>
            <div className={s.receiveBig}>
              {isDeposit
                ? previewSharesFromAmount != null
                  ? formatUsdc(previewSharesFromAmount, { withSymbol: false })
                  : "—"
                : previewUsdcFromShares != null
                  ? `$${formatUsdc(previewUsdcFromShares, { withSymbol: false })}`
                  : "—"}
              <span style={{ color: "var(--text-2)", fontSize: 18, marginLeft: 8 }}>
                {isDeposit ? "aUSDC" : "USDC"}
              </span>
            </div>
            <div className={s.receiveSub}>
              {market && market.totalLpShares > 0n
                ? `Share price: $${formatUsdc(
                    (market.lpNav * 10_000n) / market.totalLpShares,
                    { withSymbol: false, maxFractionDigits: 4 }
                  )} per share`
                : market
                  ? "First depositor — share price 1.0000"
                  : ""}
              {!isDeposit && protocol?.withdrawalFeeBps
                ? ` · Withdrawal fee ${formatBps(protocol.withdrawalFeeBps)}`
                : ""}
            </div>
          </div>
        </div>

        <div className={s.depRow}>
          <button
            className={`${s.ctaPrimary} ${!canSubmit ? s.disabled : ""}`}
            type="button"
            onClick={isDeposit ? handleDeposit : handleWithdraw}
            disabled={!canSubmit}
          >
            {pending ? "Submitting…" : isDeposit ? "Deposit →" : "Withdraw →"}
          </button>
          <div className={s.ctaHint}>
            {!hasWallet
              ? `Connect wallet to ${tab}`
              : !market
                ? "Loading market…"
                : ""}
          </div>
          {error ? <div className={s.errorBanner}>{error}</div> : null}
          {signature ? (
            <div className={s.successBanner}>
              <span>{isDeposit ? "Deposit confirmed" : "Withdrawal confirmed"}</span>
              <a href={explorerTxUrl(signature)} target="_blank" rel="noreferrer">
                {signature.slice(0, 16)}…{signature.slice(-8)} ↗
              </a>
            </div>
          ) : null}
          <div className={s.finePrint}>
            {isDeposit
              ? "Deposit mints aUSDC representing your share. Yield accrues to share price."
              : "Withdrawals redeem from lp_vault first; if light, the program redeems Kamino k-tokens atomically."}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── PositionCard ──────────────────────────────────────────────────────────

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

interface PositionCardProps {
  market: Market | null | undefined;
  lpPosition: LpPosition | null | undefined;
  hasWallet: boolean;
}

function PositionCard({ market, lpPosition, hasWallet }: PositionCardProps) {
  const sharesHeld = lpPosition?.shares ?? 0n;
  const currentValue =
    market && lpPosition && market.totalLpShares > 0n
      ? (lpPosition.shares * market.lpNav) / market.totalLpShares
      : 0n;
  const deposited = lpPosition?.depositedAmount ?? 0n;
  const totalEarned = currentValue >= deposited ? currentValue - deposited : 0n;
  const sharePctBps =
    market && lpPosition && market.totalLpShares > 0n
      ? Number((lpPosition.shares * 10_000n) / market.totalLpShares)
      : 0;

  return (
    <div className={`${s.card} ${s.posCard} reveal`}>
      <div className={s.posHead}>
        <h3>Your Position</h3>
        <span className={s.posPill}>
          <span className="tok">A</span>aUSDC
        </span>
      </div>
      {!hasWallet ? (
        <div style={{ padding: "32px 0", color: "var(--text-2)", textAlign: "center" }}>
          Connect wallet to see your LP position.
        </div>
      ) : !lpPosition ? (
        <div style={{ padding: "32px 0", color: "var(--text-2)", textAlign: "center" }}>
          No LP position yet — deposit USDC to mint shares.
        </div>
      ) : (
        <table className={s.posTbl}>
          <tbody>
            <tr>
              <td>Shares held</td>
              <td>{formatUsdc(sharesHeld, { withSymbol: false })} aUSDC</td>
            </tr>
            <tr>
              <td>Current value</td>
              <td>${formatUsdc(currentValue, { withSymbol: false })}</td>
            </tr>
            <tr>
              <td>Deposited</td>
              <td>${formatUsdc(deposited, { withSymbol: false })}</td>
            </tr>
            <tr className={s.totalEarn}>
              <td>Total earned</td>
              <td>+${formatUsdc(totalEarned, { withSymbol: false })}</td>
            </tr>
            <tr>
              <td>Your share of pool</td>
              <td>{(sharePctBps / 100).toFixed(2)}%</td>
            </tr>
          </tbody>
        </table>
      )}

      <div className={s.posChart}>
        <div className={s.posChartTitle}>Your LP value vs Kamino direct (mock — partner refresh)</div>
        <LpChart />
      </div>
    </div>
  );
}

// ─── Health (kept mocked per partner spec) ─────────────────────────────────

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

function Health({ market }: { market: Market | null | undefined }) {
  const totalNotional = market
    ? market.totalFixedNotional + market.totalVariableNotional
    : 0n;
  const util = market ? utilizationPct(totalNotional, market.lpNav) : 0;
  const cap = market ? market.maxUtilizationBps / 100 : 60;
  return (
    <section className={s.health}>
      <div className={`wrap ${s.healthGrid}`}>
        <div className={`${s.card} ${s.healthCard} reveal`}>
          <div className={s.hTitle}>Pool Utilization</div>
          <Gauge pct={util} cap={cap} />
        </div>
        <div className={`${s.card} ${s.healthCard} reveal`}>
          <div className={s.hTitle}>Pool Direction</div>
          <div className={s.dir}>
            <div className={s.dirChart} style={{ marginTop: 18 }}>
              <div className={`${s.dirSeg} ${s.pay}`} style={{ flexBasis: "54%" }}>
                PayFixed{" "}
                {market ? formatUsdcCompact(market.totalFixedNotional) : "—"}
              </div>
              <div className={`${s.dirSeg} ${s.receive}`} style={{ flexBasis: "46%" }}>
                ReceiveFixed{" "}
                {market ? formatUsdcCompact(market.totalVariableNotional) : "—"}
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
          </div>
        </div>
        <div className={`${s.card} ${s.healthCard} reveal`}>
          <div className={s.hTitle}>Spread APY (mock — partner refresh)</div>
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

// ─── Page wrapper ──────────────────────────────────────────────────────────

function LpPageContent() {
  const searchParams = useSearchParams();
  const wallet = useWallet();
  const { data: markets } = useMarkets();
  const { data: protocol } = useProtocol();

  const marketAddress = useMemo(() => {
    const fromUrl = searchParams.get("market");
    if (fromUrl) return fromUrl;
    if (markets && markets.length > 0) return markets[0].publicKey;
    return null;
  }, [searchParams, markets]);

  const { data: market, mutate: refetchMarket } = useMarket(marketAddress);
  const { data: lpPosition, mutate: refetchLp } = useLpPosition(
    wallet.publicKey?.toBase58(),
    marketAddress
  );

  const refresh = () => {
    refetchMarket();
    refetchLp();
  };

  return (
    <>
      <RevealOnScroll />
      <Nav />
      <PoolStrip market={market} />
      <Hero />
      <section className={s.workspace}>
        <div className={`wrap ${s.workspaceGrid}`}>
          <DepositCard
            market={market}
            protocol={protocol}
            lpPosition={lpPosition}
            refresh={refresh}
          />
          <PositionCard
            market={market}
            lpPosition={lpPosition}
            hasWallet={!!wallet.publicKey}
          />
        </div>
      </section>
      <Health market={market} />
      <Footer />
    </>
  );
}

export default function LpPage() {
  return (
    <Suspense>
      <LpPageContent />
    </Suspense>
  );
}
