import { AnchorProvider, Program, Wallet, Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { KeeperConfig } from "./config";

// Lazy-loaded IDL + types. We copy anemone.json from the anchor build output
// and import via require to keep the keeper independent of the monorepo tsconfig.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const idl = require("../../target/idl/anemone.json") as Idl;

export interface KeeperClient {
  connection: Connection;
  program: Program;
  keeperWallet: Wallet;
  adminWallet: Wallet | null;
}

function makeProvider(connection: Connection, keypair: Keypair): AnchorProvider {
  const wallet = new Wallet(keypair);
  return new AnchorProvider(connection, wallet, { commitment: "confirmed" });
}

export function createClient(config: KeeperConfig): KeeperClient {
  const connection = new Connection(config.rpcUrl, "confirmed");

  const keeperWallet = new Wallet(config.keeperKeypair);
  const keeperProvider = makeProvider(connection, config.keeperKeypair);
  const program = new Program(idl, keeperProvider);

  const adminWallet = config.adminKeypair ? new Wallet(config.adminKeypair) : null;

  return { connection, program, keeperWallet, adminWallet };
}

export function adminProgram(
  connection: Connection,
  admin: Keypair,
): Program {
  const provider = makeProvider(connection, admin);
  return new Program(idl, provider);
}

export function programId(): PublicKey {
  return new PublicKey((idl as any).address);
}
