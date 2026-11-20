#!/usr/bin/env node
// Browser E2E against a Supabase project (dev/staging only — never production).
// 1) Prepares fresh, confirmed test identities (investor + finance reviewer) and an UNLISTED-by-
//    default test tree `tree_e2e` via SQL, 2) serves public/ locally, 3) runs flow.e2e.mjs.
//
//   SUPABASE_DB_URL=postgresql://... npm run test:e2e        # full run (needs psql)
//   node tests/e2e/run-e2e.cjs --print-sql                  # print setup SQL + env (manual/MCP run)
//   E2E_INVESTOR_EMAIL=... E2E_FINANCE_EMAIL=... E2E_PW=... node tests/e2e/run-e2e.cjs --skip-setup
'use strict';
const { randomUUID, randomBytes } = require('node:crypto');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const args = new Set(process.argv.slice(2));
const run = randomUUID().slice(0, 8);
const pw = process.env.E2E_PW || `E2e-${randomBytes(12).toString('base64url')}!`;
const investorEmail = process.env.E2E_INVESTOR_EMAIL || `e2e-investor-${run}@faseela.test`;
const financeEmail = process.env.E2E_FINANCE_EMAIL || `e2e-finance-${run}@faseela.test`;
const sqlLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;

function setupSql() {
  const user = (id, email) => `(
    '00000000-0000-0000-0000-000000000000', ${sqlLiteral(id)}, 'authenticated', 'authenticated', ${sqlLiteral(email)},
    extensions.crypt(${sqlLiteral(pw)}, extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"E2E"}'::jsonb, now(), now(), '', '', '', '')`;
  const investorId = randomUUID();
  const financeId = randomUUID();
  return `-- Faseela E2E setup (test identities on the reserved .test domain; tree_e2e is a test-only listing).
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
values ${user(investorId, investorEmail)}, ${user(financeId, financeEmail)};
insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
values (${sqlLiteral(investorId)}, ${sqlLiteral(investorId)}, jsonb_build_object('sub', ${sqlLiteral(investorId)}, 'email', ${sqlLiteral(investorEmail)}, 'email_verified', true), 'email', now(), now(), now()),
       (${sqlLiteral(financeId)}, ${sqlLiteral(financeId)}, jsonb_build_object('sub', ${sqlLiteral(financeId)}, 'email', ${sqlLiteral(financeEmail)}, 'email_verified', true), 'email', now(), now(), now());
insert into private.user_roles (user_id, role) values (${sqlLiteral(financeId)}, 'finance_admin');
insert into public.trees_public (tree_id, status, name, name_en, total_shares, available_shares, price_per_share_minor,
  land_price_minor, has_land_option, land_area_sqm)
values ('tree_e2e', 'listed', 'E2E', 'E2E', 4, 4, 3500, 1500, true, 5)
on conflict (tree_id) do update set status = 'listed', available_shares = 4, price_per_share_minor = 3500,
  land_price_minor = 1500, has_land_option = true;
insert into private.trees (tree_id, total_shares, sold_shares, reserved_shares, price_per_share_minor, land_price_minor)
values ('tree_e2e', 4, 0, 0, 3500, 1500)
on conflict (tree_id) do update set sold_shares = 0, reserved_shares = 0, price_per_share_minor = 3500, land_price_minor = 1500;
`;
}

// Hides the test listing again after the run (no rows are deleted).
const teardownSql = "update public.trees_public set status = 'unlisted' where tree_id = 'tree_e2e';";

function psql(sql) {
  const result = spawnSync('psql', [process.env.SUPABASE_DB_URL, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`);
}

async function main() {
  if (args.has('--print-sql')) {
    process.stdout.write(`${setupSql()}\n-- env for the flow:\nE2E_INVESTOR_EMAIL=${investorEmail} E2E_FINANCE_EMAIL=${financeEmail} E2E_PW=${pw}\n-- teardown:\n${teardownSql}\n`);
    return;
  }
  if (!args.has('--skip-setup')) {
    if (!process.env.SUPABASE_DB_URL) throw new Error('SUPABASE_DB_URL is required for setup (or pass --skip-setup with E2E_* env).');
    psql(setupSql());
  }
  const port = process.env.E2E_PORT || '8099';
  const server = spawn('python3', ['-m', 'http.server', port, '--bind', '127.0.0.1', '--directory', path.join(root, 'public')], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 800));
  try {
    execFileSync('node', [path.join(__dirname, 'flow.e2e.mjs')], {
      stdio: 'inherit',
      env: {
        ...process.env,
        E2E_BASE: process.env.E2E_BASE || `http://localhost:${port}/index.html`,
        E2E_INVESTOR_EMAIL: investorEmail,
        E2E_FINANCE_EMAIL: financeEmail,
        E2E_PW: pw,
        E2E_TREE: 'tree_e2e'
      }
    });
  } finally {
    server.kill();
    if (!args.has('--skip-setup') && process.env.SUPABASE_DB_URL) psql(teardownSql);
  }
}

main().catch((error) => { console.error(error.message || error); process.exit(1); });
