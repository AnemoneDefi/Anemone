/**
 * Same as simulate-settlement.ts but bumps rate_index just enough to imply
 * a LOW variable APY (~2%), so the PayFixed trader (locked at 8.85%) loses
 * money to the LP vault.
 */
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet, BN } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { readFileSync } from "fs";
import os from "os";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const PROGRAM_ID = new PublicKey("KQs6ci5FtedFKPVJThAZSMMXyosK4TvnF7kcDSx5Jwd");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TARGET_VARIABLE_APY_BPS = 200n; // 2.00% — well below the locked 8.85%
const SECONDS_PER_YEAR = 31_536_000n;

async function timeTravel(absMs: number) {
  const r = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "surfnet_timeTravel",
      params: [{ absoluteTimestamp: absMs }],
    }),
  });
  return r.json();
}

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const idl = JSON.parse(readFileSync("target/idl/anemone.json", "utf-8"));
  const kp = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(readFileSync(os.homedir() + "/.config/solana/id.json", "utf-8")))
  );
  const provider = new AnchorProvider(conn, new Wallet(kp), { commitment: "confirmed" });
  const program = new Program(idl, provider) as any;

  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    PROGRAM_ID
  );

  const positions = await program.account.swapPosition.all();
  if (positions.length === 0) throw new Error("No positions");
  const position = positions[0];
  const market = await program.account.swapMarket.fetch(position.account.market);
  const proto = await program.account.protocolState.fetch(protocolStatePda);

  console.log(`Position: ${position.publicKey.toBase58()}`);
  console.log(`  notional: $${(Number(position.account.notional) / 1e6).toFixed(2)}`);
  console.log(`  collateral_remaining: $${(Number(position.account.collateralRemaining) / 1e6).toFixed(4)}`);
  console.log(`  fixed_rate_bps: ${position.account.fixedRateBps.toString()} (locked at ${(Number(position.account.fixedRateBps)/100).toFixed(2)}%)`);
  console.log(`  next_settlement_ts: ${position.account.nextSettlementTs.toString()}`);

  const treasuryBefore = await conn.getTokenAccountBalance(proto.treasury);
  const lpVaultBefore = await conn.getTokenAccountBalance(market.lpVault);
  console.log(`Treasury before: ${treasuryBefore.value.uiAmountString} USDC`);
  console.log(`LP vault before: ${lpVaultBefore.value.uiAmountString} USDC`);

  // ---- 1. time-travel
  const target = Number(position.account.nextSettlementTs) + 100;
  console.log(`\n[1/3] timeTravel → ${target}`);
  await timeTravel(target * 1000);
  const blockTime = await conn.getBlockTime(await conn.getSlot());
  console.log(`       chain time: ${blockTime}`);

  // ---- 2. compute rate_index that implies LOW variable APY over the elapsed window
  const elapsed = BigInt(blockTime!) - BigInt(position.account.lastSettlementTs.toString());
  const oldIndex = BigInt(market.currentRateIndex.toString());
  // variable_rate ≈ (new - old) / old × (YEAR / elapsed)
  // Solve for new: new = old + old × bps × elapsed / (10000 × YEAR)
  const bump =
    (oldIndex * TARGET_VARIABLE_APY_BPS * elapsed) / (10_000n * SECONDS_PER_YEAR);
  const newIndex = oldIndex + bump;
  console.log(`\n[2/3] set_rate_index_oracle (target var APY = ${Number(TARGET_VARIABLE_APY_BPS)/100}%)`);
  console.log(`       elapsed: ${elapsed.toString()}s`);
  console.log(`       old: ${oldIndex.toString()}`);
  console.log(`       new: ${newIndex.toString()} (+${bump.toString()})`);

  await program.methods
    .setRateIndexOracle(new BN(newIndex.toString()))
    .accountsStrict({
      protocolState: protocolStatePda,
      market: position.account.market,
      authority: kp.publicKey,
    })
    .rpc();

  // ---- 3. settle_period
  console.log(`\n[3/3] settle_period`);
  const tx = await program.methods
    .settlePeriod()
    .accountsStrict({
      protocolState: protocolStatePda,
      market: position.account.market,
      swapPosition: position.publicKey,
      lpVault: market.lpVault,
      collateralVault: market.collateralVault,
      treasury: proto.treasury,
      underlyingMint: USDC,
      caller: kp.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log(`       tx: ${tx}`);

  // ---- After
  const positionAfter = await program.account.swapPosition.fetch(position.publicKey);
  const treasuryAfter = await conn.getTokenAccountBalance(proto.treasury);
  const lpVaultAfter = await conn.getTokenAccountBalance(market.lpVault);
  const collDelta =
    (Number(positionAfter.collateralRemaining) - Number(position.account.collateralRemaining)) / 1e6;
  const treasDelta =
    Number(treasuryAfter.value.uiAmount) - Number(treasuryBefore.value.uiAmount);
  const lpDelta =
    Number(lpVaultAfter.value.uiAmount) - Number(lpVaultBefore.value.uiAmount);

  console.log(`\n=== Settlement complete ===`);
  console.log(`Trader collateral: $${(Number(positionAfter.collateralRemaining) / 1e6).toFixed(4)} (Δ ${collDelta >= 0 ? "+" : ""}${collDelta.toFixed(4)})`);
  console.log(`Treasury:          ${treasuryAfter.value.uiAmountString} USDC (Δ ${treasDelta >= 0 ? "+" : ""}${treasDelta.toFixed(6)})`);
  console.log(`LP vault:          ${lpVaultAfter.value.uiAmountString} USDC (Δ ${lpDelta >= 0 ? "+" : ""}${lpDelta.toFixed(6)})`);
  console.log(`Position next_settlement_ts: ${positionAfter.nextSettlementTs.toString()}`);
  console.log(`Position unpaid_pnl: ${positionAfter.unpaidPnl?.toString() ?? "—"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
