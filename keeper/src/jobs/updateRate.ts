import { BN } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { Reserve } from "@kamino-finance/klend-sdk";
import { KeeperConfig } from "../config";
import { KeeperClient, adminProgram } from "../client";
import { deriveProtocolPda } from "../utils/pda";
import { priorityFeeInstructions } from "../utils/priorityFee";
import { logger } from "../utils/logger";

/**
 * Pushes a fresh rate index into the market. Three modes:
 *
 *  1. Stub linear (USE_STUB_ORACLE=true, BRIDGE_MAINNET_RPC_URL unset):
 *     increments the current rate index linearly via set_rate_index_oracle.
 *     Useful for early dev when no Kamino is in the picture.
 *
 *  2. Mainnet bridge (USE_STUB_ORACLE=true, BRIDGE_MAINNET_RPC_URL set):
 *     reads the real Kamino USDC Reserve via the mainnet RPC, extracts
 *     cumulative_borrow_rate_bsf, and pushes that exact value through
 *     set_rate_index_oracle on the local cluster. Lets a public devnet
 *     deployment show real Kamino rate evolution without needing the
 *     Kamino program itself to exist there.
 *
 *  3. Real CPI (USE_STUB_ORACLE=false): calls update_rate_index permission-
 *     lessly, which does the Kamino CPI directly. The mainnet path.
 */
export async function runUpdateRate(
  client: KeeperClient,
  config: KeeperConfig,
): Promise<void> {
  try {
    if (config.useStubOracle) {
      if (config.bridgeMainnetRpcUrl) {
        await runMainnetBridge(client, config);
      } else {
        await runStubOracle(client, config);
      }
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

  await pushRateIndex(client, config, next, "stub_oracle");
}

async function runMainnetBridge(
  client: KeeperClient,
  config: KeeperConfig,
): Promise<void> {
  if (!client.adminWallet) {
    throw new Error(
      "BRIDGE_MAINNET_RPC_URL set but ADMIN_KEYPAIR_PATH not configured",
    );
  }

  const mainnetConn = new Connection(config.bridgeMainnetRpcUrl!, "confirmed");
  const reserveAcc = await mainnetConn.getAccountInfo(config.kaminoReserve);
  if (!reserveAcc) {
    throw new Error(
      `Kamino USDC Reserve ${config.kaminoReserve.toBase58()} not found via ${config.bridgeMainnetRpcUrl}`,
    );
  }

  // Decode via Kamino SDK so we get the same struct layout as our Rust crate
  // pin (kamino-lend = "=0.4.1"). bsf.value is [u64;4] little-endian; we read
  // the lower 128 bits to match programs/anemone/src/helpers/kamino.rs.
  const reserve = Reserve.decode(reserveAcc.data);
  const bsf = (reserve.liquidity as any).cumulativeBorrowRateBsf;
  const lower = BigInt(bsf.value[0].toString());
  const upper = BigInt(bsf.value[1].toString()) << 64n;
  const rateIndex = lower | upper;

  if (rateIndex === 0n) {
    throw new Error("Kamino reserve returned cumulative_borrow_rate_bsf == 0");
  }

  await pushRateIndex(client, config, rateIndex, "mainnet_bridge");
}

async function pushRateIndex(
  client: KeeperClient,
  config: KeeperConfig,
  rateIndex: bigint,
  source: "stub_oracle" | "mainnet_bridge",
): Promise<void> {
  const admin = adminProgram(
    client.connection,
    (client.adminWallet as any).payer,
  );
  const protocolPda = deriveProtocolPda(config.programId);

  const sig = await (admin.methods as any)
    .setRateIndexOracle(new BN(rateIndex.toString()))
    .accountsStrict({
      protocolState: protocolPda,
      market: config.marketPda,
      authority: client.adminWallet!.publicKey,
    })
    .preInstructions(priorityFeeInstructions(config.priorityFeeMicrolamports))
    .rpc();

  logger.info(
    { source, nextIndex: rateIndex.toString(), sig },
    "rate index pushed",
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
    .preInstructions(priorityFeeInstructions(config.priorityFeeMicrolamports))
    .rpc();

  logger.info({ sig }, "update_rate_index: pushed from Kamino");
}
