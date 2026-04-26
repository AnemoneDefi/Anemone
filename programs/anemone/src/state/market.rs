use anchor_lang::prelude::*;

/// Maximum age of `market.last_kamino_sync_ts` tolerated by user-facing LP
/// handlers (`deposit_liquidity`, `request_withdrawal`, `claim_withdrawal`).
/// Past this window the call reverts with `StaleNav` and the caller must
/// bundle `sync_kamino_yield` ahead of the LP op in the same transaction.
///
/// Chosen to be loose enough that a typical depositor does not need a bundle
/// when the keeper is healthy (cron runs every 15 min, so a 10-min window
/// almost always hits a fresh snapshot), but tight enough that NAV drift is
/// bounded. If the keeper is missing the sync cadence, the Kamino yield
/// accrued in the stale window would get paid to whoever syncs first — we
/// would rather callers see a noisy StaleNav and bundle it themselves than
/// silently get a share-price defect.
///
/// Same pattern as MAX_QUOTE_STALENESS_SECS on open_swap (C3) and
/// MAX_PERIOD_GROWTH_BPS on settle_period (H4).
pub const MAX_NAV_STALENESS_SECS: i64 = 600;

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

    // Market state
    /// Net asset value of the LP pool in underlying-token decimals. Tracks
    /// "how much USDC the LPs collectively have claim to", including yield
    /// accrued via sync_kamino_yield and PnL settled against the lp_vault.
    /// `shares * lp_nav / total_lp_shares` is the redeemable USDC per share.
    pub lp_nav: u64,
    pub total_lp_shares: u64,
    pub total_fixed_notional: u64,
    pub total_variable_notional: u64,
    pub previous_rate_index: u128,
    pub previous_rate_update_ts: i64,
    pub current_rate_index: u128,
    pub last_rate_update_ts: i64,
    pub cumulative_fees_earned: u64,
    pub total_open_positions: u64,
    pub total_kamino_collateral: u64,

    /// Last known USDC value of the k-tokens in `kamino_deposit_account`.
    /// Updated by `sync_kamino_yield`; the diff since this snapshot becomes
    /// credited yield in lp_nav. Separate from `total_kamino_collateral`
    /// (which tracks the raw k-token balance, not the USDC value).
    pub last_kamino_snapshot_usdc: u64,
    /// Unix timestamp of the most recent `sync_kamino_yield` call. User-facing
    /// LP handlers require this to be recent via MAX_NAV_STALENESS_SECS so
    /// deposits and withdrawals always price against a fresh NAV. On devnet
    /// (stub-oracle mode) this is bumped by a no-op sync — there is no Kamino
    /// yield to accrue, but the timestamp still marks "fresh enough".
    pub last_kamino_sync_ts: i64,

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
        + 8    // lp_nav
        + 8    // total_lp_shares
        + 8    // total_fixed_notional
        + 8    // total_variable_notional
        + 16   // previous_rate_index
        + 8    // previous_rate_update_ts
        + 16   // current_rate_index
        + 8    // last_rate_update_ts
        + 8    // cumulative_fees_earned
        + 8    // total_open_positions
        + 8    // total_kamino_collateral
        + 8    // last_kamino_snapshot_usdc
        + 8    // last_kamino_sync_ts
        + 1    // status
        + 1;   // bump
}