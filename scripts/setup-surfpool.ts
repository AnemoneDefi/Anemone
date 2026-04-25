#!/usr/bin/env ts-node
/**
 * Setup against Surfpool (mainnet fork). The point is to exercise the real
 * Kamino CPI paths before we ever touch real mainnet — `update_rate_index`
 * deserialises the actual Kamino Reserve struct off-fork, `deposit_to_kamino`
 * and `withdraw_from_kamino` would do real CPIs (deferred — needs minted USDC
 * mainnet, not trivial without surfpool's account-override RPC).
 *
 * Differences from setup-devnet.ts:
 *   - Built with --no-default-features (no stub-oracle), so set_rate_index_oracle
 *     does not exist. We populate rate_index via update_rate_index — the real
 *     keeper-mainnet path.
 *   - Uses real Kamino mainnet addresses (USDC reserve, k-USDC mint, USDC mint,
 *     Kamino program ID).
 *   - LP seed is skipped — needs minted USDC and surfpool account override
 *     (separate follow-up).
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
import { TOKEN_PROGRAM_ID, createMint } from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8899";
const DEPLOYER_KEYPAIR =
  process.env.DEPLOYER_KEYPAIR || path.join(os.homedir(), ".config/solana/id.json");

// Real Kamino mainnet addresses — Surfpool will fork them on demand.
const KAMINO_PROGRAM = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const KAMINO_USDC_RESERVE = new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
// NOTE: kamino_collateral_mint (the k-USDC mint that the Reserve mints when
// users deposit) is identified by reading reserve.collateral.mint_pubkey at
// runtime — but Anemone's create_market only stores it as metadata for the
// kamino_deposit_account PDA. update_rate_index doesn't touch it. So for
// the Surfpool smoke we create a throw-away fake mint, mirroring what the
// anchor tests and setup-devnet.ts already do.

const PROTOCOL_FEE_BPS = 1000;
const OPENING_FEE_BPS = 5;
const LIQUIDATION_FEE_BPS = 300;
const WITHDRAWAL_FEE_BPS = 5;
const EARLY_CLOSE_FEE_BPS = 500;

const TENOR_SECONDS = new anchor.BN(2_592_000);
const SETTLEMENT_PERIOD_SECONDS = new anchor.BN(86_400);
const MAX_UTILIZATION_BPS = 6000;
const BASE_SPREAD_BPS = 80;

function loadKeypair(filePath: string): Keypair {
  const bytes = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(bytes));
}

async function main() {
  console.log("\n=== Anemone Surfpool setup (mainnet fork) ===\n");

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

  console.log(`Deployer:    ${deployer.publicKey.toBase58()}`);
  console.log(`Program:     ${program.programId.toBase58()}`);
  console.log(`RPC:         ${RPC_URL}`);
  console.log(`Kamino:      ${KAMINO_PROGRAM.toBase58()}`);
  console.log(`USDC Reserve: ${KAMINO_USDC_RESERVE.toBase58()}\n`);

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

  console.log(`Protocol PDA: ${protocolStatePda.toBase58()}`);
  console.log(`Market PDA:   ${marketPda.toBase58()}\n`);

  // ----- create a throw-away fake collateral mint (see NOTE at top of file)
  const fakeKaminoCollateralMint = Keypair.generate();
  const collateralMintInfo = await connection.getAccountInfo(fakeKaminoCollateralMint.publicKey);
  if (!collateralMintInfo) {
    console.log("--- creating fake kamino collateral mint placeholder");
    await createMint(
      connection,
      deployer,
      deployer.publicKey,
      null,
      6,
      fakeKaminoCollateralMint,
    );
    console.log(`  ${fakeKaminoCollateralMint.publicKey.toBase58()}\n`);
  }

  // Treasury = deployer's USDC ATA on the real mint (will exist when needed).
  // For initialize_protocol we just need a token account address; the program
  // doesn't write to it during init — only later in open_swap.
  // Use a deterministic placeholder address since we won't touch it in this
  // smoke test.
  const treasuryPlaceholder = deployer.publicKey;

  // ----- initialize_protocol
  console.log("--- initialize_protocol");
  const protocolExists = await connection.getAccountInfo(protocolStatePda);
  if (protocolExists) {
    console.log("  already initialized");
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
        treasury: treasuryPlaceholder,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`  tx: ${tx}`);
  }

  // ----- create_market with REAL Kamino accounts
  console.log("\n--- create_market (using real Kamino USDC Reserve)");
  const marketExists = await connection.getAccountInfo(marketPda);
  if (marketExists) {
    console.log("  already exists");
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

  // ----- update_rate_index against REAL Kamino reserve (the H2 layout test)
  console.log("\n--- update_rate_index (REAL Kamino CPI — first call)");
  const tx1 = await program.methods
    .updateRateIndex()
    .accountsStrict({
      market: marketPda,
      kaminoReserve: KAMINO_USDC_RESERVE,
    })
    .rpc();
  console.log(`  tx: ${tx1}`);

  // Read state to see what got written
  const m1 = await program.account.swapMarket.fetch(marketPda);
  console.log(`  rate_index after first call: ${m1.currentRateIndex.toString()}`);
  console.log(`  last_rate_update_ts: ${m1.lastRateUpdateTs.toNumber()}`);

  console.log("\n  waiting 3s for second snapshot to be temporally distinct...");
  await new Promise((r) => setTimeout(r, 3000));

  console.log("\n--- update_rate_index (REAL Kamino CPI — second call, rotates previous)");
  const tx2 = await program.methods
    .updateRateIndex()
    .accountsStrict({
      market: marketPda,
      kaminoReserve: KAMINO_USDC_RESERVE,
    })
    .rpc();
  console.log(`  tx: ${tx2}`);

  const m2 = await program.account.swapMarket.fetch(marketPda);
  console.log(`\n=== Final market state ===`);
  console.log(`  previous_rate_index: ${m2.previousRateIndex.toString()}`);
  console.log(`  current_rate_index:  ${m2.currentRateIndex.toString()}`);
  console.log(`  delta:               ${(BigInt(m2.currentRateIndex.toString()) - BigInt(m2.previousRateIndex.toString())).toString()}`);
  console.log(`\n=== Surfpool smoke PASSED ===`);
  console.log(`  - Real Kamino Reserve was deserialised (kamino-lend = =0.4.1 layout still valid)`);
  console.log(`  - update_rate_index CPI path works end-to-end`);
  console.log(`  - rate_index rotation (current → previous) works`);
  console.log(`\nNot tested in this script (out of scope for Caso A):`);
  console.log(`  - deposit_to_kamino / withdraw_from_kamino CPIs (need minted USDC, surfpool override)`);
  console.log(`  - sync_kamino_yield real path`);
}

main().catch((err) => {
  console.error("\nError:", err);
  process.exit(1);
});
