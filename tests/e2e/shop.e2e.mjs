// Farm shop (public/shop.js) against a mocked backend:
//   1. a visitor sees listed products as text, an openly shown fee line, and cannot order without signing in,
//   2. a customer orders: one farm per basket, server quote, address check, changed price, payment and cancel,
//   3. a farm account submits a product, keeps the stock and sees orders without customer data,
//   4. the tab stays away when there is nothing behind it; German texts; axe in light and dark.
// Run: node tests/e2e/shop.e2e.mjs   (CHR=/path/to/chrome to use a preinstalled Chromium)
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = process.env.E2E_PORT || '8099';
const base = `http://127.0.0.1:${port}/`;
const server = spawn('python3', ['-m', 'http.server', port, '--bind', '127.0.0.1', '--directory', path.join(root, 'public')], { stdio: 'ignore' });
await new Promise((resolve) => setTimeout(resolve, 800));

const XSS = '<img src=x onerror="window.__xss=1">';
const MOCK_CLIENT = `
import * as mappers from './data-mappers.mjs';
window.FaseelaMappers = mappers;
const q = new URLSearchParams(location.search);
const role = q.get('mockRole') || '';
const fail = (code) => Object.assign(new Error(code), { code });
const watch = (rows) => (cb) => { setTimeout(() => cb(rows), 30); return () => {}; };
const product = (id, farmId, extra) => ({ id, farmId, category: 'oil', name: 'زيت ' + id, nameEn: 'Oil ' + id, description: '', descriptionEn: 'Cold pressed', unit: '500 ml', priceMinor: 1200, currency: 'EUR', stockUnits: 10, ...extra });
const order = (status, extra) => ({ orderId: 'a'.repeat(64), status, farmId: 'farm_a', currency: 'EUR', itemsMinor: 2400, shippingMinor: 900, feeBps: 1500, feeMinor: 360, farmNetMinor: 2040, totalMinor: 3300, destCountry: 'DE',
  paymentReference: 'FO-AAAAAAAAAA', expiresAt: Date.now() + 86400000, createdAt: Date.now(), reviewNote: '', trackingCode: '', lines: [{ productId: 'p1', name: ${JSON.stringify(XSS)}, unit: '500 ml', unitPriceMinor: 1200, quantity: 2, lineMinor: 2400 }], ...extra });
const S = window.__shop = { calls: [], orders: [], quotes: 0, channels: q.get('accounts') === 'none' ? [] : [{ id: 'bank_iban', titleAr: 'حساب', titleEn: 'Bank account', account: 'DE00 1234' }],
  farmProducts: [{ productId: 'own1', category: 'oil', name: 'زيت المزرعة', nameEn: 'Farm oil', description: '', descriptionEn: '', unit: '1 l', priceMinor: 2000, currency: 'EUR', stockUnits: 4, status: 'listed', reviewNote: '' },
    { productId: 'own2', category: 'dates', name: 'تمر', nameEn: 'Dates', description: '', descriptionEn: '', unit: '1 kg', priceMinor: 900, currency: 'EUR', stockUnits: 0, status: 'rejected', reviewNote: 'Please add the harvest year' }] };
window.FaseelaFirebase = window.FaseelaBackend = {
  backend: 'supabase', calls: [],
  listPublicTrees: async () => [],
  listOrigins: async () => ({ countries: [], farms: [{ farmId: 'farm_a', countryCode: 'SY', name: 'مزرعة أ', nameEn: 'Farm A' }, { farmId: 'farm_b', countryCode: 'SY', name: 'مزرعة ب', nameEn: 'Farm B' }, { farmId: 'farm_es', countryCode: 'ES', name: 'مزرعة', nameEn: 'Finca' }] }),
  listProducts: async () => q.get('shop') === 'empty' ? { products: [], shippingRates: [] } : { products: [
      product('p1', 'farm_a', { nameEn: ${JSON.stringify(XSS)} }), product('p2', 'farm_a', { nameEn: 'Green olives', category: 'olives', priceMinor: 500, stockUnits: 3 }),
      product('p3', 'farm_b', { nameEn: 'Farm B oil' }), product('p4', 'farm_a', { nameEn: 'Sold out oil', stockUnits: 0 }), product('p5', 'farm_es', { nameEn: 'Spanish oil' })],
    shippingRates: [{ originCountry: 'SY', destCountry: 'DE', amountMinor: 900, currency: 'EUR' }, { originCountry: 'SY', destCountry: 'FR', amountMinor: 1200, currency: 'EUR' }] },
  marketplaceConfig: async () => ({ data: { feeBps: 1500, shopOpen: q.get('shop') !== 'closed' } }),
  quoteOrder: async (p) => { S.calls.push(['quoteOrder', p]); S.quotes += 1; const items = p.items.reduce((sum, i) => sum + (i.productId === 'p2' ? 500 : 1200) * i.quantity, 0) + (window.__priceUp && S.quotes > 1 ? 100 : 0);
    const fee = Math.round(items * 0.15); const ship = p.destCountry === 'FR' ? 1200 : 900;
    return { data: { farmId: 'farm_a', destCountry: p.destCountry, currency: 'EUR', itemsMinor: items, feeBps: 1500, feeMinor: fee, farmNetMinor: items - fee, shippingMinor: ship, totalMinor: items + ship,
      lines: p.items.map((i) => ({ productId: i.productId, name: 'Oil', unit: '500 ml', unitPriceMinor: 1200, quantity: i.quantity, lineMinor: 1200 * i.quantity })) } }; },
  createOrder: async (p) => { S.calls.push(['createOrder', p]); if (window.__orderFails) throw fail('out-of-stock'); S.orders = [order('awaiting_payment')]; return { data: S.orders[0] }; },
  listMyOrders: async () => ({ data: { orders: S.orders } }),
  reportOrderPayment: async (p) => { S.calls.push(['reportOrderPayment', p]); S.orders = [order('under_review')]; return { data: {} }; },
  cancelMyOrder: async (p) => { S.calls.push(['cancelMyOrder', p]); S.orders = [order('cancelled')]; return { data: {} }; },
  paymentInstructions: async () => ({ data: { channels: S.channels } }),
  farmOverview: async () => ({ data: { farms: role === 'farmer' ? [{ farmId: 'farm_a', name: 'مزرعة أ', nameEn: 'Farm A', countryCode: 'SY', listed: true, products: S.farmProducts,
    orders: [{ ...order('paid'), paymentReference: undefined, lines: [{ productId: 'own1', name: 'Farm oil', unit: '1 l', unitPriceMinor: 2000, quantity: 1, lineMinor: 2000 }], itemsMinor: 2000, feeMinor: 300, farmNetMinor: 1700 }],
    balances: [{ currency: 'EUR', amountMinor: 1700 }] }] : [] } }),
  farmerUpsertProduct: async (p) => { S.calls.push(['farmerUpsertProduct', p]); if (p.name === 'خطأ') throw fail('invalid-argument'); return { data: { productId: 'new', status: 'pending_review' } }; },
  farmerSetProductStock: async (p) => { S.calls.push(['farmerSetProductStock', p]); return { data: p }; },
  watchMyInvestments: watch([]), watchMyShares: watch([]), watchMyTransactions: watch([]), watchMyOilAllocations: watch([]), watchMyOilRequests: watch([]),
  watchMyRoleApplication: (cb) => { setTimeout(() => cb(null), 30); return () => {}; }, watchMyFarmerUpdates: watch([]), watchMyPressingBatches: watch([]),
  myGifts: async () => ({ data: { given: [], received: [] } }), myReferralCode: async () => ({ data: { code: 'QATEST23', rewarded: 0, pending: 0, creditsMl: 0, creditsRedeemedMl: 0 } }),
  pendingReferralCode: () => '', pendingGiftCode: () => '', clearPendingGiftCode: () => {}, normalizeGiftCode: () => '', referralLink: () => '',
  pushState: async () => ({ data: { enabled: false, activeDevices: 0 } }), publicStatus: async () => ({ api: 'ok', jobs: 'ok', email: 'ok', checkedAt: Date.now() }),
  myAssignments: async () => ({ trees: [], mills: [] }), myFarmerProfile: async () => null, signOut: async () => {}, setMyLocale: async () => ({ data: {} })
};
setTimeout(() => window.dispatchEvent(new CustomEvent('faseela-auth-state', { detail: role ? {
  id: 'u1', uid: 'u1', email: 'qa@example.test', phone: '', name: 'QA', name_en: 'QA', role, claimRole: role,
  roleName: 'QA', roleName_en: 'QA', avatar: 'Q', avatar_en: 'Q', badgeColor: '', region: '', email_verified: true,
  auth_provider: 'email', permittedPages: ['home', 'marketplace', 'dashboard'] } : null })), 200);
`;

const browser = await chromium.launch({ executablePath: process.env.CHR || undefined });
const failures = [];
const open = async (query) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
  await ctx.addInitScript(() => { try { localStorage.setItem('faseela_lang', 'en'); } catch (e) { /* ignore */ } });
  await ctx.route('**/supabase-client.mjs', (r) => r.fulfill({ contentType: 'text/javascript', body: MOCK_CLIENT }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/40[14]|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text().slice(0, 200)}`); });
  await page.goto(`${base}${query}`, { waitUntil: 'load' });
  await page.evaluate(() => { if (state.currentLang !== 'en') setLanguage('en'); });
  return { ctx, page, errors };
};
const toShop = async (page) => {
  await page.waitForFunction(() => { const tab = document.getElementById('tab-market-shop'); return tab && !tab.hidden; }, null, { timeout: 20000 });
  await page.evaluate(() => { navigateTo('marketplace'); switchMarketplaceTrack('shop'); });
  await page.waitForSelector('#shop-container:not(.hidden) #shop-basket');
};
const calls = (page, name) => page.evaluate((n) => window.__shop.calls.filter((c) => c[0] === n).map((c) => c[1]), name);
const axe = async (page, where) => {
  const r = await new AxeBuilder({ page }).include('#shop-container').withTags(['wcag2a', 'wcag2aa']).analyze();
  for (const v of r.violations) failures.push(`${where}: ${v.id} (${v.nodes.length}) ${v.nodes[0]?.html.slice(0, 100)}`);
};
const summary = (page, scope = '#shop-basket') => page.$eval(`${scope} [data-shop-summary]`, (n) => n.textContent.replace(/\s+/g, ' '));

try {
  // ---- 1. visitor -----------------------------------------------------------------------------------------
  {
    const { ctx, page, errors } = await open('');
    await toShop(page);
    assert.equal(await page.$$eval('#shop-grid article', (n) => n.length), 5);
    assert.equal(await page.evaluate(() => window.__xss === undefined && !document.querySelector('#shop-container img')), true, 'product names render as text');
    assert.match(await page.textContent('#shop-grid'), /<img src=x/);
    assert.match(await page.textContent('#shop-container'), /Faseela keeps 15 % of the product price as its service fee/);
    assert.equal(await page.$eval('[data-product="p4"] button', (b) => b.disabled), true, 'sold-out product cannot be added');
    assert.match(await page.textContent('[data-product="p4"]'), /Sold out/);
    assert.equal(await page.$eval('[data-product="p5"] button', (b) => b.disabled), true, 'no delivery from that country, no basket');
    assert.match(await page.textContent('[data-product="p5"]'), /Not delivered to the chosen country/);
    assert.match(await page.textContent('[data-product="p2"]'), /Only 3 left/);
    assert.equal(await page.$eval('#shop-checkout', () => true).catch(() => false), false, 'an empty basket offers no order button');
    await page.fill('[data-product="p1"] input', '2');
    await page.click('[data-product="p1"] button');
    assert.match(await summary(page), /Goods€24\.00Shipping to Germany€9\.00Total€33\.00Included in the price: €3\.60 service fee \(15 %\) for Faseela, €20\.40 for the farm\./, 'nothing is added to the price; the split is shown openly');
    await page.click('[data-product="p3"] button');
    assert.equal(await page.$$eval('#shop-basket li', (n) => n.length), 1, 'a second farm does not enter the basket');
    await page.fill('[data-product="p2"] input', '99');
    await page.click('[data-product="p2"] button');
    assert.match(await page.textContent('#shop-basket'), /3 × Green olives/, 'quantity is capped at the stock');
    await page.selectOption('#shop-dest', 'FR');
    assert.match(await summary(page), /Shipping to France€12\.00/);
    await axe(page, 'visitor/light');
    await page.click('#shop-checkout');
    await page.waitForFunction(() => !document.getElementById('modal-auth')?.classList.contains('hidden') || !!document.querySelector('[id^=modal-auth]:not(.hidden)'), null, { timeout: 5000 }).catch(() => {});
    assert.deepEqual(await calls(page, 'quoteOrder'), [], 'a visitor is asked to sign in before anything is priced on the server');
    assert.deepEqual(await calls(page, 'createOrder'), []);
    assert.deepEqual(errors, [], 'no page errors (visitor)');
    await ctx.close();
  }

  // ---- 2. customer ----------------------------------------------------------------------------------------
  {
    const { ctx, page, errors } = await open('?mockRole=investor');
    await page.waitForFunction(() => state.currentUser && state.serverMode, null, { timeout: 20000 });
    await toShop(page);
    await page.fill('[data-product="p1"] input', '2');
    await page.click('[data-product="p1"] button');
    await page.click('#shop-checkout');
    await page.waitForSelector('#shop-checkout-form');
    assert.deepEqual(await calls(page, 'quoteOrder'), [{ items: [{ productId: 'p1', quantity: 2 }], destCountry: 'DE' }]);
    assert.match(await summary(page, '#shop-checkout-form'), /Total€33\.00[\s\S]*€3\.60 service fee/);
    assert.match(await page.textContent('#shop-checkout-form'), /bank transfer[\s\S]*72 hours/);
    await page.click('#shop-checkout-form button[type=submit]');
    assert.match(await page.textContent('#shop-checkout-form [role=alert]'), /name, street, city and country/);
    assert.deepEqual(await calls(page, 'createOrder'), [], 'nothing is ordered without an address');
    await page.fill('[name=shop-name]', '  Kunde Test ');
    await page.fill('[name=shop-addressLine1]', 'Weg 1');
    await page.fill('[name=shop-postalCode]', '10115');
    await page.fill('[name=shop-city]', 'Berlin');
    await page.evaluate(() => { window.__priceUp = true; });
    await page.click('#shop-checkout-form button[type=submit]');
    await page.waitForFunction(() => /price changed/.test(document.querySelector('#shop-checkout-form [role=alert]')?.textContent || ''));
    assert.deepEqual(await calls(page, 'createOrder'), [], 'a changed total is shown before the order is sent');
    assert.match(await summary(page, '#shop-checkout-form'), /Total€34\.00/);
    assert.equal(await page.inputValue('[name=shop-city]'), 'Berlin', 'the address survives the re-pricing');
    await page.evaluate(() => { window.__orderFails = true; });
    await page.click('#shop-checkout-form button[type=submit]');
    await page.waitForFunction(() => /not enough of a product/.test(document.querySelector('#shop-checkout-form [role=alert]')?.textContent || ''));
    await page.evaluate(() => { window.__orderFails = false; });
    await page.click('#shop-checkout-form button[type=submit]');
    await page.waitForSelector('#shop-orders');
    const sent = await calls(page, 'createOrder');
    assert.equal(sent.length, 2);
    assert.equal(sent[0].idempotencyKey, sent[1].idempotencyKey, 'a retry reuses the same key, so it can never create a second order');
    assert.ok(sent[1].idempotencyKey.length >= 16);
    assert.deepEqual(sent[1].items, [{ productId: 'p1', quantity: 2 }]);
    assert.deepEqual(sent[1].contact, { name: 'Kunde Test', addressLine1: 'Weg 1', addressLine2: '', postalCode: '10115', city: 'Berlin', phone: '', country: 'DE' });
    assert.match(await page.textContent('#shop-orders'), /FO-AAAAAAAAAA[\s\S]*Waiting for your transfer[\s\S]*Bank account: DE00 1234/);
    assert.equal(await page.evaluate(() => window.__xss === undefined && !document.querySelector('#shop-orders img')), true, 'order lines render as text');
    assert.match(await page.textContent('#shop-basket'), /basket is empty/);
    await axe(page, 'customer/light');
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await axe(page, 'customer/dark');
    await page.getByRole('button', { name: 'I have made the transfer: FO-AAAAAAAAAA' }).click();
    await page.waitForFunction(() => /Payment is being checked/.test(document.getElementById('shop-orders').textContent));
    assert.deepEqual(await calls(page, 'reportOrderPayment'), [{ orderId: 'a'.repeat(64) }]);
    assert.equal(await page.$$eval('#shop-orders button', (n) => n.length), 0, 'a reported order has no customer actions left');
    // German
    await page.evaluate(() => setLanguage('de'));
    await page.waitForFunction(() => /Hofladen: Produkte direkt von den Höfen/.test(document.getElementById('shop-container').textContent), null, { timeout: 10000 });
    assert.match(await page.textContent('#shop-orders'), /Zahlung wird geprüft/);
    assert.match(await page.textContent('#tab-market-shop'), /Hofladen/);
    assert.deepEqual(errors, [], 'no page errors (customer)');
    await ctx.close();
  }

  // ---- 2b. no receiving account: the customer is not sent off to pay into nothing ---------------------------
  {
    const { ctx, page } = await open('?mockRole=investor&accounts=none');
    await page.waitForFunction(() => state.currentUser && state.serverMode, null, { timeout: 20000 });
    await toShop(page);
    await page.click('[data-product="p1"] button');
    await page.click('#shop-checkout');
    await page.waitForSelector('#shop-checkout-form');
    await page.fill('[name=shop-name]', 'Kunde Test'); await page.fill('[name=shop-addressLine1]', 'Weg 1'); await page.fill('[name=shop-city]', 'Berlin');
    await page.click('#shop-checkout-form button[type=submit]');
    await page.waitForSelector('#shop-orders');
    assert.match(await page.textContent('#shop-orders [role=alert]'), /bank details are not available/);
    assert.equal(await page.getByRole('button', { name: 'I have made the transfer: FO-AAAAAAAAAA' }).isDisabled(), true);
    await page.getByRole('button', { name: 'Cancel order: FO-AAAAAAAAAA' }).click();
    await page.waitForFunction(() => /Cancelled/.test(document.getElementById('shop-orders').textContent));
    assert.deepEqual(await calls(page, 'cancelMyOrder'), [{ orderId: 'a'.repeat(64) }]);
    await ctx.close();
  }

  // ---- 3. farm account ------------------------------------------------------------------------------------
  {
    const { ctx, page, errors } = await open('?mockRole=farmer');
    await page.waitForFunction(() => state.currentUser && state.serverMode, null, { timeout: 20000 });
    await toShop(page);
    await page.waitForSelector('[data-farm="farm_a"]');
    const farm = await page.textContent('[data-farm="farm_a"]');
    assert.match(farm, /Your farm: Farm A[\s\S]*Credit from paid orders after fee and payouts: €17\.00/);
    assert.match(farm, /Dates[\s\S]*Not accepted[\s\S]*Please add the harvest year/, 'the farm sees why a product was not accepted');
    assert.match(farm, /Paid orders for your farm[\s\S]*1 × Farm oil \(1 l\) · €17\.00/);
    assert.doesNotMatch(farm, /FO-AAAAAAAAAA|Kunde|Weg 1/, 'no payment reference and no customer data for the farm');
    await page.getByRole('button', { name: 'New product' }).click();
    await page.click('#shop-product-form button[type=submit]');
    assert.match(await page.textContent('#shop-product-form [role=alert]'), /name, a unit and a price/);
    assert.deepEqual(await calls(page, 'farmerUpsertProduct'), [], 'an incomplete product is not sent');
    const form = page.locator('#shop-product-form');
    await form.getByLabel('Name (Arabic)').fill('خطأ'); await form.getByLabel('Name (English)').fill('Pressed oil');
    await form.getByLabel('Unit, e.g. 500 ml bottle').fill('750 ml'); await form.getByLabel('Price per unit').fill('14.50'); await form.getByLabel('Units in stock').fill('12');
    await page.click('#shop-product-form button[type=submit]');
    await page.waitForFunction(() => /check your entries/.test(document.querySelector('#shop-product-form [role=alert]')?.textContent || ''));
    await form.getByLabel('Name (Arabic)').fill('زيت معصور');
    assert.match(await page.textContent('#shop-product-net'), /You receive €12\.32 per unit; €2\.18 \(15 %\) is the Faseela service fee/, 'the farm sees its share before submitting');
    await axe(page, 'farmer/light');
    await page.click('#shop-product-form button[type=submit]');
    await page.waitForFunction(() => !document.getElementById('shop-product-form'));
    assert.deepEqual((await calls(page, 'farmerUpsertProduct')).slice(-1)[0], { farmId: 'farm_a', category: 'oil', name: 'زيت معصور', nameEn: 'Pressed oil', description: '', descriptionEn: '', unit: '750 ml', priceMinor: 1450, currency: 'EUR', stockUnits: 12 });
    await page.waitForSelector('[data-own-product="own1"]');
    await page.fill('[data-own-product="own1"] input', '25');
    await page.getByRole('button', { name: 'Save stock: Farm oil' }).click();
    await page.waitForFunction(() => window.__shop.calls.some((c) => c[0] === 'farmerSetProductStock'));
    await page.waitForSelector('[data-own-product="own1"]');
    await page.getByRole('button', { name: 'Take out of the shop: Farm oil' }).click();
    await page.waitForFunction(() => window.__shop.calls.filter((c) => c[0] === 'farmerSetProductStock').length === 2);
    assert.deepEqual(await calls(page, 'farmerSetProductStock'), [{ productId: 'own1', stockUnits: 25 }, { productId: 'own1', unlist: true }]);
    assert.equal(await page.$$eval('[data-own-product="own2"] button', (n) => n.map((b) => b.textContent).includes('Take out of the shop')), false, 'only a listed product can be taken out');
    await page.waitForSelector('[data-own-product="own2"]');
    await page.getByRole('button', { name: 'Edit: Dates' }).click();
    await page.locator('#shop-product-form').getByLabel('Description (English)').fill('Harvest 2026');
    await page.click('#shop-product-form button[type=submit]');
    await page.waitForFunction(() => !document.getElementById('shop-product-form'));
    const edited = (await calls(page, 'farmerUpsertProduct')).slice(-1)[0];
    assert.equal(edited.productId, 'own2'); assert.equal(edited.descriptionEn, 'Harvest 2026'); assert.equal(edited.priceMinor, 900);
    assert.deepEqual(errors, [], 'no page errors (farmer)');
    await ctx.close();
  }

  // ---- 4. nothing on offer: no tab, and the shop track cannot be forced open --------------------------------
  {
    const { ctx, page } = await open('?shop=empty');
    await page.waitForFunction(() => typeof window.FaseelaShop === 'object');
    await page.waitForTimeout(1500);
    assert.equal(await page.$eval('#tab-market-shop', (tab) => tab.hidden), true, 'no shop tab without products, orders or an own farm');
    await page.evaluate(() => { navigateTo('marketplace'); switchMarketplaceTrack('shop'); });
    assert.equal(await page.evaluate(() => state.marketplaceTrack), 'mature');
    assert.equal(await page.$eval('#shop-container', (n) => n.classList.contains('hidden')), true);
    await ctx.close();
  }

  // ---- 5. closed shop: no tab for customers; a farm account can still prepare its products ----------------------
  {
    const visitor = await open('?shop=closed');
    await visitor.page.waitForFunction(() => typeof window.FaseelaShop === 'object');
    await visitor.page.waitForTimeout(1500);
    assert.equal(await visitor.page.$eval('#tab-market-shop', (tab) => tab.hidden), true, 'a closed shop is not offered to visitors');
    await visitor.ctx.close();
    const { ctx, page } = await open('?mockRole=farmer&shop=closed');
    await page.waitForFunction(() => state.currentUser && state.serverMode, null, { timeout: 20000 });
    await page.waitForFunction(() => { const tab = document.getElementById('tab-market-shop'); return tab && !tab.hidden; }, null, { timeout: 20000 });
    await page.evaluate(() => { navigateTo('marketplace'); switchMarketplaceTrack('shop'); });
    await page.waitForSelector('[data-farm="farm_a"]');
    assert.match(await page.textContent('#shop-closed'), /does not take orders yet/);
    assert.equal(await page.$('#shop-grid'), null, 'no products to order while closed');
    assert.equal(await page.$('#shop-basket'), null);
    assert.equal(!!(await page.$('[data-own-product="own1"]')), true, 'the farm can keep preparing its products');
    await ctx.close();
  }

  assert.deepEqual(failures, [], `axe violations:\n${failures.join('\n')}`);
  console.log(JSON.stringify({ ok: true, suite: 'shop' }));
} finally {
  await browser.close();
  server.kill();
}
