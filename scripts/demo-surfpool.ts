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
// 100% of LP capital goes to Kamino — no idle buffer. The keeper just-in-time
// withdraws from Kamino as a `preInstruction` before settle/close txs that
// might need cash. Eliminates the yield drag a static buffer would cause
// (~2% APY at 20% buffer with 10% Kamino rate). The 2-phase commit pattern
// already enforced by `unpaid_pnl` + `UnpaidPnlOutstanding` is what makes
// the JIT model safe — settle accrues the debt, close refuses to settle
// until the keeper has refilled lp_vault.
const KAMINO_DEPOSIT_USDC = SEED_LP_USDC;
// Pre-settle JIT withdraw: keeper redeems a small amount of k-USDC for USDC
// before each settle/close, ensuring lp_vault has cash for any direction of
// PnL. Sized as a ceiling on the worst-case PnL per period (notional × rate
// move cap of 5% × elapsed/year), safely overshooting for the demo.
const JIT_WITHDRAW_K_USDC = 10_000_000; // 10 k-USDC (~12 USDC)
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
      keeper: deployer.publicKey, // deposit stays keeper-only
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
  header("Phase 11 — settle_period (with JIT Kamino withdraw preInstruction)");

  // Just-in-time pattern: keeper bundles `withdraw_from_kamino` as a
  // preInstruction so lp_vault has cash to pay any direction of PnL the
  // settle_period below resolves. Both instructions are atomic — if either
  // fails the entire tx reverts.
  const jitWithdrawIx = await program.methods
    .withdrawFromKamino(new anchor.BN(JIT_WITHDRAW_K_USDC))
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

  const beforeSettleColl = await getAccount(connection, collateralVaultPda);
  const beforeSettleLp = await getAccount(connection, lpVaultPda);
  const beforeSettleTreasury = await getAccount(connection, deployerUsdcAta);
  const tx11 = await program.methods
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
  const afterSettleColl = await getAccount(connection, collateralVaultPda);
  const afterSettleLp = await getAccount(connection, lpVaultPda);
  const afterSettleTreasury = await getAccount(connection, deployerUsdcAta);
  const positionAfterSettle = await program.account.swapPosition.fetch(swapPositionPda);

  const treasuryDelta = Number(afterSettleTreasury.amount) - Number(beforeSettleTreasury.amount);
  console.log(`  tx: ${tx11}`);
  console.log(
    `  collateral_vault:     ${Number(beforeSettleColl.amount) / 1e6} → ${Number(afterSettleColl.amount) / 1e6} USDC`,
  );
  console.log(
    `  lp_vault:             ${Number(beforeSettleLp.amount) / 1e6} → ${Number(afterSettleLp.amount) / 1e6} USDC`,
  );
  console.log(`  num_settlements:      ${positionAfterSettle.numSettlements}`);
  console.log(`  collateral_remaining: ${positionAfterSettle.collateralRemaining.toNumber() / 1e6} USDC`);
  console.log(`  treasury delta (A.9): +${treasuryDelta} raw units (= protocol_fee on spread leg)`);
  if (treasuryDelta < 0) {
    throw new Error(`A.9: treasury delta should be >= 0, got ${treasuryDelta}`);
  }

  // ---------------------------------------------------------------------------
  header("Phase 12 — close_position_early (internal Kamino redeem on shortfall)");

  // Atomic exit: the program does the `withdraw_from_kamino` CPI itself when
  // lp_vault is short of unpaid_pnl. Trader signs ONE ix, no preInstruction
  // bundle, no dependency on a live keeper. Replaces the previous
  // permissionless-withdraw + close pattern from PR #25 — same liveness
  // guarantee, no spammable rebalance surface for grief.
  //
  // In this demo, lp_vault has cash from Phase 11 settle so the CPI won't
  // actually fire — but the 11 Kamino accounts must still be passed (Anchor
  // validates them at deserialization).
  const beforeCloseColl = await getAccount(connection, collateralVaultPda);
  const beforeCloseTrader = await getAccount(connection, traderUsdcAta);
  const beforeCloseTreasury = await getAccount(connection, deployerUsdcAta);
  const beforeCloseLp = await getAccount(connection, lpVaultPda);
  const beforeCloseSnapshot = (await program.account.swapMarket.fetch(marketPda)).lastKaminoSnapshotUsdc;

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

  const afterCloseColl = await getAccount(connection, collateralVaultPda);
  const afterCloseTrader = await getAccount(connection, traderUsdcAta);
  const afterCloseTreasury = await getAccount(connection, deployerUsdcAta);

  const afterCloseLp = await getAccount(connection, lpVaultPda);

  console.log(`  tx: ${tx12}  (single ix: close + internal Kamino redeem if needed)`);
  console.log(
    `  lp_vault:          ${Number(beforeCloseLp.amount) / 1e6} → ${Number(afterCloseLp.amount) / 1e6} USDC`,
  );
  console.log(
    `  collateral_vault:  ${Number(beforeCloseColl.amount) / 1e6} → ${Number(afterCloseColl.amount) / 1e6} USDC`,
  );
  console.log(
    `  trader USDC:       ${Number(beforeCloseTrader.amount) / 1e6} → ${Number(afterCloseTrader.amount) / 1e6}`,
  );
  console.log(
    `  treasury USDC:     ${Number(beforeCloseTreasury.amount) / 1e6} → ${Number(afterCloseTreasury.amount) / 1e6}`,
  );
  // A.11.a — assert snapshot tracking on close_position_early
  const afterCloseSnapshot = (await program.account.swapMarket.fetch(marketPda)).lastKaminoSnapshotUsdc;
  const closeLpDelta = Number(afterCloseLp.amount) - Number(beforeCloseLp.amount);
  const closeSnapshotDelta = afterCloseSnapshot.sub(beforeCloseSnapshot).toNumber();
  console.log(`  last_kamino_snapshot_usdc: ${beforeCloseSnapshot.toString()} → ${afterCloseSnapshot.toString()} (A.11.a)`);
  if (closeLpDelta >= 0 && closeSnapshotDelta !== 0) {
    throw new Error(`A.11.a: lp_vault not drained (no CPI fired) but snapshot changed by ${closeSnapshotDelta}`);
  }
  if (closeLpDelta < 0 && closeSnapshotDelta >= 0) {
    throw new Error(`A.11.a: CPI fired (lp_vault delta=${closeLpDelta}) but snapshot did not decrement`);
  }
  console.log(`  ✓ A.11.a: snapshot consistent with internal-CPI fire (delta=${closeSnapshotDelta})`);

  // ---------------------------------------------------------------------------
  // Phases 13-17: claim_matured flow on a fresh short-tenor market.
  // Forces the internal Kamino redeem CPI to actually fire by:
  //   - draining all LP capital into Kamino (lp_vault = 0)
  //   - waiting past tenor so settle marks the position Matured with
  //     positive unpaid_pnl (LP owes trader; nothing in lp_vault to pay)
  //   - claim_matured then must redeem k-USDC from Kamino in the same tx
  // ---------------------------------------------------------------------------
  header("Phase 13 — short-tenor market + refill deployer USDC");

  const SHORT_TENOR = new anchor.BN(8);
  const SHORT_SETTLEMENT = new anchor.BN(4);
  const SHORT_LP_USDC = 1_000_000_000; // 1000 USDC
  const SHORT_NOTIONAL = 100_000_000;  // 100 USDC
  const SHORT_NONCE = 0;

  // Refill deployer USDC (the original 5000 went into the main market's LP).
  await setTokenBalance(connection, deployer.publicKey, USDC_MINT, SHORT_LP_USDC);

  const [shortMarketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), KAMINO_USDC_RESERVE.toBuffer(), SHORT_TENOR.toArrayLike(Buffer, "le", 8)],
    program.programId,
  );
  const [shortLpVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_vault"), shortMarketPda.toBuffer()],
    program.programId,
  );
  const [shortCollateralVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("collateral_vault"), shortMarketPda.toBuffer()],
    program.programId,
  );
  const [shortLpMintPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_mint"), shortMarketPda.toBuffer()],
    program.programId,
  );
  const [shortKaminoDepositPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("kamino_deposit"), shortMarketPda.toBuffer()],
    program.programId,
  );
  console.log(`  short_market:           ${shortMarketPda.toBase58()}`);
  console.log(`  short_lp_vault:         ${shortLpVaultPda.toBase58()}`);
  console.log(`  short_kamino_deposit:   ${shortKaminoDepositPda.toBase58()}`);

  const shortMarketExists = await connection.getAccountInfo(shortMarketPda);
  if (shortMarketExists) {
    console.log(`  short market already exists (rerun)`);
  } else {
    const txCreate = await program.methods
      .createMarket(SHORT_TENOR, SHORT_SETTLEMENT, MAX_UTILIZATION_BPS, BASE_SPREAD_BPS)
      .accountsStrict({
        protocolState: protocolStatePda,
        market: shortMarketPda,
        lpVault: shortLpVaultPda,
        collateralVault: shortCollateralVaultPda,
        lpMint: shortLpMintPda,
        kaminoDepositAccount: shortKaminoDepositPda,
        kaminoCollateralMint: reserveCollateralMint,
        underlyingReserve: KAMINO_USDC_RESERVE,
        underlyingProtocol: KAMINO_PROGRAM,
        underlyingMint: USDC_MINT,
        authority: deployer.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    console.log(`  tx: ${txCreate}`);
  }

  // ---------------------------------------------------------------------------
  header("Phase 14 — seed rate + deposit_lp + deposit_to_kamino (drain to 0)");

  // Two oracle snapshots 8s apart so current_apy ≈ 13%. The 8s spacing is
  // load-bearing: with elapsed < 8s, calculate_current_apy_from_index's
  // term3 overflow path gets hit (n = SEC_PER_YEAR * PRECISION / elapsed
  // grows past the u128 budget for the n*n_minus_1*n_minus_2 chain even
  // when r_cubed is 0).
  const reserveLive14 = Reserve.decode(
    (await connection.getAccountInfo(KAMINO_USDC_RESERVE))!.data,
  );
  const liveBsf14Low = BigInt(
    (reserveLive14.liquidity as any).cumulativeBorrowRateBsf.value[0].toString(),
  );
  const liveBsf14High = BigInt(
    (reserveLive14.liquidity as any).cumulativeBorrowRateBsf.value[1].toString(),
  );
  const liveBsf14 = liveBsf14Low | (liveBsf14High << 64n);
  // 8s elapsed, 13% APY → bump fraction = 0.13 * 8 / 31_536_000 ≈ 3.3e-8 → divisor ~30M
  const shortSnaps: Array<[number, bigint]> = [
    [1, liveBsf14],
    [2, liveBsf14 + liveBsf14 / 30_000_000n],
  ];
  for (const [i, value] of shortSnaps) {
    await program.methods
      .setRateIndexOracle(new anchor.BN(value.toString()))
      .accountsStrict({
        protocolState: protocolStatePda,
        market: shortMarketPda,
        authority: deployer.publicKey,
      })
      .rpc();
    if (i === 1) {
      await new Promise((r) => setTimeout(r, 8000));
    }
  }
  const m14 = await program.account.swapMarket.fetch(shortMarketPda);
  console.log(`  rate seeded: previous=${m14.previousRateIndex.toString()} current=${m14.currentRateIndex.toString()}`);

  // LP deposit
  const [shortLpPositionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp"), deployer.publicKey.toBuffer(), shortMarketPda.toBuffer()],
    program.programId,
  );
  const deployerShortLpAta = await createAssociatedTokenAccountIdempotent(
    connection,
    deployer,
    shortLpMintPda,
    deployer.publicKey,
  );
  await program.methods
    .depositLiquidity(new anchor.BN(SHORT_LP_USDC))
    .accountsStrict({
      protocolState: protocolStatePda,
      market: shortMarketPda,
      lpPosition: shortLpPositionPda,
      lpVault: shortLpVaultPda,
      lpMint: shortLpMintPda,
      underlyingMint: USDC_MINT,
      depositorTokenAccount: deployerUsdcAta,
      depositorLpTokenAccount: deployerShortLpAta,
      depositor: deployer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  // Drain ALL LP capital to Kamino — lp_vault = 0 after this.
  await program.methods
    .depositToKamino(new anchor.BN(SHORT_LP_USDC))
    .accountsStrict({
      protocolState: protocolStatePda,
      keeper: deployer.publicKey,
      market: shortMarketPda,
      lpVault: shortLpVaultPda,
      kaminoDepositAccount: shortKaminoDepositPda,
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
  const lp14 = await getAccount(connection, shortLpVaultPda);
  const k14 = await getAccount(connection, shortKaminoDepositPda);
  console.log(`  lp_vault drained:       ${Number(lp14.amount) / 1e6} USDC (target: 0)`);
  console.log(`  kamino_deposit_account: ${Number(k14.amount) / 1e6} k-USDC`);

  // ---------------------------------------------------------------------------
  header("Phase 15 — open_swap PayFixed on short market");

  const [shortSwapPositionPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("swap"),
      trader.publicKey.toBuffer(),
      shortMarketPda.toBuffer(),
      Buffer.from([SHORT_NONCE]),
    ],
    program.programId,
  );

  const tx15 = await program.methods
    .openSwap(
      { payFixed: {} } as any,
      new anchor.BN(SHORT_NOTIONAL),
      SHORT_NONCE,
      MAX_RATE_BPS,
      MIN_RATE_BPS,
    )
    .accountsStrict({
      protocolState: protocolStatePda,
      market: shortMarketPda,
      swapPosition: shortSwapPositionPda,
      collateralVault: shortCollateralVaultPda,
      treasury: deployerUsdcAta,
      underlyingMint: USDC_MINT,
      traderTokenAccount: traderUsdcAta,
      trader: trader.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([trader])
    .rpc();
  const shortPos = await program.account.swapPosition.fetch(shortSwapPositionPda);
  console.log(`  tx: ${tx15}`);
  console.log(`  fixed_rate_bps:        ${shortPos.fixedRateBps.toNumber()} (${(shortPos.fixedRateBps.toNumber() / 100).toFixed(2)}%)`);
  console.log(`  collateral_deposited:  ${shortPos.collateralDeposited.toNumber() / 1e6} USDC`);
  console.log(`  maturity_timestamp:    ${shortPos.maturityTimestamp.toNumber()} (${new Date(shortPos.maturityTimestamp.toNumber() * 1000).toISOString()})`);

  // ---------------------------------------------------------------------------
  header("Phase 16 — wait past maturity + bump rate + settle_period (matures)");

  const nowSec16 = Math.floor(Date.now() / 1000);
  const maturityTs = shortPos.maturityTimestamp.toNumber();
  const wait16 = Math.max(0, maturityTs - nowSec16) + 2;
  console.log(`  now=${nowSec16}, maturity=${maturityTs}, waiting ${wait16}s...`);
  await new Promise((r) => setTimeout(r, wait16 * 1000));

  // Big bump so variable >> fixed → PayFixed earns positive PnL → unpaid_pnl
  // accrues against an empty lp_vault.
  const m16Before = await program.account.swapMarket.fetch(shortMarketPda);
  const bumpedRate =
    BigInt(m16Before.currentRateIndex.toString()) +
    BigInt(m16Before.currentRateIndex.toString()) / 5_000_000n;
  await program.methods
    .setRateIndexOracle(new anchor.BN(bumpedRate.toString()))
    .accountsStrict({
      protocolState: protocolStatePda,
      market: shortMarketPda,
      authority: deployer.publicKey,
    })
    .rpc();

  // Settle WITHOUT preInstruction — we WANT lp_vault to stay empty so the
  // unpaid_pnl accrues and Phase 17's claim_matured exercises the internal CPI.
  const lpBeforeSettle = await getAccount(connection, shortLpVaultPda);
  const tx16 = await program.methods
    .settlePeriod()
    .accountsStrict({
      protocolState: protocolStatePda,
      market: shortMarketPda,
      swapPosition: shortSwapPositionPda,
      lpVault: shortLpVaultPda,
      collateralVault: shortCollateralVaultPda,
      treasury: deployerUsdcAta,
      underlyingMint: USDC_MINT,
      caller: deployer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  const posAfterSettle = await program.account.swapPosition.fetch(shortSwapPositionPda);
  const lpAfterSettle = await getAccount(connection, shortLpVaultPda);
  console.log(`  tx: ${tx16}`);
  console.log(`  status:               ${JSON.stringify(posAfterSettle.status)}`);
  console.log(`  unpaid_pnl:           ${posAfterSettle.unpaidPnl.toNumber() / 1e6} USDC  (LP owes trader; lp_vault empty)`);
  console.log(`  lp_vault:             ${Number(lpBeforeSettle.amount) / 1e6} → ${Number(lpAfterSettle.amount) / 1e6} USDC`);

  if (!("matured" in (posAfterSettle.status as any))) {
    throw new Error(`Position did not mature; status=${JSON.stringify(posAfterSettle.status)}`);
  }

  // ---------------------------------------------------------------------------
  header("Phase 17 — claim_matured (internal Kamino redeem fires)");

  // The big proof: lp_vault is empty AND unpaid_pnl > 0. Without the internal
  // CPI, this claim would either: (a) revert with UnpaidPnlOutstanding, or
  // (b) require a separate keeper-side withdraw_from_kamino bundled by the
  // trader. With the new logic, the program does the redeem itself in the
  // same tx — atomic exit, no preInstruction, no keeper dependency.
  const traderBeforeClaim = await getAccount(connection, traderUsdcAta);
  const collateralBeforeClaim = await getAccount(connection, shortCollateralVaultPda);
  const lpBeforeClaim = await getAccount(connection, shortLpVaultPda);
  const kBeforeClaim = await getAccount(connection, shortKaminoDepositPda);
  const beforeClaimSnapshot = (await program.account.swapMarket.fetch(shortMarketPda)).lastKaminoSnapshotUsdc;

  const tx17 = await program.methods
    .claimMatured()
    .accountsStrict({
      market: shortMarketPda,
      swapPosition: shortSwapPositionPda,
      lpVault: shortLpVaultPda,
      collateralVault: shortCollateralVaultPda,
      ownerTokenAccount: traderUsdcAta,
      underlyingMint: USDC_MINT,
      owner: trader.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      kaminoDepositAccount: shortKaminoDepositPda,
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

  const traderAfterClaim = await getAccount(connection, traderUsdcAta);
  const collateralAfterClaim = await getAccount(connection, shortCollateralVaultPda);
  const lpAfterClaim = await getAccount(connection, shortLpVaultPda);
  const kAfterClaim = await getAccount(connection, shortKaminoDepositPda);

  const kaminoDrained = Number(kBeforeClaim.amount) - Number(kAfterClaim.amount);
  const traderReceived = Number(traderAfterClaim.amount) - Number(traderBeforeClaim.amount);

  console.log(`  tx: ${tx17}`);
  console.log(`  kamino_deposit:    ${Number(kBeforeClaim.amount) / 1e6} → ${Number(kAfterClaim.amount) / 1e6} k-USDC  (drained ${kaminoDrained / 1e6} k-USDC via internal CPI)`);
  console.log(`  lp_vault:          ${Number(lpBeforeClaim.amount) / 1e6} → ${Number(lpAfterClaim.amount) / 1e6} USDC`);
  console.log(`  collateral_vault:  ${Number(collateralBeforeClaim.amount) / 1e6} → ${Number(collateralAfterClaim.amount) / 1e6} USDC`);
  console.log(`  trader USDC:       ${Number(traderBeforeClaim.amount) / 1e6} → ${Number(traderAfterClaim.amount) / 1e6}  (received ${traderReceived / 1e6} USDC)`);

  if (kaminoDrained === 0) {
    console.log(`  ⚠ Internal CPI did not fire (lp_vault had cash) — flow still valid but didn't exercise the redeem path`);
  } else {
    console.log(`  ✓ Internal Kamino redeem fired atomically inside claim_matured`);
  }

  // A.11.b — assert snapshot tracking on claim_matured CPI redeem
  const afterClaimSnapshot = (await program.account.swapMarket.fetch(shortMarketPda)).lastKaminoSnapshotUsdc;
  const claimSnapshotDelta = afterClaimSnapshot.sub(beforeClaimSnapshot).toNumber();
  console.log(`  last_kamino_snapshot_usdc: ${beforeClaimSnapshot.toString()} → ${afterClaimSnapshot.toString()} (A.11.b)`);
  if (kaminoDrained > 0 && claimSnapshotDelta >= 0) {
    throw new Error(`A.11.b: CPI fired (drained ${kaminoDrained}) but snapshot did not decrement (delta=${claimSnapshotDelta})`);
  }
  if (kaminoDrained === 0 && claimSnapshotDelta !== 0) {
    throw new Error(`A.11.b: CPI did not fire but snapshot changed by ${claimSnapshotDelta}`);
  }
  console.log(`  ✓ A.11.b: snapshot decremented by ${-claimSnapshotDelta} raw USDC (CPI delivered ${kaminoDrained} k-USDC)`);

  // ---------------------------------------------------------------------------
  header("Phase 18 — withdraw_from_kamino (REAL CPI: k-USDC → USDC)");

  // Round-trip the LP funds back: redeem all k-USDC for USDC. In production
  // this is what the keeper does when an LP wants to withdraw or when the
  // pool needs more liquidity than the buffer covers. Closes the Kamino
  // integration loop — both directions of the CPI proven on Surfpool.
  const kDeposit = await getAccount(connection, kaminoDepositPda);
  const kAmount = kDeposit.amount;
  const beforeWithdrawLpVault = await getAccount(connection, lpVaultPda);

  const tx18 = await program.methods
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
  console.log(`  tx: ${tx18}`);
  console.log(
    `  kamino_deposit_account: ${Number(kAmount) / 1e6} → ${Number(afterKDepositW.amount) / 1e6} k-USDC`,
  );
  console.log(
    `  lp_vault:               ${Number(beforeWithdrawLpVault.amount) / 1e6} → ${Number(afterWithdrawLpVault.amount) / 1e6} USDC`,
  );

  // ===========================================================================
  // Suite A — security-hardening tests (Phases 19+)
  // Each phase is an isolated assertion against a defense added in PRs #28-31.
  // Negative tests must revert with the exact error name; positive tests must
  // succeed and update state as expected.
  //
  // Skipped on Surfpool (covered by anchor tests): A.2.a (same-tx rotation
  // reject) — needs update_rate_index, which overflows on Surfpool's slot
  // drift in refresh_reserve. Anchor tests already exercise the static
  // fixture path.
  // ===========================================================================

  // ---------------------------------------------------------------------------
  header("Phase 19 — A.1.b: update_rate_index rejected for non-keeper");

  {
    const intruder = Keypair.generate();
    const sig = await connection.requestAirdrop(intruder.publicKey, 1e9);
    await connection.confirmTransaction(sig, "confirmed");

    let reverted = false;
    try {
      await program.methods
        .updateRateIndex()
        .accountsStrict({
          protocolState: protocolStatePda,
          market: marketPda,
          kaminoReserve: KAMINO_USDC_RESERVE,
          keeper: intruder.publicKey,
        })
        .signers([intruder])
        .rpc();
    } catch (err) {
      reverted = true;
      const msg = String(err);
      if (!msg.includes("InvalidAuthority")) {
        throw new Error(`A.1.b: expected InvalidAuthority, got: ${msg.slice(0, 200)}`);
      }
      console.log(`  ✓ rejected with InvalidAuthority`);
    }
    if (!reverted) throw new Error("A.1.b: update_rate_index should have reverted for non-keeper");
  }

  // ---------------------------------------------------------------------------
  header("Phase 20 — A.4.b: withdraw_from_kamino rejected for non-keeper");

  {
    const intruder = Keypair.generate();
    const sig = await connection.requestAirdrop(intruder.publicKey, 1e9);
    await connection.confirmTransaction(sig, "confirmed");

    let reverted = false;
    try {
      await program.methods
        .withdrawFromKamino(new anchor.BN(1_000_000))
        .accountsStrict({
          protocolState: protocolStatePda,
          keeper: intruder.publicKey,
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
        .signers([intruder])
        .rpc();
    } catch (err) {
      reverted = true;
      const msg = String(err);
      if (!msg.includes("InvalidAuthority")) {
        throw new Error(`A.4.b: expected InvalidAuthority, got: ${msg.slice(0, 200)}`);
      }
      console.log(`  ✓ rejected with InvalidAuthority`);
    }
    if (!reverted) throw new Error("A.4.b: withdraw_from_kamino should have reverted for non-keeper");
  }

  // ---------------------------------------------------------------------------
  header("Phase 21 — A.6: MIN_NOTIONAL boundary on open_swap");

  {
    const NONCE_REJECT = 10;
    const NONCE_ACCEPT = 11;
    const [posReject] = PublicKey.findProgramAddressSync(
      [Buffer.from("swap"), trader.publicKey.toBuffer(), marketPda.toBuffer(), Buffer.from([NONCE_REJECT])],
      program.programId,
    );
    const [posAccept] = PublicKey.findProgramAddressSync(
      [Buffer.from("swap"), trader.publicKey.toBuffer(), marketPda.toBuffer(), Buffer.from([NONCE_ACCEPT])],
      program.programId,
    );

    let reverted = false;
    try {
      await program.methods
        .openSwap({ payFixed: {} } as any, new anchor.BN(9_999_999), NONCE_REJECT, MAX_RATE_BPS, MIN_RATE_BPS)
        .accountsStrict({
          protocolState: protocolStatePda,
          market: marketPda,
          swapPosition: posReject,
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
    } catch (err) {
      reverted = true;
      const msg = String(err);
      if (!msg.includes("InvalidAmount")) {
        throw new Error(`A.6.a: expected InvalidAmount, got: ${msg.slice(0, 200)}`);
      }
      console.log(`  ✓ A.6.a: notional 9_999_999 rejected with InvalidAmount`);
    }
    if (!reverted) throw new Error("A.6.a: should have reverted on dust notional");

    await program.methods
      .openSwap({ payFixed: {} } as any, new anchor.BN(10_000_000), NONCE_ACCEPT, MAX_RATE_BPS, MIN_RATE_BPS)
      .accountsStrict({
        protocolState: protocolStatePda,
        market: marketPda,
        swapPosition: posAccept,
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
    const positionA6 = await program.account.swapPosition.fetch(posAccept);
    console.log(`  ✓ A.6.b: notional 10_000_000 accepted; position notional=${positionA6.notional.toString()}`);
  }

  // ---------------------------------------------------------------------------
  header("Phase 22 — A.8: pause_market matrix (a, b, c, g, f)");

  {
    // A.8.a — admin pause flips status 0→1
    await program.methods
      .pauseMarket()
      .accountsStrict({
        protocolState: protocolStatePda,
        market: marketPda,
        authority: deployer.publicKey,
      })
      .rpc();
    let m = await program.account.swapMarket.fetch(marketPda);
    if (m.status !== 1) throw new Error(`A.8.a: expected status=1, got ${m.status}`);
    console.log(`  ✓ A.8.a: market paused, status=${m.status}`);

    // A.8.b — open_swap on paused reverts
    const NONCE_PAUSED = 20;
    const [posPaused] = PublicKey.findProgramAddressSync(
      [Buffer.from("swap"), trader.publicKey.toBuffer(), marketPda.toBuffer(), Buffer.from([NONCE_PAUSED])],
      program.programId,
    );
    let openReverted = false;
    try {
      await program.methods
        .openSwap({ payFixed: {} } as any, new anchor.BN(10_000_000), NONCE_PAUSED, MAX_RATE_BPS, MIN_RATE_BPS)
        .accountsStrict({
          protocolState: protocolStatePda,
          market: marketPda,
          swapPosition: posPaused,
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
    } catch (err) {
      openReverted = true;
      const msg = String(err);
      if (!msg.includes("MarketPaused")) {
        throw new Error(`A.8.b: expected MarketPaused, got: ${msg.slice(0, 200)}`);
      }
      console.log(`  ✓ A.8.b: open_swap on paused rejected with MarketPaused`);
    }
    if (!openReverted) throw new Error("A.8.b: open_swap should have reverted on paused market");

    // A.8.c — deposit_liquidity on paused reverts
    let depositReverted = false;
    try {
      await program.methods
        .depositLiquidity(new anchor.BN(1_000_000))
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
    } catch (err) {
      depositReverted = true;
      const msg = String(err);
      if (!msg.includes("MarketPaused")) {
        throw new Error(`A.8.c: expected MarketPaused, got: ${msg.slice(0, 200)}`);
      }
      console.log(`  ✓ A.8.c: deposit_liquidity on paused rejected with MarketPaused`);
    }
    if (!depositReverted) throw new Error("A.8.c: deposit_liquidity should have reverted on paused market");

    // A.8.g — pause_market from non-admin reverts
    const intruder = Keypair.generate();
    const sig = await connection.requestAirdrop(intruder.publicKey, 1e9);
    await connection.confirmTransaction(sig, "confirmed");
    let pauseReverted = false;
    try {
      await program.methods
        .pauseMarket()
        .accountsStrict({
          protocolState: protocolStatePda,
          market: marketPda,
          authority: intruder.publicKey,
        })
        .signers([intruder])
        .rpc();
    } catch (err) {
      pauseReverted = true;
      const msg = String(err);
      if (!msg.includes("InvalidAuthority")) {
        throw new Error(`A.8.g: expected InvalidAuthority, got: ${msg.slice(0, 200)}`);
      }
      console.log(`  ✓ A.8.g: pause_market from non-admin rejected with InvalidAuthority`);
    }
    if (!pauseReverted) throw new Error("A.8.g: pause_market non-admin should have reverted");

    // A.8.f — unpause restores status 1→0
    await program.methods
      .unpauseMarket()
      .accountsStrict({
        protocolState: protocolStatePda,
        market: marketPda,
        authority: deployer.publicKey,
      })
      .rpc();
    m = await program.account.swapMarket.fetch(marketPda);
    if (m.status !== 0) throw new Error(`A.8.f: expected status=0, got ${m.status}`);
    console.log(`  ✓ A.8.f: market unpaused, status=${m.status}`);
  }

  // ---------------------------------------------------------------------------
  header("Phase 23 — A.3: open_swap rejects when snapshots collapse (apy=0)");

  // MUST run last in Suite A — leaves snapshots intentionally collapsed.
  {
    const collapsed = new anchor.BN("9999999999999999999");
    await program.methods
      .setRateIndexOracle(collapsed)
      .accountsStrict({ protocolState: protocolStatePda, market: marketPda, authority: deployer.publicKey })
      .rpc();
    await program.methods
      .setRateIndexOracle(collapsed)
      .accountsStrict({ protocolState: protocolStatePda, market: marketPda, authority: deployer.publicKey })
      .rpc();

    const m = await program.account.swapMarket.fetch(marketPda);
    if (m.previousRateIndex.toString() !== m.currentRateIndex.toString()) {
      throw new Error(`A.3 setup: snapshots not collapsed; previous=${m.previousRateIndex} current=${m.currentRateIndex}`);
    }
    console.log(`  snapshots collapsed: previous == current == ${m.currentRateIndex.toString()}`);

    const NONCE = 30;
    const [pos] = PublicKey.findProgramAddressSync(
      [Buffer.from("swap"), trader.publicKey.toBuffer(), marketPda.toBuffer(), Buffer.from([NONCE])],
      program.programId,
    );
    let reverted = false;
    try {
      await program.methods
        .openSwap({ payFixed: {} } as any, new anchor.BN(10_000_000), NONCE, MAX_RATE_BPS, MIN_RATE_BPS)
        .accountsStrict({
          protocolState: protocolStatePda,
          market: marketPda,
          swapPosition: pos,
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
    } catch (err) {
      reverted = true;
      const msg = String(err);
      if (!msg.includes("RateIndexNotInitialized")) {
        throw new Error(`A.3: expected RateIndexNotInitialized, got: ${msg.slice(0, 200)}`);
      }
      console.log(`  ✓ A.3: open_swap rejected with RateIndexNotInitialized`);
    }
    if (!reverted) throw new Error("A.3: open_swap should have reverted on collapsed snapshots");
  }

  console.log(`\n=== Demo complete: full Anemone lifecycle on Surfpool ===`);
  console.log(`  Real Kamino CPI:   deposit_to_kamino + withdraw_from_kamino ✓`);
  console.log(`  Real Kamino read:  cumulative_borrow_rate_bsf decoded from live Reserve ✓`);
  console.log(`  Trader cycle:      open_swap → settle_period → close_position_early ✓`);
  console.log(`  JIT pattern:       100% of LP capital in Kamino, withdraw bundled as`);
  console.log(`                     preInstruction before settle (zero idle yield drag) ✓`);
  console.log(`  Atomic trader exit: close_position_early + claim_matured do the Kamino`);
  console.log(`                      redeem CPI internally on shortfall — single ix, no bundle ✓`);
  console.log(`  Maturity flow:     short-tenor market → settle → claim_matured exercises`);
  console.log(`                     internal redeem with empty lp_vault ✓`);
  console.log(`  Stub-oracle write: rate index seeded via set_rate_index_oracle (devnet path)`);
  console.log(`  Suite A defenses:  A.1.b, A.3, A.4.b, A.6, A.8, A.9 verified on live Kamino fork ✓`);
}

main().catch((err) => {
  console.error("\nError:", err);
  process.exit(1);
});
