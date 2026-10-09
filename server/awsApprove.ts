import path from 'node:path';
import puppeteer, { type Page } from 'puppeteer-core';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface ApproveOptions {
  url: string; code: string; chromePath: string; profileDir: string; stateDir: string;
  log: (line: string) => void; onNeedsUser?: () => void; timeoutMs?: number;
}

// Drives the Identity Center device-authorization page: Confirm and continue, then Allow access.
// Off by default (aws.autoApprove). Runs headless in a dedicated Chrome profile; relaunches visibly when a sign-in is needed.
export async function approveDeviceLogin({ url, code, chromePath, profileDir, stateDir, log, onNeedsUser, timeoutMs = 540000 }: ApproveOptions): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let headless = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    const browser = await puppeteer.launch({
      executablePath: chromePath, userDataDir: profileDir, headless,
      defaultViewport: headless ? { width: 1200, height: 900 } : null,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-sync', ...(headless ? [] : ['--window-size=1100,900'])],
    });
    try {
      const page = (await browser.pages())[0] || await browser.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const result = await drive(page, { code, log, deadline, allowSignIn: !headless, onNeedsUser, stateDir });
      if (result === 'approved') { await browser.close(); return true; }
      if (result === 'needs-signin' && headless) {
        log('Identity Center wants you to sign in. Opening a visible Chrome window for that; everything after is automatic.');
        await browser.close(); headless = false; continue;
      }
      await snap(page, stateDir, 'aws-approve-fail');
      await browser.close();
      throw new Error(result);
    } catch (err) {
      await browser.close().catch(() => {});
      throw err;
    }
  }
  throw new Error('approval did not complete');
}

async function drive(page: Page, { code, log, deadline, allowSignIn, onNeedsUser, stateDir }: { code: string; log: (l: string) => void; deadline: number; allowSignIn: boolean; onNeedsUser?: () => void; stateDir: string }): Promise<string> {
  let lastSig = '', notified = false, lastClickAt = 0;
  while (Date.now() < deadline) {
    const info = await page.evaluate(() => {
      const vis = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const buttons = [...document.querySelectorAll('button, input[type=submit], a[role=button]')].filter(vis).map(b => ((b as HTMLElement).innerText || (b as HTMLInputElement).value || '').trim()).filter(Boolean);
      const codeInput = [...document.querySelectorAll('input')].filter(vis).find(i => /code/i.test(`${i.id} ${i.name} ${i.placeholder} ${i.getAttribute('aria-label') || ''}`));
      const text = document.body?.innerText || '';
      return {
        buttons, url: location.href,
        codeInputEmpty: !!codeInput && !codeInput.value,
        signIn: !!document.querySelector('input[type=password]') || !![...document.querySelectorAll('input')].filter(vis).find(i => /user|email|login/i.test(`${i.id} ${i.name} ${i.placeholder} ${i.autocomplete}`)),
        approved: /request approved|you can close this window|has been approved|approved/i.test(text) && !/allow access/i.test(text),
        snippet: text.replace(/\s+/g, ' ').slice(0, 160),
      };
    }).catch(() => null);
    if (!info) { await sleep(1000); continue; }

    const sig = `${info.url}|${info.buttons.join(',')}|${info.signIn}|${info.approved}`;
    if (sig !== lastSig) { lastSig = sig; log(`page: ${info.snippet || info.url}`); await snap(page, stateDir, 'aws-approve-last'); }

    if (info.approved) return 'approved';
    const allow = info.buttons.find(t => /allow access|^allow$/i.test(t));
    const confirm = info.buttons.find(t => /confirm and continue|^confirm$|^continue$|^next$|^submit$/i.test(t));
    if (Date.now() - lastClickAt > 2500) {
      if (info.codeInputEmpty && code) {
        await page.evaluate(() => { const i = [...document.querySelectorAll('input')].find(x => /code/i.test(`${x.id} ${x.name} ${x.placeholder}`)); if (i) { i.focus(); i.value = ''; } });
        await page.keyboard.type(code); log('typed the device code'); lastClickAt = Date.now(); continue;
      }
      if (allow) { await clickText(page, allow); log(`clicked "${allow}"`); lastClickAt = Date.now(); await sleep(1500); continue; }
      if (confirm && !info.signIn) { await clickText(page, confirm); log(`clicked "${confirm}"`); lastClickAt = Date.now(); await sleep(1500); continue; }
    }
    if (info.signIn) {
      if (!allowSignIn) return 'needs-signin';
      if (!notified) { notified = true; onNeedsUser?.(); }
    }
    await sleep(1000);
  }
  return 'timed out waiting for the approval page';
}

function clickText(page: Page, text: string) {
  return page.evaluate(t => {
    const el = [...document.querySelectorAll('button, input[type=submit], a[role=button]')].find(b => ((b as HTMLElement).innerText || (b as HTMLInputElement).value || '').trim() === t);
    (el as HTMLElement | undefined)?.click();
  }, text);
}

async function snap(page: Page, stateDir: string, name: string) {
  if (!stateDir) return;
  try { await page.screenshot({ path: path.join(stateDir, `${name}.png`) as `${string}.png` }); } catch {}
}
