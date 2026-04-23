import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { getAccount } from "@solana/spl-token";
import { KeeperClient } from "../client";
import { KeeperConfig } from "../config";
import { deriveLpVaultPda } from "../utils/pda";
import { logger } from "../utils/logger";

// Offset of `status` in LpPosition. Layout:
//   8 (disc) + 1 (is_initialized) + 32 (owner) + 32 (market)
// + 8 (shares) + 8 (deposited_amount) = 89
const STATUS_OFFSET_LP = 89;
const STATUS_PENDING = 1; // LpStatus::PendingWithdrawal

// Safety buffer on shortfall — we ask Kamino to return slightly more USDC
// than strictly needed, so any newly-queued withdrawal that lands between
// this tick and the next can also be paid without a second round-trip.
const SAFETY_BUFFER_BPS = 500n; // 5%
const BPS_DIVISOR = 10_000n;

/**
 * Scans for LP positions stuck in PendingWithdrawal status and, when the
 * lp_vault is too shallow to pay them all, instructs Kamino to redeem
 * k-tokens back into USDC.
 *
 * On devnet with USE_STUB_ORACLE=true there is no Kamino integration —
 * the vault always holds all LP USDC and the queue path never triggers.
 * The job still runs (logs a no-op) so the same binary works in both modes.
 */
export async function runPendingWithdrawals(
  client: KeeperClient,
  config: KeeperConfig,
): Promise<void> {
  try {
    const pending = await (client.program.account as any).lpPosition.all([
      {
        memcmp: {
          offset: STATUS_OFFSET_LP,
          bytes: bs58.encode(Buffer.from([STATUS_PENDING])),
        },
      },
    ]);

    if (pending.length === 0) {
      logger.debug("pending-withdrawals: none queued");
      return;
    }

    // Group by market. In MVP there is only one, but keeping the shape
    // market-agnostic so multi-market deployments work without changes.
    const byMarket = new Map<string, typeof pending>();
    for (const p of pending) {
      const key = p.account.market.toBase58();
      const bucket = byMarket.get(key) ?? [];
      bucket.push(p);
      byMarket.set(key, bucket);
    }

    for (const [marketBase58, positions] of byMarket) {
      const marketPk = new PublicKey(marketBase58);
      const totalOwed = positions.reduce(
        (acc: bigint, p: any) => acc + BigInt(p.account.withdrawalAmount.toString()),
        0n,
      );

      const lpVaultPk = deriveLpVaultPda(marketPk, config.programId);
      const vault = await getAccount(client.connection, lpVaultPk);
      const vaultBalance = BigInt(vault.amount.toString());

      if (vaultBalance >= totalOwed) {
        logger.info(
          {
            market: marketBase58,
            pending: positions.length,
            totalOwed: totalOwed.toString(),
            vaultBalance: vaultBalance.toString(),
          },
          "pending-withdrawals: vault has enough, LPs can claim directly",
        );
        continue;
      }

      const rawShortfall = totalOwed - vaultBalance;
      const bufferedShortfall =
        rawShortfall + (totalOwed * SAFETY_BUFFER_BPS) / BPS_DIVISOR;

      logger.warn(
        {
          market: marketBase58,
          pending: positions.length,
          totalOwed: totalOwed.toString(),
          vaultBalance: vaultBalance.toString(),
          shortfall: rawShortfall.toString(),
          bufferedShortfall: bufferedShortfall.toString(),
        },
        "pending-withdrawals: vault short — refill required",
      );

      if (config.useStubOracle) {
        // Devnet path: no Kamino deployed, keeper cannot refill automatically.
        // The queue-path rarely fires here (nothing pulls USDC out of the
        // vault without a redeem target). If it somehow does, surface the
        // shortfall so ops can top up the vault manually.
        logger.error(
          { market: marketBase58 },
          "pending-withdrawals: stub-oracle mode cannot refill — manual top-up needed",
        );
        continue;
      }

      // TODO(mainnet): call withdraw_from_kamino with an amount of k-tokens
      // that redeems to at least `bufferedShortfall` USDC. Requires fetching
      // the Kamino reserve's collateral_exchange_rate. Wired in Day 21 when
      // Surfpool gives us a working Kamino instance to test against.
      logger.error(
        { market: marketBase58 },
        "pending-withdrawals: Kamino CPI refill not yet wired (Day 21)",
      );
    }
  } catch (err) {
    logger.error({ err }, "pending-withdrawals job failed");
  }
}
