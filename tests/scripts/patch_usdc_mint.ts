/**
 * Patches the USDC mint account from mainnet so that the mintAuthority
 * is set to the local test wallet, allowing tokens to be minted in tests.
 *
 * SPL Token Mint layout (82 bytes):
 *   [0..4]   mintAuthorityOption (u32): 0 = None, 1 = Some
 *   [4..36]  mintAuthority (32 bytes pubkey, only valid if option == 1)
 *   [36..44] supply (u64)
 *   [44]     decimals (u8)
 *   [45]     isInitialized (bool)
 *   [46..50] freezeAuthorityOption (u32)
 *   [50..82] freezeAuthority (32 bytes pubkey)
 *
 * Run: yarn ts-node tests/scripts/patch_usdc_mint.ts <TEST_WALLET_PUBKEY>
 * Or:  yarn ts-node tests/scripts/patch_usdc_mint.ts  (uses ~/.config/solana/id.json)
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { Keypair, PublicKey } from "@solana/web3.js";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RAW_FIXTURE = path.join(__dirname, "../../tests/fixtures/usdc_mint.json");
const PATCHED_FIXTURE = path.join(__dirname, "../../tests/fixtures/usdc_mint_patched.json");

function getTestWalletPubkey(): PublicKey {
  const arg = process.argv[2];
  if (arg) {
    return new PublicKey(arg);
  }
  const keyPath = path.join(process.env.HOME!, ".config/solana/id.json");
  const keypair = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(fs.readFileSync(keyPath, "utf-8")))
  );
  return keypair.publicKey;
}

async function main() {
  // 1. Dump the USDC mint from mainnet if not already done
  if (!fs.existsSync(RAW_FIXTURE)) {
    console.log(`Dumping USDC mint from mainnet-beta...`);
    execSync(
      `solana account ${USDC_MINT} --url mainnet-beta --output json > ${RAW_FIXTURE}`,
      { stdio: "inherit" }
    );
    console.log(`Saved to ${RAW_FIXTURE}`);
  } else {
    console.log(`Using existing dump at ${RAW_FIXTURE}`);
  }

  // 2. Preserve rentEpoch as a raw integer string before JSON.parse loses precision.
  //    u64::MAX (18446744073709551615) exceeds Number.MAX_SAFE_INTEGER, so JS would
  //    serialize it back as scientific notation which the test validator rejects.
  const rawStr = fs.readFileSync(RAW_FIXTURE, "utf-8");
  const rentEpochMatch = rawStr.match(/"rentEpoch"\s*:\s*(\d+)/);
  const rentEpochLiteral = rentEpochMatch ? rentEpochMatch[1] : "0";

  const raw = JSON.parse(rawStr);
  const data = Buffer.from(raw.account.data[0], "base64");

  const testWallet = getTestWalletPubkey();
  console.log(`Patching mintAuthority → ${testWallet.toBase58()}`);

  // Set mintAuthorityOption = 1 (Some)
  data.writeUInt32LE(1, 0);
  // Write pubkey bytes at offset 4..36
  testWallet.toBuffer().copy(data, 4);

  // Re-encode and save
  const patched = {
    ...raw,
    account: {
      ...raw.account,
      data: [data.toString("base64"), "base64"],
    },
  };

  // JSON.stringify then restore rentEpoch to exact integer literal (avoids float precision loss)
  let jsonStr = JSON.stringify(patched, null, 2);
  jsonStr = jsonStr.replace(
    /"rentEpoch"\s*:\s*[^\n,}]+/,
    `"rentEpoch": ${rentEpochLiteral}`
  );

  fs.writeFileSync(PATCHED_FIXTURE, jsonStr);
  console.log(`Patched fixture saved to ${PATCHED_FIXTURE}`);
  console.log(`\nmintAuthority: ${new PublicKey(data.subarray(4, 36)).toBase58()}`);
  console.log(`decimals:      ${data[44]}`);
  console.log(`rentEpoch:     ${rentEpochLiteral}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
