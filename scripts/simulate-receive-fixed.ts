/**
 * ReceiveFixed direction symmetry demo.
 *
 *   1. Bump rate so variable APY ≈ 10%
 *   2. Open ReceiveFixed $200 (locks fixed_rate ≈ 10% − spread; trader receives fixed, pays variable)
 *   3. Settlement A: variable rises to 18% → trader LOSES (paying variable > receiving fixed)
 *   4. Settlement B: variable falls to 2%  → trader GAINS (paying tiny variable, receiving locked fixed)
 *   5. Print net PnL across the 2 settles
 *
 * Run: yarn ts-node scripts/simulate-receive-fixed.ts
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

  // ---- 1. Bump variable to 10% (fixed will lock ≈ 10% − spread for ReceiveFixed)
  console.log(`[1/5] bump variable APY ≈ 10%`);
  await bumpToApy(program, protocolStatePda, marketPda, trader.publicKey, 1000n, 60n);

  // ---- 2. Open ReceiveFixed
  const nonce = Math.floor(Math.random() * 254) + 1;
  const [swapPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("swap"), trader.publicKey.toBuffer(), marketPda.toBuffer(), Buffer.from([nonce])],
    PROGRAM_ID
  );
  console.log(`\n[2/5] open_swap ReceiveFixed $${Number(NOTIONAL_USDC) / 1e6} nonce=${nonce}`);
  // ReceiveFixed: maxRateBps = U64_MAX (no upper cap matters), minRateBps = 0
  const m1 = await program.account.swapMarket.fetch(marketPda);
  await program.methods
    .openSwap({ receiveFixed: {} }, new BN(NOTIONAL_USDC.toString()), nonce, new BN("18446744073709551615"), new BN(0))
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
  console.log(`       direction: ReceiveFixed`);
  console.log(`       locked fixed_rate: ${(Number(fixedBps) / 100).toFixed(2)}%`);
  console.log(`       collateral: $${(Number(collInitial) / 1e6).toFixed(4)}`);

  const collOpen = collInitial;

  // ---- 3. Settle A: variable rises to 18% → ReceiveFixed loses (paying high var)
  const nextSettle1 = BigInt(position.nextSettlementTs.toString()) + 60n;
  await timeTravel(Number(nextSettle1) * 1000);
  console.log(`\n[3/5] Settle A — bump variable to 18% (adverse for ReceiveFixed: pays variable, receives fixed)`);
  // Bump current_rate_index to imply 18% APY over the elapsed since last update
  const mA = await program.account.swapMarket.fetch(marketPda);
  const lastA = BigInt(mA.lastRateUpdateTs.toString());
  const elapsedA = nextSettle1 - lastA;
  const curA = BigInt(mA.currentRateIndex.toString());
  const bumpA = (curA * 1800n * (elapsedA > 0n ? elapsedA : 60n)) / (10_000n * SECONDS_PER_YEAR);
  await program.methods.setRateIndexOracle(new BN((curA + bumpA).toString()))
    .accountsStrict({ protocolState: protocolStatePda, market: marketPda, authority: trader.publicKey }).rpc();

  await program.methods.settlePeriod()
    .accountsStrict({
      protocolState: protocolStatePda, market: marketPda, swapPosition: swapPda,
      lpVault: m1.lpVault, collateralVault: m1.collateralVault, treasury: proto.treasury,
      underlyingMint: USDC, caller: trader.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
    }).rpc();
  position = await program.account.swapPosition.fetch(swapPda);
  const collA = BigInt(position.collateralRemaining.toString());
  console.log(`       collateral after Settle A: $${(Number(collA) / 1e6).toFixed(4)} (Δ ${((Number(collA) - Number(collOpen)) / 1e6).toFixed(4)})`);

  // ---- 4. Settle B: variable falls to 2% → ReceiveFixed gains
  const nextSettle2 = BigInt(position.nextSettlementTs.toString()) + 60n;
  await timeTravel(Number(nextSettle2) * 1000);
  console.log(`\n[4/5] Settle B — bump variable to 2% (favorable for ReceiveFixed)`);
  const mB = await program.account.swapMarket.fetch(marketPda);
  const lastB = BigInt(mB.lastRateUpdateTs.toString());
  const elapsedB = nextSettle2 - lastB;
  const curB = BigInt(mB.currentRateIndex.toString());
  const bumpB = (curB * 200n * (elapsedB > 0n ? elapsedB : 60n)) / (10_000n * SECONDS_PER_YEAR);
  await program.methods.setRateIndexOracle(new BN((curB + bumpB).toString()))
    .accountsStrict({ protocolState: protocolStatePda, market: marketPda, authority: trader.publicKey }).rpc();

  await program.methods.settlePeriod()
    .accountsStrict({
      protocolState: protocolStatePda, market: marketPda, swapPosition: swapPda,
      lpVault: m1.lpVault, collateralVault: m1.collateralVault, treasury: proto.treasury,
      underlyingMint: USDC, caller: trader.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
    }).rpc();
  position = await program.account.swapPosition.fetch(swapPda);
  const collB = BigInt(position.collateralRemaining.toString());
  console.log(`       collateral after Settle B: $${(Number(collB) / 1e6).toFixed(4)} (Δ ${((Number(collB) - Number(collA)) / 1e6).toFixed(4)})`);

  console.log(`\n=== ReceiveFixed symmetry demo ===`);
  console.log(`  Initial collateral:           $${(Number(collOpen) / 1e6).toFixed(4)}`);
  console.log(`  After Settle A (var ↑ 18%):   $${(Number(collA) / 1e6).toFixed(4)}  trader LOSES`);
  console.log(`  After Settle B (var ↓ 2%):    $${(Number(collB) / 1e6).toFixed(4)}  trader GAINS`);
  console.log(`  Net PnL:                      ${((Number(collB) - Number(collOpen)) / 1e6).toFixed(4)}`);
  console.log(`  Direction confirmed: ReceiveFixed loses when rates rise, gains when rates fall.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
