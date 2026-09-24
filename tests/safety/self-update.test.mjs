// The dashboard's self-update can only ever recreate the dashboard's own
// container: never a Node-RED one, and never a guess among several.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createDocker } from '../../docker.js';
import { dockerModel } from './docker-model.mjs';
import { fakeNodeRed, startServer, ROOT, ADMIN, ADMIN_PW } from '../backend/helpers.mjs';
import { githubMock, GOOD_TOKEN } from '../backend/github-mock.mjs';
import { safetyDir } from './util.mjs';

const DASH_IMAGE = { Env: ['PATH=/usr/bin'], Cmd: ['node', 'server.js'], WorkingDir: '/app', Labels: { 'nodered-admin.role': 'dashboard' } };
const NR_IMAGE = { Env: ['PATH=/usr/bin'], Cmd: ['npm', 'start'], Volumes: { '/data': {} }, Labels: {} };

const cleanups = [];
after(async () => {
  for (const f of cleanups.reverse()) await f();
});

async function world({ dashboards = 1, nrPort }) {
  const d = await dockerModel();
  cleanups.push(() => d.close());
  d.addImage('ghcr.io/octo/dash:aaa111', DASH_IMAGE);
  d.addImage('nodered/node-red:latest', NR_IMAGE);
  const nr = await d.run('nodered', {
    Image: 'nodered/node-red:latest',
    Env: ['NODERED_INSTANCE=1880'],
    HostConfig: { Binds: ['nodered_data:/data'], PortBindings: nrPort ? { '1880/tcp': [{ HostPort: String(nrPort) }] } : {} },
  });
  d.model.volumes.nodered_data.files['flows.json'] = Buffer.from('[{"id":"x"}]');
  const dash = [];
  for (let i = 0; i < dashboards; i++) {
    dash.push(await d.run(i ? `nodered-user-admin-${i}` : 'nodered-user-admin', { Image: 'ghcr.io/octo/dash:aaa111', HostConfig: { NetworkMode: 'host' } }));
  }
  return { d, nr, dash, nrBefore: d.view(nr) };
}

const runSelfUpdate = (dockerUrl, target, ref) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'self-update.js'), target, ref], { env: { PATH: process.env.PATH, DOCKER_API: dockerUrl } });
    let out = '';
    child.stdout.on('data', (x) => (out += x));
    child.stderr.on('data', (x) => (out += x));
    child.once('exit', (code) => resolve({ code, out }));
  });

test('findByRole: only the labelled container, refuses to guess between several', async () => {
  const one = await world({ dashboards: 1 });
  const docker = createDocker(one.d.url);
  assert.equal((await docker.findByRole('dashboard')).Id, one.dash[0].Id);
  assert.equal((await docker.findByRole('dashboard', one.dash[0].Id.slice(0, 12))).Id, one.dash[0].Id);
  assert.equal(await docker.findByRole('dashboard', one.nr.Id), null, 'a Node-RED id is never accepted as "own"');

  const two = await world({ dashboards: 2 });
  const docker2 = createDocker(two.d.url);
  await assert.rejects(docker2.findByRole('dashboard'), /2 running containers are labelled/);
  assert.equal((await docker2.findByRole('dashboard', two.dash[1].Id)).Id, two.dash[1].Id);

  const none = await world({ dashboards: 0 });
  assert.equal(await createDocker(none.d.url).findByRole('dashboard'), null);
  assert.deepEqual(none.d.mutations(), []);
});

test('self-update.js refuses a Node-RED container and touches nothing', async () => {
  const { d, nr, nrBefore } = await world({ dashboards: 1 });
  d.clear();
  for (const target of [nr.Id, nr.Id.slice(0, 12), 'nodered']) {
    const r = await runSelfUpdate(d.url, target, 'ghcr.io/octo/dash:aaa111');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /refusing to update .*not labelled nodered-admin.role=dashboard/);
  }
  // A container labelled with another role (the update helper) is refused too.
  const helper = await d.run('helper', { Image: 'ghcr.io/octo/dash:aaa111', Labels: { 'nodered-admin.role': 'updater' } });
  assert.equal((await runSelfUpdate(d.url, helper.Id, 'ghcr.io/octo/dash:aaa111')).code, 1);
  assert.deepEqual(d.mutations(), [], 'not one stop, rename, create or delete');
  assert.deepEqual(d.view(d.model.containers[nr.Id]), nrBefore);
});

test('/api/dashboard/update picks its own container and never a Node-RED one', async () => {
  const gh = await githubMock();
  cleanups.push(() => gh.close());
  gh.state.runs = [{ head_sha: 'bbb222', status: 'completed', conclusion: 'success', updated_at: '2026-09-24T10:00:00Z', html_url: 'x', head_commit: { message: 'm' } }];
  const nrFake = await fakeNodeRed({ login: 'credentials' });
  cleanups.push(() => nrFake.close());

  const start = async (d, env = {}) => {
    const srv = await startServer({ dir: safetyDir('dash'), env: { GITHUB_API: gh.url, DOCKER_API: d.url, APP_REVISION: 'aaa111', ...env } });
    cleanups.push(() => srv.stop());
    const c = srv.client();
    await c.login(ADMIN, ADMIN_PW);
    assert.equal((await c.post('/api/github/connect', { token: GOOD_TOKEN })).status, 200);
    await c.put('/api/github', { dashboardRepo: 'octo/dash' });
    return { srv, c };
  };
  const newImage = (d) => (d.model.pullTo = d.addImage('ghcr.io/octo/dash:bbb222', DASH_IMAGE));

  // Two dashboards and no way to tell which one is this process: refused, nothing created.
  {
    const { d, nr, nrBefore } = await world({ dashboards: 2, nrPort: nrFake.port });
    newImage(d);
    const { c } = await start(d);
    d.clear();
    const r = await c.post('/api/dashboard/update');
    assert.equal(r.status, 400);
    assert.match(r.body.error, /2 running containers are labelled/);
    assert.deepEqual(d.mutations(), []);
    assert.deepEqual(d.view(d.model.containers[nr.Id]), nrBefore);
  }
  // Only Node-RED containers: refused.
  {
    const { d, nr, nrBefore } = await world({ dashboards: 0, nrPort: nrFake.port });
    newImage(d);
    const { c } = await start(d);
    d.clear();
    const r = await c.post('/api/dashboard/update');
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Cannot find this dashboard's container/);
    assert.deepEqual(d.mutations(), []);
    assert.deepEqual(d.view(d.model.containers[nr.Id]), nrBefore);
  }
  // Two dashboards, this one known by its container id: the helper targets it,
  // and running the helper's command swaps only that container.
  {
    const { d, nr, dash, nrBefore } = await world({ dashboards: 2, nrPort: nrFake.port });
    newImage(d);
    const { c } = await start(d, { SELF_CONTAINER_ID: dash[1].Id });
    const r = await c.post('/api/dashboard/update');
    assert.equal(r.status, 200, r.text);
    const helper = Object.values(d.model.containers).find((x) => x.Config.Labels['nodered-admin.role'] === 'updater');
    assert.deepEqual(helper.Config.Cmd, ['node', 'self-update.js', dash[1].Id, 'ghcr.io/octo/dash:bbb222']);
    assert.equal(helper.HostConfig.AutoRemove, true);
    assert.equal(helper.HostConfig.NetworkMode, 'host', "the dashboard's own network mode, as listed by Docker");
    const out = await runSelfUpdate(d.url, dash[1].Id, 'ghcr.io/octo/dash:bbb222');
    assert.equal(out.code, 0, out.out);
    assert.ok(!d.model.containers[dash[1].Id], 'the old dashboard container was replaced');
    assert.ok(d.model.containers[dash[0].Id], 'the other dashboard was left alone');
    assert.deepEqual(d.view(d.model.containers[nr.Id]), nrBefore, 'Node-RED untouched');
    assert.ok(d.model.volumes.nodered_data.files['flows.json'].equals(Buffer.from('[{"id":"x"}]')));
    for (const mu of d.mutations()) assert.ok(!mu.url.includes(nr.Id) && !mu.url.includes('/containers/nodered/'), `${mu.method} ${mu.url}`);
  }
});
