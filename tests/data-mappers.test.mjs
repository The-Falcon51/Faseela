// Unit tests for public/data-mappers.mjs (run: node --test tests/)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toMillis, normalizeDoc, minorToMajor, statusLabel, mapPublicTree, mapCountry, mapFarm, mapShare,
  mapTransaction, mapInvestment, portfolioTotals, mapReviewItem, investmentTimeline, REVIEW_SLA_MS,
  HARVEST_MILL_ID, quantityUnit, quantityUnitLabel, milliToMajor, formatQuantity, isHarvestBatch, mapPressingBatch,
  mapOilRequest, mapOilAllocation, allocationTotals, parseWeightKg, validateHarvestInput
} from '../public/data-mappers.mjs';

const ts = (ms) => ({ toMillis: () => ms });

test('toMillis handles Firestore Timestamp, {seconds}, Date, number, ISO, garbage', () => {
  assert.equal(toMillis(ts(1700000000000)), 1700000000000);
  assert.equal(toMillis({ seconds: 1700000000, nanoseconds: 5e6 }), 1700000000005);
  assert.equal(toMillis(new Date(42)), 42);
  assert.equal(toMillis(7), 7);
  assert.equal(toMillis('2026-01-02T00:00:00Z'), Date.parse('2026-01-02T00:00:00Z'));
  assert.equal(toMillis('not a date'), null);
  assert.equal(toMillis(undefined), null);
  assert.equal(toMillis(NaN), null);
});

test('normalizeDoc converts nested timestamps and keeps other values', () => {
  const out = normalizeDoc({ a: ts(5), list: [ts(6), 'x'], nested: { b: { seconds: 1, nanoseconds: 0 } }, n: 3 });
  assert.deepEqual(out, { a: 5, list: [6, 'x'], nested: { b: 1000 }, n: 3 });
});

test('minorToMajor rejects non-integers instead of producing NaN', () => {
  assert.equal(minorToMajor(4550), 45.5);
  assert.equal(minorToMajor(undefined), 0);
  assert.equal(minorToMajor(1.5), 0);
});

test('mapPublicTree uses minor-unit server prices (regression: pricePerShareCents was never set)', () => {
  const t = mapPublicTree({ id: 'tree_01', status: 'listed', pricePerShareMinor: 3500, landPriceMinor: 1500, availableShares: 3, totalShares: 4, hasLandOption: true });
  const { catalog, ...core } = t;
  assert.deepEqual(core, { id: 'tree_01', server_listed: true, total_shares: 4, shares_available: 3, price_per_share: 35, land_price: 15, has_land_option: true, currency: 'USD', country_code: 'SY', farm_id: null });
});

test('mapPublicTree carries catalogue texts from the server and strips markup', () => {
  const t = mapPublicTree({ treeId: 'tree_99', status: 'listed', name: 'شجرة', nameEn: '<img src=x onerror=1>New tree', regionEn: 'Idlib', cropCategory: 'unknown', plantedYear: 1990, estimatedAnnualYieldKg: '40', images: ['images/a.webp', 'https://evil.example/x.png', 'images/../b.webp'] });
  assert.equal(t.catalog.tree_name_en, 'img src=x onerror=1New tree');
  assert.equal(t.catalog.tree_name, 'شجرة');
  assert.equal(t.catalog.crop_category, 'olive');
  assert.equal(t.catalog.planted_year, 1990);
  assert.equal(t.catalog.estimated_annual_yield_kg, 40);
  assert.deepEqual(t.catalog.images, ['images/a.webp']);
});

test('mapShare maps server fields and survives Timestamp createdAt (regression: RangeError)', () => {
  const s = mapShare({ id: 'abcdef0123456789', userId: 'u1', treeId: 'tree_01', shareCount: 2, purchasePriceMinor: 7000, includesLand: false, createdAt: ts(Date.parse('2026-10-01T10:00:00Z')) });
  assert.equal(s.purchase_price, 70);
  assert.equal(s.shares_count, 2);
  assert.equal(s.percentage, 50);
  assert.equal(s.purchase_date, '2026-10-01');
  assert.equal(s.land_deed_serial, 'FSL-2026-ABCDEF0123456789');
  assert.equal(s.source, 'server');
});

test('mapTransaction and mapInvestment translate statuses', () => {
  const tx = mapTransaction({ id: 't1', userId: 'u1', amountMinor: 3500, status: 'under_review', createdAt: ts(0) });
  assert.equal(tx.amount, 35);
  assert.equal(tx.status_en, 'Under finance review');
  const inv = mapInvestment({ id: 'r1', treeId: 'tree_01', shareCount: 1, amountMinor: 3500, status: 'awaiting_payment', expiresAt: ts(99) });
  assert.equal(inv.canCancel, true);
  assert.equal(inv.expiresAt, 99);
  assert.equal(mapInvestment({ status: 'under_review' }).canCancel, false);
  assert.equal(statusLabel('unknown_status'), 'unknown_status');
});

test('portfolioTotals counts shares, not records (regression: 7.4 L per record)', () => {
  const totals = portfolioTotals([
    { shares_count: 4, purchase_price: 155, includes_land: true },
    { shares_count: 1, purchase_price: 35, includes_land: false }
  ]);
  assert.equal(totals.totalShares, 5);
  assert.equal(totals.treesEquivalent, 1.25);
  assert.equal(totals.invested, 190);
  assert.equal(Math.round(totals.expectedOilLiters * 10) / 10, 37);
  assert.equal(totals.landSqm, 5);
  assert.deepEqual(portfolioTotals(null), { invested: 0, totalShares: 0, treesEquivalent: 0, expectedOilLiters: 0, landSqm: 0 });
});

test('mapReviewItem routes each queue to its review action', () => {
  const pay = mapReviewItem('payments', { id: 'r1', userId: 'u1', amountMinor: 7000, treeId: 'tree_01', shareCount: 2, proofSubmittedAt: 0, submitter: { displayName: 'Ali' } });
  assert.equal(pay.serverQueue, 'payments');
  assert.equal(pay.isServerInvestment, true);
  assert.equal(pay.amount_usd, 70);
  assert.equal(pay.user_name, 'Ali');
  // Reviewers must see the full content that publishing exposes (audit run-1 F2): no truncation, media and GPS carried.
  const fu = mapReviewItem('farmer_updates', { id: 'f1', farmerUid: 'u2', eventType: 'pruning', notes: 'x'.repeat(400), mediaPaths: ['u2/tree_01/a.jpg', 7], gpsLat: 34.8, gpsLng: 36.1, treeId: 'tree_01' });
  assert.equal(fu.notes.length, 400);
  assert.equal(fu.user_id, 'u2');
  assert.deepEqual(fu.mediaPaths, ['u2/tree_01/a.jpg']);
  assert.equal(fu.gpsLat, 34.8);
  assert.equal(fu.treeId, 'tree_01');
  assert.equal(mapReviewItem('farmer_updates', { id: 'f2', farmerUid: 'u2', eventType: 'other' }).gpsLat, null);
  assert.equal(mapReviewItem('pressing_batches', { id: 'b1', submittedByUid: 'u3' }).type, 'pressing_batch');
  assert.equal(mapReviewItem('role_applications', { id: 'u4', userId: 'u4', requestedRole: 'farmer' }).channel, 'farmer');
  const oil = mapReviewItem('oil_requests', { id: 'o1', userId: 'u5', kind: 'delivery', litersMl: 2500, contact: { name: 'Ab Cd', phone: '+49 1', addressLine1: 'Musterweg 1', city: 'Berlin', country: 'DE' } });
  assert.equal(oil.type, 'oil_request');
  assert.equal(oil.user_id, 'u5');
  assert.equal(oil.channel, 'delivery');
  assert.match(oil.notes, /^2\.5 L • Ab Cd • \+49 1 • Musterweg 1, Berlin, DE$/);
  assert.equal(mapReviewItem('oil_fulfilment', { id: 'o2', userId: 'u6', kind: 'donate', litersMl: 1000 }).notes, '1 L');
});

test('mapReviewItem shows a weighed harvest in kilograms and keeps mill pressings unchanged', () => {
  const harvest = mapReviewItem('pressing_batches', { id: 'h1', submittedByUid: 'u7', treeId: 'tree_12', millId: 'farm', olivesWeightKg: 120.5, oilYieldLiters: 96, acidityPct: 0, submitter: { displayName: 'Sami' } });
  assert.equal(harvest.type, 'pressing_batch'); // same review action as a pressing
  assert.equal(harvest.serverQueue, 'pressing_batches');
  assert.equal(harvest.isHarvest, true);
  assert.equal(harvest.role, 'farmer');
  assert.equal(harvest.channel, HARVEST_MILL_ID);
  assert.equal(harvest.unit, 'kg');
  assert.equal(harvest.harvestKg, 120.5);
  assert.equal(harvest.netKg, 96);
  assert.equal(harvest.type_label_en, 'Weighed harvest');
  assert.equal(harvest.type_label_de, 'Gewogene Ernte');
  assert.equal(harvest.type_label, 'حصاد موزون');
  assert.equal(harvest.notes, 'tree_12 • Harvest 120.5 kg gross → 96 kg net');
  assert.equal(harvest.notes_de, 'tree_12 • Ernte 120.5 kg brutto → 96 kg netto');
  assert.match(harvest.notes_ar, /120\.5 كغ/);
  assert.doesNotMatch(harvest.notes, / L|%/); // no litres, no acidity on a harvest row
  assert.equal(mapReviewItem('pressing_batches', { id: 'h2', millId: 'farm' }).notes, ' • Harvest ? kg gross → ? kg net');
  assert.equal(mapReviewItem('pressing_batches', { id: 'h2', millId: 'farm' }).harvestKg, null);

  const pressing = mapReviewItem('pressing_batches', { id: 'b2', submittedByUid: 'u3', treeId: 'tree_01', millId: 'mill_01', olivesWeightKg: 100, oilYieldLiters: 18, acidityPct: 0.4 });
  assert.equal(pressing.isHarvest, false);
  assert.equal(pressing.role, 'mill_owner');
  assert.equal(pressing.type_label_en, 'Pressing batch');
  assert.equal(pressing.notes, 'tree_01 • 100 kg → 18 L • 0.4%');
});

test('mapReviewItem carries the unit of an oil or harvest request', () => {
  const kg = mapReviewItem('oil_requests', { id: 'o3', userId: 'u8', kind: 'pickup', litersMl: 12500, unit: 'kg', contact: { name: 'Ab Cd' } });
  assert.equal(kg.type, 'oil_request');
  assert.equal(kg.unit, 'kg');
  assert.equal(kg.quantity, 12.5);
  assert.equal(kg.litersMl, 12500);
  assert.equal(kg.notes, '12.5 kg • Ab Cd');
  assert.equal(kg.type_label_en, 'Harvest request');
  assert.equal(kg.type_label_de, 'Ernteanfrage');
  assert.equal(mapReviewItem('oil_fulfilment', { id: 'o4', kind: 'donate', litersMl: 1234, unit: 'kg' }).notes, '1.23 kg');
  assert.equal(mapReviewItem('oil_fulfilment', { id: 'o4', kind: 'donate', litersMl: 1234, unit: 'kg' }).type_label_en, 'Harvest fulfilment');
  const oil = mapReviewItem('oil_requests', { id: 'o5', kind: 'donate', litersMl: 2500, unit: 'l' });
  assert.equal(oil.unit, 'l');
  assert.equal(oil.type_label_en, 'Oil request');
  assert.equal(oil.type_label_de, 'Ölanfrage');
  assert.equal(oil.notes, '2.5 L');
  // Rows from before the unit column, or with an unexpected value, are olive oil.
  assert.equal(mapReviewItem('oil_requests', { id: 'o6', litersMl: 1000, unit: 'lb' }).unit, 'l');
});

test('quantities: millilitres and grams are converted, labelled and never mixed', () => {
  assert.equal(quantityUnit('kg'), 'kg');
  assert.equal(quantityUnit(undefined), 'l');
  assert.equal(quantityUnitLabel('kg', 'ar'), 'كغ');
  assert.equal(quantityUnitLabel('l', 'de'), 'L');
  assert.equal(quantityUnitLabel('l', 'xx'), 'L');
  assert.equal(milliToMajor(2500), 2.5);
  assert.equal(milliToMajor('abc'), 0);
  assert.equal(milliToMajor(-5), 0);
  assert.equal(formatQuantity(2500, 'l'), '2.5 L');
  assert.equal(formatQuantity(10000, 'kg'), '10 kg');
  assert.equal(formatQuantity(1999, 'kg'), '2 kg');
  assert.equal(formatQuantity(5, 'kg'), '0.005 kg'); // a few grams are not shown as zero
  assert.equal(formatQuantity(0, 'kg'), '0 kg');
  assert.equal(formatQuantity(null, 'l', 'ar'), '0 لتر');

  assert.deepEqual(mapOilRequest({ id: 'r1', litersMl: 750, unit: 'kg', createdAt: ts(5) }), { id: 'r1', litersMl: 750, unit: 'kg', createdAt: 5, quantity: 0.75 });
  assert.equal(mapOilRequest({ id: 'r2', litersMl: 750 }).unit, 'l');
  assert.equal(mapOilRequest(null).quantity, 0);

  const crops = new Map([['tree_01', 'olive'], ['tree_12', 'pistachio']]);
  const olive = mapOilAllocation({ id: 'a1', treeId: 'tree_01', litersMl: 3700, status: 'available' }, crops);
  const nuts = mapOilAllocation({ id: 'a2', treeId: 'tree_12', litersMl: 4200, status: 'available' }, crops);
  const unknown = mapOilAllocation({ id: 'a3', treeId: 'tree_99', litersMl: 900, status: 'available' }, crops);
  assert.deepEqual([olive.unit, olive.quantity], ['l', 3.7]);
  assert.deepEqual([nuts.unit, nuts.quantity], ['kg', 4.2]);
  assert.deepEqual([unknown.unit, unknown.quantity], [null, null]);
  assert.equal(mapOilAllocation({ id: 'a4', treeId: 'tree_12', litersMl: 1000 }, { tree_12: 'almond' }).unit, 'kg');
  assert.equal(mapOilAllocation({ id: 'a5', treeId: 'tree_12', litersMl: 1000 }).unit, null);
  assert.equal(mapOilAllocation({ id: 'a6', treeId: 'toString', litersMl: 1000 }, {}).unit, null);
  // The server unit wins and needs no catalogue entry (sold-out / unlisted tree).
  assert.deepEqual((({ unit, quantity }) => [unit, quantity])(mapOilAllocation({ id: 'a7', treeId: 'tree_77', litersMl: 6000, unit: 'kg' })), ['kg', 6]);
  assert.equal(mapOilAllocation({ id: 'a8', treeId: 'tree_12', litersMl: 1000, unit: 'l' }, crops).unit, 'l');
  assert.equal(mapOilAllocation({ id: 'a9', treeId: 'tree_12', litersMl: 1000, unit: 'gallon' }, crops).unit, 'kg');
  assert.deepEqual(allocationTotals([olive, nuts, unknown, null]), { l: 3700, kg: 4200, unknown: 900 });
  assert.deepEqual(allocationTotals(undefined), { l: 0, kg: 0, unknown: 0 });
});

test('pressing batch rows: a farm row is a weighed harvest', () => {
  assert.equal(isHarvestBatch({ millId: 'farm' }), true);
  assert.equal(isHarvestBatch({ millId: 'mill_01' }), false);
  assert.equal(isHarvestBatch(null), false);
  const harvest = mapPressingBatch({ id: 'h1', treeId: 'tree_12', millId: 'farm', olivesWeightKg: 120.5, oilYieldLiters: 96.1234, status: 'pending_review', createdAt: ts(9) });
  assert.equal(harvest.isHarvest, true);
  assert.equal(harvest.harvestKg, 120.5);
  assert.equal(harvest.netKg, 96.123);
  assert.equal(harvest.createdAt, 9);
  assert.equal(harvest.status, 'pending_review');
  const pressing = mapPressingBatch({ id: 'b1', millId: 'mill_01', olivesWeightKg: 100, oilYieldLiters: 18 });
  assert.equal(pressing.isHarvest, false);
  assert.equal(pressing.oilYieldLiters, 18);
  assert.equal('harvestKg' in pressing, false);
});

test('harvest form input is checked before the round trip', () => {
  assert.equal(parseWeightKg('12,5'), 12.5);
  assert.equal(parseWeightKg(' 12.345 '), 12.345);
  assert.equal(parseWeightKg('١٢٫٥'), 12.5);
  assert.equal(parseWeightKg('۱۲'), 12);
  assert.equal(parseWeightKg(7.00049), 7);
  assert.equal(parseWeightKg(''), null);
  assert.equal(parseWeightKg('1e3'), null);
  assert.equal(parseWeightKg('-4'), null);
  assert.equal(parseWeightKg('12.3456'), null);
  assert.equal(parseWeightKg(NaN), null);
  assert.equal(parseWeightKg(undefined), null);

  assert.deepEqual(validateHarvestInput({ treeId: ' tree_12 ', harvestKg: '120,5', netKg: '96' }), { ok: true, payload: { treeId: 'tree_12', harvestKg: 120.5, netKg: 96 } });
  assert.deepEqual(validateHarvestInput({ treeId: 'tree_12', harvestKg: 5000, netKg: 0 }), { ok: true, payload: { treeId: 'tree_12', harvestKg: 5000, netKg: 0 } });
  assert.deepEqual(validateHarvestInput({ treeId: '', harvestKg: 10, netKg: 5 }), { ok: false, error: 'tree' });
  assert.deepEqual(validateHarvestInput({ treeId: 'tree 12', harvestKg: 10, netKg: 5 }), { ok: false, error: 'tree' });
  assert.deepEqual(validateHarvestInput({ treeId: 'tree_12', harvestKg: '0.05', netKg: 0 }), { ok: false, error: 'gross' });
  assert.deepEqual(validateHarvestInput({ treeId: 'tree_12', harvestKg: 5000.5, netKg: 5 }), { ok: false, error: 'gross' });
  assert.deepEqual(validateHarvestInput({ treeId: 'tree_12', harvestKg: 10, netKg: '' }), { ok: false, error: 'net' });
  assert.deepEqual(validateHarvestInput({ treeId: 'tree_12', harvestKg: 10, netKg: 10.5 }), { ok: false, error: 'net_exceeds_gross' });
  assert.deepEqual(validateHarvestInput(null), { ok: false, error: 'tree' });
});

test('mapDirectoryUser maps admin directory rows to the legacy users shape', async () => {
  const { mapDirectoryUser } = await import('../public/data-mappers.mjs');
  const u = mapDirectoryUser({ uid: 'u9', email: 'mill@x.test', role: 'mill_operator', emailVerified: false, disabled: true, createdAt: 0 });
  assert.equal(u.role, 'mill_owner');
  assert.equal(u.status, 'suspended');
  assert.equal(u.verified, false);
  assert.equal(u.name, 'mill');
});

test('investmentTimeline: steps, SLA due date, overdue flag and outcomes', () => {
  const t0 = Date.UTC(2026, 10, 10, 12, 0, 0);
  const awaiting = investmentTimeline(mapInvestment({ id: 'a', status: 'awaiting_payment', createdAt: t0, expiresAt: t0 + 1800000 }), t0 + 1000);
  assert.deepEqual(awaiting.steps.map((s) => s.state), ['done', 'current', 'todo', 'todo']);
  assert.equal(awaiting.steps[1].dueAt, t0 + 1800000);
  assert.equal(awaiting.outcome, 'open');

  const review = investmentTimeline(mapInvestment({ id: 'b', status: 'under_review', createdAt: t0, proofSubmittedAt: t0 + 60000 }), t0 + 3600000);
  assert.deepEqual(review.steps.map((s) => s.state), ['done', 'done', 'current', 'todo']);
  assert.equal(review.steps[2].dueAt, t0 + 60000 + REVIEW_SLA_MS);
  assert.equal(review.overdue, false);
  assert.equal(investmentTimeline(mapInvestment({ status: 'under_review', proofSubmittedAt: t0 }), t0 + REVIEW_SLA_MS + 1).overdue, true, 'past the SLA');
  assert.equal(investmentTimeline(mapInvestment({ status: 'under_review', proofSubmittedAt: t0, slaBreached: true }), t0 + 1).overdue, true, 'server flag wins');

  const approved = investmentTimeline(mapInvestment({ status: 'approved', proofSubmittedAt: t0, reviewedAt: t0 + 5 }), t0 + 10);
  assert.deepEqual(approved.steps.map((s) => s.state), ['done', 'done', 'done', 'done']);
  assert.equal(approved.outcome, 'approved');
  const rejected = investmentTimeline(mapInvestment({ status: 'rejected', proofSubmittedAt: t0, reviewedAt: t0 + 5 }), t0 + 10);
  assert.deepEqual(rejected.steps.map((s) => s.state), ['done', 'done', 'done', 'failed']);
  const expired = investmentTimeline(mapInvestment({ status: 'expired', createdAt: t0 }), t0 + 10);
  assert.deepEqual(expired.steps.map((s) => s.state), ['done', 'failed', 'todo', 'failed']);
  assert.equal(expired.outcome, 'expired');
  assert.doesNotThrow(() => investmentTimeline(null));
});

test('origin: country and farm of a tree are validated, with Syria as the fallback', () => {
  const es = mapPublicTree({ id: 'tree_es', status: 'listed', pricePerShareMinor: 4000, countryCode: 'ES', farmId: 'farm_es' });
  assert.equal(es.country_code, 'ES');
  assert.equal(es.farm_id, 'farm_es');
  const legacy = mapPublicTree({ id: 'tree_01', status: 'listed', pricePerShareMinor: 3500 });
  assert.equal(legacy.country_code, 'SY', 'rows from a project without migration 48 default to Syria');
  assert.equal(legacy.farm_id, null);
  const bad = mapPublicTree({ id: 'tree_x', countryCode: 'spain', farmId: 'farm <1>' });
  assert.equal(bad.country_code, 'SY');
  assert.equal(bad.farm_id, null);
});

test('mapCountry and mapFarm drop unusable rows and strip markup from names', () => {
  assert.deepEqual(mapCountry({ code: 'ES', name: 'إسبانيا', nameEn: 'Spain', nameDe: 'Spanien', currency: 'EUR' }),
    { code: 'ES', name: 'إسبانيا', name_en: 'Spain', name_de: 'Spanien', currency: 'EUR' });
  assert.equal(mapCountry({ code: 'es', nameEn: 'Spain' }), null);
  assert.equal(mapCountry({ code: 'ES', nameEn: 'Spain', currency: 'euro' }).currency, 'USD');
  const farm = mapFarm({ farmId: 'farm_es', countryCode: 'ES', name: 'مزرعة', nameEn: '<img src=x onerror=1>Finca', region: '', regionEn: 'Jaen' });
  assert.equal(farm.id, 'farm_es');
  assert.equal(/[<>]/.test(farm.name_en), false);
  assert.equal(mapFarm({ farmId: 'farm es', countryCode: 'ES' }), null);
  assert.equal(mapFarm({ farmId: 'farm_es', countryCode: 'Spain' }), null);
});
