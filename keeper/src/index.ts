import cron from "node-cron";
import { loadConfig } from "./config";
import { createClient } from "./client";
import { runUpdateRate } from "./jobs/updateRate";
import { runSettlement } from "./jobs/settlement";
import { runLiquidation } from "./jobs/liquidation";
import { runPendingWithdrawals } from "./jobs/pendingWithdrawals";
import { logger } from "./utils/logger";

async function main() {
  const config = loadConfig();
  const client = createClient(config);

  logger.info(
    {
      rpcUrl: config.rpcUrl,
      programId: config.programId.toBase58(),
      marketPda: config.marketPda.toBase58(),
      keeper: client.keeperWallet.publicKey.toBase58(),
      useStubOracle: config.useStubOracle,
    },
    "keeper: starting",
  );

  // updateRate: every 3 min (tighter than MAX_STALE_SLOTS ~= 5 min).
  cron.schedule("*/3 * * * *", () => {
    logger.debug("cron: updateRate tick");
    void runUpdateRate(client, config);
  });

  // settlement: every 10 min. Pops positions whose next_settlement_ts has passed.
  cron.schedule("*/10 * * * *", () => {
    logger.debug("cron: settlement tick");
    void runSettlement(client, config);
  });

  // liquidation: every 5 min. Keeper earns 3% incentive on each successful liquidation.
  cron.schedule("*/5 * * * *", () => {
    logger.debug("cron: liquidation tick");
    void runLiquidation(client, config);
  });

  // pendingWithdrawals: every 2 min. Detects LPs queued behind a shallow
  // lp_vault and refills via withdraw_from_kamino when needed.
  cron.schedule("*/2 * * * *", () => {
    logger.debug("cron: pendingWithdrawals tick");
    void runPendingWithdrawals(client, config);
  });

  // Run all jobs once on startup so we don't wait for the first cron tick.
  await runUpdateRate(client, config);
  await runSettlement(client, config);
  await runLiquidation(client, config);
  await runPendingWithdrawals(client, config);

  logger.info("keeper: ready (cron scheduled)");

  // Graceful shutdown
  process.on("SIGTERM", () => {
    logger.info("keeper: SIGTERM received, exiting");
    process.exit(0);
  });
  process.on("SIGINT", () => {
    logger.info("keeper: SIGINT received, exiting");
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error({ err }, "keeper: fatal");
  process.exit(1);
});
