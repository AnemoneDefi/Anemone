use anchor_lang::prelude::*;

#[account]
pub struct SwapMarket {
    // Identity
    pub protocol_state: Pubkey,
    pub underlying_protocol: Pubkey,
    pub underlying_reserve: Pubkey,
    pub underlying_mint: Pubkey,

    // Vaults
    pub lp_vault: Pubkey,
    pub kamino_deposit_account: Pubkey,
    pub collateral_vault: Pubkey,
    pub lp_mint: Pubkey,

    // Market parameters
    pub tenor_seconds: i64,
    pub settlement_period_seconds: i64,
    /// 6000 = 60%
    pub max_utilization_bps: u16,
    pub base_spread_bps: u16,
    pub max_leverage: u8,

    // Market state
    pub total_lp_deposits: u64,
    pub total_lp_shares: u64,
    pub total_fixed_notional: u64,
    pub total_variable_notional: u64,
    pub pending_withdrawals: u64,
    pub current_rate_index: u128,
    pub last_rate_update_ts: i64,
    pub cumulative_fees_earned: u64,
    pub total_open_positions: u64,
    pub total_kamino_collateral: u64,

    pub status: u8,
    pub bump: u8,
}

impl SwapMarket {
    pub const SIZE: usize = 8   // discriminator
        + 32   // protocol_state
        + 32   // underlying_protocol
        + 32   // underlying_reserve
        + 32   // underlying_mint
        + 32   // lp_vault
        + 32   // kamino_deposit_account
        + 32   // collateral_vault
        + 32   // lp_mint
        + 8    // tenor_seconds
        + 8    // settlement_period_seconds
        + 2    // max_utilization_bps
        + 2    // base_spread_bps
        + 1    // max_leverage
        + 8    // total_lp_deposits
        + 8    // total_lp_shares
        + 8    // total_fixed_notional
        + 8    // total_variable_notional
        + 8    // pending_withdrawals
        + 16   // current_rate_index
        + 8    // last_rate_update_ts
        + 8    // cumulative_fees_earned
        + 8    // total_open_positions
        + 8    // total_kamino_collateral
        + 1    // status
        + 1;   // bump
}