/**
 * Parses the Kamino USDC Reserve fixture and prints all embedded account addresses
 * needed for localnet test setup (Anchor.toml clones).
 *
 * Run: yarn ts-node tests/scripts/decode_reserve.ts
 */

import { PublicKey } from "@solana/web3.js";
import { Reserve } from "@kamino-finance/klend-sdk";
import * as fs from "fs";
import * as path from "path";

const FIXTURE_PATH = path.join(
  __dirname,
  "../../tests/fixtures/kamino_usdc_reserve.json"
);

async function main() {
  const raw = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8"));
  const accountData = Buffer.from(raw.account.data[0], "base64");

  // Reserve discriminator is 8 bytes — skip it, then deserialize
  const reserve = Reserve.decode(accountData);

  if (!reserve) {
    throw new Error("Failed to decode Reserve — check SDK version vs fixture");
  }

  console.log("=== Kamino USDC Reserve — embedded accounts ===\n");

  const lendingMarket = reserve.lendingMarket as string;
  const collateralMint = reserve.collateral.mintPubkey as string;
  const supplyVault = reserve.liquidity.supplyVault as string;
  const feeVault = reserve.liquidity.feeVault as string;

  console.log(`Lending Market:       ${lendingMarket}`);
  console.log(`kUSDC Mint:           ${collateralMint}`);
  console.log(`USDC Supply Vault:    ${supplyVault}`);
  console.log(`Fee Vault:            ${feeVault}`);

  console.log("\n=== Anchor.toml snippets ===\n");
  for (const [label, addr] of [
    ["kUSDC Mint", collateralMint],
    ["USDC Supply Vault", supplyVault],
    ["Fee Vault", feeVault],
  ]) {
    console.log(`# ${label}`);
    console.log(`[[test.validator.clone]]`);
    console.log(`address = "${addr}"\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
