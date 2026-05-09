import cron from "node-cron";
import { loadConfig } from "./config";
import { createClient, KeeperClient } from "./client";
import { KeeperConfig } from "./config";
import { runUpdateRate } from "./jobs/updateRate";
import { runSettlement } from "./jobs/settlement";
import { runLiquidation } from "./jobs/liquidation";
import { runPendingWithdrawals } from "./jobs/pendingWithdrawals";
import { runSyncNav } from "./jobs/syncNav";
import { logger } from "./utils/logger";
import { recordJobSuccess, startHealthServer } from "./utils/health";

type Job = (client: KeeperClient, config: KeeperConfig) => Promise<void>;

async function runTracked(
  name: string,
  job: Job,
  client: KeeperClient,
  config: KeeperConfig,
): Promise<void> {
  try {
    await job(client, config);
    recordJobSuccess(name);
  } catch (err) {
    logger.error({ err, job: name }, "job tick failed");
  }
}

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

  // Health endpoint for cloud hosts (Fly, Railway). PORT defaults to 8080
  // because that's the Fly default; can be overridden in any other host.
  const healthPort = parseInt(process.env.PORT || "8080", 10);
  startHealthServer(healthPort);

  // updateRate: every 3 min (tighter than MAX_STALE_SLOTS ~= 5 min).
  cron.schedule("*/3 * * * *", () => {
    logger.debug("cron: updateRate tick");
    void runTracked("updateRate", runUpdateRate, client, config);
  });

  // settlement: every 10 min. Pops positions whose next_settlement_ts has passed.
  cron.schedule("*/10 * * * *", () => {
    logger.debug("cron: settlement tick");
    void runTracked("settlement", runSettlement, client, config);
  });

  // liquidation: every 5 min. Keeper earns 3% incentive on each successful liquidation.
  cron.schedule("*/5 * * * *", () => {
    logger.debug("cron: liquidation tick");
    void runTracked("liquidation", runLiquidation, client, config);
  });

  // pendingWithdrawals: every 2 min. Detects LPs queued behind a shallow
  // lp_vault and refills via withdraw_from_kamino when needed.
  cron.schedule("*/2 * * * *", () => {
    logger.debug("cron: pendingWithdrawals tick");
    void runTracked("pendingWithdrawals", runPendingWithdrawals, client, config);
  });

  // syncNav: every 5 min. Keeps market.last_kamino_sync_ts under the
  // MAX_NAV_STALENESS_SECS gate so user-facing LP ops don't have to bundle
  // sync themselves during normal operation.
  cron.schedule("*/5 * * * *", () => {
    logger.debug("cron: syncNav tick");
    void runTracked("syncNav", runSyncNav, client, config);
  });

  // Run all jobs once on startup so we don't wait for the first cron tick.
  await runTracked("updateRate", runUpdateRate, client, config);
  await runTracked("settlement", runSettlement, client, config);
  await runTracked("liquidation", runLiquidation, client, config);
  await runTracked("pendingWithdrawals", runPendingWithdrawals, client, config);
  await runTracked("syncNav", runSyncNav, client, config);

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
