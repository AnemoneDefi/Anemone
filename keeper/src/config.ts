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
  /**
   * Optional bridge mode: when USE_STUB_ORACLE=true and this is set, instead
   * of incrementing the rate index linearly via stubRateIncrement, the keeper
   * reads the live `cumulative_borrow_rate_bsf` from the Kamino USDC Reserve
   * on the URL provided here and pushes the real value through
   * `set_rate_index_oracle` on the configured RPC. This gives a devnet (or
   * Surfpool) deployment access to the actual mainnet rate evolution without
   * requiring a real Kamino CPI. Devnet stays publicly accessible while the
   * rate that drives settlements is the real one.
   *
   * Set to a mainnet RPC (Helius, QuickNode, Alchemy, or
   * `https://api.mainnet-beta.solana.com`) to enable. Leave undefined for
   * the legacy linear-stub behaviour.
   */
  bridgeMainnetRpcUrl?: string;
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

// Hosts that are known-mainnet. If USE_STUB_ORACLE=true points at one of these,
// we bail out — on mainnet the program is built with --no-default-features, so
// `set_rate_index_oracle` does not exist. Calling it would just fail with
// InstructionFallbackNotFound, but failing config load is clearer.
const MAINNET_RPC_SUBSTRINGS = [
  "mainnet-beta",
  "mainnet.helius",
  "rpc.ankr.com/solana",
  "api.mainnet-beta.solana.com",
  "solana-mainnet",
];

export function loadConfig(): KeeperConfig {
  const rpcUrl = required("RPC_URL");
  const programId = new PublicKey(required("PROGRAM_ID"));
  const marketPda = new PublicKey(required("MARKET_PDA"));
  const kaminoReserve = new PublicKey(required("KAMINO_RESERVE"));
  const useStubOracle = (process.env.USE_STUB_ORACLE || "true") === "true";

  if (useStubOracle) {
    const lower = rpcUrl.toLowerCase();
    for (const host of MAINNET_RPC_SUBSTRINGS) {
      if (lower.includes(host)) {
        throw new Error(
          `USE_STUB_ORACLE=true but RPC_URL (${rpcUrl}) looks like mainnet. ` +
            `Mainnet builds must have the stub-oracle feature disabled — set ` +
            `USE_STUB_ORACLE=false or point at devnet/localnet.`,
        );
      }
    }
  }
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

  const bridgeMainnetRpcUrl = process.env.BRIDGE_MAINNET_RPC_URL || undefined;

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
    bridgeMainnetRpcUrl,
  };
}
