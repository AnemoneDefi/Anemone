use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum LpStatus {
    Active,
    PendingWithdrawal,
    Withdrawn,
}

#[account]
pub struct LpPosition {
    pub owner: Pubkey,
    pub market: Pubkey,

    // Shares
    pub shares: u64,
    pub deposited_amount: u64,

    // Withdrawal
    pub status: LpStatus,
    pub withdrawal_requested_at: i64,
    pub withdrawal_amount: u64,

    pub bump: u8,
}

impl LpPosition {
    pub const SIZE: usize = 8   // discriminator
        + 32   // owner
        + 32   // market
        + 8    // shares
        + 8    // deposited_amount
        + 1    // status (enum)
        + 8    // withdrawal_requested_at
        + 8    // withdrawal_amount
        + 1;   // bump
}