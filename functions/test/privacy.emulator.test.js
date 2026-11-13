// Emulator tests: DSGVO self-service (export, deletion) and the admin user directory.
// Run: npm run test:privacy:emulator  (from functions/)
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const projectId = process.env.GCLOUD_PROJECT || 'demo-faseela';
const app = initializeApp({ projectId }, `privacy-${randomUUID()}`);
const auth = getAuth(app);
const db = getFirestore(app, 'faseela-prod');
const base = `http://127.0.0.1:5001/${projectId}/europe-west3`;

async function makeUser(claims, profile = {}) {
  const email = `p-${randomUUID()}@example.test`;
  const password = `Pw-${randomUUID()}!`;
  const user = await auth.createUser({ email, password, emailVerified: true });
  if (claims) await auth.setCustomUserClaims(user.uid, claims);
  await db.doc(`users_private/${user.uid}`).set({ uid: user.uid, email, displayName: 'Test Person', phone: '+49 000', ...profile, createdAt: FieldValue.serverTimestamp() });
  const res = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
  const { idToken } = await res.json();
  return { uid: user.uid, email, idToken };
}

const call = (name, idToken, data = {}) => fetch(`${base}/${name}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` }, body: JSON.stringify({ data })
}).then((r) => r.json());

test.after(() => deleteApp(app));

test('exportMyData returns only the caller\'s records (Art. 15/20)', async () => {
  const me = await makeUser();
  const other = await makeUser();
  await db.doc(`transactions/tx-${me.uid}`).set({ userId: me.uid, amountMinor: 3500, status: 'settled' });
  await db.doc(`transactions/tx-${other.uid}`).set({ userId: other.uid, amountMinor: 9900, status: 'settled' });
  const res = await call('exportMyData', me.idToken);
  assert.equal(res.result.format, 'faseela-data-export/v1');
  assert.equal(res.result.profile.email, me.email);
  assert.deepEqual(res.result.transactions.map((t) => t.id), [`tx-${me.uid}`]);
});

test('deleteMyAccount refuses with active shares, deletes profile + login otherwise (Art. 17)', async () => {
  const holder = await makeUser();
  await db.doc(`shares/s-${holder.uid}`).set({ userId: holder.uid, status: 'active', shareCount: 1 });
  const refused = await call('deleteMyAccount', holder.idToken, { confirmation: 'DELETE' });
  assert.equal(refused.error?.status, 'FAILED_PRECONDITION');

  const wrongWord = await call('deleteMyAccount', holder.idToken, { confirmation: 'yes' });
  assert.equal(wrongWord.error?.status, 'INVALID_ARGUMENT');

  const leaver = await makeUser();
  await db.doc(`transactions/tx-${leaver.uid}`).set({ userId: leaver.uid, amountMinor: 3500, status: 'settled' });
  const ok = await call('deleteMyAccount', leaver.idToken, { confirmation: 'DELETE' });
  assert.equal(ok.result?.deleted, true);
  assert.equal((await db.doc(`users_private/${leaver.uid}`).get()).exists, false, 'profile removed');
  await assert.rejects(auth.getUser(leaver.uid), /no user record/i);
  assert.equal((await db.doc(`transactions/tx-${leaver.uid}`).get()).exists, true, 'financial record kept (pseudonymised)');
});

test('adminListUsers is admin-only and returns no secrets', async () => {
  const admin = await makeUser({ role: 'admin' });
  const investor = await makeUser();
  const denied = await call('adminListUsers', investor.idToken);
  assert.equal(denied.error?.status, 'PERMISSION_DENIED');
  const res = await call('adminListUsers', admin.idToken);
  const row = res.result.users.find((u) => u.uid === investor.uid);
  assert.ok(row, 'investor listed');
  assert.equal(row.emailVerified, true);
  assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'disabled', 'displayName', 'email', 'emailVerified', 'phone', 'region', 'role', 'uid']);
});
