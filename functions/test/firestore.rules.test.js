const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment
} = require('@firebase/rules-unit-testing');
const {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where
} = require('firebase/firestore');

const projectId = 'demo-faseela';
const databaseId = 'faseela-prod';
let testEnvironment;

test.before(async () => {
  const rules = fs.readFileSync(path.join(__dirname, '../../firestore.rules'), 'utf8');
  testEnvironment = await initializeTestEnvironment({
    projectId,
    firestore: {
      rules,
      host: '127.0.0.1',
      port: 8080
    }
  });
});

test.after(async () => {
  await testEnvironment?.cleanup();
});

test('guests can read listed trees but not unpublished listings', async () => {
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore(databaseId);
    await setDoc(doc(db, 'trees_public/listed-rules-test'), { status: 'listed', name: 'Listed tree' });
    await setDoc(doc(db, 'trees_public/unlisted-rules-test'), { status: 'draft', name: 'Draft tree' });
  });

  const guestDb = testEnvironment.unauthenticatedContext().firestore(databaseId);
  await assertSucceeds(getDoc(doc(guestDb, 'trees_public/listed-rules-test')));
  await assertFails(getDoc(doc(guestDb, 'trees_public/unlisted-rules-test')));
});

test('private profiles are owner-only and clients cannot assign roles', async () => {
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(databaseId), 'users_private/profile-owner-test'), {
      uid: 'profile-owner-test',
      email: 'owner@example.test',
      role: 'investor'
    });
  });

  const ownerDb = testEnvironment.authenticatedContext('profile-owner-test').firestore(databaseId);
  const otherDb = testEnvironment.authenticatedContext('profile-other-test').firestore(databaseId);
  await assertSucceeds(getDoc(doc(ownerDb, 'users_private/profile-owner-test')));
  await assertFails(getDoc(doc(otherDb, 'users_private/profile-owner-test')));
  await assertFails(setDoc(doc(ownerDb, 'users_private/profile-owner-test'), {
    uid: 'profile-owner-test',
    email: 'owner@example.test',
    role: 'admin'
  }));
});

test('browser clients cannot create or approve financial records', async () => {
  const investorDb = testEnvironment.authenticatedContext('investor-rules-test', {
    email_verified: true
  }).firestore(databaseId);

  await assertFails(setDoc(doc(investorDb, 'transactions/fake-payment-test'), {
    userId: 'investor-rules-test',
    status: 'settled',
    amountMinor: 100
  }));
  await assertFails(setDoc(doc(investorDb, 'shares/fake-share-test'), {
    userId: 'investor-rules-test',
    status: 'active',
    shareCount: 1
  }));
});

test('farmer reports are function-only: clients cannot write them, even for assigned trees', async () => {
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(databaseId), 'farmer_assignments/farmer-rules-test/trees/tree-assigned-test'), {
      treeId: 'tree-assigned-test'
    });
  });

  const farmerDb = testEnvironment.authenticatedContext('farmer-rules-test', {
    role: 'farmer'
  }).firestore(databaseId);
  await assertFails(setDoc(doc(farmerDb, 'farmer_updates/assigned-report-test'), {
    farmerUid: 'farmer-rules-test',
    treeId: 'tree-assigned-test',
    eventType: 'watering',
    notes: 'Watering completed',
    mediaPaths: ['field-media/other-farmer/tree-assigned-test/stolen.jpg'],
    status: 'pending_review',
    createdAt: serverTimestamp()
  }));
  await assertFails(setDoc(doc(farmerDb, 'tree_events_public/fake-published-event'), {
    treeId: 'tree-assigned-test',
    status: 'published'
  }));
});

test('farmers can list only their own reports', async () => {
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore(databaseId);
    await setDoc(doc(db, 'farmer_updates/own-report-test'), { farmerUid: 'farmer-list-test', status: 'pending_review' });
    await setDoc(doc(db, 'farmer_updates/foreign-report-test'), { farmerUid: 'farmer-other-test', status: 'pending_review' });
  });
  const farmerDb = testEnvironment.authenticatedContext('farmer-list-test', { role: 'farmer' }).firestore(databaseId);
  await assertSucceeds(getDocs(query(collection(farmerDb, 'farmer_updates'), where('farmerUid', '==', 'farmer-list-test'))));
  await assertFails(getDoc(doc(farmerDb, 'farmer_updates/foreign-report-test')));
  await assertFails(getDocs(collection(farmerDb, 'farmer_updates')));
});

test('role applications are owner/admin readable, admin listable, and never client-writable', async () => {
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(databaseId), 'role_applications/applicant-rules-test'), {
      userId: 'applicant-rules-test',
      requestedRole: 'farmer',
      region: 'North',
      organizationName: 'Test Co-op',
      message: 'Please approve',
      status: 'pending',
      submittedAt: new Date(),
      reviewedAt: null,
      reviewedByUid: null,
      reviewNote: null
    });
  });

  const ownerDb = testEnvironment.authenticatedContext('applicant-rules-test').firestore(databaseId);
  const otherDb = testEnvironment.authenticatedContext('applicant-other-test').firestore(databaseId);
  const adminDb = testEnvironment.authenticatedContext('admin-rules-test', { admin: true }).firestore(databaseId);

  await assertSucceeds(getDoc(doc(ownerDb, 'role_applications/applicant-rules-test')));
  await assertFails(getDoc(doc(otherDb, 'role_applications/applicant-rules-test')));
  await assertSucceeds(getDocs(collection(adminDb, 'role_applications')));
  await assertFails(getDocs(collection(ownerDb, 'role_applications')));
  await assertFails(setDoc(doc(ownerDb, 'role_applications/applicant-rules-test'), {
    userId: 'applicant-rules-test',
    requestedRole: 'farmer',
    status: 'approved'
  }));
});

test('investors can query their own investment requests but not read others', async () => {
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore(databaseId);
    await setDoc(doc(db, 'investment_requests/own-request-test'), {
      userId: 'investor-query-test',
      status: 'pending'
    });
    await setDoc(doc(db, 'investment_requests/foreign-request-test'), {
      userId: 'investor-foreign-test',
      status: 'pending'
    });
  });

  const investorDb = testEnvironment.authenticatedContext('investor-query-test').firestore(databaseId);
  await assertSucceeds(getDocs(query(
    collection(investorDb, 'investment_requests'),
    where('userId', '==', 'investor-query-test')
  )));
  await assertFails(getDoc(doc(investorDb, 'investment_requests/foreign-request-test')));
  await assertFails(getDocs(collection(investorDb, 'investment_requests')));
});

test('pressing batches are submitter/reviewer only, even when certified', async () => {
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore(databaseId);
    await setDoc(doc(db, 'pressing_batches/certified-batch-test'), {
      status: 'certified',
      submittedByUid: 'mill-rules-test'
    });
    await setDoc(doc(db, 'pressing_batches/pending-batch-test'), {
      status: 'pending_review',
      submittedByUid: 'mill-rules-test'
    });
  });

  const guestDb = testEnvironment.unauthenticatedContext().firestore(databaseId);
  const submitterDb = testEnvironment.authenticatedContext('mill-rules-test', {
    role: 'mill_operator'
  }).firestore(databaseId);

  const otherMillDb = testEnvironment.authenticatedContext('mill-other-test', { role: 'mill_operator' }).firestore(databaseId);
  const auditorDb = testEnvironment.authenticatedContext('auditor-rules-test', { role: 'quality_auditor' }).firestore(databaseId);

  await assertFails(getDoc(doc(guestDb, 'pressing_batches/certified-batch-test')));
  await assertFails(getDoc(doc(guestDb, 'pressing_batches/pending-batch-test')));
  await assertFails(getDoc(doc(otherMillDb, 'pressing_batches/certified-batch-test')));
  await assertSucceeds(getDoc(doc(submitterDb, 'pressing_batches/pending-batch-test')));
  await assertSucceeds(getDocs(query(collection(submitterDb, 'pressing_batches'), where('submittedByUid', '==', 'mill-rules-test'))));
  await assertSucceeds(getDoc(doc(auditorDb, 'pressing_batches/certified-batch-test')));
});

test('audit logs are readable by admins only', async () => {
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(databaseId), 'audit_logs/audit-event-test'), {
      action: 'role_application_approved',
      actorUid: 'admin-rules-test'
    });
  });

  const adminDb = testEnvironment.authenticatedContext('admin-rules-test', { admin: true }).firestore(databaseId);
  const userDb = testEnvironment.authenticatedContext('audit-user-test').firestore(databaseId);
  const guestDb = testEnvironment.unauthenticatedContext().firestore(databaseId);

  await assertSucceeds(getDoc(doc(adminDb, 'audit_logs/audit-event-test')));
  await assertSucceeds(getDocs(collection(adminDb, 'audit_logs')));
  await assertFails(getDoc(doc(userDb, 'audit_logs/audit-event-test')));
  await assertFails(getDoc(doc(guestDb, 'audit_logs/audit-event-test')));
});