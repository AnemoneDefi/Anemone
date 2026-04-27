#!/usr/bin/env ts-node
/**
 * Suite B.3 — full LP/trader lifecycle on mainnet build.
 *
 * Sanity check that everything else still works without the stub-oracle
 * bypass: rate seeding via real update_rate_index, open_swap, settle_period,
 * close_position_early, request_withdrawal — all against live Kamino fork.
 *
 * Required state: this script picks up where test-mainnet-sync.ts left off.
 * Don't restart Surfpool between the two scripts.
 *
 * Usage:
 *   yarn ts-node scripts/test-mainnet-sync.ts   # creates market, B.2 sync tests
 *   yarn ts-node scripts/test-mainnet-cycle.ts  # this script — B.3 lifecycle
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
import {
  setTokenBalance,
  refreshReserveIx,
  SCOPE_PRICES,
} from "./surfpool-overrides";

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8899";
const DEPLOYER_KEYPAIR =
  process.env.DEPLOYER_KEYPAIR || path.join(os.homedir(), ".config/solana/id.json");

const KAMINO_PROGRAM = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const KAMINO_USDC_RESERVE = new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const INSTRUCTIONS_SYSVAR = anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY;

// Must match test-mainnet-sync.ts so PDAs line up
const TENOR_SECONDS = new anchor.BN(180);
const NOTIONAL_USDC = 500_000_000; // $500 — under the 60% util cap of the $1k LP pool
const TRADER_USDC = 100_000_000;    // $100 — well over expected margin
const TRADER_NONCE = 0;
const MAX_RATE_BPS = new anchor.BN(10_000);
const MIN_RATE_BPS = new anchor.BN(0);

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, "utf-8"))));
}

function header(s: string) {
  console.log(`\n=== ${s} ===`);
}

async function main() {
  const deployer = loadKeypair(DEPLOYER_KEYPAIR);
  const trader = Keypair.generate();
  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(deployer), {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);
  const program = anchor.workspace.Anemone as Program<Anemone>;

  console.log(`Deployer: ${deployer.publicKey.toBase58()}`);
  console.log(`Trader:   ${trader.publicKey.toBase58()}`);
  console.log(`Program:  ${program.programId.toBase58()}`);

  // Verify mainnet build
  const hasStubMethod = (program.idl.instructions as any[]).some(
    (ix) => ix.name === "set_rate_index_oracle" || ix.name === "setRateIndexOracle",
  );
  if (hasStubMethod) {
    throw new Error("stub-oracle build detected — run yarn build:mainnet + restart surfpool");
  }

  // Read live Kamino reserve to derive lendingMarket etc.
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

  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")], program.programId,
  );
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

  const marketInfo = await connection.getAccountInfo(marketPda);
  if (!marketInfo) {
    throw new Error("market PDA not found — run test-mainnet-sync.ts first to create it");
  }

  const deployerUsdcAta = await createAssociatedTokenAccountIdempotent(
    connection, deployer, USDC_MINT, deployer.publicKey,
  );
  const deployerLpAta = await createAssociatedTokenAccountIdempotent(
    connection, deployer, lpMintPda, deployer.publicKey,
  );
  const [lpPositionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp"), deployer.publicKey.toBuffer(), marketPda.toBuffer()],
    program.programId,
  );

  // Fund trader
  const sig = await connection.requestAirdrop(trader.publicKey, 1e9);
  await connection.confirmTransaction(sig, "confirmed");
  await setTokenBalance(connection, trader.publicKey, USDC_MINT, BigInt(TRADER_USDC));
  const traderUsdcAta = await createAssociatedTokenAccountIdempotent(
    connection, deployer, USDC_MINT, trader.publicKey,
  );

  // Helper: refresh the Kamino reserve so its last_update.slot matches the
  // local clock (Surfpool's local slot drifts past the forked snapshot).
  // Bundled as a preInstruction before any update_rate_index call.
  const refreshIx = () => refreshReserveIx({
    reserve: KAMINO_USDC_RESERVE,
    lendingMarket,
    scopePrices: SCOPE_PRICES,
    kaminoProgram: KAMINO_PROGRAM,
  });

  // ==========================================================================
  header("B.3.c — seed rate snapshots via update_rate_index (real Kamino bsf)");

  const marketBeforeSeed = await program.account.swapMarket.fetch(marketPda);
  const seedNeeded = marketBeforeSeed.previousRateIndex.toString() === "0"
    || marketBeforeSeed.currentRateIndex.toString() === "0";
  console.log(`  before: previous=${marketBeforeSeed.previousRateIndex.toString()}, current=${marketBeforeSeed.currentRateIndex.toString()}`);

  if (seedNeeded) {
    // First call: read the live bsf, no rotation (current was 0)
    await program.methods
      .updateRateIndex()
      .accountsStrict({
        protocolState: protocolStatePda,
        market: marketPda,
        kaminoReserve: KAMINO_USDC_RESERVE,
        keeper: deployer.publicKey,
      })
      .preInstructions([refreshIx()])
      .rpc();
    const m1 = await program.account.swapMarket.fetch(marketPda);
    console.log(`  call 1: current=${m1.currentRateIndex.toString()}, ts=${m1.lastRateUpdateTs.toString()}`);

    console.log(`  waiting 9s + bumping reserve to advance bsf...`);
    await new Promise((r) => setTimeout(r, 9_000));

    // Second call: bsf has compounded (refreshIx forces re-compute), rotate
    await program.methods
      .updateRateIndex()
      .accountsStrict({
        protocolState: protocolStatePda,
        market: marketPda,
        kaminoReserve: KAMINO_USDC_RESERVE,
        keeper: deployer.publicKey,
      })
      .preInstructions([refreshIx()])
      .rpc();
    const m2 = await program.account.swapMarket.fetch(marketPda);
    console.log(`  call 2: previous=${m2.previousRateIndex.toString()}, current=${m2.currentRateIndex.toString()}`);

    if (m2.previousRateIndex.toString() === m2.currentRateIndex.toString()) {
      throw new Error(`B.3.c seed: snapshots collapsed (bsf did not advance after refresh)`);
    }
    console.log(`  ✓ snapshots seeded — bsf advanced via refresh_reserve compounding`);
  } else {
    console.log(`  rate snapshots already seeded (skip)`);
  }

  // ==========================================================================
  header(`B.3.c — open_swap PayFixed ($${NOTIONAL_USDC / 1e6} notional)`);

  const [swapPositionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("swap"), trader.publicKey.toBuffer(), marketPda.toBuffer(), Buffer.from([TRADER_NONCE])],
    program.programId,
  );

  const traderUsdcBefore = (await getAccount(connection, traderUsdcAta)).amount;
  await program.methods
    .openSwap(
      { payFixed: {} } as any,
      new anchor.BN(NOTIONAL_USDC),
      TRADER_NONCE,
      MAX_RATE_BPS,
      MIN_RATE_BPS,
    )
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
  const positionAfterOpen = await program.account.swapPosition.fetch(swapPositionPda);
  const traderUsdcAfter = (await getAccount(connection, traderUsdcAta)).amount;
  console.log(`  fixed_rate_bps:        ${positionAfterOpen.fixedRateBps.toNumber()} (${(positionAfterOpen.fixedRateBps.toNumber() / 100).toFixed(2)}%)`);
  console.log(`  collateral_deposited:  ${positionAfterOpen.collateralDeposited.toNumber() / 1e6} USDC`);
  console.log(`  next_settlement_ts:    ${positionAfterOpen.nextSettlementTs.toString()}`);
  console.log(`  trader USDC:           ${Number(traderUsdcBefore) / 1e6} → ${Number(traderUsdcAfter) / 1e6}`);
  console.log(`  ✓ open_swap on mainnet build works (rate from live Kamino bsf)`);

  // ==========================================================================
  header("B.3.c — wait + bump rate via update_rate_index + settle_period");

  const nextSettle = positionAfterOpen.nextSettlementTs.toNumber();
  const now = Math.floor(Date.now() / 1000);
  const waitSecs = Math.max(0, nextSettle - now + 2);
  if (waitSecs > 0) {
    console.log(`  waiting ${waitSecs}s for next_settlement_ts...`);
    await new Promise((r) => setTimeout(r, waitSecs * 1000));
  }

  // Bump rate index — refresh + update brings new bsf since last seed call
  await program.methods
    .updateRateIndex()
    .accountsStrict({
      protocolState: protocolStatePda,
      market: marketPda,
      kaminoReserve: KAMINO_USDC_RESERVE,
      keeper: deployer.publicKey,
    })
    .preInstructions([refreshIx()])
    .rpc();
  const mAfterBump = await program.account.swapMarket.fetch(marketPda);
  console.log(`  rate bumped: previous=${mAfterBump.previousRateIndex.toString()}, current=${mAfterBump.currentRateIndex.toString()}`);

  // Settle: needs JIT withdraw_from_kamino preInstruction so lp_vault has cash
  const beforeSettleColl = (await getAccount(connection, collateralVaultPda)).amount;
  const beforeSettleLp = (await getAccount(connection, lpVaultPda)).amount;
  const beforeSettleTreasury = (await getAccount(connection, deployerUsdcAta)).amount;

  // Withdraw a small chunk to cover any direction of PnL
  const jitWithdrawIx = await program.methods
    .withdrawFromKamino(new anchor.BN(5_000_000)) // 5 k-USDC ≈ ~6 USDC
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
    .instruction();

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
    .preInstructions([jitWithdrawIx])
    .rpc();
  const afterSettleColl = (await getAccount(connection, collateralVaultPda)).amount;
  const afterSettleLp = (await getAccount(connection, lpVaultPda)).amount;
  const afterSettleTreasury = (await getAccount(connection, deployerUsdcAta)).amount;
  const positionAfterSettle = await program.account.swapPosition.fetch(swapPositionPda);
  console.log(`  collateral_vault:     ${Number(beforeSettleColl) / 1e6} → ${Number(afterSettleColl) / 1e6}`);
  console.log(`  lp_vault:             ${Number(beforeSettleLp) / 1e6} → ${Number(afterSettleLp) / 1e6}`);
  console.log(`  treasury delta:       +${Number(afterSettleTreasury) - Number(beforeSettleTreasury)} raw`);
  console.log(`  num_settlements:      ${positionAfterSettle.numSettlements}`);
  console.log(`  ✓ settle_period works on mainnet build`);

  // ==========================================================================
  header("B.3.c — close_position_early (internal Kamino redeem if shortfall)");

  const traderBeforeClose = (await getAccount(connection, traderUsdcAta)).amount;
  const collBeforeClose = (await getAccount(connection, collateralVaultPda)).amount;
  const treasuryBeforeClose = (await getAccount(connection, deployerUsdcAta)).amount;
  const kBeforeClose = (await getAccount(connection, kaminoDepositPda)).amount;

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
  const traderAfterClose = (await getAccount(connection, traderUsdcAta)).amount;
  const collAfterClose = (await getAccount(connection, collateralVaultPda)).amount;
  const treasuryAfterClose = (await getAccount(connection, deployerUsdcAta)).amount;
  const kAfterClose = (await getAccount(connection, kaminoDepositPda)).amount;
  const traderReceived = Number(traderAfterClose) - Number(traderBeforeClose);
  const earlyCloseFee = Number(treasuryAfterClose) - Number(treasuryBeforeClose);
  const kRedeemed = Number(kBeforeClose) - Number(kAfterClose);
  console.log(`  collateral_vault:     ${Number(collBeforeClose) / 1e6} → ${Number(collAfterClose) / 1e6}`);
  console.log(`  trader received:      +${traderReceived} raw  (= $${traderReceived / 1e6})`);
  console.log(`  early_close_fee:      +${earlyCloseFee} raw  (= $${earlyCloseFee / 1e6})`);
  console.log(`  kamino redeemed via internal CPI: ${kRedeemed} k-USDC`);
  console.log(`  ✓ close_position_early works on mainnet build`);

  // ==========================================================================
  header("B.3.b — sync_kamino_yield + request_withdrawal (Finding 10 fix)");

  // No drain workaround here — we now exercise the request_withdrawal handler's
  // own internal CPI path with the cap + proportional burn that PR-fix added.
  // If the protocol's USDC→k-USDC conversion is correct AND the cap binds
  // gracefully when needed, the LP exits in one tx with no keeper-side prep.
  console.log(`  lp_vault before: ${(await getAccount(connection, lpVaultPda)).amount} raw`);
  console.log(`  kamino_deposit:  ${(await getAccount(connection, kaminoDepositPda)).amount} k-USDC`);

  // Refresh NAV staleness gate
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
  console.log(`  ✓ sync_kamino_yield refreshed staleness`);

  const lpPosition = await program.account.lpPosition.fetch(lpPositionPda);
  const sharesToBurn = lpPosition.shares;
  const lpUsdcBefore = (await getAccount(connection, deployerUsdcAta)).amount; // deployer = LP here
  const treasuryBeforeWd = (await getAccount(connection, deployerUsdcAta)).amount;

  await program.methods
    .requestWithdrawal(sharesToBurn)
    .accountsStrict({
      protocolState: protocolStatePda,
      market: marketPda,
      lpPosition: lpPositionPda,
      lpVault: lpVaultPda,
      lpMint: lpMintPda,
      underlyingMint: USDC_MINT,
      withdrawerLpTokenAccount: deployerLpAta,
      withdrawerTokenAccount: deployerUsdcAta,
      treasury: deployerUsdcAta,
      withdrawer: deployer.publicKey,
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
    .rpc();
  const marketFinal = await program.account.swapMarket.fetch(marketPda);
  const lpUsdcAfter = (await getAccount(connection, deployerUsdcAta)).amount;
  console.log(`  shares_burned:        ${sharesToBurn.toString()}`);
  console.log(`  total_lp_shares:      ${marketFinal.totalLpShares.toString()}`);
  console.log(`  lp_nav:               ${marketFinal.lpNav.toString()}`);
  console.log(`  LP+treasury net:      ${Number(lpUsdcBefore) / 1e6} → ${Number(lpUsdcAfter) / 1e6} USDC (treasury & LP share same ATA in this script)`);
  if (marketFinal.totalLpShares.toString() !== "0") {
    throw new Error(`request_withdrawal: shares not fully burned (${marketFinal.totalLpShares})`);
  }
  console.log(`  ✓ request_withdrawal works on mainnet build (internal CPI redeemed shortfall from Kamino)`);

  console.log(`\n=== B.3 PASSED — full LP/trader cycle works on mainnet build ===`);
  console.log(`  • update_rate_index real (refresh_reserve + bsf compounding)`);
  console.log(`  • open_swap with rate from live Kamino`);
  console.log(`  • settle_period + close_position_early`);
  console.log(`  • sync_kamino_yield + request_withdrawal with internal Kamino redeem`);
}

main().catch((err) => {
  console.error("\nError:", err);
  process.exit(1);
});
