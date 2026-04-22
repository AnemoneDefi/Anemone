import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { KeeperConfig } from "../config";
import { KeeperClient, adminProgram } from "../client";
import { deriveProtocolPda } from "../utils/pda";
import { logger } from "../utils/logger";

/**
 * Pushes a fresh rate index into the market.
 *
 * On devnet (USE_STUB_ORACLE=true): increments the current rate index linearly
 * using the admin keypair (set_rate_index_oracle). This requires ADMIN_KEYPAIR_PATH.
 *
 * On mainnet/Surfpool (USE_STUB_ORACLE=false): reads the real Kamino Reserve
 * and calls update_rate_index (permissionless).
 */
export async function runUpdateRate(
  client: KeeperClient,
  config: KeeperConfig,
): Promise<void> {
  try {
    if (config.useStubOracle) {
      await runStubOracle(client, config);
    } else {
      await runKaminoRate(client, config);
    }
  } catch (err) {
    logger.error({ err }, "update_rate job failed");
  }
}

async function runStubOracle(
  client: KeeperClient,
  config: KeeperConfig,
): Promise<void> {
  if (!client.adminWallet) {
    throw new Error(
      "USE_STUB_ORACLE=true but ADMIN_KEYPAIR_PATH not configured",
    );
  }

  const market = await (client.program.account as any).swapMarket.fetch(
    config.marketPda,
  );
  const current = BigInt(market.currentRateIndex.toString());
  const next = current > 0n ? current + config.stubRateIncrement : 1_000_000_000_000_000_000n; // seed at 1.0 scaled by 1e18

  const admin = adminProgram(
    client.connection,
    (client.adminWallet as any).payer,
  );
  const protocolPda = deriveProtocolPda(config.programId);

  const sig = await (admin.methods as any)
    .setRateIndexOracle(new BN(next.toString()))
    .accountsStrict({
      protocolState: protocolPda,
      market: config.marketPda,
      authority: client.adminWallet.publicKey,
    })
    .rpc();

  logger.info(
    { nextIndex: next.toString(), sig },
    "stub_oracle: rate index pushed",
  );
}

async function runKaminoRate(
  client: KeeperClient,
  config: KeeperConfig,
): Promise<void> {
  const sig = await (client.program.methods as any)
    .updateRateIndex()
    .accountsStrict({
      market: config.marketPda,
      kaminoReserve: config.kaminoReserve,
    })
    .rpc();

  logger.info({ sig }, "update_rate_index: pushed from Kamino");
}
