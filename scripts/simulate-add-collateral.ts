/**
 * add_collateral demo — risk management without closing the position.
 *
 *   1. Open PayFixed at high fixed rate
 *   2. Drain collateral via adverse settles until close to MM
 *   3. add_collateral $5 → collateral_remaining jumps back well above MM
 *   4. Show position is healthy again (no longer liquidatable)
 *
 * Run: yarn ts-node scripts/simulate-add-collateral.ts
 */
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
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
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const NOTIONAL_USDC = 200_000_000n;
const TOPUP_AMOUNT = 5_000_000n; // $5
const SECONDS_PER_YEAR = 31_536_000n;

async function timeTravel(absMs: number) {
  await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "surfnet_timeTravel",
      params: [{ absoluteTimestamp: absMs }],
    }),
  });
}

async function bumpToApy(
  program: any,
  protocolStatePda: PublicKey,
  marketPda: PublicKey,
  authority: PublicKey,
  targetBps: bigint,
  elapsedSecs: bigint
) {
  const m = await program.account.swapMarket.fetch(marketPda);
  const oldLast = BigInt(m.lastRateUpdateTs.toString());
  await timeTravel(Number(oldLast + elapsedSecs) * 1000);
  const m2 = await program.account.swapMarket.fetch(marketPda);
  const cur = BigInt(m2.currentRateIndex.toString());
  const bump = (cur * targetBps * elapsedSecs) / (10_000n * SECONDS_PER_YEAR);
  await program.methods
    .setRateIndexOracle(new BN((cur + bump).toString()))
    .accountsStrict({
      protocolState: protocolStatePda,
      market: marketPda,
      authority,
    })
    .rpc();
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
  const market = markets[0];
  const marketPda = market.publicKey;
  const traderAta = getAssociatedTokenAddressSync(USDC, trader.publicKey);

  // ---- 1. High variable APY → high fixed lock
  console.log(`[1/4] bump variable APY ≈ 50%`);
  await bumpToApy(program, protocolStatePda, marketPda, trader.publicKey, 5000n, 60n);

  // ---- 2. Open PayFixed
  const nonce = Math.floor(Math.random() * 254) + 1;
  const [swapPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("swap"), trader.publicKey.toBuffer(), marketPda.toBuffer(), Buffer.from([nonce])],
    PROGRAM_ID
  );
  console.log(`\n[2/4] open_swap PayFixed $${Number(NOTIONAL_USDC) / 1e6} nonce=${nonce}`);
  const m1 = await program.account.swapMarket.fetch(marketPda);
  await program.methods
    .openSwap({ payFixed: {} }, new BN(NOTIONAL_USDC.toString()), nonce, new BN("18446744073709551615"), new BN(0))
    .accountsStrict({
      protocolState: protocolStatePda,
      market: marketPda,
      swapPosition: swapPda,
      collateralVault: m1.collateralVault,
      treasury: proto.treasury,
      underlyingMint: USDC,
      traderTokenAccount: traderAta,
      trader: trader.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  let position = await program.account.swapPosition.fetch(swapPda);
  const fixedBps = BigInt(position.fixedRateBps.toString());
  const collInitial = BigInt(position.collateralRemaining.toString());
  const tenor = BigInt(m1.tenorSeconds.toString());
  const im = (NOTIONAL_USDC * 2000n * tenor * 15000n) / (10_000n * SECONDS_PER_YEAR * 10_000n);
  const mm = (im * 60n) / 100n;
  console.log(`       fixed_rate: ${(Number(fixedBps) / 100).toFixed(2)}%   IM=$${(Number(im)/1e6).toFixed(4)}   MM=$${(Number(mm)/1e6).toFixed(4)}`);

  // ---- 3. Drain collateral to ~MM via 6 adverse settles
  console.log(`\n[3/4] Drain collateral with 6 adverse settles (variable ≈ 0%)`);
  for (let i = 0; i < 6; i++) {
    const ns = BigInt(position.nextSettlementTs.toString()) + 60n;
    await timeTravel(Number(ns) * 1000);
    const mNow = await program.account.swapMarket.fetch(marketPda);
    const lastBI = BigInt(mNow.lastRateUpdateTs.toString());
    const ela = ns - lastBI;
    const cur = BigInt(mNow.currentRateIndex.toString());
    const tb = (cur * 1n * (ela > 0n ? ela : 60n)) / (10_000n * SECONDS_PER_YEAR);
    await program.methods.setRateIndexOracle(new BN((cur + tb).toString()))
      .accountsStrict({ protocolState: protocolStatePda, market: marketPda, authority: trader.publicKey }).rpc();
    await program.methods.settlePeriod()
      .accountsStrict({
        protocolState: protocolStatePda, market: marketPda, swapPosition: swapPda,
        lpVault: m1.lpVault, collateralVault: m1.collateralVault, treasury: proto.treasury,
        underlyingMint: USDC, caller: trader.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();
    position = await program.account.swapPosition.fetch(swapPda);
    const c = BigInt(position.collateralRemaining.toString());
    const status = c < mm ? "BELOW MM (liquidatable)" : "OK";
    console.log(`       settle ${i + 1}: collateral $${(Number(c) / 1e6).toFixed(4)}  ${status}`);
    if (c < mm) break;
  }

  position = await program.account.swapPosition.fetch(swapPda);
  const collBeforeTopup = BigInt(position.collateralRemaining.toString());

  // ---- 4. add_collateral $5 → position should jump back above MM
  console.log(`\n[4/4] add_collateral $${Number(TOPUP_AMOUNT) / 1e6}`);
  const traderUsdcBefore = await conn.getTokenAccountBalance(traderAta);
  console.log(`       trader USDC before: ${traderUsdcBefore.value.uiAmountString}`);

  await program.methods
    .addCollateral(new BN(TOPUP_AMOUNT.toString()))
    .accountsStrict({
      market: marketPda,
      swapPosition: swapPda,
      collateralVault: m1.collateralVault,
      underlyingMint: USDC,
      ownerTokenAccount: traderAta,
      owner: trader.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  position = await program.account.swapPosition.fetch(swapPda);
  const collAfterTopup = BigInt(position.collateralRemaining.toString());
  const traderUsdcAfter = await conn.getTokenAccountBalance(traderAta);
  console.log(`       trader USDC after:  ${traderUsdcAfter.value.uiAmountString} (Δ ${(Number(traderUsdcAfter.value.uiAmount) - Number(traderUsdcBefore.value.uiAmount)).toFixed(4)})`);
  const expected = collBeforeTopup + TOPUP_AMOUNT;
  console.log(`       collateral: $${(Number(collBeforeTopup) / 1e6).toFixed(4)} → $${(Number(collAfterTopup) / 1e6).toFixed(4)}`);
  console.log(`       expected:   $${(Number(expected) / 1e6).toFixed(4)}    ${collAfterTopup === expected ? "OK" : "MISMATCH"}`);
  console.log(`       liquidatable now? ${collAfterTopup < mm ? "YES (still below MM)" : "NO — position healthy again"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
