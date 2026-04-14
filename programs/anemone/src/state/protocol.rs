use anchor_lang::prelude::*;

#[account]
pub struct ProtocolState {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub total_markets: u64,
    /// 10% performance fee on LP spread (1000 = 10%)
    pub protocol_fee_bps: u16,
    /// 0.05% on notional when opening swap (5 = 0.05%)
    pub opening_fee_bps: u16,
    /// 3% on remaining margin at liquidation (300 = 3%)
    pub liquidation_fee_bps: u16,
    /// 0.05% on LP withdrawal (5 = 0.05%)
    pub withdrawal_fee_bps: u16,
    /// 5% on collateral returned when trader closes early (500 = 5%)
    pub early_close_fee_bps: u16,
    pub bump: u8,
}

impl ProtocolState {
    pub const SIZE: usize = 8  // discriminator
        + 32  // authority
        + 32  // treasury
        + 8   // total_markets
        + 2   // protocol_fee_bps
        + 2   // opening_fee_bps
        + 2   // liquidation_fee_bps
        + 2   // withdrawal_fee_bps
        + 2   // early_close_fee_bps
        + 1;  // bump
}