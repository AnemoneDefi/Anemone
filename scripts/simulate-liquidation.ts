/**
 * End-to-end liquidation demo on surfpool.
 *
 *   1. Bump rate_index high (variable APY ≈ 50%) so PayFixed open locks at ~55%
 *   2. Open PayFixed $200, 30-day tenor (deployer wallet acts as trader)
 *   3. Create + fund a separate `liquidator` keypair
 *   4. Set rate_index so variable APY ≈ 0% — trader bleeds (-55% APY × elapsed)
 *   5. Time-travel +1 day, settle_period → drains collateral below MM
 *   6. Verify collateral_remaining < maintenance_margin
 *   7. liquidator calls liquidate_position → 3% reward to liquidator,
 *      protocol fee to treasury, remainder to trader
 *
 * Run: yarn ts-node scripts/simulate-liquidation.ts
 */
import {
  Connection,
  PublicKey,
  Keypair,
  TransactionInstruction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
} from "@solana/web3.js";
import { AnchorProvider, Program, Wallet, BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { readFileSync } from "fs";
import os from "os";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const PROGRAM_ID = new PublicKey("KQs6ci5FtedFKPVJThAZSMMXyosK4TvnF7kcDSx5Jwd");
const KAMINO_PROGRAM = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const KAMINO_LENDING_MARKET = new PublicKey(
  "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"
);
const SCOPE_PRICES = new PublicKey(
  "3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH"
);
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const NOTIONAL_USDC = 200_000_000n;
const SECONDS_PER_YEAR = 31_536_000n;
const HIGH_VAR_APY_BPS = 5000n; // 50% — locks fixed_rate at ~55% via spread
const LOW_VAR_APY_BPS = 1n; // ~0% — drains PayFixed collateral fast
const ONE_DAY = 86_400;

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

async function fundWalletUSDC(pubkey: PublicKey, amount: number) {
  await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "surfnet_setTokenAccount",
      params: [pubkey.toBase58(), USDC.toBase58(), { amount }],
    }),
  });
}

async function bumpRate(
  program: any,
  protocolStatePda: PublicKey,
  marketPda: PublicKey,
  authority: PublicKey,
  targetBps: bigint,
  estimatedElapsed: bigint,
  oldLast: bigint
) {
  // Time-travel forward past oldLast so elapsed > 0
  const target = oldLast + estimatedElapsed;
  await timeTravel(Number(target) * 1000);

  const market = await program.account.swapMarket.fetch(marketPda);
  const oldCurrent = BigInt(market.currentRateIndex.toString());
  const bump = (oldCurrent * targetBps * estimatedElapsed) / (10_000n * SECONDS_PER_YEAR);
  const newCurrent = oldCurrent + bump;

  await program.methods
    .setRateIndexOracle(new BN(newCurrent.toString()))
    .accountsStrict({
      protocolState: protocolStatePda,
      market: marketPda,
      authority,
    })
    .rpc();

  return await program.account.swapMarket.fetch(marketPda);
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
  if (markets.length === 0) throw new Error("No market — run setup-surfpool first");
  const market0 = markets[0];
  const marketPda = market0.publicKey;
  const reserve = market0.account.underlyingReserve;

  const lpNav = BigInt(market0.account.lpNav.toString());
  if (lpNav < NOTIONAL_USDC * 2n) {
    throw new Error(`LP NAV is too low ($${Number(lpNav) / 1e6}); deposit LP first via UI`);
  }

  // Resolve Kamino accounts
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

  // ---- 0. Fund trader if needed
  const traderAta = getAssociatedTokenAddressSync(USDC, trader.publicKey);
  const traderBal = await conn.getTokenAccountBalance(traderAta).catch(() => null);
  if (!traderBal || Number(traderBal.value.uiAmount) < 250) {
    await fundWalletUSDC(trader.publicKey, 500_000_000);
  }

  // ---- 1. Bump rate to imply HIGH variable APY (so fixed_rate locks high)
  console.log(`[1/6] bump rate_index → variable APY ≈ ${Number(HIGH_VAR_APY_BPS) / 100}%`);
  const m0 = await program.account.swapMarket.fetch(marketPda);
  const m1 = await bumpRate(
    program,
    protocolStatePda,
    marketPda,
    trader.publicKey,
    HIGH_VAR_APY_BPS,
    60n,
    BigInt(m0.lastRateUpdateTs.toString())
  );
  const newPrev = BigInt(m1.previousRateIndex.toString());
  const newCurr = BigInt(m1.currentRateIndex.toString());
  const elapsed = BigInt(m1.lastRateUpdateTs.toString()) - BigInt(m1.previousRateUpdateTs.toString());
  const impliedApy =
    elapsed > 0n
      ? (((newCurr - newPrev) * 10_000n * SECONDS_PER_YEAR) / (newPrev * elapsed)).toString()
      : "?";
  console.log(`       implied variable APY: ${(Number(impliedApy) / 100).toFixed(2)}%`);

  // ---- 2. Open PayFixed (locks high fixed_rate)
  const nonce = Math.floor(Math.random() * 254) + 1;
  const [swapPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("swap"), trader.publicKey.toBuffer(), marketPda.toBuffer(), Buffer.from([nonce])],
    PROGRAM_ID
  );
  console.log(`\n[2/6] open_swap PayFixed $${Number(NOTIONAL_USDC) / 1e6} nonce=${nonce}`);
  const openTx = await program.methods
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
  console.log(`       tx: ${openTx}`);

  let position = await program.account.swapPosition.fetch(swapPda);
  const fixedBps = BigInt(position.fixedRateBps.toString());
  const collInitial = BigInt(position.collateralRemaining.toString());
  console.log(`       locked fixed_rate: ${(Number(fixedBps) / 100).toFixed(2)}%`);
  console.log(`       initial collateral: $${(Number(collInitial) / 1e6).toFixed(4)}`);

  // Compute IM/MM for sanity
  const tenor = BigInt(m1.tenorSeconds.toString());
  const im = (NOTIONAL_USDC * 2000n * tenor * 15000n) / (10_000n * SECONDS_PER_YEAR * 10_000n);
  const mm = (im * 60n) / 100n;
  console.log(`       IM=$${(Number(im) / 1e6).toFixed(4)}, MM=$${(Number(mm) / 1e6).toFixed(4)}`);

  // ---- 3. Drop variable APY to ~0%
  console.log(`\n[3/6] bump rate_index → variable APY ≈ ${Number(LOW_VAR_APY_BPS) / 100}% (adverse for PayFixed)`);
  const m2 = await bumpRate(
    program,
    protocolStatePda,
    marketPda,
    trader.publicKey,
    LOW_VAR_APY_BPS,
    60n,
    BigInt(m1.lastRateUpdateTs.toString())
  );

  // ---- 4. Time-travel past next_settlement_ts and settle
  const nextSettle = BigInt(position.nextSettlementTs.toString());
  console.log(`\n[4/6] timeTravel + settle_period (1 period @ low variable rate)`);
  console.log(`       next_settlement_ts: ${nextSettle.toString()}`);

  // Advance to next_settlement_ts + buffer, BUT we must also bump rate_index
  // again to stay current after the time-travel
  const settleTarget = nextSettle + 60n;
  await timeTravel(Number(settleTarget) * 1000);

  // Bump rate again to keep market.current_rate_index near low APY trajectory
  const m3 = await program.account.swapMarket.fetch(marketPda);
  const m3LastBI = BigInt(m3.lastRateUpdateTs.toString());
  // size for tiny APY (LOW_VAR_APY_BPS) over the elapsed since previous update
  const elapsedSettle = settleTarget - m3LastBI;
  const m3Curr = BigInt(m3.currentRateIndex.toString());
  const tinyBump = (m3Curr * LOW_VAR_APY_BPS * (elapsedSettle > 0n ? elapsedSettle : 60n)) / (10_000n * SECONDS_PER_YEAR);
  await program.methods
    .setRateIndexOracle(new BN((m3Curr + tinyBump).toString()))
    .accountsStrict({
      protocolState: protocolStatePda,
      market: marketPda,
      authority: trader.publicKey,
    })
    .rpc();

  await program.methods
    .settlePeriod()
    .accountsStrict({
      protocolState: protocolStatePda,
      market: marketPda,
      swapPosition: swapPda,
      lpVault: m1.lpVault,
      collateralVault: m1.collateralVault,
      treasury: proto.treasury,
      underlyingMint: USDC,
      caller: trader.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  position = await program.account.swapPosition.fetch(swapPda);
  const collAfterSettle = BigInt(position.collateralRemaining.toString());
  console.log(`       collateral after settle: $${(Number(collAfterSettle) / 1e6).toFixed(4)}`);
  console.log(`       liquidatable: ${collAfterSettle < mm ? "YES" : "no — need more drains"}`);

  if (collAfterSettle >= mm) {
    console.log(`\n  Drain not enough in 1 period. Repeating settle...`);
    // Run additional settle cycles to drain further
    for (let i = 0; i < 15 && collAfterSettle >= mm; i++) {
      const ns = BigInt(position.nextSettlementTs.toString());
      await timeTravel(Number(ns + 60n) * 1000);
      const mNow = await program.account.swapMarket.fetch(marketPda);
      const lastBI = BigInt(mNow.lastRateUpdateTs.toString());
      const ela = ns + 60n - lastBI;
      const cur = BigInt(mNow.currentRateIndex.toString());
      const tb = (cur * LOW_VAR_APY_BPS * (ela > 0n ? ela : 60n)) / (10_000n * SECONDS_PER_YEAR);
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
      console.log(`       extra settle ${i + 1}: collateral $${(Number(c) / 1e6).toFixed(4)}`);
      if (c < mm) break;
    }
  }

  position = await program.account.swapPosition.fetch(swapPda);
  const collFinal = BigInt(position.collateralRemaining.toString());
  if (collFinal >= mm) {
    console.log(`\n  Could not drive below MM. Skipping liquidation.`);
    return;
  }

  // ---- 5. Set up a SEPARATE liquidator wallet
  const liquidator = Keypair.generate();
  console.log(`\n[5/6] funding liquidator wallet ${liquidator.publicKey.toBase58()}`);
  const airdropSig = await conn.requestAirdrop(liquidator.publicKey, 1_000_000_000);
  await conn.confirmTransaction(airdropSig, "confirmed");
  // Create USDC ATA for liquidator (will receive 3% reward)
  const liquidatorAta = getAssociatedTokenAddressSync(USDC, liquidator.publicKey);
  const ataIx = createAssociatedTokenAccountIdempotentInstruction(
    trader.publicKey, liquidatorAta, liquidator.publicKey, USDC
  );
  // Send the ATA creation tx from trader (deployer pays rent)
  const { Transaction } = await import("@solana/web3.js");
  const tx = new Transaction().add(ataIx);
  tx.feePayer = trader.publicKey;
  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.sign(trader);
  await conn.sendRawTransaction(tx.serialize());

  // ---- 6. Liquidate
  console.log(`\n[6/6] liquidate_position from liquidator wallet`);
  const treasuryBefore = await conn.getTokenAccountBalance(proto.treasury);
  const traderUsdcBefore = await conn.getTokenAccountBalance(traderAta);

  const liquidatorProvider = new AnchorProvider(conn, new Wallet(liquidator), { commitment: "confirmed" });
  const liquidatorProgram = new Program(idl, liquidatorProvider) as any;
  const [kaminoDepositAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("kamino_deposit"), marketPda.toBuffer()],
    PROGRAM_ID
  );
  const liqTx = await liquidatorProgram.methods
    .liquidatePosition()
    .accountsStrict({
      protocolState: protocolStatePda,
      market: marketPda,
      swapPosition: swapPda,
      lpVault: m1.lpVault,
      collateralVault: m1.collateralVault,
      owner: trader.publicKey,
      ownerTokenAccount: traderAta,
      liquidatorTokenAccount: liquidatorAta,
      treasury: proto.treasury,
      underlyingMint: USDC,
      liquidator: liquidator.publicKey,
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
    .rpc();
  console.log(`       tx: ${liqTx}`);

  const treasuryAfter = await conn.getTokenAccountBalance(proto.treasury);
  const liquidatorAfter = await conn.getTokenAccountBalance(liquidatorAta);
  const traderUsdcAfter = await conn.getTokenAccountBalance(traderAta);

  console.log(`\n=== Liquidation complete ===`);
  console.log(`  Liquidator received:  $${liquidatorAfter.value.uiAmountString}`);
  console.log(`  Treasury Δ:           +$${(Number(treasuryAfter.value.uiAmount) - Number(treasuryBefore.value.uiAmount)).toFixed(4)}`);
  console.log(`  Trader USDC Δ:        +$${(Number(traderUsdcAfter.value.uiAmount) - Number(traderUsdcBefore.value.uiAmount)).toFixed(4)}`);

  const positionAfter = await conn.getAccountInfo(swapPda);
  console.log(`  Position closed: ${positionAfter == null ? "YES" : "NO (still exists)"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
