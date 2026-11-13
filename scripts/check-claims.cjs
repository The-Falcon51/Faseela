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
