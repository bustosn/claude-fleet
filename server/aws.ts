import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { approveDeviceLogin } from './awsApprove.js';
import type { AwsConfig } from './config.js';
import type { AwsRun, AwsStatus } from '../shared/types.js';

const BASH = 'C:/Program Files/Git/bin/bash.exe';

// AWS credential refresh: silent path first (SSO refresh token), then a device-code login approved in the user's normal browser.
export class AwsCreds {
  cfg: AwsConfig; stateDir: string; profileDir: string;
  run: AwsRun | null = null; private cached: Omit<AwsStatus, 'run' | 'needsLogin'> | null = null; private cachedAt = 0;
  login: ChildProcess | null = null; private loginDone: Promise<void> | null = null;

  constructor(cfg: Partial<AwsConfig>, stateDir: string) {
    this.cfg = { profile: '', credProfile: 'default', resetScript: '', ssoRegion: 'us-east-1', chromePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
      autoApprove: false, autoRefresh: true, autoRefreshMinutesBefore: 60, ...cfg };
    this.stateDir = stateDir; this.profileDir = path.join(stateDir, 'chrome-aws-profile');
    if (this.cfg.autoRefresh && this.enabled) setInterval(() => this.autoRefreshTick().catch(() => {}), 10 * 60000);
  }

  // No profile configured (a machine with no SSO setup): the hub reports itself off instead of failing every poll.
  get enabled() { return !!this.cfg.profile; }

  // Refresh on a timer before the role keys run out, so the button is rarely needed at all.
  // The timer only ever uses the silent path. Once that fails (SSO session expired) it waits for a click rather than opening browser tabs on its own.
  needsLogin = false;
  async autoRefreshTick() {
    if (this.run && !this.run.done) return;
    if (this.needsLogin) return;
    const s = await this.status(true);
    const left = s.expiration ? Date.parse(s.expiration) - Date.now() : -1;
    if (left < this.cfg.autoRefreshMinutesBefore * 60000) { this.start({ auto: true }); this.log(`auto-refresh: ${left < 0 ? 'credentials expired or unknown' : `${Math.round(left / 60000)} min left`}`); }
  }

  async status(force = false): Promise<AwsStatus> {
    if (!this.enabled) return { enabled: false, profile: '', credProfile: '', expiration: null, arn: null, ssoExpiresAt: null, ssoHasRefresh: false, error: null, run: null, needsLogin: false };
    if (!force && this.cached && Date.now() - this.cachedAt < 60000) return { ...this.cached, run: this.run, needsLogin: this.needsLogin };
    const out: Omit<AwsStatus, 'run' | 'needsLogin'> = { enabled: true, profile: this.cfg.profile, credProfile: this.cfg.credProfile, expiration: null, arn: null, ssoExpiresAt: null, ssoHasRefresh: false, error: null };
    try {
      const j = JSON.parse(await exec('aws', ['configure', 'export-credentials', '--profile', this.cfg.profile, '--format', 'process']));
      out.expiration = j.Expiration || null;
    } catch (err) { out.error = short(err); }
    try { out.arn = (await exec('aws', ['sts', 'get-caller-identity', '--profile', this.cfg.credProfile, '--output', 'text', '--query', 'Arn'])).trim(); }
    catch (err) { out.arn = null; out.error = out.error || short(err); }
    Object.assign(out, await this.ssoCache());
    this.cached = out; this.cachedAt = Date.now();
    return { ...out, run: this.run, needsLogin: this.needsLogin };
  }

  // Only expiry metadata is read from the SSO cache; tokens never leave this function.
  async ssoCache() {
    const dir = path.join(os.homedir(), '.aws', 'sso', 'cache');
    let latest: string | null = null, hasRefresh = false;
    try {
      for (const f of await fs.readdir(dir)) {
        try {
          const j = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
          if (!j.startUrl || !j.accessToken) continue;
          hasRefresh = hasRefresh || !!j.refreshToken;
          if (!latest || Date.parse(j.expiresAt) > Date.parse(latest)) latest = j.expiresAt;
        } catch {}
      }
    } catch {}
    return { ssoExpiresAt: latest, ssoHasRefresh: hasRefresh };
  }

  start({ forceLogin = false, auto = false } = {}): AwsRun {
    if (this.run && !this.run.done) return this.run;
    if (!this.enabled) return { id: 'off', startedAt: Date.now(), done: true, ok: false, state: 'failed', log: [], approveUrl: null, code: null, error: 'No aws.profile configured in fleet.config.json', forceLogin, auto };
    this.run = { id: Date.now().toString(36), startedAt: Date.now(), done: false, ok: null, state: 'starting', log: [], approveUrl: null, code: null, error: null, forceLogin, auto };
    this.execute(forceLogin, auto).catch(err => this.finish(false, short(err)));
    return this.run;
  }

  log(line: string) { if (!this.run) return; this.run.log.push({ at: Date.now(), line: String(line).replace(/\r/g, '').trimEnd() }); if (this.run.log.length > 200) this.run.log.shift(); }
  private setState(s: string) { this.run!.state = s; this.log(`[${s}]`); }
  private finish(ok: boolean, error?: string) { const r = this.run!; r.done = true; r.ok = ok; r.error = error || null; r.state = ok ? 'done' : 'failed'; this.log(ok ? 'done' : `failed: ${error}`); this.cachedAt = 0; this.login?.kill(); if (ok) this.needsLogin = false; }

  private async execute(forceLogin: boolean, auto = false) {
    if (!forceLogin) {
      this.setState('silent');
      this.log('Trying to refresh from the cached SSO session (no browser)');
      if (await this.writeCreds()) return this.finish(true);
      if (auto) { this.needsLogin = true; return this.finish(false, 'SSO session expired. Click Refresh credentials to log in; the timer will not open a browser on its own.'); }
    }
    this.setState('login');
    this.log(forceLogin ? 'Forced new login requested. Starting device-code login' : 'SSO session expired. Starting device-code login');
    const { url, code } = await this.deviceLogin();
    this.run!.approveUrl = url; this.run!.code = code;
    this.setState('approve');
    if (this.cfg.autoApprove) {
      this.log(`Approving device code ${code} automatically in a headless Chrome profile`);
      try {
        await approveDeviceLogin({ url, code, chromePath: this.cfg.chromePath, profileDir: this.profileDir, stateDir: this.stateDir, log: l => this.log(l),
          onNeedsUser: () => { this.setState('signin'); this.log('Sign in to Identity Center in the Chrome window that just opened. The approval clicks happen on their own afterwards.'); } });
        this.log('Approval clicked. Waiting for the CLI to finish');
      } catch (err) {
        this.log(`automatic approval failed: ${short(err)}. Opening the page in your browser instead; click Confirm and continue, then Allow access.`);
        this.setState('approve-manual');
        openInBrowser(url);
      }
    } else {
      this.log(`Approval page opened in your browser with code ${code}. Click "Confirm and continue", then "Allow access".`);
      openInBrowser(url);
    }
    await this.loginDone;
    this.setState('export');
    if (await this.writeCreds()) return this.finish(true);
    this.finish(false, 'login finished but exporting credentials still failed');
  }

  // awsreset --no-login: export from the SSO cache, back up and rewrite ~/.aws files, verify with STS.
  private async writeCreds(): Promise<boolean> {
    try {
      const out = await exec(BASH, [this.cfg.resetScript, '--no-login'], { timeout: 90000 });
      for (const l of out.split('\n')) if (l.trim()) this.log(l);
      return true;
    } catch (err) { this.log(`silent refresh failed: ${short(err)}`); return false; }
  }

  private deviceLogin(): Promise<{ url: string; code: string }> {
    return new Promise((resolve, reject) => {
      // PYTHONUNBUFFERED: the CLI is a frozen Python app and block-buffers stdout when piped, which would hide the code until exit.
      const p = spawn('aws', ['sso', 'login', '--profile', this.cfg.profile, '--use-device-code', '--no-browser'],
        { windowsHide: true, shell: true, env: { ...process.env, PYTHONUNBUFFERED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      this.login = p;
      let buf = '', resolved = false;
      const scan = (chunk: Buffer) => {
        buf += chunk.toString();
        // The CLI prints an autofill URL like https://<tenant>.awsapps.com/start/#/device?user_code=XXXX-XXXX
        const m = buf.match(/(https?:\/\/\S+user_code=([A-Z0-9-]+))/i);
        if (m && !resolved) { resolved = true; resolve({ url: m[1], code: m[2].toUpperCase() }); }
      };
      p.stdout!.on('data', scan); p.stderr!.on('data', scan);
      this.loginDone = new Promise<void>((res, rej) => {
        const timer = setTimeout(() => { p.kill(); rej(new Error('approval timed out after 10 minutes')); }, 600000);
        p.on('exit', c => { clearTimeout(timer); this.login = null; c === 0 ? res() : rej(new Error(`aws sso login exited ${c}: ${buf.slice(-300)}`)); });
      });
      this.loginDone.catch(() => {});
      p.on('exit', c => { if (!resolved) reject(new Error(`aws sso login exited ${c} before printing a code: ${buf.slice(-300)}`)); });
    });
  }
}

function exec(cmd: string, args: string[], opts: Record<string, unknown> = {}): Promise<string> {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: 30000, windowsHide: true, shell: cmd === 'aws', ...opts } as any,
    (err, stdout, stderr) => err ? reject(Object.assign(err, { stdout, stderr })) : resolve(String(stdout))));
}
function short(err: any): string { return String(err?.stderr || err?.stdout || err?.message || err).replace(/\r/g, '').trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 400); }
function openInBrowser(url: string) { spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref(); }
