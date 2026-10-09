const { createHash } = require('node:crypto');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { FieldValue, Timestamp, getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { HttpsError, onCall } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const {
  calculateReservationAmount,
  nextInvestmentStatus,
  validateFarmerUpdate,
  validatePressingBatch,
  validateRoleApplication,
  validateReservationInput
} = require('./domain');

const REGION = 'europe-west3';
const DATABASE_ID = 'faseela-prod';
const STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET
  || 'gen-lang-client-0319369264.firebasestorage.app';
const app = initializeApp();
const db = getFirestore(app, DATABASE_ID);
const bucket = getStorage(app).bucket(STORAGE_BUCKET);

function requireUser(request) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in is required.');
  }
  return request.auth;
}

function requireRole(auth, allowedRoles) {
  const role = auth.token.role;
  if (auth.token.admin !== true && !allowedRoles.includes(role)) {
    throw new HttpsError('permission-denied', 'This operation is not permitted for this account.');
  }
}

function rethrowDomainError(error) {
  if (error && error.code && error.message) {
    throw new HttpsError(error.code, error.message);
  }
  throw error;
}

function requestIdFor(uid, idempotencyKey) {
  return createHash('sha256').update(`${uid}:${idempotencyKey}`).digest('hex');
}

function isValidProofPath(path, uid, requestId) {
  return typeof path === 'string'
    && path.startsWith(`payment-proofs/${uid}/${requestId}/`)
    && /^[A-Za-z0-9._/-]{1,240}$/.test(path)
    && !path.includes('..');
}

exports.ensureInvestorProfile = onCall({ region: REGION }, async (request) => {
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

exports.submitRoleApplication = onCall({ region: REGION }, async (request) => {
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
      reviewedByUid: null
    });
    return { status: 'pending', requestedRole: application.requestedRole };
  });
});

exports.reviewRoleApplication = onCall({ region: REGION }, async (request) => {
  const auth = requireUser(request);
  requireRole(auth, ['admin']);
  const { userId, decision } = request.data || {};
  if (typeof userId !== 'string' || !['approve', 'reject'].includes(decision)) {
    throw new HttpsError('invalid-argument', 'Role application review request is invalid.');
  }

  const applicationRef = db.doc(`role_applications/${userId}`);
  const applicationSnapshot = await applicationRef.get();
  if (!applicationSnapshot.exists || applicationSnapshot.data().status !== 'pending') {
    throw new HttpsError('failed-precondition', 'Role application is not pending.');
  }
  const application = applicationSnapshot.data();

  if (decision === 'approve') {
    const account = await getAuth(app).getUser(userId);
    await getAuth(app).setCustomUserClaims(userId, {
      ...(account.customClaims || {}),
      role: application.requestedRole
    });
  }

  await applicationRef.update({
    status: decision === 'approve' ? 'approved' : 'rejected',
    reviewedByUid: auth.uid,
    reviewedAt: FieldValue.serverTimestamp()
  });
  return { userId, status: decision === 'approve' ? 'approved' : 'rejected' };
});

exports.createInvestmentRequest = onCall({ region: REGION }, async (request) => {
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

  return db.runTransaction(async (transaction) => {
    const [existing, treeSnapshot, publicTreeSnapshot] = await Promise.all([
      transaction.get(requestRef),
      transaction.get(treeRef),
      transaction.get(publicTreeRef)
    ]);

    if (existing.exists) {
      if (existing.data().userId !== auth.uid) {
        throw new HttpsError('permission-denied', 'Request key is already in use.');
      }
      return { requestId, status: existing.data().status, amountMinor: existing.data().amountMinor };
    }
    if (!treeSnapshot.exists || !publicTreeSnapshot.exists
      || publicTreeSnapshot.data().status !== 'listed') {
      throw new HttpsError('not-found', 'This tree is not currently available.');
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

    const expiresAt = Timestamp.fromMillis(Date.now() + 30 * 60 * 1000);
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
      currency: 'USD',
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
      currency: 'USD',
      status: 'pending',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    return { requestId, status: 'awaiting_payment', amountMinor, expiresAt: expiresAt.toMillis() };
  });
});

exports.submitInvestmentPaymentProof = onCall({ region: REGION }, async (request) => {
  const auth = requireUser(request);
  const requestId = request.data?.requestId;
  const storagePath = request.data?.storagePath;
  if (typeof requestId !== 'string' || !/^[a-f0-9]{64}$/.test(requestId)
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
      updatedAt: FieldValue.serverTimestamp()
    });
    transaction.update(transactionRef, {
      status: 'under_review',
      updatedAt: FieldValue.serverTimestamp()
    });
    return { requestId, status: 'under_review' };
  });
});

exports.reviewInvestmentRequest = onCall({ region: REGION }, async (request) => {
  const auth = requireUser(request);
  requireRole(auth, ['finance_admin']);
  const requestId = request.data?.requestId;
  const decision = request.data?.decision;
  if (typeof requestId !== 'string' || !/^[a-f0-9]{64}$/.test(requestId)) {
    throw new HttpsError('invalid-argument', 'Investment request ID is invalid.');
  }

  const requestRef = db.doc(`investment_requests/${requestId}`);
  const transactionRef = db.doc(`transactions/${requestId}`);
  const shareRef = db.doc(`shares/${requestId}`);

  return db.runTransaction(async (transaction) => {
    const requestSnapshot = await transaction.get(requestRef);
    if (!requestSnapshot.exists) throw new HttpsError('not-found', 'Investment request was not found.');
    const investment = requestSnapshot.data();
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

      transaction.update(treeRef, {
        reservedShares: tree.reservedShares - investment.shareCount,
        updatedAt: FieldValue.serverTimestamp()
      });
      transaction.update(publicTreeRef, {
        availableShares: publicTreeSnapshot.data().availableShares + investment.shareCount,
        updatedAt: FieldValue.serverTimestamp()
      });
      transaction.update(candidate.ref, { status: 'expired', updatedAt: FieldValue.serverTimestamp() });
      transaction.update(transactionRef, { status: 'expired', updatedAt: FieldValue.serverTimestamp() });
    });
  }
});

exports.submitFarmerUpdate = onCall({ region: REGION }, async (request) => {
  const auth = requireUser(request);
  requireRole(auth, ['farmer']);
  let update;
  try {
    update = validateFarmerUpdate(request.data);
  } catch (error) {
    rethrowDomainError(error);
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

exports.reviewFarmerUpdate = onCall({ region: REGION }, async (request) => {
  const auth = requireUser(request);
  requireRole(auth, ['quality_auditor']);
  const { updateId, decision } = request.data || {};
  if (typeof updateId !== 'string' || !['publish', 'reject'].includes(decision)) {
    throw new HttpsError('invalid-argument', 'Update review request is invalid.');
  }

  const updateRef = db.doc(`farmer_updates/${updateId}`);
  const eventRef = db.collection('tree_events_public').doc();
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(updateRef);
    if (!snapshot.exists || snapshot.data().status !== 'pending_review') {
      throw new HttpsError('failed-precondition', 'Farmer update is not pending review.');
    }
    const update = snapshot.data();
    const status = decision === 'publish' ? 'published' : 'rejected';
    transaction.update(updateRef, {
      status,
      reviewedByUid: auth.uid,
      reviewedAt: FieldValue.serverTimestamp()
    });
    if (decision === 'publish') {
      transaction.create(eventRef, {
        treeId: update.treeId,
        eventType: update.eventType,
        notes: update.notes,
        mediaPaths: update.mediaPaths,
        eventDate: update.createdAt,
        status: 'published',
        createdAt: FieldValue.serverTimestamp()
      });
    }
    return { updateId, status };
  });
});

exports.submitPressingBatch = onCall({ region: REGION }, async (request) => {
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

exports.certifyPressingBatch = onCall({ region: REGION }, async (request) => {
  const auth = requireUser(request);
  requireRole(auth, ['quality_auditor']);
  const { batchId, certificateSerial } = request.data || {};
  if (typeof batchId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(certificateSerial || '')) {
    throw new HttpsError('invalid-argument', 'Batch ID and certificate serial are required.');
  }

  const batchRef = db.doc(`pressing_batches/${batchId}`);
  const eventRef = db.collection('tree_events_public').doc();
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(batchRef);
    if (!snapshot.exists || snapshot.data().status !== 'pending_review') {
      throw new HttpsError('failed-precondition', 'Pressing batch is not pending review.');
    }
    const batch = snapshot.data();
    transaction.update(batchRef, {
      certificateSerial,
      certifiedByUid: auth.uid,
      certifiedAt: FieldValue.serverTimestamp(),
      status: 'certified'
    });
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
    return { batchId, status: 'certified' };
  });
});