/**
 * Parses the Kamino USDC Reserve fixture and prints all embedded account addresses
 * needed for localnet test setup (Anchor.toml clones).
 *
 * Run: yarn ts-node tests/scripts/decode_reserve.ts
 */

import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const FIXTURE_PATH = path.join(
  __dirname,
  "../fixtures/kamino_usdc_reserve.json"
);

function main() {
  const raw = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8"));
  const data = Buffer.from(raw.account.data[0], "base64");

  // Reserve layout offsets (verified against mainnet data)
  // Discriminator: 8 bytes
  // version: u64 (8)
  // last_update: 16 bytes (slot u64 + stale u8 + price_status u8 + placeholder [u8;6])
  // lending_market: Pubkey (32) — offset 32
  // farm_collateral: Pubkey (32) — offset 64
  // farm_debt: Pubkey (32) — offset 96
  // liquidity starts at offset 128:
  //   mint_pubkey: Pubkey (32) — offset 128
  //   supply_vault: Pubkey (32) — offset 160
  //   fee_vault: Pubkey (32) — offset 192

  const lendingMarket = new PublicKey(data.subarray(32, 64));
  const liquidityMint = new PublicKey(data.subarray(128, 160));
  const supplyVault = new PublicKey(data.subarray(160, 192));
  const feeVault = new PublicKey(data.subarray(192, 224));

  // ReserveLiquidity size = 1272, padding = 1200, collateral starts at 128 + 1272 + 1200 = 2600
  const COLLATERAL_OFFSET = 2600;
  const collateralMint = new PublicKey(data.subarray(COLLATERAL_OFFSET, COLLATERAL_OFFSET + 32));
  // collateral supply_vault at COLLATERAL_OFFSET + 32 + 8 (after mint_total_supply u64)
  const collateralSupply = new PublicKey(data.subarray(COLLATERAL_OFFSET + 40, COLLATERAL_OFFSET + 72));

  console.log("=== Kamino USDC Reserve — embedded accounts ===\n");
  console.log(`Reserve:              ${raw.pubkey}`);
  console.log(`Lending Market:       ${lendingMarket.toBase58()}`);
  console.log(`Liquidity Mint(USDC): ${liquidityMint.toBase58()}`);
  console.log(`Supply Vault:         ${supplyVault.toBase58()}`);
  console.log(`Fee Vault:            ${feeVault.toBase58()}`);
  console.log(`Collateral Mint:      ${collateralMint.toBase58()}`);
  console.log(`Collateral Supply:    ${collateralSupply.toBase58()}`);

  console.log("\n=== Anchor.toml clone snippets ===\n");
  for (const [label, addr] of [
    ["Lending Market", lendingMarket.toBase58()],
    ["Collateral Mint (k-USDC)", collateralMint.toBase58()],
    ["Supply Vault", supplyVault.toBase58()],
    ["Fee Vault", feeVault.toBase58()],
  ]) {
    console.log(`# ${label}`);
    console.log(`[[test.validator.clone]]`);
    console.log(`address = "${addr}"\n`);
  }
}

main();
