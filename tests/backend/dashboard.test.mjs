// Dashboard self-update: build status from GitHub Actions (mocked), the update
// request (Docker mocked), and the record finished on the next start.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, tempDir, sleep, ADMIN, ADMIN_PW } from './helpers.mjs';
import { githubMock, GOOD_TOKEN } from './github-mock.mjs';
import { dockerMock, id64, NEW_IMAGE } from './docker-mock.mjs';

const run = (sha, status, conclusion, msg = `commit ${sha}\n\nbody`) => ({
  head_sha: sha,
  status,
  conclusion,
  updated_at: '2026-09-24T10:00:00Z',
  html_url: `https://github.com/octo/dash/actions/runs/${sha}`,
  head_commit: { message: msg },
});

let gh, d, srv, c;
const dir = tempDir('dash');
const env = () => ({ GITHUB_API: gh.url, DOCKER_API: d.url, APP_REVISION: 'aaa111', DASHBOARD_UPDATE_CONFIRM_MS: '300' });

before(async () => {
  gh = await githubMock();
  // The list says which network this dashboard is on, like Docker's does.
  d = await dockerMock({ roleList: [{ Id: id64('dash1'), Names: ['/nodered-user-admin'], HostConfig: { NetworkMode: 'nrua_default' } }] });
  d.state.pulledId = NEW_IMAGE;
  srv = await startServer({ dir, env: env() });
  c = srv.client();
  await c.login(ADMIN, ADMIN_PW);
});
after(async () => {
  await srv?.stop();
  await gh?.close();
  await d?.close();
});

test('not configured until GitHub is connected and a repo is chosen', async () => {
  let s = (await c.get('/api/dashboard')).body;
  assert.deepEqual(s, { revision: 'aaa111', repo: '', branch: 'main', workflow: 'docker.yml', lastUpdate: null, configured: false });
  await c.post('/api/github/connect', { token: GOOD_TOKEN });
  s = (await c.get('/api/dashboard')).body;
  assert.equal(s.configured, false);
  const put = await c.put('/api/github', { dashboardRepo: 'https://github.com/Octo/Dash', dashboardBranch: 'main' });
  assert.equal(put.body.dashboardRepo, 'Octo/Dash');
  assert.equal((await c.put('/api/github', { dashboardBranch: 'a..b' })).status, 400);
  assert.equal((await c.put('/api/github', { dashboardRepo: 'nope' })).status, 400);
});

test('a newer finished build means an update is available', async () => {
  gh.state.runs = [run('bbb222', 'completed', 'success'), run('aaa111', 'completed', 'success')];
  const s = (await c.get('/api/dashboard')).body;
  assert.equal(s.configured, true);
  assert.equal(s.canUpdate, true);
  assert.equal(s.updateAvailable, true);
  assert.equal(s.image, 'ghcr.io/octo/dash:bbb222', 'lower-case for the registry');
  assert.deepEqual(s.latestBuild, { sha: 'bbb222', at: '2026-09-24T10:00:00Z', url: 'https://github.com/octo/dash/actions/runs/bbb222', message: 'commit bbb222' });
  assert.equal(s.building, null);
  assert.equal(s.failedBuild, null);
  const q = new URL(gh.find('GET', '/repos/Octo/Dash/actions/workflows/docker.yml/runs').at(-1).url, 'http://x').searchParams;
  assert.equal(q.get('branch'), 'main');
  assert.equal(q.get('event'), 'push');
});

test('a build in progress is reported, the last finished one is still offered', async () => {
  gh.state.runs = [run('ccc333', 'in_progress', null), run('bbb222', 'completed', 'success')];
  const s = (await c.get('/api/dashboard')).body;
  assert.equal(s.building.sha, 'ccc333');
  assert.equal(s.latestBuild.sha, 'bbb222');
  assert.equal(s.updateAvailable, true);
  assert.equal(s.failedBuild, null);
});

test('a failed newest build is reported and nothing newer is offered', async () => {
  gh.state.runs = [run('ddd444', 'completed', 'failure'), run('aaa111', 'completed', 'success')];
  const s = (await c.get('/api/dashboard')).body;
  assert.equal(s.failedBuild.sha, 'ddd444');
  assert.equal(s.building, null);
  assert.equal(s.latestBuild.sha, 'aaa111');
  assert.equal(s.updateAvailable, false);
  const u = await c.post('/api/dashboard/update');
  assert.equal(u.status, 400);
  assert.match(u.body.error, /no newer finished build/);
});

test('no builds at all', async () => {
  gh.state.runs = [];
  const s = (await c.get('/api/dashboard')).body;
  assert.equal(s.updateAvailable, false);
  assert.equal(s.latestBuild, null);
  assert.equal(s.image, null);
});

test('update: finds its own container, pulls with the GitHub login, starts the helper', async () => {
  gh.state.runs = [run('bbb222', 'completed', 'success')];
  d.clear();
  const r = await c.post('/api/dashboard/update');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body, { ok: true, message: 'Updating. The dashboard restarts in a few seconds and this page reloads.', to: 'bbb222' });

  const role = d.find('GET', '/containers/json')[0];
  assert.deepEqual(JSON.parse(new URL(role.url, 'http://x').searchParams.get('filters')).label, ['nodered-admin.role=dashboard']);

  const pull = d.find('POST', '/images/create')[0];
  assert.equal(pull.url, '/images/create?fromImage=ghcr.io%2Focto%2Fdash&tag=bbb222');
  assert.deepEqual(JSON.parse(Buffer.from(pull.headers['x-registry-auth'], 'base64url').toString()), { username: 'octo', password: GOOD_TOKEN, serveraddress: 'ghcr.io' });

  const create = d.find('POST', '/containers/create')[0].body;
  assert.equal(create.Image, 'ghcr.io/octo/dash:bbb222');
  assert.deepEqual(create.Cmd, ['node', 'self-update.js', id64('dash1'), 'ghcr.io/octo/dash:bbb222']);
  assert.deepEqual(create.Env, [`DOCKER_API=${d.url}`]);
  assert.equal(create.HostConfig.NetworkMode, 'nrua_default', "the helper joins the dashboard's own network, so it reaches the proxy the same way");
  assert.equal(create.HostConfig.AutoRemove, true);
  assert.ok(d.calls().at(-1).endsWith('/start'));

  const pending = srv.readJson('dashboard-update.json');
  assert.equal(pending.from, 'aaa111');
  assert.equal(pending.to, 'bbb222');
  assert.equal(pending.by, ADMIN);
  assert.equal(pending.result, undefined);
  assert.equal((await c.get('/api/dashboard')).body.lastUpdate.to, 'bbb222');
});

test('helper network: from the inspect when the list lacks it; host stays host; one update at a time', async () => {
  gh.state.runs = [run('bbb222', 'completed', 'success')];
  d.state.roleList = [{ Id: id64('dash1') }];
  d.state.containers[id64('dash1')] = { Id: id64('dash1'), Name: '/nodered-user-admin', HostConfig: { NetworkMode: 'compose_net' } };
  d.clear();
  let r = await c.post('/api/dashboard/update');
  assert.equal(r.status, 200, r.text);
  assert.equal(d.find('POST', '/containers/create')[0].body.HostConfig.NetworkMode, 'compose_net');
  assert.ok(d.calls().includes(`GET /containers/${id64('dash1')}/json`));

  d.state.containers[id64('dash1')].HostConfig.NetworkMode = 'host';
  d.clear();
  r = await c.post('/api/dashboard/update');
  assert.equal(r.status, 200, r.text);
  assert.equal(d.find('POST', '/containers/create')[0].body.HostConfig.NetworkMode, 'host');

  // Two clicks while the pull is slow: the second is refused, and the flag clears afterwards.
  d.state.pullDelay = 400;
  d.clear();
  const [a, b] = await Promise.all([c.post('/api/dashboard/update'), c.post('/api/dashboard/update')]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.match((a.status === 409 ? a : b).body.error, /already in progress/);
  assert.equal(d.find('POST', '/containers/create').length, 1, 'one helper');
  d.state.pullDelay = 0;
  assert.equal((await c.post('/api/dashboard/update')).status, 200, 'not stuck busy');
  // ...and after a failure.
  d.state.createFails = true;
  try {
    assert.equal((await c.post('/api/dashboard/update')).status, 400);
  } finally {
    d.state.createFails = false;
  }
  assert.equal((await c.post('/api/dashboard/update')).status, 200);

  delete d.state.containers[id64('dash1')];
  d.state.roleList = [{ Id: id64('dash1'), Names: ['/nodered-user-admin'], HostConfig: { NetworkMode: 'nrua_default' } }];
});

test('the next start as the new revision records ok (after it stays up)', async () => {
  await srv.stop();
  srv = await startServer({ dir, env: { ...env(), APP_REVISION: 'bbb222' } });
  assert.equal(srv.readJson('dashboard-update.json').result, undefined, 'not yet: the helper may still roll back');
  await sleep(700);
  const rec = srv.readJson('dashboard-update.json');
  assert.equal(rec.result, 'ok');
  assert.ok(rec.finishedAt);
  c = srv.client();
  await c.login(ADMIN, ADMIN_PW);
  assert.equal((await c.get('/api/dashboard')).body.lastUpdate.result, 'ok');
  // A finished record is left alone by later starts.
  await srv.stop();
  srv = await startServer({ dir, env: { ...env(), APP_REVISION: 'zzz' } });
  assert.equal(srv.readJson('dashboard-update.json').result, 'ok');
});

test('the next start as the old revision records rolled back', async () => {
  srv.writeJson('dashboard-update.json', { from: 'aaa111', to: 'bbb222', at: new Date().toISOString(), by: ADMIN });
  await srv.stop();
  srv = await startServer({ dir, env: env() });
  assert.equal(srv.readJson('dashboard-update.json').result, 'rolled back');
  c = srv.client();
  await c.login(ADMIN, ADMIN_PW);
});

test('update refusals: no dashboard container, pull failure, helper failure', async () => {
  gh.state.runs = [run('bbb222', 'completed', 'success')];
  fs.rmSync(path.join(dir, 'dashboard-update.json'), { force: true });

  d.state.roleList = [];
  let r = await c.post('/api/dashboard/update');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Cannot find this dashboard's container/);
  // No network in the list and no inspect possible: the helper falls back to the host network.
  d.state.roleList = [{ Id: id64('dash1') }];

  d.state.pullBody = '{"error":"denied: permission_denied"}';
  r = await c.post('/api/dashboard/update');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /denied/);
  assert.ok(!fs.existsSync(path.join(dir, 'dashboard-update.json')), 'nothing recorded when the pull fails');
  d.state.pullBody = '{"status":"ok"}\n';

  // The helper can't be created: no record left for the next start to call "rolled back".
  d.state.createFails = true;
  try {
    r = await c.post('/api/dashboard/update');
  } finally {
    d.state.createFails = false;
  }
  assert.equal(r.status, 400);
  assert.match(r.body.error, /updates are not enabled on the Docker proxy/);
  assert.ok(!fs.existsSync(path.join(dir, 'dashboard-update.json')), 'no pending record after a failed start');
});

test('without Docker the dashboard can not update itself', async () => {
  await srv.stop();
  srv = await startServer({ dir, env: { ...env(), DOCKER_API: '' } });
  c = srv.client();
  await c.login(ADMIN, ADMIN_PW);
  gh.state.runs = [run('bbb222', 'completed', 'success')];
  const s = (await c.get('/api/dashboard')).body;
  assert.equal(s.canUpdate, false);
  const r = await c.post('/api/dashboard/update');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Docker access is not configured/);
});
