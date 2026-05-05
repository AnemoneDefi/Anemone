/**
 * Bumps current_rate_index via set_rate_index_oracle (dev-tools instr) so the
 * NEXT open_swap quotes a target variable APY and passes the
 * MAX_QUOTE_STALENESS_SECS check.
 *
 * Handles surfpool's quirky chain-time vs last_rate_update_ts discrepancy by
 * time-travelling FORWARD past the existing last_rate_update_ts before bumping,
 * so the resulting `elapsed` is positive and bump direction is monotonic.
 *
 * Usage:
 *   yarn ts-node scripts/bump-rate-oracle.ts [target_apy_bps]
 *   yarn ts-node scripts/bump-rate-oracle.ts 800   # 8% APY (default)
 */
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet, BN } from "@coral-xyz/anchor";
import { readFileSync } from "fs";
import os from "os";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const PROGRAM_ID = new PublicKey("KQs6ci5FtedFKPVJThAZSMMXyosK4TvnF7kcDSx5Jwd");
const ELAPSED_SECONDS = 60n; // window between previous_rate_update_ts and last_rate_update_ts after rotation
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
  const targetBps = BigInt(process.argv[2] ?? "800");
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

  const markets = await program.account.swapMarket.all();
  const market = markets[0];
  const marketPda = market.publicKey;

  const oldCurrent = BigInt(market.account.currentRateIndex.toString());
  const oldPrev = BigInt(market.account.previousRateIndex.toString());
  const oldLast = BigInt(market.account.lastRateUpdateTs.toString());

  console.log(`Current state:`);
  console.log(`  previous_rate_index: ${oldPrev.toString()}`);
  console.log(`  current_rate_index:  ${oldCurrent.toString()}`);
  console.log(`  last_rate_update_ts: ${oldLast.toString()}`);

  // Surfpool's getBlockTime can lag the actual Clock::get() at tx execution by
  // tens of thousands of seconds after multiple time-travels. Don't trust it
  // for bump sizing. Instead, use empirical observation: between 2 consecutive
  // set_rate_index_oracle calls surfpool drifts ~300s of chain time. Try to
  // time-travel forward to oldLast + EXTRA, but if rejected (chain already past
  // that), the drift will still land us a few hundred seconds past oldLast.
  const target = oldLast + ELAPSED_SECONDS;
  console.log(`\n[1/2] timeTravel → ${target.toString()} (oldLast + ${ELAPSED_SECONDS}s, may be rejected if chain already further)`);
  const tt = await timeTravel(Number(target) * 1000);
  console.log(`       result: ${JSON.stringify(tt.result ?? tt.error)}`);

  const estimatedElapsed = ELAPSED_SECONDS; // typical observed elapsed; if surfpool drifted further, APY ends up smaller
  console.log(`       sizing bump for elapsed = ${estimatedElapsed.toString()}s (actual may be larger)`);

  // Compute bump from oldCurrent (which becomes new_previous after rotation)
  const bump = (oldCurrent * targetBps * estimatedElapsed) / (10_000n * SECONDS_PER_YEAR);
  // Ensure new_current > old_current (monotonic — protects future settle calls)
  const newIndex = oldCurrent + bump;

  console.log(`\n[2/2] set_rate_index_oracle (target ${Number(targetBps)/100}% APY over ${estimatedElapsed.toString()}s)`);
  console.log(`       new_current: ${newIndex.toString()} (+${bump.toString()})`);

  const tx = await program.methods
    .setRateIndexOracle(new BN(newIndex.toString()))
    .accountsStrict({
      protocolState: protocolStatePda,
      market: marketPda,
      authority: kp.publicKey,
    })
    .rpc();
  console.log(`       tx: ${tx}`);

  const after = await program.account.swapMarket.fetch(marketPda);
  const newPrev = BigInt(after.previousRateIndex.toString());
  const newCurr = BigInt(after.currentRateIndex.toString());
  const newLast = BigInt(after.lastRateUpdateTs.toString());
  const newPrevTs = BigInt(after.previousRateUpdateTs.toString());
  const realElapsed = newLast - newPrevTs;
  const realDelta = newCurr - newPrev;
  const realApyBps =
    realElapsed > 0n
      ? (realDelta * 10_000n * SECONDS_PER_YEAR) / (newPrev * realElapsed)
      : 0n;

  console.log(`\n=== After ===`);
  console.log(`  previous_rate_index: ${newPrev.toString()}`);
  console.log(`  current_rate_index:  ${newCurr.toString()}`);
  console.log(`  last_rate_update_ts: ${newLast.toString()}`);
  console.log(`  current > previous: ${newCurr > newPrev ? "OK" : "BROKEN"}`);
  console.log(`  ACTUAL elapsed:     ${realElapsed.toString()}s`);
  console.log(`  ACTUAL quoted APY:  ${(Number(realApyBps) / 100).toFixed(2)}%  (target was ${Number(targetBps) / 100}%)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
