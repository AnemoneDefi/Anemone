use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwapDirection {
    PayFixed,
    ReceiveFixed,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum PositionStatus {
    Open,
    Matured,
    Liquidated,
    ClosedEarly,
}

#[account]
pub struct SwapPosition {
    pub owner: Pubkey,
    pub market: Pubkey,

    // Swap details
    pub direction: SwapDirection,
    pub notional: u64,
    pub fixed_rate_bps: u64,

    // Collateral
    pub collateral_deposited: u64,
    pub collateral_remaining: u64,

    // Rate tracking
    pub entry_rate_index: u128,
    pub last_settled_rate_index: u128,

    // PnL
    pub realized_pnl: i64,
    pub num_settlements: u16,
    /// Trader PnL credit that the lp_vault could not cover at the moment of
    /// settlement/close/liquidation. Kept as i64 for symmetry but in practice
    /// only takes values >= 0 — the trader-loss path is capped by
    /// `collateral_remaining`, so shortfalls only arise when the trader is
    /// *owed* money and the vault is drained. Next settle_period tries to
    /// drain this first (catchup), and claim_matured / close_position_early
    /// refuse to finalize while it's non-zero. Addressed together with the
    /// keeper's pendingWithdrawals job extension that refills the vault
    /// whenever sum(unpaid_pnl) + pending LP withdrawals exceeds what the
    /// vault holds.
    pub unpaid_pnl: i64,

    // Timestamps
    pub open_timestamp: i64,
    pub maturity_timestamp: i64,
    pub next_settlement_ts: i64,
    pub last_settlement_ts: i64,

    pub status: PositionStatus,
    pub nonce: u8,
    pub bump: u8,
}

impl SwapPosition {
    pub const SIZE: usize = 8   // discriminator
        + 32   // owner
        + 32   // market
        + 1    // direction (enum)
        + 8    // notional
        + 8    // fixed_rate_bps
        + 8    // collateral_deposited
        + 8    // collateral_remaining
        + 16   // entry_rate_index
        + 16   // last_settled_rate_index
        + 8    // realized_pnl
        + 2    // num_settlements
        + 8    // unpaid_pnl
        + 8    // open_timestamp
        + 8    // maturity_timestamp
        + 8    // next_settlement_ts
        + 8    // last_settlement_ts
        + 1    // status (enum)
        + 1    // nonce
        + 1;   // bump
}