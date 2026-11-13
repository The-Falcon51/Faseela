// Home page contrast suite: axe (WCAG 2.x A/AA) on the landing page in AR/EN/DE, light and dark.
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { spawn } from 'node:child_process';
const server = spawn('python3', ['-m', 'http.server', '8097', '--bind', '127.0.0.1', '--directory', 'public'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
let failed = 0;
const browser = await chromium.launch({ executablePath: process.env.CHR });
try {
  for (const lang of ['ar', 'en', 'de']) for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: theme, serviceWorkers: 'block' });
    await ctx.route(/supabase\.co/, (r) => r.abort());
    const page = await ctx.newPage();
    await page.addInitScript(([l, t]) => { try { localStorage.setItem('faseela_lang', l); localStorage.setItem('faseela_theme', t); localStorage.setItem('faseela_dark_mode', t === 'dark' ? 'true' : 'false'); } catch (e) {} }, [lang, theme]);
    await page.goto('http://127.0.0.1:8097/', { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    console.log(lang, theme, 'dark=' + isDark, r.violations.map((v) => `${v.id}:${v.nodes.length}`).join(',') || 'clean');
    for (const v of r.violations) for (const n of v.nodes) { failed += 1; console.log('   ', n.html.slice(0, 150).replace(/\s+/g, ' '), '|', (n.any[0]?.message || '').slice(0, 130)); }
    await ctx.close();
  }
  if (failed) { console.error(`${failed} accessibility violation(s)`); process.exitCode = 1; } else console.log(JSON.stringify({ ok: true, suite: 'home-contrast' }));
} finally { await browser.close(); server.kill(); }
