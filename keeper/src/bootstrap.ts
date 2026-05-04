import { loadConfig } from "./config";
import { createClient } from "./client";
import { runUpdateRate } from "./jobs/updateRate";
import { logger } from "./utils/logger";

/**
 * First-run helper. open_swap requires BOTH previous_rate_index and
 * current_rate_index to be > 0. So after a fresh deploy we must push a rate
 * index twice with a gap between — otherwise the very first trader gets
 * RateIndexNotInitialized.
 *
 * Run this ONCE right after a fresh deploy. Re-running is a no-op if the
 * market already has both snapshots populated.
 */
async function main() {
  const config = loadConfig();
  const client = createClient(config);

  const market = await (client.program.account as any).swapMarket.fetch(
    config.marketPda,
  );

  const prev = BigInt(market.previousRateIndex.toString());
  const curr = BigInt(market.currentRateIndex.toString());

  if (prev > 0n && curr > 0n) {
    logger.info({ prev: prev.toString(), curr: curr.toString() }, "bootstrap: market already seeded");
    return;
  }

  logger.info("bootstrap: first update_rate — seeding current");
  await runUpdateRate(client, config);

  const DELAY_MS = 30_000;
  logger.info({ delayMs: DELAY_MS }, "bootstrap: waiting before second update");
  await new Promise((r) => setTimeout(r, DELAY_MS));

  logger.info("bootstrap: second update_rate — rotating previous");
  await runUpdateRate(client, config);

  const after = await (client.program.account as any).swapMarket.fetch(
    config.marketPda,
  );
  logger.info(
    {
      previousRateIndex: after.previousRateIndex.toString(),
      currentRateIndex: after.currentRateIndex.toString(),
    },
    "bootstrap: done — market ready for trades",
  );
}

main().catch((err) => {
  logger.error({ err }, "bootstrap: fatal");
  process.exit(1);
});
