#!/usr/bin/env node
/**
 * Run a SQL migration file directly against the production Postgres.
 *
 *   node scripts/run-migration.js sql/portal-auth.sql
 *
 * This replaced the Claude-for-Chrome stopgap on 2026-07-21 with Mike's
 * explicit approval ("I want you to be able to make edits in future"). The
 * standing arrangement:
 *   - migrations still live in sql/ and get committed — the file is the record
 *   - Claude executes them with this runner instead of handing Mike a block
 *   - DATABASE_URL (session pooler + db password) lives in .env, gitignored
 *
 * The whole file runs inside ONE transaction: any statement failing rolls back
 * everything, so a half-applied migration can't exist. Trailing SELECTs in our
 * migrations act as built-in verification — their rows are printed.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const { Client } = require('pg');

(async () => {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.error('Usage: node scripts/run-migration.js <path-to.sql>');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL missing from .env — cannot run migrations directly.');
    process.exit(1);
  }

  const sql = fs.readFileSync(file, 'utf8');
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },   // Supabase pooler requires TLS
  });

  console.log(`Running ${file} against production (single transaction)...`);
  await client.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(sql);
    await client.query('COMMIT');

    // pg returns an array for multi-statement files; print any SELECT output
    // (our migrations end with a sanity-check SELECT by convention).
    const results = Array.isArray(result) ? result : [result];
    for (const r of results) {
      if (r.command === 'SELECT' && r.rows?.length) {
        console.log('\nVerification output:');
        console.table(r.rows);
      }
    }
    console.log(`\n✓ ${file} applied and committed.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`\n✗ FAILED — rolled back, nothing applied: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
