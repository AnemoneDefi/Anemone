import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { KeeperClient } from "../client";
import { KeeperConfig } from "../config";
import { deriveLpVaultPda, deriveCollateralVaultPda } from "../utils/pda";
import { priorityFeeInstructions } from "../utils/priorityFee";
import { logger } from "../utils/logger";

// Offset of the `status` field in the SwapPosition account, measured from
// the start of the account data (after the 8-byte discriminator).
// Anchor serializes fields in declaration order; see state/position.rs.
//
// Layout: 8 (disc) + 32 (owner) + 32 (market) + 1 (direction) + 8 (notional)
//       + 8 (fixed_rate_bps) + 8 (collateral_deposited)
//       + 8 (collateral_remaining) + 16 (entry_rate_index)
//       + 16 (last_settled_rate_index) + 8 (realized_pnl) + 2 (num_settlements)
//       + 8 (open_ts) + 8 (maturity_ts) + 8 (next_settlement_ts)
//       + 8 (last_settlement_ts) = offset 177 for status
const STATUS_OFFSET = 177;
const STATUS_OPEN = 0;

/**
 * Fetches every Open SwapPosition whose next_settlement_ts has passed, then
 * calls settle_period on each. Failures on a single position are logged and
 * skipped so one bad position doesn't stop the whole batch.
 */
export async function runSettlement(
  client: KeeperClient,
  config: KeeperConfig,
): Promise<void> {
  try {
    const positions = await (client.program.account as any).swapPosition.all([
      {
        memcmp: {
          offset: STATUS_OFFSET,
          bytes: bs58.encode(Buffer.from([STATUS_OPEN])),
        },
      },
    ]);

    const now = Math.floor(Date.now() / 1000);
    const due = positions.filter(
      (p: any) => p.account.nextSettlementTs.toNumber() <= now,
    );

    if (due.length === 0) {
      logger.debug("settlement: no positions due");
      return;
    }

    logger.info({ count: due.length }, "settlement: processing due positions");

    for (const { publicKey, account } of due) {
      await settleOne(client, config, publicKey, account.market);
    }
  } catch (err) {
    logger.error({ err }, "settlement job failed");
  }
}

async function settleOne(
  client: KeeperClient,
  config: KeeperConfig,
  position: PublicKey,
  market: PublicKey,
): Promise<void> {
  try {
    const marketAccount = await (client.program.account as any).swapMarket.fetch(
      market,
    );

    const sig = await (client.program.methods as any)
      .settlePeriod()
      .accountsStrict({
        market,
        swapPosition: position,
        lpVault: deriveLpVaultPda(market, config.programId),
        collateralVault: deriveCollateralVaultPda(market, config.programId),
        underlyingMint: marketAccount.underlyingMint,
        caller: client.keeperWallet.publicKey,
        tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      })
      .preInstructions(priorityFeeInstructions(config.priorityFeeMicrolamports))
      .rpc();

    logger.info(
      { position: position.toBase58(), sig },
      "settlement: settled",
    );
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (msg.includes("SettlementNotDue")) {
      logger.debug({ position: position.toBase58() }, "settlement: not due yet");
    } else {
      logger.error({ err: msg, position: position.toBase58() }, "settlement: failed");
    }
  }
}
