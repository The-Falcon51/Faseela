// Sponsorship wording guards (run: node --test tests/).
// Faseela sells tree sponsorships: no ownership, no land title, no investment, no return and no money
// paid out to sponsors. These tests keep three regressions out of the shipped client:
//   1. a harvest "cash-out" (selling the sponsor's oil and paying the sponsor) - there is no server
//      function for it, so any such UI is a promise the platform cannot and may not keep;
//   2. a promise that the land grows in value (capital gain);
//   3. Arabic texts built in code with tr3(ar, en, de) that say ownership where EN/DE say sponsorship.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const appJs = read('public/app.js');
const indexHtml = read('public/index.html');
const deJson = read('src/i18n/de.json');
const deJs = read('public/i18n-de.js');

// Reads one JS string literal ('...', "..." or `...` with ${...}) starting at text[i]; returns [value, end].
function readLiteral(text, i) {
  const quote = text[i];
  if (!`'"\``.includes(quote)) return [null, i];
  let out = '';
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === '\\') { out += text.slice(j, j + 2); j += 2; continue; }
    if (c === quote) return [out, j + 1];
    if (quote === '`' && c === '$' && text[j + 1] === '{') {
      let depth = 1;
      let k = j + 2;
      while (k < text.length && depth > 0) {
        if (text[k] === '{') depth += 1;
        else if (text[k] === '}') depth -= 1;
        k += 1;
      }
      out += text.slice(j, k);
      j = k;
      continue;
    }
    out += c;
    j += 1;
  }
  return [null, j];
}

// Every tr3(ar, en, de) call whose three arguments are plain literals.
function tr3Calls(text) {
  const calls = [];
  const re = /\btr3\(\s*/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const args = [];
    let i = m.index + m[0].length;
    for (let n = 0; n < 3; n += 1) {
      const [value, end] = readLiteral(text, i);
      if (value === null) break;
      args.push(value);
      i = end;
      const sep = /^\s*,\s*/.exec(text.slice(i, i + 200));
      if (n < 2) {
        if (!sep) break;
        i += sep[0].length;
      }
    }
    if (args.length === 3) calls.push({ line: text.slice(0, m.index).split('\n').length, ar: args[0], en: args[1], de: args[2] });
  }
  return calls;
}

const calls = tr3Calls(appJs);

test('the tr3 scanner finds the texts built in code', () => {
  assert.ok(calls.length > 500, `only ${calls.length} tr3 calls parsed`);
});

test('F17: the harvest modal offers delivery only - no cash-out panel, tab or payout channels', () => {
  for (const marker of ['id="harvest-panel-cash"', 'id="tab-oil-cash"', 'id="oil-cash-channel"', 'id="oil-cash-account-num"',
    'data-i18n="oil_tab_cash"', 'value="liquidate"', 'data-i18n="dash_mode_liquidate_title"']) {
    assert.ok(!indexHtml.includes(marker), `public/index.html still contains ${marker}`);
  }
  for (const marker of ['isCash', 'harvest-panel-cash', 'harvest-cash-calc-desc', 'confirmYieldLiquidation', "actionType === 'liquidate'",
    'Verified Bank Payout', 'liquidationCashRate']) {
    assert.ok(!appJs.includes(marker), `public/app.js still contains ${marker}`);
  }
  for (const key of ['oil_tab_cash', 'oil_cash_spec_desc', 'oil_cash_method_lbl', 'oil_channel_bank', 'dash_mode_liquidate_desc', 'dash_btn_confirm_liquidate']) {
    assert.ok(!new RegExp(`\\b${key}\\b`).test(appJs), `app.js dictionary still has ${key}`);
    assert.ok(!deJson.includes(`"${key}"`), `de.json still has ${key}`);
    assert.ok(!deJs.includes(`"${key}"`), `i18n-de.js still has ${key}`);
  }
});

test('F17: no text built in code promises money for the sponsor\'s oil', () => {
  // Farm payouts (money the platform pays to partner farms) are legitimate; sponsors never get money for their oil.
  const money = /cash ?out|cash liquidation|liquidation confirmed|net payout|zum Exportpreis bestätigt|Exportverkauf|Verkaufsoption|Verkauf bestätigt|تسييل .{0,20}(?:لتر|الحصة|كاش)|التسييل (?:النقدي|المالي)|تم التسييل|المردود الصافي/i;
  const hits = calls.filter((c) => money.test(c.ar) || money.test(c.en) || money.test(c.de)).map((c) => `app.js:${c.line} ${c.en}`);
  assert.deepEqual(hits, []);
  // The selector never falls through to a money option, even for a 'liquidate' choice stored by an older version.
  assert.match(appJs, /function selectHarvestYieldAction\(actionType\) \{\n(?:\s*\/\/.*\n)*\s*if \(actionType !== 'donate'\) actionType = 'dispatch';/);
});

test('F18: nothing promises that the land grows in value', () => {
  const growth = /Capital Land Growth|Land Capital Growth|Wertzuwachs des Landes|Wertzuwachs der Landfläche|Wertsprung|Kapitalzuwachs|capital gain|capital growth|land valuation|compounded equity|land perimeter appreciation|نمو قيمة الأرض|القيمة الرأسمالية للأرض|ربح رأسمالي|تضاعف رأس المال|سعر الأرض|ارتفاع قيمة حرم الأرض/i;
  const sources = { 'public/index.html': indexHtml, 'src/i18n/de.json': deJson, 'public/i18n-de.js': deJs };
  for (const [file, text] of Object.entries(sources)) {
    const m = growth.exec(text);
    assert.equal(m, null, `${file} still promises value growth: ${m && text.slice(Math.max(0, m.index - 60), m.index + 60)}`);
  }
  // app.js: identifiers of seed data may keep the word, shown texts may not.
  const shown = calls.filter((c) => growth.test(c.ar) || growth.test(c.en) || growth.test(c.de)).map((c) => `app.js:${c.line} ${c.en}`);
  assert.deepEqual(shown, []);
  for (const key of ['virgin_kpi_growth_lbl', 'virgin_kpi_growth_sub']) assert.ok(!appJs.includes(key), `${key} is still defined`);
  for (const key of ['vstage1_desc', 'vstage3_desc', 'vstage4_desc', 'dash_roi_stage_1_desc', 'virgin_hero_desc', 'dash_virgin_holdings_sub']) {
    for (const m of appJs.matchAll(new RegExp(`\\b${key}: "([^"]*)"`, 'g'))) assert.doesNotMatch(m[1], growth, `${key}: ${m[1]}`);
  }
  assert.ok(!appJs.includes('vg.projected_land_appreciation_pct'), 'the grove card still renders the land appreciation value');
});

test('F19: Arabic texts built with tr3 say sponsorship, not ownership', () => {
  const ownership = /ملكية|ملكيت|نقل ملك|امتلك|تملّ?ك|سند الملكية/;
  // A sentence that states there is NO ownership ("لا ملكية …") is exactly what the product needs and is allowed.
  const denies = /(^|[\s،.])(لا|ليست?|دون|بدون|غير)\s+(\S+\s+)?(ملكية|تملّ?ك|امتلاك)/;
  const hits = calls.filter((c) => ownership.test(c.ar) && !denies.test(c.ar)).map((c) => `app.js:${c.line} ${c.ar}`);
  assert.deepEqual(hits, []);
  const titleHolder = /Title Holder|Invest in Tree|investment portfolio|transferred to your portfolio/i;
  const enHits = calls.filter((c) => titleHolder.test(c.en)).map((c) => `app.js:${c.line} ${c.en}`);
  assert.deepEqual(enHits, []);
});

test('F19: the named certificate and toast texts use sponsorship wording in all three languages', () => {
  const expect = [
    ['شهادة كفالة التنوع الزراعي لمقسم 15 م²', 'Multi-Crop Agroforestry Sponsorship Certificate & 15m² Plot'],
    ['شهادة كفالة شجرة زيتون سورية ومقسم زراعي (5 م²)', 'Syrian Olive Tree & 5m² Parcel Sponsorship Certificate'],
    ['شهادة كفالة شجرة زيتون سورية', 'Certificate of Syrian Olive Tree Sponsorship'],
    ['🎉 تم التأكيد: أُضيفت ${title} إلى كفالاتك بنجاح!', '🎉 Confirmed: ${title} has been added to your sponsorships!'],
    ['✅ تم اعتماد الكفالة ${reqId} وإصدار الحصص وشهادة الكفالة بنجاح!', '✅ Sponsorship ${reqId} approved & shares issued successfully!'],
    ['🔒 الكفالة مطلوبة: استلام حصة الزيت متاح فقط لكفلاء الأشجار ذوي الحصص المؤكدة.', '🔒 Sponsorship required: oil delivery is available only to verified tree sponsors.'],
  ];
  for (const [ar, en] of expect) {
    const call = calls.find((c) => c.ar === ar);
    assert.ok(call, `missing tr3 text: ${ar}`);
    assert.equal(call.en, en);
    assert.match(call.de, /Patenschaft|Baumpate/);
  }
});
