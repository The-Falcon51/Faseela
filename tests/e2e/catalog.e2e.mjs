// Catalogue suite: the database is the source of truth for the tree catalogue. A tree that exists only on the
// server appears in the marketplace, server texts replace the built-in ones, unlisted trees stay hidden.
import { chromium } from 'playwright';
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
const rows = [
  { treeId: 'tree_01', status: 'listed', name: 'اسم جديد', nameEn: '<b>Renamed</b> by admin', region: 'طرطوس', regionEn: 'Tartus', treeType: '', treeTypeEn: '', cropCategory: 'olive', totalShares: 4, availableShares: 2, pricePerShareMinor: 3500, landPriceMinor: 1500, hasLandOption: true, currency: 'USD', images: ['images/olive_branches_macro.webp'] },
  { treeId: 'tree_99', status: 'listed', name: 'شجرة الخادم', nameEn: 'Server Only Tree', region: 'إدلب', regionEn: 'Idlib', treeType: 'صوراني', treeTypeEn: 'Sorani', cropCategory: 'olive', plantedYear: 1990, estimatedAnnualYieldKg: 40, totalShares: 10, availableShares: 10, pricePerShareMinor: 4100, landPriceMinor: 0, hasLandOption: false, currency: 'USD', images: ['images/olive_branches_macro.webp'] },
  { treeId: 'tree_98', status: 'unlisted', name: 'مخفية', nameEn: 'Hidden Tree', cropCategory: 'olive', totalShares: 4, availableShares: 4, pricePerShareMinor: 1000, currency: 'USD' }
];
window.FaseelaFirebase = window.FaseelaBackend = { backend: 'supabase', listPublicTrees: async () => rows.map((row) => mappers.mapPublicTree(row)), pendingGiftCode: () => '', pendingReferralCode: () => '' };
setTimeout(() => window.dispatchEvent(new CustomEvent('faseela-auth-state', { detail: null })), 200);`;

const browser = await chromium.launch({ executablePath: process.env.CHR || undefined });
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await ctx.route('**/supabase-client.mjs', (r) => r.fulfill({ contentType: 'text/javascript', body: MOCK }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  await page.addInitScript(() => { try { localStorage.setItem('faseela_lang', 'en'); } catch (e) {} });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.serverCatalogLoaded === true, null, { timeout: 15000 });
  const trees = await page.evaluate(() => Object.fromEntries(state.trees.filter((t) => ['tree_01', 'tree_99', 'tree_98'].includes(t.id)).map((t) => [t.id, { name: t.tree_name_en, ar: t.tree_name, region: t.region_en, price: t.price_per_share, total: t.total_shares, only: t.server_only === true, farm: t.farm_name_en, logs: (t.maintenance_logs || []).length, land: !!(t.land_parcel && t.land_parcel.has_land_option), listed: t.server_listed, images: t.images }])));
  assert.equal(trees.tree_98, undefined, 'an unlisted server tree never appears');
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
  console.log(JSON.stringify({ ok: true, suite: 'catalog' }));
} finally {
  await browser.close();
  server.kill();
}
