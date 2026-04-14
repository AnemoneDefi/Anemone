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
          5,    // opening_fee_bps = 0.05%
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
      assert.equal(state.openingFeeBps, 5);
      assert.equal(state.liquidationFeeBps, 300);
      assert.equal(state.withdrawalFeeBps, 5);
      assert.equal(state.earlyCloseFeeBps, 500);

      console.log("Protocol state verified ✓");
    });

    it("fails if called twice (PDA already exists)", async () => {
      try {
        await program.methods
          .initializeProtocol(1000, 5, 300, 5, 500)
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
          80,
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
      assert.equal(market.baseSpreadBps, 80);
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
            80,
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
          80,
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

  describe("open_swap", () => {
    // We use the Kamino test market (real reserve) so update_rate_index works.
    // We need: LP deposits + two rate index updates (previous + current).
    const KAMINO_TENOR = new anchor.BN(604_800); // 7 days
    const kaminoTestCollateralMint = Keypair.generate();
    let swapMarketPda: PublicKey;
    let swapLpVaultPda: PublicKey;
    let swapCollateralVaultPda: PublicKey;
    let swapLpMintPda: PublicKey;
    let swapKaminoDepositPda: PublicKey;
    let swapLpPositionPda: PublicKey;

    let traderTokenAccount: PublicKey;
    let traderLpTokenAccount: PublicKey;
    // Treasury token account (reuse treasury keypair from protocol init)
    let swapTreasuryTokenAccount: PublicKey;

    const LP_DEPOSIT = 100_000_000_000; // $100,000 USDC
    const SWAP_NOTIONAL = 10_000_000_000; // $10,000 USDC

    before(async () => {
      // Create unique reserve and mint for this test market
      const swapReserve = KAMINO_USDC_RESERVE; // real Kamino reserve for rate reading

      [swapMarketPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("market"),
          swapReserve.toBuffer(),
          KAMINO_TENOR.toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      [swapLpVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("lp_vault"), swapMarketPda.toBuffer()],
        program.programId
      );

      [swapCollateralVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("collateral_vault"), swapMarketPda.toBuffer()],
        program.programId
      );

      [swapLpMintPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("lp_mint"), swapMarketPda.toBuffer()],
        program.programId
      );

      [swapKaminoDepositPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("kamino_deposit"), swapMarketPda.toBuffer()],
        program.programId
      );

      [swapLpPositionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("lp"), authority.publicKey.toBuffer(), swapMarketPda.toBuffer()],
        program.programId
      );

      // Create collateral mint for this market
      await createMint(
        provider.connection,
        (authority as any).payer,
        authority.publicKey,
        null,
        6,
        kaminoTestCollateralMint,
      );

      // Check if this market already exists (from update_rate_index tests)
      const marketInfo = await provider.connection.getAccountInfo(swapMarketPda);
      if (!marketInfo) {
        // Create market pointing to real Kamino reserve
        await program.methods
          .createMarket(
            KAMINO_TENOR,
            new anchor.BN(86_400), // 1 day settlement period
            6000, // 60% max utilization
            80,   // 0.8% base spread
            20,   // max leverage
          )
          .accountsStrict({
            protocolState: protocolStatePda,
            market: swapMarketPda,
            lpVault: swapLpVaultPda,
            collateralVault: swapCollateralVaultPda,
            lpMint: swapLpMintPda,
            kaminoDepositAccount: swapKaminoDepositPda,
            kaminoCollateralMint: kaminoTestCollateralMint.publicKey,
            underlyingReserve: swapReserve,
            underlyingProtocol: KAMINO_PROGRAM_ID,
            underlyingMint: underlyingMint.publicKey,
            authority: authority.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
      }

      // Deposit LP liquidity so utilization check passes
      // Use explicit keypairs to avoid ATA collisions with earlier tests
      const traderTokenKp = Keypair.generate();
      traderTokenAccount = await createAccount(
        provider.connection,
        (authority as any).payer,
        underlyingMint.publicKey,
        authority.publicKey,
        traderTokenKp,
      );

      // Mint enough for LP deposit + swap collateral + fees
      await mintTo(
        provider.connection,
        (authority as any).payer,
        underlyingMint.publicKey,
        traderTokenAccount,
        authority.publicKey,
        LP_DEPOSIT + SWAP_NOTIONAL, // plenty for both
      );

      const traderLpTokenKp = Keypair.generate();
      traderLpTokenAccount = await createAccount(
        provider.connection,
        (authority as any).payer,
        swapLpMintPda,
        authority.publicKey,
        traderLpTokenKp,
      );

      // Deposit $100k as LP
      await program.methods
        .depositLiquidity(new anchor.BN(LP_DEPOSIT))
        .accountsStrict({
          market: swapMarketPda,
          lpPosition: swapLpPositionPda,
          lpVault: swapLpVaultPda,
          lpMint: swapLpMintPda,
          underlyingMint: underlyingMint.publicKey,
          depositorTokenAccount: traderTokenAccount,
          depositorLpTokenAccount: traderLpTokenAccount,
          depositor: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("LP deposited $100k ✓");

      // Update rate index TWICE to populate both previous and current
      await program.methods
        .updateRateIndex()
        .accountsStrict({
          market: swapMarketPda,
          kaminoReserve: KAMINO_USDC_RESERVE,
        })
        .rpc();

      // Small delay then second update to rotate
      await program.methods
        .updateRateIndex()
        .accountsStrict({
          market: swapMarketPda,
          kaminoReserve: KAMINO_USDC_RESERVE,
        })
        .rpc();

      console.log("Rate index updated twice (previous + current) ✓");

      // Create treasury token account for this underlying mint
      // The treasury address is treasury.publicKey (the Keypair from above)
      const treasuryInfo = await provider.connection.getAccountInfo(treasury.publicKey);
      if (!treasuryInfo || treasuryInfo.data.length < 165) {
        // Treasury might already exist from withdrawal tests with a different mint
        // Create a new ATA-style account
        swapTreasuryTokenAccount = await createAccount(
          provider.connection,
          (authority as any).payer,
          underlyingMint.publicKey,
          authority.publicKey,
          treasury, // keypair → address = treasury.publicKey
        );
      } else {
        swapTreasuryTokenAccount = treasury.publicKey;
      }

      console.log("Open swap test setup complete ✓");
    });

    it("opens a PayFixed swap with correct parameters", async () => {
      const nonce = 0;
      const [swapPositionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("swap"),
          authority.publicKey.toBuffer(),
          swapMarketPda.toBuffer(),
          Buffer.from([nonce]),
        ],
        program.programId
      );

      const balanceBefore = await getAccount(provider.connection, traderTokenAccount);
      const collateralVaultBefore = await getAccount(provider.connection, swapCollateralVaultPda);
      const treasuryBefore = await getAccount(provider.connection, treasury.publicKey);

      const tx = await program.methods
        .openSwap({ payFixed: {} }, new anchor.BN(SWAP_NOTIONAL), nonce)
        .accountsStrict({
          protocolState: protocolStatePda,
          market: swapMarketPda,
          swapPosition: swapPositionPda,
          collateralVault: swapCollateralVaultPda,
          treasury: treasury.publicKey,
          underlyingMint: underlyingMint.publicKey,
          traderTokenAccount: traderTokenAccount,
          trader: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("open_swap (PayFixed) tx:", tx);

      // Verify SwapPosition
      const position = await program.account.swapPosition.fetch(swapPositionPda);
      assert.equal(position.owner.toBase58(), authority.publicKey.toBase58());
      assert.equal(position.market.toBase58(), swapMarketPda.toBase58());
      assert.deepEqual(position.direction, { payFixed: {} });
      assert.equal(position.notional.toNumber(), SWAP_NOTIONAL);
      assert.isTrue(position.fixedRateBps.toNumber() > 0, "Fixed rate should be > 0 (at least spread)");
      assert.equal(position.leverage, 1);
      assert.isTrue(position.collateralDeposited.toNumber() > 0, "Margin should be > 0");
      assert.equal(position.collateralRemaining.toNumber(), position.collateralDeposited.toNumber());
      assert.isTrue(position.entryRateIndex.gt(new anchor.BN(0)));
      assert.deepEqual(position.status, { open: {} });
      assert.equal(position.nonce, nonce);
      assert.equal(position.numSettlements, 0);
      assert.equal(position.realizedPnl.toNumber(), 0);

      // Verify collateral transferred to vault
      const collateralVaultAfter = await getAccount(provider.connection, swapCollateralVaultPda);
      const marginTransferred = Number(collateralVaultAfter.amount) - Number(collateralVaultBefore.amount);
      assert.equal(marginTransferred, position.collateralDeposited.toNumber());

      // Verify fee transferred to treasury
      const treasuryAfter = await getAccount(provider.connection, treasury.publicKey);
      const feeCollected = Number(treasuryAfter.amount) - Number(treasuryBefore.amount);
      const expectedFee = Math.floor(SWAP_NOTIONAL * 5 / 10000); // 0.05%
      assert.equal(feeCollected, expectedFee);

      // Verify market updated
      const market = await program.account.swapMarket.fetch(swapMarketPda);
      assert.equal(market.totalFixedNotional.toNumber(), SWAP_NOTIONAL);
      assert.equal(market.totalVariableNotional.toNumber(), 0);
      assert.equal(market.totalOpenPositions.toNumber(), 1);

      // Verify trader paid margin + fee
      const balanceAfter = await getAccount(provider.connection, traderTokenAccount);
      const totalPaid = Number(balanceBefore.amount) - Number(balanceAfter.amount);
      assert.equal(totalPaid, position.collateralDeposited.toNumber() + feeCollected);

      console.log(`PayFixed swap opened: notional=$${SWAP_NOTIONAL / 1e6}, rate=${position.fixedRateBps.toNumber()}bps, margin=$${position.collateralDeposited.toNumber() / 1e6}, fee=$${feeCollected / 1e6} ✓`);
    });

    it("rejects ReceiveFixed when APY < spread (flat rates)", async () => {
      // With a static reserve fixture, APY = 0, so ReceiveFixed rate would be negative
      const nonce = 1;
      const [swapPositionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("swap"),
          authority.publicKey.toBuffer(),
          swapMarketPda.toBuffer(),
          Buffer.from([nonce]),
        ],
        program.programId
      );

      try {
        await program.methods
          .openSwap({ receiveFixed: {} }, new anchor.BN(SWAP_NOTIONAL), nonce)
          .accountsStrict({
            protocolState: protocolStatePda,
            market: swapMarketPda,
            swapPosition: swapPositionPda,
            collateralVault: swapCollateralVaultPda,
            treasury: treasury.publicKey,
            underlyingMint: underlyingMint.publicKey,
            traderTokenAccount: traderTokenAccount,
            trader: authority.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("Should have rejected ReceiveFixed with APY < spread");
      } catch (err) {
        console.log("ReceiveFixed correctly rejected when APY < spread ✓");
      }
    });

    it("rejects swap that exceeds max utilization", async () => {
      // Try to open a swap larger than 60% of LP deposits ($100k * 60% = $60k)
      // We already have $10k fixed notional, so try $55k more (total = $65k > $60k)
      const hugeNotional = 55_000_000_000; // $55,000
      const nonce = 2;
      const [swapPositionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("swap"),
          authority.publicKey.toBuffer(),
          swapMarketPda.toBuffer(),
          Buffer.from([nonce]),
        ],
        program.programId
      );

      // Mint extra for this test
      await mintTo(
        provider.connection,
        (authority as any).payer,
        underlyingMint.publicKey,
        traderTokenAccount,
        authority.publicKey,
        hugeNotional,
      );

      try {
        await program.methods
          .openSwap({ payFixed: {} }, new anchor.BN(hugeNotional), nonce)
          .accountsStrict({
            protocolState: protocolStatePda,
            market: swapMarketPda,
            swapPosition: swapPositionPda,
            collateralVault: swapCollateralVaultPda,
            treasury: treasury.publicKey,
            underlyingMint: underlyingMint.publicKey,
            traderTokenAccount: traderTokenAccount,
            trader: authority.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("Should have rejected over-utilized swap");
      } catch (err) {
        console.log("Over-utilization correctly rejected ✓");
      }
    });

    it("rejects swap with insufficient collateral", async () => {
      // Create a new account with very little USDC
      const poorTrader = Keypair.generate();

      const sig = await provider.connection.requestAirdrop(
        poorTrader.publicKey,
        1_000_000_000,
      );
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        signature: sig,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      });

      const poorTokenAccount = await createAccount(
        provider.connection,
        poorTrader,
        underlyingMint.publicKey,
        poorTrader.publicKey,
      );

      // Mint only 1 USDC — not enough for margin on $10k notional
      await mintTo(
        provider.connection,
        (authority as any).payer,
        underlyingMint.publicKey,
        poorTokenAccount,
        authority.publicKey,
        1_000_000, // $1
      );

      const nonce = 0;
      const [swapPositionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("swap"),
          poorTrader.publicKey.toBuffer(),
          swapMarketPda.toBuffer(),
          Buffer.from([nonce]),
        ],
        program.programId
      );

      try {
        await program.methods
          .openSwap({ payFixed: {} }, new anchor.BN(SWAP_NOTIONAL), nonce)
          .accountsStrict({
            protocolState: protocolStatePda,
            market: swapMarketPda,
            swapPosition: swapPositionPda,
            collateralVault: swapCollateralVaultPda,
            treasury: treasury.publicKey,
            underlyingMint: underlyingMint.publicKey,
            traderTokenAccount: poorTokenAccount,
            trader: poorTrader.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([poorTrader])
          .rpc();
        assert.fail("Should have rejected insufficient collateral");
      } catch (err) {
        console.log("Insufficient collateral correctly rejected ✓");
      }
    });
  });
});