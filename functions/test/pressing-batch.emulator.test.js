const { randomUUID } = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

const projectId = 'demo-faseela';
const databaseId = 'faseela-prod';
const suffix = randomUUID();
const treeId = `tree_${suffix}`;
const millId = `mill_${suffix}`;
const email = `mill-${suffix}@example.test`;
const password = `Test-${randomUUID()}!`;
const app = initializeApp({ projectId }, `pressing-batch-${suffix}`);
const auth = getAuth(app);
const db = getFirestore(app, databaseId);
let user;
let batchId;

test('assigned mill operator submits a pending batch; unassigned mill is denied', async (t) => {
  t.after(async () => {
    if (user) {
      const cleanup = [
        db.doc(`mill_assignments/${user.uid}/mills/${millId}`).delete(),
        db.doc(`trees/${treeId}`).delete(),
        db.doc(`trees_public/${treeId}`).delete(),
        auth.deleteUser(user.uid)
      ];
      if (batchId) cleanup.push(db.doc(`pressing_batches/${batchId}`).delete());
      await Promise.all(cleanup);
    }
    await deleteApp(app);
  });

  assert.ok(process.env.FIREBASE_AUTH_EMULATOR_HOST, 'Auth emulator must be running');
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator must be running');

  user = await auth.createUser({ email, password });
  await auth.setCustomUserClaims(user.uid, { role: 'mill_operator' });
  await db.doc(`mill_assignments/${user.uid}/mills/${millId}`).set({ millId });
  await db.doc(`trees/${treeId}`).set({ status: 'active' });
  await db.doc(`trees_public/${treeId}`).set({ status: 'listed' });

  const authResponse = await fetch(
    `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    }
  );
  assert.equal(authResponse.ok, true, 'operator should authenticate through the Auth emulator');
  const { idToken } = await authResponse.json();
  const endpoint = `http://127.0.0.1:5001/${projectId}/europe-west3/submitPressingBatch`;
  const batch = {
    treeId,
    millId,
    olivesWeightKg: 100,
    oilYieldLiters: 18,
    temperatureCelsius: 24,
    acidityPct: 0.3,
    peroxideValue: 6
  };

  const submit = (payload) => fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`
    },
    body: JSON.stringify({ data: payload })
  });

  const acceptedResponse = await submit(batch);
  assert.equal(acceptedResponse.ok, true, 'assigned operator batch should be accepted');
  const accepted = await acceptedResponse.json();
  assert.equal(accepted.result.status, 'pending_review');
  assert.ok(accepted.result.batchId);
  batchId = accepted.result.batchId;

  const savedBatch = await db.doc(`pressing_batches/${accepted.result.batchId}`).get();
  assert.equal(savedBatch.data().status, 'pending_review');
  assert.equal(savedBatch.data().submittedByUid, user.uid);

  const deniedResponse = await submit({ ...batch, millId: `unassigned_${suffix}` });
  assert.equal(deniedResponse.ok, false, 'unassigned mill must be denied');
  const denied = await deniedResponse.json();
  assert.equal(denied.error.status, 'PERMISSION_DENIED');
});
