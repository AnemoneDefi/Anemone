import { Connection, PublicKey } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import { logger } from "./logger";

export interface DecodedAccount<T> {
  publicKey: PublicKey;
  account: T;
}

/**
 * Lookup the 8-byte Anchor discriminator for an account name from the IDL.
 *
 * Anchor 0.30+ normalizes IDL account names to camelCase at construction
 * time (e.g. JSON's "SwapPosition" → runtime "swapPosition"), but callers
 * pass PascalCase to match the Rust struct names in the program. We
 * accept either form and match case-insensitively.
 */
function discriminatorFor(program: Program, accountName: string): Buffer {
  const wanted = accountName.toLowerCase();
  const idlAccounts = (program.idl as any).accounts as Array<{
    name: string;
    discriminator: number[];
  }>;
  const entry = idlAccounts.find((a) => a.name.toLowerCase() === wanted);
  if (!entry) {
    throw new Error(`IDL has no account named ${accountName}`);
  }
  return Buffer.from(entry.discriminator);
}

/**
 * Lower-cases the first letter of an account name. Anchor's runtime API
 * (`program.account.<name>`) uses camelCase while callers pass PascalCase.
 */
function camelize(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/**
 * Drop-in replacement for `program.account.<name>.all()` that survives stale
 * accounts on the cluster.
 *
 * Why: `Program.account.<name>.all()` does `getProgramAccounts` filtered by
 * the account discriminator and then runs every result through the IDL
 * decoder. If even one account has a layout that no longer matches the IDL
 * (left over from a previous program version on devnet/localnet), the decode
 * throws and the entire batch fails. That's a real risk on a long-lived
 * devnet deploy where accounts from previous program versions linger.
 *
 * What we do differently:
 *   - Filter on discriminator AND on `expectedDataSize` so old-layout
 *     accounts get excluded at the RPC level (cheaper, fewer bytes over the
 *     wire) when their sizes don't match.
 *   - Decode each remaining account in its own try/catch so a single bad
 *     account only loses itself, not the whole batch.
 *
 * Always runs the post-fetch decode under per-item try/catch even when
 * `expectedDataSize` is set, because account layouts can shift in
 * order-of-fields (e.g. enum offsets) without changing total size.
 */
export async function fetchAllSafe<T>(
  program: Program,
  accountName: string,
  expectedDataSize?: number,
): Promise<DecodedAccount<T>[]> {
  const programId = program.programId;
  const connection: Connection = (program.provider as any).connection;
  const discriminator = discriminatorFor(program, accountName);

  const filters: Array<
    | { dataSize: number }
    | { memcmp: { offset: number; bytes: string } }
  > = [
    {
      memcmp: {
        offset: 0,
        bytes: bs58Encode(discriminator),
      },
    },
  ];
  if (expectedDataSize !== undefined) {
    filters.push({ dataSize: expectedDataSize });
  }

  const raw = await connection.getProgramAccounts(programId, {
    filters: filters as any,
    commitment: "confirmed",
  });

  const decoder = (program.account as any)[camelize(accountName)];
  if (!decoder) {
    throw new Error(`Program has no account decoder for ${accountName}`);
  }

  const out: DecodedAccount<T>[] = [];
  let skipped = 0;
  // Anchor 0.30+ keys account types in the coder by the same camelCase form
  // the runtime IDL uses; older versions accepted PascalCase. The instance
  // method `decoder.fetch` would handle the lookup for us, but we already
  // have the raw buffer from getProgramAccounts so we go through the coder.
  const decodeName = camelize(accountName);
  for (const item of raw) {
    try {
      const account = decoder.coder.accounts.decode(
        decodeName,
        item.account.data,
      ) as T;
      out.push({ publicKey: item.pubkey, account });
    } catch (err) {
      skipped++;
      logger.debug(
        {
          pubkey: item.pubkey.toBase58(),
          dataLen: item.account.data.length,
          err: (err as Error).message,
        },
        `${accountName}: skipping un-decodable account`,
      );
    }
  }

  if (skipped > 0) {
    logger.warn(
      { accountName, skipped, decoded: out.length },
      "fetchAllSafe: some accounts could not be decoded with the current IDL",
    );
  }

  return out;
}

// Local bs58 encode — pulled inline so this util doesn't drag a dependency
// into modules that import it; the keeper already depends on bs58 elsewhere
// but we want this file to stay self-contained.
function bs58Encode(buf: Buffer): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const bs58 = require("bs58");
  // bs58 v6 default-exports encode/decode; v4 had named exports. Handle both.
  const enc = bs58.default?.encode ?? bs58.encode;
  return enc(buf);
}
