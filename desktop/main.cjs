// Fleet's desktop window. The server keeps running on its own (logon task / launch agent, `npm run ship`, restarts);
// this app is only a window onto it, so closing or updating the app never ends a chat. If the server is down when the
// app opens, it starts the logon task and shows a waiting page until the server answers.
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const base = new URL(process.env.FLEET_URL || 'http://127.0.0.1:7777/');
const isWin = process.platform === 'win32';
const stateFile = path.join(app.getPath('userData'), 'window.json');
let win = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
// The page checks this to fit its title bar around the window buttons.
app.userAgentFallback = `${app.userAgentFallback} FleetDesktop/${app.getVersion()}`;

const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
function saveState() {
  if (!win || win.isDestroyed()) return;
  try { fs.writeFileSync(stateFile, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch {}
}

const serverUp = () => fetch(new URL('/api/config', base), { signal: AbortSignal.timeout(2000) }).then(r => r.ok, () => false);
// The same thing `npm run restart` ends with: start the logon task, or kick the launch agent on a Mac.
function startServer() {
  if (isWin) execFile('schtasks', ['/Run', '/TN', 'ClaudeFleet'], { windowsHide: true }, () => {});
  else if (process.platform === 'darwin') execFile('launchctl', ['kickstart', `gui/${process.getuid()}/com.fleet`], () => {});
}

async function load() {
  if (await serverUp()) return win.loadURL(base.href);
  startServer();
  await win.loadFile(path.join(__dirname, 'offline.html'), { query: { url: base.href } });
  for (let i = 0; i < 600 && !win.isDestroyed(); i++) {
    await new Promise(r => setTimeout(r, 2000));
    if (await serverUp()) return win.isDestroyed() ? undefined : win.loadURL(base.href);
  }
}

function createWindow() {
  const s = readState();
  win = new BrowserWindow({
    x: s.x, y: s.y, width: s.width || 1440, height: s.height || 900, minWidth: 720, minHeight: 480,
    title: 'Fleet', backgroundColor: '#090b0e', show: false, autoHideMenuBar: true,
    // Windows: Fleet's own title bar is the window's title bar, with the system buttons drawn over its right end.
    ...(isWin ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#0f1216', symbolColor: '#eceef3', height: 43 } } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  if (s.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  for (const ev of ['resize', 'move', 'close']) win.on(ev, saveState);

  // Fleet's own pages stay in the app; every other link opens in the default browser.
  const ours = url => { try { return new URL(url).origin === base.origin; } catch { return false; } };
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (ours(url)) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } };
    if (/^(https?|mailto):/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (ours(url) || url.startsWith('file:')) return;
    e.preventDefault();
    if (/^(https?|mailto):/.test(url)) shell.openExternal(url);
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F5' || ((input.control || input.meta) && input.key.toLowerCase() === 'r'))) load();
  });
  load();
}

ipcMain.on('fleet:titlebar', (_e, color, symbolColor) => {
  if (isWin && win && !win.isDestroyed() && /^#[0-9a-f]{6}$/i.test(color) && /^#[0-9a-f]{6}$/i.test(symbolColor)) win.setTitleBarOverlay({ color, symbolColor });
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
