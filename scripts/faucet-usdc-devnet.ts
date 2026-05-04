#!/usr/bin/env ts-node
/**
 * Mints test USDC on devnet to any wallet. Reads the devnet deployment
 * from deployments/devnet.json (written by setup-devnet.ts) and uses
 * the deployer as mint authority (deployer keypair kept the mint
 * authority intentionally for devnet — rotates to None on mainnet).
 *
 * Usage:
 *   yarn ts-node scripts/faucet-usdc-devnet.ts <RECIPIENT_PUBKEY> [AMOUNT_USDC]
 *
 * Defaults: 2000 USDC if amount omitted.
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotent,
  mintTo,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const DEPLOYER_KEYPAIR =
  process.env.DEPLOYER_KEYPAIR || path.join(os.homedir(), ".config/solana/id.json");

async function main() {
  const recipientArg = process.argv[2];
  const amountArg = process.argv[3];

  if (!recipientArg) {
    console.error("Usage: yarn ts-node scripts/faucet-usdc-devnet.ts <RECIPIENT_PUBKEY> [AMOUNT_USDC]");
    process.exit(1);
  }

  const recipient = new PublicKey(recipientArg);
  const amountUsdc = amountArg ? Number(amountArg) : 2000;
  const amountRaw = amountUsdc * 1_000_000; // 6 decimals

  const deploymentsPath = path.join(__dirname, "../deployments/devnet.json");
  if (!fs.existsSync(deploymentsPath)) {
    console.error(`deployments/devnet.json not found — run setup-devnet.ts first`);
    process.exit(1);
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentsPath, "utf-8"));
  const usdcMint = new PublicKey(deployment.usdcMint);

  const deployerBytes = JSON.parse(fs.readFileSync(DEPLOYER_KEYPAIR, "utf-8"));
  const deployer = Keypair.fromSecretKey(new Uint8Array(deployerBytes));

  const connection = new Connection(RPC_URL, "confirmed");

  console.log(`Minting ${amountUsdc} USDC to ${recipient.toBase58()}...`);
  const recipientAta = await createAssociatedTokenAccountIdempotent(
    connection,
    deployer,
    usdcMint,
    recipient,
  );
  const tx = await mintTo(
    connection,
    deployer,
    usdcMint,
    recipientAta,
    deployer.publicKey,
    amountRaw,
  );
  console.log(`ATA:      ${recipientAta.toBase58()}`);
  console.log(`Tx:       ${tx}`);
  console.log(`Explorer: https://explorer.solana.com/tx/${tx}?cluster=devnet`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
