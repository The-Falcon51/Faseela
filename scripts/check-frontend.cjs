const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const htmlFiles = [
  'public/index.html',
  'Faseela/index.html',
  'android/app/src/main/assets/public/index.html'
];

for (const relativePath of htmlFiles) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  if (!fs.existsSync(filePath)) continue;
  const html = fs.readFileSync(filePath, 'utf8');
  const scriptTag = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match;
  let inlineScriptIndex = 0;

  while ((match = scriptTag.exec(html)) !== null) {
    const [, attributes, source] = match;
    if (/\bsrc\s*=/.test(attributes) || !source.trim()) continue;
    if (/\btype\s*=\s*["']application\/(?:ld\+)?json["']/i.test(attributes)) continue;

    inlineScriptIndex += 1;
    try {
      new vm.Script(source, { filename: `${relativePath}#inline-${inlineScriptIndex}` });
    } catch (error) {
      process.stderr.write(`${error.stack}\n`);
      process.exitCode = 1;
    }
  }
}

// ---------------------------------------------------------------------------
// CSP origin guard: every external script/module origin must be allowed by the
// page's script-src, and the Supabase API + Realtime hosts by connect-src. Prevents a
// silent regression where the CSP blocks the backend (review finding F-01).
// ---------------------------------------------------------------------------
const SUPABASE_HOSTS = ['https://riyvlhlhzxxerlwqoxsy.supabase.co', 'wss://riyvlhlhzxxerlwqoxsy.supabase.co'];

function parseCsp(html) {
  const meta = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
  if (!meta) return null;
  return Object.fromEntries(meta[1].split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [name, ...sources] = part.split(/\s+/);
    return [name.toLowerCase(), sources];
  }));
}

function allowedBy(sources, url) {
  const { protocol, host } = new URL(url);
  const origin = `${protocol}//${host}`;
  return sources.some((source) => source === origin || (source.endsWith('/') && url.startsWith(source)));
}

// Faseela/ is a separate nested repository (legacy copy) and not a shipped target.
const shippedHtmlFiles = [...htmlFiles.filter((file) => !file.startsWith('Faseela/')), 'public/auth/reset.html']
  .filter((file) => fs.existsSync(path.resolve(__dirname, '..', file)));

for (const relativePath of shippedHtmlFiles) {
  const dir = path.dirname(path.resolve(__dirname, '..', relativePath));
  const html = fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');
  const csp = parseCsp(html);
  if (!csp) {
    process.stderr.write(`[CSP] ${relativePath}: no Content-Security-Policy meta tag found\n`);
    process.exitCode = 1;
    continue;
  }
  const scriptSrc = csp['script-src'] || csp['default-src'] || [];
  const connectSrc = csp['connect-src'] || csp['default-src'] || [];

  const externalScripts = [...html.matchAll(/<script\b[^>]*\bsrc="(https:[^"]+)"/gi)].map((m) => m[1]);
  const clientPath = path.join(dir, relativePath.includes('/auth/') ? '../supabase-client.mjs' : 'supabase-client.mjs');
  const moduleImports = fs.existsSync(clientPath)
    ? [...fs.readFileSync(clientPath, 'utf8').matchAll(/from\s*['"](https:[^'"]+)['"]/g)].map((m) => m[1])
    : [];
  if (!fs.existsSync(clientPath)) {
    process.stderr.write(`[BUILD] ${relativePath}: supabase-client.mjs missing (run npm run build:web)\n`);
    process.exitCode = 1;
  }

  for (const url of [...externalScripts, ...moduleImports]) {
    if (!allowedBy(scriptSrc, url)) {
      process.stderr.write(`[CSP] ${relativePath}: script-src blocks ${url}\n`);
      process.exitCode = 1;
    }
  }
  for (const host of SUPABASE_HOSTS) {
    if (!allowedBy(connectSrc, host)) {
      process.stderr.write(`[CSP] ${relativePath}: connect-src blocks ${host}\n`);
      process.exitCode = 1;
    }
  }
  if (/'unsafe-inline'/.test((scriptSrc || []).join(' '))) {
    process.stderr.write(`[CSP] ${relativePath}: script-src must not allow 'unsafe-inline' (use data-* delegation, public/events.js)\n`);
    process.exitCode = 1;
  }
  if (/firebase-client\.mjs/.test(html)) {
    process.stderr.write(`[BUILD] ${relativePath}: still references the retired Firebase client\n`);
    process.exitCode = 1;
  }
}

// Inline-handler guard: no on*= attributes or javascript: URLs may ship (CSP without 'unsafe-inline').
for (const file of ['public/index.html', 'public/app.js', 'public/auth/reset.html']) {
  const filePath = path.resolve(__dirname, '..', file);
  if (!fs.existsSync(filePath)) continue;
  const source = fs.readFileSync(filePath, 'utf8');
  const inline = source.match(/\bon(?:click|change|input|submit|keydown|keyup|scroll|load|error|focus|blur|mouseover|mouseenter)\s*=\s*\\?"/g) || [];
  if (inline.length) {
    process.stderr.write(`[CSP] ${file}: ${inline.length} inline event handler attribute(s) found\n`);
    process.exitCode = 1;
  }
  if (/href=\\?"javascript:/.test(source)) {
    process.stderr.write(`[CSP] ${file}: javascript: URL found\n`);
    process.exitCode = 1;
  }
}

// Secret guard: only the publishable key may ship in the client bundle.
for (const file of ['public/supabase-client.mjs', 'src/supabase-client.src.mjs']) {
  const filePath = path.resolve(__dirname, '..', file);
  if (!fs.existsSync(filePath)) continue;
  const source = fs.readFileSync(filePath, 'utf8');
  if (/sb_secret_[A-Za-z0-9_-]+|service_role/.test(source)) {
    process.stderr.write(`[SECRET] ${file}: contains a Supabase secret/service-role key\n`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Self-hosting guard (review F-06/F-10): shipped pages may not load scripts,
// styles or fonts from third-party origins at runtime.
// ---------------------------------------------------------------------------
for (const relativePath of shippedHtmlFiles) {
  const html = fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');
  const offenders = [
    ...html.matchAll(/<script\b[^>]*\bsrc="(https?:[^"]+)"/gi),
    ...html.matchAll(/<link\b[^>]*\bhref="(https?:[^"]+)"[^>]*rel="(?:stylesheet|preload|preconnect)"/gi),
    ...html.matchAll(/<link\b[^>]*rel="(?:stylesheet|preload|preconnect)"[^>]*\bhref="(https?:[^"]+)"/gi)
  ].map((m) => m[1]);
  for (const url of new Set(offenders)) {
    process.stderr.write(`[SELF-HOST] ${relativePath}: third-party asset ${url}\n`);
    process.exitCode = 1;
  }
  if (/unsafe-eval/.test(html)) {
    process.stderr.write(`[CSP] ${relativePath}: 'unsafe-eval' is not allowed\n`);
    process.exitCode = 1;
  }
}
