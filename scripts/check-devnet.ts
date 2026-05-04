import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Anemone } from "../target/types/anemone";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

async function main() {
  const deployment = JSON.parse(fs.readFileSync("deployments/devnet.json", "utf-8"));
  const deployer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))));
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(deployer), { commitment: "confirmed" });
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync("target/idl/anemone.json", "utf-8"));
  const program = new Program<Anemone>(idl, provider);
  const ps = await program.account.protocolState.fetch(new PublicKey(deployment.protocolState));
  const m = await program.account.swapMarket.fetch(new PublicKey(deployment.market));
  console.log("ProtocolState:");
  console.log(`  authority:       ${ps.authority.toBase58()}`);
  console.log(`  keeper:          ${ps.keeperAuthority.toBase58()}`);
  console.log(`  paused:          ${ps.paused}`);
  console.log("Market:");
  console.log(`  lp_nav:          ${m.lpNav.toNumber() / 1e6} USDC`);
  console.log(`  total_lp_shares: ${m.totalLpShares.toNumber() / 1e6}`);
  console.log(`  previous_index:  ${m.previousRateIndex.toString()}`);
  console.log(`  current_index:   ${m.currentRateIndex.toString()}`);
  console.log(`  last_sync_ts:    ${m.lastKaminoSyncTs.toNumber()}`);
  console.log(`  status:          ${m.status}`);
}
main();
