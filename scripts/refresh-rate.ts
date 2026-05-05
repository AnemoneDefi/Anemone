/**
 * Re-runs update_rate_index against the live Kamino reserve so the market's
 * `last_rate_update_ts` becomes recent. Required because surfpool doesn't run
 * the keeper bot, and open_swap / settle_period reject when the rate is older
 * than MAX_QUOTE_STALENESS_SECS (600s).
 *
 *   yarn ts-node scripts/refresh-rate.ts
 */
import {
  Connection,
  PublicKey,
  Keypair,
  TransactionInstruction,
} from "@solana/web3.js";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { readFileSync } from "fs";
import os from "os";

const PROGRAM_ID = new PublicKey("KQs6ci5FtedFKPVJThAZSMMXyosK4TvnF7kcDSx5Jwd");
const KAMINO_PROGRAM = new PublicKey(
  "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
);
const KAMINO_USDC_RESERVE = new PublicKey(
  "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"
);
const KAMINO_LENDING_MARKET = new PublicKey(
  "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"
);
const SCOPE_PRICES = new PublicKey(
  "3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH"
);

async function main() {
  const conn = new Connection(
    process.env.RPC_URL ?? "http://127.0.0.1:8899",
    "confirmed"
  );
  const idl = JSON.parse(readFileSync("target/idl/anemone.json", "utf-8"));
  const kp = Keypair.fromSecretKey(
    Buffer.from(
      JSON.parse(
        readFileSync(os.homedir() + "/.config/solana/id.json", "utf-8")
      )
    )
  );
  const provider = new AnchorProvider(conn, new Wallet(kp), {
    commitment: "confirmed",
  });
  const program = new Program(idl, provider);

  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    PROGRAM_ID
  );
  const markets = await (program.account as any).swapMarket.all();
  if (markets.length === 0) throw new Error("No markets found");
  const marketPda = markets[0].publicKey;

  const refreshReserve = new TransactionInstruction({
    programId: KAMINO_PROGRAM,
    keys: [
      { pubkey: KAMINO_USDC_RESERVE, isSigner: false, isWritable: true },
      { pubkey: KAMINO_LENDING_MARKET, isSigner: false, isWritable: false },
      { pubkey: KAMINO_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: KAMINO_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: KAMINO_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SCOPE_PRICES, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([2, 218, 138, 235, 79, 201, 25, 102]),
  });

  const tx = await (program.methods as any)
    .updateRateIndex()
    .accountsStrict({
      protocolState: protocolStatePda,
      market: marketPda,
      kaminoReserve: KAMINO_USDC_RESERVE,
      keeper: kp.publicKey,
    })
    .preInstructions([refreshReserve])
    .rpc();
  console.log(`refreshed market ${marketPda.toBase58()}`);
  console.log(`tx: ${tx}`);

  const m = await (program.account as any).swapMarket.fetch(marketPda);
  console.log(`  current_rate_index: ${m.currentRateIndex.toString()}`);
  console.log(`  last_rate_update_ts: ${m.lastRateUpdateTs.toString()}`);
  console.log(
    `  rate is fresh — open_swap valid for next ~10 min (MAX_QUOTE_STALENESS_SECS=600)`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
