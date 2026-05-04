"use client";

import useSWR, { type SWRResponse } from "swr";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount, TokenAccountNotFoundError } from "@solana/spl-token";

const REFRESH_MS = 15_000;

async function fetchBalance(
  connection: ReturnType<typeof useConnection>["connection"],
  owner: PublicKey,
  mint: PublicKey
): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  try {
    const account = await getAccount(connection, ata, "confirmed");
    return account.amount;
  } catch (err) {
    if (err instanceof TokenAccountNotFoundError) return 0n;
    throw err;
  }
}

export function useTokenBalance(
  owner: string | null | undefined,
  mint: string | null | undefined
): SWRResponse<bigint, Error> {
  const { connection } = useConnection();
  return useSWR<bigint>(
    owner && mint ? ["balance", owner, mint, connection.rpcEndpoint] : null,
    ([, ownerStr, mintStr]) =>
      fetchBalance(connection, new PublicKey(ownerStr as string), new PublicKey(mintStr as string)),
    { refreshInterval: REFRESH_MS }
  );
}
