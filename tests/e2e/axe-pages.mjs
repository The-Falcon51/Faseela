// axe sweep across pages (light + dark) — collects contrast failures with their colors/classes.
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
const b = await chromium.launch({ executablePath: process.env.CHR });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
const p = await ctx.newPage();
await p.goto('http://localhost:8099/index.html', { waitUntil: 'load' }); await p.waitForTimeout(2000);
const pages = (process.env.PAGES || 'home,marketplace,tree-detail,dashboard').split(',');
const out = {};
for (const theme of ['light', 'dark']) {
  await p.evaluate((t) => document.documentElement.classList.toggle('dark', t === 'dark'), theme);
  for (const pg of pages) {
    await p.evaluate((id) => { try { state.currentUser = state.currentUser || { role: 'admin', email_verified: true, name: 'QA' }; navigateTo(id); } catch (e) { console.log(e.message); } }, pg);
    await p.waitForTimeout(700);
    const r = await new AxeBuilder({ page: p }).include(`#page-${pg}`).withTags(['wcag2a', 'wcag2aa']).analyze();
    for (const v of r.violations) for (const n of v.nodes) {
      const key = `${v.id}|${(n.any[0]?.data?.fgColor || '')}|${(n.any[0]?.data?.bgColor || '')}`;
      const cls = (n.html.match(/class="([^"]*)"/) || [])[1] || '';
      const textCls = cls.split(' ').filter((c) => /^(dark:)?text-/.test(c)).join(' ');
      (out[key] ||= { count: 0, themes: new Set(), pages: new Set(), cls: new Set(), sample: n.html.slice(0, 110) });
      out[key].count++; out[key].themes.add(theme); out[key].pages.add(pg); out[key].cls.add(textCls);
    }
  }
}
for (const [k, v] of Object.entries(out).sort((a, b) => b[1].count - a[1].count))
  console.log(v.count, k, [...v.themes].join('/'), [...v.pages].join(','), '|', [...v.cls].slice(0, 4).join(' ; '), '|', v.sample.replace(/\s+/g, ' '));
await b.close();
