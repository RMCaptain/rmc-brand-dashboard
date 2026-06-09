/**
 * Daily database integrity audit — entry point.
 *   1. runs deterministic checks (audit/checks.js)
 *   2. asks Claude to review + prioritize (audit/agent.js)  [optional]
 *   3. posts a Slack message summarizing findings + actions
 *
 * Wired to cron in server.js at 9am UTC (after the 8:30 finalize) and
 * exposed at POST /api/audit/run for manual triggers.
 */

const { runChecks } = require('./checks');
const { reviewWithAgent } = require('./agent');

function severityEmoji(severity) {
  return severity === 'critical' ? ':rotating_light:'
       : severity === 'warning'  ? ':warning:'
       : ':information_source:';
}

function buildSlackBlocks(audit, agentResult) {
  const { findings, findingsBySeverity, totals, window } = audit;
  const blocks = [];

  // Header
  const headerEmoji = findingsBySeverity.critical > 0 ? ':rotating_light:'
                    : findingsBySeverity.warning  > 0 ? ':warning:'
                    : ':white_check_mark:';
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `${headerEmoji} RMC Data Integrity — ${window.to} review` },
  });

  // Headline counts
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*${findingsBySeverity.critical} Critical*   ·   *${findingsBySeverity.warning} Warnings*   ·   ${findingsBySeverity.info} Info\n`
        + `Window: ${window.from} → ${window.to}  ·  7d: CA$${totals.last7d.toFixed(0)}  ·  14d: CA$${totals.last14d.toFixed(0)}  ·  30d: CA$${totals.last30d.toFixed(0)}`,
    },
  });

  // Findings — critical first, then warnings, then info
  if (findings.length > 0) {
    const ordered = ['critical', 'warning', 'info'].flatMap(sev =>
      findings.filter(f => f.severity === sev)
    );
    const lines = ordered.slice(0, 25).map(f =>
      `${severityEmoji(f.severity)} *${f.type}*${f.date ? ` _${f.date}_` : ''} — ${f.message}`
      + (f.remediation ? `\n      \`${f.remediation}\`` : '')
    );
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });
    if (findings.length > 25) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `_…and ${findings.length - 25} more_` }] });
    }
  } else {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: ':white_check_mark: All checks passed.' } });
  }

  // Agent narrative
  if (agentResult && !agentResult.skipped && agentResult.text) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*AI review*\n${agentResult.text.slice(0, 2900)}` } });
  }

  return blocks;
}

async function postToSlack(blocks, fallback) {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) {
    console.log('[Audit] SLACK_WEBHOOK_URL not set — printing report instead');
    console.log(JSON.stringify({ fallback, blocks }, null, 2));
    return { posted: false, reason: 'no_webhook' };
  }
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: fallback, blocks }),
  });
  const body = await res.text();
  if (!res.ok || body !== 'ok') {
    console.error('[Audit] Slack webhook error:', res.status, body);
    return { posted: false, reason: 'webhook_error', status: res.status };
  }
  return { posted: true };
}

async function runDailyAudit(supabase) {
  console.log('[Audit] Running daily integrity checks...');
  const audit = await runChecks(supabase);
  console.log(`[Audit] Found ${audit.findings.length} findings (${audit.findingsBySeverity.critical} critical, ${audit.findingsBySeverity.warning} warnings, ${audit.findingsBySeverity.info} info)`);

  let agentResult = null;
  try {
    agentResult = await reviewWithAgent(audit);
    if (agentResult.skipped) {
      console.log('[Audit] Agent review skipped:', agentResult.reason);
    } else {
      console.log(`[Audit] Agent review done (model=${agentResult.model}, ${agentResult.inputTokens}→${agentResult.outputTokens} tokens)`);
    }
  } catch (err) {
    console.warn('[Audit] Agent review failed:', err.message);
  }

  const fallback = audit.findings.length === 0
    ? `RMC Data Audit: all clear`
    : `RMC Data Audit: ${audit.findingsBySeverity.critical} critical / ${audit.findingsBySeverity.warning} warnings`;
  const blocks = buildSlackBlocks(audit, agentResult);
  const slackResult = await postToSlack(blocks, fallback);

  return { audit, agentResult, slackResult };
}

module.exports = { runDailyAudit };
