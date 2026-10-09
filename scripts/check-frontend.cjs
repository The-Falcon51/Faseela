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
