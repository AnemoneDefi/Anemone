#!/usr/bin/env ts-node
/**
 * One-shot: re-seed the devnet market's rate index with a realistic delta so
 * the displayed APY lands in a normal range (~5%). The setup-devnet.ts seed
 * uses a 0.5% jump over 30s, which annualizes to nonsense.
 *
 * Math: target_apy = 0.05 (5%). delta = target_apy * elapsed / year * prev.
 */
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const DEPLOYER_KEYPAIR =
  process.env.DEPLOYER_KEYPAIR ||
  path.join(os.homedir(), ".config/solana/id.json");
const TARGET_APY_PCT = Number(process.env.TARGET_APY_PCT || "5"); // 5% = 0.05

const idl = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../target/idl/anemone.json"),
    "utf-8",
  ),
);

const deployments = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../deployments/devnet.json"),
    "utf-8",
  ),
);

(async () => {
  const conn = new Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(
    Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync(DEPLOYER_KEYPAIR, "utf-8"))),
    ),
  );
  const provider = new anchor.AnchorProvider(conn, wallet, {
    commitment: "confirmed",
  });
  const program = new anchor.Program(idl, provider) as any;

  const protocolStatePda = new PublicKey(deployments.protocolState);
  const marketPda = new PublicKey(deployments.market);

  const market = await program.account.swapMarket.fetch(marketPda);
  const prevTs = BigInt(market.lastRateUpdateTs.toString());
  const prevIndex = BigInt(market.currentRateIndex.toString());
  const nowTs = BigInt(Math.floor(Date.now() / 1000));
  const elapsed = nowTs - prevTs;

  console.log("current state:");
  console.log("  prevRateIndex   =", market.previousRateIndex.toString());
  console.log("  currentRateIndex=", prevIndex.toString());
  console.log("  lastRateUpdateTs=", prevTs.toString());
  console.log("  now             =", nowTs.toString());
  console.log("  elapsed         =", elapsed.toString(), "seconds");

  if (elapsed < 60n) {
    console.error(
      `elapsed=${elapsed}s is too small. Wait at least 60s after the last setRateIndexOracle and rerun.`,
    );
    process.exit(1);
  }

  // delta = targetApy * (elapsed/year) * prevIndex
  // targetApyPct/100 * elapsed/year * prev = delta
  // Use bigint math; all in same scale as prev (Wad 1e18).
  const SECONDS_PER_YEAR = 31_536_000n;
  const targetApyBps = BigInt(Math.round(TARGET_APY_PCT * 100)); // 5% -> 500 bps
  // delta = targetApyBps * elapsed / 10000 / SECONDS_PER_YEAR * prev
  const delta =
    (targetApyBps * elapsed * prevIndex) / (10_000n * SECONDS_PER_YEAR);
  const newIndex = prevIndex + delta;

  console.log("\nplanning:");
  console.log("  targetApyPct =", TARGET_APY_PCT, "%");
  console.log("  delta (Wad)  =", delta.toString());
  console.log("  newIndex     =", newIndex.toString());

  console.log("\nsending setRateIndexOracle...");
  const tx = await program.methods
    .setRateIndexOracle(new anchor.BN(newIndex.toString()))
    .accountsStrict({
      protocolState: protocolStatePda,
      market: marketPda,
      authority: wallet.publicKey,
    })
    .rpc();
  console.log("tx:", tx);

  const after = await program.account.swapMarket.fetch(marketPda);
  console.log("\nafter:");
  console.log("  prevRateIndex   =", after.previousRateIndex.toString());
  console.log("  currentRateIndex=", after.currentRateIndex.toString());
  console.log("  prevTs          =", after.previousRateUpdateTs.toString());
  console.log("  lastTs          =", after.lastRateUpdateTs.toString());
})();
