#!/usr/bin/env node
// Builds a throwaway PostgreSQL database that behaves enough like the Supabase project for the SQL suites:
// stub schemas (scripts/local-db/supabase-stubs.sql), every migration in order, then the seed.
//
//   LOCAL_PG_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres node scripts/local-db.cjs [--test]
//
// LOCAL_PG_URL must point at a maintenance database of a server you may create databases on; it is never a
// Supabase URL (the script refuses hosts ending in supabase.co / supabase.com). With --test it then runs
// scripts/run-sql-tests.cjs against the new database. Needs `psql` on PATH.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const adminUrl = process.env.LOCAL_PG_URL;
const dbName = 'faseela_test';
if (!adminUrl) {
  console.error('LOCAL_PG_URL is not set, e.g. postgresql://postgres:postgres@127.0.0.1:5432/postgres');
  process.exit(2);
}
let target;
try {
  const parsed = new URL(adminUrl);
  if (/supabase\.(co|com)$/i.test(parsed.hostname)) throw new Error('refusing to rebuild a database on a Supabase host');
  parsed.pathname = `/${dbName}`;
  target = parsed.toString();
} catch (error) {
  console.error(`LOCAL_PG_URL is not usable: ${error.message}`);
  process.exit(2);
}

function psql(url, args, input) {
  const result = spawnSync('psql', [url, '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8', input, timeout: 180000 });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status !== 0 || /^psql:.*ERROR|^ERROR/m.test(output)) {
    throw new Error(output.split('\n').filter((line) => line && !/^(NOTICE|DETAIL|HINT|WARNING)/.test(line)).slice(0, 12).join('\n'));
  }
}

try {
  psql(adminUrl, ['-c', `drop database if exists ${dbName}`]);
  psql(adminUrl, ['-c', `create database ${dbName}`]);
  // Supabase resolves pgcrypto and friends through the extensions schema.
  psql(adminUrl, ['-c', `alter database ${dbName} set search_path = "$user", public, extensions`]);
  psql(target, ['-f', path.join(root, 'scripts/local-db/supabase-stubs.sql')]);
  const dir = path.join(root, 'supabase/migrations');
  const migrations = fs.readdirSync(dir).filter((file) => file.endsWith('.sql')).sort();
  for (const file of migrations) {
    // pg_cron and pg_net are real extensions on Supabase; here their schemas are stubs.
    const sql = fs.readFileSync(path.join(dir, file), 'utf8')
      .replace(/^\s*create extension (if not exists )?(pg_cron|pg_net)[^;]*;/gim, '-- extension provided by scripts/local-db/supabase-stubs.sql');
    try {
      psql(target, [], sql);
    } catch (error) {
      throw new Error(`${file}\n${error.message}`);
    }
  }
  psql(target, ['-f', path.join(root, 'supabase/seed.sql')]);
  console.log(`✅ Local database ready: ${migrations.length} migrations + seed (${target.replace(/:[^:@/]*@/, ':***@')})`);
} catch (error) {
  console.error(`✗ Local database build failed: ${error.message}`);
  process.exit(1);
}

if (process.argv.includes('--test')) {
  const run = spawnSync(process.execPath, [path.join(__dirname, 'run-sql-tests.cjs')], { stdio: 'inherit', env: { ...process.env, SUPABASE_DB_URL: target } });
  process.exit(run.status === null ? 1 : run.status);
}
