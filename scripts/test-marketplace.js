#!/usr/bin/env node
/**
 * Multi-marketplace + Sellerboard-first regression suite. No database, no
 * network beyond localhost: boots server.js against an in-memory Supabase
 * stub (scripts/test-marketplace/stub-server.js) seeded with Amazon rows for
 * CA/US and Sellerboard rows for CA/UK, then checks:
 *   registry helpers · Sellerboard CSV parser · resolver · reconciliation ·
 *   /api/metrics payload (byMp, flags, coverage, FX) ·
 *   index.html scope math (All / CA / US / UK) · brands/products/brand pages ·
 *   report-render.js tiles/columns · the repo's render regression harness.
 *
 *   node scripts/test-marketplace.js            # default port 3699
 *   PORT=3710 node scripts/test-marketplace.js
 */
const { spawn, spawnSync } = require('child_process');
const path = require('path');

const PORT = process.env.PORT || '3699';
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = path.join(__dirname, 'test-marketplace');
const node = process.execPath;

function run(label, file, args = []) {
  const r = spawnSync(node, [file, ...args], { stdio: 'pipe', encoding: 'utf8', env: { ...process.env, PORT } });
  const out = (r.stdout || '') + (r.stderr || '');
  const ok = r.status === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(out.split('\n').filter(l => !/^\[(Images|BootMigrate|AutoSync|MCP)\]|^RMC Brand/.test(l)).slice(-25).join('\n'));
  return ok;
}

(async () => {
  let failures = 0;
  // Pure units first (no server needed)
  for (const [label, file] of [
    ['registry helpers',        'registry.test.js'],
    ['sellerboard csv parser',  'sellerboard-parse.test.js'],
    ['metrics resolver',        'resolver.test.js'],
    ['reconciliation core',     'reconcile.test.js'],
    ['traffic mp writer',       'traffic-mp.test.js'],
    ['sellerboard cogs',        'cogs-sb.test.js'],
  ]) if (!run(label, path.join(DIR, file))) failures++;

  // Stub server for the API + page checks
  const server = spawn(node, [path.join(DIR, 'stub-server.js')], { stdio: 'pipe', env: { ...process.env, PORT } });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await new Promise(r => setTimeout(r, 250));
    try { up = (await fetch(`${BASE}/api/marketplaces`)).ok; } catch {}
  }
  if (!up) { console.log('FAIL  stub server did not come up'); server.kill(); process.exit(1); }

  for (const [label, file] of [
    ['/api/metrics payload',    path.join(DIR, 'metrics-api.test.js')],
    ['index.html scope math',   path.join(DIR, 'dashboard-scope.test.js')],
    ['brands/products/brand/report pages', path.join(DIR, 'pages.test.js')],
    ['dashboard render harness', path.join(__dirname, 'test-dashboard-render.js')],
  ]) if (!run(label, file, [BASE])) failures++;

  server.kill();
  console.log(failures ? `\n${failures} suite(s) failed` : '\nALL MARKETPLACE SUITES PASS');
  process.exit(failures ? 1 : 0);
})();
