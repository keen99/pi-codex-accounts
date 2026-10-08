import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const sandbox = mkdtempSync(join(tmpdir(), 'codex-rpc-smoke-'));
const credential = (name) => ({ access: `fake-${name}`, refresh: `fake-refresh-${name}`, expires: Date.now() + 3_600_000, accountId: `fake-id-${name}` });
const raw = JSON.stringify({ active: 'teams', accounts: { plus: credential('plus'), teams: credential('teams') } });
writeFileSync(join(sandbox, 'codex-accounts.json'), raw);
writeFileSync(join(sandbox, 'settings.json'), JSON.stringify({ packages: [], defaultProvider: 'openai-codex', defaultModel: 'gpt-5.5' }));
// npm prepends node_modules/.bin to PATH, which otherwise launches the dev
// dependency's different pi version. Default to this Node installation's pi.
const child = spawn(process.env.PI_TEST_BIN ?? join(dirname(process.execPath), 'pi'), ['--mode', 'rpc', '--no-session', '--no-extensions',
  '-e', join(repo, 'src/codex-accounts.ts'),
  '-e', resolve(repo, '../pi-usage-status/src/index.ts'),
  '-e', join(repo, 'test/rpc-controls.ts'),
], { cwd: sandbox, env: { ...process.env, PI_CODING_AGENT_DIR: sandbox }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
const pending = new Map();
const events = [];
let nextId = 0, buffer = '', errors = '';
child.stderr.on('data', chunk => { errors += chunk; });
child.stdout.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n');
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    let event; try { event = JSON.parse(line); } catch { continue; }
    events.push(event);
    if (event.type === 'response' && pending.has(event.id)) {
      const { resolve, reject, timer } = pending.get(event.id); pending.delete(event.id); clearTimeout(timer);
      event.success ? resolve(event) : reject(new Error(JSON.stringify(event)));
    }
  }
});
function request(type, fields = {}) {
  const id = `smoke-${++nextId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out on ${type}: ${errors}`)), 10_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, type, ...fields }) + '\n');
  });
}
async function waitFor(predicate) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const found = events.find(predicate);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`RPC UI request did not arrive: ${JSON.stringify(events)}; stderr=${errors}`);
}
async function state() {
  await request('prompt', { message: '/test-state' });
  const event = events.filter(e => e.method === 'notify' && e.message?.includes('"testState"')).at(-1);
  return JSON.parse(event.message);
}
try {
  await request('get_commands');
  // RPC can accept get_commands while asynchronous session_start is still
  // applying runtime auth. Observe initialization rather than racing it.
  await waitFor(e => e.method === 'setStatus' && e.statusKey === 'codex-accounts' && e.statusText === 'codex:teams');
  let s = await state();
  assert.equal(s.selection.accountName, 'teams'); assert.equal(s.key, 'fake-teams');
  await request('prompt', { message: '/codex-account plus' });
  s = await state();
  assert.equal(s.selection.accountName, 'plus'); assert.equal(s.key, 'fake-plus');
  await request('prompt', { message: '/test-reload' });
  s = await state();
  assert.equal(s.selection.accountName, 'plus'); assert.equal(s.key, 'fake-plus');
  const lastFooter = events.filter(e => e.method === 'setStatus' && e.statusKey === 'usage-status' && e.statusText).at(-1);
  assert.match(lastFooter.statusText, /plus/);
  assert.equal(readFileSync(join(sandbox, 'codex-accounts.json'), 'utf8'), raw);
  let before = events.length;
  const cancelLogin = request('prompt', { message: '/test-owned-login' });
  const cancelInput = await waitFor(e => events.indexOf(e) >= before && e.method === 'input');
  child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: cancelInput.id, cancelled: true }) + '\n');
  await cancelLogin;
  assert.ok(events.slice(before).some(e => e.method === 'notify' && /login cancelled/.test(e.message)));
  s = await state(); assert.equal(s.key, 'fake-plus');
  before = events.length;
  const browserLogin = request('prompt', { message: '/test-owned-login' });
  await waitFor(e => events.indexOf(e) >= before && e.method === 'input');
  const authMessage = events.slice(before).find(e => e.method === 'notify' && e.message.includes('https://auth.openai.com/oauth/authorize'));
  const authUrl = new URL(authMessage.message.match(/https:\/\/auth\.openai\.com\/oauth\/authorize\?[^\n ]+/)[0]);
  const callback = new URL(authUrl.searchParams.get('redirect_uri'));
  callback.hostname = '127.0.0.1';
  callback.search = new URLSearchParams({ code: 'fake-browser-code', state: authUrl.searchParams.get('state') }).toString();
  assert.equal((await fetch(callback)).status, 200);
  await browserLogin; // No input response sent: browser completion dismissed it.
  assert.ok(events.slice(before).some(e => e.method === 'notify' && e.message === 'test login complete'));
  s = await state(); assert.equal(s.key, 'fake-plus');
  assert.equal(readFileSync(join(sandbox, 'codex-accounts.json'), 'utf8'), raw);
  assert.ok(!events.some(e => e.type === 'extension_error'), JSON.stringify(events.filter(e => e.type === 'extension_error')));
  console.log('Pinned-pi RPC smoke PASS: load, switch, auth, footer, reload, Escape cancellation, browser auto-completion, unchanged credentials.');
} finally {
  // Graceful shutdown of this test-owned process only. Never signal user sessions.
  await request('prompt', { message: '/test-quit' }).catch(() => undefined);
  child.stdin.end();
  // Bounded close wait. On runners the pi process tree (refresh worker etc.)
  // can hold the stdio pipes open, so 'close' never fires and node exits with
  // code 13 (unsettled top-level await) — which masked every real failure.
  // detached:true makes the child a process group leader, so the fallback
  // kills the whole tree.
  await new Promise((resolve) => {
    const killer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      resolve();
    }, 5000);
    child.once('close', () => { clearTimeout(killer); resolve(); });
  });
  rmSync(sandbox, { recursive: true, force: true });
}
