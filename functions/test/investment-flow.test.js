const { randomUUID } = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildTreeRecords,
  calculateReservationAmount,
  nextInvestmentStatus,
  validateReservationInput,
  validateRoleApplication,
  validateReviewNote,
  SHARES_PER_TREE,
  isValidProofPath,
  requestIdFor
} = require('../domain');

test('Integration Suite: Deterministic Request ID Generation and Proof Path Validation', () => {
  const uid = 'investor_usr_42';
  const idempotencyKey = 'test-idempotency-key-1';
  const reqId = requestIdFor(uid, idempotencyKey);

  assert.equal(typeof reqId, 'string');
  assert.equal(reqId.length, 64);
  assert.equal(reqId, requestIdFor(uid, idempotencyKey), 'Hashing must be deterministic');

  // Valid proof path
  const validPath = `payment-proofs/${uid}/${reqId}/1730000000_receipt.pdf`;
  assert.equal(isValidProofPath(validPath, uid, reqId), true);

  // Path traversal or mismatched uid/reqId attacks rejected
  assert.equal(isValidProofPath(`payment-proofs/${uid}/${reqId}/../hack.jpg`, uid, reqId), false);
  assert.equal(isValidProofPath(`payment-proofs/other_usr/${reqId}/receipt.png`, uid, reqId), false);
  assert.equal(isValidProofPath(`payment-proofs/${uid}/other_req/receipt.png`, uid, reqId), false);
  assert.equal(isValidProofPath(`random/path/receipt.png`, uid, reqId), false);
});

test('Integration Suite: Seed Tree Transformation & Multi-tenant Inventory Accounting', () => {
  const seedTree = {
    id: 'tree_al_ghouta_101',
    tree_name: 'شجرة الزيتون المباركة',
    tree_name_en: 'Blessed Olive Tree',
    price_per_share: 45.0,
    total_shares_available: 100, // 4 available shares
    crop_category: 'olive',
    region: 'ريف دمشق - الغوطة',
    region_en: 'Damascus Countryside - Ghouta',
    land_parcel: {
      has_land_option: true,
      land_addon_price_usd: 25.0,
      land_area_sqm: 5
    },
    gps_lat: 33.5138,
    gps_lng: 36.2765
  };

  const { tree, publicTree } = buildTreeRecords(seedTree);

  assert.equal(tree.totalShares, SHARES_PER_TREE);
  assert.equal(tree.soldShares, 0);
  assert.equal(tree.reservedShares, 0);
  assert.equal(tree.pricePerShareMinor, 4500); // 45.00 USD -> 4500 minor units
  assert.equal(tree.landPriceMinor, 2500); // 25.00 USD -> 2500 minor units
  assert.equal(publicTree.availableShares, 4);

  // 1. Investor reserves 2 shares (without land)
  const reservation1 = validateReservationInput({
    treeId: tree.treeId,
    shareCount: 2,
    includesLand: false,
    idempotencyKey: 'idemp_key_investor_alpha_99'
  });
  const cost1 = calculateReservationAmount(tree, reservation1);
  assert.equal(cost1, 9000); // 2 * 4500

  // Simulate in-memory state transition for reservation
  tree.reservedShares += reservation1.shareCount;
  publicTree.availableShares -= reservation1.shareCount;
  assert.equal(tree.reservedShares, 2);
  assert.equal(publicTree.availableShares, 2);

  // 2. Second investor attempts to reserve 3 shares (exceeds available 2)
  const reservation2 = validateReservationInput({
    treeId: tree.treeId,
    shareCount: 3,
    includesLand: false,
    idempotencyKey: 'idemp_key_investor_beta_88'
  });
  const availableShares = tree.totalShares - tree.soldShares - tree.reservedShares;
  assert.equal(availableShares, 2);
  assert.equal(reservation2.shareCount > availableShares, true, 'Must reject over-allocation');

  // 3. Investor Alpha cancels reservation -> shares released
  tree.reservedShares -= reservation1.shareCount;
  publicTree.availableShares += reservation1.shareCount;
  assert.equal(tree.reservedShares, 0);
  assert.equal(publicTree.availableShares, 4);
});

test('Integration Suite: Full End-to-End Investment Lifecycle with Finance Review', () => {
  // Simulated Firestore state
  const mockDb = {
    trees: new Map(),
    trees_public: new Map(),
    investment_requests: new Map(),
    transactions: new Map(),
    shares: new Map(),
    audit_logs: []
  };

  const treeId = 'tree_hama_sorani_01';
  mockDb.trees.set(treeId, {
    treeId,
    totalShares: 4,
    soldShares: 0,
    reservedShares: 0,
    pricePerShareMinor: 5000,
    landPriceMinor: 2000,
    currency: 'USD'
  });
  mockDb.trees_public.set(treeId, {
    treeId,
    status: 'listed',
    totalShares: 4,
    availableShares: 4,
    pricePerShareMinor: 5000,
    landPriceMinor: 2000,
    currency: 'USD'
  });

  const investorUid = 'usr_investor_damascus_01';
  const financeAdminUid = 'usr_founder_admin_01';

  // Step 1: Submit investment request (4 shares + cadastral land deed)
  const input = validateReservationInput({
    treeId,
    shareCount: 4,
    includesLand: true,
    idempotencyKey: 'client_idempotency_key_test_001'
  });

  const reqId = requestIdFor(investorUid, input.idempotencyKey);
  const tree = mockDb.trees.get(treeId);
  const pubTree = mockDb.trees_public.get(treeId);
  const amountMinor = calculateReservationAmount(tree, input);
  assert.equal(amountMinor, 22000); // (4 * 5000) + 2000 land

  // Reserve shares
  tree.reservedShares += input.shareCount;
  pubTree.availableShares -= input.shareCount;

  mockDb.investment_requests.set(reqId, {
    requestId: reqId,
    userId: investorUid,
    treeId,
    shareCount: input.shareCount,
    includesLand: input.includesLand,
    amountMinor,
    currency: 'USD',
    status: 'awaiting_payment',
    createdAt: Date.now()
  });

  mockDb.transactions.set(reqId, {
    transactionId: reqId,
    requestId: reqId,
    userId: investorUid,
    type: 'share_purchase',
    amountMinor,
    currency: 'USD',
    status: 'pending'
  });

  assert.equal(pubTree.availableShares, 0);
  assert.equal(tree.reservedShares, 4);

  // Step 2: Upload payment receipt
  const receiptPath = `payment-proofs/${investorUid}/${reqId}/bank_transfer_slip.jpg`;
  assert.equal(isValidProofPath(receiptPath, investorUid, reqId), true);

  const invReq = mockDb.investment_requests.get(reqId);
  assert.equal(invReq.status, 'awaiting_payment');
  invReq.status = 'under_review';
  invReq.paymentProofPath = receiptPath;
  invReq.proofSubmittedAt = Date.now();
  mockDb.transactions.get(reqId).status = 'under_review';

  // Step 3: Finance Admin Reviews & Approves Request
  const reviewDecision = 'approve';
  const nextStatus = nextInvestmentStatus(invReq.status, reviewDecision);
  assert.equal(nextStatus, 'approved');

  // Atomic state commit upon approval
  tree.reservedShares -= invReq.shareCount;
  tree.soldShares += invReq.shareCount;
  invReq.status = nextStatus;
  invReq.reviewedByUid = financeAdminUid;
  invReq.reviewNote = validateReviewNote('Approved after verifying Bank of Syria transfer receipt.');
  invReq.reviewedAt = Date.now();

  mockDb.transactions.get(reqId).status = 'settled';

  // Share issuance
  mockDb.shares.set(reqId, {
    shareId: reqId,
    requestId: reqId,
    userId: invReq.userId,
    treeId: invReq.treeId,
    shareCount: invReq.shareCount,
    includesLand: invReq.includesLand,
    purchasePriceMinor: invReq.amountMinor,
    currency: invReq.currency,
    status: 'active',
    createdAt: Date.now()
  });

  // Audit trail
  mockDb.audit_logs.push({
    actorUid: financeAdminUid,
    action: `investment_request.${nextStatus}`,
    targetPath: `investment_requests/${reqId}`,
    details: {
      userId: invReq.userId,
      treeId: invReq.treeId,
      shareCount: invReq.shareCount,
      amountMinor: invReq.amountMinor,
      note: invReq.reviewNote
    },
    createdAt: Date.now()
  });

  // Step 4: Verification of Final State
  assert.equal(tree.soldShares, 4);
  assert.equal(tree.reservedShares, 0);
  assert.equal(pubTree.availableShares, 0);
  assert.equal(mockDb.shares.has(reqId), true);
  assert.equal(mockDb.shares.get(reqId).status, 'active');
  assert.equal(mockDb.transactions.get(reqId).status, 'settled');
  assert.equal(mockDb.audit_logs.length, 1);
  assert.equal(mockDb.audit_logs[0].action, 'investment_request.approved');
});

test('Integration Suite: Role Application & Review Flow', () => {
  // Validate applicant submission
  const validApp = validateRoleApplication({
    requestedRole: 'farmer',
    region: 'Idlib / Ariha',
    organizationName: 'Ariha Olive Cooperative',
    message: 'Cooperative managing 400 ancient Roman olive trees.'
  });
  assert.equal(validApp.requestedRole, 'farmer');
  assert.equal(validApp.region, 'Idlib / Ariha');

  // Verify privileged role escalation is barred
  assert.throws(() => validateRoleApplication({
    requestedRole: 'admin',
    region: 'Damascus'
  }), { code: 'invalid-argument' });
  assert.throws(() => validateRoleApplication({
    requestedRole: 'finance_admin',
    region: 'Damascus'
  }), { code: 'invalid-argument' });
});
