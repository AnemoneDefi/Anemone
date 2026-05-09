import { PublicKey } from "@solana/web3.js";
import { KeeperClient } from "../client";
import { KeeperConfig } from "../config";
import {
  deriveLpVaultPda,
  deriveCollateralVaultPda,
  deriveProtocolPda,
} from "../utils/pda";
import { priorityFeeInstructions } from "../utils/priorityFee";
import { logger } from "../utils/logger";
import { fetchAllSafe } from "../utils/programAccounts";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// SwapPosition::SIZE (state/position.rs). Used as the dataSize filter so
// stale layouts left over from previous program versions get excluded at
// the RPC level instead of blowing up the decoder.
const SWAP_POSITION_SIZE = 198;

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
    const positions = await fetchAllSafe<any>(
      client.program,
      "SwapPosition",
      SWAP_POSITION_SIZE,
    );

    const now = Math.floor(Date.now() / 1000);
    // Restrict to positions in the configured market. The protocol treasury
    // is global (one PDA), but the on-chain `token::mint = underlying_mint`
    // constraint means settle only succeeds when the position's market uses
    // the same underlying as the treasury. Positions in other / older
    // markets get skipped here so a stale market doesn't poison every tick.
    const ownMarket = config.marketPda.toBase58();
    const due = positions.filter(
      (p) =>
        isOpen(p.account.status) &&
        p.account.market.toBase58() === ownMarket &&
        p.account.nextSettlementTs.toNumber() <= now,
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

// Anchor decodes a Rust enum into a JS object whose single key is the variant
// name in camelCase. `PositionStatus::Open` → `{ open: {} }`. Checking by
// shape avoids depending on byte-offsets that shift when struct fields change.
function isOpen(status: any): boolean {
  return status != null && typeof status === "object" && "open" in status;
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
    const protocolPda = deriveProtocolPda(config.programId);
    const protocolState = await (client.program.account as any).protocolState.fetch(
      protocolPda,
    );

    const sig = await (client.program.methods as any)
      .settlePeriod()
      .accountsStrict({
        protocolState: protocolPda,
        market,
        swapPosition: position,
        lpVault: deriveLpVaultPda(market, config.programId),
        collateralVault: deriveCollateralVaultPda(market, config.programId),
        treasury: protocolState.treasury,
        underlyingMint: marketAccount.underlyingMint,
        caller: client.keeperWallet.publicKey,
        tokenProgram: TOKEN_PROGRAM,
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
