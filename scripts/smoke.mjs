// Loads the app in headless Chrome and fails if it does not render. Catches what typecheck cannot: a render loop, a
// runtime exception, a blank page. Used by ship.ps1 against a throwaway instance of the fresh build before the daily
// instance restarts, and by hand: node scripts/smoke.mjs http://127.0.0.1:7777
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const url = process.argv[2] || 'http://127.0.0.1:7777/';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const shot = path.join(root, 'state', 'smoke.png');

const candidates = [
  process.env.FLEET_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const browserPath = candidates.find(p => fs.existsSync(p));
if (!browserPath) { console.error('smoke: no Chrome or Edge found; set FLEET_CHROME'); process.exit(2); }

const problems = [];
const browser = await puppeteer.launch({ executablePath: browserPath, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  page.on('pageerror', e => problems.push(`page error: ${e.message.split('\n')[0]}`));
  page.on('console', m => { if (m.type() === 'error') problems.push(`console error: ${m.text().split('\n')[0]}`); });
  page.on('requestfailed', r => { if (/\/api\//.test(r.url())) problems.push(`request failed: ${r.url()} ${r.failure()?.errorText}`); });

  const res = await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
  if (!res || !res.ok()) problems.push(`GET ${url} -> ${res ? res.status() : 'no response'}`);

  // The shell: sidebar, main area, and the status strip with its session count. A render loop leaves <main> empty.
  const ok = await page.waitForFunction(() => {
    const main = document.querySelector('main'); const aside = document.querySelector('aside'); const footer = document.querySelector('footer');
    return !!main && main.textContent.trim().length > 20 && !!aside && !!footer && /sessions/.test(footer.textContent);
  }, { timeout: 15000 }).then(() => true).catch(() => false);
  if (!ok) problems.push('app shell did not render (sidebar, main content, status strip)');

  // Something live from the API: the snapshot must have arrived at least once.
  const live = await page.evaluate(() => /\d+\s+sessions/.test(document.querySelector('footer')?.textContent || ''));
  if (!live) problems.push('status strip never showed a session count; snapshot stream not connected');

  fs.mkdirSync(path.dirname(shot), { recursive: true });
  await page.screenshot({ path: shot });
} catch (err) {
  problems.push(`smoke crashed: ${err.message.split('\n')[0]}`);
} finally {
  await browser.close();
}

const seen = [...new Set(problems)];
if (seen.length) { console.error(`smoke FAILED for ${url} (screenshot: ${shot})`); for (const p of seen) console.error('  - ' + p); process.exit(1); }
console.log(`smoke ok: ${url} renders (screenshot: ${shot})`);
