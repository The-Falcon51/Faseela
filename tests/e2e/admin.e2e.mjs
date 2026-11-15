// Admin panel UI suite (public/admin/). The backend module is replaced by a mock, so this checks the page's own
// behaviour: access control by role, every view's loading/empty/error state, confirmations, text-only rendering,
// CSV injection guard, four-eyes rules in the UI, and axe (WCAG 2.x A/AA) in both themes.
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = process.env.E2E_ADMIN_PORT || '8098';
const base = `http://127.0.0.1:${port}/admin/`;
const server = spawn('python3', ['-m', 'http.server', port, '--bind', '127.0.0.1', '--directory', path.join(root, 'public')], { stdio: 'ignore' });
await new Promise((resolve) => setTimeout(resolve, 800));

const XSS = '<img src=x onerror="window.__xss=1">';
const MOCK = `
const q = new URLSearchParams(location.search);
const role = q.get('mockRole') || 'admin';
const calls = [];
const fail = (code) => Object.assign(new Error(code), { code });
const state = { payments: [{ id: 'd'.repeat(64), user_name: ${JSON.stringify(XSS)} + ' Payer', amount_usd: 35, date: '2026-11-12', notes: 'tree_01 • 1 shares', paymentProofPath: 'u2/x/r.pdf' }], screening: null,
  pending: q.get('pending') ? { channels: [{ id: 'bank_iban', titleAr: 'بنك', titleEn: 'Bank', account: 'DE00 1234' }], proposedBySelf: q.get('pending') === 'self', proposedAt: Date.now() } : null };
window.FaseelaBackend = window.FaseelaFirebase = {
  backend: 'supabase', googleEnabled: false, implicitLinkRejected: q.get('implicit') === '1', calls,
  signIn: async (email, password) => { calls.push(['signIn', email]); if (password !== 'right') throw fail('auth/invalid_credentials'); emit(q.get('loginRole') || 'admin'); },
  signOut: async () => { calls.push(['signOut']); window.dispatchEvent(new CustomEvent('faseela-auth-state', { detail: null })); },
  requestPasswordReset: async (email) => { calls.push(['requestPasswordReset', email]); },
  adminSystemStatus: async () => { if (q.get('statusDown')) throw fail('permission-denied'); return { outbox: { pending: 2, failed: 1, sent24h: 0, lastError: 'provider not configured' }, clientErrors: { last24h: 0, top: [] }, reviews: { paymentsPending: 1, paymentsOverdue: 0, farmerUpdatesPending: 0, batchesPending: 0, roleApplicationsPending: 1 }, jobs: [{ name: 'faseela-send-emails', lastStatus: 'succeeded' }] }; },
  publicStatus: async () => ({ api: 'ok', jobs: 'ok', email: 'ok' }),
  listReviewQueueMapped: async (queue) => queue === 'payments' ? state.payments : (queue === 'role_applications' ? [{ id: 'u7', user_name: 'Applicant', role: 'farmer', date: '2026-11-11' }]
    : queue === 'farmer_updates' ? [{ id: 'fu1', user_name: 'Farmer', channel: 'pruning', notes: ${JSON.stringify(XSS)} + ' pruned', mediaPaths: ['u9/a.jpg', 'u9/b.jpg'], gpsLat: 34.8, gpsLng: 36.1, treeId: 'tree_01', date: '2026-11-11' }]
    : queue === 'pressing_batches' ? [{ id: 'pb1', user_name: 'Mill', channel: 'mill_1', notes: 'tree_01 • 60 kg → 7.4 L', date: '2026-11-11' }]
    : queue === 'oil_requests' ? (q.get('oilDown') ? Promise.reject(fail('permission-denied')) : []) : []),
  paymentScreeningState: async () => ({ data: state.screening }),
  recordPaymentScreening: async (p) => { calls.push(['recordPaymentScreening', p]); state.screening = { result: p.result, listsChecked: p.listsChecked, checkedAt: Date.now(), checkedBySelf: true }; return { data: {} }; },
  reviewInvestmentRequest: async (p) => { calls.push(['reviewInvestmentRequest', p]); if (p.decision === 'approve' && (!state.screening || state.screening.result !== 'clear')) throw fail(state.screening ? 'screening-blocked' : 'screening-required'); state.payments = []; return { data: {} }; },
  getPaymentProofUrl: async (p) => { calls.push(['getPaymentProofUrl', p]); return { data: { url: q.get('evilProof') ? 'https://evil.example/x.pdf' : 'https://riyvlhlhzxxerlwqoxsy.supabase.co/storage/v1/object/sign/payment-proofs/r.pdf?token=t' } }; },
  reviewRoleApplication: async (p) => { calls.push(['reviewRoleApplication', p]); return { data: {} }; },
  adminListUsers: async () => [{ id: 'u1', name: 'Me Admin', email: 'me@example.test', role: 'admin', verified: true, status: 'active', joined_date: '2026-10-20' }, { id: 'u2', name: ${JSON.stringify(XSS)}, email: 'inv@example.test', role: 'investor', verified: true, status: 'active', joined_date: '2026-10-21' }, { id: 'u3', name: 'Mill', email: 'mill@example.test', role: 'mill_owner', verified: false, status: 'suspended', joined_date: '2026-10-22' }],
  adminSetUserRole: async (p) => { calls.push(['adminSetUserRole', p]); return { data: {} }; },
  adminSetUserStatus: async (p) => { calls.push(['adminSetUserStatus', p]); return { data: {} }; },
  adminPaymentState: async () => ({ data: { live: { channels: [{ id: 'syriatel_cash', titleAr: 'سيريتل', titleEn: 'Syriatel', account: '0999 123' }], updatedAt: Date.now() }, pending: state.pending, fourEyes: !!q.get('pending'), adminCount: q.get('pending') ? 2 : 1 } }),
  adminSetPaymentInstructions: async (p) => { calls.push(['adminSetPaymentInstructions', p]); return { data: { status: 'applied' } }; },
  adminReviewPaymentInstructions: async (p) => { calls.push(['adminReviewPaymentInstructions', p]); state.pending = null; return { data: {} }; },
  financeExport: async (p) => { calls.push(['financeExport', p]); return { data: { truncated: false, rows: [{ requestId: 'a'.repeat(64), createdAt: '2026-11-10T10:00:00Z', status: 'approved', payerName: '=HYPERLINK("http://x","y")', payerEmail: 'p@example.test', userId: 'u2', treeId: 'tree_01', shareCount: 1, includesLand: false, amountMinor: 3500, currency: 'USD' }] } }; },
  adminDashboard: async () => { if (q.get('statusDown')) throw fail('permission-denied'); return { data: { generatedAt: Date.now(), users: { total: 12, confirmed: 10, new7d: 2, new30d: 5, suspended: 1 }, roles: { investor: 9, admin: q.get('pending') ? 2 : 1, farmer: 2 },
      requests: { byStatus: { approved: 4, under_review: 1 }, approvedMinor: 1400000, openMinor: 3500, overdue: q.get('calm') ? 0 : 1, expiring24h: 1 },
      months: Array.from({ length: 12 }, (_, i) => ({ month: '2026-' + String(i + 1).padStart(2, '0'), requests: i, approved: Math.floor(i / 2), approvedMinor: i === 9 ? 1234500 : i * 10000, signups: i === 11 ? 5 : 1 })),
      inventory: { trees: 3, listed: 3, totalShares: 12, soldShares: q.get('calm') ? 4 : 11, reservedShares: 0 }, funnel: { confirmed: 10, requested: 6, proof: 5, owners: 4 },
      gifts: { open: 1, redeemed: 2 }, referrals: { pending: 1, rewarded: 3 }, oil: { allocatedMl: 7400, requestsPending: 1, requestsApproved: 0 },
      mail: { sent: q.get('calm') ? 9 : 0, pending: 2, failed7d: 0 }, push: { enabled: window.__pushOn === true, activeDevices: 3 }, errors: { last24h: q.get('calm') ? 0 : 2, last7d: 2 },
      operations: { adminCount: q.get('calm') ? 2 : 1, financeAdminCount: 0, paymentAccountsConfigured: !!q.get('calm'), reviewQueues: q.get('calm') ? { payments: 0, roleApplications: 0, farmerUpdates: 0, pressingBatches: 0, oilRequests: 0 } : { payments: 1, roleApplications: 1, farmerUpdates: 1, pressingBatches: 1, oilRequests: 0 } } } }; },
  adminListInvestments: async (p) => { calls.push(['adminListInvestments', p]); const all = Array.from({ length: 30 }, (_, i) => ({ id: String(i).padStart(64, 'e'), createdAt: Date.now() - i * 86400000, status: i % 3 === 0 ? 'approved' : 'under_review', payerName: i === 0 ? ${JSON.stringify(XSS)} : 'Payer ' + i, payerEmail: 'p' + i + '@example.test', treeId: 'tree_01', shareCount: 1, includesLand: i === 1, amountMinor: 3500, currency: 'USD', slaBreached: i === 1, hasProof: i < 2 })).filter((r) => !p.status || r.status === p.status); return { data: { total: all.length, limit: p.limit, offset: p.offset, rows: all.slice(p.offset, p.offset + p.limit) } }; },
  adminListTrees: async () => ({ data: [{ treeId: 'tree_01', name: 'زيتونة', nameEn: ${JSON.stringify(XSS)} + ' Olive', regionEn: 'Homs', status: window.__treeStatus || 'listed', totalShares: 4, soldShares: 4, reservedShares: 0, availableShares: 0, pricePerShareMinor: 3500, landPriceMinor: 1500, currency: 'USD', holders: 2, farmers: 0, revenueMinor: 14000, updatedAt: Date.now() }] }),
  adminSetTreeStatus: async (p) => { calls.push(['adminSetTreeStatus', p]); window.__treeStatus = p.status; return { data: { changed: true } }; },
  adminListClientErrors: async () => ({ data: q.get('calm') ? [] : [{ fingerprint: 'f1', message: 'TypeError: ' + ${JSON.stringify(XSS)}, source: 'onerror', page: '/', release: 'r1', count: 2, users: 1, firstSeen: Date.now(), lastSeen: Date.now() }] }),
  adminSetPushEnabled: async (p) => { calls.push(['adminSetPushEnabled', p]); window.__pushOn = p.enabled; return { data: p }; },
  signFieldMedia: async (paths) => { calls.push(['signFieldMedia', paths]); return [{ path: paths[0], url: 'https://riyvlhlhzxxerlwqoxsy.supabase.co/storage/v1/object/sign/field-media/a.jpg?token=t' }, { path: paths[1], url: 'https://evil.example/b.jpg' }]; },
  reviewFarmerUpdate: async (p) => { calls.push(['reviewFarmerUpdate', p]); return { data: {} }; },
  certifyPressingBatch: async (p) => { calls.push(['certifyPressingBatch', p]); return { data: {} }; },
  reviewOilRequest: async (p) => { calls.push(['reviewOilRequest', p]); return { data: {} }; },
  adminGetTree: async (p) => { calls.push(['adminGetTree', p]); return { data: { treeId: 'tree_01', status: 'listed', name: 'زيتونة', nameEn: 'Olive', region: '', regionEn: '', treeType: 'صوراني', treeTypeEn: 'Sorani', plantedYear: 1990, estimatedAnnualYieldKg: 40, images: ['images/olive_branches_macro.webp'], totalShares: 4, soldShares: 4, reservedShares: 0, pricePerShareMinor: 3500, landPriceMinor: 0, hasLandOption: false, landAreaSqm: 0, currency: 'USD' } }; },
  adminCreateTree: async (p) => { calls.push(['adminCreateTree', p]); if (p.treeId === 'tree_01') throw fail('already-exists'); return { data: { treeId: p.treeId, status: 'unlisted' } }; },
  adminUpdateTree: async (p) => { calls.push(['adminUpdateTree', p]); if (p.totalShares < 4) throw fail('failed-precondition'); return { data: { updated: true } }; },
  adminUserDetail: async (p) => { calls.push(['adminUserDetail', p]); return { data: { userId: p.userId, email: 'inv@example.test', displayName: ${JSON.stringify(XSS)}, phone: '+963 9', region: 'Homs', role: 'farmer', requestedRole: 'farmer', createdAt: Date.now(), emailConfirmedAt: Date.now(), lastSignInAt: null, suspended: false, marketingOptIn: false,
    requests: [{ id: 'r'.repeat(64), treeId: 'tree_01', shareCount: 1, amountMinor: 3500, currency: 'USD', status: 'approved', createdAt: Date.now() }], shares: [{ id: 'r'.repeat(64), treeId: 'tree_01', shareCount: 1, includesLand: false, status: 'active', createdAt: Date.now() }],
    assignments: { trees: window.__assigned || ['tree_02'], mills: [] }, counts: { requests: 1, referralsMade: 2, oilAllocatedMl: 7400, pushDevices: 1 } } }; },
  adminAssign: async (p) => { calls.push(['adminAssign', p]); if (p.targetId === 'tree_99') throw fail('not-found'); const cur = window.__assigned || ['tree_02']; window.__assigned = p.action === 'add' ? cur.concat(p.targetId) : cur.filter((t) => t !== p.targetId); return { data: {} }; },
  adminListAssignments: async () => ({ trees: window.__assigned || ['tree_02'], mills: [] }),
  adminListShares: async (p) => { calls.push(['adminListShares', p]); const all = p.treeId === 'tree_03' ? [] : Array.from({ length: 60 }, (_, i) => ({ id: String(i).padStart(64, 'f'), ownerName: i === 0 ? ${JSON.stringify(XSS)} : 'Owner ' + i, ownerEmail: 'o' + i + '@example.test', userId: 'u' + i, treeId: p.treeId || 'tree_01', shareCount: 1, includesLand: i === 1, purchasePriceMinor: 3500, currency: 'USD', status: 'active', createdAt: Date.now() })); return { data: { total: all.length, limit: p.limit, offset: p.offset, rows: all.slice(p.offset, p.offset + p.limit) } }; },
  adminListOutbox: async () => ({ data: q.get('calm') ? { counts: {}, rows: [] } : { counts: { sent: 3, failed: 2, pending: 1 }, rows: [{ id: 7, template: 'payment_approved', status: 'failed', attempts: 5, recipient: 'i***@example.test', lastError: ${JSON.stringify(XSS)} + ' provider not configured', createdAt: Date.now(), sentAt: null }, { id: 6, template: 'onboarding_welcome', status: 'sent', attempts: 1, recipient: 'j***@example.test', lastError: null, createdAt: Date.now(), sentAt: Date.now() }] } }),
  adminRetryEmail: async (p) => { calls.push(['adminRetryEmail', p]); return { data: { requeued: 1 } }; },
  adminTasks: async () => { if (q.get('statusDown')) throw fail('permission-denied'); const all = [{ key: 'payment_accounts_missing', severity: 'critical', count: 1, oldestAt: null, tab: 'accounts' }, { key: 'payments_review', severity: 'high', count: 2, oldestAt: Date.now() - 3600000, tab: 'payments' }, { key: 'role_applications', severity: 'normal', count: 1, oldestAt: Date.now() - 86400000, tab: 'roles' }, { key: 'trees_sold_out', severity: 'info', count: 1, oldestAt: null, tab: 'trees' }]; return { data: q.get('calm') ? [] : role === 'finance_admin' ? all.filter((t) => ['payments_review', 'trees_sold_out'].includes(t.key)) : all }; },
  adminKpiHistory: async () => ({ data: Array.from({ length: q.get('calm') ? 1 : 9 }, (_, i) => ({ day: '2026-11-' + String(5 + i).padStart(2, '0'), users: 10 + i, confirmedUsers: 8 + i, owners: 3, approvedMinor: 100000 + i * 3500, soldShares: 5 - (i > 6 ? 1 : 0), totalShares: 12, openRequests: 1 })) }),
  adminSearch: async (p) => { calls.push(['adminSearch', p]); if (p.q === 'nichts') return { data: { users: [], requests: [], trees: [] } }; return { data: { users: [{ id: 'u2', name: ${JSON.stringify(XSS)}, email: 'inv@example.test' }], requests: [{ id: 'e'.repeat(64), treeId: 'tree_01', status: 'under_review', amountMinor: 3500, createdAt: Date.now() }], trees: [{ treeId: 'tree_01', name: 'Olive', status: 'listed' }] } }; },
  adminAutomationState: async () => ({ data: { rules: [{ key: 'review_reminder', enabled: !!window.__ruleOn, days: 2, updatedAt: Date.now(), lastRunAt: window.__ruleOn ? Date.now() : null, lastResult: window.__ruleOn ? { ok: true, done: ['role_applications'] } : null }, { key: 'sold_out_unlist', enabled: false, days: 14, updatedAt: Date.now(), lastRunAt: null, lastResult: null }],
    jobs: [{ name: 'faseela-expire-reservations', schedule: '*/10 * * * *', active: window.__jobOff !== true, lastStatus: 'succeeded', lastStart: Date.now(), lastDurationMs: 12, failures24h: 0 }, { name: 'faseela-send-push', schedule: '* * * * *', active: true, lastStatus: 'failed', lastStart: Date.now(), lastDurationMs: 900, failures24h: 3 }],
    log: window.__ruleOn ? [{ rule: 'review_reminder', subject: 'role_applications', at: Date.now() }] : [] } }),
  adminSetAutomationRule: async (p) => { calls.push(['adminSetAutomationRule', p]); window.__ruleOn = p.enabled; return { data: p }; },
  adminSetJobActive: async (p) => { calls.push(['adminSetJobActive', p]); window.__jobOff = !p.active; return { data: p }; },
  adminReadiness: async () => ({ data: { auto: ['payment_accounts', 'mail_delivered', 'two_admins', 'finance_admin', 'trees_listed', 'trees_have_farmer', 'trees_have_mill', 'jobs_healthy', 'no_client_errors'].map((key, i) => ({ key, ok: i > 3 })),
    manual: ['legal_opinion', 'legal_texts', 'sanctions_process', 'mail_domain', 'test_purchase', 'restore_test', 'store_accounts', 'support_contact'].map((key) => ({ key, done: key === 'test_purchase' && !!window.__ready, note: key === 'test_purchase' && window.__ready ? window.__ready : null, updatedAt: null })) } }),
  adminSetReadiness: async (p) => { calls.push(['adminSetReadiness', p]); window.__ready = p.done ? (p.note || 'x') : null; return { data: p }; },
  adminGetTreeMill: async () => ({ data: { treeId: 'tree_01', millId: '' } }),
  adminSetTreeMill: async (p) => { calls.push(['adminSetTreeMill', p]); return { data: p }; },
  adminGetTreeCrop: async () => ({ data: { treeId: 'tree_01', cropCategory: 'olive' } }),
  adminGetTreeOrigin: async () => ({ data: { treeId: 'tree_01', countryCode: 'SY', farmId: 'farm_01' } }),
  adminSetTreeOrigin: async (p) => { calls.push(['adminSetTreeOrigin', p]); return { data: p }; },
  adminListMasterData: async () => ({ data: {
    landOfferEnabled: q.get('land') !== 'off',
    currencies: [{ code: 'USD', minorUnits: 2 }, { code: 'EUR', minorUnits: 2 }],
    countries: [{ code: 'ES', name: 'إسبانيا', nameEn: 'Spain', nameDe: 'Spanien', currency: 'EUR', status: window.__esActive ? 'active' : 'planned', trees: 0 },
      { code: 'SY', name: 'سوريا', nameEn: 'Syria', nameDe: 'Syrien', currency: 'USD', status: 'active', trees: 3 }],
    farms: [{ farmId: 'farm_01', countryCode: 'SY', name: 'مزرعة', nameEn: ${JSON.stringify(XSS)} + ' Farm', region: '', regionEn: 'Tartus', status: 'listed', trees: 1 },
      { farmId: 'farm_es', countryCode: 'ES', name: 'مزرعة', nameEn: 'Finca Prueba', region: '', regionEn: 'Jaen', status: 'unlisted', trees: 0 }],
    mills: [{ millId: 'mill_01', countryCode: 'SY', name: 'معصرة', nameEn: 'Dreikish Mill', region: '', regionEn: '', status: 'listed', trees: 1 }]
  } }),
  adminSetCountryStatus: async (p) => { calls.push(['adminSetCountryStatus', p]); window.__esActive = p.status === 'active'; return { data: p }; },
  adminUpsertFarm: async (p) => { calls.push(['adminUpsertFarm', p]); if (p.farmId === 'farm_01') throw fail('failed-precondition'); return { data: p }; },
  adminUpsertMill: async (p) => { calls.push(['adminUpsertMill', p]); return { data: p }; },
  adminSetTreeCrop: async (p) => { calls.push(['adminSetTreeCrop', p]); return { data: p }; },
  adminListAuditLogs: async () => [{ id: 1, actorUid: 'a6380508-cca1', action: 'role.granted', target: 'user_roles/x', details: { note: ${JSON.stringify(XSS)} }, createdAt: Date.now() }]
};
// Second factor: ?mfa=enrolled|none makes every admin* call answer 'mfa-required' until a code was confirmed.
const mfa = { mode: q.get('mfa') || '', aal2: false, enrolled: q.get('mfa') === 'enrolled', required: !!q.get('mfa') };
Object.assign(window.FaseelaFirebase, {
  mfaStatus: async () => ({ currentLevel: mfa.aal2 ? 'aal2' : 'aal1', nextLevel: mfa.enrolled ? 'aal2' : 'aal1', factorId: mfa.enrolled ? 'factor-1' : null }),
  mfaEnroll: async () => { calls.push(['mfaEnroll']); return { factorId: 'factor-new', qr: 'data:image/svg+xml;utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'), secret: 'JBSWY3DPEHPK3PXP' }; },
  mfaVerify: async (factorId, code) => { calls.push(['mfaVerify', { factorId, code }]); if (code !== '123456') throw fail('mfa-invalid-code'); mfa.aal2 = true; mfa.enrolled = true; return { ok: true }; },
  staffSecurityState: async () => ({ data: { mfaRequired: mfa.required, sessionLevel: mfa.aal2 ? 'aal2' : 'aal1' } }),
  adminSetStaffMfa: async (p) => { calls.push(['adminSetStaffMfa', p]); if (p.required && !mfa.aal2) throw fail('failed-precondition'); mfa.required = p.required; return { data: { mfaRequired: p.required } }; }
});
if (mfa.mode) {
  for (const key of Object.keys(window.FaseelaFirebase)) {
    const original = window.FaseelaFirebase[key];
    if (/^admin/.test(key) && typeof original === 'function') window.FaseelaFirebase[key] = async (...args) => { if (mfa.required && !mfa.aal2) throw fail('mfa-required'); return original(...args); };
  }
}
function emit(r) { window.dispatchEvent(new CustomEvent('faseela-auth-state', { detail: r === 'none' ? null : { uid: 'u1', email: 'me@example.test', name: 'Me', role: r } })); }
setTimeout(() => emit(role), 150);
`;

const browser = await chromium.launch({ executablePath: process.env.CHR || undefined });
const failures = [];
async function open(query, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  await ctx.route('**/supabase-client.mjs', (r) => r.fulfill({ contentType: 'text/javascript', body: MOCK }));
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/\[faseela-admin\]/.test(m.text())) errs.push(m.text().slice(0, 200)); });
  await page.goto(base + query, { waitUntil: 'load' });
  return { ctx, page, errs };
}
const tab = async (page, label) => { await page.getByRole('tab', { name: label, exact: true }).click(); await page.waitForFunction(() => document.getElementById('view').getAttribute('aria-busy') === 'false'); };
const axe = async (page, where) => { const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze(); for (const v of r.violations) failures.push(`${where}: ${v.id} (${v.nodes.length}) ${v.nodes[0]?.html.slice(0, 90)}`); };
const calls = (page, name) => page.evaluate((n) => window.FaseelaBackend.calls.filter((c) => c[0] === n).map((c) => c[1]), name);

try {
  // ---- 1. signed out: login form, wrong password, forgot password, implicit-link notice
  {
    const { ctx, page, errs } = await open('?mockRole=none&implicit=1', { width: 390, height: 844 });
    await page.waitForSelector('#screen-login:not([hidden])');
    assert.match(await page.textContent('#login-info'), /nicht unterstützt/);
    await axe(page, 'login');
    await page.click('#login-submit');
    assert.match(await page.textContent('#login-error'), /E-Mail und Passwort/);
    await page.fill('#login-email', 'Me@Example.test'); await page.fill('#login-password', 'wrong'); await page.click('#login-submit');
    await page.waitForFunction(() => /stimmt nicht/.test(document.getElementById('login-error').textContent));
    await page.click('#login-forgot');
    await page.waitForFunction(() => !document.getElementById('login-info').hidden && /Zurücksetzen/.test(document.getElementById('login-info').textContent));
    assert.deepEqual(await calls(page, 'requestPasswordReset'), ['me@example.test']);
    await page.fill('#login-password', 'right'); await page.press('#login-password', 'Enter');
    await page.waitForSelector('#screen-panel:not([hidden])');
    assert.equal(await page.inputValue('#login-password'), 'right'); // cleared on sign-out below
    await page.click('#sign-out');
    await page.waitForSelector('#screen-login:not([hidden])');
    assert.equal(await page.inputValue('#login-password'), '', 'password field cleared after sign-out');
    assert.equal(await page.evaluate(() => document.getElementById('view').childElementCount), 0, 'no admin data left in the DOM after sign-out');
    assert.deepEqual(errs, []);
    await ctx.close();
  }
  // ---- 2. non-admin account is refused and signed out
  {
    const { ctx, page } = await open('?mockRole=investor');
    await page.waitForFunction(() => /keinen Zugriff/.test(document.getElementById('login-error').textContent));
    assert.equal((await calls(page, 'signOut')).length, 1);
    assert.equal(await page.isHidden('#screen-panel'), true);
    await ctx.close();
  }
  // ---- 3. finance admin sees only the finance areas
  {
    const { ctx, page } = await open('?mockRole=finance_admin');
    await page.waitForSelector('#screen-panel:not([hidden])');
    assert.deepEqual(await page.$$eval('#tablist .tab', (n) => n.map((b) => b.textContent)), ['Aufgaben', 'Zahlungen', 'Weitere Prüfungen', 'Patenschaften', 'Bäume', 'Besitzregister', 'Finanz-Export']);
    await page.waitForFunction(() => document.querySelectorAll('.task-list li').length === 2);
    assert.equal(await page.$$eval('#view input[type=search]', (n) => n.length), 0, 'the account search is for admins only');
    await ctx.close();
  }
  // ---- 4. admin: every view, both themes
  {
    const { ctx, page, errs } = await open('?mockRole=admin');
    await page.waitForSelector('#screen-panel:not([hidden])');
    await tab(page, 'Übersicht');
    await page.waitForFunction(() => document.querySelectorAll('.kpi').length === 8);
    assert.deepEqual(await page.$$eval('#tablist .tab', (n) => n.map((b) => b.textContent)), ['Aufgaben', 'Übersicht', 'Zahlungen', 'Weitere Prüfungen', 'Rollenanträge', 'Patenschaften', 'Bäume', 'Stammdaten', 'Besitzregister', 'Nutzer', 'Empfangskonten', 'Finanz-Export', 'E-Mails', 'Automationen', 'Fehler', 'Audit-Log', 'Einstellungen', 'Go-Live', 'System']);
    const overview = await page.evaluate(() => ({ text: document.getElementById('view').textContent, charts: document.querySelectorAll('.chart-svg').length, bars: document.querySelectorAll('.chart-bar').length, hints: [...document.querySelectorAll('.hints li')].map((li) => li.textContent.slice(0, 40)), peak: [...document.querySelectorAll('.chart-value')].map((n) => n.textContent) }));
    assert.equal(overview.charts, 3); assert.equal(overview.bars, 36, 'twelve months per chart');
    assert.match(overview.peak[0], /12\.345,00/, 'peak month is labelled directly');
    assert.match(overview.text, /kein KI-Modell/);
    assert.ok(overview.hints[0].startsWith('Dringend: Es sind keine Empfangskonten'), `most urgent hint first: ${overview.hints[0]}`);
    assert.ok(overview.hints.some((h) => /Nur noch 1 von 12/.test(h)) && overview.hints.some((h) => /nur einen Admin/.test(h)));
    await page.focus('.chart-bar'); assert.equal(await page.isVisible('.chart-tip'), true, 'keyboard focus shows the value');
    assert.equal(await page.$$eval('.chart details table tbody tr', (n) => n.length), 36, 'table view for every chart');
    await page.getByRole('button', { name: 'Konten eintragen' }).click();
    await page.waitForFunction(() => document.querySelector('.tab[aria-selected=true]').textContent === 'Empfangskonten');
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') await page.click('#theme-toggle');
      for (const label of ['Aufgaben', 'Übersicht', 'Zahlungen', 'Weitere Prüfungen', 'Rollenanträge', 'Patenschaften', 'Bäume', 'Stammdaten', 'Besitzregister', 'Nutzer', 'Empfangskonten', 'Finanz-Export', 'E-Mails', 'Automationen', 'Fehler', 'Audit-Log', 'Einstellungen', 'Go-Live', 'System']) { await tab(page, label); await page.waitForTimeout(150); await axe(page, `${theme}/${label}`); }
    }
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    // payments: text-only rendering, screening gate, proof link, approve after screening
    await tab(page, 'Zahlungen');
    assert.equal(await page.evaluate(() => window.__xss), undefined, 'server strings never execute');
    assert.equal(await page.$$eval('#view img', (n) => n.length), 0);
    assert.match(await page.textContent('#view h3'), /<img src=x/);
    await page.waitForFunction(() => /noch keine erfasst/.test(document.getElementById('view').textContent));
    const popup = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Beleg ansehen' }).click();
    assert.match((await popup).url(), /^https:\/\/riyvlhlhzxxerlwqoxsy\.supabase\.co\/storage\//);
    await page.getByRole('button', { name: 'Freigeben' }).click();
    await page.click('#dialog-ok');
    await page.waitForFunction(() => /fehlt eine aktuelle Sanktionsprüfung/.test(document.getElementById('dialog-error').textContent));
    assert.equal(await page.evaluate(() => document.getElementById('dialog').open), true, 'dialog stays open on a refused action');
    await page.click('#dialog-cancel');
    await page.getByRole('button', { name: 'Prüfung erfassen' }).click();
    await page.click('#dialog-ok');
    await page.waitForFunction(() => /welche Listen/.test(document.getElementById('dialog-error').textContent));
    await page.fill('#dialog-body input[type=text]', 'EU, UN');
    await page.click('#dialog-ok');
    await page.waitForFunction(() => /unauffällig · EU, UN/.test(document.getElementById('view').textContent));
    await page.getByRole('button', { name: 'Ablehnen' }).click();
    await page.click('#dialog-ok');
    await page.waitForFunction(() => /Begründung/.test(document.getElementById('dialog-error').textContent));
    await page.click('#dialog-cancel');
    await page.getByRole('button', { name: 'Freigeben' }).click();
    await page.click('#dialog-ok');
    await page.waitForFunction(() => /Keine offenen Zahlungen/.test(document.getElementById('view').textContent));
    assert.deepEqual((await calls(page, 'reviewInvestmentRequest')).map((c) => c.decision), ['approve', 'approve']);
    // further reviews: media only from the storage origin, certificate number required, partial failure isolated
    await tab(page, 'Weitere Prüfungen');
    assert.match(await page.textContent('#view'), /Feldberichte[\s\S]*<img src=x[\s\S]*Pressungen/);
    await page.getByRole('button', { name: '2 Foto(s) ansehen' }).click();
    await page.waitForSelector('#view a[target=_blank]');
    assert.deepEqual(await page.$$eval('#view a[target=_blank]', (n) => n.map((a) => a.href)), ['https://riyvlhlhzxxerlwqoxsy.supabase.co/storage/v1/object/sign/field-media/a.jpg?token=t']);
    assert.match(await page.textContent('#view'), /1 nicht ladbar/);
    await page.getByRole('button', { name: 'Zertifizieren' }).click();
    await page.click('#dialog-ok');
    await page.waitForFunction(() => /Laborzertifikats/.test(document.getElementById('dialog-error').textContent));
    await page.fill('#dialog-body input[type=text]', 'LAB-77'); await page.click('#dialog-ok');
    await page.waitForFunction(() => window.FaseelaBackend.calls.some((c) => c[0] === 'certifyPressingBatch'));
    assert.deepEqual((await calls(page, 'certifyPressingBatch'))[0], { batchId: 'pb1', decision: 'certify', certificateSerial: 'LAB-77', note: '' });
    await page.waitForFunction(() => document.getElementById('view').getAttribute('aria-busy') === 'false');
    await page.getByRole('button', { name: 'Veröffentlichen' }).click(); await page.click('#dialog-ok');
    await page.waitForFunction(() => window.FaseelaBackend.calls.some((c) => c[0] === 'reviewFarmerUpdate'));
    assert.equal((await calls(page, 'reviewFarmerUpdate'))[0].decision, 'publish');
    await page.waitForFunction(() => document.getElementById('view').getAttribute('aria-busy') === 'false');
    // investments: filter + paging are sent to the server, overdue badge, proof button only when a proof exists
    await tab(page, 'Patenschaften');
    assert.equal(await page.$$eval('#view tbody tr', (n) => n.length), 25);
    assert.match(await page.textContent('#view'), /1–25 von 30/);
    assert.equal(await page.$$eval('#view tbody button', (n) => n.length), 2);
    assert.match(await page.textContent('#view tbody tr:nth-child(2)'), /überfällig/);
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.waitForFunction(() => /26–30 von 30/.test(document.getElementById('view').textContent));
    assert.equal(await page.getByRole('button', { name: 'Weiter' }).isDisabled(), true);
    await page.selectOption('#view select', 'approved');
    await page.waitForFunction(() => /1–10 von 10/.test(document.getElementById('view').textContent));
    assert.deepEqual((await calls(page, 'adminListInvestments')).slice(-1)[0], { status: 'approved', limit: 25, offset: 0 });
    // trees: sold out and no farmer are flagged, hiding needs confirmation
    await tab(page, 'Bäume');
    assert.match(await page.textContent('#view tbody'), /<img src=x[\s\S]*4 \/ 4[\s\S]*sichtbar/);
    await page.getByRole('button', { name: 'Ausblenden' }).click();
    assert.match(await page.textContent('#dialog-body'), /Bestehende Anteile/);
    await page.click('#dialog-ok');
    await page.waitForFunction(() => /ausgeblendet/.test(document.getElementById('view').textContent));
    assert.deepEqual(await calls(page, 'adminSetTreeStatus'), [{ treeId: 'tree_01', status: 'unlisted' }]);
    // trees: edit sends only the change, server refusal keeps the dialog open, create validates before calling
    await tab(page, 'Bäume');
    await page.getByRole('button', { name: /bearbeiten$/ }).click();
    await page.waitForFunction(() => /Baum bearbeiten: tree_01/.test(document.getElementById('dialog-title').textContent));
    await axe(page, 'dark/tree-dialog');
    await page.click('#dialog-ok');
    assert.match(await page.textContent('#dialog-error'), /Region \(Arabisch\) fehlt/, 'empty catalogue text must be filled before saving');
    const dlg = (label) => page.locator('#dialog-body').getByLabel(label, { exact: true });
    assert.equal(await dlg('Kultur (nach dem ersten Verkauf nicht änderbar)').isDisabled(), true, 'crop is fixed once shares are sold');
    assert.equal(await dlg('Kultur (nach dem ersten Verkauf nicht änderbar)').inputValue(), 'olive');
    assert.equal(await dlg('Herkunftsland (nach dem ersten Verkauf nicht änderbar)').isDisabled(), true, 'country is fixed once shares are sold');
    assert.deepEqual(await dlg('Hof').locator('option').evaluateAll((o) => o.map((x) => x.value)), ['', 'farm_01'], 'only farms of the tree country are offered');
    assert.equal(await dlg('Hof').inputValue(), 'farm_01');
    await dlg('Region (Arabisch)').fill('حمص'); await dlg('Region (Englisch)').fill('Homs');
    await dlg('Anzahl Anteile').fill('3'); await page.click('#dialog-ok');
    await page.waitForFunction(() => /in diesem Zustand nicht möglich/.test(document.getElementById('dialog-error').textContent));
    assert.equal(await page.evaluate(() => document.getElementById('dialog').open), true, 'a refused save keeps the dialog open');
    await dlg('Ölmühle (Kennung, leer = keine)').fill('mill 2!'); await dlg('Anzahl Anteile').fill('6'); await dlg('Preis je Anteil (USD)').fill('40,50'); await page.click('#dialog-ok');
    assert.match(await page.textContent('#dialog-error'), /Ölmühle: Die Kennung/);
    await dlg('Ölmühle (Kennung, leer = keine)').fill('mill_02'); await page.click('#dialog-ok');
    await page.waitForFunction(() => !document.getElementById('dialog').open);
    assert.deepEqual(await calls(page, 'adminSetTreeMill'), [{ treeId: 'tree_01', millId: 'mill_02' }]);
    assert.deepEqual((await calls(page, 'adminUpdateTree')).slice(-1)[0], { region: 'حمص', regionEn: 'Homs', totalShares: 6, pricePerShareMinor: 4050, treeId: 'tree_01' }, 'only changed fields are sent, price in minor units');
    await page.waitForFunction(() => document.getElementById('view').getAttribute('aria-busy') === 'false');
    await page.getByRole('button', { name: 'Neuer Baum' }).click();
    await page.click('#dialog-ok');
    assert.match(await page.textContent('#dialog-error'), /fehlt/);
    assert.equal((await calls(page, 'adminCreateTree')).length, 0, 'nothing is sent while the form is incomplete');
    for (const [label, value] of [['Name (Arabisch)', 'شجرة'], ['Name (Englisch)', 'New tree'], ['Region (Arabisch)', 'إدلب'], ['Region (Englisch)', 'Idlib'], ['Sorte (Arabisch)', 'صوراني'], ['Sorte (Englisch)', 'Sorani'], ['Anzahl Anteile', '10'], ['Preis je Anteil (USD)', '35']]) await dlg(label).fill(value);
    await dlg('Bilder (ein Pfad je Zeile)').fill('https://evil.example/x.png'); await page.click('#dialog-ok');
    assert.match(await page.textContent('#dialog-error'), /Bilder: 1 bis 6 Pfade/);
    await dlg('Bilder (ein Pfad je Zeile)').fill('images/olive_branches_macro.webp');
    await page.locator('#dialog-body').getByLabel(/^Kennung/).fill('Tree 4'); await page.click('#dialog-ok');
    assert.match(await page.textContent('#dialog-error'), /Kennung: 3 bis 40/);
    await page.locator('#dialog-body').getByLabel(/^Kennung/).fill('tree_01'); await page.click('#dialog-ok');
    await page.waitForFunction(() => /existiert bereits/.test(document.getElementById('dialog-error').textContent));
    await page.locator('#dialog-body').getByLabel(/^Kennung/).fill('tree_04');
    await page.locator('#dialog-body').getByLabel('Mit Parzellen-Option').check();
    await page.click('#dialog-ok');
    assert.match(await page.textContent('#dialog-error'), /Preis der Parzelle fehlt/);
    assert.deepEqual(await dlg('Kultur').locator('option').evaluateAll((o) => o.map((x) => x.value)), ['olive', 'pistachio', 'almond', 'pomegranate', 'date', 'walnut']);
    await dlg('Kultur').selectOption('date');
    await dlg('Herkunftsland').selectOption('ES');
    assert.deepEqual(await dlg('Hof').locator('option').evaluateAll((o) => o.map((x) => x.value)), ['', 'farm_es'], 'farm list follows the chosen country');
    await dlg('Hof').selectOption('farm_es');
    await dlg('Preis der Parzelle (USD)').fill('15'); await dlg('Fläche der Parzelle (m²)').fill('25'); await page.click('#dialog-ok');
    await page.waitForFunction(() => !document.getElementById('dialog').open);
    assert.deepEqual(await calls(page, 'adminSetTreeCrop'), [{ treeId: 'tree_04', cropCategory: 'date' }], 'a new date tree gets its crop in a second step; refused or locked saves never set one');
    assert.deepEqual(await calls(page, 'adminSetTreeOrigin'), [{ treeId: 'tree_04', countryCode: 'ES', farmId: 'farm_es' }], 'origin is set once, for the new tree only');
    await page.waitForFunction(() => document.getElementById('view').getAttribute('aria-busy') === 'false');
    // master data: text-only rendering, country activation, farm validation and server refusal
    await tab(page, 'Stammdaten');
    await page.waitForFunction(() => /Finca Prueba/.test(document.getElementById('view').textContent));
    assert.equal(await page.evaluate(() => window.__xss === undefined && !document.querySelector('#view img, #view script')), true, 'farm names render as text');
    await axe(page, 'dark/master');
    await page.getByRole('button', { name: 'Spanien aktivieren' }).click();
    await page.click('#dialog-ok');
    await page.waitForFunction(() => !document.getElementById('dialog').open);
    assert.deepEqual(await calls(page, 'adminSetCountryStatus'), [{ code: 'ES', status: 'active' }]);
    await page.waitForFunction(() => !!document.querySelector('button[aria-label="Spanien zurückstellen"]'));
    await page.getByRole('button', { name: 'Neuer Hof' }).click();
    await page.click('#dialog-ok');
    assert.match(await page.textContent('#dialog-error'), /Kennung: 3 bis 40/);
    assert.equal((await calls(page, 'adminUpsertFarm')).length, 0, 'nothing is sent while the farm form is incomplete');
    await page.locator('#dialog-body').getByLabel(/^Kennung/).fill('farm_01');
    await dlg('Land').selectOption('ES'); await dlg('Name (Arabisch)').fill('مزرعة جديدة'); await dlg('Name (Englisch)').fill('<b>x</b>');
    await page.click('#dialog-ok');
    assert.match(await page.textContent('#dialog-error'), /Name \(Englisch\) fehlt oder enthält unzulässige Zeichen/);
    await dlg('Name (Englisch)').fill('New Farm'); await page.click('#dialog-ok');
    await page.waitForFunction(() => /in diesem Zustand nicht möglich/.test(document.getElementById('dialog-error').textContent));
    await page.locator('#dialog-body').getByLabel(/^Kennung/).fill('farm_new'); await page.locator('#dialog-body').getByLabel('Für Besucher sichtbar').check(); await page.click('#dialog-ok');
    await page.waitForFunction(() => !document.getElementById('dialog').open);
    assert.deepEqual((await calls(page, 'adminUpsertFarm')).slice(-1)[0], { farmId: 'farm_new', countryCode: 'ES', name: 'مزرعة جديدة', nameEn: 'New Farm', region: '', regionEn: '', status: 'listed' });
    await page.waitForFunction(() => document.getElementById('view').getAttribute('aria-busy') === 'false');
    await page.getByRole('button', { name: 'Neue Mühle' }).click();
    await page.locator('#dialog-body').getByLabel(/^Kennung/).fill('mill_new'); await dlg('Name (Arabisch)').fill('معصرة'); await dlg('Name (Englisch)').fill('New Mill'); await page.click('#dialog-ok');
    await page.waitForFunction(() => !document.getElementById('dialog').open);
    assert.deepEqual(await calls(page, 'adminUpsertMill'), [{ millId: 'mill_new', countryCode: 'SY', name: 'معصرة', nameEn: 'New Mill', region: '', regionEn: '', status: 'unlisted' }]);
    assert.deepEqual((await calls(page, 'adminCreateTree')).slice(-1)[0], { name: 'شجرة', nameEn: 'New tree', region: 'إدلب', regionEn: 'Idlib', treeType: 'صوراني', treeTypeEn: 'Sorani', totalShares: 10, pricePerShareMinor: 3500, images: ['images/olive_branches_macro.webp'], landPriceMinor: 1500, landAreaSqm: 25, treeId: 'tree_04', hasLandOption: true });
    await page.waitForFunction(() => document.getElementById('view').getAttribute('aria-busy') === 'false');
    // ownership register: paging, tree filter, text-only
    await tab(page, 'Besitzregister');
    assert.match(await page.textContent('#view'), /1–50 von 60/);
    assert.match(await page.textContent('#view tbody tr'), /<img src=x/);
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.waitForFunction(() => /51–60 von 60/.test(document.getElementById('view').textContent));
    await page.fill('#view input[type=search]', 'bad id!'); await page.getByRole('button', { name: 'Filtern' }).click();
    await page.waitForFunction(() => !document.getElementById('toast').hidden);
    await page.fill('#view input[type=search]', 'tree_03'); await page.press('#view input[type=search]', 'Enter');
    await page.waitForFunction(() => /keine Anteile vergeben/.test(document.getElementById('view').textContent));
    assert.deepEqual((await calls(page, 'adminListShares')).slice(-1)[0], { treeId: 'tree_03', limit: 50, offset: 0 });
    // e-mail queue: counts, masked recipients, retry needs confirmation
    await tab(page, 'E-Mails');
    assert.match(await page.textContent('#view'), /3gesendet[\s\S]*2fehlgeschlagen/);
    assert.match(await page.textContent('#view tbody'), /i\*\*\*@example\.test[\s\S]*<img src=x/);
    assert.equal(await page.$$eval('#view tbody button', (n) => n.length), 1, 'only failed mails can be retried');
    await page.getByRole('button', { name: 'E-Mail 7 erneut einreihen' }).click();
    assert.match(await page.textContent('#dialog-body'), /Solange kein E-Mail-Anbieter/);
    await page.click('#dialog-cancel');
    assert.equal((await calls(page, 'adminRetryEmail')).length, 0);
    await page.getByRole('button', { name: 'Alle fehlgeschlagenen erneut einreihen' }).click(); await page.click('#dialog-ok');
    await page.waitForFunction(() => window.FaseelaBackend.calls.some((c) => c[0] === 'adminRetryEmail'));
    assert.deepEqual(await calls(page, 'adminRetryEmail'), [{ all: true }]);
    await page.waitForFunction(() => document.getElementById('view').getAttribute('aria-busy') === 'false');
    // task inbox: most urgent first, opens the right area, search renders text only
    await tab(page, 'Aufgaben');
    const taskTexts = await page.$$eval('.task-list li', (n) => n.map((li) => li.textContent.replace(/\s+/g, ' ').slice(0, 60)));
    assert.equal(taskTexts.length, 4); assert.match(taskTexts[0], /^DringendEs sind keine Empfangskonten/); assert.match(taskTexts[1], /^Wichtig2 Zahlung\(en\) warten/);
    await page.getByRole('button', { name: 'Suchen' }).click();
    assert.match(await page.textContent('#view [role=status]'), /mindestens 2 Zeichen/);
    await page.fill('#view input[type=search]', 'nichts'); await page.press('#view input[type=search]', 'Enter');
    await page.waitForFunction(() => /Kein Treffer/.test(document.querySelector('#view [role=status]').textContent));
    await page.fill('#view input[type=search]', 'inv@'); await page.getByRole('button', { name: 'Suchen' }).click();
    await page.waitForFunction(() => /Konten[\s\S]*Bäume[\s\S]*Anfragen/.test(document.querySelector('#view [role=status]').textContent));
    assert.match(await page.textContent('#view [role=status]'), /<img src=x/);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    await axe(page, 'dark/tasks-search');
    await page.getByRole('button', { name: /Zahlung\(en\) warten auf Prüfung öffnen/ }).click();
    await page.waitForFunction(() => document.querySelector('.tab[aria-selected=true]').textContent === 'Zahlungen');
    await page.waitForFunction(() => document.getElementById('view').getAttribute('aria-busy') === 'false');
    // overview trend against the snapshot of a week ago
    await tab(page, 'Übersicht');
    assert.match(await page.textContent('#view'), /Vor 7 Tagen[\s\S]*Konten1811\+7[\s\S]*Besitzer33unverändert[\s\S]*Verkaufte Anteile45−1/);
    // automations: rule needs valid days and a confirmation; pausing a critical job warns
    await tab(page, 'Automationen');
    assert.match(await page.textContent('#view'), /kein KI-Modell[\s\S]*Noch nicht gelaufen[\s\S]*Push-Versand[\s\S]*Fehler[\s\S]*Noch keine automatische Aktion/);
    await page.locator('#view').getByLabel('Tage bis zur Erinnerung').fill('0');
    await page.getByRole('button', { name: 'Erinnerung an liegengebliebene Prüfungen: einschalten' }).click();
    await page.waitForFunction(() => !document.getElementById('toast').hidden);
    assert.equal(await page.evaluate(() => document.getElementById('dialog').open), false);
    await page.locator('#view').getByLabel('Tage bis zur Erinnerung').fill('3');
    await page.getByRole('button', { name: 'Erinnerung an liegengebliebene Prüfungen: einschalten' }).click();
    assert.match(await page.textContent('#dialog-body'), /Solange kein E-Mail-Anbieter/);
    await page.click('#dialog-ok');
    await page.waitForFunction(() => /1 Aktion\(en\)/.test(document.getElementById('view').textContent));
    assert.deepEqual(await calls(page, 'adminSetAutomationRule'), [{ key: 'review_reminder', enabled: true, days: 3 }]);
    await page.getByRole('button', { name: 'Abgelaufene Reservierungen freigeben pausieren' }).click();
    assert.match(await page.textContent('#dialog-body'), /Achtung: Ohne diesen Job bleiben unbezahlte Reservierungen/);
    await page.click('#dialog-ok');
    await page.waitForFunction(() => /pausiert/.test(document.getElementById('view').textContent));
    assert.deepEqual(await calls(page, 'adminSetJobActive'), [{ name: 'faseela-expire-reservations', active: false }]);
    // go-live checklist: system items link to their area, manual items need a confirmation
    await tab(page, 'Go-Live');
    assert.match(await page.textContent('#view'), /5 von 17 Punkten erfüllt/);
    assert.equal(await page.getByRole('button', { name: /: beheben$/ }).count(), 4);
    await page.getByRole('button', { name: /^Testkauf.*: bestätigen$/ }).click();
    await page.locator('#dialog-body textarea').fill('  bestanden am 13.11.  ');
    await page.click('#dialog-ok');
    await page.waitForFunction(() => /6 von 17 Punkten erfüllt/.test(document.getElementById('view').textContent));
    assert.deepEqual(await calls(page, 'adminSetReadiness'), [{ key: 'test_purchase', done: true, note: 'bestanden am 13.11.' }]);
    // errors + settings
    await tab(page, 'Fehler');
    assert.match(await page.textContent('#view tbody'), /TypeError: <img src=x/);
    await tab(page, 'Einstellungen');
    assert.match(await page.textContent('#view'), /ausgeschaltet · 3 aktive Geräte/);
    await page.getByRole('button', { name: 'Push einschalten' }).click();
    assert.match(await page.textContent('#dialog-body'), /FCM_SERVICE_ACCOUNT/);
    await page.click('#dialog-ok');
    await page.waitForFunction(() => /Push ausschalten/.test(document.getElementById('view').textContent));
    assert.deepEqual(await calls(page, 'adminSetPushEnabled'), [{ enabled: true }]);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    // users: own row locked, role change needs confirmation, cancel restores the select
    await tab(page, 'Nutzer');
    const rows = await page.$$eval('#view tbody tr', (trs) => trs.map((tr) => ({ name: tr.cells[0].textContent, selectDisabled: tr.querySelector('select').disabled, role: tr.querySelector('select').value, buttonDisabled: tr.querySelector('button').disabled, button: tr.querySelector('button').textContent })));
    assert.deepEqual(rows[0], { name: 'Me Admin (Sie)', selectDisabled: true, role: 'admin', buttonDisabled: true, button: 'Sperren' });
    assert.equal(rows[2].role, 'mill_operator'); assert.equal(rows[2].button, 'Entsperren');
    await page.selectOption('#view tbody tr:nth-child(2) select', 'admin');
    assert.match(await page.textContent('#dialog-body'), /vollen Zugriff/);
    await page.click('#dialog-cancel');
    assert.equal(await page.$eval('#view tbody tr:nth-child(2) select', (s) => s.value), 'investor', 'cancel restores the role');
    assert.equal((await calls(page, 'adminSetUserRole')).length, 0);
    await page.selectOption('#view tbody tr:nth-child(2) select', 'finance_admin');
    await page.click('#dialog-ok');
    await page.waitForFunction(() => window.FaseelaBackend.calls.some((c) => c[0] === 'adminSetUserRole'));
    assert.deepEqual(await calls(page, 'adminSetUserRole'), [{ userId: 'u2', role: 'finance_admin' }]);
    await page.waitForFunction(() => document.getElementById('view').getAttribute('aria-busy') === 'false');
    // user record: text-only, assignments add/remove with inline status, refusal shown in place
    await page.getByRole('button', { name: /^Details zu <img/ }).click();
    await page.waitForFunction(() => document.getElementById('dialog').open);
    assert.match(await page.textContent('#dialog-title'), /<img src=x/);
    assert.match(await page.textContent('#dialog-body'), /inv@example\.test[\s\S]*Anteile \(1\)[\s\S]*Betreute Bäume[\s\S]*tree_02/);
    assert.doesNotMatch(await page.textContent('#dialog-body'), /Ölmühlen/, 'only the assignment kind that fits the role');
    await axe(page, 'dark/user-dialog');
    const assign = page.locator('#dialog-body').getByLabel('Betreute Bäume: Kennung');
    await assign.fill('bad id'); await page.locator('#dialog-body').getByRole('button', { name: 'Zuweisen' }).click();
    assert.match(await page.textContent('#dialog-body [role=status]'), /nur Buchstaben/);
    await assign.fill('tree_99'); await page.locator('#dialog-body').getByRole('button', { name: 'Zuweisen' }).click();
    await page.waitForFunction(() => /nicht gefunden/.test(document.querySelector('#dialog-body [role=status]').textContent));
    await assign.fill('tree_03'); await page.locator('#dialog-body').getByRole('button', { name: 'Zuweisen' }).click();
    await page.waitForFunction(() => /Zuweisung gespeichert/.test(document.querySelector('#dialog-body [role=status]').textContent));
    assert.match(await page.textContent('#dialog-body'), /tree_02[\s\S]*tree_03/);
    await page.locator('#dialog-body').getByRole('button', { name: 'tree_02 entfernen' }).click();
    await page.waitForFunction(() => /Zuweisung entfernt/.test(document.querySelector('#dialog-body [role=status]').textContent));
    assert.deepEqual((await calls(page, 'adminAssign')).slice(-2), [{ userId: 'u2', kind: 'farmer_tree', action: 'add', targetId: 'tree_03' }, { userId: 'u2', kind: 'farmer_tree', action: 'remove', targetId: 'tree_02' }]);
    await page.click('#dialog-ok');
    await page.waitForFunction(() => !document.getElementById('dialog').open);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    await page.fill('#view input[type=search]', 'mill@');
    assert.equal(await page.$$eval('#view tbody tr', (n) => n.length), 1);
    // accounts: invalid form refused, valid form confirmed
    await tab(page, 'Empfangskonten');
    assert.match(await page.textContent('#view'), /Nur ein Admin vorhanden/);
    await page.fill('#view fieldset:nth-of-type(1) input.mono', 'x');
    await page.getByRole('button', { name: 'Speichern' }).click();
    assert.equal(await page.isVisible('#view .alert-error'), true);
    assert.equal(await page.evaluate(() => document.getElementById('dialog').open), false);
    await page.fill('#view fieldset:nth-of-type(1) input.mono', '0999 555 123');
    await page.getByRole('button', { name: 'Speichern' }).click();
    assert.match(await page.textContent('#dialog-body'), /0999 555 123/);
    await page.click('#dialog-ok');
    await page.waitForFunction(() => window.FaseelaBackend.calls.some((c) => c[0] === 'adminSetPaymentInstructions'));
    assert.equal((await calls(page, 'adminSetPaymentInstructions'))[0].channels[0].account, '0999 555 123');
    // export: CSV with formula-injection guard
    await tab(page, 'Finanz-Export');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'CSV herunterladen' }).click();
    const file = await (await download).path();
    const csv = fs.readFileSync(file, 'utf8');
    assert.ok(csv.includes(`"'=HYPERLINK(""http://x"",""y"")"`), 'formula cells are neutralised');
    assert.ok(csv.startsWith('﻿requestId,'));
    await page.waitForFunction(() => /1 Zeilen exportiert/.test(document.getElementById('view').textContent));
    // audit: details as text
    await tab(page, 'Audit-Log');
    assert.match(await page.textContent('#view tbody'), /role\.granted[\s\S]*<img src=x/);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.deepEqual(errs, []);
    await ctx.close();
  }
  // ---- 5. four-eyes in the UI, error state with retry, foreign proof URL refused
  {
    const { ctx, page } = await open('?mockRole=admin&pending=self&evilProof=1');
    await page.waitForSelector('#screen-panel:not([hidden])');
    await tab(page, 'Empfangskonten');
    assert.match(await page.textContent('#view'), /Vier-Augen-Prinzip aktiv \(2 Admins\)/);
    assert.equal(await page.getByRole('button', { name: 'Bestätigen', exact: true }).isDisabled(), true, 'own proposal cannot be confirmed');
    await page.getByRole('button', { name: 'Zurückziehen' }).click();
    await page.click('#dialog-ok');
    await page.waitForFunction(() => window.FaseelaBackend.calls.some((c) => c[0] === 'adminReviewPaymentInstructions'));
    assert.deepEqual(await calls(page, 'adminReviewPaymentInstructions'), [{ decision: 'reject' }]);
    await tab(page, 'Zahlungen');
    let popups = 0; page.on('popup', () => { popups += 1; });
    await page.getByRole('button', { name: 'Beleg ansehen' }).click();
    await page.waitForFunction(() => !document.getElementById('toast').hidden);
    assert.equal(popups, 0, 'a proof URL outside the storage origin is never opened');
    await ctx.close();
    const other = await open('?mockRole=admin&pending=other');
    await other.page.waitForSelector('#screen-panel:not([hidden])');
    await tab(other.page, 'Empfangskonten');
    assert.equal(await other.page.getByRole('button', { name: 'Bestätigen', exact: true }).isDisabled(), false, 'another admin may confirm');
    await other.ctx.close();
    const calm = await open('?mockRole=admin&calm=1&oilDown=1');
    await calm.page.waitForSelector('#screen-panel:not([hidden])');
    assert.match(await calm.page.textContent('#view'), /Nichts offen/, 'empty task inbox says so');
    await tab(calm.page, 'Übersicht');
    assert.match(await calm.page.textContent('#view'), /seit heute jeden Tag gesichert/, 'no trend is invented from a single snapshot');
    await calm.page.waitForFunction(() => document.querySelectorAll('.kpi').length === 8);
    assert.deepEqual(await calm.page.$$eval('.hints li', (n) => n.map((li) => li.textContent.slice(0, 30))), ['Hinweis: 1 Reservierung(en) la', 'Hinweis: 2 Konto/Konten haben ', 'Hinweis: Push-Benachrichtigung'], 'only informational hints when everything is in order');
    await tab(calm.page, 'Fehler');
    assert.match(await calm.page.textContent('#view'), /Keine Fehler gemeldet/);
    await tab(calm.page, 'Weitere Prüfungen');
    assert.match(await calm.page.textContent('#view'), /Ölanfragen[\s\S]*fehlt diesem Konto die Berechtigung/, 'one failing queue does not hide the others');
    assert.match(await calm.page.textContent('#view'), /Feldberichte/);
    await calm.ctx.close();
    const down = await open('?mockRole=admin&statusDown=1');
    await down.page.waitForSelector('#screen-panel:not([hidden])');
    await down.page.waitForFunction(() => /fehlt diesem Konto die Berechtigung/.test(document.getElementById('view').textContent));
    assert.equal(await down.page.getByRole('button', { name: 'Erneut laden' }).isVisible(), true);
    await down.ctx.close();

    // second factor: an enrolled account confirms a code and lands in the panel
    const stepUp = await open('?mockRole=admin&mfa=enrolled');
    await stepUp.page.waitForSelector('#screen-panel:not([hidden])');
    await stepUp.page.waitForFunction(() => /zweiter Faktor vorgeschrieben/.test(document.getElementById('view').textContent));
    await axe(stepUp.page, 'dark/mfa-prompt');
    const code = (page) => page.locator('#view').getByLabel('Sechsstelliger Code');
    await code(stepUp.page).fill('12'); await stepUp.page.getByRole('button', { name: 'Code bestätigen' }).click();
    assert.match(await stepUp.page.textContent('#view'), /sechsstelligen Code aus der App/);
    assert.equal((await calls(stepUp.page, 'mfaVerify')).length, 0, 'an incomplete code is not sent');
    await code(stepUp.page).fill('000000'); await stepUp.page.getByRole('button', { name: 'Code bestätigen' }).click();
    await stepUp.page.waitForFunction(() => /Der Code wurde nicht akzeptiert/.test(document.getElementById('view').textContent));
    await code(stepUp.page).fill('123456'); await stepUp.page.getByRole('button', { name: 'Code bestätigen' }).click();
    await stepUp.page.waitForFunction(() => document.querySelectorAll('.task-list li').length > 0 || /Nichts offen/.test(document.getElementById('view').textContent));
    assert.deepEqual(await calls(stepUp.page, 'mfaVerify'), [{ factorId: 'factor-1', code: '000000' }, { factorId: 'factor-1', code: '123456' }]);
    // …and can lift the team requirement again from the settings
    await tab(stepUp.page, 'Einstellungen');
    await stepUp.page.waitForFunction(() => /Diese Sitzung ist mit der Authenticator-App bestätigt/.test(document.getElementById('view').textContent));
    await stepUp.page.getByRole('button', { name: 'Pflicht aufheben' }).click(); await stepUp.page.click('#dialog-ok');
    await stepUp.page.waitForFunction(() => !document.getElementById('dialog').open);
    assert.deepEqual(await calls(stepUp.page, 'adminSetStaffMfa'), [{ required: false }]);
    await stepUp.ctx.close();

    // second factor: an account without an authenticator is led through the set-up
    const enrol = await open('?mockRole=finance_admin&mfa=none');
    await enrol.page.waitForSelector('#screen-panel:not([hidden])');
    await enrol.page.waitForFunction(() => /noch keiner eingerichtet/.test(document.getElementById('view').textContent));
    await enrol.page.getByRole('button', { name: 'Authenticator einrichten' }).click();
    await enrol.page.waitForSelector('#view img.qr');
    assert.match(await enrol.page.textContent('#view'), /JBSWY3DPEHPK3PXP/, 'the key is shown for manual entry');
    assert.equal(await enrol.page.$eval('#view img.qr', (img) => img.src.startsWith('data:image/svg+xml') && img.alt.length > 0), true);
    await axe(enrol.page, 'dark/mfa-enrol');
    await code(enrol.page).fill('123456'); await enrol.page.getByRole('button', { name: 'Code bestätigen' }).click();
    await enrol.page.waitForFunction(() => document.querySelectorAll('.task-list li').length > 0 || /Nichts offen/.test(document.getElementById('view').textContent));
    assert.deepEqual(await calls(enrol.page, 'mfaVerify'), [{ factorId: 'factor-new', code: '123456' }]);
    await enrol.ctx.close();

    // land offer off: a new tree cannot be given a parcel option
    const noLand = await open('?mockRole=admin&land=off');
    await noLand.page.waitForSelector('#screen-panel:not([hidden])');
    await tab(noLand.page, 'Bäume');
    await noLand.page.getByRole('button', { name: 'Neuer Baum' }).click();
    await noLand.page.waitForFunction(() => /Neuer Baum/.test(document.getElementById('dialog-title').textContent));
    assert.equal(await noLand.page.locator('#dialog-body').getByLabel('Mit Parzellen-Option').count(), 0, 'no parcel option while the land offer is off');
    assert.equal(await noLand.page.locator('#dialog-body').getByLabel('Herkunftsland', { exact: true }).count(), 1);
    await noLand.ctx.close();

    // settings without a requirement: the switch refuses an admin whose own session has no second factor
    const plain = await open('?mockRole=admin');
    await plain.page.waitForSelector('#screen-panel:not([hidden])');
    await tab(plain.page, 'Einstellungen');
    await plain.page.waitForFunction(() => /Noch nicht eingerichtet/.test(document.getElementById('view').textContent));
    await plain.page.getByRole('button', { name: 'Für alle Team-Konten verlangen' }).click(); await plain.page.click('#dialog-ok');
    await plain.page.waitForFunction(() => /in diesem Zustand nicht möglich/.test(document.getElementById('dialog-error').textContent));
    assert.deepEqual(await calls(plain.page, 'adminSetStaffMfa'), [{ required: true }]);
    await plain.ctx.close();
  }
  assert.deepEqual(failures, [], `axe violations:\n${failures.join('\n')}`);
  console.log(JSON.stringify({ ok: true, suite: 'admin' }));
} finally {
  await browser.close();
  server.kill();
}
