// Storage rules test (review F-07). Cross-service rules cannot read the named database
// faseela-prod, so uploads are authorised by server-written grants in (default)/upload_grants.
// Run: npm run test:storage:rules
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertFails, assertSucceeds, initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc } = require('firebase/firestore');
const { ref, uploadBytes } = require('firebase/storage');

const projectId = 'demo-faseela';
let env;

test.before(async () => {
  env = await initializeTestEnvironment({
    projectId,
    firestore: { rules: fs.readFileSync(path.join(__dirname, '../../firestore.default.rules'), 'utf8'), host: '127.0.0.1', port: 8080 },
    storage: { rules: fs.readFileSync(path.join(__dirname, '../../storage.rules'), 'utf8'), host: '127.0.0.1', port: 9199 }
  });
  await env.withSecurityRulesDisabled(async (context) => {
    const grants = context.firestore(); // (default) database
    const inOneHour = new Date(Date.now() + 3600 * 1000);
    await setDoc(doc(grants, 'upload_grants/investor-a__payment__req-open'), { uid: 'investor-a', kind: 'payment', targetId: 'req-open', expiresAt: inOneHour });
    await setDoc(doc(grants, 'upload_grants/investor-a__payment__req-expired'), { uid: 'investor-a', kind: 'payment', targetId: 'req-expired', expiresAt: new Date(Date.now() - 1000) });
    await setDoc(doc(grants, 'upload_grants/farmer-a__tree__tree-1'), { uid: 'farmer-a', kind: 'tree', targetId: 'tree-1' });
  });
});

test.after(() => env?.cleanup());

const pdf = () => new Uint8Array([37, 80, 68, 70, 45]); // "%PDF-"

test('owner can upload a receipt while holding a valid payment grant', async () => {
  const storage = env.authenticatedContext('investor-a').storage();
  await assertSucceeds(uploadBytes(ref(storage, 'payment-proofs/investor-a/req-open/r.pdf'), pdf(), { contentType: 'application/pdf' }));
});

test('uploads are denied without grant, after expiry, for wrong types and for other users', async () => {
  const owner = env.authenticatedContext('investor-a').storage();
  const intruder = env.authenticatedContext('investor-b').storage();
  await assertFails(uploadBytes(ref(owner, 'payment-proofs/investor-a/req-without-grant/r.pdf'), pdf(), { contentType: 'application/pdf' }));
  await assertFails(uploadBytes(ref(owner, 'payment-proofs/investor-a/req-expired/r.pdf'), pdf(), { contentType: 'application/pdf' }));
  await assertFails(uploadBytes(ref(owner, 'payment-proofs/investor-a/req-open/r.html'), pdf(), { contentType: 'text/html' }));
  await assertFails(uploadBytes(ref(intruder, 'payment-proofs/investor-a/req-open/r.pdf'), pdf(), { contentType: 'application/pdf' }));
  await assertFails(uploadBytes(ref(intruder, 'payment-proofs/investor-b/req-open/r.pdf'), pdf(), { contentType: 'application/pdf' }));
});

test('assigned farmer can upload field media, unassigned cannot', async () => {
  const farmer = env.authenticatedContext('farmer-a', { role: 'farmer' }).storage();
  await assertSucceeds(uploadBytes(ref(farmer, 'field-media/farmer-a/tree-1/p.jpg'), pdf(), { contentType: 'image/jpeg' }));
  await assertFails(uploadBytes(ref(farmer, 'field-media/farmer-a/tree-9/p.jpg'), pdf(), { contentType: 'image/jpeg' }));
  const investorAsFarmer = env.authenticatedContext('farmer-a').storage(); // missing farmer role claim
  await assertFails(uploadBytes(ref(investorAsFarmer, 'field-media/farmer-a/tree-1/p.jpg'), pdf(), { contentType: 'image/jpeg' }));
  assert.ok(true);
});

test('the grants database is closed to every client', async () => {
  const user = env.authenticatedContext('investor-a').firestore();
  const { getDoc } = require('firebase/firestore');
  await assertFails(getDoc(doc(user, 'upload_grants/investor-a__payment__req-open')));
  await assertFails(setDoc(doc(user, 'upload_grants/investor-a__payment__forged'), { uid: 'investor-a', kind: 'payment', expiresAt: new Date(Date.now() + 1e9) }));
});
