/**
 * Daily database integrity audit + self-improvement loop.
 *
 * Pipeline:
 *   1. runChecks()       — deterministic integrity rules (audit/checks.js)
 *   2. reviewWithAgent() — Claude reads findings + raw shapes, prioritizes (audit/agent.js)
 *   3. proposeImprovements() — Claude reads findings + relevant source code,
 *                              proposes concrete code-level safeguards
 *                              (audit/improver.js)
 *   4. persist all of the above to disk under audit/history/<date>/
 *
 * No Slack. The improver writes a markdown file with proposed diffs for human
 * review the next time someone (or a session) sits down with the codebase.
 *
 * Wired to cron in server.js at 9am UTC and exposed at POST /api/audit/run.
 */

const fs   = require('fs');
const path = require('path');
const { runChecks }           = require('./checks');
const { reviewWithAgent }     = require('./agent');
const { proposeImprovements } = require('./improver');

const HISTORY_DIR = path.join(__dirname, 'history');

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

function writeRun(runDir, audit, agentResult, improvements) {
  ensureDir(runDir);

  fs.writeFileSync(path.join(runDir, 'audit.json'),
    JSON.stringify({ audit, agentResult }, null, 2));

  // Human-readable findings + agent review summary
  const lines = [];
  lines.push(`# Audit ${audit.window.to}`);
  lines.push('');
  lines.push(`Window: ${audit.window.from} → ${audit.window.to}`);
  lines.push(`Critical: ${audit.findingsBySeverity.critical}  ·  Warning: ${audit.findingsBySeverity.warning}  ·  Info: ${audit.findingsBySeverity.info}`);
  lines.push(`Totals (blended CAD): 7d=$${audit.totals.last7d.toFixed(0)}, 14d=$${audit.totals.last14d.toFixed(0)}, 30d=$${audit.totals.last30d.toFixed(0)}`);
  lines.push('');
  if (audit.findings.length === 0) {
    lines.push('All checks passed.');
  } else {
    lines.push('## Findings');
    for (const f of audit.findings) {
      lines.push(`- **[${f.severity}] ${f.type}**${f.date ? ` (${f.date})` : ''} — ${f.message}`);
      if (f.remediation) lines.push(`  - Remediation: \`${f.remediation}\``);
    }
  }
  if (agentResult && !agentResult.skipped && agentResult.text) {
    lines.push('');
    lines.push('## Agent review');
    lines.push(agentResult.text);
  }
  fs.writeFileSync(path.join(runDir, 'audit.md'), lines.join('\n'));

  if (improvements && !improvements.skipped && improvements.text) {
    fs.writeFileSync(path.join(runDir, 'improvements.md'), improvements.text);
  }
}

async function runDailyAudit(supabase) {
  console.log('[Audit] Running daily integrity checks...');
  const audit = await runChecks(supabase);
  console.log(`[Audit] ${audit.findings.length} findings (${audit.findingsBySeverity.critical}c/${audit.findingsBySeverity.warning}w/${audit.findingsBySeverity.info}i)`);

  let agentResult = null;
  try {
    agentResult = await reviewWithAgent(audit);
    if (agentResult.skipped) console.log('[Audit] Agent review skipped:', agentResult.reason);
    else console.log(`[Audit] Agent review done (${agentResult.inputTokens}→${agentResult.outputTokens} tokens)`);
  } catch (err) {
    console.warn('[Audit] Agent review failed:', err.message);
  }

  // Only invoke the improver when there's something to improve — saves tokens
  // on the common all-clear days.
  let improvements = { skipped: true, reason: 'no_findings' };
  if (audit.findings.length > 0) {
    try {
      improvements = await proposeImprovements(audit, agentResult);
      if (improvements.skipped) console.log('[Improver] Skipped:', improvements.reason);
      else console.log(`[Improver] Proposal done (${improvements.inputTokens}→${improvements.outputTokens} tokens)`);
    } catch (err) {
      console.warn('[Improver] Failed:', err.message);
      improvements = { skipped: true, reason: err.message };
    }
  } else {
    console.log('[Improver] No findings — skipped');
  }

  const runDir = path.join(HISTORY_DIR, audit.window.to);
  writeRun(runDir, audit, agentResult, improvements);
  console.log(`[Audit] Persisted to ${runDir}`);

  return { audit, agentResult, improvements, runDir };
}

module.exports = { runDailyAudit };
