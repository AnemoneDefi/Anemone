/**
 * Finds the byte offset of cumulative_borrow_rate_bsf in the Kamino Reserve account data.
 * We use this to replace the kamino-lend crate dependency with direct byte reading.
 *
 * Run: yarn ts-node tests/scripts/find_rate_offset.ts
 */
import { Reserve } from "@kamino-finance/klend-sdk";
import * as fs from "fs";
import * as path from "path";

const FIXTURE_PATH = path.join(
  __dirname,
  "../../tests/fixtures/kamino_usdc_reserve.json"
);

function main() {
  const raw = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8"));
  const data = Buffer.from(raw.account.data[0], "base64");

  const reserve = Reserve.decode(data)!;
  const bsf = reserve.liquidity.cumulativeBorrowRateBsf;
  // bsf.value is [BN, BN, BN, BN] representing [u64; 4]
  const val0 = BigInt((bsf as any).value[0].toString());
  const val1 = BigInt((bsf as any).value[1].toString());

  console.log("cumulativeBorrowRateBsf.value[0]:", val0.toString());
  console.log("cumulativeBorrowRateBsf.value[1]:", val1.toString());

  // Search for value[0] as little-endian u64 bytes in the account data
  const target = Buffer.alloc(8);
  const lo = val0 & 0xFFFFFFFFn;
  const hi = (val0 >> 32n) & 0xFFFFFFFFn;
  target.writeUInt32LE(Number(lo), 0);
  target.writeUInt32LE(Number(hi), 4);

  console.log("\nSearching for bytes:", target.toString("hex"));

  for (let i = 0; i <= data.length - 8; i++) {
    if (data.subarray(i, i + 8).equals(target)) {
      // Also verify value[1] follows immediately
      const next = Buffer.alloc(8);
      const lo1 = val1 & 0xFFFFFFFFn;
      const hi1 = (val1 >> 32n) & 0xFFFFFFFFn;
      next.writeUInt32LE(Number(lo1), 0);
      next.writeUInt32LE(Number(hi1), 4);

      if (data.subarray(i + 8, i + 16).equals(next)) {
        console.log(`\n✓ Found cumulativeBorrowRateBsf at byte offset: ${i}`);
        console.log(`  (discriminator 8 bytes + struct offset = ${i})`);
        console.log(`\nIn Rust: &account_data[${i}..${i + 32}] → [u64; 4]`);
        return;
      }
    }
  }

  console.log("Not found — the value might be zero or stored differently");
}

main();
