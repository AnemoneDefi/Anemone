/**
 * Negative tests — verifies the program REJECTS invalid operations with
 * the correct error codes. Each test asserts an instruction fails with
 * the expected AnemoneError variant.
 *
 * Test cases:
 *   1. open_swap with notional above max_utilization → UtilizationExceeded
 *   2. settle_period before next_settlement_ts → SettlementNotDue
 *   3. claim_matured on Open (not Matured) position → PositionNotMatured
 *   4. liquidate_position on a fresh healthy position → AboveMaintenanceMargin
 *
 * Tests are ordered so destructive ones (liquidate, which closes the account)
 * come last. Each test reads the freshest open position from chain state.
 *
 * Run: yarn ts-node scripts/simulate-rejections.ts
 */
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { AnchorProvider, Program, Wallet, BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { readFileSync } from "fs";
import os from "os";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const PROGRAM_ID = new PublicKey("KQs6ci5FtedFKPVJThAZSMMXyosK4TvnF7kcDSx5Jwd");
const KAMINO_PROGRAM = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const KAMINO_LENDING_MARKET = new PublicKey(
  "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"
);
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

let passed = 0;
let failed = 0;

async function expectError(name: string, expectedCode: string, fn: () => Promise<any>) {
  process.stdout.write(`  [${name}] expecting error "${expectedCode}"... `);
  try {
    await fn();
    console.log(`FAIL — instruction succeeded but should have rejected`);
    failed++;
  } catch (e: any) {
    const msg = e.message ?? String(e);
    if (msg.includes(expectedCode)) {
      console.log(`PASS`);
      passed++;
    } else {
      console.log(`FAIL — got error "${(msg.match(/Error Code: (\w+)/) ?? [, "unknown"])[1]}" instead of "${expectedCode}"`);
      console.log(`         full: ${msg.slice(0, 200)}`);
      failed++;
    }
  }
}

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const idl = JSON.parse(readFileSync("target/idl/anemone.json", "utf-8"));
  const trader = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(readFileSync(os.homedir() + "/.config/solana/id.json", "utf-8")))
  );
  const provider = new AnchorProvider(conn, new Wallet(trader), { commitment: "confirmed" });
  const program = new Program(idl, provider) as any;

  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    PROGRAM_ID
  );
  const proto = await program.account.protocolState.fetch(protocolStatePda);
  const markets = await program.account.swapMarket.all();
  const market0 = markets[0];
  const marketPda = market0.publicKey;
  const traderAta = getAssociatedTokenAddressSync(USDC, trader.publicKey);

  const reserve = market0.account.underlyingReserve;
  const reserveData = (await conn.getAccountInfo(reserve))!;
  const { Reserve } = await import(
    "@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/Reserve.js"
  );
  const reserveStruct = Reserve.decode(reserveData.data);
  const reserveLiquiditySupply = new PublicKey(
    (reserveStruct.liquidity as any).supplyVault.toString()
  );
  const reserveCollateralMint = new PublicKey(
    (reserveStruct.collateral as any).mintPubkey.toString()
  );
  const [kaminoLendingMarketAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("lma"), KAMINO_LENDING_MARKET.toBuffer()],
    KAMINO_PROGRAM
  );

  console.log(`Running rejection tests against market ${marketPda.toBase58()}\n`);

  // ---- Test 1: open_swap with notional above max_utilization
  // lp_nav × max_util_bps / 10000 is the cap. Try 10x bigger.
  const lpNav = BigInt(market0.account.lpNav.toString());
  const oversize = lpNav * 2n;
  const nonce1 = Math.floor(Math.random() * 254) + 1;
  const [swap1] = PublicKey.findProgramAddressSync(
    [Buffer.from("swap"), trader.publicKey.toBuffer(), marketPda.toBuffer(), Buffer.from([nonce1])],
    PROGRAM_ID
  );
  await expectError(
    "1) open_swap notional > max_util",
    "UtilizationExceeded",
    () => program.methods
      .openSwap({ payFixed: {} }, new BN(oversize.toString()), nonce1, new BN("18446744073709551615"), new BN(0))
      .accountsStrict({
        protocolState: protocolStatePda,
        market: marketPda,
        swapPosition: swap1,
        collateralVault: market0.account.collateralVault,
        treasury: proto.treasury,
        underlyingMint: USDC,
        traderTokenAccount: traderAta,
        trader: trader.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc()
  );

  // ---- Open a FRESH position owned by trader so tests 2-4 have a clean target
  const freshNonce = Math.floor(Math.random() * 254) + 1;
  const [freshSwap] = PublicKey.findProgramAddressSync(
    [Buffer.from("swap"), trader.publicKey.toBuffer(), marketPda.toBuffer(), Buffer.from([freshNonce])],
    PROGRAM_ID
  );
  console.log(`\n  [setup] open fresh PayFixed $50 nonce=${freshNonce}`);
  await program.methods
    .openSwap({ payFixed: {} }, new BN("50000000"), freshNonce, new BN("18446744073709551615"), new BN(0))
    .accountsStrict({
      protocolState: protocolStatePda,
      market: marketPda,
      swapPosition: freshSwap,
      collateralVault: market0.account.collateralVault,
      treasury: proto.treasury,
      underlyingMint: USDC,
      traderTokenAccount: traderAta,
      trader: trader.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  const [kaminoDepositAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("kamino_deposit"), marketPda.toBuffer()],
    PROGRAM_ID
  );

  // ---- Test 2: settle_period before next_settlement_ts
  await expectError(
    "2) settle_period before next_settlement_ts",
    "SettlementNotDue",
    () => program.methods
      .settlePeriod()
      .accountsStrict({
        protocolState: protocolStatePda,
        market: marketPda,
        swapPosition: freshSwap,
        lpVault: market0.account.lpVault,
        collateralVault: market0.account.collateralVault,
        treasury: proto.treasury,
        underlyingMint: USDC,
        caller: trader.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc()
  );

  // ---- Test 3: claim_matured on Open position
  await expectError(
    "3) claim_matured on Open position",
    "PositionNotMatured",
    () => program.methods
      .claimMatured()
      .accountsStrict({
        market: marketPda,
        swapPosition: freshSwap,
        lpVault: market0.account.lpVault,
        collateralVault: market0.account.collateralVault,
        ownerTokenAccount: traderAta,
        underlyingMint: USDC,
        owner: trader.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        kaminoDepositAccount,
        kaminoReserve: reserve,
        kaminoLendingMarket: KAMINO_LENDING_MARKET,
        kaminoLendingMarketAuthority,
        reserveLiquidityMint: USDC,
        reserveLiquiditySupply,
        reserveCollateralMint,
        collateralTokenProgram: TOKEN_PROGRAM_ID,
        liquidityTokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        kaminoProgram: KAMINO_PROGRAM,
      })
      .rpc()
  );

  // ---- Test 4: liquidate the fresh healthy position (closes account if it succeeds — last)
  await expectError(
    "4) liquidate healthy position",
    "AboveMaintenanceMargin",
    () => program.methods
      .liquidatePosition()
      .accountsStrict({
        protocolState: protocolStatePda,
        market: marketPda,
        swapPosition: freshSwap,
        lpVault: market0.account.lpVault,
        collateralVault: market0.account.collateralVault,
        owner: trader.publicKey,
        ownerTokenAccount: traderAta,
        liquidatorTokenAccount: traderAta,
        treasury: proto.treasury,
        underlyingMint: USDC,
        liquidator: trader.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        kaminoDepositAccount,
        kaminoReserve: reserve,
        kaminoLendingMarket: KAMINO_LENDING_MARKET,
        kaminoLendingMarketAuthority,
        reserveLiquidityMint: USDC,
        reserveLiquiditySupply,
        reserveCollateralMint,
        collateralTokenProgram: TOKEN_PROGRAM_ID,
        liquidityTokenProgram: TOKEN_PROGRAM_ID,
        instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
        kaminoProgram: KAMINO_PROGRAM,
      })
      .rpc()
  );

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
