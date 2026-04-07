use anchor_lang::prelude::*;

declare_id!("KQs6ci5FtedFKPVJThAZSMMXyosK4TvnF7kcDSx5Jwd");

#[program]
pub mod anemone {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
