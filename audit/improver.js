/**
 * Self-improvement loop: takes the day's integrity findings, reads the source
 * files responsible for those classes of bug, and asks Claude to propose
 * concrete code-level safeguards that would have prevented them.
 *
 * Output is a markdown file under audit/history/<date>/improvements.md. We do
 * NOT auto-apply — proposals are reviewed by a human (or a future Claude
 * session) before merging.
 *
 * No-ops gracefully when ANTHROPIC_API_KEY is unset.
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const MODEL = 'claude-sonnet-4-6';

// Map each finding type to the source files most relevant for prevention.
// Keep this list small and updated; bloat costs tokens and diffuses focus.
const FILES_BY_FINDING = {
  missing_date:     ['sync/backfill.js', 'server.js'],
  zero_filled:      ['server.js', 'sync/orders.js'],
  partial_rows:     ['sync/backfill.js', 'sync/orders.js'],
  inflated:         ['sync/orders.js', 'sync/backfill.js', 'server.js'],
  depleted:         ['sync/orders.js'],
  monotonicity:     ['server.js'],
  yesterday_thin:   ['server.js', 'sync/orders.js'],
};

const SYSTEM_PROMPT = `You are reviewing a Node.js codebase that pulls Amazon SP-API order data into a Supabase daily_metrics table for an internal brand dashboard. Your job: given today's integrity-check findings and the current source for the modules responsible, propose specific code-level safeguards that would PREVENT those classes of bugs from recurring.

Constraints:
- Only propose changes that target the root cause of an actual finding. Skip generic refactors and "would be nicer" tweaks.
- Output a markdown file with one section per proposal. Each section: \`### <finding-type> — short title\`, then a paragraph explaining the bug class, then a fenced code block showing the proposed code (or a clear diff), then a one-line **Risk:** note covering what could break.
- If the existing code already has the safeguard the proposal calls for, say so and skip — do not duplicate.
- Be concrete. Show actual function names, variable names, file paths.
- No fluff. No emojis. No restating the architecture.
- If the findings don't suggest any code change worth making (e.g., one partial-rows day that was already manually rebuilt), say so in one line and stop.`;

function readFileSafe(filePath) {
  try {
    const full = path.join(__dirname, '..', filePath);
    if (!fs.existsSync(full)) return null;
    return fs.readFileSync(full, 'utf8');
  } catch { return null; }
}

function postAnthropic(body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type':     'application/json',
        'x-api-key':        process.env.ANTHROPIC_API_KEY,
        'anthropic-version':'2023-06-01',
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

async function proposeImprovements(audit, agentResult) {
  if (!process.env.ANTHROPIC_API_KEY) return { skipped: true, reason: 'ANTHROPIC_API_KEY not set' };
  if (!audit.findings || audit.findings.length === 0) return { skipped: true, reason: 'no findings' };

  // Collect unique file paths relevant to the findings actually seen today
  const fileSet = new Set();
  for (const f of audit.findings) {
    for (const p of (FILES_BY_FINDING[f.type] || [])) fileSet.add(p);
  }
  if (fileSet.size === 0) return { skipped: true, reason: 'no file map for finding types' };

  // Load the source. Truncate very large files at the end (server.js is ~3k lines)
  // — proposals about that file usually concern the data-writing helpers near the top.
  const MAX_FILE_BYTES = 60_000;
  const sourceBlocks = [];
  for (const p of fileSet) {
    let body = readFileSafe(p);
    if (body == null) continue;
    let suffix = '';
    if (body.length > MAX_FILE_BYTES) { suffix = `\n\n// ... [truncated at ${MAX_FILE_BYTES} bytes; full file is ${body.length} bytes]`; body = body.slice(0, MAX_FILE_BYTES); }
    sourceBlocks.push(`\n----- FILE: ${p} -----\n${body}${suffix}`);
  }

  const findingsBlock = audit.findings
    .map(f => `- [${f.severity}] ${f.type}${f.date ? ` (${f.date})` : ''}: ${f.message}${f.remediation ? `\n    current remediation: ${f.remediation}` : ''}`)
    .join('\n');

  const reviewerNotes = (agentResult && !agentResult.skipped && agentResult.text) ? `\n\nReviewer notes (from prior agent pass):\n${agentResult.text}` : '';

  const userPrompt =
`Today's findings:
${findingsBlock}
${reviewerNotes}

Relevant source files:
${sourceBlocks.join('\n')}

Now produce the markdown improvement proposal.`;

  const body = {
    model: MODEL,
    max_tokens: 2500,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  };

  const result = await postAnthropic(body);
  const text   = result.content?.[0]?.text || '';
  return {
    skipped: false,
    model: result.model,
    inputTokens:  result.usage?.input_tokens,
    outputTokens: result.usage?.output_tokens,
    filesReviewed: [...fileSet],
    text,
  };
}

module.exports = { proposeImprovements };
