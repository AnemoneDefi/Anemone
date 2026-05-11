import { Anemone, type AnchorWallet as SdkAnchorWallet } from "@anemonedefi/sdk";
import { Connection } from "@solana/web3.js";
import type { AnchorWallet as AdapterAnchorWallet } from "@solana/wallet-adapter-react";

export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL || "http://127.0.0.1:8899";

let readonlyInstance: Anemone | null = null;

export function getReadonlyClient(): Anemone {
  if (!readonlyInstance) {
    readonlyInstance = new Anemone({
      connection: new Connection(RPC_URL, "confirmed"),
    });
  }
  return readonlyInstance;
}

/**
 * Accepts the wallet-adapter `AnchorWallet` (the real-world, constrained type).
 * The SDK's `AnchorWallet` uses an unconstrained generic for back-compat with older
 * Anchor providers; the adapter's signature is a subtype in practice, so we cast
 * once here instead of at every call site.
 */
export function buildClient(wallet: AdapterAnchorWallet): Anemone {
  return new Anemone({
    connection: new Connection(RPC_URL, "confirmed"),
    wallet: wallet as unknown as SdkAnchorWallet,
  });
}
