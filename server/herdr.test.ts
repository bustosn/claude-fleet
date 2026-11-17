import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// A stand-in for herdr's API: the same path the monitor looks at, one JSON line in and out per connection.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-herdr-'));
process.env.APPDATA = home;
process.env.XDG_CONFIG_HOME = home;
fs.mkdirSync(path.join(home, 'herdr'), { recursive: true });
const sockFile = path.join(home, 'herdr', 'herdr.sock');
const listen = process.platform === 'win32' ? `\\\\.\\pipe\\${sockFile}` : sockFile;

const calls: { method: string; params: any }[] = [];
let agentStatus = 'working';
const workspaces = [{ workspace_id: 'w1', label: 'grove', agent_status: 'working', worktree: { checkout_path: 'C:/coding/grove' } }];
const server = net.createServer(conn => {
  let buf = '';
  conn.on('data', d => {
    buf += d.toString();
    if (!buf.includes('\n')) return;
    const req = JSON.parse(buf.split('\n')[0]);
    calls.push({ method: req.method, params: req.params });
    const result: Record<string, any> = {
      'agent.list': { agents: [{ pane_id: 'w1:p1', workspace_id: 'w1', agent_status: agentStatus, agent: 'claude', terminal_title_stripped: 'Fix the thing', cwd: 'C:\\coding\\grove' }] },
      'workspace.list': { workspaces },
      'pane.list': { panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', cwd: 'C:\\coding\\grove' }] },
      'workspace.focus': { type: 'ok' },
      'workspace.create': { workspace: { workspace_id: 'w2' } },
    }[req.method];
    conn.end(JSON.stringify(result ? { id: req.id, result } : { id: req.id, error: { code: 'unknown_method', message: 'no such method' } }) + '\n');
  });
});

const { HerdrMonitor } = await import('./herdr.js');
const monitor = new HerdrMonitor();
(monitor as any).bin = process.execPath; // any existing file: the monitor only needs to know herdr is installed
await new Promise<void>(r => server.listen(listen, r));

test('agents and workspaces are read from the socket', async () => {
  await monitor.refresh();
  monitor.stop();
  assert.equal(monitor.state.running, true);
  assert.deepEqual(monitor.state.agents.map(a => [a.paneId, a.workspace, a.status, a.agent, a.title]), [['w1:p1', 'grove', 'working', 'claude', 'Fix the thing']]);
});

test('an agent that becomes blocked is reported, the first look is not', async () => {
  const seen: string[] = [];
  monitor.on('agent', a => seen.push(`${a.paneId}:${a.status}`));
  agentStatus = 'blocked';
  await monitor.refresh(); monitor.stop();
  assert.deepEqual(seen, ['w1:p1:blocked']);
  await monitor.refresh(); monitor.stop();
  assert.deepEqual(seen, ['w1:p1:blocked'], 'no repeat while it stays blocked');
});

test('hop focuses the workspace that has the folder, in either slash style, and creates one when none does', async () => {
  calls.length = 0;
  assert.deepEqual(await monitor.hop('C:\\coding\\grove\\'), { workspaceId: 'w1', opened: false });
  assert.deepEqual(calls.find(c => c.method === 'workspace.focus')?.params, { workspace_id: 'w1' });
  calls.length = 0;
  assert.deepEqual(await monitor.hop('C:/coding/other'), { workspaceId: 'w2', opened: true });
  assert.deepEqual(calls.find(c => c.method === 'workspace.create')?.params, { cwd: 'C:/coding/other', label: 'other', focus: true });
});

test('a refusal from herdr comes back as an error with its message', async () => {
  await assert.rejects(monitor.focusAgent('x'), /refused agent\.focus: no such method/);
});

test('with herdr stopped the state says installed but not running', async () => {
  await new Promise<void>(r => server.close(() => r()));
  await monitor.refresh(); monitor.stop();
  assert.deepEqual([monitor.state.installed, monitor.state.running, monitor.state.agents.length], [true, false, 0]);
  fs.rmSync(home, { recursive: true, force: true });
});
