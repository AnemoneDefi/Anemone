#!/usr/bin/env ts-node
/**
 * Devnet bootstrap. Creates the USDC test mint, initialises the
 * protocol, sets the keeper, creates the single market, seeds LP
 * liquidity, and populates the rate-index oracle so `open_swap`
 * can price trades immediately.
 *
 * Idempotent: re-running after initial setup skips steps whose
 * on-chain accounts already exist.
 *
 * Usage:
 *   yarn ts-node scripts/setup-devnet.ts
 *
 * Env overrides:
 *   RPC_URL              default https://api.devnet.solana.com
 *   DEPLOYER_KEYPAIR     default ~/.config/solana/id.json
 *   KEEPER_KEYPAIR       default ~/.config/solana/anemone-keeper.json
 *   UPGRADE_AUTHORITY    default 4AGLdo...NiXf (our devnet Squad vault)
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Anemone } from "../target/types/anemone";
import {
  PublicKey,
  Keypair,
  Connection,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotent,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ----- config
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const DEPLOYER_KEYPAIR =
  process.env.DEPLOYER_KEYPAIR || path.join(os.homedir(), ".config/solana/id.json");
const KEEPER_KEYPAIR =
  process.env.KEEPER_KEYPAIR || path.join(os.homedir(), ".config/solana/anemone-keeper.json");
const UPGRADE_AUTHORITY =
  process.env.UPGRADE_AUTHORITY || "4AGLdo9MUsGpMrQxuYTrNJnLW4Yqn73Zvk6EGVJFNiXf";

const PROTOCOL_FEE_BPS = 1000; // 10%
const OPENING_FEE_BPS = 5; // 0.05%
const LIQUIDATION_FEE_BPS = 300; // 3%
const WITHDRAWAL_FEE_BPS = 5; // 0.05%
const EARLY_CLOSE_FEE_BPS = 500; // 5%

const TENOR_SECONDS = new anchor.BN(2_592_000); // 30 days
const SETTLEMENT_PERIOD_SECONDS = new anchor.BN(86_400); // 1 day
const MAX_UTILIZATION_BPS = 6000; // 60%
const BASE_SPREAD_BPS = 80; // 0.8%

const SEED_USDC_AMOUNT = 5_000_000_000; // 5000 USDC (6 decimals)

// Rate-index seed values (1e18 and 1e18 * 1.005 — gives APY calc a nonzero delta).
const INITIAL_RATE_INDEX = new anchor.BN("1000000000000000000");
const NEXT_RATE_INDEX = new anchor.BN("1005000000000000000");
const RATE_DELAY_MS = 30_000;

// The reserve/mint/collateral-mint accounts referenced by `create_market`.
// On devnet we don't have a real Kamino reserve, so we generate placeholder
// pubkeys that only need to exist at PDA-derivation time. The on-chain code
// reads them as identifiers, never deserialises them (stub-oracle path).
// Using fixed seeds in a local file under scripts/ keeps these stable across
// reruns — regenerating them would orphan previously-deposited LP positions.
const PLACEHOLDER_KEYPAIRS_PATH = path.join(__dirname, "devnet-placeholder-keypairs.json");

function loadKeypair(filePath: string): Keypair {
  const bytes = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(bytes));
}

function loadOrCreatePlaceholders(): {
  fakeReserve: Keypair;
  fakeUnderlyingProtocol: Keypair;
  fakeKaminoCollateralMint: Keypair;
  underlyingMint: Keypair;
} {
  if (fs.existsSync(PLACEHOLDER_KEYPAIRS_PATH)) {
    const raw = JSON.parse(fs.readFileSync(PLACEHOLDER_KEYPAIRS_PATH, "utf-8"));
    return {
      fakeReserve: Keypair.fromSecretKey(new Uint8Array(raw.fakeReserve)),
      fakeUnderlyingProtocol: Keypair.fromSecretKey(new Uint8Array(raw.fakeUnderlyingProtocol)),
      fakeKaminoCollateralMint: Keypair.fromSecretKey(new Uint8Array(raw.fakeKaminoCollateralMint)),
      underlyingMint: Keypair.fromSecretKey(new Uint8Array(raw.underlyingMint)),
    };
  }
  const generated = {
    fakeReserve: Keypair.generate(),
    fakeUnderlyingProtocol: Keypair.generate(),
    fakeKaminoCollateralMint: Keypair.generate(),
    underlyingMint: Keypair.generate(),
  };
  fs.writeFileSync(
    PLACEHOLDER_KEYPAIRS_PATH,
    JSON.stringify(
      {
        fakeReserve: Array.from(generated.fakeReserve.secretKey),
        fakeUnderlyingProtocol: Array.from(generated.fakeUnderlyingProtocol.secretKey),
        fakeKaminoCollateralMint: Array.from(generated.fakeKaminoCollateralMint.secretKey),
        underlyingMint: Array.from(generated.underlyingMint.secretKey),
      },
      null,
      2,
    ),
  );
  return generated;
}

async function main() {
  console.log("\n=== Anemone devnet setup ===\n");

  const deployer = loadKeypair(DEPLOYER_KEYPAIR);
  const keeper = loadKeypair(KEEPER_KEYPAIR);

  console.log(`Deployer:          ${deployer.publicKey.toBase58()}`);
  console.log(`Keeper:            ${keeper.publicKey.toBase58()}`);
  console.log(`Upgrade authority: ${UPGRADE_AUTHORITY}`);
  console.log(`RPC:               ${RPC_URL}\n`);

  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = new Wallet(deployer);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../target/idl/anemone.json"), "utf-8"),
  );
  const program = new Program<Anemone>(idl, provider);
  console.log(`Program:           ${program.programId.toBase58()}\n`);

  const placeholders = loadOrCreatePlaceholders();
  const { fakeReserve, fakeUnderlyingProtocol, fakeKaminoCollateralMint, underlyingMint } =
    placeholders;

  // ----- derive PDAs
  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    program.programId,
  );
  const [marketPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("market"),
      fakeReserve.publicKey.toBuffer(),
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
  const [lpPositionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp"), deployer.publicKey.toBuffer(), marketPda.toBuffer()],
    program.programId,
  );

  console.log(`Protocol PDA: ${protocolStatePda.toBase58()}`);
  console.log(`Market PDA:   ${marketPda.toBase58()}\n`);

  // ----- step 1: USDC mint
  console.log("--- USDC devnet mint");
  const usdcMintInfo = await connection.getAccountInfo(underlyingMint.publicKey);
  if (usdcMintInfo) {
    console.log(`  already exists at ${underlyingMint.publicKey.toBase58()}`);
  } else {
    await createMint(
      connection,
      deployer,
      deployer.publicKey,
      null,
      6,
      underlyingMint,
    );
    console.log(`  created ${underlyingMint.publicKey.toBase58()}`);
  }
  const usdcMint = underlyingMint.publicKey;

  // ----- step 2: fake kamino collateral mint (create_market requires one even in stub)
  console.log("\n--- fake kamino collateral mint");
  const kaminoMintInfo = await connection.getAccountInfo(fakeKaminoCollateralMint.publicKey);
  if (kaminoMintInfo) {
    console.log(`  already exists at ${fakeKaminoCollateralMint.publicKey.toBase58()}`);
  } else {
    await createMint(
      connection,
      deployer,
      deployer.publicKey,
      null,
      6,
      fakeKaminoCollateralMint,
    );
    console.log(`  created ${fakeKaminoCollateralMint.publicKey.toBase58()}`);
  }

  // ----- step 3: treasury token account
  console.log("\n--- treasury USDC account (ATA of deployer)");
  const treasuryTokenAccount = await createAssociatedTokenAccountIdempotent(
    connection,
    deployer,
    usdcMint,
    deployer.publicKey,
  );
  console.log(`  ${treasuryTokenAccount.toBase58()}`);

  // ----- step 4: initialize_protocol
  console.log("\n--- initialize_protocol");
  const protocolExists = await connection.getAccountInfo(protocolStatePda);
  if (protocolExists) {
    console.log(`  already initialized`);
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
        treasury: treasuryTokenAccount,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`  tx: ${tx}`);
  }

  // ----- step 5: set_keeper
  console.log("\n--- set_keeper");
  const currentState = await program.account.protocolState.fetch(protocolStatePda);
  if (currentState.keeperAuthority.toBase58() === keeper.publicKey.toBase58()) {
    console.log(`  keeper already set to ${keeper.publicKey.toBase58()}`);
  } else {
    const tx = await program.methods
      .setKeeper(keeper.publicKey)
      .accountsStrict({
        protocolState: protocolStatePda,
        authority: deployer.publicKey,
      })
      .rpc();
    console.log(`  tx: ${tx}`);
  }

  // ----- step 6: create_market
  console.log("\n--- create_market");
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
        kaminoCollateralMint: fakeKaminoCollateralMint.publicKey,
        underlyingReserve: fakeReserve.publicKey,
        underlyingProtocol: fakeUnderlyingProtocol.publicKey,
        underlyingMint: usdcMint,
        authority: deployer.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    console.log(`  tx: ${tx}`);
  }

  // ----- step 7: sync_kamino_yield (stub — bumps last_kamino_sync_ts so LP handlers pass staleness gate)
  console.log("\n--- sync_kamino_yield (stub)");
  const tx7 = await program.methods
    .syncKaminoYield()
    .accountsStrict({ market: marketPda })
    .rpc();
  console.log(`  tx: ${tx7}`);

  // ----- step 8: seed LP deposit (5000 USDC)
  console.log("\n--- seed LP deposit (5000 USDC)");
  const marketStateBefore = await program.account.swapMarket.fetch(marketPda);
  if (marketStateBefore.lpNav.toNumber() > 0) {
    console.log(`  LP vault already has ${marketStateBefore.lpNav.toNumber() / 1e6} USDC, skipping seed`);
  } else {
    // deployer needs a USDC ATA with 5000 USDC minted
    const deployerUsdcAta = await createAssociatedTokenAccountIdempotent(
      connection,
      deployer,
      usdcMint,
      deployer.publicKey,
    );
    // Mint 5000 USDC to the deployer (treasury ATA already exists; this is separate)
    await mintTo(
      connection,
      deployer,
      usdcMint,
      deployerUsdcAta,
      deployer.publicKey,
      SEED_USDC_AMOUNT,
    );
    const deployerLpAta = await createAssociatedTokenAccountIdempotent(
      connection,
      deployer,
      lpMintPda,
      deployer.publicKey,
    );
    const tx = await program.methods
      .depositLiquidity(new anchor.BN(SEED_USDC_AMOUNT))
      .accountsStrict({
        protocolState: protocolStatePda,
        market: marketPda,
        lpPosition: lpPositionPda,
        lpVault: lpVaultPda,
        lpMint: lpMintPda,
        underlyingMint: usdcMint,
        depositorTokenAccount: deployerUsdcAta,
        depositorLpTokenAccount: deployerLpAta,
        depositor: deployer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`  tx: ${tx}`);
  }

  // ----- step 9: set_rate_index_oracle x2 (populates prev + current)
  console.log("\n--- set_rate_index_oracle (first)");
  const marketStateRate = await program.account.swapMarket.fetch(marketPda);
  if (marketStateRate.previousRateIndex.toString() !== "0" && marketStateRate.currentRateIndex.toString() !== "0") {
    console.log(`  already populated (prev=${marketStateRate.previousRateIndex.toString()}, curr=${marketStateRate.currentRateIndex.toString()}), skipping`);
  } else {
    const tx9a = await program.methods
      .setRateIndexOracle(INITIAL_RATE_INDEX)
      .accountsStrict({
        protocolState: protocolStatePda,
        market: marketPda,
        authority: deployer.publicKey,
      })
      .rpc();
    console.log(`  tx: ${tx9a}`);

    console.log(`  waiting ${RATE_DELAY_MS / 1000}s for separation...`);
    await new Promise((r) => setTimeout(r, RATE_DELAY_MS));

    console.log("\n--- set_rate_index_oracle (second, +0.5%)");
    const tx9b = await program.methods
      .setRateIndexOracle(NEXT_RATE_INDEX)
      .accountsStrict({
        protocolState: protocolStatePda,
        market: marketPda,
        authority: deployer.publicKey,
      })
      .rpc();
    console.log(`  tx: ${tx9b}`);
  }

  // ----- step 10: dump deployments/devnet.json
  const deploymentsDir = path.join(__dirname, "../deployments");
  fs.mkdirSync(deploymentsDir, { recursive: true });
  const deploymentsPath = path.join(deploymentsDir, "devnet.json");

  const deployment = {
    cluster: "devnet",
    programId: program.programId.toBase58(),
    upgradeAuthority: UPGRADE_AUTHORITY,
    protocolState: protocolStatePda.toBase58(),
    market: marketPda.toBase58(),
    usdcMint: usdcMint.toBase58(),
    lpVault: lpVaultPda.toBase58(),
    collateralVault: collateralVaultPda.toBase58(),
    lpMint: lpMintPda.toBase58(),
    kaminoDepositAccount: kaminoDepositPda.toBase58(),
    fakeKaminoCollateralMint: fakeKaminoCollateralMint.publicKey.toBase58(),
    fakeUnderlyingReserve: fakeReserve.publicKey.toBase58(),
    fakeUnderlyingProtocol: fakeUnderlyingProtocol.publicKey.toBase58(),
    treasury: treasuryTokenAccount.toBase58(),
    keeper: keeper.publicKey.toBase58(),
    deployer: deployer.publicKey.toBase58(),
    tenorSeconds: TENOR_SECONDS.toNumber(),
    settlementPeriodSeconds: SETTLEMENT_PERIOD_SECONDS.toNumber(),
    maxUtilizationBps: MAX_UTILIZATION_BPS,
    baseSpreadBps: BASE_SPREAD_BPS,
    deployedAt: new Date().toISOString(),
  };

  fs.writeFileSync(deploymentsPath, JSON.stringify(deployment, null, 2));
  console.log(`\n=== Setup complete. Deployment written to ${deploymentsPath} ===`);
  console.log(JSON.stringify(deployment, null, 2));
}

main().catch((err) => {
  console.error("\nError:", err);
  process.exit(1);
});
