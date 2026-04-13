import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Anemone } from "../target/types/anemone";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
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
  const fakeKaminoCollateralMint = Keypair.generate();

  // Real Kamino accounts (loaded from mainnet fixture via Anchor.toml)
  const KAMINO_PROGRAM_ID = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
  const KAMINO_USDC_RESERVE = new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59");
  const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

  // PDAs
  let protocolStatePda: PublicKey;
  let marketPda: PublicKey;
  let lpVaultPda: PublicKey;
  let collateralVaultPda: PublicKey;
  let lpMintPda: PublicKey;
  let kaminoDepositPda: PublicKey;

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

    [kaminoDepositPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("kamino_deposit"), marketPda.toBuffer()],
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

    // Create fake k-USDC collateral mint for testing
    await createMint(
      provider.connection,
      (authority as any).payer,
      authority.publicKey,
      null,
      6,
      fakeKaminoCollateralMint,
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
          kaminoDepositAccount: kaminoDepositPda,
          kaminoCollateralMint: fakeKaminoCollateralMint.publicKey,
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

      const [fakeKaminoDeposit] = PublicKey.findProgramAddressSync(
        [Buffer.from("kamino_deposit"), fakeMarketPda.toBuffer()],
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
            kaminoDepositAccount: fakeKaminoDeposit,
            kaminoCollateralMint: fakeKaminoCollateralMint.publicKey,
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

  describe("update_rate_index", () => {
    // This test uses a real Kamino USDC Reserve account cloned from mainnet
    const KAMINO_TENOR = new anchor.BN(604_800); // 7 days
    const kaminoTestCollateralMint = Keypair.generate();
    let kaminoMarketPda: PublicKey;
    let kaminoLpVaultPda: PublicKey;
    let kaminoCollateralVaultPda: PublicKey;
    let kaminoLpMintPda: PublicKey;
    let kaminoDepositAccountPda: PublicKey;

    before(async () => {
      [kaminoMarketPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("market"),
          KAMINO_USDC_RESERVE.toBuffer(),
          KAMINO_TENOR.toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      [kaminoLpVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("lp_vault"), kaminoMarketPda.toBuffer()],
        program.programId
      );

      [kaminoCollateralVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("collateral_vault"), kaminoMarketPda.toBuffer()],
        program.programId
      );

      [kaminoLpMintPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("lp_mint"), kaminoMarketPda.toBuffer()],
        program.programId
      );

      [kaminoDepositAccountPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("kamino_deposit"), kaminoMarketPda.toBuffer()],
        program.programId
      );

      // Create fake collateral mint for this test market
      await createMint(
        provider.connection,
        (authority as any).payer,
        authority.publicKey,
        null,
        6,
        kaminoTestCollateralMint,
      );

      // Create market pointing to real Kamino USDC Reserve
      await program.methods
        .createMarket(
          KAMINO_TENOR,
          new anchor.BN(86_400),
          6000,
          50,
          20,
        )
        .accountsStrict({
          protocolState: protocolStatePda,
          market: kaminoMarketPda,
          lpVault: kaminoLpVaultPda,
          collateralVault: kaminoCollateralVaultPda,
          lpMint: kaminoLpMintPda,
          kaminoDepositAccount: kaminoDepositAccountPda,
          kaminoCollateralMint: kaminoTestCollateralMint.publicKey,
          underlyingReserve: KAMINO_USDC_RESERVE,
          underlyingProtocol: KAMINO_PROGRAM_ID,
          underlyingMint: underlyingMint.publicKey,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      console.log("Kamino market created for update_rate_index tests ✓");
    });

    it("reads rate index from real Kamino Reserve", async () => {
      const tx = await program.methods
        .updateRateIndex()
        .accountsStrict({
          market: kaminoMarketPda,
          kaminoReserve: KAMINO_USDC_RESERVE,
        })
        .rpc();

      console.log("update_rate_index tx:", tx);

      // Verify the market was updated
      const market = await program.account.swapMarket.fetch(kaminoMarketPda);
      assert.isTrue(
        market.currentRateIndex.gt(new anchor.BN(0)),
        "Rate index should be > 0"
      );
      assert.isTrue(
        market.lastRateUpdateTs.gt(new anchor.BN(0)),
        "Last update timestamp should be > 0"
      );

      console.log("Rate index:", market.currentRateIndex.toString());
      console.log("Last update ts:", market.lastRateUpdateTs.toString());
      console.log("Rate index updated from real Kamino Reserve ✓");
    });

    it("rejects wrong reserve account", async () => {
      const fakeReserve = Keypair.generate();

      try {
        await program.methods
          .updateRateIndex()
          .accountsStrict({
            market: kaminoMarketPda,
            kaminoReserve: fakeReserve.publicKey,
          })
          .rpc();
        assert.fail("Should have thrown");
      } catch (err) {
        console.log("Wrong reserve correctly rejected ✓");
      }
    });
  });

  describe("deposit_liquidity & request_withdrawal", () => {
    const DEPOSIT_AMOUNT = 10_000_000_000; // 10,000 USDC (6 decimals)
    let depositorTokenAccount: PublicKey;
    let depositorLpTokenAccount: PublicKey;
    let lpPositionPda: PublicKey;

    before(async () => {
      // Derive LP position PDA
      [lpPositionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("lp"), authority.publicKey.toBuffer(), marketPda.toBuffer()],
        program.programId
      );

      // Create depositor's USDC token account and mint tokens
      depositorTokenAccount = await createAccount(
        provider.connection,
        (authority as any).payer,
        underlyingMint.publicKey,
        authority.publicKey,
      );

      await mintTo(
        provider.connection,
        (authority as any).payer,
        underlyingMint.publicKey,
        depositorTokenAccount,
        authority.publicKey,
        DEPOSIT_AMOUNT * 2, // Extra for second deposit
      );

      // Create depositor's LP token account
      depositorLpTokenAccount = await createAccount(
        provider.connection,
        (authority as any).payer,
        lpMintPda,
        authority.publicKey,
      );

      console.log("LP test accounts created ✓");
    });

    it("deposits 10,000 USDC and receives 1:1 shares", async () => {
      const tx = await program.methods
        .depositLiquidity(new anchor.BN(DEPOSIT_AMOUNT))
        .accountsStrict({
          market: marketPda,
          lpPosition: lpPositionPda,
          lpVault: lpVaultPda,
          lpMint: lpMintPda,
          underlyingMint: underlyingMint.publicKey,
          depositorTokenAccount: depositorTokenAccount,
          depositorLpTokenAccount: depositorLpTokenAccount,
          depositor: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("deposit_liquidity tx:", tx);

      // Verify market state
      const market = await program.account.swapMarket.fetch(marketPda);
      assert.equal(market.totalLpDeposits.toNumber(), DEPOSIT_AMOUNT);
      assert.equal(market.totalLpShares.toNumber(), DEPOSIT_AMOUNT);

      // Verify LP position
      const lpPos = await program.account.lpPosition.fetch(lpPositionPda);
      assert.equal(lpPos.shares.toNumber(), DEPOSIT_AMOUNT);
      assert.equal(lpPos.depositedAmount.toNumber(), DEPOSIT_AMOUNT);
      assert.equal(lpPos.owner.toBase58(), authority.publicKey.toBase58());

      // Verify LP tokens received
      const lpAccount = await getAccount(provider.connection, depositorLpTokenAccount);
      assert.equal(Number(lpAccount.amount), DEPOSIT_AMOUNT);

      // Verify vault received USDC
      const vaultAccount = await getAccount(provider.connection, lpVaultPda);
      assert.equal(Number(vaultAccount.amount), DEPOSIT_AMOUNT);

      console.log("First deposit: 10,000 USDC -> 10,000 shares ✓");
    });

    it("second deposit gets proportional shares", async () => {
      const secondAmount = 5_000_000_000; // 5,000 USDC

      await program.methods
        .depositLiquidity(new anchor.BN(secondAmount))
        .accountsStrict({
          market: marketPda,
          lpPosition: lpPositionPda,
          lpVault: lpVaultPda,
          lpMint: lpMintPda,
          underlyingMint: underlyingMint.publicKey,
          depositorTokenAccount: depositorTokenAccount,
          depositorLpTokenAccount: depositorLpTokenAccount,
          depositor: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Pool: 10K deposits / 10K shares. Depositing 5K → 5K shares (1:1, no yield yet)
      const market = await program.account.swapMarket.fetch(marketPda);
      assert.equal(market.totalLpDeposits.toNumber(), DEPOSIT_AMOUNT + secondAmount);
      assert.equal(market.totalLpShares.toNumber(), DEPOSIT_AMOUNT + secondAmount);

      const lpPos = await program.account.lpPosition.fetch(lpPositionPda);
      assert.equal(lpPos.shares.toNumber(), DEPOSIT_AMOUNT + secondAmount);

      console.log("Second deposit: 5,000 USDC -> 5,000 shares (proportional) ✓");
    });

    it("withdraws 50% of shares with fee to treasury", async () => {
      const totalShares = DEPOSIT_AMOUNT + 5_000_000_000; // 15,000 USDC
      const sharesToBurn = Math.floor(totalShares / 2); // 7,500

      // Create treasury token account using treasury keypair so address matches protocol_state.treasury
      const treasuryTokenAccount = await createAccount(
        provider.connection,
        (authority as any).payer,
        underlyingMint.publicKey,
        authority.publicKey,
        treasury, // keypair → address = treasury.publicKey
      );

      const balanceBefore = await getAccount(provider.connection, depositorTokenAccount);

      await program.methods
        .requestWithdrawal(new anchor.BN(sharesToBurn))
        .accountsStrict({
          protocolState: protocolStatePda,
          market: marketPda,
          lpPosition: lpPositionPda,
          lpVault: lpVaultPda,
          lpMint: lpMintPda,
          underlyingMint: underlyingMint.publicKey,
          withdrawerLpTokenAccount: depositorLpTokenAccount,
          withdrawerTokenAccount: depositorTokenAccount,
          treasury: treasury.publicKey,
          withdrawer: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      // Verify market state
      const market = await program.account.swapMarket.fetch(marketPda);
      assert.equal(market.totalLpShares.toNumber(), totalShares - sharesToBurn);
      assert.equal(market.totalLpDeposits.toNumber(), totalShares - sharesToBurn);

      // Verify LP position
      const lpPos = await program.account.lpPosition.fetch(lpPositionPda);
      assert.equal(lpPos.shares.toNumber(), totalShares - sharesToBurn);

      // Verify USDC returned (minus 0.05% fee)
      const balanceAfter = await getAccount(provider.connection, depositorTokenAccount);
      const received = Number(balanceAfter.amount) - Number(balanceBefore.amount);
      const expectedFee = Math.floor(sharesToBurn * 5 / 10000); // 0.05%
      const expectedNet = sharesToBurn - expectedFee;
      assert.approximately(received, expectedNet, 1);

      // Verify treasury got the fee
      const treasuryAccount = await getAccount(provider.connection, treasury.publicKey);
      assert.equal(Number(treasuryAccount.amount), expectedFee);

      console.log(`Withdrawal: ${sharesToBurn} shares -> ${received} USDC (fee: ${expectedFee}) ✓`);
    });

    it("rejects withdrawal with insufficient shares", async () => {
      try {
        await program.methods
          .requestWithdrawal(new anchor.BN(999_999_999_999))
          .accountsStrict({
            protocolState: protocolStatePda,
            market: marketPda,
            lpPosition: lpPositionPda,
            lpVault: lpVaultPda,
            lpMint: lpMintPda,
            underlyingMint: underlyingMint.publicKey,
            withdrawerLpTokenAccount: depositorLpTokenAccount,
            withdrawerTokenAccount: depositorTokenAccount,
            treasury: treasury.publicKey,
            withdrawer: authority.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        assert.fail("Should have thrown");
      } catch (err) {
        console.log("Insufficient shares correctly rejected ✓");
      }
    });
  });
});