# Brand Dashboard — Build Backlog

> **⚠ HANDOFF (2026-07-31) — finish the daily_fees backfill from the machine
> that has `DATABASE_URL` in its `.env`:**
> 1. `node scripts/run-migration.js sql/daily-fees.sql`
> 2. `node scripts/backfill-daily-fees.js`   *(2026-01-01 → yesterday, ~2 h, idempotent — safe to re-run)*
> 3. Verify `/api/metrics?from=2026-07-01&to=2026-07-29` shows `feeSource: "daily_fees"`, July amazonFees ≈ $75-85k (SB ref: payout C$129k, profit C$31k).
>
> Context: fixes the 4× profit overstatement (custom ranges had $0 Amazon fees).
> Pipeline + tile wiring already deployed with fallback. Also pending: team fills
> `my-ai-workspace/Outputs/missing-cogs-2026.csv` (100 offboarded ASINs, no COGS
> anywhere) and re-uploads via the product-data bulk CSV. Delete this note when done.

> **Moved to Notion as of 2026-06-30.**
> The canonical backlog now lives in the Build Log database on the **RMC App Build** page.
>
> - Page: https://app.notion.com/p/38f1b5c78853818180eaf849d54ce0d6
> - Submissions (intake) → Mike approves → Build Log (backlog)
> - Status moves: `Queued → In Build → Blocked → Shipped`
>
> For architecture, stack, and env var context → see [CLAUDE.md](CLAUDE.md) and [ARCHITECTURE.md](ARCHITECTURE.md).
