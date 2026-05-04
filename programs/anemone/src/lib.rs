use anchor_lang::prelude::*;

pub mod state;
pub mod instructions;
pub mod helpers;
pub mod errors;

use instructions::*;

declare_id!("KQs6ci5FtedFKPVJThAZSMMXyosK4TvnF7kcDSx5Jwd");

#[program]
pub mod anemone {
    use super::*;

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        protocol_fee_bps: u16,
        opening_fee_bps: u16,
        liquidation_fee_bps: u16,
        withdrawal_fee_bps: u16,
        early_close_fee_bps: u16,
    ) -> Result<()> {
        instructions::admin::initialize_protocol::handle_initialize_protocol(
            ctx,
            protocol_fee_bps,
            opening_fee_bps,
            liquidation_fee_bps,
            withdrawal_fee_bps,
            early_close_fee_bps,
        )
    }

    pub fn create_market(
        ctx: Context<CreateMarket>,
        tenor_seconds: i64,
        settlement_period_seconds: i64,
        max_utilization_bps: u16,
        base_spread_bps: u16,
    ) -> Result<()> {
        instructions::admin::create_market::handle_create_market(
            ctx,
            tenor_seconds,
            settlement_period_seconds,
            max_utilization_bps,
            base_spread_bps,
        )
    }

    pub fn set_keeper(ctx: Context<SetKeeper>, new_keeper: Pubkey) -> Result<()> {
        instructions::admin::set_keeper::handle_set_keeper(ctx, new_keeper)
    }

    pub fn pause_protocol(ctx: Context<PauseProtocol>) -> Result<()> {
        instructions::admin::pause_protocol::handle_pause_protocol(ctx)
    }

    pub fn unpause_protocol(ctx: Context<PauseProtocol>) -> Result<()> {
        instructions::admin::pause_protocol::handle_unpause_protocol(ctx)
    }

    pub fn pause_market(ctx: Context<PauseMarket>) -> Result<()> {
        instructions::admin::pause_market::handle_pause_market(ctx)
    }

    pub fn unpause_market(ctx: Context<PauseMarket>) -> Result<()> {
        instructions::admin::pause_market::handle_unpause_market(ctx)
    }

    /// Admin-only utility for clusters where Kamino K-Lend is not deployed
    /// (localnet/devnet) and for surfpool E2E that need to drive rate-index
    /// state to specific values (e.g. organic-liquidation tests). Feature-
    /// gated so mainnet builds do NOT include it — see [features] in
    /// programs/anemone/Cargo.toml. On mainnet, rate index comes exclusively
    /// from `update_rate_index` reading Kamino state.
    #[cfg(feature = "dev-tools")]
    pub fn set_rate_index_oracle(
        ctx: Context<SetRateIndexOracle>,
        rate_index: u128,
    ) -> Result<()> {
        instructions::admin::set_rate_index_oracle::handle_set_rate_index_oracle(ctx, rate_index)
    }

    pub fn update_rate_index(ctx: Context<UpdateRateIndex>) -> Result<()> {
        instructions::keeper::update_rate_index::handle_update_rate_index(ctx)
    }

    pub fn sync_kamino_yield(ctx: Context<SyncKaminoYield>) -> Result<()> {
        instructions::keeper::sync_kamino_yield::handle_sync_kamino_yield(ctx)
    }

    pub fn deposit_liquidity(ctx: Context<DepositLiquidity>, amount: u64) -> Result<()> {
        instructions::lp::deposit_liquidity::handle_deposit_liquidity(ctx, amount)
    }

    pub fn request_withdrawal(ctx: Context<RequestWithdrawal>, shares_to_burn: u64) -> Result<()> {
        instructions::lp::request_withdrawal::handle_request_withdrawal(ctx, shares_to_burn)
    }

    pub fn deposit_to_kamino(ctx: Context<DepositToKamino>, amount: u64) -> Result<()> {
        instructions::keeper::deposit_to_kamino::handle_deposit_to_kamino(ctx, amount)
    }

    pub fn withdraw_from_kamino(ctx: Context<WithdrawFromKamino>, collateral_amount: u64) -> Result<()> {
        instructions::keeper::withdraw_from_kamino::handle_withdraw_from_kamino(ctx, collateral_amount)
    }

    pub fn settle_period(ctx: Context<SettlePeriod>) -> Result<()> {
        instructions::trader::settle_period::handle_settle_period(ctx)
    }

    pub fn open_swap(
        ctx: Context<OpenSwap>,
        direction: state::SwapDirection,
        notional: u64,
        nonce: u8,
        max_rate_bps: u64,
        min_rate_bps: u64,
    ) -> Result<()> {
        instructions::trader::open_swap::handle_open_swap(
            ctx, direction, notional, nonce, max_rate_bps, min_rate_bps,
        )
    }

    pub fn claim_matured(ctx: Context<ClaimMatured>) -> Result<()> {
        instructions::trader::claim_matured::handle_claim_matured(ctx)
    }

    pub fn liquidate_position(ctx: Context<LiquidatePosition>) -> Result<()> {
        instructions::trader::liquidate_position::handle_liquidate_position(ctx)
    }

    pub fn close_position_early(ctx: Context<ClosePositionEarly>) -> Result<()> {
        instructions::trader::close_position_early::handle_close_position_early(ctx)
    }

    pub fn add_collateral(ctx: Context<AddCollateral>, amount: u64) -> Result<()> {
        instructions::trader::add_collateral::handle_add_collateral(ctx, amount)
    }
}
