// Catalogue suite: the database is the source of truth for the tree catalogue. A tree that exists only on the
// server appears in the marketplace, server texts replace the built-in ones, unlisted trees stay hidden.
import { chromium } from 'playwright';
import { hermetic } from './hermetic.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = process.env.E2E_CATALOG_PORT || '8096';
const server = spawn('python3', ['-m', 'http.server', port, '--bind', '127.0.0.1', '--directory', path.join(root, 'public')], { stdio: 'ignore' });
await new Promise((resolve) => setTimeout(resolve, 800));
const MOCK = `
import * as mappers from './data-mappers.mjs';
window.FaseelaMappers = mappers;
const rows = [
  { treeId: 'tree_01', status: 'listed', name: 'اسم جديد', nameEn: '<b>Renamed</b> by admin', region: 'طرطوس', regionEn: 'Tartus', treeType: '', treeTypeEn: '', cropCategory: 'olive', totalShares: 4, availableShares: 2, pricePerShareMinor: 3500, landPriceMinor: 1500, hasLandOption: true, currency: 'USD', images: ['images/olive_branches_macro.webp'] },
  { treeId: 'tree_99', status: 'listed', name: 'شجرة الخادم', nameEn: 'Server Only Tree', region: 'إدلب', regionEn: 'Idlib', treeType: 'صوراني', treeTypeEn: 'Sorani', cropCategory: 'olive', plantedYear: 1990, estimatedAnnualYieldKg: 40, totalShares: 10, availableShares: 10, pricePerShareMinor: 4100, landPriceMinor: 0, hasLandOption: false, currency: 'USD', images: ['images/olive_branches_macro.webp'] },
  { treeId: 'tree_97', status: 'listed', name: 'نخلة الخادم', nameEn: 'Server Date Palm', region: 'دير الزور', regionEn: 'Deir ez-Zor', treeType: 'خستاوي', treeTypeEn: 'Khastawi', cropCategory: 'date', totalShares: 10, availableShares: 10, pricePerShareMinor: 3000, landPriceMinor: 0, hasLandOption: false, currency: 'USD', images: [] },
  { treeId: 'tree_02', status: 'listed', name: 'نخلة معدلة', nameEn: 'Olive Turned Date', region: 'دير الزور', regionEn: 'Deir ez-Zor', treeType: '', treeTypeEn: '', cropCategory: 'date', totalShares: 10, availableShares: 10, pricePerShareMinor: 3000, landPriceMinor: 0, hasLandOption: false, currency: 'USD', images: [] },
  { treeId: 'tree_98', status: 'unlisted', name: 'مخفية', nameEn: 'Hidden Tree', cropCategory: 'olive', totalShares: 4, availableShares: 4, pricePerShareMinor: 1000, currency: 'USD' }
];
window.FaseelaFirebase = window.FaseelaBackend = { backend: 'supabase', listPublicTrees: async () => rows.map((row) => mappers.mapPublicTree(row)), pendingGiftCode: () => '', pendingReferralCode: () => '',
  submitHarvestBatch: async (p) => { (window.__harvest = window.__harvest || []).push(p); if (p.harvestKg === 99) throw Object.assign(new Error('x'), { code: 'already-exists' }); if (p.harvestKg === 98) throw Object.assign(new Error('x'), { code: 'not-found' }); return { data: { batchId: 'b1', status: 'pending_review' } }; },
  requestOil: async (p) => { window.__oil = p; return { data: { requestId: 'r1', status: 'pending', unit: 'kg' } }; } };
setTimeout(() => window.dispatchEvent(new CustomEvent('faseela-auth-state', { detail: null })), 200);`;

const browser = hermetic(await chromium.launch({ executablePath: process.env.CHR || undefined }));
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await ctx.route('**/supabase-client.mjs*', (r) => r.fulfill({ contentType: 'text/javascript', body: MOCK }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  await page.addInitScript(() => { try { localStorage.setItem('faseela_lang', 'en'); } catch (e) {} });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.serverCatalogLoaded === true, null, { timeout: 15000 });
  const trees = await page.evaluate(() => Object.fromEntries(state.trees.filter((t) => ['tree_01', 'tree_99', 'tree_98'].includes(t.id)).map((t) => [t.id, { name: t.tree_name_en, ar: t.tree_name, region: t.region_en, price: t.price_per_share, total: t.total_shares, only: t.server_only === true, farm: t.farm_name_en, logs: (t.maintenance_logs || []).length, land: !!(t.land_parcel && t.land_parcel.has_land_option), listed: t.server_listed, images: t.images }])));
  assert.equal(trees.tree_98, undefined, 'an unlisted server tree never appears');
  const dates = await page.evaluate(() => state.trees.filter((t) => ['tree_97', 'tree_02'].includes(t.id)).map((t) => ({ id: t.id, crop: t.crop_category, images: t.images, type: t.tree_type_en || '' })));
  assert.equal(dates.length, 2, 'both date palms are listed');
  for (const d of dates) {
    assert.equal(d.crop, 'date', `${d.id} keeps its crop`);
    assert.deepEqual(d.images, ['images/tree_date_palm.webp'], `${d.id} shows the date palm picture, not an olive`);
    assert.doesNotMatch(d.type, /olive/i, `${d.id} carries no olive variety text`);
  }
  assert.deepEqual(trees.tree_99, { name: 'Server Only Tree', ar: 'شجرة الخادم', region: 'Idlib', price: 41, total: 10, only: true, farm: '', logs: 0, land: false, listed: true, images: ['images/olive_branches_macro.webp'] });
  assert.equal(trees.tree_01.name, 'bRenamed/b by admin', 'server text replaces the built-in one, markup characters removed');
  assert.equal(trees.tree_01.ar, 'اسم جديد'); assert.equal(trees.tree_01.only, false); assert.equal(trees.tree_01.price, 35);
  await page.evaluate(() => navigateTo('marketplace'));
  await page.waitForFunction(() => /Server Only Tree/.test(document.body.innerText), null, { timeout: 10000 });
  assert.match(await page.evaluate(() => document.body.innerText), /bRenamed\/b by admin/);
  assert.equal(await page.evaluate(() => document.querySelectorAll('b').length ? [...document.querySelectorAll('b')].some((b) => b.textContent === 'Renamed') : false), false, 'no markup from server text');
  await page.evaluate(() => viewTreeDetails('tree_99'));
  await page.waitForTimeout(800);
  assert.deepEqual(errors, [], 'a server-only tree opens without page errors');
  // Farmer harvest form: only for an assigned tree of a weighed crop; weights are checked before anything is sent.
  await page.evaluate(() => { farmerQuick.assignments = { trees: [{ treeId: 'tree_01', nameEn: 'Olive' }] }; renderFqrTrees(); });
  assert.equal(await page.evaluate(() => document.getElementById('farmer-harvest').classList.contains('hidden')), true, 'no harvest form for olive trees');
  await page.evaluate(() => { farmerQuick.assignments = { trees: [{ treeId: 'tree_01', nameEn: 'Olive' }, { treeId: 'tree_14', nameEn: '<i>Almond</i>' }, { treeId: 'tree_97', nameEn: 'Date Palm', regionEn: 'Deir ez-Zor' }] }; renderFqrTrees(); });
  const form = await page.evaluate(() => ({ hidden: document.getElementById('farmer-harvest').classList.contains('hidden'), options: [...document.querySelectorAll('#fh-tree option')].map((o) => o.value + '|' + o.textContent), markup: document.querySelectorAll('#fh-tree i').length }));
  assert.deepEqual(form, { hidden: false, options: ['tree_14|<i>Almond</i>', 'tree_97|Date Palm • Deir ez-Zor'], markup: 0 });
  const harvestMsg = () => page.evaluate(() => document.getElementById('fh-msg').textContent);
  const fillHarvest = (gross, net) => page.evaluate(([g, n]) => { document.getElementById('fh-gross').value = g; document.getElementById('fh-net').value = n; return submitFarmerHarvest(); }, [gross, net]);
  await fillHarvest('20', '24');
  assert.match(await harvestMsg(), /net weight cannot exceed/);
  await fillHarvest('', '5');
  assert.match(await harvestMsg(), /gross weight in kilograms \(0\.1 to 5000\)/);
  await fillHarvest('12', 'abc');
  assert.match(await harvestMsg(), /net weight in kilograms \(0 to 5000\)/);
  assert.equal(await page.evaluate(() => window.__harvest), undefined, 'nothing is sent while the weights are wrong');
  await fillHarvest('30', '24,5');
  assert.deepEqual(await page.evaluate(() => window.__harvest), [{ treeId: 'tree_14', harvestKg: 30, netKg: 24.5 }], 'decimal comma accepted, numbers sent');
  assert.match(await harvestMsg(), /waiting for the quality review/);
  assert.deepEqual(await page.evaluate(() => [document.getElementById('fh-gross').value, document.getElementById('fh-net').value, document.getElementById('fh-submit').disabled]), ['', '', false], 'form cleared and usable again');
  await fillHarvest('99', '1');
  assert.match(await harvestMsg(), /already recorded/);
  await fillHarvest('98', '1');
  assert.match(await harvestMsg(), /No weighed harvest is recorded for this tree/);
  // Own history: a harvest row shows both weights in kilograms and its review status.
  const history = await page.evaluate(() => { state.myPressingBatches = [{ id: 'b1', treeId: 'tree_14', millId: 'farm', isHarvest: true, harvestKg: 30, netKg: 24.5, status: 'pending_review', createdAt: Date.now() }, { id: 'b2', treeId: 'tree_01', millId: 'mill_01', isHarvest: false, oilYieldLiters: 7, status: 'certified' }]; renderFarmerHarvestHistory(); return { rows: document.querySelectorAll('#fh-history li').length, text: document.getElementById('fh-history').textContent, markup: document.querySelectorAll('#fh-history i').length }; });
  assert.equal(history.rows, 1, 'mill pressings are not listed as harvests');
  assert.match(history.text, /<i>Almond<\/i> • Gross 30 kg • Net 24\.5 kg[\s\S]*Waiting for quality review/);
  assert.equal(history.markup, 0);
  // My oil: litres and kilograms are never added together, and one request carries only one of them.
  const oil = await page.evaluate(async () => {
    state.myOilAllocations = [
      { id: 'a1', treeId: 'tree_01', litersMl: 7400, status: 'available', unit: 'l' },
      { id: 'a2', treeId: 'tree_14', litersMl: 12500, status: 'available', unit: 'kg' },
      { id: 'a3', treeId: 'tree_01', litersMl: 300, status: 'available', unit: null }, // crop lookup failed: no unit is guessed
      { id: 'a4', treeId: 'tree_14', litersMl: 900, status: 'requested' } // older client without the field: the crop of the tree decides
    ];
    const out = { total: allocationTotalsText(allocationTotals(state.myOilAllocations)), groups: oilRequestGroups().map((g) => g.key + '=' + QUANTITY_TEXT(g.amount, g.unit)) };
    openOilRequestModal();
    out.choiceHidden = document.getElementById('oil-group-fields').classList.contains('hidden');
    out.options = [...document.querySelectorAll('#oil-group-options input')].map((i) => i.value + (i.checked ? '*' : ''));
    out.oil = [document.getElementById('oil-modal-title').textContent, document.getElementById('oil-modal-liters').textContent, document.getElementById('oil-kind-pickup-lbl').textContent];
    document.querySelector('#oil-group-options input[value="kg"]').click();
    out.harvest = [document.getElementById('oil-modal-title').textContent, document.getElementById('oil-modal-liters').textContent, document.getElementById('oil-kind-pickup-lbl').textContent];
    document.querySelector('input[name="oil-kind"][value="donate"]').click();
    await submitOilRequest();
    out.sent = window.__oil ? [window.__oil.kind, window.__oil.allocationIds.join(',')] : null;
    state.myOilAllocations = [{ id: 'a2', treeId: 'tree_14', litersMl: 12500, status: 'available', unit: 'kg' }];
    openOilRequestModal();
    out.single = [document.getElementById('oil-group-fields').classList.contains('hidden'), document.getElementById('oil-modal-title').textContent, document.getElementById('oil-modal-liters').textContent];
    closeModal('modal-oil-request');
    state.myOilAllocations = [];
    return out;
  });
  assert.deepEqual(oil, {
    total: '7.4 L + 13.4 kg + 0.3', groups: ['l=7.4 L', 'kg=12.5 kg', 'tree:tree_01=0.3'], choiceHidden: false, options: ['l*', 'kg', 'tree:tree_01'],
    oil: ['Request your oil', '7.4 L', 'Pickup at the mill'], harvest: ['Request your harvest', '12.5 kg', 'I will pick it up'],
    sent: ['donate', 'a2'], single: [true, 'Request your harvest', '12.5 kg']
  });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, suite: 'catalog' }));
} finally {
  await browser.close();
  server.kill();
}
