// Adversarial regression tests: abuse cases from the 2026-10-17 review must stay blocked.
// Run: npm run test:abuse:emulator  (from functions/)
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

const projectId = process.env.GCLOUD_PROJECT || 'demo-faseela';
const databaseId = 'faseela-prod';
const app = initializeApp({ projectId }, `adversarial-${randomUUID()}`);
const auth = getAuth(app);
const db = getFirestore(app, databaseId);
const grantsDb = getFirestore(app); // (default): upload grants for storage.rules
const base = `http://127.0.0.1:5001/${projectId}/europe-west3`;

async function makeUser(claims) {
  const email = `u-${randomUUID()}@example.test`;
  const password = `Pw-${randomUUID()}!`;
  const user = await auth.createUser({ email, password, emailVerified: true });
  if (claims) await auth.setCustomUserClaims(user.uid, claims);
  const res = await fetch(
    `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) }
  );
  assert.equal(res.ok, true, 'test user must authenticate against the Auth emulator');
  const { idToken } = await res.json();
  return { uid: user.uid, idToken };
}

const call = (name, idToken, data) => fetch(`${base}/${name}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
  body: JSON.stringify({ data })
}).then((r) => r.json());

async function seedTree(totalShares = 4) {
  const treeId = `tree_${randomUUID().slice(0, 8)}`;
  await db.doc(`trees/${treeId}`).set({ totalShares, soldShares: 0, reservedShares: 0, pricePerShareMinor: 4500, landPriceMinor: 0, currency: 'USD' });
  await db.doc(`trees_public/${treeId}`).set({ status: 'listed', availableShares: totalShares });
  return treeId;
}

test.before(() => {
  assert.ok(process.env.FIREBASE_AUTH_EMULATOR_HOST, 'Auth emulator must be running');
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator must be running');
});
test.after(() => deleteApp(app));

test('ABUSE-1 blocked: one account cannot hoard a tree with fresh idempotency keys', async () => {
  const treeId = await seedTree(4);
  const attacker = await makeUser();
  const first = await call('createInvestmentRequest', attacker.idToken, { treeId, shareCount: 1, idempotencyKey: randomUUID() });
  assert.equal(first.result?.status, 'awaiting_payment', 'first request is legitimate');

  const second = await call('createInvestmentRequest', attacker.idToken, { treeId, shareCount: 1, idempotencyKey: randomUUID() });
  assert.equal(second.error?.status, 'ALREADY_EXISTS', 'second open request on the same tree is rejected');

  const pub = (await db.doc(`trees_public/${treeId}`).get()).data();
  assert.equal(pub.availableShares, 3, 'only one share is held');

  const victim = await makeUser();
  const fair = await call('createInvestmentRequest', victim.idToken, { treeId, shareCount: 1, idempotencyKey: randomUUID() });
  assert.equal(fair.result?.status, 'awaiting_payment', 'other investors can still reserve');
});

test('ABUSE-1b blocked: one account cannot sweep many trees', async () => {
  const attacker = await makeUser();
  const statuses = [];
  for (let i = 0; i < 4; i += 1) {
    const treeId = await seedTree(4);
    const res = await call('createInvestmentRequest', attacker.idToken, { treeId, shareCount: 1, idempotencyKey: randomUUID() });
    statuses.push(res.result?.status || res.error?.status);
  }
  assert.deepEqual(statuses, ['awaiting_payment', 'awaiting_payment', 'awaiting_payment', 'RESOURCE_EXHAUSTED']);
});

test('Idempotent replay still works under the quota', async () => {
  const treeId = await seedTree(4);
  const investor = await makeUser();
  const key = randomUUID();
  const a = await call('createInvestmentRequest', investor.idToken, { treeId, shareCount: 2, idempotencyKey: key });
  const b = await call('createInvestmentRequest', investor.idToken, { treeId, shareCount: 2, idempotencyKey: key });
  assert.equal(a.result?.requestId, b.result?.requestId, 'same key returns the same request instead of a quota error');
  const grant = await grantsDb.doc(`upload_grants/${investor.uid}__payment__${a.result.requestId}`).get();
  assert.equal(grant.exists, true, 'an upload grant is mirrored for storage.rules');
  await call('cancelInvestmentRequest', investor.idToken, { requestId: a.result.requestId });
  assert.equal((await grantsDb.doc(`upload_grants/${investor.uid}__payment__${a.result.requestId}`).get()).exists, false, 'grant removed on cancel');
});

test('ABUSE-2 blocked: finance_admin cannot approve their own investment', async () => {
  const treeId = await seedTree(4);
  const insider = await makeUser({ role: 'finance_admin' });
  const created = await call('createInvestmentRequest', insider.idToken, { treeId, shareCount: 2, idempotencyKey: randomUUID() });
  const requestId = created.result.requestId;
  // Storage emulator is not started; simulate the submitted proof directly.
  await db.doc(`investment_requests/${requestId}`).update({ status: 'under_review', paymentProofPath: `payment-proofs/${insider.uid}/${requestId}/proof.pdf` });

  const selfDecision = await call('reviewInvestmentRequest', insider.idToken, { requestId, decision: 'approve' });
  assert.equal(selfDecision.error?.status, 'PERMISSION_DENIED');
  assert.equal((await db.doc(`shares/${requestId}`).get()).exists, false, 'no share was minted');

  const colleague = await makeUser({ role: 'finance_admin' });
  const fourEyes = await call('reviewInvestmentRequest', colleague.idToken, { requestId, decision: 'approve' });
  assert.equal(fourEyes.result?.status, 'approved', 'a second reviewer can approve');
});
