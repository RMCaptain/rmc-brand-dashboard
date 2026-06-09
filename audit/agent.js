/**
 * Claude-powered narrative review of the integrity-check findings.
 * Adds context the rules can't infer (trends, weekday/weekend variance,
 * whether a "depleted" day is real or under-fetched) and produces a
 * prioritized action list in plain English.
 *
 * No-ops if ANTHROPIC_API_KEY is unset — the deterministic checks still
 * run and post on their own; the LLM is additive, not gating.
 */

const https = require('https');

const MODEL = 'claude-sonnet-4-6';   // cheap + fast for a daily once-over

const SYSTEM_PROMPT = `You are the daily data-integrity reviewer for the RMC brand dashboard. The dashboard pulls Amazon SP-API order data into Supabase (table: daily_metrics, one row per ASIN per PST calendar day). Your job: look at the deterministic integrity findings + the day-by-day shape data and produce a short, sharp review.

Architecture context you should assume:
- Orders API is the single source of truth for units + revenue (matches Sellerboard).
- S&T sync writes traffic-only (sessions, buy box, page views) — never units/revenue.
- A 15-min poller updates "today" incrementally via LastUpdatedAfter.
- A nightly cron (8:30am UTC) finalizes "yesterday" with a full Orders API re-pull. It refuses to zero existing rows if the API returns nothing.
- PST/PDT (America/Los_Angeles) is the day boundary.

Known corruption patterns and what they look like in the data:
1. Zero-filled day: many rows but ~0 units. Caused by old finalize bug where the zero step ran before the API call succeeded.
2. S&T-era inflation: a day shows ~2x the units/revenue of surrounding days. Old S&T-sourced data that the Orders rebuild missed.
3. Partial sync: row count is ~half normal. Only one marketplace (CA or US) succeeded.
4. Monotonicity break: 7d > 14d total, or 14d > 30d. Means some day inside the wider window is corrupted lower.
5. Yesterday thin: yesterday has way fewer rows than median → the 8:30 finalize didn't run.

What you must output (as a compact JSON block followed by a one-paragraph executive summary):
{
  "status": "green" | "yellow" | "red",
  "headline": "One-sentence verdict.",
  "priority_actions": [ {"date": "YYYY-MM-DD", "issue": "brief", "command": "exact shell command to fix"} ],
  "trends": "1-2 sentences on day-over-day or weekly trends visible in the shapes data.",
  "notes": "Anything the rules missed but the data suggests."
}

Be terse. Match RMC's voice: direct, no fluff, no preamble, no emojis. Cite dates explicitly. If everything's healthy, say so in one line and stop — don't fabricate concerns.`;

function buildUserPrompt(audit) {
  return [
    `Review window: ${audit.window.from} → ${audit.window.to}`,
    `Totals: 7d=CA$${audit.totals.last7d.toFixed(0)}, 14d=CA$${audit.totals.last14d.toFixed(0)}, 30d=CA$${audit.totals.last30d.toFixed(0)}`,
    `Baselines: rowMedian=${audit.baselines.rowMedian.toFixed(0)}, revMedian=CA$${audit.baselines.revMedianBlended.toFixed(0)}`,
    ``,
    `Findings (${audit.findings.length}, ${audit.findingsBySeverity.critical} critical / ${audit.findingsBySeverity.warning} warning / ${audit.findingsBySeverity.info} info):`,
    audit.findings.length === 0
      ? '  (none — checks all passed)'
      : audit.findings.map(f => `  [${f.severity}] ${f.type}${f.date ? ` ${f.date}` : ''} — ${f.message}`).join('\n'),
    ``,
    `Daily shape (last ${audit.shapes.length} days, newest first):`,
    audit.shapes.map(s =>
      `  ${s.date}  rows=${String(s.rows).padStart(4)}  units=${String(s.units).padStart(4)}  blended=CA$${s.blended.toFixed(0).padStart(6)}  withSessions=${s.withSessions}`
    ).join('\n'),
  ].join('\n');
}

function postAnthropic(body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Anthropic ${res.statusCode}: ${raw.slice(0, 300)}`));
        try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function reviewWithAgent(audit) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { skipped: true, reason: 'ANTHROPIC_API_KEY not set' };
  }

  const body = {
    model: MODEL,
    max_tokens: 800,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(audit) }],
  };

  const result = await postAnthropic(body);
  const text = result.content?.[0]?.text || '';
  return {
    skipped: false,
    model: result.model,
    inputTokens:  result.usage?.input_tokens,
    outputTokens: result.usage?.output_tokens,
    text,
  };
}

module.exports = { reviewWithAgent };
