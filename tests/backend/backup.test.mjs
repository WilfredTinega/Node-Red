// GitHub connection and flow backups, through the running server, against a
// fake GitHub and fake Node-REDs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { fakeNodeRed, startServer, sleep, acceptsBackupAccount, ADMIN, ADMIN_PW, BACKUP_USER } from './helpers.mjs';
import { githubMock, GOOD_TOKEN } from './github-mock.mjs';

let gh, nrLogin, nrOpen, nrBroken, nrRemote, srv, c;
const FLOWS = [{ id: 'f1', type: 'tab', label: 'Main' }, { id: 'n1', type: 'debug', z: 'f1' }, { id: 'n2', type: 'inject', z: 'f1' }];

before(async () => {
  gh = await githubMock();
  // Accepts the dashboard's own backup account (its password is only in the
  // server's files) and a hand-set login; the administrator is never valid here.
  const users = (u, p) => (u === 'backup' && p === 'backup-pw-123') || acceptsBackupAccount(() => srv)(u, p);
  nrLogin = await fakeNodeRed({ login: 'credentials', flows: FLOWS, users });
  nrOpen = await fakeNodeRed({ login: 'open' });
  nrBroken = await fakeNodeRed({ login: 'open', flowsStatus: 500 });
  nrRemote = await fakeNodeRed({ login: 'credentials', users });
  srv = await startServer({ env: { GITHUB_API: gh.url, DOCKER_API: '', SCAN_HOST_PORTS: '0' } });
  srv.writeJson('instances.json', [
    { name: 'Farm A', port: nrLogin.port, sharedLogins: true },
    { name: 'Farm A', port: nrOpen.port },
    { name: 'Broken', port: nrBroken.port },
  ]);
  c = srv.client();
  await c.login(ADMIN, ADMIN_PW);
});
after(async () => {
  await srv?.stop();
  await Promise.all([gh, nrLogin, nrOpen, nrBroken, nrRemote].map((s) => s?.close()));
});

const backupUser = () => srv.readJson('users.json').find((u) => u.username === BACKUP_USER);

test('backups before GitHub is connected', async () => {
  const s = (await c.get('/api/backup')).body;
  assert.equal(s.githubConnected, false);
  assert.equal(s.nextRunAt, null);
  assert.equal(s.defaultLoginUser, BACKUP_USER);
  assert.equal(backupUser(), undefined, 'the backup account is only made when a backup needs it');
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

  // Per-instance results; the folder carries the address (host + port).
  const fld = (name, port) => `${name}_127.0.0.1-${port}`;
  assert.deepEqual(
    e.instances.map((i) => [i.name, i.ok, i.folder, i.address]),
    [
      ['Farm A', true, fld('farm-a', nrLogin.port), `127.0.0.1:${nrLogin.port}`],
      ['Farm A', true, fld('farm-a', nrOpen.port), `127.0.0.1:${nrOpen.port}`],
      ['Broken', false, fld('broken', nrBroken.port), `127.0.0.1:${nrBroken.port}`],
    ].sort((a, b) => Number(a[2].split('-').at(-1)) - Number(b[2].split('-').at(-1))),
  );
  const login = e.instances.find((i) => i.port === nrLogin.port);
  assert.equal(login.nodes, 3);
  assert.equal(login.rev, 'rev-1');
  assert.match(e.instances.find((i) => !i.ok).error, /GET \/flows returned 500/);

  // Logged in with read scope as the dashboard's own backup account, then revoked the token.
  assert.equal(nrLogin.tokenRequests.length, 1);
  const sent = nrLogin.tokenRequests[0];
  assert.deepEqual({ ...sent, password: '<checked below>' }, { client_id: 'node-red-admin', grant_type: 'password', scope: 'read', username: BACKUP_USER, password: '<checked below>' });
  assert.notEqual(sent.password, ADMIN_PW);
  assert.ok(sent.password.length >= 16);
  // The account it made: read-only, marked system, hash only (never viewable).
  const bu = backupUser();
  assert.equal(bu.permissions, 'read');
  assert.equal(bu.system, true);
  assert.equal(bu.instances, undefined);
  assert.equal(bu.secret, undefined);
  assert.ok(bcrypt.compareSync(sent.password, bu.password));
  // The plaintext lives only encrypted in backup.json.
  const saved = srv.readJson('backup.json');
  assert.match(saved.systemLoginSecret, /^v1:/);
  assert.ok(!JSON.stringify(saved).includes(sent.password));
  assert.equal(saved.loginUser, '', 'not shown as a hand-set login');
  assert.equal((await c.get('/api/backup')).body.loginSet, false);
  assert.equal((await c.get('/api/users')).body.find((u) => u.username === BACKUP_USER).system, true);
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
    'POST /repos/octo/private-empty/git/trees',
    'POST /repos/octo/private-empty/git/commits',
    'POST /repos/octo/private-empty/git/refs',
  ]);
  const readme = gh.find('PUT', '/repos/octo/private-empty/contents/README.md')[0].body;
  assert.match(Buffer.from(readme.content, 'base64').toString(), /^# Node-RED backups/);
  const tree = gh.find('POST', '/repos/octo/private-empty/git/trees')[0].body;
  // No base_tree, and only flow files: the branch never carries README or a
  // metadata file, just each instance's flows under its address folder.
  assert.equal(tree.base_tree, undefined);
  assert.deepEqual(tree.tree.map((t) => t.path).sort(), [`farm-a_127.0.0.1-${nrLogin.port}/flows.json`, `farm-a_127.0.0.1-${nrOpen.port}/flows.json`].sort());
  for (const t of tree.tree) assert.deepEqual([t.mode, t.type], ['100644', 'blob']);
  assert.deepEqual(JSON.parse(tree.tree.find((t) => t.path.startsWith(`farm-a_127.0.0.1-${nrLogin.port}/`)).content), FLOWS);
  assert.ok(!tree.tree.some((t) => /backup-info|README/.test(t.path)), 'no metadata files in the branch');
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

test('the backup account heals itself: deleted or reset by hand, it gets a new password; the same one is reused otherwise', async () => {
  const secretBefore = srv.readJson('backup.json').systemLoginSecret;
  const hashBefore = backupUser().password;
  await sleep(1100);
  nrLogin.tokenRequests.length = 0;
  let r = await c.post('/api/backup/run');
  assert.equal(r.body.ok, true, r.body.message);
  assert.equal(srv.readJson('backup.json').systemLoginSecret, secretBefore, 'still valid: kept');
  assert.equal(backupUser().password, hashBefore);

  // Deleted on the Users page: recreated with a fresh password.
  assert.equal((await c.del(`/api/users/${BACKUP_USER}`)).status, 200);
  await sleep(1100);
  nrLogin.tokenRequests.length = 0;
  r = await c.post('/api/backup/run');
  assert.equal(r.body.ok, true, r.body.message);
  assert.equal(nrLogin.tokenRequests[0].username, BACKUP_USER);
  assert.notEqual(srv.readJson('backup.json').systemLoginSecret, secretBefore);
  assert.notEqual(backupUser().password, hashBefore);
  assert.equal(backupUser().system, true);

  // Password reset by hand: the stored copy no longer matches, so it is rotated.
  const users = srv.readJson('users.json');
  users.find((u) => u.username === BACKUP_USER).password = bcrypt.hashSync('someone-changed-it', 4);
  srv.writeJson('users.json', users);
  const secretMid = srv.readJson('backup.json').systemLoginSecret;
  await sleep(1100);
  r = await c.post('/api/backup/run');
  assert.equal(r.body.ok, true, r.body.message);
  assert.equal(r.body.instances.find((i) => i.port === nrLogin.port).ok, true);
  assert.notEqual(srv.readJson('backup.json').systemLoginSecret, secretMid);
  assert.ok(!bcrypt.compareSync('someone-changed-it', backupUser().password));

  // Across everything so far, the administrator's login was never sent anywhere.
  for (const nr of [nrLogin, nrRemote]) assert.ok(nr.tokenRequests.every((t) => t.username !== ADMIN));
});

test('every online instance is backed up; login-required ones use the read-only backup account', async () => {
  srv.writeJson('instances.json', [
    { name: 'Not shared', port: nrLogin.port },
    { name: 'Remote', host: '127.0.0.1', port: nrRemote.port },
    { name: 'Open', port: nrOpen.port },
  ]);
  await sleep(1100);
  nrLogin.clear();
  nrLogin.tokenRequests.length = 0;
  nrRemote.tokenRequests.length = 0;
  const r = await c.post('/api/backup/run');
  assert.equal(r.body.ok, true, r.body.message);
  // All three online instances are included, not just the ones marked shared.
  assert.equal(r.body.message, 'Backed up 3 of 3 instances.');
  for (const name of ['Not shared', 'Remote', 'Open']) {
    assert.equal(r.body.instances.find((i) => i.name === name).ok, true, name);
  }
  // The login-required ones were logged into as the read-only backup account,
  // never the administrator; the open one got no login.
  assert.equal(nrLogin.tokenRequests.at(-1).username, BACKUP_USER);
  assert.equal(nrRemote.tokenRequests.at(-1).username, BACKUP_USER);
  for (const nr of [nrLogin, nrRemote]) assert.ok(nr.tokenRequests.every((t) => t.username !== ADMIN && t.password !== ADMIN_PW));
  assert.equal(nrOpen.find('GET', '/flows').at(-1).headers.authorization, undefined, 'an open instance gets no login');
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
  await sleep(1100); // a second no earlier test used
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
