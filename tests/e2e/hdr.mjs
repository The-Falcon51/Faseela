import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: process.env.CHR });
for (const w of [360, 375, 390, 414]) {
  const p = await (await b.newContext({ viewport: { width: w, height: 800 } })).newPage();
  await p.goto('http://localhost:8099/index.html', { waitUntil: 'load' }); await p.waitForTimeout(1200);
  const r = await p.evaluate(() => {
    const W = document.documentElement.clientWidth;
    const pick = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right), Math.round(r.width)]; };
    return { W, scrollW: document.documentElement.scrollWidth, toggle: pick('#mobile-nav-toggle'), bell: pick('#btn-notifications-bell'), cur: pick('#btn-currency-selector'), lang: pick('#btn-navbar-lang'), sess: pick('#btn-user-session'), calOlive: pick('#cal-btn-olive') };
  });
  console.log(w, JSON.stringify(r));
}
await b.close();
