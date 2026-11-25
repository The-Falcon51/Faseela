// Language fixes in code-built texts (run: node --test tests/).
// - legal-contracts modal: German strings, no "Investor Deed", sponsorship wording only
// - status labels of the farmer / mill "my submissions" list in Arabic, English and German
// - printed gift certificate: lang/dir follow the active language, no inline script (CSP script-src 'self')
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { STATUS_LABELS, statusLabel } from '../public/data-mappers.mjs';

const root = new URL('../', import.meta.url);
const appJs = fs.readFileSync(new URL('public/app.js', root), 'utf8');
const deDict = JSON.parse(fs.readFileSync(new URL('src/i18n/de.json', root), 'utf8'));

// Dictionary entry `key: "value"` inside the Arabic (first) or English (second) block of public/app.js.
function appDictValue(key, which) {
  const matches = [...appJs.matchAll(new RegExp(`\\n\\s+${key}: "([^"]*)"`, 'g'))].map(m => m[1]);
  return which === 'ar' ? matches[0] : matches[1];
}

// Runs renderLegalContractsContent (sections 1-7, the legal-contracts modal) against a tiny fake DOM.
function renderLegalModal(lang) {
  const start = appJs.indexOf('    function renderLegalContractsContent() {');
  const end = appJs.indexOf('      // 8. Farmer Partnership Contract Modal', start);
  assert.ok(start > 0 && end > start, 'renderLegalContractsContent sections 1-7 not found');
  const source = `${appJs.slice(start, end)}\n    }\n    renderLegalContractsContent();`;
  const els = new Map();
  const el = (key) => { if (!els.has(key)) els.set(key, { innerHTML: '', innerText: '' }); return els.get(key); };
  const dict = { ar: {}, en: {}, de: deDict };
  for (const key of ['legal_modal_title', 'legal_modal_sub', 'legal_tab_charter', 'legal_tab_investor', 'legal_tab_farmer', 'legal_tab_mill']) {
    dict.ar[key] = appDictValue(key, 'ar');
    dict.en[key] = appDictValue(key, 'en');
  }
  const state = { currentLang: lang };
  const context = {
    state,
    document: { getElementById: (id) => el(`#${id}`), querySelector: (sel) => el(sel) },
    tr3: (ar, en, de) => (state.currentLang === 'ar' ? ar : (state.currentLang === 'de' ? de : en)),
    t: (key) => dict[state.currentLang][key] ?? key,
    normalizeLang: (l) => (['ar', 'en', 'de'].includes(l) ? l : 'ar'),
    escapeHtml: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;')
  };
  vm.runInNewContext(source, context);
  return els;
}

const FORBIDDEN_IN_LEGAL_MODAL = /Investor|investor|usufruct|Nießbrauch|cadastral|كاداستر|net profits|liquidation|Urkunde|Deed|deed|صك|سند حيازة|مستثمر/;

test('legal-contracts modal: German readers get German, not English', () => {
  const els = renderLegalModal('de');
  assert.equal(els.get('[data-i18n="legal_tab_investor"]').innerText, 'Leistungsbeschreibung Baumpatenschaft');
  assert.equal(els.get('[data-i18n="legal_modal_title"]').innerText, deDict.legal_modal_title);
  assert.match(els.get('#legal-panel-investor').innerHTML, /Leistungsbeschreibung: Baumpatenschaft/);
  assert.match(els.get('#legal-panel-investor').innerHTML, /Kein Eigentum am Baum oder am Boden/);
  assert.match(els.get('#legal-panel-investor').innerHTML, /legal\/patenschaft\.html#de/);
  assert.match(els.get('#legal-panel-charter').innerHTML, /Zahlungsprüfung/);
  assert.match(els.get('#legal-panel-farmer').innerHTML, /Pflegevereinbarung/);
  assert.match(els.get('#legal-panel-mill').innerHTML, /Qualitätsstandard/);
  assert.equal(els.get('#legal-seal-title').innerText, 'Verifiziertes Faseela-Siegel');
  for (const [key, value] of els) {
    assert.doesNotMatch(value.innerHTML + value.innerText, /\b(?:Payment|Service description|What you receive|Article)\b/, `${key} still English for de`);
  }
});

test('legal-contracts modal: sponsorship wording in every language, never "Investor Deed"', () => {
  for (const lang of ['ar', 'en', 'de']) {
    const els = renderLegalModal(lang);
    for (const [key, value] of els) {
      assert.doesNotMatch(value.innerHTML + value.innerText, FORBIDDEN_IN_LEGAL_MODAL, `${lang} ${key}`);
    }
  }
  assert.equal(renderLegalModal('en').get('[data-i18n="legal_tab_investor"]').innerText, 'Service description: tree sponsorship');
  assert.equal(renderLegalModal('ar').get('[data-i18n="legal_tab_investor"]').innerText, 'وصف الخدمة: كفالة شجرة');
  assert.match(renderLegalModal('ar').get('#legal-panel-investor').innerHTML, /legal\/patenschaft\.html#ar/);
  assert.doesNotMatch(appJs, /Investor Deed/);
  for (const key of ['legal_tab_investor', 'legal_modal_title', 'legal_modal_sub']) {
    assert.doesNotMatch(deDict[key], FORBIDDEN_IN_LEGAL_MODAL, `de.json ${key}`);
  }
});

test('legal-contracts modal: no Arabic-or-English branch left in sections 1-7', () => {
  const start = appJs.indexOf('    function renderLegalContractsContent() {');
  const end = appJs.indexOf('      // 8. Farmer Partnership Contract Modal', start);
  assert.doesNotMatch(appJs.slice(start, end), /isEn\s*\?/);
});

test('status labels exist in Arabic, English and German', () => {
  for (const [status, entry] of Object.entries(STATUS_LABELS)) {
    assert.ok(entry.ar && entry.en && entry.de, `${status} lacks a language`);
    assert.equal(statusLabel(status, 'de'), entry.de);
    assert.equal(statusLabel(status, 'en'), entry.en);
    assert.equal(statusLabel(status, 'ar'), entry.ar);
    assert.equal(statusLabel(status), entry.ar);
  }
  assert.equal(statusLabel('approved', 'de'), 'Genehmigt');
  assert.equal(statusLabel('pending_review', 'fr'), 'Pending review');
  assert.equal(statusLabel('unknown_status', 'de'), 'unknown_status');
});

test('my-submissions list asks for status labels in the active language', () => {
  const start = appJs.indexOf('function renderServerSubmissions(kind)');
  const body = appJs.slice(start, appJs.indexOf('\n    }\n', start));
  assert.match(body, /statusLabel\(status, normalizeLang\(state\.currentLang\)\)/);
  assert.doesNotMatch(body, /statusLabel\(status, isEn/);
});

test('gift certificate print window: language attributes and no inline script', () => {
  const start = appJs.indexOf("printBtn.onclick = () => {");
  assert.ok(start > 0, 'gift print handler not found');
  const body = appJs.slice(start, appJs.indexOf('\n          };', start));
  assert.match(body, /<html lang="' \+ normalizeLang\(state\.currentLang\) \+ '" dir="' \+ \(state\.currentLang === 'ar' \? 'rtl' : 'ltr'\) \+ '">/);
  assert.doesNotMatch(body, /<script/i, 'inline script is blocked by the CSP (script-src self)');
  assert.match(body, /w\.document\.close\(\);[\s\S]*w\.print\(\)/, 'print must be triggered from the opener');
  assert.match(body, /escapeHtml\(recipient\)/);
  assert.match(body, /escapeHtml\(message\)/);
  assert.match(body, /escapeHtml\(data\.code\)/);
});

test('bundled client carries the same three-language status labels (window.FaseelaMappers)', () => {
  const bundle = fs.readFileSync(new URL('public/supabase-client.mjs', root), 'utf8');
  const js = (s) => s.replace(/[\u0080-\u00ff]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).toUpperCase());
  for (const entry of Object.values(STATUS_LABELS)) {
    assert.ok(bundle.includes(`en:"${entry.en}",de:"${js(entry.de)}"`), `bundle lacks German label for ${entry.en}`);
  }
  assert.match(bundle, /return r\?e==="ar"\?r\.ar:r\[e\]\|\|r\.en:String\(t\|\|""\)/);
});

test('English service-description items are verbatim from legal/patenschaft.html', () => {
  const page = fs.readFileSync(new URL('public/legal/patenschaft.html', root), 'utf8').replace(/&#039;|&apos;/g, "'");
  const html = renderLegalModal('en').get('#legal-panel-investor').innerHTML.replace(/&#039;/g, "'");
  const items = [...html.matchAll(/<li>([^<]+)<\/li>/g)].map(m => m[1]);
  assert.equal(items.length, 7);
  for (const item of items) assert.ok(page.includes(item), `not in patenschaft.html: ${item}`);
});

test('shipped index.html has no deed or land-title wording left in the legal panels', () => {
  const html = fs.readFileSync(new URL('public/index.html', root), 'utf8');
  const start = html.indexOf('id="legal-panel-charter"');
  const end = html.indexOf('id="legal-seal-title"', start);
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(html.slice(start, end), /صك|سند حيازة|طابو|مستثمر|SYR-INV-DEED|5 م²/);
});
