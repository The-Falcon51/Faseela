// UI regression suite without a backend account (runs in CI):
//   1. every data-* handler in index.html + app.js parses (events.js grammar) and resolves to a global function,
//   2. delegated clicks drive navigation, language, theme and modals,
//   3. a mocked server session renders dashboard/admin views without page errors or reloads,
//   4. axe (WCAG 2.x A/AA) reports no violations on the main pages in light and dark mode.
// Run: node tests/e2e/handlers.e2e.mjs   (CHR=/path/to/chrome to use a preinstalled Chromium)
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = process.env.E2E_PORT || '8097';
const base = `http://127.0.0.1:${port}/`;
const server = spawn('python3', ['-m', 'http.server', port, '--bind', '127.0.0.1', '--directory', path.join(root, 'public')], { stdio: 'ignore' });
await new Promise((resolve) => setTimeout(resolve, 800));

const MOCK_CLIENT = `
import * as mappers from './data-mappers.mjs';
window.FaseelaMappers = mappers;
const watch = (rows, mapper) => (cb) => { setTimeout(() => cb(rows.map(mapper)), 30); return () => {}; };
const role = new URLSearchParams(location.search).get('mockRole') || 'investor';
window.FaseelaFirebase = window.FaseelaBackend = {
  backend: 'supabase',
  listPublicTrees: async () => [{ treeId: 'tree_01', status: 'listed', totalShares: 4, availableShares: 2, pricePerShareMinor: 3500, landPriceMinor: 1500, hasLandOption: true, currency: 'USD' }].map(mappers.mapPublicTree),
  watchMyInvestments: watch([{ id: 'd'.repeat(64), userId: 'u1', treeId: 'tree_01', shareCount: 1, amountMinor: 3500, currency: 'USD', status: 'under_review', createdAt: Date.now() - 7200000, proofSubmittedAt: Date.now() - 3600000, expiresAt: Date.now() + 1 }, { id: 'e'.repeat(64), userId: 'u1', treeId: 'tree_01', shareCount: 1, amountMinor: 3500, currency: 'USD', status: 'rejected', reviewNote: 'Receipt unreadable', createdAt: Date.now() - 9e7, proofSubmittedAt: Date.now() - 8e7, reviewedAt: Date.now() - 7e7 }], mappers.mapInvestment),
  watchMyShares: watch([{ id: 'c'.repeat(64), userId: 'u1', treeId: 'tree_01', shareCount: 4, includesLand: true, purchasePriceMinor: 15500, currency: 'USD', status: 'active', createdAt: Date.now() }], mappers.mapShare),
  watchMyTransactions: watch([], mappers.mapTransaction),
  watchMyOilAllocations: watch([{ id: '11111111-1111-4111-8111-111111111111', userId: 'u1', treeId: 'tree_01', batchId: 'b1', shareCount: 4, litersMl: 7400, seasonYear: 2026, certificateSerial: 'LAB-1', status: 'available', createdAt: Date.now() }], mappers.normalizeDoc),
  watchMyOilRequests: watch([], mappers.normalizeDoc),
  requestOil: async (p) => { window.FaseelaBackend.calls.push(['requestOil', p]); return { requestId: '22222222-2222-4222-8222-222222222222', status: 'pending' }; },
  cancelOilRequest: async (p) => ({ requestId: p.requestId, status: 'cancelled' }),
  reviewOilRequest: async () => ({}),
  downloadShareCertificate: async (id) => { window.FaseelaBackend.calls.push(['downloadShareCertificate', id]); return { serial: 'FSL-2026-TEST' }; },
  watchMyRoleApplication: (cb) => { setTimeout(() => cb(null), 30); return () => {}; },
  watchMyFarmerUpdates: watch([], mappers.normalizeDoc),
  watchMyPressingBatches: watch([], mappers.normalizeDoc),
  adminListUsers: async () => [{ uid: 'u2', displayName: 'Test Investor', email: 'i@example.test', role: 'investor', emailVerified: true, disabled: false, createdAt: Date.now() }].map(mappers.mapDirectoryUser),
  adminListAssignments: async () => ({ trees: ['tree_01'], mills: [] }),
  adminSystemStatus: async () => ({ outbox: { pending: 0, failed: 1, sent24h: 3, lastError: 'brevo 401: key' }, clientErrors: { last24h: 2, top: [{ message: 'TypeError: x', count: 2 }] }, reviews: { paymentsPending: 1, paymentsOverdue: 0, farmerUpdatesPending: 0, batchesPending: 0, roleApplicationsPending: 0 }, jobs: [{ name: 'faseela-send-emails', lastStatus: 'succeeded' }] }),
  listReviewQueueMapped: async (q) => q === 'farmer_updates'
    ? [mappers.mapReviewItem('farmer_updates', { id: '44444444-4444-4444-8444-444444444444', farmerUid: 'u9', eventType: 'pruning', notes: 'N'.repeat(500), mediaPaths: ['u9/tree_01/a.jpg', 'u9/tree_01/b.jpg'], gpsLat: 34.8, gpsLng: 36.1, treeId: 'tree_01', createdAt: Date.now() })]
    : [],
  signFieldMedia: async (paths) => { window.FaseelaBackend.calls.push(['signFieldMedia', paths]); return paths.map((p, i) => ({ path: p, url: i === 0 ? 'https://riyvlhlhzxxerlwqoxsy.supabase.co/storage/v1/object/sign/field-media/a.jpg?token=t' : null, error: i === 0 ? null : 'Object not found' })); },
  reviewFarmerUpdate: async (p) => { window.FaseelaBackend.calls.push(['reviewFarmerUpdate', p]); return { updateId: p.updateId, status: 'published' }; },
  signOut: async () => { window.FaseelaBackend.calls.push(['signOut']); }, exportMyData: async () => ({ shares: [] }),
  pushState: async () => { if (window.__pushStateDown) throw Object.assign(new Error('down'), { code: 'unavailable' }); return { data: { enabled: localStorage.getItem('__pushOff') !== '1', activeDevices: 0 } }; },
  registerPushToken: async (p) => { window.FaseelaBackend.calls.push(['registerPushToken', p]); if (window.__pushServerDown) throw Object.assign(new Error('down'), { code: 'unavailable' }); return { data: { registered: true, activeDevices: 1 } }; },
  unregisterPushToken: async (p) => { window.FaseelaBackend.calls.push(['unregisterPushToken', p]); if (window.__pushServerDown) throw Object.assign(new Error('down'), { code: 'unavailable' }); return { data: { unregistered: true, activeDevices: 0 } }; },
  calls: [],
  // Gifts & referrals
  gifts: { given: [], received: [] },
  myGifts: async () => ({ data: window.FaseelaBackend.gifts }),
  myReferralCode: async () => ({ data: { code: 'QATEST23', rewarded: 1, pending: 0, creditsMl: 250, creditsRedeemedMl: 0 } }),
  createGift: async (p) => { window.FaseelaBackend.calls.push(['createGift', p]); const g = { giftId: '55555555-5555-4555-8555-555555555555', shareId: p.shareId, treeId: 'tree_01', shareCount: 4, code: 'ABCD-EFGH-2345', codeHint: '2345', recipientName: p.recipientName, message: p.message, status: 'open', createdAt: Date.now(), expiresAt: Date.now() + 365 * 86400000 }; window.FaseelaBackend.gifts = { given: [g], received: [] }; return { data: g }; },
  cancelGift: async (p) => { window.FaseelaBackend.calls.push(['cancelGift', p]); window.FaseelaBackend.gifts = { given: window.FaseelaBackend.gifts.given.map((g) => ({ ...g, status: 'cancelled' })), received: [] }; return { data: { giftId: p.giftId, status: 'cancelled' } }; },
  redeemGift: async (code) => { window.FaseelaBackend.calls.push(['redeemGift', code]); return { data: code === 'WXYZ-WXYZ-WXYZ' ? { status: 'redeemed', treeId: 'tree_01', shareCount: 1 } : { status: 'invalid' } }; },
  attachRequestExtras: async (p) => { window.FaseelaBackend.calls.push(['attachRequestExtras', p]); return { data: { requestId: p.requestId, gift: !!p.giftRecipientName, referral: !!p.referralCode } }; },
  referralLink: (code) => location.origin + '/?ref=' + code,
  normalizeGiftCode: (v) => { const b = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return /^[A-Z0-9]{12}$/.test(b) ? b.slice(0, 4) + '-' + b.slice(4, 8) + '-' + b.slice(8) : ''; },
  pendingReferralCode: () => '', pendingGiftCode: () => '', clearPendingGiftCode: () => {},
  // Payment instructions (server-managed): starts unconfigured; admin save fills it.
  payment: null,
  paymentInstructions: async () => ({ data: window.FaseelaBackend.payment }),
  recordPaymentScreening: async (p) => { window.FaseelaBackend.calls.push(['recordPaymentScreening', p]); return { data: { requestId: p.requestId, result: p.result } }; },
  paymentScreeningState: async () => ({ data: null }),
  reviewInvestmentRequest: async (p) => { window.FaseelaBackend.calls.push(['reviewInvestmentRequest', p]); return { data: { requestId: p.requestId, status: 'approved' } }; },
  financeExport: async (p) => { window.FaseelaBackend.calls.push(['financeExport', p]); return { data: { from: p.from, to: p.to, truncated: false, rows: [{ requestId: 'a'.repeat(64), createdAt: '2026-11-10T10:00:00Z', status: 'approved', payerName: '=HYPERLINK("http://x","y")', payerEmail: 'p@example.test', userId: 'u2', treeId: 'tree_01', shareCount: 1, includesLand: false, amountMinor: 3500, currency: 'USD', reviewNote: 'ok, "fine"', screeningResult: 'clear', screeningLists: 'EU, UN' }] } }; },
  fourEyes: false, pendingPayment: null,
  adminPaymentState: async () => ({ data: { live: window.FaseelaBackend.payment, pending: window.FaseelaBackend.pendingPayment, fourEyes: window.FaseelaBackend.fourEyes, adminCount: window.FaseelaBackend.fourEyes ? 2 : 1 } }),
  adminSetPaymentInstructions: async (p) => { window.FaseelaBackend.calls.push(['adminSetPaymentInstructions', p]); if (window.FaseelaBackend.fourEyes) { window.FaseelaBackend.pendingPayment = { ...p, proposedAt: Date.now(), proposedBySelf: true }; return { data: { status: 'pending' } }; } window.FaseelaBackend.payment = { ...p, updatedAt: Date.now() }; return { data: { status: 'applied' } }; },
  adminReviewPaymentInstructions: async (p) => { window.FaseelaBackend.calls.push(['adminReviewPaymentInstructions', p]); if (p.decision === 'approve') { window.FaseelaBackend.payment = { channels: window.FaseelaBackend.pendingPayment.channels, updatedAt: Date.now() }; } window.FaseelaBackend.pendingPayment = null; return { data: { status: p.decision === 'approve' ? 'applied' : 'rejected' } }; },
  updateMyProfile: async (p) => { window.FaseelaBackend.calls.push(['updateMyProfile', p]); return p; },
  setMarketingConsent: async (optIn) => { window.FaseelaBackend.calls.push(['setMarketingConsent', optIn]); return { marketingOptIn: optIn }; },
  publicStatus: async () => ({ api: 'ok', jobs: 'ok', email: 'ok', checkedAt: Date.now() }),
  myAssignments: async () => ({ trees: [{ treeId: 'tree_01', name: 'زيتونة القصير', nameEn: 'Qusayr Olive', region: 'حمص', regionEn: 'Homs' }], mills: [] }),
  myFarmerProfile: async () => window.FaseelaBackend.profileRow,
  profileRow: null,
  uploadFieldMedia: async (treeId, file) => { window.FaseelaBackend.calls.push(['uploadFieldMedia', treeId, file.name]); return 'u1/' + treeId + '/1_' + file.name; },
  uploadFarmerProfilePhoto: async (file) => { window.FaseelaBackend.calls.push(['uploadFarmerProfilePhoto', file.name]); return 'u1/profile/1_' + file.name; },
  submitFarmerUpdate: async (p) => { window.FaseelaBackend.calls.push(['submitFarmerUpdate', p]); return { updateId: '33333333-3333-4333-8333-333333333333', status: 'pending_review' }; },
  updateFarmerProfile: async (p) => { window.FaseelaBackend.calls.push(['updateFarmerProfile', p]); window.FaseelaBackend.profileRow = { ...p, consentAt: p.consentPublic ? Date.now() : null }; return { data: p }; }
};
setTimeout(() => window.dispatchEvent(new CustomEvent('faseela-auth-state', { detail: {
  id: 'u1', uid: 'u1', email: 'qa@example.test', phone: '', name: 'QA', name_en: 'QA', role, claimRole: role,
  roleName: 'QA', roleName_en: 'QA', avatar: 'Q', avatar_en: 'Q', badgeColor: '', region: '', email_verified: true,
  auth_provider: 'email', permittedPages: ['home', 'marketplace', 'dashboard'] } })), 200);
`;

const browser = await chromium.launch({ executablePath: process.env.CHR || undefined });
const failures = [];
try {
  // ---- 1. handler inventory ------------------------------------------------------------
  const attrs = new Set();
  for (const file of ['public/index.html', 'public/app.js']) {
    for (const m of fs.readFileSync(path.join(root, file), 'utf8').matchAll(/data-(click|change|input|submit|keydown|scroll)=\\?"((?:[^"\\]|\\.)*)\\?"/g)) {
      attrs.add(m[2].replace(/\\"/g, '"'));
    }
  }
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/40[14]/.test(m.text())) errors.push(`console: ${m.text().slice(0, 200)}`); });
  // The catalogue is what the database lists, so the anonymous page gets a fixed catalogue instead of live data.
  const tree = (id, crop, nameEn, extra = {}) => ({ tree_id: id, status: 'listed', crop_category: crop, name: 'شجرة ' + id, name_en: nameEn, region: 'طرطوس', region_en: 'Tartus',
    tree_type: 'خضيري', tree_type_en: 'Khodairi', planted_year: 1990, estimated_annual_yield_kg: 60, images: ['images/olive_branches_macro.webp'], total_shares: 4, available_shares: 3,
    price_per_share_minor: 3500, land_price_minor: 0, has_land_option: false, land_area_sqm: 0, currency: 'USD', country_code: 'SY', farm_id: 'farm_01', ...extra });
  const CATALOG = [tree('tree_01', 'olive', 'Fixture Olive One'), tree('tree_02', 'olive', 'Fixture Olive Two', { farm_id: null }), tree('tree_15', 'pomegranate', 'Fixture Pomegranate', { farm_id: null })];
  await page.route('**/rest/v1/trees_public*', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(CATALOG) }));
  await page.route('**/rest/v1/countries*', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify([{ code: 'SY', name: 'سوريا', name_en: 'Syria', name_de: 'Syrien', currency: 'USD' }]) }));
  await page.route('**/rest/v1/farms*', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify([{ farm_id: 'farm_01', country_code: 'SY', name: 'مزرعة الاختبار', name_en: 'Fixture Farm', region: '', region_en: '' }]) }));
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => window.FaseelaEvents && typeof navigateTo === 'function', null, { timeout: 20000 });
  await page.waitForFunction(() => state.catalogState === 'ready', null, { timeout: 20000 });

  // ---- 1b. database-only catalogue: built-in entries are templates, never offers ----
  const catalog = await page.evaluate(async () => {
    navigateTo('marketplace'); await new Promise((r) => setTimeout(r, 200));
    const offered = catalogTrees();
    const grid = document.getElementById('trees-grid');
    const first = offered.find((tr) => tr.id === 'tree_01');
    const out = {
      builtIn: state.treeTemplates.length, offered: offered.map((tr) => tr.id).sort(),
      cards: grid.querySelectorAll('[data-click^="viewTreeDetails"]').length > 0, text: ['شجرة tree_01', 'شجرة tree_15'].every((n) => grid.textContent.includes(n)), // the page starts in Arabic
      sampleGone: [first.mill_name, first.mill_batch_serial, first.harvest_batch_acidity, first.health_status].join('') === '' && first.maintenance_logs.length === 0 && first.harvest_status === 'growing',
      farmFromDb: first.farm_name_en, farmless: offered.find((tr) => tr.id === 'tree_02').farm_name_en,
      counts: Object.fromEntries([...document.querySelectorAll('[data-crop-count]')].map((el) => [el.getAttribute('data-crop-count'), el.classList.contains('hidden') ? 'hidden' : el.textContent])),
      featured: state.featuredSeasonTreeId, calculator: [...document.getElementById('roi-region-select').options].map((o) => o.value)
    };
    return out;
  });
  // error and retry (the client object is frozen, so the failure is produced at the network level; 404 is the status the error filter above ignores)
  const failing = (r) => r.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"not found"}' });
  await page.route('**/rest/v1/trees_public*', failing);
  catalog.error = await page.evaluate(async () => {
    await loadServerCatalog();
    const grid = document.getElementById('trees-grid');
    return { state: state.catalogState, shown: !!grid.querySelector('[data-catalog-state="error"]'), offered: catalogTrees().length, cards: grid.querySelectorAll('[data-click^="viewTreeDetails"]').length };
  });
  await page.unroute('**/rest/v1/trees_public*', failing);
  await page.click('#trees-grid [data-click="retryCatalog()"]');
  await page.waitForFunction(() => state.catalogState === 'ready');
  catalog.retry = await page.evaluate(() => ({ state: state.catalogState, offered: catalogTrees().length }));
  // empty catalogue: nothing on offer, no featured tree, no calculator
  const nothing = (r) => r.fulfill({ contentType: 'application/json', body: '[]' });
  await page.route('**/rest/v1/trees_public*', nothing);
  catalog.empty = await page.evaluate(async () => {
    await loadServerCatalog();
    const grid = document.getElementById('trees-grid');
    return { offered: catalogTrees().length, emptyState: /No trees found|لم يتم العثور/.test(grid.textContent), heroHidden: document.getElementById('hero-featured-tree-container').classList.contains('hidden'),
      calculatorHidden: document.getElementById('section-harvest-calculator').classList.contains('hidden'), templatesKept: state.trees.length >= 16 };
  });
  await page.unroute('**/rest/v1/trees_public*', nothing);
  catalog.restored = await page.evaluate(async () => { await loadServerCatalog(); const n = catalogTrees().length; navigateTo('home'); return n; });
  assert.deepEqual(catalog, {
    builtIn: 16, offered: ['tree_01', 'tree_02', 'tree_15'], cards: true, text: true, sampleGone: true, farmFromDb: 'Fixture Farm', farmless: '',
    counts: { olive: '2', pistachio: 'hidden', almond_walnut: 'hidden', pomegranate: '1' }, featured: 'tree_01', calculator: ['tree_01', 'tree_02', 'tree_15'],
    error: { state: 'error', shown: true, offered: 0, cards: 0 }, retry: { state: 'ready', offered: 3 },
    empty: { offered: 0, emptyState: true, heroHidden: true, calculatorHidden: true, templatesKept: true }, restored: 3
  }, 'only database trees are on offer');
  const inventory = await page.evaluate((list) => {
    const bad = [];
    for (const src of list) {
      const runtime = src.replace(/'\$\{[^}]*\}'/g, "'x'").replace(/\$\{[^}]*\}/g, '1');
      try {
        for (const call of window.FaseelaEvents.parseCalls(runtime)) {
          if (typeof window[call.name] !== 'function') bad.push(`${call.name} <- ${src}`);
        }
      } catch (e) { bad.push(`${e.message} <- ${src}`); }
    }
    return { total: list.length, bad };
  }, [...attrs]);
  assert.deepEqual(inventory.bad, [], `unresolved handlers:\n${inventory.bad.join('\n')}`);
  assert.ok(inventory.total > 400, 'handler inventory looks complete');

  // ---- 2. delegated interactions --------------------------------------------------------
  const smoke = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const click = (sel) => { const el = document.querySelector(sel); if (!el) return false; el.click(); return true; };
    const out = {};
    out.nav = click('[data-click="navigateTo(\'marketplace\')"]'); await wait(150); out.page = getCurrentVisiblePage();
    out.lang = click('[data-click^="setLanguage(\'en\')"]'); await wait(150); out.langState = state.currentLang;
    out.auth = click('[data-click="openAuthModal()"]'); await wait(150);
    out.authOpen = !document.getElementById('modal-auth-session').classList.contains('hidden');
    out.close = click('[data-click="closeModal(\'modal-auth-session\')"]'); await wait(150);
    out.authClosed = document.getElementById('modal-auth-session').classList.contains('hidden');
    return out;
  });
  assert.deepEqual(smoke, { nav: true, page: 'marketplace', lang: true, langState: 'en', auth: true, authOpen: true, close: true, authClosed: true });

  // ---- 2b. land / greenfield offer switch (legal): off = no surface, no purchase path -----
  const land = await page.evaluate(() => {
    const shown = (sel) => { const host = document.querySelector(sel)?.closest('[data-feature="land"]'); return !host || getComputedStyle(host).display !== 'none'; };
    const toasts = [];
    const orig = window.showToast; window.showToast = (m) => toasts.push(m);
    setModalPackageChoice(true); toggleROILandOption(true); selectDetailPackage(true);
    switchMarketplaceTrack('virgin');
    investInVirginPackage('vg_01', 1, 55, 25);
    investInAgroforestryBundle();
    document.getElementById('filter-land').value = 'with_land';
    renderMarketplace();
    const cards = document.querySelectorAll('#marketplace-cards-container [data-feature="land"]');
    window.showToast = orig;
    return {
      enabled: landOfferEnabled(),
      flags: [state.includeLandInModal, state.includeLandInCalc],
      track: state.marketplaceTrack,
      blocked: toasts.filter((m) => m === t('land_offer_unavailable')).length,
      investModalOpen: !document.getElementById('modal-invest').classList.contains('hidden'),
      treeOptions: state.trees.filter((tr) => tr.land_parcel && tr.land_parcel.has_land_option).length,
      surfaces: ['#hero-feat-land-pkg', '#sec-land-tenure-showcase', '#tab-market-virgin', '#virgin-groves-container', '#modal-pkg-card-land', '#filter-land'].filter(shown),
      cardPricesShown: [...cards].filter((el) => getComputedStyle(el).display !== 'none').length
    };
  });
  await page.evaluate(() => { document.getElementById('filter-land').value = 'all'; renderMarketplace(); });

  // ---- 2b2. country filter: hidden with one origin country, data-driven with more -----
  const origin = await page.evaluate(() => {
    const visible = () => !document.getElementById('filter-country-wrapper').classList.contains('hidden');
    const cards = () => [...document.querySelectorAll('#trees-grid [data-click^="viewTreeDetails"]')].length;
    state.currentLang = 'de'; // country names come from the data; the German dictionary is not loaded here, so labels fall back to English
    renderCountryFilter();
    const single = { visible: visible(), options: document.getElementById('filter-country').options.length };
    state.origins = { countries: [{ code: 'ES', name: 'إسبانيا', name_en: 'Spain', name_de: 'Spanien', currency: 'EUR' }], farms: [] };
    state.trees.push({ ...JSON.parse(JSON.stringify(state.trees[0])), id: 'tree_es_x', country_code: 'ES', tree_name_en: 'Picual Test', server_listed: true });
    renderCountryFilter(); renderMarketplace();
    const all = cards();
    const options = [...document.getElementById('filter-country').options].map((o) => `${o.value}:${o.textContent}`);
    document.getElementById('filter-country').value = 'ES'; renderMarketplace();
    const onlySpain = { cards: cards(), names: document.getElementById('trees-grid').textContent.includes('Picual Test') };
    resetMarketplaceFilters();
    const afterReset = document.getElementById('filter-country').value;
    state.trees = state.trees.filter((tr) => tr.id !== 'tree_es_x'); state.origins = null;
    renderCountryFilter(); renderMarketplace();
    const back = visible();
    state.currentLang = 'en';
    return { single, twoVisible: options.length === 3, options, fewer: onlySpain.cards > 0 && onlySpain.cards < all, names: onlySpain.names, afterReset, back };
  });
  assert.deepEqual(origin, { single: { visible: false, options: 2 }, twoVisible: true, options: ['all:All countries', 'ES:Spanien', 'SY:Syrien'], fewer: true, names: true, afterReset: 'all', back: false }, 'country filter follows the catalogue');

  // ---- 2c. assistant knowledge layer: truthful topics first, in the language of the question ----
  const faq = await page.evaluate(() => {
    const ask = (lang, q) => { state.currentLang = lang; const html = generateFaseelaResponse(q); return `${(/data-faq="([a-z_]+)"/.exec(html) || [])[1] || 'legacy'}/${(/ lang="([a-z]+)"/.exec(html) || [])[1] || '-'}`; };
    const out = {
      dates: [ask('de', 'Gibt es auch Dattelpalmen?'), ask('en', 'Do you have date palms?'), ask('ar', 'هل يوجد نخيل تمر؟')],
      land: [ask('de', 'Kann ich ein Grundstück dazu kaufen?'), ask('en', 'Can I buy the land parcel?'), ask('ar', 'هل أستطيع شراء قطعة أرض مع الشجرة؟')],
      money: [ask('de', 'Ist das eine Geldanlage mit Rendite?'), ask('en', 'Can I sell my share on the P2P market?'), ask('en', 'Is there a cash payout?')],
      flow: [ask('de', 'Wie kann ich bezahlen?'), ask('ar', 'كيف أستلم الزيت؟'), ask('en', 'How do I delete my account?')],
      noFalseHit: [ask('ar', 'هل يجوز لي التسجيل؟'), ask('ar', 'كم ينتج الزيتون؟'), ask('de', 'Ich bin Landwirt, wie mache ich mit?')],
      landText: (() => { state.currentLang = 'en'; return /currently not offered/.test(generateFaseelaResponse('Can I buy the land parcel?')); })(),
      chips: {}
    };
    for (const lang of ['ar', 'en', 'de']) {
      state.currentLang = lang; renderChatQuickChips();
      const queries = [...document.querySelectorAll('#chat-quick-chips button')].map((b) => b.dataset.query);
      out.chips[lang] = [queries.length, queries.filter((q) => !/data-faq=/.test(generateFaseelaResponse(q))).length];
    }
    state.currentLang = 'en';
    return out;
  });
  assert.deepEqual(faq, {
    dates: ['dates/de', 'dates/en', 'dates/ar'],
    land: ['land_off/de', 'land_off/en', 'land_off/ar'],
    money: ['not_investment/de', 'resale_off/en', 'reinvest_off/en'],
    flow: ['payment/de', 'oil/ar', 'account/en'],
    noFalseHit: ['signup/ar', 'legacy/-', 'farmer/de'],
    landText: true,
    chips: { ar: [10, 0], en: [10, 0], de: [10, 0] }
  }, 'assistant answers from the knowledge layer');
  assert.deepEqual(land, { enabled: false, flags: [false, false], track: 'mature', blocked: 2, investModalOpen: false,
    treeOptions: 0, surfaces: [], cardPricesShown: 0 }, 'land offer is off everywhere');
  assert.deepEqual(errors, [], `page errors:\n${errors.join('\n')}`);
  await page.close();

  // ---- 2b. gift landing for signed-out visitors ------------------------------------------
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/supabase-client.mjs', (r) => r.fulfill({ contentType: 'text/javascript', body: `
      const params = new URLSearchParams(location.search);
      const gift = (params.get('gift') || '').toUpperCase();
      history.replaceState(null, '', location.pathname);
      window.FaseelaFirebase = window.FaseelaBackend = { backend: 'supabase', listPublicTrees: async () => [], pendingGiftCode: () => gift, pendingReferralCode: () => '' };
      setTimeout(() => window.dispatchEvent(new CustomEvent('faseela-auth-state', { detail: null })), 200);` }));
    const g = await ctx.newPage();
    const gErrs = [];
    g.on('pageerror', (e) => gErrs.push(e.message));
    await g.goto(`${base}?gift=abcd-efgh-2345`, { waitUntil: 'load' });
    await g.waitForFunction(() => !document.getElementById('modal-gift-landing').classList.contains('hidden'), null, { timeout: 15000 });
    const landing = await g.evaluate(async () => {
      const out = { code: document.getElementById('gift-landing-code').textContent, urlClean: !location.search.includes('gift') };
      giftLandingContinue(); await new Promise((r) => setTimeout(r, 200));
      out.landingClosed = document.getElementById('modal-gift-landing').classList.contains('hidden');
      out.authOpen = !document.getElementById('modal-auth-session').classList.contains('hidden');
      return out;
    });
    assert.deepEqual(landing, { code: 'ABCD-EFGH-2345', urlClean: true, landingClosed: true, authOpen: true });
    const gAxe = await new AxeBuilder({ page: g }).include('#modal-auth-session').withTags(['wcag2a', 'wcag2aa']).analyze();
    assert.deepEqual(gErrs, [], `gift landing page errors: ${gErrs.join(' | ')}`);
    await ctx.close();
  }

  // ---- 2c. German as third language (lazy dictionary, fallback chain, no Arabic leakage) -----
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.route('**/supabase-client.mjs', (r) => r.fulfill({ contentType: 'text/javascript', body: `
      window.FaseelaFirebase = window.FaseelaBackend = { backend: 'supabase', listPublicTrees: async () => [], pendingGiftCode: () => '', pendingReferralCode: () => '' };
      setTimeout(() => window.dispatchEvent(new CustomEvent('faseela-auth-state', { detail: null })), 200);` }));
    const d = await ctx.newPage();
    const dErrs = [];
    const dRequests = [];
    d.on('pageerror', (e) => dErrs.push(e.message));
    d.on('request', (req) => { if (req.url().endsWith('i18n-de.js')) dRequests.push(req.url()); });
    await d.goto(base, { waitUntil: 'load' });
    await d.waitForTimeout(600);
    assert.equal(dRequests.length, 0, 'German dictionary is not downloaded for Arabic visitors');
    const parity = await d.evaluate(async () => {
      setLanguage('de');
      const duringLoad = { lang: document.documentElement.lang, dir: document.documentElement.dir, fallback: t('skip_to_content') };
      const loaded = await loadGermanDictionary();
      await new Promise((r) => setTimeout(r, 300));
      const enKeys = Object.keys(i18n.en);
      const placeholders = (v) => (String(v).match(/\$\{[^}]*\}|\{[a-zA-Z_0-9]+\}/g) || []).sort().join('|');
      const tags = (v) => (String(v).match(/<[^>]+>/g) || []).sort().join('|');
      const arabic = /[؀-ۿ]/;
      return {
        duringLoad, loaded,
        missing: enKeys.filter((k) => i18n.de[k] === undefined),
        placeholderDrift: enKeys.filter((k) => i18n.de[k] !== undefined && placeholders(i18n.de[k]) !== placeholders(i18n.en[k])),
        tagDrift: enKeys.filter((k) => i18n.de[k] !== undefined && tags(i18n.de[k]) !== tags(i18n.en[k])),
        arabicInGerman: enKeys.filter((k) => arabic.test(String(i18n.de[k])) && !arabic.test(String(i18n.en[k]))),
        frozen: Object.isFrozen(i18n.de),
        lang: document.documentElement.lang, dir: document.documentElement.dir, title: document.title,
        skip: t('skip_to_content'), stored: localStorage.getItem('faseela_lang'), locale: uiLocale(),
        drawerPressed: document.getElementById('drawer-lang-de').getAttribute('aria-pressed'),
        cardPressed: document.getElementById('panel-lang-de-btn').getAttribute('aria-pressed'),
        nextLabel: document.getElementById('active-lang-label').textContent,
        // Static, data-i18n driven nodes must not show Arabic in German mode unless English does too.
        arabicNodes: [...document.querySelectorAll('[data-i18n]')].filter((el) => {
          const key = el.getAttribute('data-i18n');
          return arabic.test(el.textContent) && !arabic.test(String(i18n.en[key] === undefined ? '' : i18n.en[key]));
        }).map((el) => el.getAttribute('data-i18n')).slice(0, 10),
        fallbackToEnglish: (() => { const k = '__probe_only_en'; i18n.en[k] = 'english-probe'; const v = t(k); delete i18n.en[k]; return v; })(),
        unknownKey: t('__no_such_key__')
      };
    });
    assert.deepEqual(parity.duringLoad, { lang: 'de', dir: 'ltr', fallback: 'Skip to main content' }, 'English fallback while the German dictionary loads');
    assert.equal(parity.loaded, true);
    assert.deepEqual(parity.missing, [], 'every English key has a German string');
    assert.deepEqual(parity.placeholderDrift, [], 'placeholders preserved');
    assert.deepEqual(parity.tagDrift, [], 'HTML tags preserved');
    assert.deepEqual(parity.arabicInGerman, [], 'no Arabic introduced by the German dictionary');
    assert.equal(parity.frozen, true);
    assert.equal(parity.lang, 'de'); assert.equal(parity.dir, 'ltr');
    assert.match(parity.title, /^Faseela \| Anteilige Patenschaft/);
    assert.equal(parity.skip, 'Zum Hauptinhalt springen');
    assert.equal(parity.stored, 'de'); assert.equal(parity.locale, 'de-DE');
    assert.equal(parity.drawerPressed, 'true'); assert.equal(parity.cardPressed, 'true');
    assert.equal(parity.nextLabel, 'عربي', 'quick toggle announces the next language');
    assert.deepEqual(parity.arabicNodes, [], 'no Arabic leakage in data-i18n nodes');
    assert.equal(parity.fallbackToEnglish, 'english-probe', 'missing German key falls back to English');
    assert.equal(parity.unknownKey, '__no_such_key__');
    assert.equal(dRequests.length, 1, 'dictionary fetched exactly once');
    // Persisted choice survives a reload and unknown stored values fall back to Arabic.
    await d.reload({ waitUntil: 'load' });
    await d.waitForFunction(() => typeof i18n !== 'undefined' && !!i18n.de && document.documentElement.lang === 'de', null, { timeout: 10000 });
    const cycle = await d.evaluate(() => {
      const seen = [state.currentLang];
      toggleLanguageQuick(); seen.push(state.currentLang + ':' + document.documentElement.dir);
      toggleLanguageQuick(); seen.push(state.currentLang + ':' + document.documentElement.dir);
      toggleLanguageQuick(); seen.push(state.currentLang + ':' + document.documentElement.dir);
      setLanguage('xx'); seen.push(state.currentLang);
      return seen;
    });
    assert.deepEqual(cycle, ['de', 'ar:rtl', 'en:ltr', 'de:ltr', 'ar']);
    // Error state: dictionary unreachable -> stays usable in English, user is told.
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx2.route('**/supabase-client.mjs', (r) => r.fulfill({ contentType: 'text/javascript', body: `
      window.FaseelaFirebase = window.FaseelaBackend = { backend: 'supabase', listPublicTrees: async () => [], pendingGiftCode: () => '', pendingReferralCode: () => '' };` }));
    await ctx2.route('**/i18n-de.js', (r) => r.abort());
    const f = await ctx2.newPage();
    const fErrs = [];
    f.on('pageerror', (e) => fErrs.push(e.message));
    await f.goto(base, { waitUntil: 'load' });
    const failed = await f.evaluate(async () => {
      const toasts = [];
      const original = window.showToast;
      window.showToast = (m) => { toasts.push(m); return original && original(m); };
      setLanguage('de');
      const ok = await loadGermanDictionary();
      await new Promise((r) => setTimeout(r, 200));
      return { ok, hasDe: !!i18n.de, text: t('skip_to_content'), dir: document.documentElement.dir, toasts };
    });
    assert.equal(failed.ok, false); assert.equal(failed.hasDe, false);
    assert.equal(failed.text, 'Skip to main content'); assert.equal(failed.dir, 'ltr');
    assert.ok(failed.toasts.some((m) => /German could not be loaded/.test(m)), 'load failure is announced');
    assert.deepEqual(fErrs, [], `german failure page errors: ${fErrs.join(' | ')}`);
    await ctx2.close();
    await d.evaluate(() => setLanguage('de'));
    await d.waitForTimeout(300);
    const deAxe = await new AxeBuilder({ page: d }).include('header').include('main').withTags(['wcag2a', 'wcag2aa']).analyze();
    for (const v of deAxe.violations) failures.push(`de: ${v.id} (${v.nodes.length}) ${v.nodes[0]?.html.slice(0, 100)}`);
    assert.deepEqual(dErrs, [], `german page errors: ${dErrs.join(' | ')}`);
    await ctx.close();
  }

  // ---- 2d. push notifications (native app mocked through a fake Capacitor plugin) ------------
  {
    const TOKEN = 'fcmTok_' + 'p'.repeat(60);
    // Browser (no Capacitor): the card stays hidden and nothing is registered.
    const webCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await webCtx.route('**/supabase-client.mjs', (r) => r.fulfill({ contentType: 'text/javascript', body: MOCK_CLIENT }));
    const w = await webCtx.newPage();
    await w.goto(`${base}?mockRole=investor`, { waitUntil: 'load' });
    await w.waitForFunction(() => state.currentUser && state.serverMode, null, { timeout: 20000 });
    const web = await w.evaluate(async () => {
      await enablePushNotifications();
      return { hidden: document.getElementById('prefs-push-card').classList.contains('hidden'), calls: window.FaseelaBackend.calls.filter((c) => /Push/.test(c[0])).length };
    });
    assert.deepEqual(web, { hidden: true, calls: 0 }, 'no push UI and no registration in the browser');
    await webCtx.close();

    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/supabase-client.mjs', (r) => r.fulfill({ contentType: 'text/javascript', body: MOCK_CLIENT }));
    await ctx.addInitScript((token) => {
      const listeners = {};
      window.__push = { permission: localStorage.getItem('__pushPerm') || 'prompt', afterRequest: 'granted', token, log: [], listeners }; // the OS remembers the permission across app starts
      window.Capacitor = {
        isNativePlatform: () => true, getPlatform: () => 'android', isPluginAvailable: () => false,
        Plugins: { PushNotifications: {
          addListener: async (name, fn) => { listeners[name] = fn; return { remove: async () => {} }; },
          checkPermissions: async () => { window.__push.log.push('check'); return { receive: window.__push.permission }; },
          requestPermissions: async () => { window.__push.log.push('request'); window.__push.permission = window.__push.afterRequest; return { receive: window.__push.permission }; },
          register: async () => { window.__push.log.push('register'); setTimeout(() => listeners.registration && listeners.registration({ value: window.__push.token }), 20); },
          unregister: async () => { window.__push.log.push('unregister'); }
        } }
      };
    }, TOKEN);
    const n = await ctx.newPage();
    const nErrs = [];
    n.on('pageerror', (e) => nErrs.push(e.message));
    await n.goto(`${base}?mockRole=investor`, { waitUntil: 'load' });
    await n.waitForFunction(() => state.currentUser && state.serverMode, null, { timeout: 20000 });
    await n.waitForFunction(() => !document.getElementById('prefs-push-card').classList.contains('hidden'), null, { timeout: 5000 });
    const push = await n.evaluate(async (token) => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const pushCalls = () => window.FaseelaBackend.calls.filter((c) => /Push|signOut/.test(c[0])).map((c) => c[0] + (c[1] ? ':' + (c[1].token === token ? 'tok' : 'other') + (c[1].platform ? ':' + c[1].platform : '') : ''));
      const card = () => ({ hidden: document.getElementById('prefs-push-card').classList.contains('hidden'), status: document.getElementById('prefs-push-status').textContent, pressed: document.getElementById('prefs-push-toggle').getAttribute('aria-pressed'), label: document.getElementById('prefs-push-toggle').textContent });
      setLanguage('en');
      const out = {};
      out.initial = { ...card(), log: [...window.__push.log], calls: pushCalls() }; // signed in, not opted in: no prompt
      // 1. permission refused
      window.__push.afterRequest = 'denied';
      await enablePushNotifications(); await wait(60);
      out.denied = { ...card(), calls: pushCalls(), optIn: localStorage.getItem('faseela_push_optin_uid') };
      // 2. permission granted -> token registered with the server
      window.__push.permission = 'prompt'; window.__push.afterRequest = 'granted';
      togglePushNotifications(); await wait(120);
      out.enabled = { ...card(), calls: pushCalls(), optIn: localStorage.getItem('faseela_push_optin_uid') };
      // 3. foreground message is shown as plain text; a tap opens the dashboard
      window.__push.listeners.pushNotificationReceived({ body: '<img src=x onerror=alert(1)> Payment approved' });
      out.toastHtml = document.getElementById('toast-message').innerHTML;
      navigateTo('marketplace'); window.__push.listeners.pushNotificationActionPerformed({}); await wait(50);
      out.pageAfterTap = getCurrentVisiblePage();
      // 4. server refuses the switch-off -> the card must not claim "off"
      window.__pushServerDown = true;
      togglePushNotifications(); await wait(80);
      out.disableFailed = { ...card(), optIn: localStorage.getItem('faseela_push_optin_uid') };
      window.__pushServerDown = false;
      renderPushCard('on');
      togglePushNotifications(); await wait(80);
      out.disabled = { ...card(), calls: pushCalls().slice(-1), optIn: localStorage.getItem('faseela_push_optin_uid'), log: window.__push.log.slice(-1) };
      // 5. unusable token from the plugin is rejected client-side
      window.__push.token = 'bad token!';
      await enablePushNotifications(); await wait(80);
      out.badToken = { ...card(), registered: pushCalls().filter((c) => c.startsWith('registerPushToken:other')).length };
      // 6. sign-out releases the device before the session ends
      window.__push.token = token;
      renderPushCard('off'); await enablePushNotifications(); await wait(120);
      window.FaseelaBackend.calls.length = 0;
      await handleSignOut();
      out.signOut = window.FaseelaBackend.calls.map((c) => c[0]);
      return out;
    }, TOKEN);
    assert.deepEqual(push.initial, { hidden: false, status: 'Off', pressed: 'false', label: 'Turn on', log: [], calls: [] }, 'no permission prompt and no registration before the user opts in');
    assert.equal(push.denied.pressed, 'false'); assert.match(push.denied.status, /blocked in the system settings/);
    assert.deepEqual(push.denied.calls, [], 'denied permission registers nothing'); assert.equal(push.denied.optIn, null);
    assert.deepEqual({ status: push.enabled.status, pressed: push.enabled.pressed, label: push.enabled.label }, { status: 'On for this device', pressed: 'true', label: 'Turn off' });
    assert.deepEqual(push.enabled.calls, ['registerPushToken:tok:android']); assert.equal(push.enabled.optIn, 'u1', 'opt-in is bound to the account');
    assert.ok(!/<img/i.test(push.toastHtml) && /&lt;img/.test(push.toastHtml), 'push text is rendered as text, never as markup');
    assert.equal(push.pageAfterTap, 'dashboard');
    assert.match(push.disableFailed.status, /could not be changed/); assert.equal(push.disableFailed.optIn, 'u1', 'failed switch-off keeps the opt-in');
    assert.deepEqual(push.disabled, { hidden: false, status: 'Off', pressed: 'false', label: 'Turn on', calls: ['unregisterPushToken:tok'], optIn: null, log: ['unregister'] });
    assert.match(push.badToken.status, /could not be changed/); assert.equal(push.badToken.registered, 0, 'malformed token never reaches the server');
    assert.deepEqual(push.signOut, ['unregisterPushToken', 'signOut'], 'device released before sign-out');
    // iPhone: push stays off until the Firebase iOS SDK is wired in (the FCM sender cannot address APNs tokens).
    const ios = await n.evaluate(async () => {
      const original = window.Capacitor.getPlatform;
      window.Capacitor.getPlatform = () => 'ios';
      window.FaseelaBackend.calls.length = 0; window.__push.log.length = 0;
      renderPushCard(); await enablePushNotifications();
      const out = { hidden: document.getElementById('prefs-push-card').classList.contains('hidden'), log: [...window.__push.log], calls: window.FaseelaBackend.calls.length };
      window.Capacitor.getPlatform = original; renderPushCard();
      return out;
    });
    assert.deepEqual(ios, { hidden: true, log: [], calls: 0 }, 'no push on iOS for now');
    // Returning user: opted-in account refreshes its token silently after reload (no permission request).
    await n.evaluate(() => { localStorage.setItem('faseela_push_optin_uid', 'u1'); localStorage.setItem('__pushPerm', 'granted'); });
    await n.reload({ waitUntil: 'load' });
    await n.waitForFunction(() => window.FaseelaBackend && window.FaseelaBackend.calls.some((c) => c[0] === 'registerPushToken'), null, { timeout: 20000 });
    const refreshed = await n.evaluate(() => ({ log: window.__push.log, pressed: document.getElementById('prefs-push-toggle').getAttribute('aria-pressed') }));
    assert.deepEqual(refreshed.log, ['check', 'register'], 'silent refresh: permission is checked, never requested');
    await n.waitForFunction(() => document.getElementById('prefs-push-toggle').getAttribute('aria-pressed') === 'true', null, { timeout: 5000 });
    // Server switch off (FCM not wired in yet): the card stays hidden and the native plugin is never called.
    await n.evaluate(() => localStorage.setItem('__pushOff', '1'));
    await n.reload({ waitUntil: 'load' });
    await n.waitForFunction(() => state.currentUser && state.serverMode, null, { timeout: 20000 });
    await n.waitForTimeout(400);
    const off = await n.evaluate(async () => {
      await enablePushNotifications(); togglePushNotifications(); await new Promise((r) => setTimeout(r, 80));
      return { hidden: document.getElementById('prefs-push-card').classList.contains('hidden'), log: window.__push.log, calls: window.FaseelaBackend.calls.filter((c) => /registerPush|unregisterPush/.test(c[0])).length };
    });
    assert.deepEqual(off, { hidden: true, log: [], calls: 0 }, 'push switched off server-side: nothing shown, plugin untouched');
    await n.evaluate(() => localStorage.removeItem('__pushOff'));
    // A different account on the same device is not enrolled.
    await n.evaluate(() => localStorage.setItem('faseela_push_optin_uid', 'someone-else'));
    await n.reload({ waitUntil: 'load' });
    await n.waitForFunction(() => state.currentUser && state.serverMode, null, { timeout: 20000 });
    await n.waitForTimeout(400);
    const other = await n.evaluate(() => ({ log: window.__push.log, calls: window.FaseelaBackend.calls.filter((c) => /Push/.test(c[0])).length }));
    assert.deepEqual(other, { log: [], calls: 0 }, 'opt-in of another account does not enrol this one');
    const pushAxe = await new AxeBuilder({ page: n }).include('#prefs-push-card').withTags(['wcag2a', 'wcag2aa']).analyze();
    for (const v of pushAxe.violations) failures.push(`push card: ${v.id} (${v.nodes.length}) ${v.nodes[0]?.html.slice(0, 100)}`);
    assert.deepEqual(nErrs, [], `push page errors: ${nErrs.join(' | ')}`);
    await ctx.close();
  }

  // ---- 3. mocked sessions ---------------------------------------------------------------
  for (const role of ['investor', 'admin', 'farmer']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.route('**/supabase-client.mjs', (r) => r.fulfill({ contentType: 'text/javascript', body: MOCK_CLIENT }));
    const p = await ctx.newPage();
    const errs = [];
    const navs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
    p.on('framenavigated', (f) => { if (f === p.mainFrame()) navs.push(f.url()); });
    await p.goto(`${base}?mockRole=${role}`, { waitUntil: 'load' });
    await p.waitForFunction(() => state.currentUser && state.serverMode, null, { timeout: 20000 });
    const result = await p.evaluate(async (r) => {
      const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      navigateTo(r === 'farmer' ? 'farmer-portal' : 'dashboard'); await wait(300);
      const out = { page: getCurrentVisiblePage(), shares: state.userShares.length, kpiTrees: document.getElementById('dash-trees-count')?.innerText || '' };
      if (r === 'farmer') {
        await wait(300);
        out.toolsVisible = !document.getElementById('farmer-server-tools').classList.contains('hidden');
        out.treeOptions = document.querySelectorAll('#fqr-tree option').length;
        out.treeLabel = document.querySelector('#fqr-tree option')?.textContent || '';
        fqrSelectType('pruning');
        out.pressed = document.querySelector('#fqr-types [data-fqr-type="pruning"]').getAttribute('aria-pressed');
        // Photo validation: a text file is rejected client-side, a small PNG is accepted.
        const dt = new DataTransfer();
        dt.items.add(new File(['x'], 'notes.txt', { type: 'text/plain' }));
        document.getElementById('fqr-photos').files = dt.files; fqrPhotosChanged();
        out.badPhotoError = !document.getElementById('fqr-error').classList.contains('hidden');
        const png = new File([new Uint8Array([137, 80, 78, 71])], 'leaf.png', { type: 'image/png' });
        const dt2 = new DataTransfer(); dt2.items.add(png);
        document.getElementById('fqr-photos').files = dt2.files; fqrPhotosChanged();
        out.previewCount = document.querySelectorAll('#fqr-photo-preview img').length;
        document.getElementById('fqr-notes').value = 'Drip irrigation 2h';
        await submitQuickReport(); await wait(100);
        const sub = window.FaseelaBackend.calls.find((c) => c[0] === 'submitFarmerUpdate');
        out.reportPayload = sub ? { treeId: sub[1].treeId, eventType: sub[1].eventType, media: sub[1].mediaPaths, notes: sub[1].notes } : null;
        out.uploadBeforeSubmit = window.FaseelaBackend.calls.findIndex((c) => c[0] === 'uploadFieldMedia') < window.FaseelaBackend.calls.findIndex((c) => c[0] === 'submitFarmerUpdate');
        out.previewCleared = document.querySelectorAll('#fqr-photo-preview img').length === 0 && document.getElementById('fqr-notes').value === '';
        // Profile: consent without a name is blocked client-side; with a name it is saved and the status flips to public.
        document.getElementById('fp-consent').checked = true;
        await saveFarmerProfile(); await wait(50);
        out.nameError = !document.getElementById('fp-error').classList.contains('hidden');
        document.getElementById('fp-name').value = 'Abu Ahmad';
        document.getElementById('fp-village').value = 'Al-Qusayr';
        document.getElementById('fp-years').value = '25';
        await saveFarmerProfile(); await wait(100);
        const prof = window.FaseelaBackend.calls.find((c) => c[0] === 'updateFarmerProfile');
        out.profilePayload = prof ? { displayName: prof[1].displayName, yearsFarming: prof[1].yearsFarming, consentPublic: prof[1].consentPublic, photoPath: prof[1].photoPath } : null;
        out.statusPublic = /Public since|منشور/.test(document.getElementById('fp-status').textContent);
        out.treeLink = !!document.querySelector('#fp-status a[href^="tree.html?tree=tree_01"]');
        out.consentDisplayed = document.getElementById('fp-consent').checked;
      }
      if (r === 'investor') {
        // Profile edits must reach the server in server mode (name + consent), not only localStorage.
        openAuthModal(); await wait(150);
        toggleProfileEditDrawer(true); await wait(50);
        document.getElementById('profile-edit-name').value = 'QA Tester';
        document.getElementById('profile-edit-phone').value = '+49 151 1234567';
        document.getElementById('profile-edit-marketing').checked = true;
        await saveUserProfileEdits(); await wait(100);
        out.profileCalls = window.FaseelaBackend.calls.map((c) => c[0]);
        out.profileName = window.FaseelaBackend.calls[0]?.[1]?.displayName;
        out.consent = state.currentUser.marketing_opt_in;
        closeModal('modal-auth-session');
        // Oil: allocation rendered, KPI shows the real amount, delivery request validated then sent.
        out.oilVisible = !document.getElementById('my-oil-section').classList.contains('hidden');
        out.oilAvailable = document.getElementById('oil-available-liters').textContent;
        out.oilKpi = document.getElementById('dash-expected-oil').innerText;
        openOilRequestModal(); await wait(100);
        document.getElementById('oil-name').value = 'QA Tester';
        document.getElementById('oil-phone').value = '+49 151 1234567';
        await submitOilRequest(); await wait(50);
        out.oilValidationShown = !document.getElementById('oil-modal-error').classList.contains('hidden');
        document.getElementById('oil-line1').value = 'Musterweg 1';
        document.getElementById('oil-city').value = '10115 Berlin';
        document.getElementById('oil-country').value = 'de';
        await submitOilRequest(); await wait(100);
        const oilCall = window.FaseelaBackend.calls.find((c) => c[0] === 'requestOil');
        out.oilPayload = oilCall ? { kind: oilCall[1].kind, ids: oilCall[1].allocationIds.length, country: oilCall[1].contact.country } : null;
        out.oilModalClosed = document.getElementById('modal-oil-request').classList.contains('hidden');
        // Certificate: server-mode share card offers the PDF and shows the real serial (no demo parcel text).
        const card = document.getElementById('my-shares-container');
        out.certButton = !!card.querySelector(`[data-click="downloadShareCertificatePdf('${'c'.repeat(64)}')"]`);
        out.demoParcelText = /Parcel #412|SYR-MILL-2025/.test(card.innerHTML);
        out.serialShown = card.innerHTML.includes('FSL-') && card.innerHTML.includes('C'.repeat(16));
        await downloadShareCertificatePdf('c'.repeat(64)); await wait(50);
        out.certCall = window.FaseelaBackend.calls.some((c) => c[0] === 'downloadShareCertificate');
        // Payment timeline: 4 steps per request, current step marked, SLA date shown, rejection note visible.
        const tls = [...document.querySelectorAll('#my-investments-container [data-timeline]')];
        out.timelines = tls.map((el) => el.dataset.timeline);
        out.timelineSteps = tls[0]?.querySelectorAll('ol > li').length;
        out.timelineCurrent = tls[0]?.querySelector('[aria-current="step"]')?.textContent.replace(/\s+/g, ' ').trim() || '';
        out.timelineRejectNote = tls[1]?.textContent.includes('Receipt unreadable');
        // Sync pill: shown while offline with the last sync time, hidden again when online.
        window.dispatchEvent(new CustomEvent('faseela-sync-state', { detail: { online: false, lastSyncAt: Date.now() } }));
        out.syncPillOffline = !document.getElementById('sync-state-pill').classList.contains('hidden');
        window.dispatchEvent(new CustomEvent('faseela-sync-state', { detail: { online: true, lastSyncAt: Date.now(), reason: 'online' } }));
        out.syncPillOnline = document.getElementById('sync-state-pill').classList.contains('hidden');
        // Gifts & referrals: section visible, referral code + link rendered, gift flow shows the code once,
        // list + card badge update, cancel works, redeem distinguishes invalid from redeemed, bad format blocked client-side.
        await wait(200);
        out.rewardsVisible = !document.getElementById('my-rewards-section').classList.contains('hidden');
        out.referralCode = document.getElementById('referral-code').textContent;
        out.referralWa = document.getElementById('referral-share-wa').getAttribute('href').includes(encodeURIComponent('?ref=QATEST23'));
        out.referralStats = document.getElementById('referral-stats').textContent;
        out.giftButton = !!card.querySelector(`[data-click="openGiftModal('${'c'.repeat(64)}')"]`);
        openGiftModal('c'.repeat(64)); await wait(100);
        out.giftModalOpen = !document.getElementById('modal-gift').classList.contains('hidden');
        document.getElementById('gift-recipient').value = 'Layla';
        document.getElementById('gift-message').value = 'Happy birthday';
        await submitCreateGift(); await wait(200);
        const gc = window.FaseelaBackend.calls.find((c) => c[0] === 'createGift');
        out.giftPayload = gc ? { shareId: gc[1].shareId.length, recipientName: gc[1].recipientName, message: gc[1].message } : null;
        out.giftCodeShown = document.getElementById('gift-result-code').textContent;
        out.giftWa = document.getElementById('gift-result-wa').getAttribute('href').includes(encodeURIComponent('ABCD-EFGH-2345'));
        out.giftFormHidden = document.getElementById('gift-form').classList.contains('hidden');
        closeModal('modal-gift');
        out.giftListed = /2345/.test(document.getElementById('my-gifts-list').textContent);
        out.giftBadge = !card.querySelector(`[data-click="openGiftModal('${'c'.repeat(64)}')"]`) && /gift/.test(card.innerHTML);
        window.confirm = () => true;
        await cancelGiftCode('55555555-5555-4555-8555-555555555555'); await wait(150);
        out.giftCancelled = window.FaseelaBackend.calls.some((c) => c[0] === 'cancelGift');
        out.giftButtonBack = !!card.querySelector(`[data-click="openGiftModal('${'c'.repeat(64)}')"]`);
        document.getElementById('gift-redeem-input').value = 'abc';
        await redeemGiftCode(); await wait(50);
        out.redeemFormatBlocked = !window.FaseelaBackend.calls.some((c) => c[0] === 'redeemGift') && !document.getElementById('gift-redeem-msg').classList.contains('hidden');
        document.getElementById('gift-redeem-input').value = 'aaaa aaaa aaaa';
        await redeemGiftCode(); await wait(50);
        out.redeemInvalidMsg = document.getElementById('gift-redeem-msg').textContent;
        document.getElementById('gift-redeem-input').value = 'wxyz-wxyz-wxyz';
        await redeemGiftCode(); await wait(50);
        out.redeemCalls = window.FaseelaBackend.calls.filter((c) => c[0] === 'redeemGift').map((c) => c[1]);
        out.redeemCleared = document.getElementById('gift-redeem-input').value === '';
        // Checkout extras: referral row hidden because the user already owns a server share; gift toggle reveals fields.
        openInvestModal('tree_01'); await wait(100);
        out.extrasVisible = !document.getElementById('invest-extras').classList.contains('hidden');
        out.referralRowHidden = document.getElementById('invest-referral-row').classList.contains('hidden');
        document.getElementById('invest-gift-toggle').checked = true; investGiftToggled(true);
        out.giftFieldsShown = !document.getElementById('invest-gift-fields').classList.contains('hidden');
        document.getElementById('invest-gift-recipient').value = 'Mama';
        out.extrasCollected = collectInvestExtras();
        // Payment instructions: unconfigured → blocking notice + purchase refused before any reservation.
        await wait(100);
        out.payUnconfigured = !!document.querySelector('#local-pay-accounts [role="alert"]');
        out.payReady = state.paymentReady;
        document.getElementById('invest-risk-ack').checked = true;
        state.selectedReceiptFile = new File(['x'], 'r.png', { type: 'image/png' });
        await confirmPurchase(); await wait(50);
        out.purchaseBlocked = !window.FaseelaBackend.calls.some((c) => c[0] === 'createInvestmentRequest');
        window.FaseelaBackend.payment = { channels: [{ id: 'bank_iban', titleAr: 'بنك', titleEn: 'Bank', account: 'SY00 TEST 1234', hintEn: 'Reference: your name' }], noteEn: 'Keep the receipt', updatedAt: Date.now() };
        await preparePaymentInstructions(true); await wait(50);
        out.payRendered = document.getElementById('local-pay-accounts').textContent.includes('SY00 TEST 1234') && document.getElementById('local-pay-accounts').textContent.includes('Keep the receipt');
        out.payCopyBtn = !!document.querySelector('#local-pay-accounts button[data-account="SY00 TEST 1234"]');
        out.payReadyAfter = state.paymentReady;
        out.noDemoIban = !document.body.innerHTML.includes('SY98BBSF') && !document.body.innerHTML.includes('0944112233');
        state.selectedReceiptFile = null;
        closeModal('modal-invest');
        // P2P stays demo-only: tab hidden, modal refuses, chatbot answer gated.
        out.tradeTabHidden = document.getElementById('btn-investor-tab-trade').classList.contains('hidden');
        switchInvestorSubTab('trade'); await wait(50);
        out.tradePanelHidden = document.getElementById('panel-investor-trade').classList.contains('hidden');
        openP2PListModal(); await wait(50);
        out.p2pModalHidden = !document.querySelector('[id^="modal-p2p"]:not(.hidden)');
      }
      if (r === 'admin') {
        navigateTo('founder-control'); await wait(300);
        await loadServerUsersDirectory(); await wait(100);
        out.users = state.users.length;
        await loadFounderSystemStatus(); await wait(100);
        out.statusTiles = document.querySelectorAll('#fndr-system-status-body > div').length;
        out.statusVisible = !document.getElementById('fndr-system-status').classList.contains('hidden');
        openFounderManageUserModal(state.users[0].id); await wait(300);
        out.assignBoxVisible = !document.getElementById('fndr-assign-box').classList.contains('hidden');
        out.assignChips = document.querySelectorAll('#fndr-assign-trees [data-click^="founderRemoveAssignment"]').length;
        out.impersonateHidden = document.getElementById('fndr-btn-impersonate').classList.contains('hidden');
        closeModal('modal-fndr-manage-user');
        // Review gate (audit run-1 F2): approving a field report without opening it is refused and opens the detail;
        // the detail shows full notes + photos (signed with the reviewer's session); approve then publishes.
        await loadServerReviewQueues(); await wait(100);
        const fuId = '44444444-4444-4444-8444-444444444444';
        out.queueHasReport = (state.financialApprovalsQueue || []).some((i) => i.id === fuId && i.type === 'farmer_update');
        await approveFinancialRequest(fuId); await wait(150);
        out.blindApproveBlocked = !window.FaseelaBackend.calls.some((c) => c[0] === 'reviewFarmerUpdate');
        out.detailOpened = !document.getElementById('modal-fndr-fin-detail').classList.contains('hidden');
        out.contentVisible = !document.getElementById('fndr-fin-modal-content').classList.contains('hidden');
        out.notesFull = document.getElementById('fndr-fin-modal-notes').textContent.length === 500;
        await wait(200);
        out.signCall = window.FaseelaBackend.calls.some((c) => c[0] === 'signFieldMedia' && c[1].length === 2);
        out.photoRendered = !!document.querySelector('#fndr-fin-modal-media img[src^="https://riyvlhlhzxxerlwqoxsy.supabase.co/"]');
        out.missingFlag = !document.getElementById('fndr-fin-modal-media-note').classList.contains('hidden');
        closeModal('modal-fndr-fin-detail');
        await approveFinancialRequest(fuId); await wait(150);
        const rev = window.FaseelaBackend.calls.find((c) => c[0] === 'reviewFarmerUpdate');
        out.publishPayload = rev ? { updateId: rev[1].updateId, decision: rev[1].decision } : null;
        // Screening: approving a payment opens the screening step; validation; clear → record then approve; hit → record only.
        const payId = 'b'.repeat(64);
        out.approveOpensScreening = (await decideServerReviewItem({ serverQueue: 'payments', id: payId }, true)) === false; await wait(150);
        out.screeningOpen = !document.getElementById('modal-screening').classList.contains('hidden');
        await submitPaymentScreening(); await wait(50);
        out.screeningEmptyBlocked = !document.getElementById('screening-error').classList.contains('hidden') && !window.FaseelaBackend.calls.some((c) => c[0] === 'recordPaymentScreening');
        document.querySelector('input[name="scr-result"][value="hit"]').checked = true;
        document.getElementById('scr-lists').value = 'EU, UN';
        await submitPaymentScreening(); await wait(50);
        out.hitNeedsNote = !window.FaseelaBackend.calls.some((c) => c[0] === 'recordPaymentScreening');
        document.getElementById('scr-note').value = 'Exact name match';
        await submitPaymentScreening(); await wait(150);
        out.hitRecordedNoApproval = window.FaseelaBackend.calls.filter((c) => c[0] === 'recordPaymentScreening').length === 1 && !window.FaseelaBackend.calls.some((c) => c[0] === 'reviewInvestmentRequest');
        await openScreeningModal(payId); await wait(100);
        document.querySelector('input[name="scr-result"][value="clear"]').checked = true;
        document.getElementById('scr-lists').value = 'EU, UN, OFAC';
        document.getElementById('scr-reference').value = 'CASE-7';
        await submitPaymentScreening(); await wait(150);
        const order = window.FaseelaBackend.calls.filter((c) => ['recordPaymentScreening', 'reviewInvestmentRequest'].includes(c[0]));
        out.clearOrder = order.slice(-2).map((c) => c[0] + ':' + (c[1].result || c[1].decision));
        out.clearPayload = { lists: order[order.length - 2][1].listsChecked, ref: order[order.length - 2][1].reference };
        out.screeningClosed = document.getElementById('modal-screening').classList.contains('hidden');
        // Finance export: box visible, bad period rejected client-side, CSV built with BOM, quoting and formula neutralisation.
        out.fxVisible = !document.getElementById('fndr-finance-export').classList.contains('hidden');
        out.fxDefaults = /^\d{4}-\d{2}-01$/.test(document.getElementById('fx-from').value) && /^\d{4}-\d{2}-\d{2}$/.test(document.getElementById('fx-to').value);
        document.getElementById('fx-from').value = '2026-12-01'; document.getElementById('fx-to').value = '2026-11-01';
        await downloadFinanceExport(); await wait(50);
        out.fxBadPeriodBlocked = !window.FaseelaBackend.calls.some((c) => c[0] === 'financeExport');
        document.getElementById('fx-from').value = '2026-11-01'; document.getElementById('fx-to').value = '2026-11-30';
        let csvBlob = null; const realCreate = URL.createObjectURL; URL.createObjectURL = (b) => { csvBlob = b; return realCreate.call(URL, b); };
        await downloadFinanceExport(); await wait(100); URL.createObjectURL = realCreate;
        const csvBytes = csvBlob ? new Uint8Array(await csvBlob.arrayBuffer()) : new Uint8Array();
        const csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(csvBytes);
        const Q = String.fromCharCode(34);
        out.fxCall = window.FaseelaBackend.calls.find((c) => c[0] === 'financeExport')?.[1];
        out.fxHeader = csv.split('\r\n')[0].replace(/^\uFEFF/, '').startsWith('requestId,createdAt,status,payerName') && csv.split('\r\n')[0].endsWith('amountMajor');
        out.fxBom = csvBytes[0] === 0xEF && csvBytes[1] === 0xBB && csvBytes[2] === 0xBF;
        out.fxFormulaNeutralised = csv.includes(Q + "'=HYPERLINK(" + Q + Q + 'http://x' + Q + Q + ',' + Q + Q + 'y' + Q + Q + ')' + Q);
        out.fxQuoted = csv.includes(Q + 'ok, ' + Q + Q + 'fine' + Q + Q + Q) && csv.trimEnd().endsWith('35.00');
        out.fxMsg = document.getElementById('fx-msg').textContent;
        out.csvCells = [csvCell('+49 151'), csvCell('plain'), csvCell(null), csvCell('-5')];
        // Receiving accounts form: visible, 3 rows, empty save rejected client-side, valid save hits the RPC.
        await wait(100);
        out.payFormVisible = !document.getElementById('fndr-payment-settings').classList.contains('hidden');
        out.payRows = document.querySelectorAll('#fndr-pay-rows fieldset').length;
        await saveFounderPaymentSettings(); await wait(50);
        out.paySaveEmptyBlocked = !window.FaseelaBackend.calls.some((c) => c[0] === 'adminSetPaymentInstructions') && !document.getElementById('fndr-pay-error').classList.contains('hidden');
        document.getElementById('fndr-pay-type-0').value = 'syriatel_cash';
        document.getElementById('fndr-pay-title-ar-0').value = 'سيريتل كاش';
        document.getElementById('fndr-pay-title-en-0').value = 'Syriatel Cash';
        document.getElementById('fndr-pay-account-0').value = '0999 000 000';
        document.getElementById('fndr-pay-note-en').value = 'Keep the receipt';
        await saveFounderPaymentSettings(); await wait(100);
        const ps = window.FaseelaBackend.calls.find((c) => c[0] === 'adminSetPaymentInstructions');
        out.paySavePayload = ps ? { n: ps[1].channels.length, id: ps[1].channels[0].id, account: ps[1].channels[0].account, noteEn: ps[1].noteEn, noteAr: ps[1].noteAr } : null;
        out.payStatusUpdated = /Last updated|آخر تحديث/.test(document.getElementById('fndr-pay-status').textContent);
        out.fourEyesOffHint = /Single admin|مشرف واحد/.test(document.getElementById('fndr-pay-status').textContent);
        out.pendingHiddenSingle = document.getElementById('fndr-pay-pending').classList.contains('hidden');
        // Four-eyes: with two admins a save only proposes; the proposer cannot approve; another admin can.
        window.FaseelaBackend.fourEyes = true;
        document.getElementById('fndr-pay-account-0').value = '0988 111 222';
        await saveFounderPaymentSettings(); await wait(150);
        out.pendingShown = !document.getElementById('fndr-pay-pending').classList.contains('hidden') && document.getElementById('fndr-pay-pending-list').textContent.includes('0988 111 222');
        out.liveUnchanged = window.FaseelaBackend.payment.channels[0].account === '0999 000 000';
        out.approveDisabledForProposer = document.getElementById('fndr-pay-approve').disabled;
        window.FaseelaBackend.pendingPayment.proposedBySelf = false;
        await loadFounderPaymentSettings(); await wait(100);
        out.approveEnabledForOther = !document.getElementById('fndr-pay-approve').disabled;
        await reviewFounderPaymentProposal('approve'); await wait(150);
        out.reviewCall = window.FaseelaBackend.calls.find((c) => c[0] === 'adminReviewPaymentInstructions')?.[1]?.decision;
        out.pendingCleared = document.getElementById('fndr-pay-pending').classList.contains('hidden');
        out.liveAfterApprove = document.getElementById('fndr-pay-account-0').value;
      }
      return out;
    }, role);
    // Real session: no sample widgets, no built-in sample notifications, no shop.
    const demo = await p.evaluate(() => {
      const blocks = [...document.querySelectorAll('[data-demo]')];
      const shop = [...document.querySelectorAll('[data-feature="boutique"]')];
      const toasts = []; const orig = window.showToast; window.showToast = (m) => toasts.push(m);
      switchMarketplaceTrack('boutique'); openBoutiqueCheckout('prod_01'); confirmBoutiqueOrder();
      window.showToast = orig;
      return {
        serverClass: document.documentElement.classList.contains('server-mode'),
        blocks: blocks.length >= 15, visibleBlocks: blocks.filter((el) => getComputedStyle(el).display !== 'none').map((el) => el.id || el.className.slice(0, 30)),
        shopBlocks: shop.length, visibleShop: shop.filter((el) => getComputedStyle(el).display !== 'none').length,
        track: state.marketplaceTrack, shopRefused: toasts.length, checkoutOpen: !document.getElementById('modal-boutique-checkout').classList.contains('hidden'),
        sampleNotifications: (state.notifications || []).filter((n) => /credited|صرف|180/.test(JSON.stringify(n))).length,
        badgeHidden: document.getElementById('notifications-badge').classList.contains('hidden') || (state.notifications || []).length > 0
      };
    });
    assert.deepEqual(demo, { serverClass: true, blocks: true, visibleBlocks: [], shopBlocks: 2, visibleShop: 0, track: 'mature', shopRefused: 2, checkoutOpen: false, sampleNotifications: 0, badgeHidden: true }, `no sample data in a real session (${role})`);

    if (role === 'farmer') {
      assert.equal(result.page, 'farmer-portal');
      assert.equal(result.toolsVisible, true, 'farmer server tools visible');
      assert.equal(result.treeOptions, 1, 'assigned tree listed');
      assert.match(result.treeLabel, /Qusayr Olive|زيتونة القصير/);
      assert.equal(result.pressed, 'true', 'event type toggle updates aria-pressed');
      assert.equal(result.badPhotoError, true, 'non-image rejected client-side');
      assert.equal(result.previewCount, 1, 'accepted photo previewed');
      assert.deepEqual(result.reportPayload, { treeId: 'tree_01', eventType: 'pruning', media: ['u1/tree_01/1_leaf.png'], notes: 'Drip irrigation 2h' });
      assert.equal(result.uploadBeforeSubmit, true, 'photos uploaded before the RPC');
      assert.equal(result.previewCleared, true, 'form reset after submit');
      assert.equal(result.nameError, true, 'consent requires a display name');
      assert.deepEqual(result.profilePayload, { displayName: 'Abu Ahmad', yearsFarming: 25, consentPublic: true, photoPath: undefined });
      assert.equal(result.statusPublic, true, 'status shows public after consent');
      assert.equal(result.treeLink, true, 'public tree page linked');
      assert.equal(result.consentDisplayed, true);
    } else {
      assert.equal(result.page, 'dashboard');
      assert.equal(result.shares, 1, 'mapped share reaches the dashboard');
      assert.match(result.kpiTrees, /^1\b/, `one full tree: ${result.kpiTrees}`);
    }
    if (role === 'investor') {
      assert.deepEqual(result.profileCalls, ['updateMyProfile', 'setMarketingConsent'], 'profile save hits the server');
      assert.equal(result.profileName, 'QA Tester');
      assert.equal(result.consent, true, 'consent mirrored into state after server accepted it');
      assert.equal(result.oilVisible, true, 'oil section visible in server mode');
      assert.equal(result.oilAvailable, '7.4 L');
      assert.equal(result.oilKpi, '7.4 L', 'KPI shows allocated oil instead of the estimate');
      assert.equal(result.oilValidationShown, true, 'client validation blocks an incomplete address');
      assert.deepEqual(result.oilPayload, { kind: 'delivery', ids: 1, country: 'DE' });
      assert.equal(result.oilModalClosed, true);
      assert.equal(result.certButton, true, 'PDF certificate button rendered for server shares');
      assert.equal(result.demoParcelText, false, 'no demo parcel/lab serial text in server mode');
      assert.equal(result.serialShown, true, 'certificate serial shown on the card');
      assert.equal(result.certCall, true);
      assert.deepEqual(result.timelines, ['open', 'rejected'], 'one timeline per request with its outcome');
      assert.equal(result.timelineSteps, 4);
      assert.match(result.timelineCurrent, /Finance review.*Decision expected by|مراجعة المالية/, `current step with SLA: ${result.timelineCurrent}`);
      assert.equal(result.timelineRejectNote, true, 'review note shown on a rejected request');
      assert.equal(result.syncPillOffline, true, 'offline pill visible');
      assert.equal(result.syncPillOnline, true, 'offline pill hidden when back online');
      assert.equal(result.rewardsVisible, true, 'gifts & referrals section visible in server mode');
      assert.equal(result.referralCode, 'QATEST23');
      assert.equal(result.referralWa, true, 'WhatsApp share link carries the referral link');
      assert.match(result.referralStats, /1/, 'referral stats rendered');
      assert.match(result.referralStats, /0\.25 L/, 'oil credit shown in liters');
      assert.equal(result.giftButton, true, 'gift button on server share card');
      assert.equal(result.giftModalOpen, true);
      assert.deepEqual(result.giftPayload, { shareId: 64, recipientName: 'Layla', message: 'Happy birthday' });
      assert.equal(result.giftCodeShown, 'ABCD-EFGH-2345', 'code shown once after creation');
      assert.equal(result.giftWa, true, 'WhatsApp link carries the gift code');
      assert.equal(result.giftFormHidden, true, 'form replaced by result view');
      assert.equal(result.giftListed, true, 'gift listed with its hint');
      assert.equal(result.giftBadge, true, 'open gift badge replaces the gift button');
      assert.equal(result.giftCancelled, true);
      assert.equal(result.giftButtonBack, true, 'gift button returns after cancel');
      assert.equal(result.redeemFormatBlocked, true, 'format validated client-side before the RPC');
      assert.match(result.redeemInvalidMsg, /invalid|used|expired|غير صالح/i);
      assert.deepEqual(result.redeemCalls, ['AAAA-AAAA-AAAA', 'WXYZ-WXYZ-WXYZ'], 'codes normalised before sending');
      assert.equal(result.redeemCleared, true, 'input cleared after a successful redeem');
      assert.equal(result.extrasVisible, true, 'checkout extras shown in server mode');
      assert.equal(result.referralRowHidden, true, 'referral field hidden for existing owners');
      assert.equal(result.giftFieldsShown, true);
      assert.deepEqual(result.extrasCollected, { giftRecipientName: 'Mama', giftMessage: '', referralCode: '' });
      assert.equal(result.payUnconfigured, true, 'unconfigured accounts show a blocking notice');
      assert.equal(result.payReady, false);
      assert.equal(result.purchaseBlocked, true, 'purchase refused before reservation while accounts are unknown');
      assert.equal(result.payRendered, true, 'server-managed accounts rendered with note');
      assert.equal(result.payCopyBtn, true, 'copy button carries the account');
      assert.equal(result.payReadyAfter, true);
      assert.equal(result.noDemoIban, true, 'no hard-coded demo account numbers in the DOM');
      assert.equal(result.tradeTabHidden, true, 'P2P tab hidden in server mode');
      assert.equal(result.tradePanelHidden, true, 'P2P panel never opens in server mode');
      assert.equal(result.p2pModalHidden, true, 'P2P modal refused in server mode');
    }
    if (role === 'admin') {
      assert.equal(result.users, 1);
      assert.equal(result.assignBoxVisible, true, 'assignment box shown in server mode');
      assert.equal(result.assignChips, 1, 'assigned tree rendered');
      assert.equal(result.impersonateHidden, true, 'demo impersonation hidden in server mode');
      assert.equal(result.statusVisible, true, 'system status shown for admins');
      assert.equal(result.statusTiles, 6, 'system status renders all tiles');
      assert.equal(result.queueHasReport, true, 'farmer update reaches the approvals desk');
      assert.equal(result.blindApproveBlocked, true, 'approve without inspection is refused');
      assert.equal(result.detailOpened, true, 'refusal opens the detail view');
      assert.equal(result.contentVisible, true, 'content box shown for field reports');
      assert.equal(result.notesFull, true, 'full notes shown (no truncation)');
      assert.equal(result.signCall, true, 'photos signed with the reviewer session');
      assert.equal(result.photoRendered, true, 'signed photo rendered');
      assert.equal(result.missingFlag, true, 'missing object flagged');
      assert.deepEqual(result.publishPayload, { updateId: '44444444-4444-4444-8444-444444444444', decision: 'publish' });
      assert.equal(result.approveOpensScreening, true, 'payment approval starts with the screening step');
      assert.equal(result.screeningOpen, true);
      assert.equal(result.screeningEmptyBlocked, true, 'empty screening rejected client-side');
      assert.equal(result.hitNeedsNote, true, 'hit without a note rejected client-side');
      assert.equal(result.hitRecordedNoApproval, true, 'a hit is recorded but never approved');
      assert.deepEqual(result.clearOrder, ['recordPaymentScreening:clear', 'reviewInvestmentRequest:approve'], 'clear: record first, then approve');
      assert.deepEqual(result.clearPayload, { lists: 'EU, UN, OFAC', ref: 'CASE-7' });
      assert.equal(result.screeningClosed, true);
      assert.equal(result.fxVisible, true, 'finance export shown for admins');
      assert.equal(result.fxDefaults, true, 'period defaults to the current month');
      assert.equal(result.fxBadPeriodBlocked, true, 'inverted period rejected client-side');
      assert.deepEqual(result.fxCall, { from: '2026-11-01', to: '2026-11-30' });
      assert.equal(result.fxHeader, true, 'CSV header');
      assert.equal(result.fxBom, true, 'UTF-8 BOM for spreadsheet apps');
      assert.equal(result.fxFormulaNeutralised, true, 'formula injection neutralised');
      assert.equal(result.fxQuoted, true, 'quotes escaped and major amount appended');
      assert.match(result.fxMsg, /1 row|1 صف/);
      assert.deepEqual(result.csvCells, ["'+49 151", 'plain', '', "'-5"]);
      assert.equal(result.payFormVisible, true, 'receiving-accounts form shown for admins');
      assert.equal(result.payRows, 3);
      assert.equal(result.paySaveEmptyBlocked, true, 'empty form rejected client-side');
      assert.deepEqual(result.paySavePayload, { n: 1, id: 'syriatel_cash', account: '0999 000 000', noteEn: 'Keep the receipt', noteAr: undefined });
      assert.equal(result.payStatusUpdated, true);
      assert.equal(result.fourEyesOffHint, true, 'single-admin mode is called out');
      assert.equal(result.pendingHiddenSingle, true);
      assert.equal(result.pendingShown, true, 'proposal shown with the proposed number');
      assert.equal(result.liveUnchanged, true, 'live accounts untouched while pending');
      assert.equal(result.approveDisabledForProposer, true, 'proposer cannot approve');
      assert.equal(result.approveEnabledForOther, true, 'another admin can approve');
      assert.equal(result.reviewCall, 'approve');
      assert.equal(result.pendingCleared, true);
      assert.equal(result.liveAfterApprove, '0988 111 222', 'form shows approved accounts');
    }
    assert.deepEqual(navs.filter((u) => !u.includes('mockRole')), [], 'no unexpected navigations/reloads');
    assert.deepEqual(errs, [], `page errors (${role}):\n${errs.join('\n')}`);

    // ---- 4. axe ----------------------------------------------------------------------
    for (const theme of ['light', 'dark']) {
      await p.evaluate((t) => document.documentElement.classList.toggle('dark', t === 'dark'), theme);
      for (const pg of role === 'admin' ? ['founder-control'] : role === 'farmer' ? ['farmer-portal'] : ['home', 'marketplace', 'dashboard']) {
        await p.evaluate((id) => navigateTo(id), pg);
        await p.waitForTimeout(400);
        const axe = await new AxeBuilder({ page: p }).include(`#page-${pg}`).withTags(['wcag2a', 'wcag2aa']).analyze();
        for (const v of axe.violations) failures.push(`${role}/${theme}/${pg}: ${v.id} (${v.nodes.length}) ${v.nodes[0]?.html.slice(0, 100)}`);
      }
    }
    await ctx.close();
  }
  // ---- 5. public pages: verify + status (mocked RPCs, axe) -----------------------------------
  for (const pg of ['verify.html?serial=FSL-2026-ABCDEF0123456789', 'status.html', 'tree.html?tree=tree_01&lang=en']) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('**/rest/v1/rpc/verify_certificate', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ valid: true, serial: 'FSL-2026-ABCDEF0123456789', treeId: 'tree_01', treeName: 'Test Tree', treeNameAr: 'شجرة', shareCount: 4, totalShares: 4, includesLand: true, status: 'active', holderInitials: 'M.H.', issuedAt: Date.now() }) }));
    await ctx.route('**/rest/v1/rpc/public_status', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ api: 'ok', jobs: 'ok', email: 'ok', checkedAt: Date.now() }) }));
    await ctx.route('**/rest/v1/rpc/public_tree_profile', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({
      tree: { treeId: 'tree_01', name: 'زيتونة القصير', nameEn: 'Qusayr Olive', region: 'حمص', regionEn: 'Homs', treeType: 'صوراني', treeTypeEn: 'Sorani', plantedYear: 1890, estimatedAnnualYieldKg: 60, images: ['images/olive_branches_macro.webp', 'javascript:alert(1)'], status: 'listed', totalShares: 4, availableShares: 1, pricePerShareMinor: 3500, landPriceMinor: 1500, hasLandOption: true, landAreaSqm: 25, currency: 'USD' },
      farmer: { displayName: 'Abu Ahmad', village: 'Al-Qusayr', region: 'Homs', yearsFarming: 25, bio: 'نبذة', bioEn: 'Third-generation grower.' },
      events: [{ id: 'e1', eventType: 'pruning', eventDate: Date.now(), notes: 'Winter pruning', mediaCount: 1 }, { id: 'e2', eventType: 'pressing_certified', eventDate: Date.now(), oilYieldLiters: 7.4, acidityPct: 0.3, peroxideValue: 8, certificateSerial: 'LAB-1' }],
      lastPressing: { certifiedAt: Date.now(), oilYieldLiters: 7.4, acidityPct: 0.3, peroxideValue: 8, certificateSerial: 'LAB-1', extraVirgin: true },
      stats: { publishedEvents: 2, certifiedPressings: 1 } }) }));
    await ctx.route('**/functions/v1/tree-media?*', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ treeId: 'tree_01', events: { e1: ['https://riyvlhlhzxxerlwqoxsy.supabase.co/storage/v1/object/sign/field-media/x.jpg?token=t', 'https://evil.example/x.jpg'] }, farmerPhoto: 'https://riyvlhlhzxxerlwqoxsy.supabase.co/storage/v1/object/sign/field-media/p.jpg?token=t', expiresIn: 3600 }) }));
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base + pg, { waitUntil: 'load' });
    if (pg.startsWith('verify')) {
      await p.waitForFunction(() => document.getElementById('result').dataset.state === 'ok', null, { timeout: 10000 });
      assert.match(await p.textContent('#result'), /Genuine certificate[\s\S]*M\.H\./);
    } else if (pg.startsWith('tree')) {
      await p.waitForFunction(() => document.getElementById('main').getAttribute('aria-busy') === 'false', null, { timeout: 10000 });
      const tree = await p.evaluate(() => ({
        title: document.title, name: document.getElementById('tree-name').textContent,
        farmerVisible: !document.getElementById('farmer-card').hidden, farmerPhoto: document.getElementById('farmer-photo').getAttribute('src'),
        heroSrc: document.getElementById('hero-img').getAttribute('src'), timelineItems: document.querySelectorAll('#timeline li').length,
        photos: [...document.querySelectorAll('#timeline .photos img')].map((i) => i.getAttribute('src')),
        evoo: !!document.querySelector('#pressing .badge.ok'), cta: document.getElementById('cta').getAttribute('href'), ctaDisabled: document.getElementById('cta').getAttribute('aria-disabled'),
        error: document.getElementById('error').hidden
      }));
      assert.equal(tree.title, 'Qusayr Olive · Faseela');
      assert.equal(tree.farmerVisible, true, 'consented farmer shown');
      assert.match(tree.farmerPhoto, /^https:\/\/riyvlhlhzxxerlwqoxsy\.supabase\.co\//);
      assert.equal(tree.heroSrc, 'images/olive_branches_macro.webp', 'only whitelisted hero image used');
      assert.equal(tree.timelineItems, 2);
      assert.deepEqual(tree.photos, ['https://riyvlhlhzxxerlwqoxsy.supabase.co/storage/v1/object/sign/field-media/x.jpg?token=t'], 'foreign image hosts dropped');
      assert.equal(tree.evoo, true, 'EVOO badge for low acidity/peroxide');
      assert.equal(tree.cta, './?tree=tree_01#marketplace');
      assert.equal(tree.ctaDisabled, 'false');
      assert.equal(tree.error, true);
    } else {
      await p.waitForFunction(() => document.getElementById('overall').dataset.state === 'ok', null, { timeout: 10000 });
    }
    const axe = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa']).analyze();
    for (const v of axe.violations) failures.push(`${pg}: ${v.id} (${v.nodes.length})`);
    assert.deepEqual(errs, [], `page errors (${pg})`);
    await ctx.close();
  }
  assert.deepEqual(failures, [], `axe violations:\n${failures.join('\n')}`);
  console.log(JSON.stringify({ ok: true, handlers: inventory.total }, null, 1));
} finally {
  await browser.close();
  server.kill();
}
