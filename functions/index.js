const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { FieldValue, Timestamp, getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { HttpsError, onCall } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const {
  uploadGrantId,
  OPEN_REQUEST_STATUSES,
  REVIEW_SLA_MS,
  assertAccountDeletable,
  isReviewOverdue,
  isValidProofPath,
  requestIdFor,
  assertNotSelfReview,
  assertReservationQuota,
  calculateReservationAmount,
  nextInvestmentStatus,
  validateFarmerUpdate,
  validatePressingBatch,
  validateReviewNote,
  validateRoleApplication,
  validateReservationInput
} = require('./domain');

const REGION = 'europe-west3';
const DATABASE_ID = 'faseela-prod';
const STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET
  || 'gen-lang-client-0319369264.firebasestorage.app';
const RESERVATION_TTL_MS = 30 * 60 * 1000;
const DOC_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const REQUEST_ID_PATTERN = /^[a-f0-9]{64}$/;
// App Check stays opt-in until every client (web, Android, iOS) sends tokens;
// enabling it earlier would reject all traffic (fail-closed). Set
// ENFORCE_APP_CHECK=true in functions/.env once the clients are rolled out.
const CALLABLE_OPTIONS = Object.freeze({
  region: REGION,
  enforceAppCheck: process.env.ENFORCE_APP_CHECK === 'true'
});
const app = initializeApp();
const db = getFirestore(app, DATABASE_ID);
// Upload grants live in the (default) database because cross-service Storage rules
// cannot read named databases (review F-07, verified in the emulator).
const grantsDb = getFirestore(app);
const bucket = getStorage(app).bucket(STORAGE_BUCKET);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function requireUser(request) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in is required.');
  }
  return request.auth;
}

function isAdminToken(token) {
  return token.admin === true || token.role === 'admin';
}

function requireRole(auth, allowedRoles) {
  if (!isAdminToken(auth.token) && !allowedRoles.includes(auth.token.role)) {
    throw new HttpsError('permission-denied', 'This operation is not permitted for this account.');
  }
}

function rethrowDomainError(error) {
  if (error && error.code && error.message) {
    throw new HttpsError(error.code, error.message);
  }
  throw error;
}

function guardSelfReview(reviewerUid, ownerUid) {
  try {
    assertNotSelfReview(reviewerUid, ownerUid);
  } catch (error) {
    rethrowDomainError(error);
  }
}

function parseNote(note) {
  try {
    return validateReviewNote(note);
  } catch (error) {
    return rethrowDomainError(error);
  }
}

/**
 * Appends an immutable audit entry inside the caller's transaction so that the
 * business change and its audit record are committed atomically.
 */
function writeAudit(transaction, { actorUid, action, targetPath, details = {} }) {
  transaction.create(db.collection('audit_logs').doc(), {
    actorUid,
    action,
    targetPath,
    details,
    createdAt: FieldValue.serverTimestamp()
  });
}

async function setPaymentGrant(uid, requestId, expiresAt) {
  await grantsDb.doc(`upload_grants/${uploadGrantId(uid, 'payment', requestId)}`).set({
    uid, kind: 'payment', targetId: requestId, expiresAt, createdAt: FieldValue.serverTimestamp()
  });
}

async function clearPaymentGrant(uid, requestId) {
  try {
    await grantsDb.doc(`upload_grants/${uploadGrantId(uid, 'payment', requestId)}`).delete();
  } catch (error) {
    // Grants expire on their own (expiresAt is enforced by storage.rules); log and continue.
    console.warn(JSON.stringify({ event: 'grant_cleanup_failed', requestId, code: error.code || 'unknown' }));
  }
}

function serialize(value) {
  if (value instanceof Timestamp) return value.toMillis();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, serialize(inner)]));
  }
  return value;
}

function releaseReservation(transaction, { treeRef, publicTreeRef, tree, publicTree, shareCount }) {
  transaction.update(treeRef, {
    reservedShares: tree.reservedShares - shareCount,
    updatedAt: FieldValue.serverTimestamp()
  });
  transaction.update(publicTreeRef, {
    availableShares: publicTree.availableShares + shareCount,
    updatedAt: FieldValue.serverTimestamp()
  });
}

// ---------------------------------------------------------------------------
// Profiles & roles
// ---------------------------------------------------------------------------

exports.ensureInvestorProfile = onCall(CALLABLE_OPTIONS, async (request) => {
  const auth = requireUser(request);
  const displayName = request.data?.displayName;
  const phone = request.data?.phone;
  const region = request.data?.region;
  const requestedRole = request.data?.requestedRole;
  if ((displayName !== undefined && (typeof displayName !== 'string' || displayName.trim().length > 120))
    || (phone !== undefined && (typeof phone !== 'string' || phone.length > 40))
    || (region !== undefined && (typeof region !== 'string' || region.trim().length > 120))
    || (requestedRole !== undefined
      && !['investor', 'farmer', 'mill_operator'].includes(requestedRole))) {
    throw new HttpsError('invalid-argument', 'Profile data is invalid.');
  }
  const profileRef = db.doc(`users_private/${auth.uid}`);
  let profile;
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(profileRef);
    const existing = snapshot.exists ? snapshot.data() : {};
    profile = {
      uid: auth.uid,
      email: auth.token.email || existing.email || null,
      displayName: displayName === undefined
        ? existing.displayName || ''
        : displayName.trim(),
      phone: phone === undefined ? existing.phone || '' : phone.trim(),
      region: region === undefined ? existing.region || '' : region.trim(),
      requestedRole: requestedRole === undefined
        ? existing.requestedRole || 'investor'
        : requestedRole,
      role: existing.role || 'investor'
    };
    transaction.set(profileRef, {
      ...profile,
      createdAt: existing.createdAt || FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  });
  return { uid: auth.uid, role: profile.role, profile };
});

exports.submitRoleApplication = onCall(CALLABLE_OPTIONS, async (request) => {
  const auth = requireUser(request);
  if (auth.token.email_verified !== true) {
    throw new HttpsError('failed-precondition', 'Verify your email before requesting an operator role.');
  }
  let application;
  try {
    application = validateRoleApplication(request.data);
  } catch (error) {
    rethrowDomainError(error);
  }

  const applicationRef = db.doc(`role_applications/${auth.uid}`);
  return db.runTransaction(async (transaction) => {
    const existing = await transaction.get(applicationRef);
    if (existing.exists) {
      const previous = existing.data();
      if (previous.status === 'pending') {
        return { status: 'pending', requestedRole: previous.requestedRole };
      }
      if (previous.status === 'approved' && previous.requestedRole === application.requestedRole) {
        return { status: 'approved', requestedRole: previous.requestedRole };
      }
    }
    transaction.set(applicationRef, {
      ...application,
      userId: auth.uid,
      status: 'pending',
      submittedAt: FieldValue.serverTimestamp(),
      reviewedAt: null,
      reviewedByUid: null,
      reviewNote: ''
    });
    return { status: 'pending', requestedRole: application.requestedRole };
  });
});

exports.reviewRoleApplication = onCall(CALLABLE_OPTIONS, async (request) => {
  const auth = requireUser(request);
  requireRole(auth, ['admin']);
  const { userId, decision } = request.data || {};
  if (typeof userId !== 'string' || !DOC_ID_PATTERN.test(userId) || !['approve', 'reject'].includes(decision)) {
    throw new HttpsError('invalid-argument', 'Role application review request is invalid.');
  }
  guardSelfReview(auth.uid, userId);
  const note = parseNote(request.data?.note);
  const applicationRef = db.doc(`role_applications/${userId}`);
  const profileRef = db.doc(`users_private/${userId}`);
  const nextStatus = decision === 'approve' ? 'approved' : 'rejected';

  // Step 1: atomically claim the pending application so concurrent reviewers cannot double-decide.
  const application = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(applicationRef);
    if (!snapshot.exists || snapshot.data().status !== 'pending') {
      throw new HttpsError('failed-precondition', 'Role application is not pending.');
    }
    const data = snapshot.data();
    transaction.update(applicationRef, {
      status: nextStatus,
      reviewedByUid: auth.uid,
      reviewNote: note,
      reviewedAt: FieldValue.serverTimestamp()
    });
    if (decision === 'approve') {
      transaction.set(profileRef, {
        role: data.requestedRole,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
    writeAudit(transaction, {
      actorUid: auth.uid,
      action: `role_application.${nextStatus}`,
      targetPath: applicationRef.path,
      details: { userId, requestedRole: data.requestedRole, note }
    });
    return data;
  });

  // Step 2: custom claims live outside Firestore. Roll back the decision if the claim update fails.
  if (decision === 'approve') {
    try {
      const account = await getAuth(app).getUser(userId);
      await getAuth(app).setCustomUserClaims(userId, {
        ...(account.customClaims || {}),
        role: application.requestedRole
      });
    } catch (error) {
      await applicationRef.update({ status: 'pending', reviewedAt: null, reviewedByUid: null });
      await profileRef.set({ role: 'investor', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      throw new HttpsError('internal', 'Could not assign the role claim; the application was returned to pending.');
    }
  }
  return { userId, status: nextStatus };
});

// ---------------------------------------------------------------------------
// Investments
// ---------------------------------------------------------------------------

exports.createInvestmentRequest = onCall(CALLABLE_OPTIONS, async (request) => {
  const auth = requireUser(request);
  if (auth.token.email_verified !== true) {
    throw new HttpsError('failed-precondition', 'Verify your email before requesting an investment.');
  }

  let input;
  try {
    input = validateReservationInput(request.data);
  } catch (error) {
    rethrowDomainError(error);
  }

  const requestId = requestIdFor(auth.uid, input.idempotencyKey);
  const requestRef = db.doc(`investment_requests/${requestId}`);
  const transactionRef = db.doc(`transactions/${requestId}`);
  const treeRef = db.doc(`trees/${input.treeId}`);
  const publicTreeRef = db.doc(`trees_public/${input.treeId}`);

  const outcome = await db.runTransaction(async (transaction) => {
    const [existing, treeSnapshot, publicTreeSnapshot] = await Promise.all([
      transaction.get(requestRef),
      transaction.get(treeRef),
      transaction.get(publicTreeRef)
    ]);

    if (existing.exists) {
      if (existing.data().userId !== auth.uid) {
        throw new HttpsError('permission-denied', 'Request key is already in use.');
      }
      const previous = existing.data();
      return {
        requestId,
        status: previous.status,
        amountMinor: previous.amountMinor,
        expiresAt: previous.expiresAt?.toMillis?.() || null
      };
    }
    if (!treeSnapshot.exists || !publicTreeSnapshot.exists
      || publicTreeSnapshot.data().status !== 'listed') {
      throw new HttpsError('not-found', 'This tree is not currently available.');
    }

    // Read inside the transaction so concurrent requests from the same user serialize.
    const openRequests = await transaction.get(db.collection('investment_requests')
      .where('userId', '==', auth.uid)
      .where('status', 'in', OPEN_REQUEST_STATUSES)
      .limit(50));
    try {
      assertReservationQuota(openRequests.docs.map((doc) => doc.data()), input);
    } catch (error) {
      rethrowDomainError(error);
    }

    const tree = treeSnapshot.data();
    const availableShares = tree.totalShares - tree.soldShares - tree.reservedShares;
    if (!Number.isSafeInteger(availableShares) || input.shareCount > availableShares) {
      throw new HttpsError('failed-precondition', 'Not enough shares are available.');
    }

    let amountMinor;
    try {
      amountMinor = calculateReservationAmount(tree, input);
    } catch (error) {
      rethrowDomainError(error);
    }

    const expiresAt = Timestamp.fromMillis(Date.now() + RESERVATION_TTL_MS);
    transaction.update(treeRef, {
      reservedShares: tree.reservedShares + input.shareCount,
      updatedAt: FieldValue.serverTimestamp()
    });
    transaction.update(publicTreeRef, {
      availableShares: availableShares - input.shareCount,
      updatedAt: FieldValue.serverTimestamp()
    });
    transaction.create(requestRef, {
      requestId,
      userId: auth.uid,
      treeId: input.treeId,
      shareCount: input.shareCount,
      includesLand: input.includesLand,
      amountMinor,
      currency: tree.currency || 'USD',
      status: 'awaiting_payment',
      expiresAt,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    transaction.create(transactionRef, {
      transactionId: requestId,
      requestId,
      userId: auth.uid,
      type: 'share_purchase',
      amountMinor,
      currency: tree.currency || 'USD',
      status: 'pending',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    return { requestId, status: 'awaiting_payment', amountMinor, expiresAt: expiresAt.toMillis() };
  });

  // Mirror the upload grant outside the transaction (different database). An idempotent
  // replay recreates it, so a transient failure here is recoverable by retrying.
  if (outcome.status === 'awaiting_payment' && Number.isFinite(outcome.expiresAt)) {
    await setPaymentGrant(auth.uid, requestId, Timestamp.fromMillis(outcome.expiresAt));
  }
  return outcome;
});

exports.cancelInvestmentRequest = onCall(CALLABLE_OPTIONS, async (request) => {
  const auth = requireUser(request);
  const requestId = request.data?.requestId;
  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new HttpsError('invalid-argument', 'Investment request ID is invalid.');
  }
  const requestRef = db.doc(`investment_requests/${requestId}`);
  const transactionRef = db.doc(`transactions/${requestId}`);

  return db.runTransaction(async (transaction) => {
    const requestSnapshot = await transaction.get(requestRef);
    if (!requestSnapshot.exists || requestSnapshot.data().userId !== auth.uid) {
      throw new HttpsError('not-found', 'Investment request was not found.');
    }
    const investment = requestSnapshot.data();
    if (investment.status !== 'awaiting_payment') {
      throw new HttpsError('failed-precondition', 'Only requests awaiting payment can be cancelled.');
    }
    const treeRef = db.doc(`trees/${investment.treeId}`);
    const publicTreeRef = db.doc(`trees_public/${investment.treeId}`);
    const [treeSnapshot, publicTreeSnapshot] = await Promise.all([
      transaction.get(treeRef), transaction.get(publicTreeRef)
    ]);
    if (treeSnapshot.exists && publicTreeSnapshot.exists
      && treeSnapshot.data().reservedShares >= investment.shareCount) {
      releaseReservation(transaction, {
        treeRef,
        publicTreeRef,
        tree: treeSnapshot.data(),
        publicTree: publicTreeSnapshot.data(),
        shareCount: investment.shareCount
      });
    }
    transaction.update(requestRef, { status: 'cancelled', updatedAt: FieldValue.serverTimestamp() });
    transaction.update(transactionRef, { status: 'cancelled', updatedAt: FieldValue.serverTimestamp() });
    return { requestId, status: 'cancelled' };
  }).then(async (result) => {
    await clearPaymentGrant(auth.uid, requestId);
    return result;
  });
});

exports.submitInvestmentPaymentProof = onCall(CALLABLE_OPTIONS, async (request) => {
  const auth = requireUser(request);
  const requestId = request.data?.requestId;
  const storagePath = request.data?.storagePath;
  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)
    || !isValidProofPath(storagePath, auth.uid, requestId)) {
    throw new HttpsError('invalid-argument', 'Payment proof reference is invalid.');
  }

  const proofFile = bucket.file(storagePath);
  const [exists, metadata] = await proofFile.exists().then(async ([found]) => {
    if (!found) return [false, null];
    return [true, await proofFile.getMetadata().then(([value]) => value)];
  });
  if (!exists || !['image/jpeg', 'image/png', 'application/pdf'].includes(metadata?.contentType)) {
    throw new HttpsError('failed-precondition', 'Upload a supported payment receipt first.');
  }

  const requestRef = db.doc(`investment_requests/${requestId}`);
  const transactionRef = db.doc(`transactions/${requestId}`);
  return db.runTransaction(async (transaction) => {
    const requestSnapshot = await transaction.get(requestRef);
    if (!requestSnapshot.exists || requestSnapshot.data().userId !== auth.uid) {
      throw new HttpsError('not-found', 'Investment request was not found.');
    }
    const investment = requestSnapshot.data();
    if (investment.status !== 'awaiting_payment' || investment.expiresAt.toMillis() <= Date.now()) {
      throw new HttpsError('failed-precondition', 'This payment request has expired or was already submitted.');
    }

    transaction.update(requestRef, {
      status: 'under_review',
      paymentProofPath: storagePath,
      proofSubmittedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    transaction.update(transactionRef, {
      status: 'under_review',
      updatedAt: FieldValue.serverTimestamp()
    });
    return { requestId, status: 'under_review' };
  }).then(async (result) => {
    await clearPaymentGrant(auth.uid, requestId);
    return result;
  });
});

exports.getPaymentProofUrl = onCall(CALLABLE_OPTIONS, async (request) => {
  const auth = requireUser(request);
  requireRole(auth, ['finance_admin']);
  const requestId = request.data?.requestId;
  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new HttpsError('invalid-argument', 'Investment request ID is invalid.');
  }
  const snapshot = await db.doc(`investment_requests/${requestId}`).get();
  const proofPath = snapshot.exists ? snapshot.data().paymentProofPath : null;
  if (!proofPath) {
    throw new HttpsError('not-found', 'No payment proof is attached to this request.');
  }
  const [url] = await bucket.file(proofPath).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + 10 * 60 * 1000
  });
  return { url, expiresInSeconds: 600 };
});

exports.reviewInvestmentRequest = onCall(CALLABLE_OPTIONS, async (request) => {
  const auth = requireUser(request);
  requireRole(auth, ['finance_admin']);
  const requestId = request.data?.requestId;
  const decision = request.data?.decision;
  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new HttpsError('invalid-argument', 'Investment request ID is invalid.');
  }
  const note = parseNote(request.data?.note);

  const requestRef = db.doc(`investment_requests/${requestId}`);
  const transactionRef = db.doc(`transactions/${requestId}`);
  const shareRef = db.doc(`shares/${requestId}`);

  return db.runTransaction(async (transaction) => {
    const requestSnapshot = await transaction.get(requestRef);
    if (!requestSnapshot.exists) throw new HttpsError('not-found', 'Investment request was not found.');
    const investment = requestSnapshot.data();
    guardSelfReview(auth.uid, investment.userId);
    let nextStatus;
    try {
      nextStatus = nextInvestmentStatus(investment.status, decision);
    } catch (error) {
      rethrowDomainError(error);
    }

    const treeRef = db.doc(`trees/${investment.treeId}`);
    const publicTreeRef = db.doc(`trees_public/${investment.treeId}`);
    const [treeSnapshot, publicTreeSnapshot, transactionSnapshot, shareSnapshot] = await Promise.all([
      transaction.get(treeRef),
      transaction.get(publicTreeRef),
      transaction.get(transactionRef),
      transaction.get(shareRef)
    ]);
    if (!treeSnapshot.exists || !publicTreeSnapshot.exists || !transactionSnapshot.exists) {
      throw new HttpsError('failed-precondition', 'Investment records are incomplete.');
    }
    if (shareSnapshot.exists) {
      throw new HttpsError('already-exists', 'A share record already exists for this request.');
    }

    const tree = treeSnapshot.data();
    if (tree.reservedShares < investment.shareCount) {
      throw new HttpsError('failed-precondition', 'Reserved inventory is inconsistent.');
    }

    const releasedAvailable = publicTreeSnapshot.data().availableShares
      + (decision === 'reject' ? investment.shareCount : 0);
    transaction.update(treeRef, {
      reservedShares: tree.reservedShares - investment.shareCount,
      ...(decision === 'approve' ? { soldShares: tree.soldShares + investment.shareCount } : {}),
      updatedAt: FieldValue.serverTimestamp()
    });
    transaction.update(publicTreeRef, {
      availableShares: releasedAvailable,
      updatedAt: FieldValue.serverTimestamp()
    });
    transaction.update(requestRef, {
      status: nextStatus,
      reviewedByUid: auth.uid,
      reviewNote: note,
      reviewedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    transaction.update(transactionRef, {
      status: decision === 'approve' ? 'settled' : 'rejected',
      reviewedByUid: auth.uid,
      reviewedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    if (decision === 'approve') {
      transaction.create(shareRef, {
        shareId: requestId,
        requestId,
        userId: investment.userId,
        treeId: investment.treeId,
        shareCount: investment.shareCount,
        includesLand: investment.includesLand,
        purchasePriceMinor: investment.amountMinor,
        currency: investment.currency,
        status: 'active',
        createdAt: FieldValue.serverTimestamp()
      });
    }
    writeAudit(transaction, {
      actorUid: auth.uid,
      action: `investment_request.${nextStatus}`,
      targetPath: requestRef.path,
      details: {
        userId: investment.userId,
        treeId: investment.treeId,
        shareCount: investment.shareCount,
        amountMinor: investment.amountMinor,
        note
      }
    });

    return { requestId, status: nextStatus };
  });
});

exports.expireInvestmentRequests = onSchedule({
  region: REGION,
  schedule: 'every 10 minutes',
  timeZone: 'Etc/UTC',
  maxInstances: 1
}, async () => {
  const expired = await db.collection('investment_requests')
    .where('status', '==', 'awaiting_payment')
    .where('expiresAt', '<=', Timestamp.now())
    .limit(100)
    .get();

  for (const candidate of expired.docs) {
    await db.runTransaction(async (transaction) => {
      const requestSnapshot = await transaction.get(candidate.ref);
      if (!requestSnapshot.exists || requestSnapshot.data().status !== 'awaiting_payment') return;
      const investment = requestSnapshot.data();
      const treeRef = db.doc(`trees/${investment.treeId}`);
      const publicTreeRef = db.doc(`trees_public/${investment.treeId}`);
      const transactionRef = db.doc(`transactions/${investment.requestId}`);
      const [treeSnapshot, publicTreeSnapshot, paymentSnapshot] = await Promise.all([
        transaction.get(treeRef), transaction.get(publicTreeRef), transaction.get(transactionRef)
      ]);
      if (!treeSnapshot.exists || !publicTreeSnapshot.exists || !paymentSnapshot.exists) return;
      const tree = treeSnapshot.data();
      if (tree.reservedShares < investment.shareCount) return;

      releaseReservation(transaction, {
        treeRef,
        publicTreeRef,
        tree,
        publicTree: publicTreeSnapshot.data(),
        shareCount: investment.shareCount
      });
      transaction.update(candidate.ref, { status: 'expired', updatedAt: FieldValue.serverTimestamp() });
      transaction.update(transactionRef, { status: 'expired', updatedAt: FieldValue.serverTimestamp() });
    });
    const expired = candidate.data();
    if (expired?.userId) await clearPaymentGrant(expired.userId, candidate.id);
  }
});

// ---------------------------------------------------------------------------
// Field operations: farmer updates & pressing batches
// ---------------------------------------------------------------------------

exports.submitFarmerUpdate = onCall(CALLABLE_OPTIONS, async (request) => {
  const auth = requireUser(request);
  requireRole(auth, ['farmer']);
  let update;
  try {
    update = validateFarmerUpdate(request.data);
  } catch (error) {
    rethrowDomainError(error);
  }

  if (update.mediaPaths.some((path) => !path.startsWith(`field-media/${auth.uid}/${update.treeId}/`))) {
    throw new HttpsError('invalid-argument', 'Media must be uploaded to your own field-media folder for this tree.');
  }

  const assignmentRef = db.doc(`farmer_assignments/${auth.uid}/trees/${update.treeId}`);
  const assignment = await assignmentRef.get();
  if (!assignment.exists) throw new HttpsError('permission-denied', 'Tree is not assigned to this farmer.');

  const updateRef = db.collection('farmer_updates').doc();
  await updateRef.create({
    ...update,
    farmerUid: auth.uid,
    status: 'pending_review',
    createdAt: FieldValue.serverTimestamp()
  });
  return { updateId: updateRef.id, status: 'pending_review' };
});

exports.reviewFarmerUpdate = onCall(CALLABLE_OPTIONS, async (request) => {
  const auth = requireUser(request);
  requireRole(auth, ['quality_auditor']);
  const { updateId, decision } = request.data || {};
  if (typeof updateId !== 'string' || !DOC_ID_PATTERN.test(updateId) || !['publish', 'reject'].includes(decision)) {
    throw new HttpsError('invalid-argument', 'Update review request is invalid.');
  }
  const note = parseNote(request.data?.note);

  const updateRef = db.doc(`farmer_updates/${updateId}`);
  const eventRef = db.collection('tree_events_public').doc();
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(updateRef);
    if (!snapshot.exists || snapshot.data().status !== 'pending_review') {
      throw new HttpsError('failed-precondition', 'Farmer update is not pending review.');
    }
    const update = snapshot.data();
    guardSelfReview(auth.uid, update.farmerUid);
    const status = decision === 'publish' ? 'published' : 'rejected';
    transaction.update(updateRef, {
      status,
      reviewNote: note,
      reviewedByUid: auth.uid,
      reviewedAt: FieldValue.serverTimestamp()
    });
    if (decision === 'publish') {
      transaction.create(eventRef, {
        treeId: update.treeId,
        eventType: update.eventType,
        notes: update.notes,
        // Media remains private in Storage; only the count is published.
        mediaCount: Array.isArray(update.mediaPaths) ? update.mediaPaths.length : 0,
        eventDate: update.createdAt,
        status: 'published',
        createdAt: FieldValue.serverTimestamp()
      });
    }
    writeAudit(transaction, {
      actorUid: auth.uid,
      action: `farmer_update.${status}`,
      targetPath: updateRef.path,
      details: { treeId: update.treeId, farmerUid: update.farmerUid, note }
    });
    return { updateId, status };
  });
});

exports.submitPressingBatch = onCall(CALLABLE_OPTIONS, async (request) => {
  const auth = requireUser(request);
  requireRole(auth, ['mill_operator']);
  let batch;
  try {
    batch = validatePressingBatch(request.data);
  } catch (error) {
    rethrowDomainError(error);
  }
  const [assignment, treeSnapshot, publicTreeSnapshot] = await Promise.all([
    db.doc(`mill_assignments/${auth.uid}/mills/${batch.millId}`).get(),
    db.doc(`trees/${batch.treeId}`).get(),
    db.doc(`trees_public/${batch.treeId}`).get()
  ]);
  if (!assignment.exists) throw new HttpsError('permission-denied', 'Mill is not assigned to this operator.');
  if (!treeSnapshot.exists || !publicTreeSnapshot.exists
    || publicTreeSnapshot.data().status !== 'listed') {
    throw new HttpsError('not-found', 'This tree is not available for pressing records.');
  }

  const batchRef = db.collection('pressing_batches').doc();
  await batchRef.create({
    ...batch,
    submittedByUid: auth.uid,
    seasonYear: new Date().getUTCFullYear(),
    status: 'pending_review',
    createdAt: FieldValue.serverTimestamp()
  });
  return { batchId: batchRef.id, status: 'pending_review' };
});

exports.certifyPressingBatch = onCall(CALLABLE_OPTIONS, async (request) => {
  const auth = requireUser(request);
  requireRole(auth, ['quality_auditor']);
  const { batchId, certificateSerial } = request.data || {};
  const decision = request.data?.decision || 'certify';
  if (typeof batchId !== 'string' || !DOC_ID_PATTERN.test(batchId) || !['certify', 'reject'].includes(decision)) {
    throw new HttpsError('invalid-argument', 'Batch review request is invalid.');
  }
  if (decision === 'certify' && !/^[A-Za-z0-9_-]{1,120}$/.test(certificateSerial || '')) {
    throw new HttpsError('invalid-argument', 'A certificate serial is required to certify a batch.');
  }
  const note = parseNote(request.data?.note);

  const batchRef = db.doc(`pressing_batches/${batchId}`);
  const eventRef = db.collection('tree_events_public').doc();
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(batchRef);
    if (!snapshot.exists || snapshot.data().status !== 'pending_review') {
      throw new HttpsError('failed-precondition', 'Pressing batch is not pending review.');
    }
    const batch = snapshot.data();
    guardSelfReview(auth.uid, batch.submittedByUid);
    const status = decision === 'certify' ? 'certified' : 'rejected';
    transaction.update(batchRef, {
      ...(decision === 'certify' ? { certificateSerial } : {}),
      reviewNote: note,
      certifiedByUid: auth.uid,
      certifiedAt: FieldValue.serverTimestamp(),
      status
    });
    if (decision === 'certify') {
      transaction.create(eventRef, {
        treeId: batch.treeId,
        eventType: 'pressing_certified',
        batchId,
        certificateSerial,
        oilYieldLiters: batch.oilYieldLiters,
        acidityPct: batch.acidityPct,
        peroxideValue: batch.peroxideValue,
        status: 'published',
        createdAt: FieldValue.serverTimestamp()
      });
    }
    writeAudit(transaction, {
      actorUid: auth.uid,
      action: `pressing_batch.${status}`,
      targetPath: batchRef.path,
      details: { treeId: batch.treeId, millId: batch.millId, certificateSerial: certificateSerial || null, note }
    });
    return { batchId, status };
  });
});

// ---------------------------------------------------------------------------
// Review queue for reviewer dashboards
// ---------------------------------------------------------------------------

const REVIEW_QUEUES = {
  payments: { collection: 'investment_requests', status: 'under_review', roles: ['finance_admin'], timeField: 'proofSubmittedAt' },
  farmer_updates: { collection: 'farmer_updates', status: 'pending_review', roles: ['quality_auditor'], timeField: 'createdAt' },
  pressing_batches: { collection: 'pressing_batches', status: 'pending_review', roles: ['quality_auditor'], timeField: 'createdAt' },
  role_applications: { collection: 'role_applications', status: 'pending', roles: [], timeField: 'submittedAt' }
};

exports.listReviewQueue = onCall(CALLABLE_OPTIONS, async (request) => {
  const auth = requireUser(request);
  const queueName = request.data?.queue;
  const queue = REVIEW_QUEUES[queueName];
  if (!queue) {
    throw new HttpsError('invalid-argument', 'Unknown review queue.');
  }
  requireRole(auth, queue.roles);

  // Equality-only query avoids a composite index; ordering is applied in memory.
  const snapshot = await db.collection(queue.collection)
    .where('status', '==', queue.status)
    .limit(100)
    .get();

  const items = snapshot.docs
    .map((doc) => ({ id: doc.id, ...serialize(doc.data()) }))
    .sort((a, b) => (a[queue.timeField] || 0) - (b[queue.timeField] || 0));

  // Enrich with applicant/investor contact details for authorized reviewers only.
  const userIds = [...new Set(items.map((item) => item.userId || item.farmerUid || item.submittedByUid).filter(Boolean))];
  const profiles = userIds.length
    ? await db.getAll(...userIds.map((uid) => db.doc(`users_private/${uid}`)))
    : [];
  const profileByUid = Object.fromEntries(profiles.filter((doc) => doc.exists).map((doc) => [doc.id, {
    displayName: doc.data().displayName || '',
    email: doc.data().email || ''
  }]));

  return {
    queue: queueName,
    items: items.map((item) => ({
      ...item,
      submitter: profileByUid[item.userId || item.farmerUid || item.submittedByUid] || null
    }))
  };
});
// ---------------------------------------------------------------------------
// Operations: finance review SLA (review F-17)
// ---------------------------------------------------------------------------

exports.flagOverdueReviews = onSchedule({
  region: REGION,
  schedule: 'every 6 hours',
  timeZone: 'Etc/UTC',
  maxInstances: 1
}, async () => {
  const cutoff = Timestamp.fromMillis(Date.now() - REVIEW_SLA_MS);
  const overdue = await db.collection('investment_requests')
    .where('status', '==', 'under_review')
    .where('proofSubmittedAt', '<=', cutoff)
    .limit(200)
    .get();
  for (const candidate of overdue.docs) {
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(candidate.ref);
      const data = snapshot.data();
      if (!snapshot.exists || data.status !== 'under_review' || data.slaBreached === true) return;
      if (!isReviewOverdue(data.proofSubmittedAt?.toMillis?.(), Date.now())) return;
      transaction.update(candidate.ref, { slaBreached: true, slaBreachedAt: FieldValue.serverTimestamp() });
      writeAudit(transaction, {
        actorUid: 'system',
        action: 'investment_request.review_sla_breached',
        targetPath: candidate.ref.path,
        details: { treeId: data.treeId, shareCount: data.shareCount }
      });
    });
  }
  // Structured log line for alerting (no PII: ids only).
  console.log(JSON.stringify({ event: 'review_sla_scan', overdue: overdue.size }));
});

// ---------------------------------------------------------------------------
// Admin: user directory (admin only, minimal fields)
// ---------------------------------------------------------------------------

exports.adminListUsers = onCall(CALLABLE_OPTIONS, async (request) => {
  const auth = requireUser(request);
  requireRole(auth, ['admin']);
  const snapshot = await db.collection('users_private').limit(500).get();
  const profiles = snapshot.docs.map((doc) => ({ uid: doc.id, ...doc.data() }));
  const authRecords = new Map();
  for (let i = 0; i < profiles.length; i += 100) {
    const batch = profiles.slice(i, i + 100).map((p) => ({ uid: p.uid }));
    const result = await getAuth(app).getUsers(batch);
    result.users.forEach((user) => authRecords.set(user.uid, user));
  }
  return {
    users: profiles.map((p) => {
      const record = authRecords.get(p.uid);
      return {
        uid: p.uid,
        displayName: p.displayName || '',
        email: p.email || record?.email || '',
        phone: p.phone || '',
        region: p.region || '',
        role: record?.customClaims?.role || (record?.customClaims?.admin ? 'admin' : 'investor'),
        emailVerified: record?.emailVerified === true,
        disabled: record?.disabled === true,
        createdAt: serialize(p.createdAt) || null
      };
    })
  };
});

// ---------------------------------------------------------------------------
// DSGVO self-service: export (Art. 15/20) and deletion (Art. 17)
// ---------------------------------------------------------------------------

async function ownedDocs(collectionName, field, uid) {
  const snapshot = await db.collection(collectionName).where(field, '==', uid).limit(1000).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...serialize(doc.data()) }));
}

exports.exportMyData = onCall(CALLABLE_OPTIONS, async (request) => {
  const auth = requireUser(request);
  const [profile, roleApplication, investmentRequests, transactions, shares, farmerUpdates, pressingBatches] = await Promise.all([
    db.doc(`users_private/${auth.uid}`).get(),
    db.doc(`role_applications/${auth.uid}`).get(),
    ownedDocs('investment_requests', 'userId', auth.uid),
    ownedDocs('transactions', 'userId', auth.uid),
    ownedDocs('shares', 'userId', auth.uid),
    ownedDocs('farmer_updates', 'farmerUid', auth.uid),
    ownedDocs('pressing_batches', 'submittedByUid', auth.uid)
  ]);
  console.log(JSON.stringify({ event: 'data_export', uidHash: requestIdFor(auth.uid, 'export').slice(0, 16) }));
  return {
    exportedAt: new Date().toISOString(),
    format: 'faseela-data-export/v1',
    profile: profile.exists ? serialize(profile.data()) : null,
    roleApplication: roleApplication.exists ? serialize(roleApplication.data()) : null,
    investmentRequests,
    transactions,
    shares,
    farmerUpdates,
    pressingBatches
  };
});

exports.deleteMyAccount = onCall(CALLABLE_OPTIONS, async (request) => {
  const auth = requireUser(request);
  const [open, active] = await Promise.all([
    db.collection('investment_requests').where('userId', '==', auth.uid).where('status', 'in', OPEN_REQUEST_STATUSES).limit(1).get(),
    db.collection('shares').where('userId', '==', auth.uid).where('status', '==', 'active').limit(1).get()
  ]);
  try {
    assertAccountDeletable({ confirmation: request.data?.confirmation, openRequests: open.size, activeShares: active.size });
  } catch (error) {
    rethrowDomainError(error);
  }

  // Personal data is removed; financial records stay keyed by the now-orphaned uid
  // (pseudonymised) to meet bookkeeping retention duties [PLATZHALTER: retention period].
  const profileRef = db.doc(`users_private/${auth.uid}`);
  const applicationRef = db.doc(`role_applications/${auth.uid}`);
  await db.runTransaction(async (transaction) => {
    transaction.delete(profileRef);
    transaction.delete(applicationRef);
    writeAudit(transaction, {
      actorUid: auth.uid,
      action: 'account.deleted',
      targetPath: profileRef.path,
      details: {}
    });
  });
  await getAuth(app).deleteUser(auth.uid);
  return { deleted: true };
});
