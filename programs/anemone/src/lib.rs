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
        max_leverage: u8,
    ) -> Result<()> {
        instructions::admin::create_market::handle_create_market(
            ctx,
            tenor_seconds,
            settlement_period_seconds,
            max_utilization_bps,
            base_spread_bps,
            max_leverage,
        )
    }

    pub fn update_rate_index(ctx: Context<UpdateRateIndex>) -> Result<()> {
        instructions::keeper::update_rate_index::handle_update_rate_index(ctx)
    }
}
