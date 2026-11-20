#!/usr/bin/env node
/**
 * Faseela operations CLI (trusted, server-side only).
 *
 * Uses firebase-admin with Application Default Credentials in production
 * (`gcloud auth application-default login`) or the local emulators when
 * FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST are set.
 *
 * Commands:
 *   seed-trees [--file ../database/seed_data.json] [--dry-run]
 *   set-role <email> <investor|farmer|mill_operator|finance_admin|quality_auditor|admin>
 *   assign-farmer <email> <treeId>
 *   assign-mill <email> <millId>
 *
 * Examples (emulator):
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
 *     GCLOUD_PROJECT=demo-faseela node scripts/admin-cli.js seed-trees
 */
const fs = require('node:fs');
const path = require('node:path');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');
const { buildTreeRecords, uploadGrantId } = require('../domain');

const DATABASE_ID = 'faseela-prod';
const ROLES = ['investor', 'farmer', 'mill_operator', 'finance_admin', 'quality_auditor', 'admin'];
const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace('#!/usr/bin/env node\n', ''));
  process.exit(1);
}

function getServices() {
  const projectId = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID;
  const app = initializeApp(projectId ? { projectId } : undefined);
  // grantsDb: (default) database read by storage.rules for upload permissions (review F-07).
  return { auth: getAuth(app), db: getFirestore(app, DATABASE_ID), grantsDb: getFirestore(app) };
}

async function seedTrees(args) {
  const fileIndex = args.indexOf('--file');
  const file = fileIndex >= 0 ? args[fileIndex + 1] : path.join(__dirname, '../../database/seed_data.json');
  const dryRun = args.includes('--dry-run');
  const data = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  if (!Array.isArray(data.trees) || data.trees.length === 0) usage(`No trees found in ${file}`);

  const records = data.trees.map(buildTreeRecords);
  if (dryRun) {
    console.log(JSON.stringify(records, null, 2));
    return;
  }

  const { db } = getServices();
  let created = 0;
  let skipped = 0;
  for (const { tree, publicTree } of records) {
    const treeRef = db.doc(`trees/${tree.treeId}`);
    const publicRef = db.doc(`trees_public/${tree.treeId}`);
    // Never overwrite live inventory: existing trees may already have sold/reserved shares.
    const wrote = await db.runTransaction(async (transaction) => {
      const existing = await transaction.get(treeRef);
      if (existing.exists) return false;
      transaction.create(treeRef, { ...tree, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      transaction.set(publicRef, { ...publicTree, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      return true;
    });
    if (wrote) created += 1; else skipped += 1;
    console.log(`${wrote ? 'created' : 'skipped (exists)'}: ${tree.treeId}`);
  }
  console.log(`Done. created=${created} skipped=${skipped}`);
}

async function setRole([email, role]) {
  if (!email || !ROLES.includes(role)) usage('set-role requires <email> and a valid role');
  const { auth, db } = getServices();
  const user = await auth.getUserByEmail(email);
  const claims = { ...(user.customClaims || {}) };
  if (role === 'admin') {
    claims.admin = true;
    claims.role = 'admin';
  } else {
    delete claims.admin;
    claims.role = role;
  }
  await auth.setCustomUserClaims(user.uid, claims);
  await db.doc(`users_private/${user.uid}`).set({ role, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await db.collection('audit_logs').add({
    actorUid: 'admin-cli',
    action: 'role.set',
    targetPath: `users_private/${user.uid}`,
    details: { email, role },
    createdAt: FieldValue.serverTimestamp()
  });
  console.log(`Role "${role}" assigned to ${email} (${user.uid}). The user must sign out and in again.`);
}

async function assign(kind, [email, targetId]) {
  if (!email || !ID_PATTERN.test(targetId || '')) usage(`${kind} requires <email> and a valid id`);
  const { auth, db, grantsDb } = getServices();
  const user = await auth.getUserByEmail(email);
  const expectedRole = kind === 'assign-farmer' ? 'farmer' : 'mill_operator';
  if (user.customClaims?.role !== expectedRole) {
    console.warn(`Warning: ${email} does not have role "${expectedRole}" yet. Run set-role first.`);
  }
  const docPath = kind === 'assign-farmer'
    ? `farmer_assignments/${user.uid}/trees/${targetId}`
    : `mill_assignments/${user.uid}/mills/${targetId}`;
  await db.doc(docPath).set({
    [kind === 'assign-farmer' ? 'treeId' : 'millId']: targetId,
    assignedAt: FieldValue.serverTimestamp()
  });
  if (kind === 'assign-farmer') {
    await grantsDb.doc(`upload_grants/${uploadGrantId(user.uid, 'tree', targetId)}`).set({
      uid: user.uid, kind: 'tree', targetId, createdAt: FieldValue.serverTimestamp()
    });
  }
  console.log(`Assigned ${targetId} to ${email} (${docPath}).`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'seed-trees': return seedTrees(args);
    case 'set-role': return setRole(args);
    case 'assign-farmer':
    case 'assign-mill': return assign(command, args);
    default: return usage(command ? `Unknown command "${command}"` : undefined);
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
