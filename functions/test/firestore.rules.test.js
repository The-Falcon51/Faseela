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
  doc,
  getDoc,
  serverTimestamp,
  setDoc
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

test('farmers can submit bounded pending reports only for assigned trees', async () => {
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(databaseId), 'farmer_assignments/farmer-rules-test/trees/tree-assigned-test'), {
      treeId: 'tree-assigned-test'
    });
  });

  const farmerDb = testEnvironment.authenticatedContext('farmer-rules-test', {
    role: 'farmer'
  }).firestore(databaseId);
  await assertSucceeds(setDoc(doc(farmerDb, 'farmer_updates/assigned-report-test'), {
    farmerUid: 'farmer-rules-test',
    treeId: 'tree-assigned-test',
    eventType: 'watering',
    notes: 'Watering completed',
    mediaPaths: [],
    status: 'pending_review',
    createdAt: serverTimestamp()
  }));
  await assertFails(setDoc(doc(farmerDb, 'farmer_updates/unassigned-report-test'), {
    farmerUid: 'farmer-rules-test',
    treeId: 'tree-not-assigned',
    eventType: 'watering',
    notes: 'Watering completed',
    mediaPaths: [],
    status: 'pending_review',
    createdAt: serverTimestamp()
  }));
  await assertFails(setDoc(doc(farmerDb, 'tree_events_public/fake-published-event'), {
    treeId: 'tree-assigned-test',
    status: 'published'
  }));
});