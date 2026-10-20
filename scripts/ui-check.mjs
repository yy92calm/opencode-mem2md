import { chromium } from 'playwright';
import { existsSync } from 'fs';

const url = process.argv[2] || 'http://127.0.0.1:13999/ui';
const out = process.argv[3] || '/tmp/mem-ui.png';

// Use a locally installed Chrome unless CHROME_PATH is set (Playwright's
// bundled browser may not be downloaded).
const candidates = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const executablePath = candidates.find((p) => existsSync(p));

const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage({ viewport: { width: 1240, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('#cards .card', { timeout: 5000 });

const summary = await page.evaluate(() => ({
  cards: [...document.querySelectorAll('#cards .card .n')].map((n) => n.textContent),
  tabs: [...document.querySelectorAll('.tab')].map((t) => t.textContent.trim()),
  workspaces: [...document.querySelectorAll('#wsSelect option')].map((o) => o.textContent.trim()),
  wsMemories: document.querySelectorAll('#wsList .mem').length,
  wsFocus: document.querySelectorAll('#wsFocus .focus-item').length,
  pipeline: document.querySelector('#pipeBadge')?.textContent,
}));

await page.screenshot({ path: out, fullPage: true });

// profile tab
await page.click('.tab[data-page="profile"]');
await page.waitForFunction(() => {
  const t = document.querySelector('#profileText')?.textContent || '';
  return t.length > 0 && t !== '加载中…';
}, { timeout: 5000 }).catch(() => {});
await page.screenshot({ path: out.replace('.png', '-profile.png'), fullPage: true });
const profileLen = await page.evaluate(() => document.querySelector('#profileText').textContent.length);

// focus tab
await page.click('.tab[data-page="focus"]');
await page.waitForTimeout(800);
const focusCount = await page.evaluate(() => document.querySelectorAll('#focusList .focus-item').length);

// hard search
await page.click('.tab[data-page="hard"]');
await page.waitForFunction(
  () => document.querySelectorAll('#hardList .mem').length > 0,
  { timeout: 6000 },
).catch(() => {});
const hardCount = await page.evaluate(() => document.querySelectorAll('#hardList .mem').length);

console.log(JSON.stringify({ summary, profileLen, focusCount, hardCount, errors }, null, 2));
await browser.close();