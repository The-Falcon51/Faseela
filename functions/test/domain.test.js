const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateReservationAmount,
  nextInvestmentStatus,
  validateFarmerUpdate,
  validatePressingBatch,
  validateRoleApplication,
  validateReservationInput
} = require('../domain');

test('reservation input requires bounded quantity and an idempotency key', () => {
  assert.deepEqual(validateReservationInput({
    treeId: 'tree_01',
    shareCount: 4,
    idempotencyKey: 'client-request-key-123'
  }), {
    treeId: 'tree_01',
    shareCount: 4,
    includesLand: false,
    idempotencyKey: 'client-request-key-123'
  });
  assert.throws(() => validateReservationInput({
    treeId: 'tree_01',
    shareCount: 0,
    idempotencyKey: 'client-request-key-123'
  }), { code: 'invalid-argument' });
});

test('reservation totals use integer minor units and land requires a whole tree', () => {
  const tree = { totalShares: 4, pricePerShareMinor: 3800, landPriceMinor: 1500 };
  assert.equal(calculateReservationAmount(tree, { shareCount: 1, includesLand: false }), 3800);
  assert.equal(calculateReservationAmount(tree, { shareCount: 4, includesLand: true }), 16700);
  assert.throws(() => calculateReservationAmount(tree, { shareCount: 1, includesLand: true }), {
    code: 'failed-precondition'
  });
});

test('investment review allows only pending review decisions', () => {
  assert.equal(nextInvestmentStatus('under_review', 'approve'), 'approved');
  assert.equal(nextInvestmentStatus('under_review', 'reject'), 'rejected');
  assert.throws(() => nextInvestmentStatus('approved', 'reject'), { code: 'failed-precondition' });
});

test('farmer updates enforce bounded media and valid GPS values', () => {
  assert.equal(validateFarmerUpdate({
    treeId: 'tree_01',
    eventType: 'watering',
    notes: 'Irrigated the tree',
    mediaPaths: ['field-media/farmer-1/tree_01/photo.jpg'],
    gpsLat: 35.9,
    gpsLng: 36.7
  }).eventType, 'watering');
  assert.throws(() => validateFarmerUpdate({
    treeId: 'tree_01',
    eventType: 'watering',
    notes: '',
    mediaPaths: [],
    gpsLat: 95
  }), { code: 'invalid-argument' });
});

test('role applications accept only non-privileged operator roles', () => {
  assert.equal(validateRoleApplication({
    requestedRole: 'farmer',
    region: 'Tartous',
    organizationName: 'Partner Farm'
  }).requestedRole, 'farmer');
  assert.throws(() => validateRoleApplication({
    requestedRole: 'admin',
    region: 'Tartous'
  }), { code: 'invalid-argument' });
});

test('pressing batches reject implausible measurements', () => {
  assert.equal(validatePressingBatch({
    treeId: 'tree_01',
    millId: 'mill_01',
    olivesWeightKg: 100,
    oilYieldLiters: 18,
    temperatureCelsius: 24,
    acidityPct: 0.3,
    peroxideValue: 6
  }).olivesWeightKg, 100);
  assert.throws(() => validatePressingBatch({
    treeId: 'tree_01',
    millId: 'mill_01',
    olivesWeightKg: -1,
    oilYieldLiters: 18,
    temperatureCelsius: 24,
    acidityPct: 0.3,
    peroxideValue: 6
  }), { code: 'invalid-argument' });
});