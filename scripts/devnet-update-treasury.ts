#!/usr/bin/env ts-node
/**
 * One-shot: call update_treasury on devnet to point protocol_state.treasury
 * at the fresh USDC ATA created by setup-devnet.ts. Required after we
 * regenerated the underlying USDC mint without re-initializing the protocol.
 */
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const DEPLOYER_KEYPAIR =
  process.env.DEPLOYER_KEYPAIR ||
  path.join(os.homedir(), ".config/solana/id.json");

const idl = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../target/idl/anemone.json"),
    "utf-8",
  ),
);

const deployments = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../deployments/devnet.json"),
    "utf-8",
  ),
);

(async () => {
  const conn = new Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(
    Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync(DEPLOYER_KEYPAIR, "utf-8"))),
    ),
  );
  const provider = new anchor.AnchorProvider(conn, wallet, {
    commitment: "confirmed",
  });
  const program = new anchor.Program(idl, provider) as any;

  const protocolStatePda = new PublicKey(deployments.protocolState);
  const newTreasury = new PublicKey(deployments.treasury);

  const before = await program.account.protocolState.fetch(protocolStatePda);
  console.log("before: protocol.treasury =", before.treasury.toBase58());
  console.log("desired:                   ", newTreasury.toBase58());

  if (before.treasury.toBase58() === newTreasury.toBase58()) {
    console.log("already correct, nothing to do.");
    return;
  }

  const tx = await program.methods
    .updateTreasury()
    .accountsStrict({
      protocolState: protocolStatePda,
      newTreasury,
      authority: wallet.publicKey,
    })
    .rpc();
  console.log("tx:", tx);

  const after = await program.account.protocolState.fetch(protocolStatePda);
  console.log("after:  protocol.treasury =", after.treasury.toBase58());
})();
