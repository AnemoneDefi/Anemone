import { ComputeBudgetProgram, TransactionInstruction } from "@solana/web3.js";

/**
 * Builds the pair of compute-budget instructions that every keeper tx should
 * prepend: a CU limit and a per-CU price. Without the price bump, during
 * congestion `update_rate_index` can fall behind MAX_QUOTE_STALENESS_SECS and
 * auto-DoS the `open_swap` staleness check.
 *
 * The CU limit of 400k covers the heaviest CPI (`deposit_to_kamino`). Smaller
 * tx's pay only for what they burn, so the limit is a ceiling not a cost.
 */
export function priorityFeeInstructions(
  microLamportsPerCu: number,
  cuLimit = 400_000,
): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: microLamportsPerCu,
    }),
  ];
}
