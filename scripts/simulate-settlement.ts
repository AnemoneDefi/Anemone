/**
 * Simulates one settle_period for the open position on surfpool.
 *
 *   1. surfnet_timeTravel forward past `next_settlement_ts`
 *   2. set_rate_index_oracle (dev-tools instr) — bump current_rate_index so the
 *      keeper-equivalent rate freshness check passes
 *   3. settle_period — permissionless, anyone signs as `caller`
 *
 * Run: yarn ts-node scripts/simulate-settlement.ts
 */
import {
  Connection,
  PublicKey,
  Keypair,
} from "@solana/web3.js";
import { AnchorProvider, Program, Wallet, BN } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { readFileSync } from "fs";
import os from "os";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const PROGRAM_ID = new PublicKey("KQs6ci5FtedFKPVJThAZSMMXyosK4TvnF7kcDSx5Jwd");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

async function timeTravel(connection: Connection, absoluteTimestampMs: number) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "surfnet_timeTravel",
      params: [{ absoluteTimestamp: absoluteTimestampMs }],
    }),
  });
  return res.json();
}

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const idl = JSON.parse(readFileSync("target/idl/anemone.json", "utf-8"));
  const kp = Keypair.fromSecretKey(
    Buffer.from(
      JSON.parse(readFileSync(os.homedir() + "/.config/solana/id.json", "utf-8"))
    )
  );
  const provider = new AnchorProvider(conn, new Wallet(kp), {
    commitment: "confirmed",
  });
  const program = new Program(idl, provider) as any;

  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    PROGRAM_ID
  );

  const positions = await program.account.swapPosition.all();
  if (positions.length === 0) throw new Error("No open positions");
  const position = positions[0];
  console.log(`Position: ${position.publicKey.toBase58()}`);
  console.log(`  owner: ${position.account.owner.toBase58()}`);
  console.log(`  notional: $${(Number(position.account.notional) / 1e6).toFixed(2)}`);
  console.log(`  collateral_remaining: $${(Number(position.account.collateralRemaining) / 1e6).toFixed(4)}`);
  console.log(`  fixed_rate_bps: ${position.account.fixedRateBps.toString()}`);
  console.log(`  next_settlement_ts: ${position.account.nextSettlementTs.toString()}`);
  console.log(`  last_settled_rate_index: ${position.account.lastSettledRateIndex.toString()}`);

  const market = await program.account.swapMarket.fetch(position.account.market);
  console.log(`\nMarket:`);
  console.log(`  current_rate_index: ${market.currentRateIndex.toString()}`);
  console.log(`  last_rate_update_ts: ${market.lastRateUpdateTs.toString()}`);

  const proto = await program.account.protocolState.fetch(protocolStatePda);
  const treasuryBalBefore = await conn.getTokenAccountBalance(proto.treasury);
  console.log(`\nTreasury before: ${treasuryBalBefore.value.uiAmountString} USDC`);

  // ---- Step 1: time-travel
  const target = Number(position.account.nextSettlementTs) + 100; // 100s past due
  const targetMs = target * 1000;
  console.log(`\n[1/3] timeTravel → ${target} (${new Date(targetMs).toISOString()})`);
  const ttResult = await timeTravel(conn, targetMs);
  console.log("       ", JSON.stringify(ttResult.result ?? ttResult.error));

  const slot = await conn.getSlot();
  const blockTime = await conn.getBlockTime(slot);
  console.log(`       chain time now: ${blockTime}`);

  // ---- Step 2: bump rate_index. Use ~0.034% bump (≈ 12.5% APY for 1 day).
  const oldIndex = BigInt(market.currentRateIndex.toString());
  const bump = oldIndex / 3000n; // ~0.033%
  const newIndex = oldIndex + bump;
  console.log(`\n[2/3] set_rate_index_oracle`);
  console.log(`       old: ${oldIndex.toString()}`);
  console.log(`       new: ${newIndex.toString()} (+${bump.toString()})`);

  const tx2 = await program.methods
    .setRateIndexOracle(new BN(newIndex.toString()))
    .accountsStrict({
      protocolState: protocolStatePda,
      market: position.account.market,
      authority: kp.publicKey,
    })
    .rpc();
  console.log(`       tx: ${tx2}`);

  // ---- Step 3: settle_period
  console.log(`\n[3/3] settle_period`);
  const ownerTokenAccount = getAssociatedTokenAddressSync(
    USDC,
    position.account.owner
  );

  const tx3 = await program.methods
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
  console.log(`       tx: ${tx3}`);

  // ---- Show after state
  const positionAfter = await program.account.swapPosition.fetch(position.publicKey);
  const marketAfter = await program.account.swapMarket.fetch(position.account.market);
  const treasuryBalAfter = await conn.getTokenAccountBalance(proto.treasury);

  const collDelta =
    (Number(positionAfter.collateralRemaining) - Number(position.account.collateralRemaining)) / 1e6;
  const treasDelta =
    Number(treasuryBalAfter.value.uiAmount) -
    Number(treasuryBalBefore.value.uiAmount);

  console.log(`\n=== Settlement complete ===`);
  console.log(`Position:`);
  console.log(`  collateral_remaining: $${(Number(positionAfter.collateralRemaining) / 1e6).toFixed(4)} (Δ ${collDelta >= 0 ? "+" : ""}${collDelta.toFixed(4)})`);
  console.log(`  num_settlements_completed: ${positionAfter.numSettlementsCompleted?.toString() ?? "?"}`);
  console.log(`  next_settlement_ts: ${positionAfter.nextSettlementTs.toString()}`);
  console.log(`  last_settled_rate_index: ${positionAfter.lastSettledRateIndex.toString()}`);
  console.log(`  unpaid_pnl: ${positionAfter.unpaidPnl?.toString() ?? "?"}`);
  console.log(`Treasury: ${treasuryBalAfter.value.uiAmountString} USDC (Δ ${treasDelta >= 0 ? "+" : ""}${treasDelta.toFixed(6)})`);
  console.log(`Market lp_vault_balance: ${marketAfter.lpVaultBalance.toString()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
