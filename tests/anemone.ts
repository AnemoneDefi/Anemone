import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Anemone } from "../target/types/anemone";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createMint } from "@solana/spl-token";
import { assert } from "chai";

describe("anemone", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.anemone as Program<Anemone>;
  const authority = provider.wallet;

  // Treasury is just a random keypair for tests
  const treasury = Keypair.generate();

  // Fake underlying accounts for test market
  const underlyingReserve = Keypair.generate();
  const underlyingProtocol = Keypair.generate();
  const underlyingMint = Keypair.generate();

  // PDAs
  let protocolStatePda: PublicKey;
  let marketPda: PublicKey;
  let lpVaultPda: PublicKey;
  let collateralVaultPda: PublicKey;
  let lpMintPda: PublicKey;

  const TENOR_SECONDS = new anchor.BN(2_592_000); // 30 days

  before(async () => {
    // Derive PDAs
    [protocolStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol")],
      program.programId
    );

    [marketPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("market"),
        underlyingReserve.publicKey.toBuffer(),
        TENOR_SECONDS.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    [lpVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_vault"), marketPda.toBuffer()],
      program.programId
    );

    [collateralVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("collateral_vault"), marketPda.toBuffer()],
      program.programId
    );

    [lpMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_mint"), marketPda.toBuffer()],
      program.programId
    );

    // Create the fake USDC mint for testing
    await createMint(
      provider.connection,
      (authority as any).payer,
      authority.publicKey,
      null,
      6,
      underlyingMint,
    );
  });

  describe("initialize_protocol", () => {
    it("initializes the protocol with correct fees", async () => {
      const tx = await program.methods
        .initializeProtocol(
          1000, // protocol_fee_bps = 10%
          20,   // opening_fee_bps = 0.2%
          300,  // liquidation_fee_bps = 3%
          5,    // withdrawal_fee_bps = 0.05%
          500,  // early_close_fee_bps = 5%
        )
        .accountsStrict({
          protocolState: protocolStatePda,
          authority: authority.publicKey,
          treasury: treasury.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("initialize_protocol tx:", tx);

      // Fetch and verify
      const state = await program.account.protocolState.fetch(protocolStatePda);
      assert.equal(state.authority.toBase58(), authority.publicKey.toBase58());
      assert.equal(state.treasury.toBase58(), treasury.publicKey.toBase58());
      assert.equal(state.totalMarkets.toNumber(), 0);
      assert.equal(state.protocolFeeBps, 1000);
      assert.equal(state.openingFeeBps, 20);
      assert.equal(state.liquidationFeeBps, 300);
      assert.equal(state.withdrawalFeeBps, 5);
      assert.equal(state.earlyCloseFeeBps, 500);

      console.log("Protocol state verified ✓");
    });

    it("fails if called twice (PDA already exists)", async () => {
      try {
        await program.methods
          .initializeProtocol(1000, 20, 300, 5, 500)
          .accountsStrict({
            protocolState: protocolStatePda,
            authority: authority.publicKey,
            treasury: treasury.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("Should have thrown");
      } catch (err) {
        console.log("Double init correctly rejected ✓");
      }
    });
  });

  describe("create_market", () => {
    it("creates a market with correct parameters", async () => {
      const tx = await program.methods
        .createMarket(
          TENOR_SECONDS,
          new anchor.BN(86_400),
          6000,
          50,
          20,
        )
        .accountsStrict({
          protocolState: protocolStatePda,
          market: marketPda,
          lpVault: lpVaultPda,
          collateralVault: collateralVaultPda,
          lpMint: lpMintPda,
          underlyingReserve: underlyingReserve.publicKey,
          underlyingProtocol: underlyingProtocol.publicKey,
          underlyingMint: underlyingMint.publicKey,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      console.log("create_market tx:", tx);

      // Verify market
      const market = await program.account.swapMarket.fetch(marketPda);
      assert.equal(market.protocolState.toBase58(), protocolStatePda.toBase58());
      assert.equal(market.underlyingReserve.toBase58(), underlyingReserve.publicKey.toBase58());
      assert.equal(market.underlyingMint.toBase58(), underlyingMint.publicKey.toBase58());
      assert.equal(market.lpVault.toBase58(), lpVaultPda.toBase58());
      assert.equal(market.collateralVault.toBase58(), collateralVaultPda.toBase58());
      assert.equal(market.lpMint.toBase58(), lpMintPda.toBase58());
      assert.equal(market.tenorSeconds.toNumber(), 2_592_000);
      assert.equal(market.settlementPeriodSeconds.toNumber(), 86_400);
      assert.equal(market.maxUtilizationBps, 6000);
      assert.equal(market.baseSpreadBps, 50);
      assert.equal(market.maxLeverage, 20);
      assert.equal(market.totalLpDeposits.toNumber(), 0);
      assert.equal(market.totalLpShares.toNumber(), 0);
      assert.equal(market.totalOpenPositions.toNumber(), 0);
      assert.equal(market.status, 0);

      console.log("Market state verified ✓");

      // Verify protocol counter incremented
      const protocol = await program.account.protocolState.fetch(protocolStatePda);
      assert.equal(protocol.totalMarkets.toNumber(), 1);

      console.log("Protocol total_markets = 1 ✓");
    });

    it("fails if non-authority tries to create market", async () => {
      const fakeAuthority = Keypair.generate();
      const fakeReserve = Keypair.generate();

      const sig = await provider.connection.requestAirdrop(
        fakeAuthority.publicKey,
        1_000_000_000
      );
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        signature: sig,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      });

      // Derive a different market PDA so init doesn't fail on "already exists"
      const [fakeMarketPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("market"),
          fakeReserve.publicKey.toBuffer(),
          TENOR_SECONDS.toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      const [fakeLpVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("lp_vault"), fakeMarketPda.toBuffer()],
        program.programId
      );

      const [fakeCollateralVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("collateral_vault"), fakeMarketPda.toBuffer()],
        program.programId
      );

      const [fakeLpMint] = PublicKey.findProgramAddressSync(
        [Buffer.from("lp_mint"), fakeMarketPda.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .createMarket(
            TENOR_SECONDS,
            new anchor.BN(86_400),
            6000,
            50,
            20,
          )
          .accountsStrict({
            protocolState: protocolStatePda,
            market: fakeMarketPda,
            lpVault: fakeLpVault,
            collateralVault: fakeCollateralVault,
            lpMint: fakeLpMint,
            underlyingReserve: fakeReserve.publicKey,
            underlyingProtocol: underlyingProtocol.publicKey,
            underlyingMint: underlyingMint.publicKey,
            authority: fakeAuthority.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([fakeAuthority])
          .rpc();
        assert.fail("Should have thrown");
      } catch (err) {
        console.log("Non-authority correctly rejected ✓");
      }
    });
  });
});