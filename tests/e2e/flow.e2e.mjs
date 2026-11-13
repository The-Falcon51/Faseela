// Browser E2E against the Supabase backend (Auth, PostgREST RPCs, Storage, Realtime) with the
// production CSP. Investor buys through the real UI -> proof upload (storage policy) -> finance
// reviewer approves in the approvals desk -> investor dashboard shows the share (Realtime).
// Fails on any page error. Start via tests/e2e/run-e2e.cjs (prepares identities + tree_e2e).
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = process.env.E2E_BASE || 'http://localhost:8099/index.html';
const browser = await chromium.launch({ executablePath: process.env.CHR || undefined });
const errors = [];

async function openPage() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|ERR_FILE_NOT_FOUND/.test(m.text())) errors.push(`console: ${m.text().slice(0, 200)}`); });
  page.on('dialog', (d) => d.accept(process.env.E2E_DIALOG_ANSWER || ''));
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => window.FaseelaBackend?.backend === 'supabase' && !!window.FaseelaMappers, null, { timeout: 20000 });
  return page;
}

async function signIn(page, email, password) {
  await page.evaluate(async ({ email, password }) => { await window.FaseelaBackend.signIn(email, password); }, { email, password });
  await page.waitForFunction(() => state.serverMode === true && !!state.currentUser, null, { timeout: 15000 });
}

const investorPage = await openPage();
await signIn(investorPage, process.env.E2E_INVESTOR_EMAIL, process.env.E2E_PW);

// Demo data must be gone for a real account.
const demoCheck = await investorPage.evaluate(() => ({ shares: state.userShares.length, tx: state.transactions.length, users: state.users.length, ls: Object.keys(localStorage).filter((k) => k.startsWith('faseela_') && k !== 'faseela_currency' && k !== 'faseela_lang' && k !== 'faseela_theme') }));
assert.deepEqual(demoCheck, { shares: 0, tx: 0, users: 0, ls: [] }, 'server mode starts without demo records or legacy storage');

// Buy through the real purchase function (risk ack + receipt file + land => full tree).
const purchase = await investorPage.evaluate(async (treeId) => {
  // tree_e2e is a test-only server listing: give it a local catalog card (cloned from tree_01).
  if (!state.trees.some((t) => t.id === treeId)) {
    state.trees.push({ ...JSON.parse(JSON.stringify(state.trees.find((t) => t.id === 'tree_01'))), id: treeId });
  }
  await loadServerCatalog();
  state.currentTreeId = treeId;
  state.selectedSharePct = 25;
  state.includeLandInModal = true;
  document.getElementById('invest-risk-ack').checked = true;
  state.selectedReceiptFile = new File([new Uint8Array([37, 80, 68, 70, 45])], 'receipt.pdf', { type: 'application/pdf' });
  const toasts = [];
  const orig = window.showToast; window.showToast = (m) => toasts.push(m);
  await confirmPurchase();
  window.showToast = orig;
  return { toasts, listed: state.trees.find((t) => t.id === treeId)?.server_listed };
}, process.env.E2E_TREE);
assert.equal(purchase.listed, true, 'catalog marks the seeded tree as server-listed');
assert.ok(purchase.toasts.some((t) => /4 حصص|4 shares/.test(t)), `land package forces the full tree: ${purchase.toasts.join(' | ')}`);
assert.ok(purchase.toasts.some((t) => /\$155\.00/.test(t)), `server-confirmed amount shown: ${purchase.toasts.join(' | ')}`);

await investorPage.waitForFunction(() => state.myInvestments.some((r) => r.status === 'under_review'), null, { timeout: 15000 });
await investorPage.evaluate(() => navigateTo('dashboard'));
const dashRow = await investorPage.textContent('#my-investments-container');
assert.match(dashRow, /155\.00/, 'dashboard lists the request with the server amount (regression: treeName ReferenceError)');

// Finance reviewer approves in the approvals desk.
const financePage = await openPage();
await signIn(financePage, process.env.E2E_FINANCE_EMAIL, process.env.E2E_PW);
const desk = await financePage.evaluate(async () => {
  navigateTo('founder-control');
  await loadServerReviewQueues();
  const hiddenTabs = ['overview', 'users', 'fleet'].map((t) => document.getElementById(`btn-fndr-tab-${t}`)?.classList.contains('hidden'));
  const item = state.financialApprovalsQueue.find((q) => q.serverQueue === 'payments');
  return { count: state.financialApprovalsQueue.length, hiddenTabs, id: item?.id, amount: item?.amount_usd };
});
assert.equal(desk.amount, 155, 'payment item shows the server amount');
assert.deepEqual(desk.hiddenTabs, [true, true, true], 'finance reviewers see only the approvals tab');
await financePage.evaluate((id) => approveFinancialRequest(id), desk.id);
// Approval is a two-step flow since migration 32: record the sanctions/KYC screening, then the approval follows.
await financePage.waitForFunction(() => !document.getElementById('modal-screening').classList.contains('hidden'), null, { timeout: 10000 });
await financePage.evaluate(async () => {
  document.querySelector('input[name="scr-result"][value="clear"]').checked = true;
  document.getElementById('scr-lists').value = 'E2E test lists';
  await submitPaymentScreening();
});
await financePage.waitForFunction((id) => !state.financialApprovalsQueue.some((q) => q.id === id), desk.id, { timeout: 15000 });

// Investor sees the share (realtime listener) with correct KPIs.
await investorPage.waitForFunction(() => state.userShares.length === 1, null, { timeout: 15000 });
await investorPage.evaluate(() => renderDashboard());
const kpis = await investorPage.evaluate(() => ({
  invested: document.getElementById('dash-total-invested')?.innerText,
  trees: document.getElementById('dash-trees-count')?.innerText,
  land: document.getElementById('dash-land-area')?.innerText
}));
assert.match(kpis.trees, /^1\b/, `one full tree: ${kpis.trees}`);
assert.match(kpis.land, /^5\.0/, `5 m² land: ${kpis.land}`);

// Signed receipt URL for finance (storage policy) and none for a foreign investor request id.
const signed = await financePage.evaluate(async (id) => (await window.FaseelaBackend.getPaymentProofUrl({ requestId: id })).data, desk.id);
assert.match(signed.url, /\/storage\/v1\/object\/sign\/payment-proofs\//, 'finance gets a signed receipt URL');
assert.equal(signed.expiresInSeconds, 600);

// RLS: the finance reviewer is not the investor; the investor cannot list the review queue.
const denied = await investorPage.evaluate(async () => {
  try { await window.FaseelaBackend.listReviewQueue({ queue: 'payments' }); return 'allowed'; } catch (e) { return e.code; }
});
assert.equal(denied, 'permission-denied', 'investor cannot read the payment review queue');

// DSGVO export from the UI helper.
const exported = await investorPage.evaluate(async () => (await window.FaseelaBackend.exportMyData()).shares.length);
assert.equal(exported, 1, 'export contains the share');

assert.deepEqual(errors, [], `no page errors:\n${errors.join('\n')}`);
console.log(JSON.stringify({ ok: true, purchase: purchase.toasts, kpis, desk: { count: desk.count } }, null, 1));
await browser.close();
