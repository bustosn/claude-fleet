// Runs an npm script's Windows (.ps1) or macOS (.sh) version, so `npm run setup|restart|ship` works on both.
//   node scripts/os.mjs <setup|restart|ship> [args passed through]
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [name, ...args] = process.argv.slice(2);

const windows = { setup: ['install.ps1'], restart: ['autostart.ps1', '-Restart'], ship: ['ship.ps1'] };
const mac = { setup: ['install.sh'], restart: ['autostart.sh', 'restart'] };

let cmd, argv;
if (process.platform === 'win32') {
  if (!windows[name]) fail(`unknown script: ${name}`);
  const [file, ...fixed] = windows[name];
  cmd = 'powershell'; argv = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, file), ...fixed, ...args];
} else if (process.platform === 'darwin') {
  if (name === 'ship') fail('ship is Windows-only so far. On a Mac, update the daily instance with: git pull && ./scripts/install.sh');
  if (!mac[name]) fail(`unknown script: ${name}`);
  const [file, ...fixed] = mac[name];
  cmd = path.join(here, file); argv = [...fixed, ...args];
} else fail(`npm run ${name} supports Windows and macOS; on ${process.platform} run npm start yourself.`);

const r = spawnSync(cmd, argv, { stdio: 'inherit' });
if (r.error) fail(r.error.message);
process.exit(r.status ?? 1);

function fail(msg) { console.error(msg); process.exit(1); }
