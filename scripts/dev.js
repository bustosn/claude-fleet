// Dev: the API server on FLEET_PORT (default 7778) with restart-on-change, plus Vite with HMR on 5178 proxying /api.
// The daily instance on 7777 is untouched.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = process.env.FLEET_PORT || '7778';
const env = { ...process.env, FLEET_PORT: port };
const bin = name => path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);

// Windows needs a shell to run the .cmd shims, so paths are quoted for it; elsewhere the binaries run directly.
const win = process.platform === 'win32';
const q = p => win ? `"${p}"` : p;
const server = spawn(q(bin('tsx')), ['watch', q(path.join(root, 'server', 'index.ts'))], { stdio: 'inherit', env, shell: win });
const web = spawn(q(bin('vite')), ['--config', q(path.join(root, 'web', 'vite.config.ts'))], { stdio: 'inherit', env, shell: win });

const stop = () => { server.kill(); web.kill(); };
process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });
server.on('exit', code => { web.kill(); process.exit(code ?? 0); });
web.on('exit', code => { server.kill(); process.exit(code ?? 0); });
