import { KeeperClient } from "../client";
import { KeeperConfig } from "../config";
import { priorityFeeInstructions } from "../utils/priorityFee";
import { logger } from "../utils/logger";

/**
 * Periodic NAV refresh. Calls `sync_kamino_yield` on the market so
 * user-facing LP handlers (deposit_liquidity, request_withdrawal,
 * claim_withdrawal) stay within MAX_NAV_STALENESS_SECS without the caller
 * having to bundle a sync of their own.
 *
 * On devnet (USE_STUB_ORACLE=true) this just bumps `last_kamino_sync_ts`
 * on-chain — there is no Kamino to read, but the timestamp update is
 * what the staleness gate cares about.
 */
export async function runSyncNav(
  client: KeeperClient,
  config: KeeperConfig,
): Promise<void> {
  try {
    const sig = await (client.program.methods as any)
      .syncKaminoYield()
      .accountsStrict({
        market: config.marketPda,
      })
      .preInstructions(priorityFeeInstructions(config.priorityFeeMicrolamports))
      .rpc();

    logger.info({ sig }, "syncNav: NAV timestamp refreshed");
  } catch (err) {
    logger.error({ err }, "syncNav job failed");
  }
}
