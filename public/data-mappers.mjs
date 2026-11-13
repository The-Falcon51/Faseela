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

const CROP_CATEGORIES = ['olive', 'pistachio', 'almond', 'pomegranate', 'walnut'];
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
    return {
      ...base,
      role: 'mill_owner',
      type: 'pressing_batch',
      type_label: 'دفعة عصر',
      type_label_en: 'Pressing batch',
      channel: d.millId || '',
      notes: `${d.treeId || ''} • ${d.olivesWeightKg ?? '?'} kg → ${d.oilYieldLiters ?? '?'} L • ${d.acidityPct ?? '?'}%`
    };
  }
  if (queue === 'oil_requests' || queue === 'oil_fulfilment') {
    const c = d.contact || {};
    const liters = `${(Number(d.litersMl || 0) / 1000).toFixed(2).replace(/\.?0+$/, '')} L`;
    const where = d.kind === 'delivery' ? [c.addressLine1, c.addressLine2, c.city, c.country].filter(Boolean).join(', ') : '';
    return {
      ...base,
      role: 'investor',
      type: 'oil_request',
      type_label: queue === 'oil_requests' ? 'طلب زيت' : 'تنفيذ طلب زيت',
      type_label_en: queue === 'oil_requests' ? 'Oil request' : 'Oil fulfilment',
      channel: d.kind || '',
      notes: [liters, c.name, c.phone, where, c.note].filter(Boolean).join(' • ').slice(0, 400)
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
