#!/usr/bin/env node
// Ties the page to the exact code it was built with.
//
// Without this, index.html and app.js are two independently cached files: on a weak connection a device can get the
// new page and fall back to an OLD cached app.js, which then lacks texts the new page refers to (a label shows its
// key instead of its text). Every code and style URL in index.html therefore carries ?v=<build id>, and the service
// worker's cache name and precache list carry the same id. A cached file can only ever answer for the build it
// belongs to.
//
//   node scripts/version-assets.cjs          writes the id into public/index.html and public/sw.js
//   node scripts/version-assets.cjs --check  fails when they are out of date (part of `npm run build`)
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const pub = path.resolve(__dirname, '..', 'public');
// Referenced by index.html with a version.
const VERSIONED = ['events.js', 'app.js', 'assistant-knowledge.js', 'shop.js', 'supabase-client.mjs', 'assets/tailwind.css'];
// Loaded by the versioned files themselves; they change the build id too.
const ALSO_HASHED = ['i18n-de.js', 'data-mappers.mjs'];

function buildId() {
  const hash = crypto.createHash('sha256');
  for (const file of [...VERSIONED, ...ALSO_HASHED]) {
    hash.update(file);
    hash.update(fs.readFileSync(path.join(pub, file)));
  }
  return hash.digest('hex').slice(0, 12);
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function versioned(id) {
  let html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  let sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');
  for (const file of VERSIONED) {
    const ref = new RegExp(`((?:src|href)="(?:\\./)?${escapeRe(file)})(?:\\?v=[0-9a-f]+)?"`, 'g');
    if (!ref.test(html)) throw new Error(`index.html does not reference ${file}`);
    html = html.replace(ref, `$1?v=${id}"`);
    const precache = new RegExp(`('\\./${escapeRe(file)})(?:\\?v=[0-9a-f]+)?'`, 'g');
    if (!precache.test(sw)) throw new Error(`sw.js does not precache ${file}`);
    sw = sw.replace(precache, `$1?v=${id}'`);
  }
  const meta = /<meta name="faseela-build" content="[0-9a-f]*">/;
  if (!meta.test(html)) throw new Error('index.html has no <meta name="faseela-build">');
  html = html.replace(meta, `<meta name="faseela-build" content="${id}">`);
  const cacheVersion = /const CACHE_VERSION = '[^']*';/;
  if (!cacheVersion.test(sw)) throw new Error('sw.js has no CACHE_VERSION');
  sw = sw.replace(cacheVersion, `const CACHE_VERSION = 'b${id}';`);
  return { html, sw };
}

function run(checkOnly) {
  const id = buildId();
  const next = versioned(id);
  const files = [['index.html', next.html], ['sw.js', next.sw]];
  const stale = files.filter(([name, content]) => fs.readFileSync(path.join(pub, name), 'utf8') !== content).map(([name]) => name);
  if (checkOnly) {
    if (stale.length) {
      process.stderr.write(`[VERSION] ${stale.join(', ')} do not carry the current build id ${id}. Run: npm run build:web\n`);
      process.exit(1);
    }
    process.stdout.write(`✅ Page and code carry the same build id (${id}).\n`);
    return id;
  }
  for (const [name, content] of files) fs.writeFileSync(path.join(pub, name), content);
  return id;
}

module.exports = { run, buildId };
if (require.main === module) run(process.argv.includes('--check'));
