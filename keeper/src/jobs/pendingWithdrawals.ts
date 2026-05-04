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
 * Scans for debts the lp_vault owes — both LP withdrawals queued pending
 * (LpPosition.status == PendingWithdrawal) and trader PnL that couldn't be
 * paid in full at settlement (SwapPosition.unpaid_pnl > 0, H1). Groups by
 * market, totals the owed amount, and instructs Kamino to redeem k-tokens
 * back into USDC when the vault is short.
 *
 * On devnet with USE_STUB_ORACLE=true there is no Kamino integration —
 * the vault always holds all LP USDC and the queue path rarely triggers.
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

    // H1: also fetch SwapPositions with unpaid_pnl > 0. The field is the
    // 13th in the struct so the memcmp-by-status trick doesn't apply —
    // fetch all positions and filter client-side. Good enough for MVP;
    // mainnet should index via Helius/Geyser to avoid the full scan.
    const allPositions = await (client.program.account as any).swapPosition.all();
    const unpaidPositions = allPositions.filter(
      (p: any) => BigInt(p.account.unpaidPnl?.toString?.() ?? "0") > 0n,
    );

    if (pending.length === 0 && unpaidPositions.length === 0) {
      logger.debug("pending-withdrawals: none queued");
      return;
    }

    // Group LP pending by market. In MVP there is only one, but keeping the
    // shape market-agnostic so multi-market deployments work without changes.
    const byMarket = new Map<string, typeof pending>();
    for (const p of pending) {
      const key = p.account.market.toBase58();
      const bucket = byMarket.get(key) ?? [];
      bucket.push(p);
      byMarket.set(key, bucket);
    }

    // Also bucket trader unpaid_pnl by market so the vault-refill math
    // includes both sources of debt.
    const unpaidByMarket = new Map<string, bigint>();
    for (const p of unpaidPositions) {
      const key = p.account.market.toBase58();
      const amt = BigInt(p.account.unpaidPnl.toString());
      unpaidByMarket.set(key, (unpaidByMarket.get(key) ?? 0n) + amt);
      if (!byMarket.has(key)) {
        byMarket.set(key, [] as any);
      }
    }

    for (const [marketBase58, positions] of byMarket) {
      const marketPk = new PublicKey(marketBase58);
      const lpOwed = positions.reduce(
        (acc: bigint, p: any) => acc + BigInt(p.account.withdrawalAmount.toString()),
        0n,
      );
      const traderUnpaid = unpaidByMarket.get(marketBase58) ?? 0n;
      const totalOwed = lpOwed + traderUnpaid;

      const lpVaultPk = deriveLpVaultPda(marketPk, config.programId);
      const vault = await getAccount(client.connection, lpVaultPk);
      const vaultBalance = BigInt(vault.amount.toString());

      if (vaultBalance >= totalOwed) {
        logger.info(
          {
            market: marketBase58,
            pendingLps: positions.length,
            lpOwed: lpOwed.toString(),
            traderUnpaid: traderUnpaid.toString(),
            totalOwed: totalOwed.toString(),
            vaultBalance: vaultBalance.toString(),
          },
          "pending-withdrawals: vault has enough for all debts",
        );
        continue;
      }

      const rawShortfall = totalOwed - vaultBalance;
      const bufferedShortfall =
        rawShortfall + (totalOwed * SAFETY_BUFFER_BPS) / BPS_DIVISOR;

      logger.warn(
        {
          market: marketBase58,
          pendingLps: positions.length,
          lpOwed: lpOwed.toString(),
          traderUnpaid: traderUnpaid.toString(),
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
