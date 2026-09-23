// GitHub connection and flow backups, through the running server, against a
// fake GitHub and fake Node-REDs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fakeNodeRed, startServer, sleep, ADMIN, ADMIN_PW } from './helpers.mjs';
import { githubMock, GOOD_TOKEN } from './github-mock.mjs';

let gh, nrLogin, nrOpen, nrBroken, srv, c;
const FLOWS = [{ id: 'f1', type: 'tab', label: 'Main' }, { id: 'n1', type: 'debug', z: 'f1' }, { id: 'n2', type: 'inject', z: 'f1' }];

before(async () => {
  gh = await githubMock();
  nrLogin = await fakeNodeRed({ login: 'credentials', flows: FLOWS, users: { [ADMIN]: ADMIN_PW, backup: 'backup-pw-123' } });
  nrOpen = await fakeNodeRed({ login: 'open' });
  nrBroken = await fakeNodeRed({ login: 'open', flowsStatus: 500 });
  srv = await startServer({ env: { GITHUB_API: gh.url, DOCKER_API: '', SCAN_HOST_PORTS: '0' } });
  srv.writeJson('instances.json', [
    { name: 'Farm A', port: nrLogin.port },
    { name: 'Farm A', port: nrOpen.port },
    { name: 'Broken', port: nrBroken.port },
  ]);
  c = srv.client();
  await c.login(ADMIN, ADMIN_PW);
});
after(async () => {
  await srv?.stop();
  await Promise.all([gh, nrLogin, nrOpen, nrBroken].map((s) => s?.close()));
});

test('backups before GitHub is connected', async () => {
  const s = (await c.get('/api/backup')).body;
  assert.equal(s.githubConnected, false);
  assert.equal(s.nextRunAt, null);
  assert.equal(s.defaultLoginUser, ADMIN);
  assert.deepEqual(Object.keys(s).sort(), ['branchPrefix', 'canStoreSecrets', 'defaultLoginUser', 'githubConnected', 'history', 'loginSet', 'loginUser', 'nextRunAt', 'repo', 'running', 'schedule', 'timezone'].sort());
  const run = await c.post('/api/backup/run');
  assert.equal(run.status, 200);
  assert.equal(run.body.ok, false);
  assert.match(run.body.message, /no repository/);
});

test('connect GitHub: a bad token is refused and nothing is stored', async () => {
  const bad = await c.post('/api/github/connect', { token: 'ghp_wrong' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /401 Bad credentials/);
  assert.equal((await c.post('/api/github/connect', { token: '  ' })).status, 400);
  assert.equal((await c.get('/api/github')).body.connected, false);
});

test('connect GitHub with a good token', async () => {
  const r = await c.post('/api/github/connect', { token: ` ${GOOD_TOKEN} ` });
  assert.equal(r.status, 200);
  assert.equal(r.body.connected, true);
  assert.equal(r.body.account.login, 'octo');
  assert.equal(r.body.account.name, 'Octo Cat');
  assert.deepEqual(Object.keys(r.body).sort(), ['account', 'canStoreSecrets', 'connected', 'dashboardBranch', 'dashboardRepo']);
  const saved = JSON.stringify(srv.readJson('github.json'));
  assert.ok(!saved.includes(GOOD_TOKEN), 'the token is stored encrypted');
  assert.ok(!(await c.get('/api/github')).text.includes(GOOD_TOKEN));
  const req = gh.find('GET', '/user').at(-1);
  assert.equal(req.headers.authorization, `Bearer ${GOOD_TOKEN}`);
  assert.equal(req.headers['x-github-api-version'], '2022-11-28');
});

test('list repositories', async () => {
  const r = await c.get('/api/github/repos');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.find((x) => x.fullName === 'octo/readonly'), { fullName: 'octo/readonly', private: true, canPush: false, defaultBranch: 'main' });
  assert.match(gh.find('GET', '/user/repos').at(-1).url, /per_page=100/);
});

test('checkRepo refuses public and read-only repositories', async () => {
  assert.equal((await c.put('/api/backup', { repo: 'https://github.com/octo/public.git' })).body.repo, 'octo/public');
  let t = await c.post('/api/backup/test');
  assert.equal(t.status, 400);
  assert.match(t.body.error, /is public/);
  // A run also refuses, before reading any flows.
  nrOpen.clear();
  const run = await c.post('/api/backup/run');
  assert.equal(run.body.ok, false);
  assert.match(run.body.message, /is public/);
  assert.equal(nrOpen.find('GET', '/flows').length, 0);

  await c.put('/api/backup', { repo: 'octo/readonly' });
  t = await c.post('/api/backup/test');
  assert.equal(t.status, 400);
  assert.match(t.body.error, /cannot write/);

  await c.put('/api/backup', { repo: 'octo/private-empty' });
  t = await c.post('/api/backup/test');
  assert.equal(t.status, 200);
  assert.deepEqual(t.body, { ok: true, message: 'Connected to octo/private-empty, a private repository.', url: 'https://github.com/octo/private-empty' });
});

test('settings validation over the API', async () => {
  for (const body of [{ repo: 'bad' }, { branchPrefix: '..' }, { schedule: { mode: 'x' } }, { schedule: { time: '25:00' } }, { schedule: { mode: 'hours', everyHours: 7 } }, { schedule: { weekday: 9 } }]) {
    const r = await c.put('/api/backup', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const r = await c.put('/api/backup', { branchPrefix: 'nr/', schedule: { mode: 'daily', time: '03:00' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.repo, 'octo/private-empty');
  assert.equal(r.body.timezone, 'UTC');
  // Connected with a repo: the next run is booked, at 03:00 UTC.
  assert.match(r.body.nextRunAt, /T03:00:00\.000Z$/);
  assert.ok(new Date(r.body.nextRunAt) > new Date());
});

test('first backup to an empty repo: README, tree, commit, dated branch', async () => {
  gh.clear();
  nrLogin.tokenRequests.length = 0;
  const before = new Date();
  const r = await c.post('/api/backup/run');
  const after = new Date();
  assert.equal(r.status, 200);
  const e = r.body;
  assert.equal(e.ok, true, e.message);
  assert.equal(e.message, 'Backed up 2 of 3 instances (1 failed).');
  assert.match(e.trigger, /^manual \(administrator\)$/);

  // Branch: <prefix>YYYY-MM-DD_HH-MM-SS in the server's TZ (UTC here).
  assert.match(e.branch, /^nr\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
  const stamp = e.branch.slice(3).replace('_', 'T').replace(/-(\d{2})-(\d{2})$/, ':$1:$2') + 'Z';
  assert.ok(new Date(stamp) >= new Date(Math.floor(before / 1000) * 1000) && new Date(stamp) <= after, stamp);
  assert.equal(e.url, `https://github.com/octo/private-empty/tree/${e.branch}`);

  // Per-instance results; the same name twice gets separate folders.
  assert.deepEqual(
    e.instances.map((i) => [i.name, i.ok, i.folder]),
    [
      ['Farm A', true, `farm-a-${nrLogin.port}`],
      ['Farm A', true, `farm-a-${nrOpen.port}`],
      ['Broken', false, `broken-${nrBroken.port}`],
    ].sort((a, b) => Number(a[2].split('-').at(-1)) - Number(b[2].split('-').at(-1))),
  );
  const login = e.instances.find((i) => i.port === nrLogin.port);
  assert.equal(login.nodes, 3);
  assert.equal(login.rev, 'rev-1');
  assert.match(e.instances.find((i) => !i.ok).error, /GET \/flows returned 500/);

  // Logged in with read scope as the locked admin, then revoked the token.
  assert.equal(nrLogin.tokenRequests.length, 1);
  assert.deepEqual(nrLogin.tokenRequests[0], { client_id: 'node-red-admin', grant_type: 'password', scope: 'read', username: ADMIN, password: ADMIN_PW });
  const flowsReq = nrLogin.find('GET', '/flows').at(-1);
  assert.match(flowsReq.headers.authorization, /^Bearer tok-/);
  assert.equal(flowsReq.headers['node-red-api-version'], 'v2');
  await sleep(200);
  assert.deepEqual(nrLogin.revoked, [flowsReq.headers.authorization.slice(7)]);
  assert.equal(nrOpen.find('GET', '/flows').at(-1).headers.authorization, undefined);

  // GitHub calls, in order.
  const calls = gh.requests.map((x) => `${x.method} ${x.path}`);
  assert.deepEqual(calls, [
    'GET /repos/octo/private-empty',
    'GET /repos/octo/private-empty/git/ref/heads/main',
    'PUT /repos/octo/private-empty/contents/README.md',
    'GET /repos/octo/private-empty/git/commits/c-readme-1',
    'POST /repos/octo/private-empty/git/trees',
    'POST /repos/octo/private-empty/git/commits',
    'POST /repos/octo/private-empty/git/refs',
  ]);
  const readme = gh.find('PUT', '/repos/octo/private-empty/contents/README.md')[0].body;
  assert.match(Buffer.from(readme.content, 'base64').toString(), /^# Node-RED backups/);
  const tree = gh.find('POST', '/repos/octo/private-empty/git/trees')[0].body;
  assert.equal(tree.base_tree, 'tree-of-c-readme-1');
  assert.deepEqual(tree.tree.map((t) => t.path).sort(), [`farm-a-${nrLogin.port}/flows.json`, `farm-a-${nrOpen.port}/flows.json`, 'backup-info.json'].sort());
  for (const t of tree.tree) assert.deepEqual([t.mode, t.type], ['100644', 'blob']);
  assert.deepEqual(JSON.parse(tree.tree.find((t) => t.path.startsWith(`farm-a-${nrLogin.port}/`)).content), FLOWS);
  const info = JSON.parse(tree.tree.find((t) => t.path === 'backup-info.json').content);
  assert.equal(info.instances.length, 3);
  const commit = gh.find('POST', '/repos/octo/private-empty/git/commits')[0].body;
  assert.deepEqual(commit.parents, ['c-readme-1']);
  assert.match(commit.tree, /^tree-/);
  assert.match(commit.message, /FAILED, GET \/flows returned 500/);
  const ref = gh.find('POST', '/repos/octo/private-empty/git/refs')[0].body;
  assert.equal(ref.ref, `refs/heads/${e.branch}`);

  const state = (await c.get('/api/backup')).body;
  assert.equal(state.history[0].branch, e.branch);
  assert.equal(state.history[0].ok, true);
  assert.equal(state.history.length, 3, 'the two refused runs before this one are kept too');
  assert.equal(state.running, false);
});

test('second backup branches from the existing default branch', async () => {
  await sleep(1100); // a new second, so a new branch name
  gh.clear();
  const r = await c.post('/api/backup/run');
  assert.equal(r.body.ok, true, r.body.message);
  assert.equal(gh.find('PUT', '/repos/octo/private-empty/contents').length, 0);
  assert.deepEqual(gh.find('POST', '/repos/octo/private-empty/git/commits')[0].body.parents, ['c-readme-1']);
});

test('a separate backup login is used when set, and dropped when the name changes', async () => {
  let s = (await c.put('/api/backup', { loginUser: 'backup', loginPassword: 'backup-pw-123' })).body;
  assert.equal(s.loginUser, 'backup');
  assert.equal(s.loginSet, true);
  assert.ok(!JSON.stringify(srv.readJson('backup.json')).includes('backup-pw-123'));

  await sleep(1100);
  nrLogin.tokenRequests.length = 0;
  const r = await c.post('/api/backup/run');
  assert.equal(r.body.ok, true, r.body.message);
  assert.equal(nrLogin.tokenRequests[0].username, 'backup');

  // Same name, no password: the stored one stays.
  s = (await c.put('/api/backup', { loginUser: 'backup', loginPassword: '' })).body;
  assert.equal(s.loginSet, true);
  // A different name without a password must not reuse the old password.
  s = (await c.put('/api/backup', { loginUser: 'someone-else' })).body;
  assert.equal(s.loginSet, false);
  s = (await c.put('/api/backup', { loginUser: '' })).body;
  assert.equal(s.loginUser, '');
  assert.equal(s.loginSet, false);
});

test('a refused Node-RED login fails only that instance', async () => {
  await c.put('/api/backup', { loginUser: 'backup', loginPassword: 'not-the-password' });
  await sleep(1100);
  const r = await c.post('/api/backup/run');
  assert.equal(r.body.ok, true);
  assert.match(r.body.instances.find((i) => i.port === nrLogin.port).error, /login as backup was refused \(401\)/);
  await c.put('/api/backup', { loginUser: '' });
});

test('every instance failing records a failed run', async () => {
  srv.writeJson('instances.json', [{ name: 'Broken', port: nrBroken.port }]);
  gh.clear();
  const r = await c.post('/api/backup/run');
  assert.equal(r.body.ok, false);
  assert.match(r.body.message, /^Could not read flows from any instance: Broken: GET \/flows returned 500/);
  assert.equal(gh.find('POST', '/repos/octo/private-empty/git/refs').length, 0, 'no branch for an empty backup');

  srv.writeJson('instances.json', []);
  const none = await c.post('/api/backup/run');
  assert.match(none.body.message, /No online Node-RED instances/);
});

test('two runs in the same second get distinct branches', async () => {
  srv.writeJson('instances.json', [{ name: 'Open', port: nrOpen.port }]);
  const a = await c.post('/api/backup/run');
  const b = await c.post('/api/backup/run');
  assert.equal(a.body.ok, true, a.body.message);
  assert.equal(b.body.ok, true, b.body.message);
  assert.notEqual(a.body.branch, b.body.branch);
  // Usually both land in the same second; then the second one gets -2.
  assert.ok(b.body.branch === `${a.body.branch}-2` || /_\d{2}-\d{2}-\d{2}$/.test(b.body.branch), b.body.branch);
});

test('history keeps the newest 30 runs', async () => {
  await sleep(1100);
  const saved = srv.readJson('backup.json');
  saved.history = Array.from({ length: 30 }, (_, i) => ({ at: new Date(Date.UTC(2020, 0, 1, 0, i)).toISOString(), trigger: 'old', ok: true, message: `old ${i}` }));
  srv.writeJson('backup.json', saved);
  srv.writeJson('instances.json', [{ name: 'Open', port: nrOpen.port }]);
  const r = await c.post('/api/backup/run');
  assert.equal(r.body.ok, true, r.body.message);
  const h = (await c.get('/api/backup')).body.history;
  assert.equal(h.length, 30);
  assert.equal(h[0].at, r.body.at);
  assert.equal(h[1].message, 'old 0');
  assert.equal(h[29].message, 'old 28');
});

test('two runs at once: the second is refused', async () => {
  srv.writeJson('instances.json', [{ name: 'Open', port: nrOpen.port }]);
  await sleep(1100);
  const [a, b] = await Promise.all([c.post('/api/backup/run'), c.post('/api/backup/run')]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  assert.match((a.status === 409 ? a : b).body.error, /already running/);
});

test('disconnecting GitHub stops the schedule', async () => {
  const r = await c.post('/api/github/disconnect');
  assert.equal(r.body.connected, false);
  assert.equal((await c.get('/api/backup')).body.nextRunAt, null);
  assert.equal((await c.get('/api/github/repos')).status, 400);
  // Non-admins can't see or change any of this.
  await c.post('/api/users', { username: 'viewer', permissions: 'read', password: 'viewer-pass-1' });
  const v = srv.client();
  await v.login('viewer', 'viewer-pass-1');
  for (const [m, p] of [['get', '/api/backup'], ['get', '/api/github'], ['post', '/api/backup/run'], ['get', '/api/dashboard']]) {
    assert.equal((await v[m](p)).status, 403, p);
  }
});
