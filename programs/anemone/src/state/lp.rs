use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum LpStatus {
    Active,
    Withdrawn,
}

#[account]
pub struct LpPosition {
    pub is_initialized: bool,
    pub owner: Pubkey,
    pub market: Pubkey,

    pub shares: u64,
    pub deposited_amount: u64,

    pub status: LpStatus,
    pub bump: u8,
}

impl LpPosition {
    pub const SIZE: usize = 8   // discriminator
        + 1    // is_initialized
        + 32   // owner
        + 32   // market
        + 8    // shares
        + 8    // deposited_amount
        + 1    // status (enum)
        + 1;   // bump
}
