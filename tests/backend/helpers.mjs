// Shared helpers for the backend tests: temp dirs, mock HTTP servers, and a
// running copy of server.js with every file and API pointed at the test's own.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH =
  process.env.TEST_TMP || '/tmp/claude-1000/-home-tinega-my-bench/e57509ac-35ba-4220-a0d9-7f4270c311fd/scratchpad/backend';

export function tempDir(prefix = 't') {
  const base = fs.existsSync(path.dirname(SCRATCH)) ? SCRATCH : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, `${prefix}-`));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A tiny HTTP server that records every request and answers with `handler`.
// handler(req, body) returns { status, json | text, headers, delay } or undefined (404).
export async function mockServer(handler, { host = '127.0.0.1', port = 0 } = {}) {
  const requests = [];
  const state = { handler };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = raw;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {}
    const record = { method: req.method, url: req.url, path: req.url.split('?')[0], headers: req.headers, body, raw };
    requests.push(record);
    let out;
    try {
      out = (await state.handler(record)) || { status: 404, json: { message: 'Not Found' } };
    } catch (e) {
      out = { status: 500, json: { message: e.message } };
    }
    if (out.delay) await sleep(out.delay);
    const headers = { ...(out.headers || {}) };
    let payload = '';
    if (out.json !== undefined) {
      headers['Content-Type'] ||= 'application/json';
      payload = JSON.stringify(out.json);
    } else if (out.text !== undefined) {
      payload = out.text;
    }
    res.writeHead(out.status || 200, headers);
    res.end(payload);
  });
  await new Promise((r) => server.listen(port, host, r));
  const actualPort = server.address().port;
  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    requests,
    setHandler: (h) => (state.handler = h),
    find: (method, pathPrefix) => requests.filter((r) => r.method === method && r.path.startsWith(pathPrefix)),
    clear: () => requests.splice(0),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

// A fake Node-RED: "/" is the editor page, /auth/login says how it logs in.
// opts: { login: 'credentials' | 'open', version, flows, users: {name: password}, flowsStatus }
export function fakeNodeRed(opts = {}, listen = {}) {
  const tokens = new Set();
  const nr = { revoked: [], tokenRequests: [] };
  const handler = (r) => {
    if (r.method === 'GET' && r.path === '/') {
      const v = opts.version === undefined ? '4.0.9' : opts.version;
      return { text: `<html><head><title>Node-RED</title><script src="red/red.min.js${v ? `?v=${v}` : ''}"></script></head></html>`, headers: { 'Content-Type': 'text/html' } };
    }
    if (r.method === 'GET' && r.path === '/auth/login') {
      return { json: opts.login === 'credentials' ? { type: 'credentials', prompts: [] } : {} };
    }
    if (r.method === 'POST' && r.path === '/auth/token') {
      const form = new URLSearchParams(r.raw);
      nr.tokenRequests.push(Object.fromEntries(form));
      const want = opts.users?.[form.get('username')];
      if (!want || want !== form.get('password')) return { status: 401, json: { error: 'unauthorized' } };
      const t = `tok-${Math.random().toString(36).slice(2)}`;
      tokens.add(t);
      return { json: { access_token: t, expires_in: 604800, token_type: 'Bearer' } };
    }
    if (r.method === 'POST' && r.path === '/auth/revoke') {
      nr.revoked.push(r.body?.token);
      tokens.delete(r.body?.token);
      return { json: {} };
    }
    if (r.method === 'GET' && r.path === '/flows') {
      if (opts.flowsStatus) return { status: opts.flowsStatus, json: { message: 'boom' } };
      if (opts.login === 'credentials') {
        const t = (r.headers.authorization || '').replace(/^Bearer /, '');
        if (!tokens.has(t)) return { status: 401, json: { message: 'unauthorized' } };
      }
      const flows = opts.flows || [{ id: 'a', type: 'tab' }, { id: 'b', type: 'inject', z: 'a' }];
      return r.headers['node-red-api-version'] === 'v2' ? { json: { flows, rev: 'rev-1' } } : { json: flows };
    }
  };
  return mockServer(handler, listen).then((srv) => Object.assign(srv, nr));
}

// A free port in 18900-18949 for the server under test.
export async function freePort() {
  for (let p = 18900 + Math.floor(Math.random() * 50), n = 0; n < 50; n++, p = 18900 + ((p - 18900 + 1) % 50)) {
    const ok = await new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(p, '0.0.0.0', () => s.close(() => resolve(true)));
    });
    if (ok) return p;
  }
  throw new Error('no free port in 18900-18949');
}

// Starts `node server.js` with every file inside `dir`. Returns a handle with
// a cookie-keeping client, the captured log, and stop().
export async function startServer({ dir = tempDir('srv'), env = {}, users } = {}) {
  const port = await freePort();
  if (users !== undefined) fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(users, null, 2));
  const fullEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TZ: 'UTC',
    PORT: String(port),
    USERS_FILE: path.join(dir, 'users.json'),
    SECRET_KEY_FILE: path.join(dir, 'password.key'),
    BACKUP_FILE: path.join(dir, 'backup.json'),
    GITHUB_FILE: path.join(dir, 'github.json'),
    DASHBOARD_UPDATE_FILE: path.join(dir, 'dashboard-update.json'),
    INSTANCES_FILE: path.join(dir, 'instances.json'),
    PROBE_HOST: '127.0.0.1',
    SCAN_HOST_PORTS: '0',
    DOCKER_API: '',
    // Never the real GitHub: an unused local port unless a test gives a mock.
    GITHUB_API: 'http://127.0.0.1:9',
    DEFAULT_ADMIN_PASSWORD: 'default-admin-pw',
    ...env,
  };
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: fullEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  const exited = new Promise((r) => proc.once('exit', r));
  const deadline = Date.now() + 10000;
  while (!log.includes(`listening on :${port}`)) {
    if (proc.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error(`server did not start:\n${log}`);
    }
    await sleep(25);
  }
  const base = `http://127.0.0.1:${port}`;
  return {
    port,
    dir,
    base,
    env: fullEnv,
    proc,
    log: () => log,
    client: () => client(base),
    readJson: (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')),
    writeJson: (name, v) => fs.writeFileSync(path.join(dir, name), JSON.stringify(v, null, 2)),
    stop: async () => {
      if (proc.exitCode === null) proc.kill('SIGTERM');
      await exited;
    },
  };
}

// A fetch wrapper that keeps the session cookie and sends the CSRF header.
export function client(base) {
  let cookie = null;
  const c = {
    get cookie() {
      return cookie;
    },
    set cookie(v) {
      cookie = v;
    },
    async req(method, p, body, { csrf = true, headers = {}, raw } = {}) {
      const h = { ...headers };
      if (csrf) h['X-Requested-With'] = 'fetch';
      if (cookie) h.Cookie = cookie;
      if (body !== undefined) h['Content-Type'] = 'application/json';
      const res = await fetch(base + p, { method, headers: h, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
      const set = res.headers.get('set-cookie');
      if (set) {
        const v = set.split(';')[0];
        cookie = v.endsWith('=') ? null : v;
      }
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {}
      return { status: res.status, body: json, text, headers: res.headers };
    },
    get: (p, o) => c.req('GET', p, undefined, o),
    post: (p, b, o) => c.req('POST', p, b, o),
    put: (p, b, o) => c.req('PUT', p, b, o),
    del: (p, o) => c.req('DELETE', p, undefined, o),
    async login(username, password) {
      const r = await c.post('/api/login', { username, password });
      if (r.status !== 200) throw new Error(`login ${username} failed: ${r.status} ${r.text}`);
      return r;
    },
  };
  return c;
}

export const ADMIN = 'administrator';
export const ADMIN_PW = 'default-admin-pw';
