#!/usr/bin/env ts-node
/**
 * End-to-end demo against Surfpool (mainnet fork). Shows the full Anemone
 * lifecycle hitting REAL Kamino CPIs:
 *
 *   1. LP deposits USDC into Anemone
 *   2. Keeper moves USDC to Kamino via deposit_to_kamino (real CPI → k-USDC)
 *   3. Trader opens a PayFixed swap, posting collateral
 *   4. Time-travel one settlement period forward
 *   5. update_rate_index (real CPI) refreshes the rate snapshot
 *   6. settle_period flows PnL between collateral_vault and lp_vault
 *   7. Trader closes early, paying the early-close fee
 *
 * Requires Surfpool 1.2+ with the anemone program already deployed (the
 * default `runbooks/deployment` runbook fired during `surfpool start`).
 *
 * Usage:
 *   surfpool start --network mainnet --no-tui -y    # in another terminal
 *   yarn ts-node scripts/demo-surfpool.ts
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

// Real Kamino mainnet — Surfpool forks them on demand.
const KAMINO_PROGRAM = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const KAMINO_USDC_RESERVE = new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const INSTRUCTIONS_SYSVAR = new PublicKey("Sysvar1nstructions1111111111111111111111111");

// Short tenor so the demo runs end-to-end in under a minute of wall-clock
// time. 60s tenor, 10s settlement period — small enough that we wait in real
// time between phases (no fragile time-travel needed).
const TENOR_SECONDS = new anchor.BN(60);
const SETTLEMENT_PERIOD_SECONDS = new anchor.BN(10);
const MAX_UTILIZATION_BPS = 6000;
const BASE_SPREAD_BPS = 80;

const PROTOCOL_FEE_BPS = 1000;
const OPENING_FEE_BPS = 5;
const LIQUIDATION_FEE_BPS = 300;
const WITHDRAWAL_FEE_BPS = 5;
const EARLY_CLOSE_FEE_BPS = 500;

const SEED_LP_USDC = 5_000_000_000; // 5000 USDC (6 dp)
// Keeper deposits most of the LP into Kamino to earn yield, but leaves a
// liquidity buffer in lp_vault so settle_period has cash to pay trader PnL.
// In production this is what the keeper's rebalance loop does — never 100%
// in Kamino.
const KAMINO_DEPOSIT_USDC = 4_900_000_000; // 4900 USDC → Kamino (98%)
const TRADER_USDC = 1_000_000_000; // 1000 USDC for the trader's balance
const NOTIONAL_USDC = 1_000_000_000; // 1000 USDC notional swap
const TRADER_NONCE = 0;
const MAX_RATE_BPS = new anchor.BN(10_000); // 100% APY ceiling — generous slippage
const MIN_RATE_BPS = new anchor.BN(0);

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, "utf-8"))));
}

function header(s: string) {
  console.log(`\n=== ${s} ===`);
}

async function main() {
  const deployer = loadKeypair(DEPLOYER_KEYPAIR);
  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(deployer), {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../target/idl/anemone.json"), "utf-8"),
  );
  const program = new Program<Anemone>(idl, provider);

  console.log(`Deployer: ${deployer.publicKey.toBase58()}`);
  console.log(`Program:  ${program.programId.toBase58()}`);
  console.log(`RPC:      ${RPC_URL}`);

  // ---------------------------------------------------------------------------
  header("Phase 0 — read live Kamino USDC Reserve");

  const reserveAcc = await connection.getAccountInfo(KAMINO_USDC_RESERVE);
  if (!reserveAcc) {
    throw new Error(`Reserve ${KAMINO_USDC_RESERVE.toBase58()} not found — Surfpool fork issue?`);
  }
  const reserve = Reserve.decode(reserveAcc.data);

  const lendingMarket = new PublicKey((reserve as any).lendingMarket.toString());
  const reserveLiquiditySupply = new PublicKey(
    (reserve.liquidity as any).supplyVault.toString(),
  );
  const reserveCollateralMint = new PublicKey(
    (reserve.collateral as any).mintPubkey.toString(),
  );

  // Kamino's lending_market_authority PDA: seeds = ["lma", lending_market]
  const [lendingMarketAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("lma"), lendingMarket.toBuffer()],
    KAMINO_PROGRAM,
  );

  console.log(`  lending_market:                ${lendingMarket.toBase58()}`);
  console.log(`  lending_market_authority:      ${lendingMarketAuthority.toBase58()}`);
  console.log(`  reserve_liquidity_supply:      ${reserveLiquiditySupply.toBase58()}`);
  console.log(`  reserve_collateral_mint (k):   ${reserveCollateralMint.toBase58()}`);

  // ---------------------------------------------------------------------------
  header("Phase 1 — override deployer USDC balance (5000 USDC)");

  await setTokenBalance(connection, deployer.publicKey, USDC_MINT, SEED_LP_USDC);
  const deployerUsdcAta = await createAssociatedTokenAccountIdempotent(
    connection,
    deployer,
    USDC_MINT,
    deployer.publicKey,
  );
  const ataBalance = await getAccount(connection, deployerUsdcAta);
  console.log(`  deployer ATA: ${deployerUsdcAta.toBase58()}`);
  console.log(`  balance:      ${Number(ataBalance.amount) / 1e6} USDC`);

  // ---------------------------------------------------------------------------
  header("Phase 2 — initialize_protocol (idempotent)");

  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    program.programId,
  );

  const protocolExists = await connection.getAccountInfo(protocolStatePda);
  if (protocolExists) {
    console.log(`  already initialised at ${protocolStatePda.toBase58()}`);
  } else {
    const tx = await program.methods
      .initializeProtocol(
        PROTOCOL_FEE_BPS,
        OPENING_FEE_BPS,
        LIQUIDATION_FEE_BPS,
        WITHDRAWAL_FEE_BPS,
        EARLY_CLOSE_FEE_BPS,
      )
      .accountsStrict({
        protocolState: protocolStatePda,
        authority: deployer.publicKey,
        treasury: deployerUsdcAta,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`  tx: ${tx}`);
  }

  // ---------------------------------------------------------------------------
  header("Phase 3 — create_market (REAL k-USDC mint, short tenor)");

  const [marketPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("market"),
      KAMINO_USDC_RESERVE.toBuffer(),
      TENOR_SECONDS.toArrayLike(Buffer, "le", 8),
    ],
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
  const [lpMintPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_mint"), marketPda.toBuffer()],
    program.programId,
  );
  const [kaminoDepositPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("kamino_deposit"), marketPda.toBuffer()],
    program.programId,
  );
  console.log(`  market:                  ${marketPda.toBase58()}`);
  console.log(`  lp_vault:                ${lpVaultPda.toBase58()}`);
  console.log(`  kamino_deposit_account:  ${kaminoDepositPda.toBase58()}`);

  const marketExists = await connection.getAccountInfo(marketPda);
  if (marketExists) {
    console.log(`  market already exists`);
  } else {
    const tx = await program.methods
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
    console.log(`  tx: ${tx}`);
  }

  // ---------------------------------------------------------------------------
  header("Phase 4 — seed rate index (live Kamino bsf read + stub oracle write)");

  // We READ the live cumulative_borrow_rate_bsf from the forked Kamino
  // Reserve so the snapshots reflect mainnet reality, but WRITE via
  // set_rate_index_oracle (the stub-oracle admin path). Why not call
  // update_rate_index directly?
  //   - update_rate_index does a refresh_reserve CPI as part of staleness
  //     handling. On Surfpool, refresh_reserve overflows with even small
  //     slot deltas because Kamino's compounding math hits u128 limits when
  //     the live mainnet bsf is already ~1.45e18.
  //   - We've already proven update_rate_index real CPI works in
  //     setup-surfpool.ts (committed). The big proof point of THIS demo is
  //     the deposit_to_kamino CPI in Phase 6, not the rate-read CPI.
  //
  // The two snapshots are spaced by ~8s real time (long enough that
  // Anemone's APY helper Taylor expansion does not overflow on `elapsed`).
  const reserveLive = Reserve.decode(
    (await connection.getAccountInfo(KAMINO_USDC_RESERVE))!.data,
  );
  const liveBsfLow = BigInt(
    (reserveLive.liquidity as any).cumulativeBorrowRateBsf.value[0].toString(),
  );
  const liveBsfHigh = BigInt(
    (reserveLive.liquidity as any).cumulativeBorrowRateBsf.value[1].toString(),
  );
  const liveBsf = liveBsfLow | (liveBsfHigh << 64n);
  // Bump must annualise to a realistic APY (~12%). With 8s elapsed between
  // snapshots, bump fraction = APY * elapsed / SECONDS_PER_YEAR
  //                          = 0.13 * 8 / 31_536_000 ≈ 3.3e-8
  // → divisor = 1 / 3.3e-8 ≈ 30_000_000.
  const snapshots: Array<[number, bigint]> = [
    [1, liveBsf],
    [2, liveBsf + liveBsf / 30_000_000n],
  ];

  for (const [i, value] of snapshots) {
    const tx = await program.methods
      .setRateIndexOracle(new anchor.BN(value.toString()))
      .accountsStrict({
        protocolState: protocolStatePda,
        market: marketPda,
        authority: deployer.publicKey,
      })
      .rpc();
    const m = await program.account.swapMarket.fetch(marketPda);
    console.log(`  call ${i}: tx ${tx}`);
    console.log(`    previous_rate_index: ${m.previousRateIndex.toString()}`);
    console.log(`    current_rate_index:  ${m.currentRateIndex.toString()}`);
    if (i === 1) {
      console.log(`  waiting 8s so the two snapshots are well-separated...`);
      await new Promise((r) => setTimeout(r, 8000));
    }
  }

  // ---------------------------------------------------------------------------
  header("Phase 5 — deposit_lp (5000 USDC)");

  const [lpPositionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp"), deployer.publicKey.toBuffer(), marketPda.toBuffer()],
    program.programId,
  );
  const deployerLpAta = await createAssociatedTokenAccountIdempotent(
    connection,
    deployer,
    lpMintPda,
    deployer.publicKey,
  );

  const beforeLpVault = await getAccount(connection, lpVaultPda);
  const tx5 = await program.methods
    .depositLiquidity(new anchor.BN(SEED_LP_USDC))
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
  const afterLpVault = await getAccount(connection, lpVaultPda);
  console.log(`  tx: ${tx5}`);
  console.log(
    `  lp_vault: ${Number(beforeLpVault.amount) / 1e6} → ${Number(afterLpVault.amount) / 1e6} USDC`,
  );

  // ---------------------------------------------------------------------------
  header(
    `Phase 6 — deposit_to_kamino (REAL CPI: ${KAMINO_DEPOSIT_USDC / 1e6} USDC → k-USDC)`,
  );

  const beforeLpVaultK = await getAccount(connection, lpVaultPda);
  const beforeKDeposit = await getAccount(connection, kaminoDepositPda);

  const tx6 = await program.methods
    .depositToKamino(new anchor.BN(KAMINO_DEPOSIT_USDC))
    .accountsStrict({
      protocolState: protocolStatePda,
      keeper: deployer.publicKey, // deployer is the default keeper after init
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

  const afterLpVaultK = await getAccount(connection, lpVaultPda);
  const afterKDeposit = await getAccount(connection, kaminoDepositPda);
  console.log(`  tx: ${tx6}`);
  console.log(
    `  lp_vault:               ${Number(beforeLpVaultK.amount) / 1e6} → ${Number(afterLpVaultK.amount) / 1e6} USDC`,
  );
  console.log(
    `  kamino_deposit_account: ${Number(beforeKDeposit.amount) / 1e6} → ${Number(afterKDeposit.amount) / 1e6} k-USDC`,
  );

  // ---------------------------------------------------------------------------
  header("Phase 7 — fund trader (1000 USDC + SOL for fees)");

  const trader = Keypair.generate();
  await setTokenBalance(connection, trader.publicKey, USDC_MINT, TRADER_USDC);
  // Fund SOL so the trader can sign transactions
  const fundSig = await connection.requestAirdrop(
    trader.publicKey,
    1_000_000_000, // 1 SOL
  );
  await connection.confirmTransaction(fundSig, "confirmed");
  const traderUsdcAta = await createAssociatedTokenAccountIdempotent(
    connection,
    deployer, // deployer pays the rent
    USDC_MINT,
    trader.publicKey,
  );
  const traderBal = await getAccount(connection, traderUsdcAta);
  console.log(`  trader:  ${trader.publicKey.toBase58()}`);
  console.log(`  USDC:    ${Number(traderBal.amount) / 1e6}`);
  console.log(`  SOL:     ${(await connection.getBalance(trader.publicKey)) / 1e9}`);

  // ---------------------------------------------------------------------------
  header("Phase 8 — open_swap PayFixed (1000 USDC notional)");

  const [swapPositionPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("swap"),
      trader.publicKey.toBuffer(),
      marketPda.toBuffer(),
      Buffer.from([TRADER_NONCE]),
    ],
    program.programId,
  );

  const beforeCollVault = await getAccount(connection, collateralVaultPda);
  const beforeTraderUsdc = await getAccount(connection, traderUsdcAta);

  const tx8 = await program.methods
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

  const afterCollVault = await getAccount(connection, collateralVaultPda);
  const afterTraderUsdc = await getAccount(connection, traderUsdcAta);
  const position = await program.account.swapPosition.fetch(swapPositionPda);

  console.log(`  tx: ${tx8}`);
  console.log(`  fixed_rate_bps:        ${position.fixedRateBps.toNumber()} (${(position.fixedRateBps.toNumber() / 100).toFixed(2)}%)`);
  console.log(`  collateral_deposited:  ${position.collateralDeposited.toNumber() / 1e6} USDC`);
  console.log(`  next_settlement_ts:    ${position.nextSettlementTs.toNumber()} (${new Date(position.nextSettlementTs.toNumber() * 1000).toISOString()})`);
  console.log(
    `  collateral_vault: ${Number(beforeCollVault.amount) / 1e6} → ${Number(afterCollVault.amount) / 1e6} USDC`,
  );
  console.log(
    `  trader USDC:      ${Number(beforeTraderUsdc.amount) / 1e6} → ${Number(afterTraderUsdc.amount) / 1e6}`,
  );

  // ---------------------------------------------------------------------------
  header("Phase 9 — wait one settlement period in real time");

  // No time-travel: just wait. settlement_period_seconds is 10s; we wait 12s
  // to be safely past `next_settlement_ts` and let Surfpool's clock advance
  // naturally. Slot delta over 12s (~30 slots) is small enough that Kamino's
  // refresh_reserve in Phase 10 still works.
  const nowSec = Math.floor(Date.now() / 1000);
  const nextSettlementUnix = position.nextSettlementTs.toNumber();
  const secondsToWait = Math.max(0, nextSettlementUnix - nowSec) + 2;
  console.log(`  now:                 ${nowSec}`);
  console.log(`  next_settlement_ts:  ${nextSettlementUnix}`);
  console.log(`  waiting ${secondsToWait}s...`);
  await new Promise((r) => setTimeout(r, secondsToWait * 1000));

  // ---------------------------------------------------------------------------
  header("Phase 10 — bump rate index via stub oracle (post-wait)");

  // Same rationale as Phase 4: we sidestep refresh_reserve and write through
  // the stub-oracle path. The bump annualises to ~13% APY for a 12s wait,
  // matching the snapshot pacing in Phase 4. settle_period sees a non-zero
  // PnL but stays well under H4's 5%-per-period cap.
  const m9 = await program.account.swapMarket.fetch(marketPda);
  const nextRateIndex =
    BigInt(m9.currentRateIndex.toString()) +
    BigInt(m9.currentRateIndex.toString()) / 20_000_000n;
  const tx10 = await program.methods
    .setRateIndexOracle(new anchor.BN(nextRateIndex.toString()))
    .accountsStrict({
      protocolState: protocolStatePda,
      market: marketPda,
      authority: deployer.publicKey,
    })
    .rpc();
  const m10 = await program.account.swapMarket.fetch(marketPda);
  console.log(`  tx: ${tx10}`);
  console.log(`  previous_rate_index: ${m10.previousRateIndex.toString()}`);
  console.log(`  current_rate_index:  ${m10.currentRateIndex.toString()}`);

  // ---------------------------------------------------------------------------
  header("Phase 11 — settle_period (permissionless, deployer calls)");

  const beforeSettleColl = await getAccount(connection, collateralVaultPda);
  const beforeSettleLp = await getAccount(connection, lpVaultPda);
  const tx11 = await program.methods
    .settlePeriod()
    .accountsStrict({
      market: marketPda,
      swapPosition: swapPositionPda,
      lpVault: lpVaultPda,
      collateralVault: collateralVaultPda,
      underlyingMint: USDC_MINT,
      caller: deployer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  const afterSettleColl = await getAccount(connection, collateralVaultPda);
  const afterSettleLp = await getAccount(connection, lpVaultPda);
  const positionAfterSettle = await program.account.swapPosition.fetch(swapPositionPda);

  console.log(`  tx: ${tx11}`);
  console.log(
    `  collateral_vault:     ${Number(beforeSettleColl.amount) / 1e6} → ${Number(afterSettleColl.amount) / 1e6} USDC`,
  );
  console.log(
    `  lp_vault:             ${Number(beforeSettleLp.amount) / 1e6} → ${Number(afterSettleLp.amount) / 1e6} USDC`,
  );
  console.log(`  num_settlements:      ${positionAfterSettle.numSettlements}`);
  console.log(`  collateral_remaining: ${positionAfterSettle.collateralRemaining.toNumber() / 1e6} USDC`);

  // ---------------------------------------------------------------------------
  header("Phase 12 — close_position_early (trader exits, pays 5% early-close fee)");

  const beforeCloseColl = await getAccount(connection, collateralVaultPda);
  const beforeCloseTrader = await getAccount(connection, traderUsdcAta);
  const beforeCloseTreasury = await getAccount(connection, deployerUsdcAta);

  const tx12 = await program.methods
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
    })
    .signers([trader])
    .rpc();

  const afterCloseColl = await getAccount(connection, collateralVaultPda);
  const afterCloseTrader = await getAccount(connection, traderUsdcAta);
  const afterCloseTreasury = await getAccount(connection, deployerUsdcAta);

  console.log(`  tx: ${tx12}`);
  console.log(
    `  collateral_vault:  ${Number(beforeCloseColl.amount) / 1e6} → ${Number(afterCloseColl.amount) / 1e6} USDC`,
  );
  console.log(
    `  trader USDC:       ${Number(beforeCloseTrader.amount) / 1e6} → ${Number(afterCloseTrader.amount) / 1e6}`,
  );
  console.log(
    `  treasury USDC:     ${Number(beforeCloseTreasury.amount) / 1e6} → ${Number(afterCloseTreasury.amount) / 1e6}`,
  );

  // ---------------------------------------------------------------------------
  header("Phase 13 — withdraw_from_kamino (REAL CPI: k-USDC → USDC)");

  // Round-trip the LP funds back: redeem all k-USDC for USDC. In production
  // this is what the keeper does when an LP wants to withdraw or when the
  // pool needs more liquidity than the buffer covers. Closes the Kamino
  // integration loop — both directions of the CPI proven on Surfpool.
  const kDeposit = await getAccount(connection, kaminoDepositPda);
  const kAmount = kDeposit.amount;
  const beforeWithdrawLpVault = await getAccount(connection, lpVaultPda);

  const tx13 = await program.methods
    .withdrawFromKamino(new anchor.BN(kAmount.toString()))
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

  const afterKDepositW = await getAccount(connection, kaminoDepositPda);
  const afterWithdrawLpVault = await getAccount(connection, lpVaultPda);
  console.log(`  tx: ${tx13}`);
  console.log(
    `  kamino_deposit_account: ${Number(kAmount) / 1e6} → ${Number(afterKDepositW.amount) / 1e6} k-USDC`,
  );
  console.log(
    `  lp_vault:               ${Number(beforeWithdrawLpVault.amount) / 1e6} → ${Number(afterWithdrawLpVault.amount) / 1e6} USDC`,
  );

  console.log(`\n=== Demo complete: full Anemone lifecycle on Surfpool ===`);
  console.log(`  Real Kamino CPI:   deposit_to_kamino + withdraw_from_kamino ✓`);
  console.log(`  Real Kamino read:  cumulative_borrow_rate_bsf decoded from live Reserve ✓`);
  console.log(`  Trader cycle:      open_swap → settle_period → close_position_early ✓`);
  console.log(`  Stub-oracle write: rate index seeded via set_rate_index_oracle (devnet path)`);
}

main().catch((err) => {
  console.error("\nError:", err);
  process.exit(1);
});
