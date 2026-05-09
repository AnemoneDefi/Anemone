import { PublicKey } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotent,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { KeeperClient } from "../client";
import { KeeperConfig } from "../config";
import { deriveProtocolPda, deriveCollateralVaultPda, deriveLpVaultPda } from "../utils/pda";
import { calculateMaintenanceMargin } from "../utils/margin";
import { priorityFeeInstructions } from "../utils/priorityFee";
import { logger } from "../utils/logger";
import { fetchAllSafe } from "../utils/programAccounts";

const SWAP_POSITION_SIZE = 198; // see settlement.ts for source of truth
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/**
 * For each Open position, compares collateral_remaining against its
 * maintenance margin (computed off-chain). If underwater, calls
 * liquidate_position — the keeper receives 3% as incentive.
 */
export async function runLiquidation(
  client: KeeperClient,
  config: KeeperConfig,
): Promise<void> {
  try {
    const positions = await fetchAllSafe<any>(
      client.program,
      "SwapPosition",
      SWAP_POSITION_SIZE,
    );

    // Same market scope as settlement — the keeper liquidates only the
    // market it is configured for. Cross-market liquidation would require
    // looking up each position's market account separately.
    const ownMarket = config.marketPda.toBase58();
    const open = positions.filter(
      (p) =>
        isOpen(p.account.status) &&
        p.account.market.toBase58() === ownMarket,
    );

    for (const { publicKey, account } of open) {
      await tryLiquidate(client, config, publicKey, account);
    }
  } catch (err) {
    logger.error({ err }, "liquidation job failed");
  }
}

function isOpen(status: any): boolean {
  return status != null && typeof status === "object" && "open" in status;
}

async function tryLiquidate(
  client: KeeperClient,
  config: KeeperConfig,
  position: PublicKey,
  account: any,
): Promise<void> {
  try {
    const marketAccount = await (client.program.account as any).swapMarket.fetch(
      account.market,
    );

    const notional = BigInt(account.notional.toString());
    const tenor = BigInt(marketAccount.tenorSeconds.toString());
    const mm = calculateMaintenanceMargin(notional, tenor);
    const collateral = BigInt(account.collateralRemaining.toString());

    if (collateral >= mm) {
      return; // healthy, skip
    }

    logger.info(
      { position: position.toBase58(), collateral: collateral.toString(), mm: mm.toString() },
      "liquidation: position below MM — liquidating",
    );

    const keeperAta = getAssociatedTokenAddressSync(
      marketAccount.underlyingMint,
      client.keeperWallet.publicKey,
    );
    const ownerAta = getAssociatedTokenAddressSync(
      marketAccount.underlyingMint,
      account.owner,
    );

    // Make sure both ATAs exist. Keeper creates them if missing (owner too — it's
    // idempotent and only costs rent on the first liquidation for that owner).
    await createAssociatedTokenAccountIdempotent(
      client.connection,
      (client.keeperWallet as any).payer,
      marketAccount.underlyingMint,
      client.keeperWallet.publicKey,
    );
    await createAssociatedTokenAccountIdempotent(
      client.connection,
      (client.keeperWallet as any).payer,
      marketAccount.underlyingMint,
      account.owner,
    );

    const sig = await (client.program.methods as any)
      .liquidatePosition()
      .accountsStrict({
        protocolState: deriveProtocolPda(config.programId),
        market: account.market,
        swapPosition: position,
        lpVault: deriveLpVaultPda(account.market, config.programId),
        collateralVault: deriveCollateralVaultPda(account.market, config.programId),
        owner: account.owner,
        ownerTokenAccount: ownerAta,
        liquidatorTokenAccount: keeperAta,
        underlyingMint: marketAccount.underlyingMint,
        liquidator: client.keeperWallet.publicKey,
        tokenProgram: TOKEN_PROGRAM,
      })
      .preInstructions(priorityFeeInstructions(config.priorityFeeMicrolamports))
      .rpc();

    logger.info(
      { position: position.toBase58(), sig },
      "liquidation: position liquidated",
    );
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (msg.includes("AboveMaintenanceMargin")) {
      // Race: position was already re-settled above MM between fetch and tx
      logger.debug({ position: position.toBase58() }, "liquidation: raced, skip");
    } else {
      logger.error({ err: msg, position: position.toBase58() }, "liquidation: failed");
    }
  }
}
