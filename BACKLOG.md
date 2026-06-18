# Brand Dashboard — Build Backlog

> Source of truth for pending features. Update status as work progresses.
> For architecture, stack, and env var context → see [CLAUDE.md](CLAUDE.md)

## Status Key
- `[ ]` Pending
- `[~]` In Progress / Deferred
- `[x]` Complete
- `[!]` Blocked

---

## Phase 1 — Active

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 1 | Advertising API integration | `[!]` Blocked | Submitted 2026-04-13; needs Advertising refresh token once approved |
| 2 | Slack reorder alerts | `[~]` Deferred | Needs webhook URL to proceed |

### Ads API — Steps When Unblocked
1. `GET /v2/profiles` → fetch CA + US Advertising profile IDs
2. Pull Sponsored Products campaign / ad group / keyword reports
3. Add ad spend + ACOS tiles to brand detail page and index page

### Brand Analytics — Keyword CVR Efficiency (Phase 1 Add-On)
- Per ASIN, per keyword: `conversionShare / clickShare` ratio vs market baseline of 1.0
- `> 1.0` = converting better than average for that keyword
- `< 1.0` = underperforming vs competitors
- Monthly granularity only (weekly has date alignment issues)
- Best paired with Ads API keyword data for full picture
- Limited to ASINs appearing in top 3 clicked

---

## Phase 2 — Queued

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 3 | Bundle / Multipack Opportunity Finder | `[ ]` | Velocity + co-purchase + PPC signals |
| 4 | Monthly Client Brand Report | `[ ]` | Auto-generated PDF/email; brand manager approves before send |
| 5 | Client-Facing Brand Portal | `[ ]` | Read-only per-brand view with Supabase Auth |

---

## PO Builder — Deferred (added 2026-06-17)

These were intentionally deferred during the production-blockers fix session so we could start using the PO Builder daily. Revisit once the editor has been used in anger for a few weeks.

| # | Feature | Notes |
|---|---------|-------|
| P1 | **Seasonality / time-window velocity editor** | Currently uses `last30d` average. Build editor that lets brand manager pick a custom date window per ASIN (e.g. "use Nov-Dec velocity for Q4 reorders") so seasonal SKUs reorder against the right baseline. |
| P2 | **Email-to-supplier workflow** | One-click "Send PO to supplier" with attached PDF, captured supplier contact, sent-history. Avoids manual email attachment + stale-version mistakes. |
| P3 | **PO spend reporting / metrics dashboard** | "Total PO spend by brand YTD", "open PO commitment by status", "supplier cost trend". Wait until the editor is in regular use so we know what cuts of the data matter. |
| P4 | **Restructure `purchase_orders.data` (JSONB) → relational** | Recommendation: a `purchase_order_lines` table (po_id FK, sequence, asin, description, qty, price, line_type, etc.) plus keep `data` for free-form fields (notes, optionalCols). Lets us query "how many cases of ASIN X have we ordered this year" with a JOIN instead of parsing every PO's JSON. Migration is one-time + idempotent; old POs read seamlessly because the lines table is additive. ~3-4 hours including a one-shot backfill from existing rows. |
| P5 | **Audit log viewer** | The `audit_log` JSONB column on `purchase_orders` is being populated now. Build a side-panel / modal on each PO showing the history (who/what/when changed). Useful for supplier disputes. |
| P6 | **PO templates / clone** | "Reorder same as last month" — clone a previous PO and adjust quantities. Faster than auto-generating + manual edits. |
| P7 | **Inventory on-hand consideration** | Auto-suggest currently subtracts inbound but ignores on-hand. Full ERP-style inventory ledger is out of scope; revisit only if it becomes a clear pain point. |

---

## Phase 3 — Backlog

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 6 | Review Velocity Tracker | `[ ]` | Daily scrape of review count + rating per ASIN |
| 7 | Event / Promo Calendar Agent | `[ ]` | Prime Day / BFCM prep checklist per brand |
| 8 | PPC + SEO Keyword Gap Tool | `[ ]` | Converting PPC keywords not indexed organically |
| 9 | A+ Content / Listing Asset Tracker | `[ ]` | Yes/no matrix per ASIN |
| 10 | Internal Weekly Brand Manager Report | `[ ]` | Per-brand-manager digest |
| 11 | Brand Onboarding Checklist | `[ ]` | Auto-generate Notion task list on new brand sign |

---

## Completed

| Feature | Notes |
|---------|-------|
| Listing Health Monitor | `GET /api/health` + daily Slack digest via `slack/digest.js` |
| PO Builder | Excel output, velocity-based qty, optional columns, vendor info, Bill To / Ship To |
| Brand Analytics access | MONTH period, CA marketplace — confirmed working |
| UPC scraping | Listings report (primary) → Catalog API fallback → manual entry |
| HTTP Basic Auth | Bypassed locally; Cloudflare Access (Google SSO) is next step for VPS |
| Ad spend merge fix | Switched `backgroundUpdateFinancials()` to merge logic — was zeroing adSpend on full replace |

---

## Infrastructure

| Item | Status | Notes |
|------|--------|-------|
| Cloudzy VPS deployment | `[ ]` Ready | Deploy steps documented — Mike's call on timing |
| Custom domain | `[ ]` After VPS | `dashboard.rockymountainco.ca` via Cloudflare DNS + SSL |
| Cloudflare Access (SSO) | `[ ]` Phase 2 | Google SSO for internal team; free ≤50 users |
| Supabase Auth / Client Portal | `[ ]` Phase 3 | Requires Client-Facing Portal feature first |
