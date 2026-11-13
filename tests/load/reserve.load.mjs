#!/usr/bin/env node
// Concurrency test for the reservation path (dev/staging only — never production).
//
// Provisions N confirmed test investors and one 4-share listing `tree_load` via SQL, signs every
// investor in through the public Auth API, then fires all reservations at the same instant against
// `rpc/create_investment_request`. Invariants under check:
//   1. exactly TOTAL_SHARES reservations succeed, every other call fails with `failed-precondition`,
//   2. `trees_public.available_shares` is exactly 0 afterwards and was never negative,
//   3. `private.trees.reserved_shares` equals TOTAL_SHARES (no lost or double update),
//   4. the second wave (same users, same idempotency keys) returns the same request ids (replay-safe).
//
//   SUPABASE_DB_URL=postgresql://... node tests/load/reserve.load.mjs            # needs psql on PATH
//   LOAD_USERS=100 LOAD_WAVES=3 SUPABASE_DB_URL=... node tests/load/reserve.load.mjs
//   node tests/load/reserve.load.mjs --print-sql                                  # setup SQL only
//
// Env: SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY default to the project constants in src/supabase-client.src.mjs.
import { randomUUID, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = new Set(process.argv.slice(2));
const clientSrc = fs.readFileSync(path.join(root, 'src/supabase-client.src.mjs'), 'utf8');
const pick = (name) => (clientSrc.match(new RegExp(`const ${name} = '([^']+)'`)) || [])[1];
const SUPABASE_URL = process.env.SUPABASE_URL || pick('SUPABASE_URL');
const KEY = process.env.SUPABASE_PUBLISHABLE_KEY || pick('SUPABASE_PUBLISHABLE_KEY');
const USERS = Math.max(8, Number(process.env.LOAD_USERS || 50));
const WAVES = Math.max(1, Number(process.env.LOAD_WAVES || 2));
const TOTAL_SHARES = 4;
const TREE = 'tree_load';
const run = randomUUID().slice(0, 8);
const pw = `Load-${randomBytes(15).toString('base64url')}!`;
const sqlLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;

if (!SUPABASE_URL || !KEY) throw new Error('SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY could not be resolved.');
if (!args.has('--print-sql') && /riyvlhlhzxxerlwqoxsy/.test(SUPABASE_URL) && !args.has('--i-know-this-is-production')) {
  throw new Error('Refusing to run the load test against the production project. Point SUPABASE_URL/SUPABASE_DB_URL at staging.');
}

const users = Array.from({ length: USERS }, (_, i) => ({
  id: randomUUID(),
  email: `load-${run}-${String(i).padStart(3, '0')}@faseela.test`
}));

function setupSql() {
  const rows = users.map((u) => `(
    '00000000-0000-0000-0000-000000000000', ${sqlLiteral(u.id)}, 'authenticated', 'authenticated', ${sqlLiteral(u.email)},
    extensions.crypt(${sqlLiteral(pw)}, extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Load"}'::jsonb, now(), now(), '', '', '', '')`).join(',\n');
  const identities = users.map((u) => `(${sqlLiteral(u.id)}, ${sqlLiteral(u.id)}, jsonb_build_object('sub', ${sqlLiteral(u.id)}, 'email', ${sqlLiteral(u.email)}, 'email_verified', true), 'email', now(), now(), now())`).join(',\n');
  return `-- Faseela load-test setup (${USERS} identities on the reserved .test domain; ${TREE} is a test-only listing).
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
values ${rows};
insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
values ${identities};
insert into public.trees_public (tree_id, status, name, name_en, total_shares, available_shares, price_per_share_minor,
  land_price_minor, has_land_option, land_area_sqm)
values (${sqlLiteral(TREE)}, 'listed', 'Load', 'Load', ${TOTAL_SHARES}, ${TOTAL_SHARES}, 1000, 0, false, 0)
on conflict (tree_id) do update set status = 'listed', available_shares = ${TOTAL_SHARES};
insert into private.trees (tree_id, total_shares, sold_shares, reserved_shares, price_per_share_minor, land_price_minor)
values (${sqlLiteral(TREE)}, ${TOTAL_SHARES}, 0, 0, 1000, 0)
on conflict (tree_id) do update set sold_shares = 0, reserved_shares = 0;
-- Open requests of earlier runs would distort the count: expire them (status change only, nothing deleted).
update public.investment_requests set status = 'expired' where tree_id = ${sqlLiteral(TREE)} and status = 'awaiting_payment';
`;
}
const teardownSql = `update public.trees_public set status = 'unlisted' where tree_id = ${sqlLiteral(TREE)};`;
const inventorySql = `select json_build_object('available', (select available_shares from public.trees_public where tree_id = ${sqlLiteral(TREE)}),
  'reserved', (select reserved_shares from private.trees where tree_id = ${sqlLiteral(TREE)}),
  'open', (select count(*) from public.investment_requests where tree_id = ${sqlLiteral(TREE)} and status = 'awaiting_payment'))::text;`;

function psql(sql, capture = false) {
  const result = spawnSync('psql', [process.env.SUPABASE_DB_URL, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`);
  return capture ? result.stdout.trim() : '';
}

async function signIn(user) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: pw })
  });
  if (!res.ok) throw new Error(`sign-in failed for ${user.email}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).access_token;
}

async function reserve(token, user) {
  const started = performance.now();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/create_investment_request`, {
    method: 'POST',
    headers: { apikey: KEY, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ payload: { treeId: TREE, shareCount: 1, idempotencyKey: `load-${run}-${user.id}` } })
  });
  const ms = performance.now() - started;
  const body = await res.json().catch(() => ({}));
  // PostgREST maps RAISE ... USING HINT to `hint`; private.fail() puts the stable code there.
  return { ok: res.ok, code: res.ok ? 'ok' : (body.hint || body.code || String(res.status)), requestId: body.requestId || null, ms };
}

async function readAvailable() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/trees_public?select=available_shares&tree_id=eq.${TREE}`, { headers: { apikey: KEY } });
  return (await res.json())[0]?.available_shares;
}

async function main() {
  if (args.has('--print-sql')) { process.stdout.write(`${setupSql()}\n-- teardown:\n${teardownSql}\n`); return; }
  if (!process.env.SUPABASE_DB_URL) throw new Error('SUPABASE_DB_URL is required (staging connection string).');
  psql(setupSql());
  const failures = [];
  try {
    const tokens = await Promise.all(users.map(signIn));
    let minSeen = TOTAL_SHARES;
    const sampler = setInterval(async () => { const a = await readAvailable(); if (typeof a === 'number') minSeen = Math.min(minSeen, a); }, 25);
    const waves = [];
    for (let w = 0; w < WAVES; w += 1) {
      // One barrier per wave: every request is dispatched in the same tick.
      waves.push(await Promise.all(users.map((u, i) => reserve(tokens[i], u))));
    }
    clearInterval(sampler);
    const first = waves[0];
    const okIds = first.filter((r) => r.ok).map((r) => r.requestId);
    const codes = first.reduce((acc, r) => ({ ...acc, [r.code]: (acc[r.code] || 0) + 1 }), {});
    const p95 = [...first.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(first.length * 0.95)];
    const inventory = JSON.parse(psql(inventorySql, true));
    if (okIds.length !== TOTAL_SHARES) failures.push(`expected ${TOTAL_SHARES} successful reservations, got ${okIds.length}`);
    if (new Set(okIds).size !== okIds.length) failures.push('duplicate request ids among successes');
    if ((codes['failed-precondition'] || 0) !== USERS - TOTAL_SHARES) failures.push(`expected ${USERS - TOTAL_SHARES} failed-precondition, got ${JSON.stringify(codes)}`);
    if (inventory.available !== 0) failures.push(`available_shares after wave 1 = ${inventory.available}, expected 0`);
    if (inventory.reserved !== TOTAL_SHARES) failures.push(`reserved_shares = ${inventory.reserved}, expected ${TOTAL_SHARES}`);
    if (inventory.open !== TOTAL_SHARES) failures.push(`open requests = ${inventory.open}, expected ${TOTAL_SHARES}`);
    if (minSeen < 0) failures.push(`available_shares went negative (min ${minSeen})`);
    for (let w = 1; w < WAVES; w += 1) {
      const replay = waves[w].filter((r) => r.ok).map((r) => r.requestId).sort();
      if (JSON.stringify(replay) !== JSON.stringify([...okIds].sort())) failures.push(`wave ${w + 1}: idempotent replay returned different ids`);
    }
    console.log(JSON.stringify({ users: USERS, waves: WAVES, codes, p95Ms: Math.round(p95), inventory, minAvailableSeen: minSeen, ok: failures.length === 0, failures }, null, 1));
  } finally {
    psql(teardownSql);
  }
  if (failures.length) process.exit(1);
}

main().catch((error) => { console.error(error.message || error); process.exit(1); });
