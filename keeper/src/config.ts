import * as dotenv from "dotenv";
import * as fs from "fs";
import { Keypair, PublicKey } from "@solana/web3.js";

dotenv.config();

export interface KeeperConfig {
  rpcUrl: string;
  programId: PublicKey;
  marketPda: PublicKey;
  kaminoReserve: PublicKey;
  useStubOracle: boolean;
  stubRateIncrement: bigint;
  keeperKeypair: Keypair;
  adminKeypair: Keypair | null;
  /**
   * Priority fee paid per compute unit. Non-zero values buy prioritization
   * during hot fee markets; critical for `update_rate_index` to land before
   * the on-chain MAX_QUOTE_STALENESS_SECS (see open_swap.rs). Without this,
   * the staleness guard can DoS the protocol when the fee market is busy.
   *
   * Default: 10_000 microlamports (~0.0002 SOL for a 200k CU tx). Tune per
   * cluster load via env var PRIORITY_FEE_MICROLAMPORTS.
   */
  priorityFeeMicrolamports: number;
}

function loadKeypair(path: string): Keypair {
  const secret = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function loadConfig(): KeeperConfig {
  const rpcUrl = required("RPC_URL");
  const programId = new PublicKey(required("PROGRAM_ID"));
  const marketPda = new PublicKey(required("MARKET_PDA"));
  const kaminoReserve = new PublicKey(required("KAMINO_RESERVE"));
  const useStubOracle = (process.env.USE_STUB_ORACLE || "true") === "true";
  const stubRateIncrement = BigInt(
    process.env.STUB_RATE_INCREMENT || "1000000000000",
  );
  const priorityFeeMicrolamports = parseInt(
    process.env.PRIORITY_FEE_MICROLAMPORTS || "10000",
    10,
  );

  const keeperKeypair = loadKeypair(required("KEYPAIR_PATH"));

  // Admin keypair is only required for stub oracle mode (set_rate_index_oracle)
  const adminPath = process.env.ADMIN_KEYPAIR_PATH;
  const adminKeypair =
    useStubOracle && adminPath ? loadKeypair(adminPath) : null;

  return {
    rpcUrl,
    programId,
    marketPda,
    kaminoReserve,
    useStubOracle,
    stubRateIncrement,
    keeperKeypair,
    adminKeypair,
    priorityFeeMicrolamports,
  };
}
