const { createHash } = require('node:crypto');

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

/**
 * Reservation quota policy (review finding F-03: inventory hoarding).
 *
 * Every open request (awaiting payment or under finance review) holds real
 * inventory. Without a per-user ceiling a single account can lock every tree by
 * repeating requests with fresh idempotency keys.
 *
 * @param {Array<{treeId: string, shareCount: number}>} openRequests the caller's open requests
 * @param {{treeId: string, shareCount: number}} reservation the new request
 * @param {{maxOpenRequests: number, maxOpenShares: number}} limits
 */
const DEFAULT_RESERVATION_LIMITS = Object.freeze({ maxOpenRequests: 3, maxOpenShares: 8 });

function assertReservationQuota(openRequests, reservation, limits = DEFAULT_RESERVATION_LIMITS) {
  if (!Array.isArray(openRequests)) {
    throw new DomainError('internal', 'Open reservations could not be evaluated.');
  }
  if (openRequests.some((open) => open.treeId === reservation.treeId)) {
    throw new DomainError('already-exists', 'You already have an open request for this tree. Complete or cancel it first.');
  }
  if (openRequests.length >= limits.maxOpenRequests) {
    throw new DomainError('resource-exhausted', 'Too many open investment requests. Complete or cancel one first.');
  }
  const openShares = openRequests.reduce((sum, open) => sum + (Number.isSafeInteger(open.shareCount) ? open.shareCount : 0), 0);
  if (openShares + reservation.shareCount > limits.maxOpenShares) {
    throw new DomainError('resource-exhausted', 'This request exceeds the number of shares you can reserve at once.');
  }
}

/**
 * Separation of duties (review finding F-04): nobody may decide on a record
 * they submitted themselves, regardless of role.
 */
function assertNotSelfReview(reviewerUid, ownerUid) {
  if (typeof reviewerUid !== 'string' || typeof ownerUid !== 'string' || reviewerUid === ownerUid) {
    throw new DomainError('permission-denied', 'Reviewers cannot decide on their own submissions.');
  }
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

function validateReviewNote(note) {
  if (note === undefined || note === null) return '';
  if (typeof note !== 'string' || note.length > 500) {
    throw new DomainError('invalid-argument', 'Review note must be a string of at most 500 characters.');
  }
  return note.trim();
}

/** Deterministic request id: the same user + idempotency key always maps to one request. */
function requestIdFor(uid, idempotencyKey) {
  return createHash('sha256').update(`${uid}:${idempotencyKey}`).digest('hex');
}

/** A payment proof must live under the caller's own folder for that request. */
function isValidProofPath(path, uid, requestId) {
  return typeof path === 'string'
    && path.startsWith(`payment-proofs/${uid}/${requestId}/`)
    && /^[A-Za-z0-9._/-]{1,240}$/.test(path)
    && !path.includes('..');
}

const OPEN_REQUEST_STATUSES = Object.freeze(['awaiting_payment', 'under_review']);
const DELETION_CONFIRMATION = 'DELETE';
const REVIEW_SLA_MS = 72 * 60 * 60 * 1000;

/**
 * Account deletion guard (DSGVO Art. 17). Deletion is refused while the account still
 * holds open requests or active shares, because those are live contractual positions
 * that need to be settled or transferred first (fail-closed, nothing is half-deleted).
 */
function assertAccountDeletable({ confirmation, openRequests, activeShares }) {
  if (confirmation !== DELETION_CONFIRMATION) {
    throw new DomainError('invalid-argument', `Type ${DELETION_CONFIRMATION} to confirm account deletion.`);
  }
  if (openRequests > 0) {
    throw new DomainError('failed-precondition', 'Cancel or complete your open investment requests before deleting the account.');
  }
  if (activeShares > 0) {
    throw new DomainError('failed-precondition', 'Your account still holds active shares. Please contact support to settle or transfer them first.');
  }
}

/** True when a request has waited longer than the finance review SLA. */
function isReviewOverdue(proofSubmittedAtMs, nowMs, slaMs = REVIEW_SLA_MS) {
  return Number.isFinite(proofSubmittedAtMs) && nowMs - proofSubmittedAtMs > slaMs;
}

/** Document id of an upload grant in the (default) database, read by storage.rules. */
function uploadGrantId(uid, kind, targetId) {
  if (typeof uid !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(uid)
    || !['payment', 'tree'].includes(kind)
    || typeof targetId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(targetId)) {
    throw new DomainError('invalid-argument', 'Upload grant reference is invalid.');
  }
  return `${uid}__${kind}__${targetId}`;
}

const SHARES_PER_TREE = 4;
const SHARE_PERCENT = 100 / SHARES_PER_TREE;

function toMinorUnits(amount) {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new DomainError('invalid-argument', 'Monetary amounts must be non-negative numbers.');
  }
  return Math.round(amount * 100);
}

/**
 * Converts a legacy seed/demo tree (percentage-based availability, decimal USD prices)
 * into the canonical server record (`trees`) and the curated public listing (`trees_public`).
 * The public listing intentionally omits farmer contact data and exact parcel corners.
 */
function buildTreeRecords(seedTree) {
  if (!seedTree || typeof seedTree.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(seedTree.id)) {
    throw new DomainError('invalid-argument', 'Seed tree requires a valid id.');
  }
  const availablePct = Number.isFinite(seedTree.total_shares_available) ? seedTree.total_shares_available : 100;
  const availableShares = Math.max(0, Math.min(SHARES_PER_TREE, Math.floor(availablePct / SHARE_PERCENT)));
  const pricePerShareMinor = toMinorUnits(seedTree.price_per_share);
  if (pricePerShareMinor < 1) {
    throw new DomainError('invalid-argument', `Seed tree ${seedTree.id} requires a positive price.`);
  }
  const hasLand = seedTree.land_parcel?.has_land_option === true;
  const landPriceMinor = hasLand ? toMinorUnits(seedTree.land_parcel.land_addon_price_usd || 0) : 0;

  const tree = {
    treeId: seedTree.id,
    farmId: seedTree.farm_id || null,
    millId: seedTree.mill_id || null,
    totalShares: SHARES_PER_TREE,
    soldShares: SHARES_PER_TREE - availableShares,
    reservedShares: 0,
    pricePerShareMinor,
    landPriceMinor,
    currency: 'USD',
    landParcel: hasLand ? seedTree.land_parcel : null,
    gps: Number.isFinite(seedTree.gps_lat) && Number.isFinite(seedTree.gps_lng)
      ? { lat: seedTree.gps_lat, lng: seedTree.gps_lng }
      : null
  };

  const publicTree = {
    treeId: seedTree.id,
    status: 'listed',
    cropCategory: seedTree.crop_category || 'olive',
    name: seedTree.tree_name || '',
    nameEn: seedTree.tree_name_en || seedTree.tree_name || '',
    region: seedTree.region || seedTree.region_detail || '',
    regionEn: seedTree.region_en || seedTree.region || '',
    treeType: seedTree.tree_type || '',
    treeTypeEn: seedTree.tree_type_en || seedTree.tree_type || '',
    plantedYear: Number.isSafeInteger(seedTree.planted_year) ? seedTree.planted_year : null,
    estimatedAnnualYieldKg: Number.isFinite(seedTree.estimated_annual_yield_kg) ? seedTree.estimated_annual_yield_kg : null,
    carbonOffsetKgYear: Number.isFinite(seedTree.carbon_offset_kg_year) ? seedTree.carbon_offset_kg_year : null,
    images: Array.isArray(seedTree.images) ? seedTree.images.filter((path) => typeof path === 'string').slice(0, 6) : [],
    totalShares: SHARES_PER_TREE,
    availableShares,
    pricePerShareMinor,
    landPriceMinor,
    hasLandOption: hasLand,
    landAreaSqm: hasLand ? (seedTree.land_parcel.land_area_sqm || 5) : 0,
    currency: 'USD'
  };

  return { tree, publicTree };
}

module.exports = {
  uploadGrantId,
  DELETION_CONFIRMATION,
  OPEN_REQUEST_STATUSES,
  REVIEW_SLA_MS,
  assertAccountDeletable,
  isReviewOverdue,
  isValidProofPath,
  requestIdFor,
  DEFAULT_RESERVATION_LIMITS,
  DomainError,
  assertNotSelfReview,
  assertReservationQuota,
  SHARES_PER_TREE,
  buildTreeRecords,
  calculateReservationAmount,
  nextInvestmentStatus,
  validateFarmerUpdate,
  validatePressingBatch,
  validateReviewNote,
  validateRoleApplication,
  validateReservationInput
};