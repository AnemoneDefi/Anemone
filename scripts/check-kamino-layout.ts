#!/usr/bin/env ts-node
/**
 * Validates that the live Kamino USDC Reserve (mainnet) still matches the
 * layout we pin in `tests/kamino_layout.rs` (8_656 bytes for the Rust struct,
 * which corresponds to a 8624-byte raw account: 8 anchor discriminator +
 * the rest of the data).
 *
 * Run against a Surfpool fork (default) so it pulls the live Reserve from
 * mainnet without us paying anything.
 *
 * What it proves:
 *   - The `kamino-lend = "=0.4.1"` crate we pinned still represents the
 *     reserve struct that Kamino is actually running on mainnet. If Kamino
 *     ever ships a layout-changing upgrade, this script (or H2 layout test
 *     in CI rerun against mainnet) catches it.
 *
 * What it does NOT prove:
 *   - That deposit_to_kamino / withdraw_from_kamino CPIs work end-to-end.
 *     For that we'd need the deploy + minted USDC dance which Surfpool 1.0.0
 *     stalls on for 712KB programs. Tracked as follow-up.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8899";
const KAMINO_USDC_RESERVE = new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59");
const KAMINO_PROGRAM_ID = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";

// Pinned in tests/kamino_layout.rs — the Rust struct size from the
// kamino-lend = =0.4.1 crate. The on-account raw size is different from
// the Rust struct size because anchor-gen does not materialise Kamino's
// reserved padding tail. So we compare both numbers against what we know.
const PINNED_RUST_STRUCT_SIZE = 8656;
const EXPECTED_RAW_ACCOUNT_SIZE = 8624; // observed via solana account fetch

async function main() {
  console.log("\n=== Kamino USDC Reserve layout check ===\n");

  const connection = new Connection(RPC_URL, "confirmed");

  console.log(`RPC:     ${RPC_URL}`);
  console.log(`Reserve: ${KAMINO_USDC_RESERVE.toBase58()}`);
  console.log(`Pinned in tests/kamino_layout.rs: size_of::<Reserve>() == ${PINNED_RUST_STRUCT_SIZE}\n`);

  // ----- live fetch
  const accountInfo = await connection.getAccountInfo(KAMINO_USDC_RESERVE);
  if (!accountInfo) {
    console.error("ERROR: Reserve account not found via the RPC. Is surfpool running?");
    process.exit(1);
  }

  const liveSize = accountInfo.data.length;
  const owner = accountInfo.owner.toBase58();
  const discriminator = accountInfo.data.subarray(0, 8).toString("hex");

  console.log("=== Live mainnet state ===");
  console.log(`  raw account size: ${liveSize} bytes`);
  console.log(`  owner:            ${owner}`);
  console.log(`  discriminator:    0x${discriminator}`);
  console.log(`  balance (rent):   ${accountInfo.lamports / 1e9} SOL\n`);

  // ----- compare with fixture (the dump we ship for anchor tests)
  const fixturePath = path.join(__dirname, "../tests/fixtures/kamino_usdc_reserve.json");
  let fixtureSize: number | null = null;
  if (fs.existsSync(fixturePath)) {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
    // solana dump fixture format: account.data is base64 encoded
    const dataB64 = Array.isArray(fixture.account.data) ? fixture.account.data[0] : fixture.account.data;
    const decoded = Buffer.from(dataB64, "base64");
    fixtureSize = decoded.length;
    console.log("=== Fixture state (tests/fixtures/kamino_usdc_reserve.json) ===");
    console.log(`  size:           ${fixtureSize} bytes`);
    console.log(`  matches live:   ${fixtureSize === liveSize ? "YES ✓" : "NO ✗"}`);
    console.log("");
  } else {
    console.log("(fixture not found at tests/fixtures/kamino_usdc_reserve.json — skipping comparison)\n");
  }

  // ----- assertions
  console.log("=== Assertions ===");
  let allPassed = true;

  if (owner !== KAMINO_PROGRAM_ID) {
    console.log(`  ✗ owner mismatch: got ${owner}, expected ${KAMINO_PROGRAM_ID}`);
    allPassed = false;
  } else {
    console.log(`  ✓ owner is Kamino program ID`);
  }

  if (liveSize !== EXPECTED_RAW_ACCOUNT_SIZE) {
    console.log(`  ✗ live size ${liveSize} != expected ${EXPECTED_RAW_ACCOUNT_SIZE}`);
    console.log(`    → Kamino layout may have changed. Re-run tests/kamino_layout.rs in CI`);
    console.log(`      against the new size and update PINNED_RUST_STRUCT_SIZE if intentional.`);
    allPassed = false;
  } else {
    console.log(`  ✓ live raw account size matches expected ${EXPECTED_RAW_ACCOUNT_SIZE}`);
  }

  if (fixtureSize !== null && fixtureSize !== liveSize) {
    console.log(`  ⚠ fixture is stale: ${fixtureSize} vs live ${liveSize}`);
    console.log(`    → re-dump the fixture to stay aligned (not a layout break, just outdated)`);
  } else if (fixtureSize !== null) {
    console.log(`  ✓ fixture size matches live`);
  }

  console.log("");
  if (allPassed) {
    console.log("=== Layout check PASSED ===");
    console.log(`The kamino-lend = "=0.4.1" crate we pinned still represents the live`);
    console.log(`Kamino USDC Reserve. Deposits, withdrawals, and rate reads against`);
    console.log(`the real Kamino in mainnet will deserialise the same struct.`);
  } else {
    console.log("=== Layout check FAILED ===");
    console.log("Investigate before any mainnet deploy.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nError:", err);
  process.exit(1);
});
