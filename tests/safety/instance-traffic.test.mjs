// Everything the dashboard ever sends to a Node-RED instance: discovery reads
// "/" and "/auth/login", backups read "/flows" with a read-scoped token that is
// revoked afterwards. Nothing writes flows, deploys, or changes an instance.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeNodeRed, startServer, acceptsBackupAccount, ADMIN, ADMIN_PW, BACKUP_USER, ROOT } from '../backend/helpers.mjs';
import { githubMock, GOOD_TOKEN } from '../backend/github-mock.mjs';
import { dockerModel } from './docker-model.mjs';
import { safetyDir } from './util.mjs';

const ALLOWED = new Set(['GET /', 'GET /auth/login', 'GET /flows', 'POST /auth/token', 'POST /auth/revoke']);
const closers = [];
after(async () => {
  for (const c of closers.reverse()) await c();
});

test('Node-RED instances only ever see reads, and a read-only login for backups', async () => {
  const gh = await githubMock();
  let srv;
  const nrDocker = await fakeNodeRed({ login: 'credentials', users: acceptsBackupAccount(() => srv) });
  const nrConfigured = await fakeNodeRed({ login: 'open' });
  const d = await dockerModel();
  closers.push(() => gh.close(), () => nrDocker.close(), () => nrConfigured.close(), () => d.close());
  for (const p of [nrDocker.port, nrConfigured.port]) assert.ok(![1880, 1890, 1891].includes(p));
  d.addImage('nodered/node-red:latest', { Env: [], Volumes: { '/data': {} }, Labels: {} });
  // Mounts /auth: uses the shared accounts, so the backup login may be sent to it.
  const c0 = await d.run('nodered', { Image: 'nodered/node-red:latest', HostConfig: { Binds: ['nr_data:/data', '/opt/nodered-auth:/auth:ro'], PortBindings: { '1880/tcp': [{ HostPort: String(nrDocker.port) }] } } });

  const dir = safetyDir('traffic');
  fs.writeFileSync(path.join(dir, 'instances.json'), JSON.stringify([{ name: 'Configured', port: nrConfigured.port }]));
  srv = await startServer({ dir, env: { GITHUB_API: gh.url, DOCKER_API: d.url } });
  closers.push(() => srv.stop());
  const c = srv.client();
  await c.login(ADMIN, ADMIN_PW);

  const list = (await c.get('/api/instances')).body.instances;
  assert.deepEqual(list.map((i) => i.port).sort(), [nrDocker.port, nrConfigured.port].sort());
  assert.equal((await c.post(`/api/instances/${c0.Id.slice(0, 12)}/restart`)).status, 200);
  await c.post('/api/github/connect', { token: GOOD_TOKEN });
  await c.put('/api/backup', { repo: 'octo/private-full' });
  const run = (await c.post('/api/backup/run')).body;
  assert.equal(run.ok, true, run.message);
  assert.equal(run.instances.filter((i) => i.ok).length, 2);
  // User management reaches no instance at all.
  const beforeUsers = nrDocker.requests.length + nrConfigured.requests.length;
  await c.post('/api/users', { username: 'x1', permissions: 'read', password: 'x1-password-1' });
  await c.put('/api/users/x1', { permissions: '*' });
  await c.del('/api/users/x1');
  assert.equal(nrDocker.requests.length + nrConfigured.requests.length, beforeUsers);

  for (const nr of [nrDocker, nrConfigured]) {
    for (const r of nr.requests) assert.ok(ALLOWED.has(`${r.method} ${r.path}`), `unexpected ${r.method} ${r.path}`);
    assert.ok(nr.requests.some((r) => r.method === 'GET' && r.path === '/flows'));
  }
  // The token asked for is read-only, for the dashboard's own read-only account
  // (never the administrator), and it is revoked afterwards.
  assert.equal(nrDocker.tokenRequests.length, 1);
  assert.equal(nrDocker.tokenRequests[0].username, BACKUP_USER);
  assert.notEqual(nrDocker.tokenRequests[0].password, ADMIN_PW);
  assert.equal(nrDocker.tokenRequests[0].scope, 'read');
  assert.equal(nrDocker.tokenRequests[0].client_id, 'node-red-admin');
  for (let i = 0; i < 50 && nrDocker.revoked.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(nrDocker.revoked.length, 1);
  assert.equal(nrConfigured.tokenRequests.length, 0, 'an open instance gets no login at all');
  // The only Docker write was the restart that was asked for.
  assert.deepEqual(d.mutations().map((m) => `${m.method} ${m.url.split('?')[0]}`), [`POST /containers/${c0.Id.slice(0, 12)}/restart`]);
});

// A guard against future edits: the backend never names a flows file, settings.js,
// a .config file or a Node-RED userDir, and every file write goes to a known target.
test('backend source: no writes to Node-RED files, no non-GET flow requests', () => {
  const files = ['server.js', 'backup.js', 'github.js', 'docker.js', 'self-update.js', 'nodered/adminAuth.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.doesNotMatch(code, /flows_cred|\.config\.[a-z]+\.json|\.node-red|['"`]\/data\b/, `${f} names a Node-RED file`);
    assert.doesNotMatch(code, /settings\.js\b/, `${f} names settings.js in code`); // settings.json is the dashboard's own
    // fetch(`…/flows`…) calls: none may carry a method.
    for (const m of code.matchAll(/fetch\(`[^`]*\/flows?[`/?][^;]*/g)) assert.doesNotMatch(m[0], /method\s*:/, `${f}: ${m[0].slice(0, 80)}`);
    const writes = [...code.matchAll(/fs\.(writeFileSync|renameSync|rmSync|unlinkSync|appendFileSync|mkdirSync|copyFileSync|chmodSync)\(([^,)]+)/g)].map((m) => m[2].trim());
    const known = ['tmp', 'USERS_FILE', 'SECRET_KEY_FILE', 'DASHBOARD_UPDATE_FILE', 'INITIAL_PASSWORD_FILE', '`${dest}.tmp`', 'dest', '`${file}.tmp`', 'file'];
    for (const t of writes) assert.ok(known.includes(t), `${f} writes to ${t}`);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'backup.js'), 'utf8'), /['"]POST['"][^\n]*\/flows/);
});
