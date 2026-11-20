# functions/ — retired Firebase backend (reference only)

Since 2026-10-20 the backend runs on **Supabase** (`supabase/migrations`). This folder is no
longer deployed (`firebase.json` contains only `hosting`).

What is still used:

- `domain.js` — canonical tree builder for `scripts/supabase-seed.cjs` and the business-rule
  reference (limits, four-eyes, land = full tree) that the SQL RPCs re-implement.
- `npm --prefix functions test` — unit tests of `domain.js` (run by `npm test`).

What is retired: `index.js` (Cloud Functions), the emulator suites in `test/*.emulator.test.js`
and `test/*.rules.test.js` (their rules files moved to `legacy/firebase/`). The equivalent checks
now live in `supabase/tests/security.test.sql`.
