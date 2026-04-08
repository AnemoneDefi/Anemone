use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
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
    pub leverage: u8,

    // Collateral
    pub collateral_deposited: u64,
    pub collateral_remaining: u64,

    // Rate tracking
    pub entry_rate_index: u128,
    pub last_settled_rate_index: u128,

    // PnL
    pub realized_pnl: i64,
    pub num_settlements: u16,

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
        + 1    // leverage
        + 8    // collateral_deposited
        + 8    // collateral_remaining
        + 16   // entry_rate_index
        + 16   // last_settled_rate_index
        + 8    // realized_pnl
        + 2    // num_settlements
        + 8    // open_timestamp
        + 8    // maturity_timestamp
        + 8    // next_settlement_ts
        + 8    // last_settlement_ts
        + 1    // status (enum)
        + 1    // nonce
        + 1;   // bump
}