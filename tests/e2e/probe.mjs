// Runtime probe: console errors, CSP violations, network, a11y (axe), basic perf timings.
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const browser = await chromium.launch({ executablePath: process.env.CHR });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const logs = [];
const failed = [];
const external = new Map();
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text().slice(0, 260)}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message.slice(0, 260)}`));
page.on('requestfailed', (r) => failed.push(`${r.failure()?.errorText} ${r.url().slice(0, 120)}`));
page.on('request', (r) => { const h = new URL(r.url()).host; if (!h.startsWith('localhost')) external.set(h, (external.get(h) || 0) + 1); });

const t0 = Date.now();
await page.goto('http://localhost:8099/index.html', { waitUntil: 'load', timeout: 90000 });
const loadMs = Date.now() - t0;
await page.waitForTimeout(6000);
const perf = await page.evaluate(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  const lcp = new Promise((res) => { new PerformanceObserver((l) => { const e = l.getEntries(); res(e[e.length - 1]?.startTime); }).observe({ type: 'largest-contentful-paint', buffered: true }); setTimeout(() => res(null), 1500); });
  return lcp.then((l) => ({ domContentLoaded: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd), lcp: l && Math.round(l), domNodes: document.getElementsByTagName('*').length, firebaseReady: !!window.FaseelaFirebase, lucide: !!window.lucide, tailwind: !!window.tailwind, lang: document.documentElement.lang, dir: document.documentElement.dir }));
});
await page.screenshot({ path: process.env.SHOT || '/tmp/home-mobile.png' });
let axe;
try {
  axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
} catch (e) { axe = { violations: [], error: e.message }; }
console.log(JSON.stringify({
  loadMs, perf, external: Object.fromEntries(external), failed: failed.slice(0, 15), logs: [...new Set(logs)].slice(0, 25),
  axe: axe.error || axe.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help }))
}, null, 2));
await browser.close();
