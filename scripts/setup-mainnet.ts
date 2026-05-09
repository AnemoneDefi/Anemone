#!/usr/bin/env ts-node
/**
 * Mainnet bootstrap. Initializes protocol, creates the v0.1 USDC/30d market
 * with real caps ($100k pool, $10k position) pointing to the LIVE Kamino
 * USDC reserve, sets a dedicated keeper keypair, and seeds the rate index
 * via 2 update_rate_index calls against real Kamino bsf.
 *
 * Idempotent — re-running skips anything that already exists on-chain.
 *
 *   yarn ts-node scripts/setup-mainnet.ts
 *
 * Env:
 *   RPC_URL              default https://api.mainnet-beta.solana.com
 *   DEPLOYER_KEYPAIR     default ~/.config/solana/id.json
 *   KEEPER_KEYPAIR       default ~/keys/anemone-mainnet-keeper.json
 *
 * Pre-flight:
 *   - Program already deployed (see solana program deploy)
 *   - Deployer wallet has ≥0.5 SOL for tx fees
 *   - Keeper keypair generated; passed as KEEPER_KEYPAIR
 *
 * Note: protocol_state.authority is set to the DEPLOYER pubkey here (not the
 * Squads vault). Migration to Squads requires a future `update_authority`
 * admin instruction. Upgrade authority of the program SHOULD be migrated
 * to Squads via `solana program set-upgrade-authority` before this script
 * runs — that's the v0.1 security boundary.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import { Anemone } from "../target/types/anemone";
import {
  PublicKey,
  Keypair,
  Connection,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotent,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ----- config
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const DEPLOYER_KEYPAIR =
  process.env.DEPLOYER_KEYPAIR || path.join(os.homedir(), ".config/solana/id.json");
const KEEPER_KEYPAIR =
  process.env.KEEPER_KEYPAIR || path.join(os.homedir(), "keys/anemone-mainnet-keeper.json");

// Live mainnet addresses
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const KAMINO_PROGRAM = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const KAMINO_USDC_RESERVE = new PublicKey(
  "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59",
);
const KAMINO_USDC_LENDING_MARKET = new PublicKey(
  "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
);
const SCOPE_PRICES = new PublicKey(
  "3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH",
);

// Protocol fees (bps)
const PROTOCOL_FEE_BPS = 1000; // 10%
const OPENING_FEE_BPS = 5; // 0.05%
const LIQUIDATION_FEE_BPS = 300; // 3%
const WITHDRAWAL_FEE_BPS = 5; // 0.05%
const EARLY_CLOSE_FEE_BPS = 500; // 5%

// Market params
const TENOR_SECONDS = new anchor.BN(2_592_000); // 30 days
const SETTLEMENT_PERIOD_SECONDS = new anchor.BN(86_400); // 1 day
const MAX_UTILIZATION_BPS = 6000; // 60%
const BASE_SPREAD_BPS = 80; // 0.8%

// v0.1 caps
const MAX_LP_NAV = new anchor.BN("100000000000"); // $100,000 USDC
const MAX_POSITION_NOTIONAL = new anchor.BN("10000000000"); // $10,000 USDC

// Rate-index seeding delay between calls (must clear MIN_RATE_UPDATE_ELAPSED_SECS=8)
const RATE_DELAY_MS = 12_000;

// Anchor discriminator for Kamino refresh_reserve
const REFRESH_RESERVE_DISCRIMINATOR = Buffer.from([
  2, 218, 138, 235, 79, 201, 25, 102,
]);

function loadKeypair(filePath: string): Keypair {
  const bytes = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(bytes));
}

function buildRefreshReserveIx(): TransactionInstruction {
  return new TransactionInstruction({
    programId: KAMINO_PROGRAM,
    keys: [
      { pubkey: KAMINO_USDC_RESERVE, isSigner: false, isWritable: true },
      { pubkey: KAMINO_USDC_LENDING_MARKET, isSigner: false, isWritable: false },
      { pubkey: KAMINO_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: KAMINO_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: KAMINO_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SCOPE_PRICES, isSigner: false, isWritable: false },
    ],
    data: REFRESH_RESERVE_DISCRIMINATOR,
  });
}

async function main() {
  console.log("\n=== Anemone MAINNET setup ===\n");
  console.log("⚠ THIS WRITES TO MAINNET. CHECK ALL ADDRESSES BEFORE PROCEEDING.\n");

  const deployer = loadKeypair(DEPLOYER_KEYPAIR);

  if (!fs.existsSync(KEEPER_KEYPAIR)) {
    throw new Error(
      `Keeper keypair not found at ${KEEPER_KEYPAIR}. Generate one first:\n` +
        `  solana-keygen new -o ${KEEPER_KEYPAIR} --no-bip39-passphrase`,
    );
  }
  const keeper = loadKeypair(KEEPER_KEYPAIR);

  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = new Wallet(deployer);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../target/idl/anemone.json"), "utf-8"),
  );
  const program = new Program<Anemone>(idl, provider);

  console.log(`RPC:                ${RPC_URL}`);
  console.log(`Program:            ${program.programId.toBase58()}`);
  console.log(`Deployer:           ${deployer.publicKey.toBase58()}`);
  console.log(`Keeper:             ${keeper.publicKey.toBase58()}`);
  console.log(`USDC mint:          ${USDC_MINT.toBase58()}`);
  console.log(`Kamino reserve:     ${KAMINO_USDC_RESERVE.toBase58()}`);
  console.log(`Tenor:              ${TENOR_SECONDS.toString()}s (30d)`);
  console.log(`Settlement period:  ${SETTLEMENT_PERIOD_SECONDS.toString()}s (1d)`);
  console.log(`max_lp_nav:         $${(Number(MAX_LP_NAV) / 1e6).toLocaleString()} USDC`);
  console.log(`max_position:       $${(Number(MAX_POSITION_NOTIONAL) / 1e6).toLocaleString()} USDC`);
  console.log("");

  const deployerSol = await connection.getBalance(deployer.publicKey);
  if (deployerSol < 0.5e9) {
    throw new Error(
      `Deployer has only ${(deployerSol / 1e9).toFixed(3)} SOL — needs ≥0.5 SOL for tx fees`,
    );
  }
  console.log(`Deployer balance: ${(deployerSol / 1e9).toFixed(3)} SOL\n`);

  // ----- derive PDAs
  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    program.programId,
  );
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

  console.log(`Protocol PDA:       ${protocolStatePda.toBase58()}`);
  console.log(`Market PDA:         ${marketPda.toBase58()}`);
  console.log(`LP vault:           ${lpVaultPda.toBase58()}`);
  console.log(`Collateral vault:   ${collateralVaultPda.toBase58()}`);
  console.log(`LP mint:            ${lpMintPda.toBase58()}`);
  console.log(`Kamino deposit:     ${kaminoDepositPda.toBase58()}\n`);

  // Resolve real Kamino accounts from on-chain reserve
  const reserveAcc = await connection.getAccountInfo(KAMINO_USDC_RESERVE);
  if (!reserveAcc) throw new Error("Kamino USDC reserve not found on this RPC");
  const { Reserve } = await import(
    "@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/Reserve.js"
  );
  const reserveStruct = Reserve.decode(reserveAcc.data);
  const reserveCollateralMint = new PublicKey(
    (reserveStruct.collateral as any).mintPubkey.toString(),
  );
  console.log(`k-USDC mint (from reserve): ${reserveCollateralMint.toBase58()}\n`);

  // ----- treasury ATA (deployer-owned for v0.1; migrate to Squads pos-hackathon)
  const treasuryAta = await createAssociatedTokenAccountIdempotent(
    connection,
    deployer,
    USDC_MINT,
    deployer.publicKey,
  );
  console.log(`Treasury ATA: ${treasuryAta.toBase58()}\n`);

  // ----- initialize_protocol
  const protocolExists = await connection.getAccountInfo(protocolStatePda);
  if (protocolExists) {
    console.log(`--- initialize_protocol: already exists, skipping`);
  } else {
    console.log(`--- initialize_protocol`);
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
        treasury: treasuryAta,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`  tx: ${tx}\n`);
  }

  // ----- set_keeper
  const protocolStateAcc = await program.account.protocolState.fetch(protocolStatePda);
  if (protocolStateAcc.keeperAuthority?.equals(keeper.publicKey)) {
    console.log(`--- set_keeper: already set to ${keeper.publicKey.toBase58()}, skipping`);
  } else {
    console.log(`--- set_keeper(${keeper.publicKey.toBase58()})`);
    const tx = await program.methods
      .setKeeper(keeper.publicKey)
      .accountsStrict({
        protocolState: protocolStatePda,
        authority: deployer.publicKey,
      })
      .rpc();
    console.log(`  tx: ${tx}\n`);
  }

  // ----- create_market
  const marketExists = await connection.getAccountInfo(marketPda);
  if (marketExists) {
    console.log(`--- create_market: already exists, skipping`);
  } else {
    console.log(`--- create_market (caps: $100k pool, $10k position)`);
    const tx = await program.methods
      .createMarket(
        TENOR_SECONDS,
        SETTLEMENT_PERIOD_SECONDS,
        MAX_UTILIZATION_BPS,
        BASE_SPREAD_BPS,
        MAX_LP_NAV,
        MAX_POSITION_NOTIONAL,
      )
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
    console.log(`  tx: ${tx}\n`);
  }

  // ----- seed rate_index (2 calls against real Kamino to populate previous + current)
  const market = await program.account.swapMarket.fetch(marketPda);
  if (
    market.previousRateIndex.toString() !== "0" &&
    market.currentRateIndex.toString() !== "0"
  ) {
    console.log(`--- rate_index: already seeded, skipping`);
    console.log(`  previous: ${market.previousRateIndex.toString()}`);
    console.log(`  current:  ${market.currentRateIndex.toString()}`);
  } else {
    console.log(`--- update_rate_index (1st call, seeds current)`);
    const tx1 = await program.methods
      .updateRateIndex()
      .accountsStrict({
        protocolState: protocolStatePda,
        market: marketPda,
        kaminoReserve: KAMINO_USDC_RESERVE,
        keeper: keeper.publicKey,
      })
      .preInstructions([buildRefreshReserveIx()])
      .signers([keeper])
      .rpc();
    console.log(`  tx: ${tx1}`);

    console.log(`\n  waiting ${RATE_DELAY_MS / 1000}s for temporal distinction...`);
    await new Promise((r) => setTimeout(r, RATE_DELAY_MS));

    console.log(`\n--- update_rate_index (2nd call, rotates previous + sets new current)`);
    const tx2 = await program.methods
      .updateRateIndex()
      .accountsStrict({
        protocolState: protocolStatePda,
        market: marketPda,
        kaminoReserve: KAMINO_USDC_RESERVE,
        keeper: keeper.publicKey,
      })
      .preInstructions([buildRefreshReserveIx()])
      .signers([keeper])
      .rpc();
    console.log(`  tx: ${tx2}`);

    const m2 = await program.account.swapMarket.fetch(marketPda);
    console.log(`\n  previous_rate_index: ${m2.previousRateIndex.toString()}`);
    console.log(`  current_rate_index:  ${m2.currentRateIndex.toString()}`);
    console.log(
      `  delta:               ${(BigInt(m2.currentRateIndex.toString()) - BigInt(m2.previousRateIndex.toString())).toString()}`,
    );
  }

  console.log(`\n=== Mainnet bootstrap COMPLETE ===\n`);
  console.log(`Save for the frontend env vars:`);
  console.log(`  NEXT_PUBLIC_PROGRAM_ID=${program.programId.toBase58()}`);
  console.log(`  NEXT_PUBLIC_MARKET=${marketPda.toBase58()}`);
  console.log(`  NEXT_PUBLIC_LP_MINT=${lpMintPda.toBase58()}`);
  console.log(``);
  console.log(`Save for the keeper bot env:`);
  console.log(`  PROGRAM_ID=${program.programId.toBase58()}`);
  console.log(`  MARKET_PDA=${marketPda.toBase58()}`);
  console.log(`  KAMINO_RESERVE=${KAMINO_USDC_RESERVE.toBase58()}`);
  console.log(``);
  console.log(`Next: deposit $1000 LP via the frontend to bootstrap pool.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
