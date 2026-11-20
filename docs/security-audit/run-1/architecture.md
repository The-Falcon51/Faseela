# Faseela — architecture summary for security audit run-1

## 1. Product, principals, authority, protected resources
Faseela is a bilingual (AR/EN) fractional olive-tree stewardship platform. Investors reserve shares in Syrian olive trees, pay offline and upload a payment proof; finance staff review; certified pressings allocate oil pro-rata to share holders; farmers file field reports that auditors publish; share certificates (PDF + public verification) are issued per share.

Principals (role row in `private.user_roles`, default `investor` when absent; admin passes every role check): `anon` (public catalogue, published events, consented farmer profiles, 4 anon RPCs), `investor` (owner-scoped reservations, proofs, oil requests, certificate, export, delete), `farmer` (reports + public profile, requires active tree assignment), `mill_operator` (pressing batches, requires mill assignment), `finance_admin` (payment and oil review queues; decrypts oil contact PII), `quality_auditor` (publishes field reports, certifies batches), `admin` (role/status/assignment management, user directory, system status), `service_role` (Edge Functions: outbox claim/mark, tree_media_paths), `pg_cron`/postgres (jobs), SQL-editor-only operator helpers.

Protected resources: investment_requests/transactions/shares (money, four-eyes), payment proofs and field media (private buckets), oil contact PII (pgp-encrypted in `private.oil_request_contacts`, Vault `pii_key`), roles/assignments, audit_logs, email outbox + Vault `outbox_token`, consented farmer identities, certificate serials ↔ holder initials.

## 2. Comparable baseline
No source-grounded comparable project. Docs mention generic marketplace/crowdfunding terms and a regulatory note that the offer may be a Vermögensanlage. Calibrate severity as for a payment-adjacent multi-role SaaS with private documents; no comparable-defect shortcut applies.

## 3. Stack, deployment paths, offline limits
Frontend: vanilla JS/HTML (`public/index.html`, `public/app.js` ~25k lines, `public/events.js` CSP-safe delegation grammar), built bundle `public/supabase-client.mjs` from `src/supabase-client.src.mjs` (supabase-js 2.117.2, PKCE), Tailwind, lucide vendored. Standalone pages `tree.mjs`, `verify.mjs`, `status.mjs`, `auth/reset.mjs`. Hosting: Firebase Hosting (two sites, both serve `public/`), strict CSP `script-src 'self'`, connect-src only the Supabase origin. Mobile: Capacitor 6 (webDir `public`, synced copy under `android/app/src/main/assets/public`; no native project in repo).
Backend: Supabase Postgres (EU). Schemas: `public` (RLS SELECT-only tables, SECURITY INVOKER wrappers) and `private` (SECURITY DEFINER logic with `search_path=''`, no-RLS internal tables with all privileges revoked). Storage buckets `payment-proofs`, `field-media` (private, write-once insert policies). pg_cron jobs (expire reservations, overdue reviews, ops-check, send-emails via pg_net + Vault token, onboarding). Edge Functions (Deno): `send-emails` (service_role, custom `x-outbox-token`), `certificate` (caller JWT passthrough, pdf-lib), `tree-media` (service_role, anonymous, CORS allowlist).
Legacy/unclear: `functions/` (Firebase Functions, not deployed; `domain.js` reused by tests/seed), `backend/` (Express+sqlite+JWT, wired only via `render.yaml`/`docker-compose.yml`, unreachable from the hosted CSP), root `Dockerfile` (nginx, unreferenced).
Offline: `npm test`, `npm run test:web`, `npm run build` (checks only) are pure-local. `test:ui` needs Playwright Chromium + loopback http.server. `test:db`, `test:e2e`, `test:load`, deploys, `npx cap`, emulators are prohibited in this run. No Deno, no Supabase CLI, no local Supabase stack. **No OS-enforced sandbox is approved for target execution in this run: hunters are source-only; execution-dependent claims become `needs_validation`.**

## 4. Entry surfaces and important paths
- PostgREST RPC (`public.*` wrappers → `private.*`): jsonb payloads validated via `req_id`/`req_uuid` regexes, `opt_text` (length only), `req_number` (type only), `jsonb_typeof` guards; no dynamic SQL. Free text (notes, display names, bios) flows to: anon RPC output (`public_tree_profile`, `verify_certificate` initials), e-mail HTML (escaped in `send-emails`), PDF text (`latin()`), browser HTML (`escapeHtml` in app.js; `esc` in tree/verify).
- Anon RPCs: `report_client_error` (global 500/h cap, no type checks), `public_status`, `verify_certificate`, `public_tree_profile` (reads `trees_public` by id without `status='listed'`).
- Helpers granted to authenticated with caller-chosen uid: `farmer_has_tree(p_uid,…)`, `operator_has_mill(p_uid,…)`.
- Storage: client builds `uid/<id>/<ts>_<clean>` paths; upload policy `can_upload_*`; RPC re-checks path prefix; downloads via createSignedUrl; `tree-media` signs published media + consented profile photo (farmerPhoto not extension-filtered).
- Edge Functions: `send-emails` constant-time token compare, HTML-escaped params, unsubscribe link without token (`/?unsubscribe=marketing`, needs session); `certificate` Bearer format check then RPC as caller; `tree-media` treeId regex, service_role lookup.
- Browser: `events.js` resolves `data-*` call names to any `window[IDENT]`; attributes are built with template literals from server ids (format-restricted by regex) and from localStorage values (unescaped in several spots); `escapeHtml` does not protect the attribute→grammar context. Query inputs `?tree`, `?code`, `?unsubscribe`, `#hash`.
- Auth client: PKCE; password reset page shows form on any session and calls `updateUser` without old password; suspension sets `banned_until` only; roles re-read per call.
- Jobs: cron → `net.http_post` to send-emails with Vault token; outbox retention; ops alert dedupe.

## 5. Trust boundaries and strongest source-visible control
| Boundary | Control |
|---|---|
| anon ↔ DB | RLS SELECT-only + explicit grants; `revoke … from public, anon` + default privileges in `private` |
| authenticated ↔ others' rows | RLS owner/role policies; `require_user/require_role` first in every definer |
| reviewer ↔ own submission | `assert_not_self_review`, `admin_target` |
| client ↔ storage | insert-only policies with `can_upload_*`; private buckets; signed URLs |
| cron/Edge ↔ DB | service_role grants limited to outbox/tree_media_paths; Vault secrets |
| browser ↔ script execution | CSP `script-self`, no inline; delegation grammar whitelist |
| Edge ↔ caller | `certificate` passes caller JWT (authz in SQL); `send-emails` token; `tree-media` CORS only |

## 6. Starting paths
`supabase/migrations/*.sql` (core_schema 0100, rpc_core 0200, rpc_operations 0300, api_surface 0400, storage 0410, jobs 0420, account_deletion 0500, admin_tools 20261026000100, notifications 0200, outbox 0220, anon_private 0230, profile/onboarding 0400, harvest_oil 20261101000100, certificates 0200, tree_profiles 20261102000100, my_assignments 0200), `supabase/functions/{send-emails,certificate,tree-media}/index.ts`, `src/supabase-client.src.mjs`, `public/{app.js,events.js,index.html,tree.mjs,verify.mjs,status.mjs,auth/reset.mjs,data-mappers.mjs}`, `firebase.json`, `capacitor.config.json`, `.github/workflows/ci.yml`, `.gitleaks.toml`, `package.json`, `backend/`, `render.yaml`.

## 7. Prior coverage
No prior ledger exists; all units are `none`.

## 8. Companion selection
WEB-PROTOCOL-AND-AUTH (password reset/recovery, JWT claim binding at Edge, CSRF on state-changing GET-landing, session invalidation on suspension); DATA-ISOLATION-AND-LIFECYCLE (owner enforcement, policy/query disagreement incl. definer bypass of `listed`, signed-reference overreach, enumeration oracles, export scope, stale authorization, retention); CLIENT-SIDE (DOM XSS via delegation grammar and localStorage, storage disclosure, navigation confusion, clickjacking headers); CLOUD-AND-DEPLOYMENT (signed-URL policy, secret exposure across Edge/Vault, unexpected reachability of `backend/`, edge/runtime mismatch of verify_jwt); RESOURCE-EXHAUSTION (pre-auth work on anon RPCs, quota scope, outbox growth, retry storms); SUPPLY-CHAIN (unbound Edge imports, CI pinning, gitleaks allowlist, deploy identity); DESKTOP-MOBILE (deep-link `faseela://` code handoff) — selected only for the auth-client unit. Excluded: MEMORY-SAFETY (no native code), AI-AND-LLM (no model/tool boundary), PROTOCOLS-RPC-AND-MESSAGING (no custom protocol/broker; PostgREST covered by ordinary blocks).
