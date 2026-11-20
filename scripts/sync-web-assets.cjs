#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const androidPublicDir = path.join(rootDir, 'android/app/src/main/assets/public');
const faseelaDir = path.join(rootDir, 'Faseela');

// Everything the web app ships, except the original JPEG photos (the app uses the
// WebP versions) and build-only license notes. Keeps Android in lockstep with public/.
function listShippedFiles(dir, base = '') {
  return fs.readdirSync(path.join(dir, base), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.posix.join(base, entry.name);
    if (entry.isDirectory()) return listShippedFiles(dir, rel);
    if (/\.(jpe?g)$/i.test(entry.name) || entry.name.endsWith('.LEGAL.txt') || entry.name === '.DS_Store') return [];
    return [rel];
  });
}
const syncedFiles = listShippedFiles(publicDir);

const checkOnly = process.argv.includes('--check');
const includeFaseela = process.argv.includes('--include-faseela');

let driftDetected = false;

function compareOrCopy(srcPath, destPath, relName, label) {
  if (!fs.existsSync(srcPath)) return;
  const srcContent = fs.readFileSync(srcPath);

  if (checkOnly) {
    if (!fs.existsSync(destPath)) {
      console.error(`[DRIFT] Missing in ${label}: ${relName}`);
      driftDetected = true;
      return;
    }
    const destContent = fs.readFileSync(destPath);
    if (!srcContent.equals(destContent)) {
      console.error(`[DRIFT] Out of sync in ${label}: ${relName}`);
      driftDetected = true;
    }
  } else {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, srcContent);
  }
}

for (const rel of syncedFiles) {
  const src = path.join(publicDir, rel);
  const destAndroid = path.join(androidPublicDir, rel);
  compareOrCopy(src, destAndroid, rel, 'android');

  if (includeFaseela) {
    const destFaseela = path.join(faseelaDir, rel);
    compareOrCopy(src, destFaseela, rel, 'Faseela');
  }
}

if (checkOnly) {
  if (driftDetected) {
    console.error('Web assets are out of sync! Run "npm run sync" to reconcile.');
    process.exit(1);
  }
  console.log('✅ Web assets are in sync across platforms.');
} else {
  console.log(`✅ Successfully synced web assets to Android${includeFaseela ? ' and Faseela' : ''}.`);
}
