// Renders the PNG app icons from web/public/icon.svg and icon-maskable.svg in headless Chrome. The PNGs are committed;
// run this again only after changing an SVG: node scripts/icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const pub = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'web', 'public');
const candidates = [
  process.env.FLEET_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const browserPath = candidates.find(p => fs.existsSync(p));
if (!browserPath) { console.error('icons: no Chrome or Edge found; set FLEET_CHROME'); process.exit(2); }

const outputs = [
  ['icon.svg', 'icon-192.png', 192],
  ['icon.svg', 'icon-512.png', 512],
  ['icon-maskable.svg', 'icon-maskable-512.png', 512],
  ['icon-maskable.svg', 'apple-touch-icon.png', 180],
];

const browser = await puppeteer.launch({ executablePath: browserPath, headless: true });
try {
  const page = await browser.newPage();
  for (const [src, out, size] of outputs) {
    const svg = fs.readFileSync(path.join(pub, src), 'utf8');
    await page.setViewport({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: path.join(pub, out), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    console.log(`icons: ${out} (${size}px)`);
  }
} finally {
  await browser.close();
}
