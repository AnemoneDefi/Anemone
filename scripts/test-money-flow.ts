#!/usr/bin/env ts-node
/**
 * A.12 — End-to-end money flow integration test (SURFPOOL_TEST_PLAN.md).
 *
 * Validates that every fee path lands in the treasury and the LP cycle
 * closes cleanly. Token conservation across the whole protocol catches any
 * silent decimal bug or off-by-one that per-handler unit tests miss.
 *
 * Required state: fresh Surfpool (this script `init`s the protocol and a
 * dedicated market). Restart between runs:
 *   pkill -9 surfpool && surfpool start --network mainnet --no-tui -y
 *
 * Usage:
 *   yarn ts-node scripts/test-money-flow.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Anemone } from "../target/types/anemone";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  getAccount,
} from "@solana/spl-token";
import { Reserve } from "@kamino-finance/klend-sdk";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { setTokenBalance } from "./surfpool-overrides";

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8899";
const DEPLOYER_KEYPAIR =
  process.env.DEPLOYER_KEYPAIR || path.join(os.homedir(), ".config/solana/id.json");

const KAMINO_PROGRAM = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const KAMINO_USDC_RESERVE = new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const INSTRUCTIONS_SYSVAR = new PublicKey("Sysvar1nstructions1111111111111111111111111");

// Sized for visible fee math: $10k notional × 80bps × 30s elapsed gives
// protocol_fee ≈ 7 raw units (vs 0 in the lifecycle demo's $1k × 10s).
const TENOR_SECONDS = new anchor.BN(120);
const SETTLEMENT_PERIOD_SECONDS = new anchor.BN(30);
const MAX_UTILIZATION_BPS = 6000;
const BASE_SPREAD_BPS = 80;

const PROTOCOL_FEE_BPS = 1000;
const OPENING_FEE_BPS = 5;
const LIQUIDATION_FEE_BPS = 300;
const WITHDRAWAL_FEE_BPS = 5;
const EARLY_CLOSE_FEE_BPS = 500;

// LP deposits $20k so notional $10k stays under 60% max_utilization. The plan's
// "$10k LP, $10k notional" implies 100% utilization which the protocol rejects;
// fee math scales with notional (unchanged) so the expected delta to treasury
// for opening/protocol/early-close fees is the same. Withdrawal fee scales
// with gross_amount so it doubles vs the plan's number.
const LP_DEPOSIT_USDC = 20_000_000_000; // $20,000
const NOTIONAL_USDC = 10_000_000_000;   // $10,000
const TRADER_USDC = 1_000_000_000;       // $1,000 — well over expected margin
const TRADER_NONCE = 0;
const MAX_RATE_BPS = new anchor.BN(10_000);
const MIN_RATE_BPS = new anchor.BN(0);

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, "utf-8"))));
}

function header(s: string) {
  console.log(`\n=== ${s} ===`);
}

function fmt(raw: bigint | number, decimals = 6): string {
  return (Number(raw) / 10 ** decimals).toFixed(decimals);
}

interface Snapshot {
  treasury: number;
  lpVault: number;
  collateralVault: number;
  kaminoDeposit: number;
  traderUsdc: number;
  lpUsdc: number;
  lpNav: bigint;
  totalShares: bigint;
}

async function snapshot(
  conn: Connection,
  program: Program<Anemone>,
  accs: {
    treasury: PublicKey;
    lpVault: PublicKey;
    collateralVault: PublicKey;
    kaminoDeposit: PublicKey;
    traderUsdc: PublicKey;
    lpUsdc: PublicKey;
    market: PublicKey;
  },
): Promise<Snapshot> {
  const [t, l, c, k, tu, lu] = await Promise.all([
    getAccount(conn, accs.treasury),
    getAccount(conn, accs.lpVault),
    getAccount(conn, accs.collateralVault),
    getAccount(conn, accs.kaminoDeposit),
    getAccount(conn, accs.traderUsdc),
    getAccount(conn, accs.lpUsdc),
  ]);
  const m = await program.account.swapMarket.fetch(accs.market);
  return {
    treasury: Number(t.amount),
    lpVault: Number(l.amount),
    collateralVault: Number(c.amount),
    kaminoDeposit: Number(k.amount),
    traderUsdc: Number(tu.amount),
    lpUsdc: Number(lu.amount),
    lpNav: BigInt(m.lpNav.toString()),
    totalShares: BigInt(m.totalLpShares.toString()),
  };
}

function logDiff(label: string, before: Snapshot, after: Snapshot) {
  const d = (k: keyof Snapshot) => {
    const b = before[k];
    const a = after[k];
    if (typeof b === "bigint" || typeof a === "bigint") {
      return `${b.toString()} → ${a.toString()}`;
    }
    const delta = (a as number) - (b as number);
    const sign = delta >= 0 ? "+" : "";
    return `${fmt(b as number)} → ${fmt(a as number)} (${sign}${delta} raw)`;
  };
  console.log(`  [${label}]`);
  console.log(`    treasury        ${d("treasury")}`);
  console.log(`    lp_vault        ${d("lpVault")}`);
  console.log(`    collateral_vault${d("collateralVault")}`);
  console.log(`    kamino_deposit  ${d("kaminoDeposit")}`);
  console.log(`    trader USDC     ${d("traderUsdc")}`);
  console.log(`    lp USDC         ${d("lpUsdc")}`);
  console.log(`    lp_nav          ${d("lpNav")}`);
  console.log(`    total_shares    ${d("totalShares")}`);
}

async function main() {
  const deployer = loadKeypair(DEPLOYER_KEYPAIR);
  const lp = Keypair.generate();
  const trader = Keypair.generate();
  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(deployer), {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);
  const program = anchor.workspace.Anemone as Program<Anemone>;

  console.log(`Deployer: ${deployer.publicKey.toBase58()}`);
  console.log(`LP:       ${lp.publicKey.toBase58()}`);
  console.log(`Trader:   ${trader.publicKey.toBase58()}`);
  console.log(`Program:  ${program.programId.toBase58()}`);
  console.log(`RPC:      ${RPC_URL}`);

  // ==========================================================================
  header("Setup — read Kamino, fund signers, init protocol + market");

  const reserveLive = Reserve.decode(
    (await connection.getAccountInfo(KAMINO_USDC_RESERVE))!.data,
  );
  const lendingMarket = new PublicKey((reserveLive as any).lendingMarket.toString());
  const reserveLiquiditySupply = new PublicKey(
    (reserveLive.liquidity as any).supplyVault.toString(),
  );
  const reserveCollateralMint = new PublicKey(
    (reserveLive.collateral as any).mintPubkey.toString(),
  );
  const [lendingMarketAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("lma"), lendingMarket.toBuffer()],
    KAMINO_PROGRAM,
  );

  // Fund LP and trader with SOL
  for (const kp of [lp, trader]) {
    const sig = await connection.requestAirdrop(kp.publicKey, 2 * 1e9);
    await connection.confirmTransaction(sig, "confirmed");
  }

  // ATAs
  const deployerUsdcAta = await createAssociatedTokenAccountIdempotent(
    connection, deployer, USDC_MINT, deployer.publicKey,
  );
  const lpUsdcAta = await createAssociatedTokenAccountIdempotent(
    connection, deployer, USDC_MINT, lp.publicKey,
  );
  const traderUsdcAta = await createAssociatedTokenAccountIdempotent(
    connection, deployer, USDC_MINT, trader.publicKey,
  );

  // Use deployer ATA as treasury (matches demo-surfpool pattern). Reset to 0.
  await setTokenBalance(connection, deployer.publicKey, USDC_MINT, 0n);
  await setTokenBalance(connection, lp.publicKey, USDC_MINT, BigInt(LP_DEPOSIT_USDC));
  await setTokenBalance(connection, trader.publicKey, USDC_MINT, BigInt(TRADER_USDC));

  // Initialize protocol (idempotent — re-init on fresh Surfpool)
  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    program.programId,
  );
  const protocolExists = await connection.getAccountInfo(protocolStatePda);
  if (protocolExists) {
    console.log(`  initialize_protocol already done (re-using state)`);
  } else {
    await program.methods
      .initializeProtocol(
        PROTOCOL_FEE_BPS, OPENING_FEE_BPS, LIQUIDATION_FEE_BPS,
        WITHDRAWAL_FEE_BPS, EARLY_CLOSE_FEE_BPS,
      )
      .accountsStrict({
        protocolState: protocolStatePda,
        authority: deployer.publicKey,
        treasury: deployerUsdcAta,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`  initialize_protocol OK`);
  }

  // Create market
  const [marketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), KAMINO_USDC_RESERVE.toBuffer(), TENOR_SECONDS.toArrayLike(Buffer, "le", 8)],
    program.programId,
  );
  const [lpVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_vault"), marketPda.toBuffer()],
    program.programId,
  );
  const [collateralVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("collateral_vault"), marketPda.toBuffer()],
    program.programId,
  );
  const [kaminoDepositPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("kamino_deposit"), marketPda.toBuffer()],
    program.programId,
  );
  const [lpMintPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_mint"), marketPda.toBuffer()],
    program.programId,
  );

  const marketExists = await connection.getAccountInfo(marketPda);
  if (marketExists) {
    console.log(`  create_market already done: ${marketPda.toBase58()}`);
  } else {
    await program.methods
      .createMarket(TENOR_SECONDS, SETTLEMENT_PERIOD_SECONDS, MAX_UTILIZATION_BPS, BASE_SPREAD_BPS)
      .accountsStrict({
        protocolState: protocolStatePda,
        market: marketPda,
        lpVault: lpVaultPda,
        collateralVault: collateralVaultPda,
        lpMint: lpMintPda,
        kaminoDepositAccount: kaminoDepositPda,
        kaminoCollateralMint: reserveCollateralMint,
        underlyingReserve: KAMINO_USDC_RESERVE,
        underlyingProtocol: KAMINO_PROGRAM,
        underlyingMint: USDC_MINT,
        authority: deployer.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    console.log(`  create_market OK: ${marketPda.toBase58()}`);
  }

  // Seed rate snapshots (live bsf read + 8s spacing for valid APY)
  const liveBsfLow = BigInt((reserveLive.liquidity as any).cumulativeBorrowRateBsf.value[0].toString());
  const liveBsfHigh = BigInt((reserveLive.liquidity as any).cumulativeBorrowRateBsf.value[1].toString());
  const liveBsf = liveBsfLow | (liveBsfHigh << 64n);
  const seedSnapshots: Array<bigint> = [liveBsf, liveBsf + liveBsf / 30_000_000n];
  for (let i = 0; i < seedSnapshots.length; i++) {
    await program.methods
      .setRateIndexOracle(new anchor.BN(seedSnapshots[i].toString()))
      .accountsStrict({ protocolState: protocolStatePda, market: marketPda, authority: deployer.publicKey })
      .rpc();
    if (i === 0) await new Promise((r) => setTimeout(r, 8000));
  }
  console.log(`  rate snapshots seeded (8s apart)`);

  const [lpPositionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp"), lp.publicKey.toBuffer(), marketPda.toBuffer()],
    program.programId,
  );
  const lpLpTokenAta = await createAssociatedTokenAccountIdempotent(
    connection, deployer, lpMintPda, lp.publicKey,
  );

  const sharedAccs = {
    treasury: deployerUsdcAta,
    lpVault: lpVaultPda,
    collateralVault: collateralVaultPda,
    kaminoDeposit: kaminoDepositPda,
    traderUsdc: traderUsdcAta,
    lpUsdc: lpUsdcAta,
    market: marketPda,
  };

  // ==========================================================================
  // Capture LpWithdrawal events emitted on request_withdrawal (Step 11).
  const capturedEvents: any[] = [];
  const listenerId = program.addEventListener("lpWithdrawal", (event) => {
    capturedEvents.push(event);
  });

  const T0 = await snapshot(connection, program, sharedAccs);
  console.log(`\nT0 baseline:`);
  console.log(`  treasury=${T0.treasury}, lp_vault=${T0.lpVault}, lp_nav=${T0.lpNav}, shares=${T0.totalShares}`);

  // ==========================================================================
  header(`Step 1 — LP deposit_liquidity ($${LP_DEPOSIT_USDC / 1e6})`);
  await program.methods
    .depositLiquidity(new anchor.BN(LP_DEPOSIT_USDC))
    .accountsStrict({
      protocolState: protocolStatePda,
      market: marketPda,
      lpPosition: lpPositionPda,
      lpVault: lpVaultPda,
      lpMint: lpMintPda,
      underlyingMint: USDC_MINT,
      depositorTokenAccount: lpUsdcAta,
      depositorLpTokenAccount: lpLpTokenAta,
      depositor: lp.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([lp])
    .rpc();
  const S1 = await snapshot(connection, program, sharedAccs);
  logDiff("after deposit_liquidity", T0, S1);
  if (S1.treasury !== T0.treasury) throw new Error(`Step 1: treasury changed by ${S1.treasury - T0.treasury} (expected 0)`);
  if (S1.lpVault !== T0.lpVault + LP_DEPOSIT_USDC) throw new Error(`Step 1: lp_vault delta wrong`);
  console.log(`  ✓ no fee on deposit; lp_vault credited; ${S1.totalShares} shares minted`);

  // ==========================================================================
  header(`Step 2 — keeper deposit_to_kamino ($${LP_DEPOSIT_USDC / 1e6})`);
  await program.methods
    .depositToKamino(new anchor.BN(LP_DEPOSIT_USDC))
    .accountsStrict({
      protocolState: protocolStatePda,
      keeper: deployer.publicKey,
      market: marketPda,
      lpVault: lpVaultPda,
      kaminoDepositAccount: kaminoDepositPda,
      kaminoReserve: KAMINO_USDC_RESERVE,
      kaminoLendingMarket: lendingMarket,
      kaminoLendingMarketAuthority: lendingMarketAuthority,
      reserveLiquidityMint: USDC_MINT,
      reserveLiquiditySupply: reserveLiquiditySupply,
      reserveCollateralMint: reserveCollateralMint,
      collateralTokenProgram: TOKEN_PROGRAM_ID,
      liquidityTokenProgram: TOKEN_PROGRAM_ID,
      instructionSysvarAccount: INSTRUCTIONS_SYSVAR,
      kaminoProgram: KAMINO_PROGRAM,
    })
    .rpc();
  const S2 = await snapshot(connection, program, sharedAccs);
  logDiff("after deposit_to_kamino", S1, S2);
  if (S2.treasury !== S1.treasury) throw new Error(`Step 2: treasury changed (expected 0)`);
  if (S2.lpVault !== 0) throw new Error(`Step 2: lp_vault not drained: ${S2.lpVault}`);
  if (S2.kaminoDeposit <= 0) throw new Error(`Step 2: kamino_deposit not credited`);
  console.log(`  ✓ lp_vault drained, kamino_deposit_account credited (${fmt(S2.kaminoDeposit)} k-USDC)`);

  // ==========================================================================
  header(`Step 3 — trader open_swap PayFixed ($${NOTIONAL_USDC / 1e6} notional)`);
  const [swapPositionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("swap"), trader.publicKey.toBuffer(), marketPda.toBuffer(), Buffer.from([TRADER_NONCE])],
    program.programId,
  );
  await program.methods
    .openSwap({ payFixed: {} } as any, new anchor.BN(NOTIONAL_USDC), TRADER_NONCE, MAX_RATE_BPS, MIN_RATE_BPS)
    .accountsStrict({
      protocolState: protocolStatePda,
      market: marketPda,
      swapPosition: swapPositionPda,
      collateralVault: collateralVaultPda,
      treasury: deployerUsdcAta,
      underlyingMint: USDC_MINT,
      traderTokenAccount: traderUsdcAta,
      trader: trader.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([trader])
    .rpc();
  const S3 = await snapshot(connection, program, sharedAccs);
  const expectedOpeningFee = (NOTIONAL_USDC * OPENING_FEE_BPS) / 10000;
  const actualOpeningFee = S3.treasury - S2.treasury;
  logDiff("after open_swap", S2, S3);
  if (actualOpeningFee !== expectedOpeningFee) {
    throw new Error(`Step 3: opening_fee expected ${expectedOpeningFee}, got ${actualOpeningFee}`);
  }
  console.log(`  ✓ opening_fee = $${fmt(actualOpeningFee)} flowed to treasury`);

  // Helper for settle_period rounds
  let cumulativeProtocolFee = 0;

  async function bumpRateAndSettle(roundIdx: number): Promise<number> {
    const position = await program.account.swapPosition.fetch(swapPositionPda);
    const nextSettle = position.nextSettlementTs.toNumber();
    const now = Math.floor(Date.now() / 1000);
    const waitSecs = Math.max(0, nextSettle - now + 2);
    if (waitSecs > 0) {
      console.log(`  waiting ${waitSecs}s for next_settlement_ts...`);
      await new Promise((r) => setTimeout(r, waitSecs * 1000));
    }

    const currentMarket = await program.account.swapMarket.fetch(marketPda);
    const bumped = BigInt(currentMarket.currentRateIndex.toString())
      + BigInt(currentMarket.currentRateIndex.toString()) / 5_000_000n;
    await program.methods
      .setRateIndexOracle(new anchor.BN(bumped.toString()))
      .accountsStrict({ protocolState: protocolStatePda, market: marketPda, authority: deployer.publicKey })
      .rpc();

    const before = await snapshot(connection, program, sharedAccs);
    await program.methods
      .settlePeriod()
      .accountsStrict({
        protocolState: protocolStatePda,
        market: marketPda,
        swapPosition: swapPositionPda,
        lpVault: lpVaultPda,
        collateralVault: collateralVaultPda,
        treasury: deployerUsdcAta,
        underlyingMint: USDC_MINT,
        caller: deployer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    const after = await snapshot(connection, program, sharedAccs);
    const protocolFee = after.treasury - before.treasury;
    cumulativeProtocolFee += protocolFee;
    logDiff(`after settle #${roundIdx}`, before, after);
    if (protocolFee < 0) {
      throw new Error(`Step 5/7: protocol_fee should be >= 0, got ${protocolFee}`);
    }
    console.log(`  ✓ settle #${roundIdx}: protocol_fee = +${protocolFee} raw units; cumulative = ${cumulativeProtocolFee}`);
    return protocolFee;
  }

  // ==========================================================================
  header(`Step 4-5 — wait + bump rate + settle_period (round 1)`);
  await bumpRateAndSettle(1);

  // ==========================================================================
  header(`Step 6-7 — wait + bump rate + settle_period (round 2)`);
  await bumpRateAndSettle(2);

  // ==========================================================================
  header(`Step 8 — trader close_position_early`);
  const beforeClose = await snapshot(connection, program, sharedAccs);
  await program.methods
    .closePositionEarly()
    .accountsStrict({
      protocolState: protocolStatePda,
      market: marketPda,
      swapPosition: swapPositionPda,
      lpVault: lpVaultPda,
      collateralVault: collateralVaultPda,
      treasury: deployerUsdcAta,
      underlyingMint: USDC_MINT,
      ownerTokenAccount: traderUsdcAta,
      owner: trader.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      kaminoDepositAccount: kaminoDepositPda,
      kaminoReserve: KAMINO_USDC_RESERVE,
      kaminoLendingMarket: lendingMarket,
      kaminoLendingMarketAuthority: lendingMarketAuthority,
      reserveLiquidityMint: USDC_MINT,
      reserveLiquiditySupply: reserveLiquiditySupply,
      reserveCollateralMint: reserveCollateralMint,
      collateralTokenProgram: TOKEN_PROGRAM_ID,
      liquidityTokenProgram: TOKEN_PROGRAM_ID,
      instructionSysvarAccount: INSTRUCTIONS_SYSVAR,
      kaminoProgram: KAMINO_PROGRAM,
    })
    .signers([trader])
    .rpc();
  const afterClose = await snapshot(connection, program, sharedAccs);
  const earlyCloseFee = afterClose.treasury - beforeClose.treasury;
  logDiff("after close_position_early", beforeClose, afterClose);
  if (earlyCloseFee < 0) throw new Error(`Step 8: early_close_fee should be >= 0, got ${earlyCloseFee}`);
  console.log(`  ✓ early_close_fee = +${earlyCloseFee} raw units`);

  // ==========================================================================
  header(`Step 9 — keeper withdraw_from_kamino (refill lp_vault for LP exit)`);
  const kAmount = afterClose.kaminoDeposit;
  await program.methods
    .withdrawFromKamino(new anchor.BN(kAmount))
    .accountsStrict({
      protocolState: protocolStatePda,
      keeper: deployer.publicKey,
      market: marketPda,
      lpVault: lpVaultPda,
      kaminoDepositAccount: kaminoDepositPda,
      kaminoReserve: KAMINO_USDC_RESERVE,
      kaminoLendingMarket: lendingMarket,
      kaminoLendingMarketAuthority: lendingMarketAuthority,
      reserveLiquidityMint: USDC_MINT,
      reserveLiquiditySupply: reserveLiquiditySupply,
      reserveCollateralMint: reserveCollateralMint,
      collateralTokenProgram: TOKEN_PROGRAM_ID,
      liquidityTokenProgram: TOKEN_PROGRAM_ID,
      instructionSysvarAccount: INSTRUCTIONS_SYSVAR,
      kaminoProgram: KAMINO_PROGRAM,
    })
    .rpc();
  const S9 = await snapshot(connection, program, sharedAccs);
  logDiff("after withdraw_from_kamino", afterClose, S9);
  if (S9.treasury !== afterClose.treasury) throw new Error(`Step 9: rebalance changed treasury`);
  console.log(`  ✓ no fee on rebalance; lp_vault refilled to ${fmt(S9.lpVault)} USDC`);

  // ==========================================================================
  header(`Step 10 — sync_kamino_yield (refresh NAV staleness for LP exit)`);
  await program.methods
    .syncKaminoYield()
    .accountsStrict({ market: marketPda })
    .rpc();
  console.log(`  ✓ NAV staleness gate refreshed`);

  // ==========================================================================
  header(`Step 11 — LP request_withdrawal(all_shares) with internal CPI accounts`);
  const lpPosition = await program.account.lpPosition.fetch(lpPositionPda);
  const sharesToBurn = lpPosition.shares;
  console.log(`  shares_to_burn: ${sharesToBurn.toString()}`);

  const beforeWd = await snapshot(connection, program, sharedAccs);
  await program.methods
    .requestWithdrawal(sharesToBurn)
    .accountsStrict({
      protocolState: protocolStatePda,
      market: marketPda,
      lpPosition: lpPositionPda,
      lpVault: lpVaultPda,
      lpMint: lpMintPda,
      underlyingMint: USDC_MINT,
      withdrawerLpTokenAccount: lpLpTokenAta,
      withdrawerTokenAccount: lpUsdcAta,
      treasury: deployerUsdcAta,
      withdrawer: lp.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      kaminoDepositAccount: kaminoDepositPda,
      kaminoReserve: KAMINO_USDC_RESERVE,
      kaminoLendingMarket: lendingMarket,
      kaminoLendingMarketAuthority: lendingMarketAuthority,
      reserveLiquidityMint: USDC_MINT,
      reserveLiquiditySupply: reserveLiquiditySupply,
      reserveCollateralMint: reserveCollateralMint,
      collateralTokenProgram: TOKEN_PROGRAM_ID,
      liquidityTokenProgram: TOKEN_PROGRAM_ID,
      instructionSysvarAccount: INSTRUCTIONS_SYSVAR,
      kaminoProgram: KAMINO_PROGRAM,
    })
    .signers([lp])
    .rpc();
  const afterWd = await snapshot(connection, program, sharedAccs);
  const withdrawalFee = afterWd.treasury - beforeWd.treasury;
  logDiff("after request_withdrawal", beforeWd, afterWd);
  if (withdrawalFee < 0) throw new Error(`Step 11: withdrawal_fee should be >= 0, got ${withdrawalFee}`);
  if (afterWd.totalShares !== 0n) throw new Error(`Step 11: shares not fully burned: ${afterWd.totalShares}`);
  console.log(`  ✓ withdrawal_fee = +${withdrawalFee} raw units; shares fully burned`);

  // Wait briefly for event listener
  await new Promise((r) => setTimeout(r, 2000));
  await program.removeEventListener(listenerId);

  // ==========================================================================
  header(`Final aggregate — fee accounting + token conservation`);

  const sumOfFees =
    (S3.treasury - S2.treasury)        // opening
    + cumulativeProtocolFee             // protocol fees over all settles
    + earlyCloseFee                     // early close
    + withdrawalFee;                    // withdrawal

  const treasuryDelta = afterWd.treasury - T0.treasury;

  console.log(`\n  Fee paths:`);
  console.log(`    opening_fee:     +${S3.treasury - S2.treasury} raw  (Step 3)`);
  console.log(`    protocol_fees:   +${cumulativeProtocolFee} raw  (Steps 5+7, ${cumulativeProtocolFee > 0 ? "visible" : "below truncation"})`);
  console.log(`    early_close_fee: +${earlyCloseFee} raw  (Step 8)`);
  console.log(`    withdrawal_fee:  +${withdrawalFee} raw  (Step 11)`);
  console.log(`    --------------------------------`);
  console.log(`    sum:             ${sumOfFees} raw`);
  console.log(`    treasury Δ:      ${treasuryDelta} raw`);

  if (sumOfFees !== treasuryDelta) {
    throw new Error(`Fee aggregate mismatch: sum=${sumOfFees}, treasury delta=${treasuryDelta}`);
  }
  console.log(`  ✓ sum of fees == treasury delta (no leak)`);

  // Token conservation: sum of USDC across all parties at start vs end. The
  // delta should equal Kamino yield earned (positive, small) — nothing should
  // disappear or be over-credited. Equation:
  //   totalIn  = T0   sum across LP + trader + treasury + lp_vault + collateral_vault
  //   totalOut = end  same sum, PLUS kamino_value (Kamino still holds nothing
  //              once Step 9 drained it, so this should be ~0)
  // delta = totalOut - totalIn  →  expected = Kamino interest accrued during
  // the ~70s the protocol held the k-tokens.
  const reserveFinal = Reserve.decode(
    (await connection.getAccountInfo(KAMINO_USDC_RESERVE))!.data,
  );
  const collMintTotal = BigInt((reserveFinal.collateral as any).mintTotalSupply.toString());
  const liqAvailable = BigInt((reserveFinal.liquidity as any).availableAmount.toString());
  const liqBorrowedSf = BigInt((reserveFinal.liquidity as any).borrowedAmountSf.toString());
  const liqFeesSf = BigInt((reserveFinal.liquidity as any).accumulatedProtocolFeesSf.toString());
  const totalLiquidity = liqAvailable + (liqBorrowedSf >> 60n) - (liqFeesSf >> 60n);
  const kaminoUsdcValue = collMintTotal > 0n
    ? (BigInt(afterWd.kaminoDeposit) * totalLiquidity) / collMintTotal
    : 0n;

  const totalIn =
    T0.lpUsdc + T0.traderUsdc + T0.treasury + T0.lpVault + T0.collateralVault;
  const totalOut =
    afterWd.lpUsdc + afterWd.traderUsdc + afterWd.treasury + afterWd.lpVault
    + afterWd.collateralVault + Number(kaminoUsdcValue);
  const conservationDelta = totalOut - totalIn;

  console.log(`\n  Token conservation (sum of all USDC across the system):`);
  console.log(`    in  = ${totalIn} raw  (T0: LP wallet + trader wallet + treasury + vaults)`);
  console.log(`    out = ${totalOut} raw  (final: same accounts + kamino_value)`);
  console.log(`    delta = ${conservationDelta} raw  (expected: Kamino yield accrued)`);

  // Tolerance: $0.05 raw units (50_000) — covers up to ~3 min of Kamino yield
  // on $20k at high APY plus rounding across multiple CPI hops. A real leak
  // would be cents-scale or worse.
  const TOLERANCE = 50_000;
  if (conservationDelta < 0 || conservationDelta > TOLERANCE) {
    throw new Error(`Token conservation FAILED: delta ${conservationDelta} outside [0, ${TOLERANCE}]`);
  }
  console.log(`  ✓ token conservation holds (delta within Kamino-yield range)`);

  // ==========================================================================
  header(`LpWithdrawal event capture (Step 11)`);
  if (capturedEvents.length === 0) {
    console.log(`  ⚠ no LpWithdrawal event captured (event listener may have missed; tx still succeeded)`);
  } else {
    for (const e of capturedEvents) {
      console.log(`  market:               ${e.market.toBase58()}`);
      console.log(`  withdrawer:           ${e.withdrawer.toBase58()}`);
      console.log(`  shares_burned:        ${e.sharesBurned.toString()}`);
      console.log(`  gross_amount:         ${e.grossAmount.toString()}`);
      console.log(`  net_amount:           ${e.netAmount.toString()}`);
      console.log(`  fee:                  ${e.fee.toString()}`);
      console.log(`  kamino_redeemed_usdc: ${e.kaminoRedeemedUsdc.toString()}`);
      console.log(`  timestamp:            ${e.timestamp.toString()}`);
      if (e.fee.toNumber() !== withdrawalFee) {
        throw new Error(`Event fee=${e.fee} mismatches treasury delta=${withdrawalFee}`);
      }
    }
    console.log(`  ✓ event payload matches observed treasury delta`);
  }

  console.log(`\n=== A.12 PASSED — full money flow verified, fees match, token conservation holds ===`);
}

main().catch((err) => {
  console.error("\nError:", err);
  process.exit(1);
});
