import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";

/** Kamino refresh_reserve discriminator (anchor-generated) */
const REFRESH_RESERVE_DISCRIMINATOR = Buffer.from([
  2, 218, 138, 235, 79, 201, 25, 102,
]);

/** Mainnet Scope prices oracle account (Kamino's price source for USDC). */
export const SCOPE_PRICES = new PublicKey(
  "3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH",
);

/**
 * Build a Kamino `refresh_reserve` instruction. Required before reading the
 * Reserve via update_rate_index, because Surfpool's local slot drifts past
 * the forked reserve.last_update.slot (StaleOracle if delta > 750 slots).
 *
 * For USDC the Reserve is configured with Scope only (pyth + switchboard
 * fields are the zero pubkey), so we pass the Kamino program as placeholder
 * for the unused oracles.
 */
export function refreshReserveIx(args: {
  reserve: PublicKey;
  lendingMarket: PublicKey;
  scopePrices: PublicKey;
  kaminoProgram: PublicKey;
}): TransactionInstruction {
  const { reserve, lendingMarket, scopePrices, kaminoProgram } = args;
  return new TransactionInstruction({
    programId: kaminoProgram,
    keys: [
      { pubkey: reserve, isSigner: false, isWritable: true },
      { pubkey: lendingMarket, isSigner: false, isWritable: false },
      { pubkey: kaminoProgram, isSigner: false, isWritable: false }, // pyth (unused)
      { pubkey: kaminoProgram, isSigner: false, isWritable: false }, // switchboard price (unused)
      { pubkey: kaminoProgram, isSigner: false, isWritable: false }, // switchboard twap (unused)
      { pubkey: scopePrices, isSigner: false, isWritable: false },
    ],
    data: REFRESH_RESERVE_DISCRIMINATOR,
  });
}

/**
 * Set the USDC (or any SPL) balance on `owner`'s ATA via Surfpool's
 * surfnet_setTokenAccount RPC. Surfpool creates the ATA if missing.
 *
 * Param `amount` is raw token units (e.g. 5_000_000_000 for 5000 USDC at 6 dp).
 */
export async function setTokenBalance(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
  amount: bigint | number,
): Promise<void> {
  const result = await rpc(connection, "surfnet_setTokenAccount", [
    owner.toBase58(),
    mint.toBase58(),
    { amount: Number(amount) },
  ]);
  if (result.error) {
    throw new Error(
      `surfnet_setTokenAccount failed: ${JSON.stringify(result.error)}`,
    );
  }
}

/**
 * Jump Surfpool's clock forward to the given absolute slot. Kamino accrues
 * interest per slot, so this is how we make yield visible in a demo.
 */
export async function timeTravelToSlot(
  connection: Connection,
  absoluteSlot: number,
): Promise<{ epoch: number; absoluteSlot: number }> {
  const result = await rpc(connection, "surfnet_timeTravel", [
    { absoluteSlot },
  ]);
  if (result.error) {
    throw new Error(
      `surfnet_timeTravel failed: ${JSON.stringify(result.error)}`,
    );
  }
  return result.result;
}

/**
 * Convenience: jump forward by `slots` from the current slot. Surfpool's
 * 400ms slot-time means 100k slots ~= 11 hours of accrual.
 */
export async function warpForwardSlots(
  connection: Connection,
  slots: number,
): Promise<number> {
  const current = await connection.getSlot("confirmed");
  const target = current + slots;
  await timeTravelToSlot(connection, target);
  return target;
}

async function rpc(
  connection: Connection,
  method: string,
  params: unknown[],
): Promise<any> {
  const res = await fetch((connection as any)._rpcEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}
