#!/usr/bin/env ts-node
/**
 * End-to-end smoke test against the devnet deployment.
 *
 * Flow:
 *   1. Read deployments/devnet.json
 *   2. Refresh rate-index + NAV snapshot if stale (C3 + C2 on-chain gates)
 *   3. Make sure deployer has USDC — mint via the deployer-owned mint if not
 *   4. Open a PayFixed swap: 1000 USDC notional, 200 USDC collateral, nonce 0
 *      (deployer is already an LP from setup — acting here as trader too)
 *   5. Dump SwapPosition + Market state deltas so we can eyeball
 *
 * Settle is out of scope today because settlement_period_seconds = 86_400.
 * Liquidation is out of scope because we seeded enough collateral. Both get
 * exercised either next day (keeper cron runs settlement) or in a future
 * short-tenor test market.
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
  mintTo,
  getAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const DEPLOYER_KEYPAIR =
  process.env.DEPLOYER_KEYPAIR || path.join(os.homedir(), ".config/solana/id.json");

const NOTIONAL_USDC = 1000;
const COLLATERAL_USDC = 200;
const NONCE = 0;

// Slippage tolerance: PayFixed accepts fixed_rate_bps <= MAX, ReceiveFixed >= MIN.
// We set MAX very high so the test doesn't fail on spread/imbalance noise; in
// the real UI the user sets these based on their risk appetite.
const MAX_RATE_BPS = new anchor.BN(10_000); // 100% APY
const MIN_RATE_BPS = new anchor.BN(0);

const MAX_STALENESS_SECS = 500; // refresh if older than this (below the 600s on-chain cap)

function loadKeypair(filePath: string): Keypair {
  const bytes = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(bytes));
}

async function main() {
  const deployment = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../deployments/devnet.json"), "utf-8"),
  );

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

  const protocolStatePda = new PublicKey(deployment.protocolState);
  const marketPda = new PublicKey(deployment.market);
  const lpVaultPda = new PublicKey(deployment.lpVault);
  const collateralVaultPda = new PublicKey(deployment.collateralVault);
  const treasury = new PublicKey(deployment.treasury);
  const usdcMint = new PublicKey(deployment.usdcMint);

  console.log("\n=== Anemone devnet E2E test ===\n");

  // ----- freshness checks
  const nowSec = Math.floor(Date.now() / 1000);
  const marketBefore = await program.account.swapMarket.fetch(marketPda);
  const rateAge = nowSec - marketBefore.lastRateUpdateTs.toNumber();
  const navAge = nowSec - marketBefore.lastKaminoSyncTs.toNumber();
  console.log(`Rate index age: ${rateAge}s`);
  console.log(`NAV snapshot age: ${navAge}s`);

  if (navAge > MAX_STALENESS_SECS) {
    console.log("Refreshing NAV snapshot (sync_kamino_yield)...");
    const tx = await program.methods
      .syncKaminoYield()
      .accountsStrict({ market: marketPda })
      .rpc();
    console.log(`  tx: ${tx}`);
  }
  if (rateAge > MAX_STALENESS_SECS) {
    console.log("Refreshing rate index (set_rate_index_oracle)...");
    const bumpedRate = new anchor.BN(marketBefore.currentRateIndex.toString()).add(
      new anchor.BN("1000000000000"),
    );
    const tx = await program.methods
      .setRateIndexOracle(bumpedRate)
      .accountsStrict({
        protocolState: protocolStatePda,
        market: marketPda,
        authority: deployer.publicKey,
      })
      .rpc();
    console.log(`  tx: ${tx}`);
  }

  // ----- derive trader accounts
  const [swapPositionPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("swap"),
      deployer.publicKey.toBuffer(),
      marketPda.toBuffer(),
      Buffer.from([NONCE]),
    ],
    program.programId,
  );

  const existingPosition = await connection.getAccountInfo(swapPositionPda);
  if (existingPosition) {
    console.log(
      `\n!! SwapPosition for nonce=${NONCE} already exists at ${swapPositionPda.toBase58()}.`,
    );
    console.log(
      "   E2E test is one-shot per nonce — bump NONCE in the script to open a fresh position.",
    );
    const pos = await program.account.swapPosition.fetch(swapPositionPda);
    console.log(`   current state: status=${JSON.stringify(pos.status)}, collateral_remaining=${pos.collateralRemaining.toNumber() / 1e6} USDC, num_settlements=${pos.numSettlements}`);
    return;
  }

  // ----- make sure deployer has USDC (seed LP used 5000; mint extra for this swap)
  const deployerUsdcAta = await createAssociatedTokenAccountIdempotent(
    connection,
    deployer,
    usdcMint,
    deployer.publicKey,
  );
  const ataBefore = await getAccount(connection, deployerUsdcAta);
  const usdcBalance = Number(ataBefore.amount) / 1e6;
  console.log(`\nDeployer USDC balance: ${usdcBalance} USDC`);
  if (usdcBalance < COLLATERAL_USDC) {
    const needed = COLLATERAL_USDC * 1_000_000; // raw units
    console.log(`Minting ${COLLATERAL_USDC} USDC to deployer...`);
    await mintTo(
      connection,
      deployer,
      usdcMint,
      deployerUsdcAta,
      deployer.publicKey,
      needed,
    );
  }

  // ----- snapshot market + treasury + collateral_vault before
  const collateralVaultBefore = await getAccount(connection, collateralVaultPda);
  const treasuryBefore = await getAccount(connection, treasury);

  // ----- open_swap (PayFixed)
  console.log(`\n--- open_swap PayFixed`);
  console.log(`  notional:   ${NOTIONAL_USDC} USDC`);
  console.log(`  collateral: ${COLLATERAL_USDC} USDC`);
  console.log(`  nonce:      ${NONCE}`);
  console.log(`  max rate:   ${MAX_RATE_BPS.toString()} bps`);

  const tx = await program.methods
    .openSwap(
      { payFixed: {} } as any,
      new anchor.BN(NOTIONAL_USDC * 1_000_000),
      NONCE,
      MAX_RATE_BPS,
      MIN_RATE_BPS,
    )
    .accountsStrict({
      protocolState: protocolStatePda,
      market: marketPda,
      swapPosition: swapPositionPda,
      collateralVault: collateralVaultPda,
      treasury: treasury,
      underlyingMint: usdcMint,
      traderTokenAccount: deployerUsdcAta,
      trader: deployer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`  tx: ${tx}`);
  console.log(`  https://explorer.solana.com/tx/${tx}?cluster=devnet`);

  // ----- verify deltas
  const marketAfter = await program.account.swapMarket.fetch(marketPda);
  const position = await program.account.swapPosition.fetch(swapPositionPda);
  const collateralVaultAfter = await getAccount(connection, collateralVaultPda);
  const treasuryAfter = await getAccount(connection, treasury);

  const deltaCollateralVault =
    (Number(collateralVaultAfter.amount) - Number(collateralVaultBefore.amount)) / 1e6;
  const deltaTreasury =
    (Number(treasuryAfter.amount) - Number(treasuryBefore.amount)) / 1e6;
  const expectedMargin = position.collateralDeposited.toNumber() / 1e6;
  const protocolStateBefore = await program.account.protocolState.fetch(protocolStatePda);
  const expectedFee = (NOTIONAL_USDC * protocolStateBefore.openingFeeBps) / 10_000;

  console.log(`\n=== Post-open state ===`);
  console.log(`Market:`);
  console.log(`  total_fixed_notional:    ${marketAfter.totalFixedNotional.toNumber() / 1e6} USDC`);
  console.log(`  total_variable_notional: ${marketAfter.totalVariableNotional.toNumber() / 1e6} USDC`);
  console.log(`  total_open_positions:    ${marketAfter.totalOpenPositions.toNumber()}`);
  console.log(`Position (${swapPositionPda.toBase58()}):`);
  console.log(`  direction:              ${JSON.stringify(position.direction)}`);
  console.log(`  notional:               ${position.notional.toNumber() / 1e6} USDC`);
  console.log(`  fixed_rate_bps:         ${position.fixedRateBps.toNumber()} bps (${(position.fixedRateBps.toNumber() / 100).toFixed(2)}%)`);
  console.log(`  collateral_deposited:   ${expectedMargin} USDC  (initial margin, computed from notional × tenor × safety factor — ignores the 'collateral' you 'pass' to the script)`);
  console.log(`  collateral_remaining:   ${position.collateralRemaining.toNumber() / 1e6} USDC`);
  console.log(`  maturity_ts:            ${position.maturityTimestamp.toNumber()} (${new Date(position.maturityTimestamp.toNumber() * 1000).toISOString()})`);
  console.log(`  next_settlement_ts:     ${position.nextSettlementTs.toNumber()} (${new Date(position.nextSettlementTs.toNumber() * 1000).toISOString()})`);
  console.log(`Movements:`);
  console.log(`  collateral_vault +${deltaCollateralVault} USDC  (== initial margin)`);
  console.log(`  treasury net     ${deltaTreasury >= 0 ? '+' : ''}${deltaTreasury} USDC`);
  if (deployment.treasury === deployerUsdcAta.toBase58()) {
    console.log(`  (NOTE: devnet treasury is the deployer's own ATA, so 'treasury net' also`);
    console.log(`   includes the outflow that funded the collateral transfer. For a clean`);
    console.log(`   breakdown see the tx on Solana Explorer. In mainnet, treasury will be a`);
    console.log(`   separate token account owned by the protocol multisig.)`);
  }
  console.log(`  Expected opening fee: ${expectedFee} USDC (${protocolStateBefore.openingFeeBps} bps of notional, per protocol config)`);

  console.log(`\n=== E2E smoke test PASSED ===`);
  console.log(`Next steps:`);
  console.log(`  - keeper's settlement cron will try to settle this position when`);
  console.log(`    next_settlement_ts (${new Date(position.nextSettlementTs.toNumber() * 1000).toISOString()}) is reached`);
  console.log(`  - in the meantime the position is visible via getProgramAccounts`);
  console.log(`  - to close early, call close_position_early from the UI (coming in Fase 4)`);
}

main().catch((err) => {
  console.error("\nError:", err);
  process.exit(1);
});
