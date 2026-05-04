/**
 * Patches the USDC mint fixture so mintAuthority matches the local test wallet.
 * This allows minting USDC tokens in localnet tests.
 *
 * SPL Token Mint layout (82 bytes):
 *   [0..4]   mintAuthorityOption (u32): 0 = None, 1 = Some
 *   [4..36]  mintAuthority (32 bytes pubkey)
 *   [36..44] supply (u64)
 *   [44]     decimals (u8)
 *   [45]     isInitialized (bool)
 *   [46..50] freezeAuthorityOption (u32)
 *   [50..82] freezeAuthority (32 bytes pubkey)
 *
 * Run: yarn ts-node tests/scripts/patch_usdc_mint.ts
 */

import * as fs from "fs";
import * as path from "path";
import { Keypair, PublicKey } from "@solana/web3.js";

const RAW_FIXTURE = path.join(__dirname, "../fixtures/usdc_mint.json");
const PATCHED_FIXTURE = path.join(__dirname, "../fixtures/usdc_mint_patched.json");

function getTestWalletPubkey(): PublicKey {
  const arg = process.argv[2];
  if (arg) {
    return new PublicKey(arg);
  }

  // Read from default Solana keypair
  const keypairPath = path.join(
    process.env.HOME || "~",
    ".config/solana/id.json"
  );

  if (!fs.existsSync(keypairPath)) {
    console.error("No keypair found. Run: solana-keygen new");
    process.exit(1);
  }

  const secretKey = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  const keypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));
  return keypair.publicKey;
}

function main() {
  const walletPubkey = getTestWalletPubkey();
  console.log(`Patching USDC mint authority to: ${walletPubkey.toBase58()}`);

  const raw = JSON.parse(fs.readFileSync(RAW_FIXTURE, "utf-8"));
  const data = Buffer.from(raw.account.data[0], "base64");

  // Set mintAuthorityOption = 1 (Some)
  data.writeUInt32LE(1, 0);

  // Set mintAuthority = test wallet pubkey
  walletPubkey.toBuffer().copy(data, 4);

  // Write patched fixture
  raw.account.data[0] = data.toString("base64");
  fs.writeFileSync(PATCHED_FIXTURE, JSON.stringify(raw, null, 2) + "\n");

  console.log(`Patched fixture written to: ${PATCHED_FIXTURE}`);
}

main();
