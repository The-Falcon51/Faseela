#!/usr/bin/env node
// Build guard (review finding F-02): fails if unbacked financial claims reappear in the
// shipped HTML — fabricated reserve amounts, percentage returns, guarantee wording,
// "100% backed" coverage claims or escrow claims. Extend BANNED when copy rules change.
const fs = require('node:fs');
const path = require('node:path');

const shippedHtmlFiles = [
  'public/index.html',
  'android/app/src/main/assets/public/index.html'
];

const BANNED = [
  { pattern: /425,000|425k|\$425/g, label: 'fabricated reserve amount' },
  { pattern: /\d{1,3}\s?%\+?\s?(?:Annual|Compound)?\s?(?:ROI|Economic Return)/g, label: 'percentage return' },
  { pattern: /ROI\s?~?\d/g, label: 'percentage return' },
  { pattern: /(?<!')\bguarantee(?:d|s)?\b/gi, label: 'guarantee wording' },
  { pattern: /مضمون/g, label: 'guarantee wording (ar)' },
  { pattern: /100% (?:Bank Secured|Backed|Covered|asset-backed|capital)/g, label: 'unbacked coverage claim' },
  { pattern: /\bEscrow\b/g, label: 'escrow claim' },
  { pattern: /حساب الضمان/g, label: 'escrow claim (ar)' }
];

let findings = 0;
for (const relativePath of shippedHtmlFiles) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  if (!fs.existsSync(filePath)) continue;
  const html = fs.readFileSync(filePath, 'utf8');
  for (const { pattern, label } of BANNED) {
    for (const match of html.matchAll(pattern)) {
      const line = html.slice(0, match.index).split('\n').length;
      const context = html.slice(Math.max(0, match.index - 50), match.index + match[0].length + 50).replace(/\s+/g, ' ');
      process.stderr.write(`[CLAIM] ${relativePath}:${line} ${label}: …${context}…\n`);
      findings += 1;
    }
  }
}

// Legal placeholders are reported (not fatal) so they stay visible until counsel fills them in.
const legalDir = path.resolve(__dirname, '..', 'public/legal');
if (fs.existsSync(legalDir)) {
  const open = fs.readdirSync(legalDir).filter((f) => f.endsWith('.html'))
    .map((f) => [f, (fs.readFileSync(path.join(legalDir, f), 'utf8').match(/\[PLATZHALTER/g) || []).length])
    .filter(([, n]) => n > 0);
  for (const [file, n] of open) console.warn(`⚠ public/legal/${file}: ${n} open [PLATZHALTER] item(s) — complete before public launch.`);
}

if (findings > 0) {
  process.stderr.write(`${findings} unbacked claim(s) found. Rewrite the copy or get legal sign-off before shipping.\n`);
  process.exit(1);
}
console.log('✅ No unbacked financial claims in shipped HTML.');

// ---- Wording ratchet --------------------------------------------------------------------
// Most copy lives outside index.html (public/app.js dictionaries, the German dictionary, the
// manifest). Investment / land-title / return wording there is a regulatory risk (prospectus
// duty for "investments", land sales). It cannot be removed in one step, so the count per
// term and file is frozen in scripts/claims-baseline.json: a build fails when any count
// rises, and the baseline is lowered as copy is rewritten (`node scripts/check-claims.cjs
// --update-baseline` after a clean-up). Counts include identifiers in app.js; only the
// direction matters.
const RATCHET_FILES = ['public/index.html', 'public/app.js', 'src/i18n/de.json', 'public/manifest.json'];
const RATCHET_TERMS = [
  { label: 'land title (ar)', pattern: /طابو/g },
  { label: 'land title', pattern: /\bTabu\b|\bGrundbuch|\bcadastral\b|كاداستر/gi },
  { label: 'deed / usufruct', pattern: /\busufruct\b|\bdeeds?\b|\bNießbrauch|سند حيازة|صك/gi },
  { label: 'investment wording', pattern: /\binvest(?:or|ors|ment|ments|ing)?\b|\bInvestition|\bAnleger|استثمار|مستثمر/gi },
  { label: 'return / profit wording', pattern: /\bROI\b|\bdividends?\b|\bcapital gains?\b|\bappreciation\b|\bRendite|أرباح|عوائد|ربح رأسمالي/gi },
  { label: 'escrow', pattern: /\bescrow\b|\bTreuhand|حساب الضمان/gi }
];
const baselinePath = path.resolve(__dirname, 'claims-baseline.json');
const current = {};
for (const relativePath of RATCHET_FILES) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  if (!fs.existsSync(filePath)) continue;
  // Text between the two markers is not counted: the assistant has to name these words to say that
  // sponsorship is NOT an investment and that land is NOT offered, and to recognise such questions.
  const text = fs.readFileSync(filePath, 'utf8').replace(/\/\/ claims-ratchet:off[\s\S]*?\/\/ claims-ratchet:on/g, '');
  current[relativePath] = {};
  for (const { label, pattern } of RATCHET_TERMS) current[relativePath][label] = (text.match(pattern) || []).length;
}
if (process.argv.includes('--update-baseline')) {
  fs.writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
  console.log('claims-baseline.json updated.');
  process.exit(0);
}
if (!fs.existsSync(baselinePath)) {
  process.stderr.write('scripts/claims-baseline.json is missing. Run: node scripts/check-claims.cjs --update-baseline\n');
  process.exit(1);
}
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
let regressions = 0;
let remaining = 0;
for (const [file, counts] of Object.entries(current)) {
  for (const [label, count] of Object.entries(counts)) {
    const allowed = (baseline[file] && baseline[file][label]) || 0;
    remaining += count;
    if (count > allowed) {
      process.stderr.write(`[WORDING] ${file}: "${label}" rose from ${allowed} to ${count}. Use sponsorship / pre-purchase wording instead.\n`);
      regressions += 1;
    }
  }
}
if (regressions > 0) process.exit(1);
console.log(`✅ Wording ratchet held (${remaining} legacy occurrences still to rewrite).`);
