// Pure mapping layer between Firestore/Callable payloads and the legacy UI state shapes.
// No Firebase imports: unit-tested with `node --test tests/` and shared by firebase-client.mjs.
// Money stays in minor units on the server; conversion to major units happens only here.

const SHARES_PER_TREE = 4;
const OIL_LITERS_PER_SHARE = 7.4; // non-binding estimate shown in the UI (see risk notice)
const LAND_SQM_PER_TREE = 5;

export const STATUS_LABELS = Object.freeze({
  awaiting_payment: { ar: 'بانتظار الدفع', en: 'Awaiting payment' },
  under_review: { ar: 'قيد المراجعة المالية', en: 'Under finance review' },
  approved: { ar: 'معتمد', en: 'Approved' },
  rejected: { ar: 'مرفوض', en: 'Rejected' },
  cancelled: { ar: 'ملغى', en: 'Cancelled' },
  expired: { ar: 'منتهي الصلاحية', en: 'Expired' },
  pending: { ar: 'قيد الانتظار', en: 'Pending' },
  settled: { ar: 'مُسوّى', en: 'Settled' },
  active: { ar: 'فعّال', en: 'Active' },
  pending_review: { ar: 'بانتظار التدقيق', en: 'Pending review' },
  published: { ar: 'منشور', en: 'Published' },
  certified: { ar: 'معتمد مخبرياً', en: 'Certified' }
});

/** Firestore Timestamp | {seconds,nanoseconds} | Date | number | ISO string -> epoch ms (or null). */
export function toMillis(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value === 'object' && Number.isFinite(value.seconds)) {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Recursively converts timestamp-like values so documents are JSON- and Date-safe. */
export function normalizeDoc(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(normalizeDoc);
  if (typeof value === 'object') {
    if (typeof value.toMillis === 'function' || value instanceof Date) return toMillis(value);
    if (Number.isFinite(value.seconds) && Number.isFinite(value.nanoseconds) && Object.keys(value).length === 2) {
      return toMillis(value);
    }
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, normalizeDoc(inner)]));
  }
  return value;
}

export function minorToMajor(minor) {
  return Number.isSafeInteger(minor) ? minor / 100 : 0;
}

function isoDay(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
}

export function statusLabel(status, lang = 'ar') {
  const entry = STATUS_LABELS[status];
  if (!entry) return String(status || '');
  return lang === 'ar' ? entry.ar : entry.en;
}

const CROP_CATEGORIES = ['olive', 'pistachio', 'almond', 'pomegranate', 'date', 'walnut'];
const COUNTRY_CODE = /^[A-Z]{2}$/;
const SITE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;
const CATALOG_IMAGE = /^images\/[A-Za-z0-9_-]{1,80}\.(webp|png|jpg|jpeg)$/;
/** Catalogue text from the server: markup characters and control characters never reach the page. */
function cleanText(value) {
  return typeof value === 'string' ? value.replace(/[<>\u0000-\u001f\u007f]/g, '').trim().slice(0, 160) : '';
}

/** trees_public document -> fields merged onto the local catalog entry (`catalog` holds the texts and images). */
export function mapPublicTree(doc) {
  const d = normalizeDoc(doc || {});
  return {
    id: d.id || d.treeId,
    server_listed: d.status === 'listed',
    total_shares: Number.isSafeInteger(d.totalShares) ? d.totalShares : SHARES_PER_TREE,
    shares_available: Number.isSafeInteger(d.availableShares) ? d.availableShares : 0,
    price_per_share: minorToMajor(d.pricePerShareMinor),
    land_price: minorToMajor(d.landPriceMinor),
    has_land_option: d.hasLandOption === true,
    currency: d.currency || 'USD',
    country_code: COUNTRY_CODE.test(d.countryCode || '') ? d.countryCode : 'SY',
    farm_id: SITE_ID.test(d.farmId || '') ? d.farmId : null,
    catalog: {
      tree_name: cleanText(d.name), tree_name_en: cleanText(d.nameEn),
      region: cleanText(d.region), region_en: cleanText(d.regionEn),
      tree_type: cleanText(d.treeType), tree_type_en: cleanText(d.treeTypeEn),
      crop_category: CROP_CATEGORIES.includes(d.cropCategory) ? d.cropCategory : 'olive',
      planted_year: Number.isSafeInteger(d.plantedYear) && d.plantedYear >= 1000 && d.plantedYear <= 2200 ? d.plantedYear : null,
      estimated_annual_yield_kg: Number.isFinite(Number(d.estimatedAnnualYieldKg)) && Number(d.estimatedAnnualYieldKg) > 0 ? Number(d.estimatedAnnualYieldKg) : null,
      images: (Array.isArray(d.images) ? d.images : []).filter((path) => typeof path === 'string' && CATALOG_IMAGE.test(path)).slice(0, 6)
    }
  };
}

/** countries row -> { code, name, name_en, name_de, currency }; rows with an unusable code are dropped. */
export function mapCountry(doc) {
  const d = normalizeDoc(doc || {});
  if (!COUNTRY_CODE.test(d.code || '')) return null;
  return {
    code: d.code,
    name: cleanText(d.name), name_en: cleanText(d.nameEn), name_de: cleanText(d.nameDe),
    currency: CURRENCY_CODE.test(d.currency || '') ? d.currency : 'USD'
  };
}

/** farms row -> { id, country_code, name, name_en, region, region_en }. */
export function mapFarm(doc) {
  const d = normalizeDoc(doc || {});
  if (!SITE_ID.test(d.farmId || '') || !COUNTRY_CODE.test(d.countryCode || '')) return null;
  return {
    id: d.farmId, country_code: d.countryCode,
    name: cleanText(d.name), name_en: cleanText(d.nameEn),
    region: cleanText(d.region), region_en: cleanText(d.regionEn)
  };
}

/** shares document -> legacy `state.userShares` entry. */
export function mapShare(doc) {
  const d = normalizeDoc(doc || {});
  const sharesCount = Number.isSafeInteger(d.shareCount) && d.shareCount > 0 ? d.shareCount : 1;
  const id = String(d.id || d.shareId || '');
  return {
    id,
    user_id: d.userId,
    tree_id: d.treeId,
    shares_count: sharesCount,
    percentage: Math.round((sharesCount / SHARES_PER_TREE) * 100),
    purchase_price: minorToMajor(d.purchasePriceMinor),
    currency: d.currency || 'USD',
    includes_land: d.includesLand === true,
    purchase_date: isoDay(d.createdAt),
    // Same format as private.certificate_serial() so UI, PDF and verifier agree.
    land_deed_serial: `FSL-${isoDay(d.createdAt).slice(0, 4) || new Date().getFullYear()}-${id.slice(0, 16).toUpperCase()}`,
    status: d.status || 'active',
    is_bundle: false,
    is_virgin_grove: false,
    source: 'server'
  };
}

/** transactions document -> legacy `state.transactions` entry. */
export function mapTransaction(doc) {
  const d = normalizeDoc(doc || {});
  const status = d.status || 'pending';
  return {
    id: d.id || d.transactionId,
    user_id: d.userId,
    ref: d.requestId || d.id,
    type: 'اكتتاب حصص زراعية',
    type_en: 'Tree share purchase',
    details: '',
    details_en: '',
    amount: minorToMajor(d.amountMinor),
    currency: d.currency || 'USD',
    method: 'Bank transfer',
    method_ar: 'تحويل بنكي',
    method_en: 'Bank transfer',
    status,
    status_ar: statusLabel(status, 'ar'),
    status_en: statusLabel(status, 'en'),
    date: isoDay(d.createdAt),
    source: 'server'
  };
}

/** investment_requests document -> dashboard request row. */
export function mapInvestment(doc) {
  const d = normalizeDoc(doc || {});
  return {
    id: d.id || d.requestId,
    treeId: d.treeId,
    shareCount: Number.isSafeInteger(d.shareCount) ? d.shareCount : 1,
    includesLand: d.includesLand === true,
    amountMinor: Number.isSafeInteger(d.amountMinor) ? d.amountMinor : 0,
    amount: minorToMajor(d.amountMinor),
    currency: d.currency || 'USD',
    status: d.status,
    expiresAt: toMillis(d.expiresAt),
    createdAt: toMillis(d.createdAt),
    reviewNote: d.reviewNote || '',
    proofSubmittedAt: toMillis(d.proofSubmittedAt),
    reviewedAt: toMillis(d.reviewedAt),
    slaBreached: d.slaBreached === true,
    canCancel: d.status === 'awaiting_payment'
  };
}

export const REVIEW_SLA_MS = 72 * 60 * 60 * 1000;

/**
 * Four-step payment timeline for one investment request (pure; rendered by the dashboard).
 * Steps: reserved → receipt → review → result. Each step: { key, state: 'done'|'current'|'todo'|'failed', at, dueAt }.
 */
export function investmentTimeline(req, now = Date.now()) {
  const r = req || {};
  const closedBad = ['rejected', 'expired', 'cancelled'].includes(r.status);
  const hasProof = Number.isFinite(r.proofSubmittedAt) || ['under_review', 'approved', 'rejected'].includes(r.status);
  const reviewDue = Number.isFinite(r.proofSubmittedAt) ? r.proofSubmittedAt + REVIEW_SLA_MS : null;
  const steps = [
    { key: 'reserved', state: 'done', at: r.createdAt ?? null, dueAt: null },
    { key: 'receipt', state: hasProof ? 'done' : (r.status === 'awaiting_payment' ? 'current' : 'failed'), at: r.proofSubmittedAt ?? null,
      dueAt: r.status === 'awaiting_payment' ? (r.expiresAt ?? null) : null },
    { key: 'review', state: r.status === 'under_review' ? 'current' : (['approved', 'rejected'].includes(r.status) ? 'done' : 'todo'),
      at: r.reviewedAt ?? null, dueAt: r.status === 'under_review' ? reviewDue : null },
    { key: 'result', state: r.status === 'approved' ? 'done' : (closedBad ? 'failed' : 'todo'), at: r.status === 'approved' ? (r.reviewedAt ?? null) : null, dueAt: null }
  ];
  const overdue = r.status === 'under_review' && (r.slaBreached === true || (reviewDue !== null && now > reviewDue));
  return { steps, overdue, outcome: r.status === 'approved' ? 'approved' : (closedBad ? r.status : 'open') };
}

/** Dashboard KPIs derived from mapped shares (no demo multipliers per record). */
export function portfolioTotals(shares) {
  const list = Array.isArray(shares) ? shares : [];
  const totalShares = list.reduce((sum, s) => sum + (s.shares_count || 0), 0);
  const landTrees = list.filter((s) => s.includes_land).reduce((sum, s) => sum + (s.shares_count || 0) / SHARES_PER_TREE, 0);
  return {
    invested: list.reduce((sum, s) => sum + (s.purchase_price || 0), 0),
    totalShares,
    treesEquivalent: totalShares / SHARES_PER_TREE,
    expectedOilLiters: totalShares * OIL_LITERS_PER_SHARE,
    landSqm: landTrees * LAND_SQM_PER_TREE
  };
}

// ---------------------------------------------------------------------------
// Weighed harvest (non-olive crops) and amounts with a unit
// ---------------------------------------------------------------------------
// The server keeps one amount column for both products: `litersMl` holds millilitres for olive oil and GRAMS for a
// weighed harvest. A harvest row is a pressing batch whose mill is 'farm': `olivesWeightKg` is the gross weight and
// `oilYieldLiters` the net weight, both in kilograms.

/** Mill id the server stores on a weighed-harvest row. */
export const HARVEST_MILL_ID = 'farm';
/** Limits enforced by submit_harvest_batch; mirrored here so a form can answer before the round trip. */
export const HARVEST_LIMITS = Object.freeze({ minGrossKg: 0.1, maxKg: 5000 });
const QUANTITY_UNIT_LABELS = Object.freeze({
  l: Object.freeze({ ar: 'لتر', en: 'L', de: 'L' }),
  kg: Object.freeze({ ar: 'كغ', en: 'kg', de: 'kg' })
});

/** Any server value -> 'l' | 'kg'. Requests created before the unit existed are olive oil. */
export function quantityUnit(unit) {
  return unit === 'kg' ? 'kg' : 'l';
}

/** Unit label for a language ('ar' | 'en' | 'de'); the Latin label is the fallback. */
export function quantityUnitLabel(unit, lang = 'en') {
  const entry = QUANTITY_UNIT_LABELS[quantityUnit(unit)];
  return entry[lang] || entry.en;
}

/** Millilitres or grams -> litres or kilograms as a number (0 for anything unusable). */
export function milliToMajor(milli) {
  const n = Number(milli);
  return Number.isFinite(n) && n > 0 ? n / 1000 : 0;
}

/** Litres or kilograms as text: two decimals, three below 0.01 so a few grams never read as zero. */
export function formatMajor(milli) {
  const value = milliToMajor(milli);
  return value.toFixed(value > 0 && value < 0.01 ? 3 : 2).replace(/\.?0+$/, '');
}

/** 2500, 'l' -> "2.5 L"; 2500, 'kg' -> "2.5 kg". */
export function formatQuantity(milli, unit, lang = 'en') {
  return `${formatMajor(milli)} ${quantityUnitLabel(unit, lang)}`;
}

/** Kilograms as stored on a batch (numeric, up to grams) -> text; '?' when the value is missing. */
function kgText(value) {
  if (value === null || value === undefined || value === '') return '?';
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : '?';
}

function kgNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
}

/** True for a pressing_batches row that records a weighed harvest instead of a mill pressing. */
export function isHarvestBatch(doc) {
  return Boolean(doc) && doc.millId === HARVEST_MILL_ID;
}

/**
 * pressing_batches row -> the same row plus `isHarvest`; a harvest row also carries `harvestKg` (gross) and `netKg`,
 * so no caller has to read weights out of the oil columns.
 */
export function mapPressingBatch(doc) {
  const d = normalizeDoc(doc || {});
  if (!isHarvestBatch(d)) return { ...d, isHarvest: false };
  return { ...d, isHarvest: true, harvestKg: kgNumber(d.olivesWeightKg), netKg: kgNumber(d.oilYieldLiters) };
}

/** oil_requests row -> the same row with a guaranteed `unit` ('l' | 'kg') and `quantity` in that unit. */
export function mapOilRequest(doc) {
  const d = normalizeDoc(doc || {});
  return { ...d, unit: quantityUnit(d.unit), quantity: milliToMajor(d.litersMl) };
}

/**
 * oil_allocations row -> the same row plus `unit` and `quantity`. The row has no unit of its own: it follows the
 * crop of its tree. `cropByTreeId` (Map or plain object: treeId -> crop category) decides; a tree that is not in it
 * yields `unit: null` and `quantity: null`, because guessing would label grams as litres.
 */
export function mapOilAllocation(doc, cropByTreeId) {
  const d = normalizeDoc(doc || {});
  const lookup = cropByTreeId || {};
  const crop = typeof lookup.get === 'function' ? lookup.get(d.treeId) : lookup[d.treeId];
  const unit = CROP_CATEGORIES.includes(crop) ? (crop === 'olive' ? 'l' : 'kg') : null;
  return { ...d, unit, quantity: unit ? milliToMajor(d.litersMl) : null };
}

/**
 * Sums of allocation amounts per unit: { l: <ml>, kg: <g>, unknown: <raw> }. Millilitres and grams are never added
 * together; `unknown` collects rows whose tree crop could not be resolved.
 */
export function allocationTotals(allocations) {
  const totals = { l: 0, kg: 0, unknown: 0 };
  for (const a of Array.isArray(allocations) ? allocations : []) {
    if (!a) continue;
    const amount = Number(a.litersMl);
    totals[a.unit === 'l' || a.unit === 'kg' ? a.unit : 'unknown'] += Number.isFinite(amount) ? amount : 0;
  }
  return totals;
}

/** Form text or number -> kilograms rounded to grams, or null. Accepts a decimal comma and Arabic digits. */
export function parseWeightKg(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
  if (typeof value !== 'string') return null;
  const text = value.trim()
    .replace(/[٠-٩]/g, (ch) => String(ch.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (ch) => String(ch.charCodeAt(0) - 0x06f0))
    .replace(/[,٫]/g, '.');
  if (!/^[0-9]{1,4}(\.[0-9]{1,3})?$/.test(text)) return null;
  return Number(text);
}

/**
 * Harvest form values -> `{ ok: true, payload }` for submit_harvest_batch, or `{ ok: false, error }` with one of
 * 'tree' | 'gross' | 'net' | 'net_exceeds_gross'. The server repeats every check and stays the authority.
 */
export function validateHarvestInput(input) {
  const source = input || {};
  const treeId = typeof source.treeId === 'string' ? source.treeId.trim() : '';
  if (!SITE_ID.test(treeId)) return { ok: false, error: 'tree' };
  const harvestKg = parseWeightKg(source.harvestKg);
  if (harvestKg === null || harvestKg < HARVEST_LIMITS.minGrossKg || harvestKg > HARVEST_LIMITS.maxKg) return { ok: false, error: 'gross' };
  const netKg = parseWeightKg(source.netKg);
  if (netKg === null || netKg < 0 || netKg > HARVEST_LIMITS.maxKg) return { ok: false, error: 'net' };
  if (netKg > harvestKg) return { ok: false, error: 'net_exceeds_gross' };
  return { ok: true, payload: { treeId, harvestKg, netKg } };
}

/** listReviewQueue item -> approvals-desk row. `queue` selects the review action. */
export function mapReviewItem(queue, item) {
  const d = normalizeDoc(item || {});
  const submitter = d.submitter?.displayName || d.submitter?.email || d.userId || d.farmerUid || d.submittedByUid || '';
  const base = {
    id: d.id,
    serverQueue: queue,
    isServerItem: true,
    user_id: d.userId || d.farmerUid || d.submittedByUid,
    user_name: submitter,
    user_name_en: submitter,
    status: 'pending',
    date: isoDay(d.proofSubmittedAt || d.submittedAt || d.createdAt),
    amount_usd: 0,
    amount_syp: 0,
    notes: ''
  };
  if (queue === 'payments') {
    return {
      ...base,
      isServerInvestment: true,
      role: 'investor',
      type: 'investment',
      type_label: 'اكتتاب حصص زراعية',
      type_label_en: 'Tree share purchase',
      amount_usd: minorToMajor(d.amountMinor),
      channel: 'Bank transfer',
      paymentProofPath: d.paymentProofPath,
      notes: `${d.treeId || ''} • ${d.shareCount || 0} shares${d.includesLand ? ' + 5 m²' : ''}`
    };
  }
  if (queue === 'farmer_updates') {
    // The reviewer must see exactly what gets published: full notes, every media path, GPS (audit run-1 F2).
    return {
      ...base, role: 'farmer', type: 'farmer_update', type_label: 'تقرير ميداني', type_label_en: 'Field report',
      channel: d.eventType || '', notes: d.notes || '',
      mediaPaths: Array.isArray(d.mediaPaths) ? d.mediaPaths.filter((x) => typeof x === 'string') : [],
      gpsLat: Number.isFinite(Number(d.gpsLat)) && d.gpsLat !== null ? Number(d.gpsLat) : null,
      gpsLng: Number.isFinite(Number(d.gpsLng)) && d.gpsLng !== null ? Number(d.gpsLng) : null,
      treeId: d.treeId || ''
    };
  }
  if (queue === 'pressing_batches') {
    if (isHarvestBatch(d)) {
      // Weighed harvest of a non-olive tree: recorded on the farm, no mill and no lab values.
      const gross = kgText(d.olivesWeightKg);
      const net = kgText(d.oilYieldLiters);
      return {
        ...base,
        role: 'farmer',
        type: 'pressing_batch',
        type_label: 'حصاد موزون',
        type_label_en: 'Weighed harvest',
        type_label_de: 'Gewogene Ernte',
        channel: HARVEST_MILL_ID,
        isHarvest: true,
        unit: 'kg',
        treeId: d.treeId || '',
        harvestKg: kgNumber(d.olivesWeightKg),
        netKg: kgNumber(d.oilYieldLiters),
        notes: `${d.treeId || ''} • Harvest ${gross} kg gross → ${net} kg net`,
        notes_ar: `${d.treeId || ''} • الحصاد ${gross} كغ قائم ← ${net} كغ صافٍ`,
        notes_de: `${d.treeId || ''} • Ernte ${gross} kg brutto → ${net} kg netto`
      };
    }
    return {
      ...base,
      role: 'mill_owner',
      type: 'pressing_batch',
      type_label: 'دفعة عصر',
      type_label_en: 'Pressing batch',
      type_label_de: 'Pressung',
      channel: d.millId || '',
      isHarvest: false,
      unit: 'l',
      treeId: d.treeId || '',
      notes: `${d.treeId || ''} • ${d.olivesWeightKg ?? '?'} kg → ${d.oilYieldLiters ?? '?'} L • ${d.acidityPct ?? '?'}%`
    };
  }
  if (queue === 'oil_requests' || queue === 'oil_fulfilment') {
    const c = d.contact || {};
    // One request carries either olive oil (millilitres) or weighed harvest (grams), never both.
    const unit = quantityUnit(d.unit);
    const isRequest = queue === 'oil_requests';
    const where = d.kind === 'delivery' ? [c.addressLine1, c.addressLine2, c.city, c.country].filter(Boolean).join(', ') : '';
    const labels = unit === 'kg'
      ? { ar: isRequest ? 'طلب محصول' : 'تنفيذ طلب محصول', en: isRequest ? 'Harvest request' : 'Harvest fulfilment', de: isRequest ? 'Ernteanfrage' : 'Ernte-Auslieferung' }
      : { ar: isRequest ? 'طلب زيت' : 'تنفيذ طلب زيت', en: isRequest ? 'Oil request' : 'Oil fulfilment', de: isRequest ? 'Ölanfrage' : 'Öl-Auslieferung' };
    return {
      ...base,
      role: 'investor',
      type: 'oil_request',
      type_label: labels.ar,
      type_label_en: labels.en,
      type_label_de: labels.de,
      channel: d.kind || '',
      unit,
      litersMl: Number.isFinite(Number(d.litersMl)) ? Number(d.litersMl) : 0,
      quantity: milliToMajor(d.litersMl),
      notes: [formatQuantity(d.litersMl, unit), c.name, c.phone, where, c.note].filter(Boolean).join(' • ').slice(0, 400)
    };
  }
  if (queue === 'role_applications') {
    return { ...base, role: d.requestedRole, type: 'role_application', type_label: 'طلب صلاحية', type_label_en: 'Role application', channel: d.requestedRole || '', notes: `${d.region || ''} ${d.organizationName || ''}`.trim() };
  }
  return base;
}

/** adminListUsers entry -> founder users-directory row (legacy `state.users` shape). */
export function mapDirectoryUser(doc) {
  const d = normalizeDoc(doc || {});
  const role = d.role === 'mill_operator' ? 'mill_owner' : (d.role || 'investor');
  const name = d.displayName || (d.email ? String(d.email).split('@')[0] : d.uid);
  return {
    id: d.uid,
    name,
    name_en: name,
    email: d.email || '',
    phone: d.phone || '',
    role,
    region: d.region || '',
    verified: d.emailVerified === true,
    status: d.disabled ? 'suspended' : 'active',
    joined_date: isoDay(d.createdAt),
    avatar: String(name || '?').charAt(0).toUpperCase(),
    source: 'server'
  };
}

export const CONSTANTS = Object.freeze({ SHARES_PER_TREE, OIL_LITERS_PER_SHARE, LAND_SQM_PER_TREE });
