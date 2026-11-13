// Visual snapshots of key views (mobile + desktop, light + dark) for before/after comparison.
import { chromium } from 'playwright';
const out = process.argv[2];
const b = await chromium.launch({ executablePath: process.env.CHR || undefined });
const errs = [];
for (const [w, h] of [[390, 844], [1280, 900]]) {
  for (const theme of ['light', 'dark']) {
    const p = await (await b.newContext({ viewport: { width: w, height: h } })).newPage();
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto('http://localhost:8099/index.html', { waitUntil: 'load' });
    await p.evaluate((t) => document.documentElement.classList.toggle('dark', t === 'dark'), theme);
    await p.waitForTimeout(800);
    for (const page of ['home', 'marketplace']) {
      await p.evaluate((id) => navigateTo(id), page);
      await p.waitForTimeout(600);
      await p.screenshot({ path: `${out}/${page}-${w}-${theme}.png`, fullPage: false });
    }
    await p.evaluate(() => { openModal('modal-invest'); });
    await p.waitForTimeout(500);
    await p.screenshot({ path: `${out}/invest-${w}-${theme}.png` });
  }
}
console.log(JSON.stringify({ errs }));
await b.close();
