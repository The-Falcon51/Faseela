const ALLOWED_FARMER_EVENTS = new Set([
  'watering',
  'pruning',
  'fertilizing',
  'pest_control',
  'harvest',
  'other'
]);

class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function validateReservationInput(input) {
  if (!input || typeof input !== 'object') {
    throw new DomainError('invalid-argument', 'Reservation data is required.');
  }

  const { treeId, shareCount, includesLand = false, idempotencyKey } = input;
  if (typeof treeId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(treeId)) {
    throw new DomainError('invalid-argument', 'A valid tree ID is required.');
  }
  if (!Number.isSafeInteger(shareCount) || shareCount < 1 || shareCount > 1000) {
    throw new DomainError('invalid-argument', 'Share count must be between 1 and 1000.');
  }
  if (typeof includesLand !== 'boolean') {
    throw new DomainError('invalid-argument', 'includesLand must be a boolean.');
  }
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 16 || idempotencyKey.length > 120) {
    throw new DomainError('invalid-argument', 'A valid idempotency key is required.');
  }

  return { treeId, shareCount, includesLand, idempotencyKey };
}

function calculateReservationAmount(tree, reservation) {
  const totalShares = tree.totalShares;
  const pricePerShareMinor = tree.pricePerShareMinor;
  const landPriceMinor = tree.landPriceMinor === undefined ? 0 : tree.landPriceMinor;

  if (!Number.isSafeInteger(totalShares) || totalShares < 1
    || !Number.isSafeInteger(pricePerShareMinor) || pricePerShareMinor < 1
    || !Number.isSafeInteger(landPriceMinor) || landPriceMinor < 0
    || !Number.isSafeInteger(reservation.shareCount) || reservation.shareCount < 1
    || typeof reservation.includesLand !== 'boolean') {
    throw new DomainError('failed-precondition', 'Tree pricing data is invalid.');
  }
  if (reservation.shareCount > totalShares) {
    throw new DomainError('invalid-argument', 'Requested shares exceed the tree total.');
  }
  if (reservation.includesLand && reservation.shareCount !== totalShares) {
    throw new DomainError('failed-precondition', 'Land can currently be reserved only with a complete tree.');
  }

  const amountMinor = reservation.shareCount * pricePerShareMinor
    + (reservation.includesLand ? landPriceMinor : 0);
  if (!Number.isSafeInteger(amountMinor)) {
    throw new DomainError('failed-precondition', 'Reservation amount exceeds the supported range.');
  }
  return amountMinor;
}

function nextInvestmentStatus(currentStatus, decision) {
  if (currentStatus !== 'under_review') {
    throw new DomainError('failed-precondition', 'Only reviewed payment requests can be decided.');
  }
  if (decision === 'approve') return 'approved';
  if (decision === 'reject') return 'rejected';
  throw new DomainError('invalid-argument', 'Decision must be approve or reject.');
}

function validateFarmerUpdate(input) {
  if (!input || typeof input !== 'object'
    || typeof input.treeId !== 'string'
    || !/^[A-Za-z0-9_-]{1,80}$/.test(input.treeId)
    || !ALLOWED_FARMER_EVENTS.has(input.eventType)
    || typeof input.notes !== 'string'
    || input.notes.length > 1200
    || !Array.isArray(input.mediaPaths)
    || input.mediaPaths.length > 5
    || input.mediaPaths.some((path) => typeof path !== 'string' || path.length > 300)) {
    throw new DomainError('invalid-argument', 'Farmer update data is invalid.');
  }

  const gpsLat = input.gpsLat;
  const gpsLng = input.gpsLng;
  if ((gpsLat !== undefined && (!Number.isFinite(gpsLat) || gpsLat < -90 || gpsLat > 90))
    || (gpsLng !== undefined && (!Number.isFinite(gpsLng) || gpsLng < -180 || gpsLng > 180))) {
    throw new DomainError('invalid-argument', 'GPS coordinates are invalid.');
  }

  return {
    treeId: input.treeId,
    eventType: input.eventType,
    notes: input.notes,
    mediaPaths: input.mediaPaths,
    ...(gpsLat === undefined ? {} : { gpsLat }),
    ...(gpsLng === undefined ? {} : { gpsLng })
  };
}

function validateRoleApplication(input) {
  if (!input || typeof input !== 'object'
    || !['farmer', 'mill_operator'].includes(input.requestedRole)
    || typeof input.region !== 'string'
    || input.region.trim().length < 2
    || input.region.length > 120
    || (input.organizationName !== undefined
      && (typeof input.organizationName !== 'string' || input.organizationName.length > 160))
    || (input.message !== undefined
      && (typeof input.message !== 'string' || input.message.length > 1000))) {
    throw new DomainError('invalid-argument', 'Role application data is invalid.');
  }

  return {
    requestedRole: input.requestedRole,
    region: input.region.trim(),
    organizationName: (input.organizationName || '').trim(),
    message: (input.message || '').trim()
  };
}

function validatePressingBatch(input) {
  const fields = ['olivesWeightKg', 'oilYieldLiters', 'temperatureCelsius', 'acidityPct', 'peroxideValue'];
  if (!input || typeof input !== 'object'
    || typeof input.treeId !== 'string'
    || !/^[A-Za-z0-9_-]{1,80}$/.test(input.treeId)
    || typeof input.millId !== 'string'
    || !/^[A-Za-z0-9_-]{1,80}$/.test(input.millId)
    || fields.some((field) => !Number.isFinite(input[field]))) {
    throw new DomainError('invalid-argument', 'Pressing batch data is invalid.');
  }
  if (input.olivesWeightKg <= 0 || input.oilYieldLiters < 0
    || input.temperatureCelsius < 0 || input.temperatureCelsius > 40
    || input.acidityPct < 0 || input.acidityPct > 100
    || input.peroxideValue < 0 || input.peroxideValue > 100) {
    throw new DomainError('invalid-argument', 'Pressing batch values are outside allowed bounds.');
  }

  return Object.fromEntries([
    'treeId', 'millId', 'olivesWeightKg', 'oilYieldLiters',
    'temperatureCelsius', 'acidityPct', 'peroxideValue'
  ].map((key) => [key, input[key]]));
}

module.exports = {
  DomainError,
  calculateReservationAmount,
  nextInvestmentStatus,
  validateFarmerUpdate,
  validatePressingBatch,
  validateRoleApplication,
  validateReservationInput
};