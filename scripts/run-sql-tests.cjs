#!/usr/bin/env node
// Runs supabase/tests/*.test.sql against a Supabase database and checks the summary line.
// Each suite is one transaction that always rolls back (it ends with RAISE 'TEST SUMMARY ...').
// Usage: SUPABASE_DB_URL=postgresql://... npm run test:db   (needs `psql` on PATH)
// Never point this at production with real users: it creates and rolls back test identities.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error('SUPABASE_DB_URL is not set (Project Settings → Database → connection string).');
  process.exit(2);
}
const dir = path.resolve(__dirname, '..', 'supabase', 'tests');
const suites = fs.readdirSync(dir).filter((file) => file.endsWith('.test.sql')).sort();
let failed = false;

for (const suite of suites) {
  const result = spawnSync('psql', [dbUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=0', '-f', path.join(dir, suite)], {
    encoding: 'utf8',
    timeout: 120000
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const match = output.match(/TEST SUMMARY passed=(\d+) failed=(\d+)([^\n]*)/);
  if (!match) {
    failed = true;
    console.error(`✗ ${suite}: no summary found\n${output.trim()}`);
    continue;
  }
  const [, passed, failures, details] = match;
  if (Number(failures) > 0) {
    failed = true;
    console.error(`✗ ${suite}: passed=${passed} failed=${failures}${details}`);
  } else {
    console.log(`✓ ${suite}: passed=${passed} failed=0`);
  }
}
process.exit(failed ? 1 : 0);
