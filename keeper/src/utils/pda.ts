import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";

export function deriveProtocolPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    programId,
  )[0];
}

export function deriveMarketPda(
  reserve: PublicKey,
  tenorSeconds: BN,
  programId: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("market"),
      reserve.toBuffer(),
      tenorSeconds.toArrayLike(Buffer, "le", 8),
    ],
    programId,
  )[0];
}

export function deriveLpVaultPda(market: PublicKey, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lp_vault"), market.toBuffer()],
    programId,
  )[0];
}

export function deriveCollateralVaultPda(
  market: PublicKey,
  programId: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("collateral_vault"), market.toBuffer()],
    programId,
  )[0];
}
