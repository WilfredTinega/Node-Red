// Fake services the dashboard talks to in the end-to-end tests. They run in
// the Playwright worker, so a test can steer their answers (`state`) and
// check what they received (`requests`). All listen on 127.0.0.1 on a random
// port: nothing here reaches the real GitHub, Docker or Node-RED.
import http from 'node:http';
import net from 'node:net';

// A tiny HTTP server that records every request and answers with `handler`.
// handler(record) returns { status, json | text, headers, delay } or undefined (404).
export async function mockServer(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = raw;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      // form bodies (Node-RED /auth/token) stay as text
    }
    const url = new URL(req.url, 'http://mock');
    const record = { method: req.method, url: req.url, path: url.pathname, query: url.searchParams, headers: req.headers, body, raw };
    requests.push(record);
    let out;
    try {
      out = (await handler(record)) || { status: 404, json: { message: 'Not Found' } };
    } catch (e) {
      out = { status: 500, json: { message: e.message } };
    }
    if (out.delay) await new Promise((r) => setTimeout(r, out.delay));
    const headers = { ...(out.headers || {}) };
    let payload = '';
    if (out.json !== undefined) {
      headers['Content-Type'] ||= 'application/json';
      payload = JSON.stringify(out.json);
    } else if (out.text !== undefined) {
      payload = out.text;
    } else if (out.buffer !== undefined) {
      payload = out.buffer;
    }
    res.writeHead(out.status || 200, headers);
    res.end(payload);
  });
  server.keepAliveTimeout = 500;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    find: (method, pathRe) => requests.filter((r) => r.method === method && pathRe.test(r.path)),
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

// A port nothing listens on (for an instance that is down).
export async function deadPort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

// A Node-RED editor: the page loads red/red.min.js?v=<version>, /auth/login
// says how it logs in, /auth/token hands out a token, /flows returns flows.
export async function fakeNodeRed({ version = '4.0.9', login = true, nodes = 3 } = {}) {
  const flows = Array.from({ length: nodes }, (_, i) => ({ id: `n${i + 1}`, type: i === 0 ? 'tab' : 'inject', label: `node ${i + 1}` }));
  const srv = await mockServer((r) => {
    if (r.method === 'GET' && r.path === '/') {
      return {
        headers: { 'Content-Type': 'text/html' },
        text: `<!DOCTYPE html><html><head><title>Node-RED</title><script src="red/red.min.js?v=${version}"></script></head><body></body></html>`,
      };
    }
    if (r.method === 'GET' && r.path === '/auth/login') {
      return { json: login ? { type: 'credentials', prompts: [{ id: 'username', type: 'text', label: 'Username' }] } : {} };
    }
    if (r.method === 'POST' && r.path === '/auth/token') {
      return { json: { access_token: 'fake-node-red-token', expires_in: 604800, token_type: 'Bearer' } };
    }
    if (r.method === 'POST' && r.path === '/auth/revoke') return { json: {} };
    if (r.method === 'GET' && r.path === '/flows') {
      if (login && r.headers.authorization !== 'Bearer fake-node-red-token') return { status: 401, json: { message: 'Unauthorized' } };
      return { json: { rev: `rev-${version}`, flows } };
    }
    return undefined;
  });
  return { ...srv, flows };
}

export const GOOD_TOKEN = 'ghp_e2eTestToken0000000000000000000000';
export const BUILD_SHA = '1234567890abcdef1234567890abcdef12345678';
export const BUILDING_SHA = 'bbbbbbb890abcdef1234567890abcdef12345678';
export const FAILED_SHA = 'fffffff890abcdef1234567890abcdef12345678';

// A tiny transparent PNG for the account avatar.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

export function run({ sha, status = 'completed', conclusion = 'success', message = 'Build', minutesAgo = 10 }) {
  return {
    head_sha: sha,
    status,
    conclusion: status === 'completed' ? conclusion : null,
    updated_at: new Date(Date.now() - minutesAgo * 60000).toISOString(),
    html_url: `https://github.com/acme/nodered-user-admin/actions/runs/${sha.slice(0, 6)}`,
    head_commit: { message: `${message}\n\nlonger body` },
  };
}

// The parts of GitHub's REST API the dashboard uses: /user, repos, the Git
// Data API for backups, and Actions runs for dashboard updates.
export async function githubMock() {
  const state = {
    runs: [],
    repos: [
      { full_name: 'acme/flows-backup', private: true, permissions: { push: true, admin: true }, default_branch: 'main' },
      { full_name: 'acme/nodered-user-admin', private: false, permissions: { push: true }, default_branch: 'main' },
      { full_name: 'acme/public-site', private: false, permissions: { push: false }, default_branch: 'trunk' },
    ],
    commits: 0,
  };
  let avatarUrl = '';
  const srv = await mockServer((r) => {
    if (r.path === '/avatar.png') return { headers: { 'Content-Type': 'image/png' }, buffer: PNG };
    if (r.headers.authorization !== `Bearer ${GOOD_TOKEN}`) return { status: 401, json: { message: 'Bad credentials' } };
    let m;
    if (r.method === 'GET' && r.path === '/user') {
      return { json: { login: 'octo-e2e', name: 'Octo Tester', avatar_url: avatarUrl, html_url: 'https://github.com/octo-e2e' } };
    }
    if (r.method === 'GET' && r.path === '/user/repos') return { json: state.repos };
    if ((m = r.path.match(/^\/repos\/([^/]+\/[^/]+)\/actions\/workflows\/([^/]+)\/runs$/))) {
      return { json: { total_count: state.runs.length, workflow_runs: state.runs } };
    }
    if (r.method === 'GET' && (m = r.path.match(/^\/repos\/([^/]+\/[^/]+)$/))) {
      const repo = state.repos.find((x) => x.full_name === m[1]);
      if (!repo) return { status: 404, json: { message: 'Not Found' } };
      return { json: { ...repo, html_url: `https://github.com/${repo.full_name}` } };
    }
    if (r.method === 'GET' && /\/git\/ref\/heads\//.test(r.path)) return { json: { object: { sha: 'base000commit' } } };
    if (r.method === 'GET' && (m = r.path.match(/\/git\/commits\/([^/]+)$/))) return { json: { sha: m[1], tree: { sha: 'base000tree' } } };
    if (r.method === 'POST' && /\/git\/trees$/.test(r.path)) return { status: 201, json: { sha: 'newtree001' } };
    if (r.method === 'POST' && /\/git\/commits$/.test(r.path)) return { status: 201, json: { sha: `newcommit00${++state.commits}` } };
    if (r.method === 'POST' && /\/git\/refs$/.test(r.path)) return { status: 201, json: { ref: r.body.ref, object: { sha: r.body.sha } } };
    return undefined;
  });
  avatarUrl = `${srv.url}/avatar.png`;
  return { ...srv, state };
}

const pad64 = (s) => s + '0'.repeat(64 - s.length);
export const CONTAINERS = {
  main: pad64('c0ffee01'),
  open: pad64('c0ffee02'),
  stopped: pad64('c0ffee03'),
  dashboard: pad64('da5b0a4d'),
};

// A Docker Engine API as seen through the socket proxy: three Node-RED
// containers, the dashboard's own container, and the calls restart, update
// and the dashboard self-update make.
export async function dockerMock({ mainPort, openPort }) {
  const state = { restartDelay: 0, created: 0 };
  const list = [
    {
      Id: CONTAINERS.main,
      Names: ['/nodered-main'],
      Image: 'nodered/node-red:4.0.9',
      State: 'running',
      Status: 'Up 2 hours',
      Labels: {},
      Ports: [
        { IP: '0.0.0.0', PrivatePort: 1880, PublicPort: mainPort, Type: 'tcp' },
        { IP: '::', PrivatePort: 1880, PublicPort: mainPort, Type: 'tcp' },
      ],
      Mounts: [{ Type: 'bind', Source: '/srv/nodered-auth-e2e', Destination: '/auth' }],
      // Shares the accounts file and knows its own key. A test that empties
      // this (or changes the value) gets the "instance key" warning.
      Env: [`NODERED_INSTANCE=${mainPort}`],
    },
    {
      Id: CONTAINERS.open,
      Names: ['/nodered-open'],
      Image: 'nodered/node-red:3.1.0',
      State: 'running',
      Status: 'Up 5 minutes',
      Labels: {},
      Ports: [{ IP: '0.0.0.0', PrivatePort: 1880, PublicPort: openPort, Type: 'tcp' }],
      Mounts: [{ Type: 'volume', Name: 'open-data', Destination: '/data' }],
    },
    {
      Id: CONTAINERS.stopped,
      Names: ['/nodered-stopped'],
      Image: 'nodered/node-red:latest',
      State: 'exited',
      Status: 'Exited (0) 3 days ago',
      Labels: {},
      Ports: [],
      Mounts: [],
    },
    {
      Id: CONTAINERS.dashboard,
      Names: ['/nodered-user-admin'],
      Image: 'ghcr.io/acme/nodered-user-admin:dev',
      State: 'running',
      Status: 'Up 1 hour',
      Labels: { 'nodered-admin.role': 'dashboard' },
      Ports: [],
      Mounts: [],
    },
  ];
  const byId = (id) => list.find((c) => c.Id.startsWith(id) || c.Names[0] === `/${id}`);
  const srv = await mockServer((r) => {
    let m;
    if (r.method === 'GET' && r.path === '/containers/json') {
      const filters = r.query.get('filters');
      if (filters) return { json: filters.includes('role=dashboard') ? [list[3]] : [] };
      return { json: list };
    }
    if (r.method === 'POST' && r.path === '/images/create') {
      return { headers: { 'Content-Type': 'application/json' }, text: '{"status":"Pulling"}\n{"status":"Status: Image is up to date"}\n' };
    }
    if (r.method === 'GET' && (m = r.path.match(/^\/images\/(.+)\/json$/))) {
      return { json: { Id: 'sha256:same-image', Config: { Env: [], Labels: {} } } };
    }
    if (r.method === 'POST' && r.path === '/containers/create') {
      return { status: 201, json: { Id: pad64(`be1b${++state.created}`), Warnings: [] } };
    }
    if ((m = r.path.match(/^\/containers\/([^/]+)\/json$/)) && r.method === 'GET') {
      const c = byId(m[1]);
      if (!c) return { status: 404, json: { message: `No such container: ${m[1]}` } };
      return {
        json: {
          Id: c.Id,
          Name: c.Names[0],
          Image: 'sha256:same-image',
          State: { Running: c.State === 'running', ExitCode: 0 },
          Config: { Image: c.Image, Env: c.Env || [], Labels: {}, Hostname: c.Id.slice(0, 12) },
          HostConfig: {},
          Mounts: c.Mounts,
          NetworkSettings: { Networks: {} },
        },
      };
    }
    if (r.method === 'POST' && (m = r.path.match(/^\/containers\/([^/]+)\/(restart|start|stop)$/))) {
      return { status: 204, delay: m[2] === 'restart' ? state.restartDelay : 0 };
    }
    return undefined;
  });
  return { ...srv, state, list };
}
