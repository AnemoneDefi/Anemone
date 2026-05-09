import { AnchorProvider, Program, Wallet, Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { KeeperConfig } from "./config";

// IDL is bundled at the keeper root so the package is deploy-self-contained
// (Docker, Fly, Railway, etc). The same relative path resolves from both
// `src/` under ts-node and `dist/` after `tsc`.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const idl = require("../anemone.idl.json") as Idl;

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
