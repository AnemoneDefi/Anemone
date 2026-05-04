import {
  Connection,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";

export interface KaminoCpiAccounts {
  kaminoLendingMarket: PublicKey;
  kaminoLendingMarketAuthority: PublicKey;
  reserveLiquiditySupply: PublicKey;
  reserveCollateralMint: PublicKey;
}

export const KAMINO_PROGRAM_ID = new PublicKey(
  "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
);

/** Mainnet Kamino USDC reserve constants — same on surfpool fork. */
export const KAMINO_USDC_LENDING_MARKET = new PublicKey(
  "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"
);
export const KAMINO_SCOPE_PRICES = new PublicKey(
  "3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH"
);

/** Anchor discriminator for Kamino's `refresh_reserve` instruction. */
const REFRESH_RESERVE_DISCRIMINATOR = Buffer.from([
  2, 218, 138, 235, 79, 201, 25, 102,
]);

/**
 * Build a Kamino `refresh_reserve` instruction. Bundle as preInstruction to any
 * Anemone op that reads `cumulative_borrow_rate_bsf` so the reserve state is
 * fresh in the same transaction.
 */
export function buildRefreshReserveIx(reserve: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: KAMINO_PROGRAM_ID,
    keys: [
      { pubkey: reserve, isSigner: false, isWritable: true },
      { pubkey: KAMINO_USDC_LENDING_MARKET, isSigner: false, isWritable: false },
      { pubkey: KAMINO_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: KAMINO_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: KAMINO_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: KAMINO_SCOPE_PRICES, isSigner: false, isWritable: false },
    ],
    data: REFRESH_RESERVE_DISCRIMINATOR,
  });
}

const cache = new Map<string, KaminoCpiAccounts>();

export async function resolveKaminoCpiAccounts(
  connection: Connection,
  reserveAddress: PublicKey
): Promise<KaminoCpiAccounts> {
  const cacheKey = reserveAddress.toBase58();
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const acc = await connection.getAccountInfo(reserveAddress);
  if (!acc) {
    throw new Error(
      `Kamino reserve ${reserveAddress.toBase58()} not found on this RPC. ` +
        `Surfpool fork the right slot? Devnet has no Kamino — switch to surfpool/mainnet.`
    );
  }

  // Deep import avoids pulling kliquidity-sdk + Orca whirlpools wasm into the bundle.
  const { Reserve } = await import(
    "@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/Reserve.js"
  );
  const reserve = Reserve.decode(acc.data);

  const kaminoLendingMarket = new PublicKey(
    (reserve as any).lendingMarket.toString()
  );
  const reserveLiquiditySupply = new PublicKey(
    (reserve.liquidity as any).supplyVault.toString()
  );
  const reserveCollateralMint = new PublicKey(
    (reserve.collateral as any).mintPubkey.toString()
  );

  const [kaminoLendingMarketAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("lma"), kaminoLendingMarket.toBuffer()],
    KAMINO_PROGRAM_ID
  );

  const resolved: KaminoCpiAccounts = {
    kaminoLendingMarket,
    kaminoLendingMarketAuthority,
    reserveLiquiditySupply,
    reserveCollateralMint,
  };
  cache.set(cacheKey, resolved);
  return resolved;
}
