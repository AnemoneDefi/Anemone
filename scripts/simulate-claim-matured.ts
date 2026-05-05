/**
 * End-to-end claim_matured demo on surfpool. Uses the deployer wallet as
 * the trader so the script can sign for `owner` (Phantom-signed positions
 * can't be claimed via script — only via UI).
 *
 *   1. Open PayFixed swap ($200 notional, 30-day tenor)
 *   2. Time-travel past maturity_ts
 *   3. Bump rate_index (set_rate_index_oracle, dev-tools)
 *   4. Call settle_period → transitions position to Matured
 *   5. Call claim_matured → returns collateral + accrued PnL to trader
 *   6. Print before/after balances + treasury fee
 *
 * Run: yarn ts-node scripts/simulate-claim-matured.ts
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
  ASSOCIATED_TOKEN_PROGRAM_ID,
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
const SCOPE_PRICES = new PublicKey(
  "3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH"
);
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const NOTIONAL_USDC = 200_000_000n; // $200
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
  const market = markets[0];
  const marketPda = market.publicKey;
  const reserve = market.account.underlyingReserve;

  // Resolve Kamino accounts from on-chain reserve
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

  console.log(`Trader: ${trader.publicKey.toBase58()}`);
  const usdcAta = getAssociatedTokenAddressSync(USDC, trader.publicKey);
  let bal = await conn.getTokenAccountBalance(usdcAta);
  console.log(`  USDC balance: ${bal.value.uiAmountString}`);

  if (Number(bal.value.uiAmount) < 250) {
    console.log("  Funding deployer wallet with USDC via surfnet cheat...");
    await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "surfnet_setTokenAccount",
        params: [trader.publicKey.toBase58(), USDC.toBase58(), { amount: 500_000_000 }],
      }),
    });
    bal = await conn.getTokenAccountBalance(usdcAta);
    console.log(`  USDC balance after: ${bal.value.uiAmountString}`);
  }

  const lpNav = BigInt(market.account.lpNav.toString());
  if (lpNav < NOTIONAL_USDC * 2n) {
    throw new Error(
      `LP NAV is too low ($${Number(lpNav) / 1e6}); deposit LP first via UI`
    );
  }

  // ---- 1. Open PayFixed
  const nonce = Math.floor(Math.random() * 254) + 1;
  const [swapPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("swap"), trader.publicKey.toBuffer(), marketPda.toBuffer(), Buffer.from([nonce])],
    PROGRAM_ID
  );
  console.log(`\n[1/5] open_swap PayFixed $${Number(NOTIONAL_USDC) / 1e6} nonce=${nonce}`);
  console.log(`       swap PDA: ${swapPda.toBase58()}`);

  const refresh1 = new TransactionInstruction({
    programId: KAMINO_PROGRAM,
    keys: [
      { pubkey: reserve, isSigner: false, isWritable: true },
      { pubkey: KAMINO_LENDING_MARKET, isSigner: false, isWritable: false },
      { pubkey: KAMINO_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: KAMINO_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: KAMINO_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SCOPE_PRICES, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([2, 218, 138, 235, 79, 201, 25, 102]),
  });
  const updateRateIx = await program.methods
    .updateRateIndex()
    .accountsStrict({
      protocolState: protocolStatePda,
      market: marketPda,
      kaminoReserve: reserve,
      keeper: trader.publicKey,
    })
    .instruction();

  const openTx = await program.methods
    .openSwap({ payFixed: {} }, new BN(NOTIONAL_USDC.toString()), nonce, new BN("18446744073709551615"), new BN(0))
    .accountsStrict({
      protocolState: protocolStatePda,
      market: marketPda,
      swapPosition: swapPda,
      collateralVault: market.account.collateralVault,
      treasury: proto.treasury,
      underlyingMint: USDC,
      traderTokenAccount: usdcAta,
      trader: trader.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([refresh1, updateRateIx])
    .rpc();
  console.log(`       tx: ${openTx}`);

  let position = await program.account.swapPosition.fetch(swapPda);
  console.log(`       collateral: $${(Number(position.collateralRemaining) / 1e6).toFixed(4)}`);
  console.log(`       fixed_rate_bps: ${position.fixedRateBps.toString()}`);
  console.log(`       maturity_ts: ${position.maturityTimestamp.toString()}`);
  console.log(`       open_timestamp: ${position.openTimestamp.toString()}`);

  // ---- 2. Time-travel to maturity + 60s
  const matAt = BigInt(position.maturityTimestamp.toString()) + 60n;
  console.log(`\n[2/5] timeTravel → ${matAt.toString()} (maturity + 60s)`);
  await timeTravel(Number(matAt) * 1000);

  // ---- 3. Bump rate index for final settle (variable APY ≈ fixed_rate to avoid huge PnL)
  const fixedBps = BigInt(position.fixedRateBps.toString());
  const oldCurrent = BigInt(market.account.currentRateIndex.toString());
  // Reload market to get latest rate state (open_swap may have rotated)
  const m2 = await program.account.swapMarket.fetch(marketPda);
  const m2Last = BigInt(m2.lastRateUpdateTs.toString());
  const m2Current = BigInt(m2.currentRateIndex.toString());

  // Size bump for fixedBps APY over full tenor (so PnL ≈ 0)
  const tenor = BigInt(market.account.tenorSeconds.toString());
  const bump = (m2Current * fixedBps * tenor) / (10_000n * SECONDS_PER_YEAR);
  const newCurrent = m2Current + bump;
  console.log(`\n[3/5] set_rate_index_oracle ${(Number(fixedBps) / 100).toFixed(2)}% APY over ${tenor.toString()}s`);
  console.log(`       new_current: ${newCurrent.toString()} (+${bump.toString()})`);

  await program.methods
    .setRateIndexOracle(new BN(newCurrent.toString()))
    .accountsStrict({
      protocolState: protocolStatePda,
      market: marketPda,
      authority: trader.publicKey,
    })
    .rpc();

  // ---- 4. settle_period → transitions to Matured
  console.log(`\n[4/5] settle_period (final — should mark Matured)`);
  await program.methods
    .settlePeriod()
    .accountsStrict({
      protocolState: protocolStatePda,
      market: marketPda,
      swapPosition: swapPda,
      lpVault: market.account.lpVault,
      collateralVault: market.account.collateralVault,
      treasury: proto.treasury,
      underlyingMint: USDC,
      caller: trader.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  position = await program.account.swapPosition.fetch(swapPda);
  console.log(`       status: ${JSON.stringify(position.status)}`);
  console.log(`       collateral: $${(Number(position.collateralRemaining) / 1e6).toFixed(4)}`);

  if (!("matured" in position.status)) {
    throw new Error("Position did not transition to Matured");
  }

  // ---- 5. claim_matured
  const balBefore = await conn.getTokenAccountBalance(usdcAta);
  console.log(`\n[5/5] claim_matured`);
  console.log(`       trader USDC before: ${balBefore.value.uiAmountString}`);

  const [kaminoDepositAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("kamino_deposit"), marketPda.toBuffer()],
    PROGRAM_ID
  );
  const claimTx = await program.methods
    .claimMatured()
    .accountsStrict({
      market: marketPda,
      swapPosition: swapPda,
      lpVault: market.account.lpVault,
      collateralVault: market.account.collateralVault,
      ownerTokenAccount: usdcAta,
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
    .rpc();
  console.log(`       tx: ${claimTx}`);

  const balAfter = await conn.getTokenAccountBalance(usdcAta);
  const delta = Number(balAfter.value.uiAmount) - Number(balBefore.value.uiAmount);
  console.log(`       trader USDC after: ${balAfter.value.uiAmountString} (Δ +${delta.toFixed(4)})`);

  // Position account closed (close = owner)
  const positionAfter = await conn.getAccountInfo(swapPda);
  console.log(`       swap_position account closed: ${positionAfter == null ? "YES" : "NO"}`);

  console.log(`\n=== Lifecycle complete ===`);
  console.log(`  Trader recovered $${delta.toFixed(4)} on $${Number(NOTIONAL_USDC) / 1e6} notional position.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
