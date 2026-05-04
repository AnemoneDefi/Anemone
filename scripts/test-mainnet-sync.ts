#!/usr/bin/env ts-node
/**
 * Suite B — sync_kamino_yield mainnet handler test.
 *
 * Required setup:
 *   1. Build with --no-default-features:  yarn build:mainnet
 *   2. Restart Surfpool so the runbook redeploys the mainnet binary.
 *   3. Run this within ~5 min of Surfpool start (slot drift budget for the
 *      750-slot StaleOracle window before refresh_reserve panics).
 *
 * Tests:
 *   B.2.a  First sync_kamino_yield right after deposit_to_kamino — delta ≈ 0,
 *          last_kamino_snapshot_usdc set; verifies no double-counting.
 *   B.2.b  Second sync after 30s — delta > 0, lp_nav increased; verifies real
 *          Kamino yield is credited.
 *   B.2.c  Cross-check: TS-side computation of total_liquidity matches
 *          on-chain output. Validates the SF math (>>60) and accounting.
 *
 * Usage:
 *   yarn ts-node scripts/test-mainnet-sync.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Anemone } from "../target/types/anemone";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
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
import { setTokenBalance, refreshReserveIx, SCOPE_PRICES } from "./surfpool-overrides";

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8899";
const DEPLOYER_KEYPAIR =
  process.env.DEPLOYER_KEYPAIR || path.join(os.homedir(), ".config/solana/id.json");

const KAMINO_PROGRAM = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const KAMINO_USDC_RESERVE = new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const TENOR_SECONDS = new anchor.BN(180);
const SETTLEMENT_PERIOD_SECONDS = new anchor.BN(30);
const MAX_UTILIZATION_BPS = 6000;
const BASE_SPREAD_BPS = 80;
const PROTOCOL_FEE_BPS = 1000;
const OPENING_FEE_BPS = 5;
const LIQUIDATION_FEE_BPS = 300;
const WITHDRAWAL_FEE_BPS = 5;
const EARLY_CLOSE_FEE_BPS = 500;

const LP_DEPOSIT_USDC = 1_000_000_000; // $1,000

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, "utf-8"))));
}

function header(s: string) {
  console.log(`\n=== ${s} ===`);
}

function readReserveFields(data: Buffer) {
  const r = Reserve.decode(data);
  const liq = r.liquidity as any;
  const coll = r.collateral as any;
  return {
    available: BigInt(liq.availableAmount.toString()),
    borrowedSf: BigInt(liq.borrowedAmountSf.toString()),
    feesSf: BigInt(liq.accumulatedProtocolFeesSf.toString()),
    referrerFeesSf: BigInt((liq.accumulatedReferrerFeesSf ?? 0n).toString()),
    pendingReferrerFeesSf: BigInt((liq.pendingReferrerFeesSf ?? 0n).toString()),
    collMintTotal: BigInt(coll.mintTotalSupply.toString()),
    cumulativeBorrowRateBsfLow: BigInt(liq.cumulativeBorrowRateBsf.value[0].toString()),
    cumulativeBorrowRateBsfHigh: BigInt(liq.cumulativeBorrowRateBsf.value[1].toString()),
  };
}

const SF_SHIFT = 60n;

function expectedKaminoUsdcValue(reserveFields: ReturnType<typeof readReserveFields>, ourKBalance: bigint): bigint {
  const totalLiquidity = reserveFields.available
    + (reserveFields.borrowedSf >> SF_SHIFT)
    - (reserveFields.feesSf >> SF_SHIFT);
  if (reserveFields.collMintTotal === 0n) return 0n;
  return (ourKBalance * totalLiquidity) / reserveFields.collMintTotal;
}

async function main() {
  const deployer = loadKeypair(DEPLOYER_KEYPAIR);
  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(deployer), {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);
  const program = anchor.workspace.Anemone as Program<Anemone>;

  console.log(`Deployer: ${deployer.publicKey.toBase58()}`);
  console.log(`Program:  ${program.programId.toBase58()}`);
  console.log(`RPC:      ${RPC_URL}`);

  // Verify mainnet build (no setRateIndexOracle in IDL)
  const hasStubMethod = (program.idl.instructions as any[]).some(
    (ix) => ix.name === "set_rate_index_oracle" || ix.name === "setRateIndexOracle",
  );
  if (hasStubMethod) {
    throw new Error(
      "set_rate_index_oracle is in the IDL — this is a stub-oracle build, not mainnet. " +
      "Run `yarn build:mainnet` and restart Surfpool first.",
    );
  }
  console.log(`  ✓ confirmed mainnet build (no setRateIndexOracle in IDL)`);

  // ==========================================================================
  header("Setup — Kamino reserve fields, init protocol + market");

  const reserveAcc0 = await connection.getAccountInfo(KAMINO_USDC_RESERVE);
  if (!reserveAcc0) throw new Error("Kamino USDC reserve not found in fork");
  const reserveFields0 = readReserveFields(reserveAcc0.data);
  const reserveLive = Reserve.decode(reserveAcc0.data);
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

  const deployerUsdcAta = await createAssociatedTokenAccountIdempotent(
    connection, deployer, USDC_MINT, deployer.publicKey,
  );
  await setTokenBalance(connection, deployer.publicKey, USDC_MINT, BigInt(LP_DEPOSIT_USDC));

  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    program.programId,
  );
  const protocolExists = await connection.getAccountInfo(protocolStatePda);
  if (!protocolExists) {
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
  } else {
    console.log(`  initialize_protocol already done`);
  }

  const [marketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), KAMINO_USDC_RESERVE.toBuffer(), TENOR_SECONDS.toArrayLike(Buffer, "le", 8)],
    program.programId,
  );
  const [lpVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_vault"), marketPda.toBuffer()], program.programId,
  );
  const [collateralVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("collateral_vault"), marketPda.toBuffer()], program.programId,
  );
  const [kaminoDepositPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("kamino_deposit"), marketPda.toBuffer()], program.programId,
  );
  const [lpMintPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_mint"), marketPda.toBuffer()], program.programId,
  );

  const marketExists = await connection.getAccountInfo(marketPda);
  if (!marketExists) {
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
  } else {
    console.log(`  create_market already done`);
  }

  const deployerLpAta = await createAssociatedTokenAccountIdempotent(
    connection, deployer, lpMintPda, deployer.publicKey,
  );
  const [lpPositionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp"), deployer.publicKey.toBuffer(), marketPda.toBuffer()],
    program.programId,
  );

  // ==========================================================================
  header("Step 1 — deposit_liquidity ($1,000) + deposit_to_kamino");

  await program.methods
    .depositLiquidity(new anchor.BN(LP_DEPOSIT_USDC))
    .accountsStrict({
      protocolState: protocolStatePda,
      market: marketPda,
      lpPosition: lpPositionPda,
      lpVault: lpVaultPda,
      lpMint: lpMintPda,
      underlyingMint: USDC_MINT,
      depositorTokenAccount: deployerUsdcAta,
      depositorLpTokenAccount: deployerLpAta,
      depositor: deployer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`  ✓ deposited $${LP_DEPOSIT_USDC / 1e6} into lp_vault`);

  // Klend deposit_reserve_liquidity panics with MathOverflow when the reserve
  // is stale. Always bundle a refresh_reserve preInstruction (see runbook §2).
  const refreshIx = refreshReserveIx({
    reserve: KAMINO_USDC_RESERVE,
    lendingMarket,
    scopePrices: SCOPE_PRICES,
    kaminoProgram: KAMINO_PROGRAM,
  });

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
      instructionSysvarAccount: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      kaminoProgram: KAMINO_PROGRAM,
    })
    .preInstructions([refreshIx])
    .rpc();
  const kBalance = (await getAccount(connection, kaminoDepositPda)).amount;
  const marketAfterDeposit = await program.account.swapMarket.fetch(marketPda);
  console.log(`  ✓ deposit_to_kamino: ${Number(kBalance) / 1e6} k-USDC, last_kamino_snapshot_usdc=${marketAfterDeposit.lastKaminoSnapshotUsdc.toString()}`);

  if (Number(marketAfterDeposit.lastKaminoSnapshotUsdc.toString()) !== LP_DEPOSIT_USDC) {
    throw new Error(`Snapshot post-deposit should equal LP_DEPOSIT_USDC=${LP_DEPOSIT_USDC}, got ${marketAfterDeposit.lastKaminoSnapshotUsdc}`);
  }

  // ==========================================================================
  header("B.2.a — first sync_kamino_yield (delta ≈ 0; no double-counting)");

  const lpNavBeforeFirstSync = BigInt(marketAfterDeposit.lpNav.toString());
  const snapshotBeforeFirstSync = BigInt(marketAfterDeposit.lastKaminoSnapshotUsdc.toString());

  await program.methods
    .syncKaminoYield()
    .accountsStrict({
      market: marketPda,
      kaminoReserve: KAMINO_USDC_RESERVE,
      kaminoDepositAccount: kaminoDepositPda,
      kaminoLendingMarket: lendingMarket,
      pythOracle: KAMINO_PROGRAM, // placeholder (USDC reserve uses Scope only)
      switchboardPriceOracle: KAMINO_PROGRAM,
      switchboardTwapOracle: KAMINO_PROGRAM,
      scopePrices: SCOPE_PRICES,
      kaminoProgram: KAMINO_PROGRAM,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  const marketAfterFirstSync = await program.account.swapMarket.fetch(marketPda);
  const lpNavAfterFirstSync = BigInt(marketAfterFirstSync.lpNav.toString());
  const snapshotAfterFirstSync = BigInt(marketAfterFirstSync.lastKaminoSnapshotUsdc.toString());
  const firstDelta = lpNavAfterFirstSync - lpNavBeforeFirstSync;

  console.log(`  lp_nav:                 ${lpNavBeforeFirstSync} → ${lpNavAfterFirstSync} (Δ ${firstDelta})`);
  console.log(`  last_kamino_snapshot:   ${snapshotBeforeFirstSync} → ${snapshotAfterFirstSync}`);

  // First sync: tiny accrual since deposit (sub-second to a few seconds), so
  // delta should be 0 or very small (< 100 raw = $0.0001).
  if (firstDelta < 0n) throw new Error(`B.2.a: first sync delta is negative: ${firstDelta}`);
  if (firstDelta > 100n) throw new Error(`B.2.a: first sync delta unexpectedly large: ${firstDelta}`);
  console.log(`  ✓ first sync delta within expected range (no double-counting)`);

  // ==========================================================================
  header("B.2.b — sleep 30s, second sync_kamino_yield (delta > 0)");

  console.log(`  sleeping 30s for Kamino interest to accrue...`);
  await new Promise((r) => setTimeout(r, 30_000));

  await program.methods
    .syncKaminoYield()
    .accountsStrict({
      market: marketPda,
      kaminoReserve: KAMINO_USDC_RESERVE,
      kaminoDepositAccount: kaminoDepositPda,
      kaminoLendingMarket: lendingMarket,
      pythOracle: KAMINO_PROGRAM,
      switchboardPriceOracle: KAMINO_PROGRAM,
      switchboardTwapOracle: KAMINO_PROGRAM,
      scopePrices: SCOPE_PRICES,
      kaminoProgram: KAMINO_PROGRAM,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  const marketAfterSecondSync = await program.account.swapMarket.fetch(marketPda);
  const lpNavAfterSecondSync = BigInt(marketAfterSecondSync.lpNav.toString());
  const snapshotAfterSecondSync = BigInt(marketAfterSecondSync.lastKaminoSnapshotUsdc.toString());
  const secondDelta = lpNavAfterSecondSync - lpNavAfterFirstSync;

  console.log(`  lp_nav:                 ${lpNavAfterFirstSync} → ${lpNavAfterSecondSync} (Δ ${secondDelta})`);
  console.log(`  last_kamino_snapshot:   ${snapshotAfterFirstSync} → ${snapshotAfterSecondSync}`);

  if (secondDelta <= 0n) {
    throw new Error(`B.2.b: second sync delta should be > 0 (yield accrued), got ${secondDelta}`);
  }
  console.log(`  ✓ yield credited: +${secondDelta} raw USDC (= $${Number(secondDelta) / 1e6})`);

  // ==========================================================================
  header("B.2.c — cross-check: TS-side computation matches on-chain");

  const reserveAcc1 = await connection.getAccountInfo(KAMINO_USDC_RESERVE);
  if (!reserveAcc1) throw new Error("reserve missing");
  const reserveFields1 = readReserveFields(reserveAcc1.data);
  const expectedValue = expectedKaminoUsdcValue(reserveFields1, BigInt(kBalance.toString()));

  console.log(`  TS computed: total_liquidity = available + (borrowed_sf >> 60) - (fees_sf >> 60)`);
  console.log(`               = ${reserveFields1.available} + ${reserveFields1.borrowedSf >> SF_SHIFT} - ${reserveFields1.feesSf >> SF_SHIFT}`);
  console.log(`  TS expected kamino_usdc_value: ${expectedValue}`);
  console.log(`  on-chain last_kamino_snapshot: ${snapshotAfterSecondSync}`);

  // The on-chain value was computed at the slot where syncKaminoYield ran
  // (just before this read). The TS read happens 1 RPC roundtrip later, so
  // a few hundred raw units of accrual may differ. Tolerance: 1000 raw
  // units = $0.001.
  const crossCheckDelta = expectedValue - snapshotAfterSecondSync;
  console.log(`  delta (TS - on-chain): ${crossCheckDelta} raw`);
  const CROSS_CHECK_TOLERANCE = 1_000n;
  if (crossCheckDelta < -CROSS_CHECK_TOLERANCE || crossCheckDelta > CROSS_CHECK_TOLERANCE) {
    throw new Error(`B.2.c: TS/on-chain math mismatch: ${crossCheckDelta} raw outside ±${CROSS_CHECK_TOLERANCE}`);
  }
  console.log(`  ✓ TS-side math matches on-chain handler within ±${CROSS_CHECK_TOLERANCE} raw`);

  console.log(`\n=== B.2 PASSED — sync_kamino_yield mainnet handler verified ===`);
  console.log(`  • First sync after deposit:  no double-counting (Δ ${firstDelta})`);
  console.log(`  • Second sync after 30s:     real yield credited (+${secondDelta} raw)`);
  console.log(`  • SF math (>>60):            TS cross-check matches handler output`);
}

main().catch((err) => {
  console.error("\nError:", err);
  process.exit(1);
});
