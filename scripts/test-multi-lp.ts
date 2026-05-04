#!/usr/bin/env ts-node
/**
 * Multi-LP yield distribution test.
 *
 * Verifies the share-price formula handles LPs entering at different times:
 *
 *   shares_to_mint = amount * total_shares_before / lp_nav_before
 *
 * After LP1 has accrued some Kamino yield, LP2 must receive PROPORTIONALLY
 * FEWER shares than LP1 did for the same USDC deposit. Otherwise LP2 would
 * silently dilute LP1's claim on the accrued yield.
 *
 * Required setup (mainnet build):
 *   yarn build:mainnet && restart surfpool
 *
 * Usage:
 *   yarn ts-node scripts/test-multi-lp.ts
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
import { setTokenBalance, SCOPE_PRICES, refreshReserveIx } from "./surfpool-overrides";

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8899";
const DEPLOYER_KEYPAIR =
  process.env.DEPLOYER_KEYPAIR || path.join(os.homedir(), ".config/solana/id.json");

const KAMINO_PROGRAM = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const KAMINO_USDC_RESERVE = new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const INSTRUCTIONS_SYSVAR = anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY;

const TENOR_SECONDS = new anchor.BN(360); // unique vs test-mainnet-sync (180)
const SETTLEMENT_PERIOD_SECONDS = new anchor.BN(30);
const MAX_UTILIZATION_BPS = 6000;
const BASE_SPREAD_BPS = 80;
const PROTOCOL_FEE_BPS = 1000;
const OPENING_FEE_BPS = 5;
const LIQUIDATION_FEE_BPS = 300;
const WITHDRAWAL_FEE_BPS = 5;
const EARLY_CLOSE_FEE_BPS = 500;

// $50k each LP — bigger pool means measurable Kamino yield over 60s wait
const LP_DEPOSIT_USDC = 50_000_000_000;

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, "utf-8"))));
}

function header(s: string) {
  console.log(`\n=== ${s} ===`);
}

async function main() {
  const deployer = loadKeypair(DEPLOYER_KEYPAIR);
  const lp1 = Keypair.generate();
  const lp2 = Keypair.generate();
  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(deployer), {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);
  const program = anchor.workspace.Anemone as Program<Anemone>;

  console.log(`Deployer: ${deployer.publicKey.toBase58()}`);
  console.log(`LP1:      ${lp1.publicKey.toBase58()}`);
  console.log(`LP2:      ${lp2.publicKey.toBase58()}`);
  console.log(`Program:  ${program.programId.toBase58()}`);

  // Verify mainnet build
  const hasStubMethod = (program.idl.instructions as any[]).some(
    (ix) => ix.name === "set_rate_index_oracle" || ix.name === "setRateIndexOracle",
  );
  if (hasStubMethod) {
    throw new Error("stub-oracle build detected — run yarn build:mainnet + restart surfpool");
  }
  console.log(`  ✓ confirmed mainnet build`);

  // Read live Kamino reserve
  const reserveAcc = await connection.getAccountInfo(KAMINO_USDC_RESERVE);
  if (!reserveAcc) throw new Error("Kamino USDC reserve not found");
  const reserveLive = Reserve.decode(reserveAcc.data);
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

  // ==========================================================================
  header("Setup — initialize protocol & create market (tenor=360)");

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
    console.log(`  create_market already done — REUSING existing market state`);
    console.log(`  (run on a fresh Surfpool for clean state)`);
  }

  // Fund both LPs
  for (const lp of [lp1, lp2]) {
    const sig = await connection.requestAirdrop(lp.publicKey, 1e9);
    await connection.confirmTransaction(sig, "confirmed");
    await setTokenBalance(connection, lp.publicKey, USDC_MINT, BigInt(LP_DEPOSIT_USDC));
  }
  const lp1UsdcAta = await createAssociatedTokenAccountIdempotent(connection, deployer, USDC_MINT, lp1.publicKey);
  const lp1LpAta = await createAssociatedTokenAccountIdempotent(connection, deployer, lpMintPda, lp1.publicKey);
  const [lp1PosPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp"), lp1.publicKey.toBuffer(), marketPda.toBuffer()], program.programId,
  );
  const lp2UsdcAta = await createAssociatedTokenAccountIdempotent(connection, deployer, USDC_MINT, lp2.publicKey);
  const lp2LpAta = await createAssociatedTokenAccountIdempotent(connection, deployer, lpMintPda, lp2.publicKey);
  const [lp2PosPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp"), lp2.publicKey.toBuffer(), marketPda.toBuffer()], program.programId,
  );

  // ==========================================================================
  header(`Step 1 — LP1 deposit $${LP_DEPOSIT_USDC / 1e6}`);

  const marketBeforeLp1 = await program.account.swapMarket.fetch(marketPda);
  const lpNavBeforeLp1 = BigInt(marketBeforeLp1.lpNav.toString());
  const totalSharesBeforeLp1 = BigInt(marketBeforeLp1.totalLpShares.toString());

  await program.methods
    .depositLiquidity(new anchor.BN(LP_DEPOSIT_USDC))
    .accountsStrict({
      protocolState: protocolStatePda,
      market: marketPda,
      lpPosition: lp1PosPda,
      lpVault: lpVaultPda,
      lpMint: lpMintPda,
      underlyingMint: USDC_MINT,
      depositorTokenAccount: lp1UsdcAta,
      depositorLpTokenAccount: lp1LpAta,
      depositor: lp1.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([lp1])
    .rpc();

  const marketAfterLp1 = await program.account.swapMarket.fetch(marketPda);
  const lp1Position = await program.account.lpPosition.fetch(lp1PosPda);
  const lp1Shares = BigInt(lp1Position.shares.toString());
  console.log(`  lp_nav:        ${lpNavBeforeLp1} → ${marketAfterLp1.lpNav.toString()}`);
  console.log(`  total_shares:  ${totalSharesBeforeLp1} → ${marketAfterLp1.totalLpShares.toString()}`);
  console.log(`  lp1.shares:    ${lp1Shares}`);

  if (totalSharesBeforeLp1 === 0n && lp1Shares !== BigInt(LP_DEPOSIT_USDC)) {
    throw new Error(`First LP should mint 1:1: expected ${LP_DEPOSIT_USDC}, got ${lp1Shares}`);
  }
  console.log(`  ✓ LP1 minted ${lp1Shares} shares (1:1 since pool was empty)`);

  // ==========================================================================
  header("Step 2 — deposit_to_kamino + sync to seed snapshot");

  // Klend deposit_reserve_liquidity panics with MathOverflow if the reserve's
  // last_update.slot is far behind current_slot. Bundle a refresh_reserve
  // preInstruction so the reserve is in fresh state before our CPI runs.
  const refreshIx = () => refreshReserveIx({
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
      instructionSysvarAccount: INSTRUCTIONS_SYSVAR,
      kaminoProgram: KAMINO_PROGRAM,
    })
    .preInstructions([refreshIx()])
    .rpc();

  const kBalance = (await getAccount(connection, kaminoDepositPda)).amount;
  console.log(`  ✓ deposit_to_kamino: ${Number(kBalance) / 1e6} k-USDC`);

  // First sync — sets snapshot, delta ≈ 0
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

  const marketAfterSeedSync = await program.account.swapMarket.fetch(marketPda);
  const lpNavAfterSeed = BigInt(marketAfterSeedSync.lpNav.toString());
  console.log(`  lp_nav after seed sync: ${lpNavAfterSeed}`);

  // ==========================================================================
  header("Step 3 — sleep 60s for Kamino yield to accrue");

  console.log(`  sleeping 60s...`);
  await new Promise((r) => setTimeout(r, 60_000));

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

  const marketAfterYieldSync = await program.account.swapMarket.fetch(marketPda);
  const lpNavAfterYield = BigInt(marketAfterYieldSync.lpNav.toString());
  const totalSharesBeforeLp2 = BigInt(marketAfterYieldSync.totalLpShares.toString());
  const yieldDelta = lpNavAfterYield - lpNavAfterSeed;
  console.log(`  lp_nav: ${lpNavAfterSeed} → ${lpNavAfterYield} (yield = +${yieldDelta} raw = $${Number(yieldDelta) / 1e6})`);

  if (yieldDelta <= 0n) {
    throw new Error(`Yield should be > 0 after 60s — got ${yieldDelta}`);
  }
  console.log(`  ✓ Kamino yield credited`);

  // ==========================================================================
  header(`Step 4 — LP2 deposit $${LP_DEPOSIT_USDC / 1e6} (after yield)`);

  await program.methods
    .depositLiquidity(new anchor.BN(LP_DEPOSIT_USDC))
    .accountsStrict({
      protocolState: protocolStatePda,
      market: marketPda,
      lpPosition: lp2PosPda,
      lpVault: lpVaultPda,
      lpMint: lpMintPda,
      underlyingMint: USDC_MINT,
      depositorTokenAccount: lp2UsdcAta,
      depositorLpTokenAccount: lp2LpAta,
      depositor: lp2.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([lp2])
    .rpc();

  const marketAfterLp2 = await program.account.swapMarket.fetch(marketPda);
  const lp2Position = await program.account.lpPosition.fetch(lp2PosPda);
  const lp2Shares = BigInt(lp2Position.shares.toString());
  const totalSharesAfterLp2 = BigInt(marketAfterLp2.totalLpShares.toString());
  const lpNavAfterLp2 = BigInt(marketAfterLp2.lpNav.toString());

  console.log(`  lp_nav:        ${lpNavAfterYield} → ${lpNavAfterLp2}`);
  console.log(`  total_shares:  ${totalSharesBeforeLp2} → ${totalSharesAfterLp2}`);
  console.log(`  lp2.shares:    ${lp2Shares}`);
  console.log(`  lp1.shares:    ${lp1Shares} (unchanged)`);

  // Math check: shares_LP2 = LP2_amount × total_shares_before / lp_nav_before
  const expectedLp2Shares = (BigInt(LP_DEPOSIT_USDC) * totalSharesBeforeLp2) / lpNavAfterYield;
  const sharesDelta = lp2Shares > expectedLp2Shares
    ? lp2Shares - expectedLp2Shares
    : expectedLp2Shares - lp2Shares;

  console.log(`\n  Math:   LP2_shares = LP2_amount × total_shares_before / lp_nav_before`);
  console.log(`               = ${LP_DEPOSIT_USDC} × ${totalSharesBeforeLp2} / ${lpNavAfterYield}`);
  console.log(`               = ${expectedLp2Shares} expected`);
  console.log(`  on-chain    = ${lp2Shares}`);
  console.log(`  delta:        ${sharesDelta} raw`);

  if (sharesDelta > 1n) {
    throw new Error(`Multi-LP: expected ${expectedLp2Shares} shares for LP2, got ${lp2Shares} (delta ${sharesDelta} > rounding tolerance)`);
  }
  console.log(`  ✓ LP2 shares match formula (rounding ≤ 1 raw)`);

  // ==========================================================================
  header("Step 5 — Verify share-value distribution");

  // share_value_per_share = lp_nav / total_shares
  // LP1's claim = lp1_shares × lp_nav / total_shares
  // LP2's claim = lp2_shares × lp_nav / total_shares
  const lp1Claim = (lp1Shares * lpNavAfterLp2) / totalSharesAfterLp2;
  const lp2Claim = (lp2Shares * lpNavAfterLp2) / totalSharesAfterLp2;
  const totalClaim = lp1Claim + lp2Claim;

  console.log(`  LP1 claim: ${lp1Claim} raw = $${Number(lp1Claim) / 1e6} (deposit was $${LP_DEPOSIT_USDC / 1e6})`);
  console.log(`  LP2 claim: ${lp2Claim} raw = $${Number(lp2Claim) / 1e6} (deposit was $${LP_DEPOSIT_USDC / 1e6})`);
  console.log(`  total:     ${totalClaim} raw vs lp_nav ${lpNavAfterLp2} (delta ${lpNavAfterLp2 - totalClaim})`);

  // LP1 should have GAINED yield (claim > deposit)
  const lp1Gain = lp1Claim - BigInt(LP_DEPOSIT_USDC);
  // LP2 should be ~equal to deposit (no yield since they just entered)
  const lp2Gain = lp2Claim - BigInt(LP_DEPOSIT_USDC);

  console.log(`\n  LP1 gain:  +${lp1Gain} raw  (LP1 captured the pre-LP2 yield)`);
  console.log(`  LP2 gain:  ${lp2Gain >= 0n ? "+" : ""}${lp2Gain} raw  (LP2 entered after yield → ~zero gain)`);

  if (lp1Gain <= 0n) {
    throw new Error(`LP1 should have gained yield but claim=${lp1Claim} <= deposit=${LP_DEPOSIT_USDC}`);
  }
  // LP2 might be off by a few raw units due to integer rounding — tolerance ±5 raw
  if (lp2Gain < -5n || lp2Gain > 5n) {
    throw new Error(`LP2 claim should ≈ deposit (rounding only), got gain=${lp2Gain} raw`);
  }
  console.log(`  ✓ LP1 captured the yield, LP2 does NOT silently dilute LP1`);

  console.log(`\n=== MULTI-LP TEST PASSED ===`);
  console.log(`  • LP2 shares = LP2_amount × total_before / lp_nav_before  (formula correct)`);
  console.log(`  • LP1 keeps the yield accrued before LP2 entered`);
  console.log(`  • LP2's claim ≈ LP2's deposit (no free yield)`);
}

main().catch((err) => {
  console.error("\nError:", err);
  process.exit(1);
});
