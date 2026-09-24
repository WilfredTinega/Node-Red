// docker.js against a fake Docker API, and the restart/update endpoints.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createDocker, registryAuth, splitRef, pullError } from '../../docker.js';
import { dockerMock, freshNodeRed, id64, NEW_IMAGE, OLD_IMAGE } from './docker-mock.mjs';
import { fakeNodeRed, startServer, ROOT, ADMIN, ADMIN_PW } from './helpers.mjs';

test('splitRef', () => {
  assert.deepEqual(splitRef('img'), ['img', 'latest']);
  assert.deepEqual(splitRef('img:tag'), ['img', 'tag']);
  assert.deepEqual(splitRef('host:5000/img'), ['host:5000/img', 'latest']);
  assert.deepEqual(splitRef('host:5000/img:1.2'), ['host:5000/img', '1.2']);
  assert.deepEqual(splitRef('nodered/node-red:4.0.9-22'), ['nodered/node-red', '4.0.9-22']);
  assert.deepEqual(splitRef('ghcr.io/o/r:abc123'), ['ghcr.io/o/r', 'abc123']);
});

test('registryAuth is base64url JSON', () => {
  const a = registryAuth('octo', 'tok', 'ghcr.io');
  assert.doesNotMatch(a, /[+/=]/);
  assert.deepEqual(JSON.parse(Buffer.from(a, 'base64url').toString()), { username: 'octo', password: 'tok', serveraddress: 'ghcr.io' });
});

test('pullError finds failures in any form of the stream', () => {
  assert.equal(pullError('{"status":"a"}\n{"status":"b"}\n'), null);
  assert.equal(pullError('{"status":"a"}\n{"errorDetail":{"message":"denied"},"error":"denied: no access"}\n'), 'denied: no access');
  // A one-line stream is parsed as an object by the JSON reader.
  assert.equal(pullError({ errorDetail: { message: 'manifest unknown' }, error: 'manifest unknown' }), 'manifest unknown');
  assert.equal(pullError({ status: 'ok' }), null);
  assert.equal(pullError('{"error":"has \\"quotes\\" inside"}'), 'has "quotes" inside');
  assert.equal(pullError('not json\n'), null);
  assert.equal(pullError(null), null);
});

let d, docker;
before(async () => {
  d = await dockerMock();
  docker = createDocker(d.url);
});
after(() => d?.close());

test('restart', async () => {
  d.clear();
  assert.deepEqual(await docker.restart('aaaa11110000'), { message: 'Restarted.' });
  assert.deepEqual(d.requests.map((r) => `${r.method} ${r.url}`), ['POST /containers/aaaa11110000/restart?t=10']);
});

test('proxy refusals and Docker errors read clearly', async () => {
  const deny = await (await import('./helpers.mjs')).mockServer(() => ({ status: 403, text: '<html>Forbidden</html>' }));
  try {
    await assert.rejects(createDocker(deny.url).restart('x'), /updates are not enabled on the Docker proxy/);
  } finally {
    await deny.close();
  }
  await assert.rejects(docker.inspect('nope'), /Docker GET \/containers\/nope\/json: 404 No such container/);
});

test('pull: success, stream errors, HTTP errors, auth header', async () => {
  d.clear();
  d.state.pulledId = NEW_IMAGE;
  const img = await docker.pull('ghcr.io/octo/dash:abc', 'AUTH');
  assert.equal(img.Id, NEW_IMAGE);
  const create = d.find('POST', '/images/create')[0];
  assert.equal(create.url, '/images/create?fromImage=ghcr.io%2Focto%2Fdash&tag=abc');
  assert.equal(create.headers['x-registry-auth'], 'AUTH');
  assert.equal(d.requests[1].path, `/images/${encodeURIComponent('ghcr.io/octo/dash:abc')}/json`);

  d.clear();
  await docker.pull('nodered/node-red');
  assert.equal(d.requests[0].headers['x-registry-auth'], undefined);
  assert.match(d.requests[0].url, /fromImage=nodered%2Fnode-red&tag=latest/);

  d.state.pullBody = '{"status":"Pulling"}\n{"errorDetail":{"message":"unauthorized"},"error":"unauthorized: authentication required"}\n';
  await assert.rejects(docker.pull('ghcr.io/octo/private:1'), /Pulling ghcr.io\/octo\/private:1 failed: unauthorized: authentication required/);
  d.state.pullBody = '{"errorDetail":{"message":"manifest unknown"},"error":"manifest unknown"}';
  await assert.rejects(docker.pull('nodered/node-red:nope'), /failed: manifest unknown/, 'a one-line error stream');
  d.state.pullBody = '{"message":"pull access denied"}';
  d.state.pullStatus = 404;
  await assert.rejects(docker.pull('nope/nope'), /404 pull access denied/);
  d.state.pullStatus = 200;
  d.state.pullBody = '{"status":"ok"}\n';
});

test('update: same image id just restarts', async () => {
  d.clear();
  d.state.pulledId = OLD_IMAGE;
  const r = await docker.update(id64('aaaa1111'));
  assert.deepEqual(r, { updated: false, message: 'Already on the newest nodered/node-red:latest. Restarted it.' });
  assert.deepEqual(d.calls(), [
    `GET /containers/${id64('aaaa1111')}/json`,
    'POST /images/create',
    `GET /images/${encodeURIComponent('nodered/node-red:latest')}/json`,
    `POST /containers/${id64('aaaa1111')}/restart`,
  ]);
});

test('update refuses digest-pinned containers', async () => {
  const pinned = id64('pin1');
  d.state.containers[pinned] = { ...d.state.containers[id64('aaaa1111')], Id: pinned, Name: '/pinned', Config: { Image: 'nodered/node-red@sha256:abc' } };
  await assert.rejects(docker.update(pinned), /pinned to an image digest/);
});

test('update: a new image recreates the container, keeping its settings', async () => {
  d.clear();
  d.state.pulledId = NEW_IMAGE;
  const oldId = id64('aaaa1111');
  const r = await docker.update(oldId);
  assert.deepEqual(r, { updated: true, message: 'Updated nodered-a to the newest nodered/node-red:latest and started it.' });
  const calls = d.calls();
  const i = (s) => calls.indexOf(s);
  assert.ok(i(`POST /containers/${oldId}/stop`) < i(`POST /containers/${oldId}/rename`));
  assert.ok(i(`POST /containers/${oldId}/rename`) < i('POST /containers/create'));
  assert.ok(calls.includes(`DELETE /containers/${oldId}`), 'the old container is removed after the new one runs');

  const rename = d.find('POST', `/containers/${oldId}/rename`)[0];
  assert.match(rename.url, /name=nodered-a-before-update-\d+/);
  const create = d.find('POST', '/containers/create')[0];
  assert.equal(create.url, '/containers/create?name=nodered-a');
  const body = create.body;
  assert.equal(body.Image, 'nodered/node-red:latest');
  assert.deepEqual(body.Env, ['NODERED_INSTANCE=1890'], "the old image's env defaults are dropped");
  assert.equal(body.Cmd, undefined);
  assert.equal(body.WorkingDir, undefined);
  assert.equal(body.Hostname, undefined, 'the old id-based hostname is not carried over');
  assert.deepEqual(body.Labels, { 'com.docker.compose.service': 'nodered' });
  assert.deepEqual(body.HostConfig.Binds, ['/opt/nodered-auth:/auth', 'anon123:/data'], 'anonymous /data volume kept, --mount volume not duplicated');
  assert.deepEqual(body.HostConfig.PortBindings, { '1880/tcp': [{ HostPort: '1890' }] });
  assert.deepEqual(Object.keys(body.NetworkingConfig.EndpointsConfig), ['bridge']);
  // Put the original back for the next tests.
  d.state.containers[oldId] = freshNodeRed();
});

test('update: a new container that fails to start is rolled back', async () => {
  d.clear();
  d.state.pulledId = NEW_IMAGE;
  d.state.startFails = true;
  const oldId = id64('aaaa1111');
  const before = Object.keys(d.state.containers).sort();
  try {
    await assert.rejects(docker.update(oldId), /Update failed and nodered-a was restored: .*port is already allocated/);
  } finally {
    d.state.startFails = false;
  }
  const calls = d.calls();
  assert.equal(d.find('POST', '/containers/create').length, 1);
  assert.deepEqual(Object.keys(d.state.containers).sort(), before, 'the new container was deleted');
  assert.ok(calls.some((c) => /^DELETE \/containers\/new/.test(c)));
  const renames = d.find('POST', `/containers/${oldId}/rename`).map((r) => new URL(r.url, 'http://x').searchParams.get('name'));
  assert.match(renames[0], /^nodered-a-before-update-/);
  assert.equal(renames[1], 'nodered-a');
  assert.equal(calls.at(-1), `POST /containers/${oldId}/start`);
  assert.ok(!calls.includes(`DELETE /containers/${oldId}`));
  assert.equal(d.state.containers[oldId].Name, '/nodered-a');
});

test('update: a new container that exits within 5 seconds is rolled back', async () => {
  d.clear();
  d.state.pulledId = NEW_IMAGE;
  d.state.newRunning = false;
  const oldId = id64('aaaa1111');
  try {
    await assert.rejects(docker.update(oldId), /restored: the new container exited \(code 1\)/);
  } finally {
    d.state.newRunning = true;
  }
  assert.ok(d.calls().some((c) => /^DELETE \/containers\/new/.test(c)));
  assert.equal(d.calls().at(-1), `POST /containers/${oldId}/start`);
});

test('findByRole and runHelper', async () => {
  d.clear();
  d.state.roleList = [{ Id: id64('dash1') }];
  assert.equal((await docker.findByRole('dashboard')).Id, id64('dash1'));
  const q = new URL(d.requests[0].url, 'http://x').searchParams.get('filters');
  assert.deepEqual(JSON.parse(q), { label: ['nodered-admin.role=dashboard'], status: ['running'] });
  d.state.roleList = [];
  assert.equal(await docker.findByRole('dashboard'), null);

  d.clear();
  const id = await docker.runHelper('img:1', ['node', 'x.js'], ['A=1']);
  const create = d.find('POST', '/containers/create')[0].body;
  assert.deepEqual(create, { Image: 'img:1', Cmd: ['node', 'x.js'], Env: ['A=1'], Labels: { 'nodered-admin.role': 'updater' }, HostConfig: { NetworkMode: 'host', AutoRemove: true } });
  assert.equal(d.calls().at(-1), `POST /containers/${id}/start`);

  d.clear();
  await docker.runHelper('img:1', ['node', 'x.js'], ['A=1'], 'farm_default');
  assert.equal(d.find('POST', '/containers/create')[0].body.HostConfig.NetworkMode, 'farm_default');
});

test('recreate: a failed rename after the stop starts the old container again', async () => {
  d.clear();
  const oldId = id64('aaaa1111');
  d.state.renameFails = true;
  try {
    await assert.rejects(docker.recreate(oldId, 'nodered/node-red:latest'), /Update failed and nodered-a was restored: .*rename failed/);
  } finally {
    d.state.renameFails = false;
  }
  const calls = d.calls();
  assert.ok(calls.includes(`POST /containers/${oldId}/stop`));
  assert.equal(calls.at(-1), `POST /containers/${oldId}/start`, 'started again after the failed rename');
  assert.equal(d.find('POST', '/containers/create').length, 0, 'nothing new was created');
  assert.equal(d.state.containers[oldId].Name, '/nodered-a');
});

test('self-update.js: usage error, then a full swap against the mock', async () => {
  const bad = spawnSync(process.execPath, [path.join(ROOT, 'self-update.js')], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /usage/);

  d.clear();
  const oldId = id64('aaaa1111');
  // self-update.js only swaps a container labelled as the dashboard.
  const target = d.state.containers[oldId];
  target.Config = { ...target.Config, Labels: { ...target.Config.Labels, 'nodered-admin.role': 'dashboard' } };
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [path.join(ROOT, 'self-update.js'), oldId, 'ghcr.io/octo/dash:new'], { env: { PATH: process.env.PATH, DOCKER_API: d.url } });
  let out = '';
  child.stdout.on('data', (x) => (out += x));
  child.stderr.on('data', (x) => (out += x));
  const code = await new Promise((r) => child.once('exit', r));
  assert.equal(code, 0, out);
  assert.match(out, /Dashboard now runs ghcr.io\/octo\/dash:new \(new/);
  assert.equal(d.find('POST', '/containers/create')[0].body.Image, 'ghcr.io/octo/dash:new');
  d.state.containers[oldId] = freshNodeRed();
});

// ---------- through the server ----------

test('actions are recorded in the activity log with the user who ran them', async () => {
  const nr = await fakeNodeRed({ login: 'credentials' });
  d.state.list = [
    { Id: id64('bbbb2222'), Names: ['/nodered-b'], Image: 'nodered/node-red:latest', State: 'running', Status: 'Up', Labels: {}, Mounts: [], Ports: [{ PrivatePort: 1880, PublicPort: nr.port, Type: 'tcp' }] },
  ];
  d.state.containers[id64('bbbb2222')] = freshNodeRed(); // so /restart finds it
  const srv = await startServer({ env: { DOCKER_API: d.url, SCAN_HOST_PORTS: '0' } });
  try {
    const c = srv.client();
    await c.login(ADMIN, ADMIN_PW);
    assert.equal((await c.post('/api/instances/bbbb22220000/restart')).status, 200);
    // A failed action is recorded too.
    assert.equal((await c.post('/api/instances/nope00000000/restart')).status, 404);

    const { entries } = (await c.get('/api/activity')).body;
    const ok = entries.find((e) => e.action === 'restart' && e.ok);
    assert.equal(ok.user, ADMIN);
    assert.equal(ok.target, 'nodered-b');
    assert.match(ok.at, /^\d{4}-\d\d-\d\dT/);
    // It is durable: the same entries are on disk.
    const onDisk = srv.readJson('activity.json');
    assert.equal(onDisk[0].action, 'restart');
    assert.equal(onDisk[0].user, ADMIN);

    // Read-only users can't see the log.
    await c.post('/api/users', { username: 'v', permissions: 'read', password: 'viewer-pass-1' });
    const v = srv.client();
    await v.login('v', 'viewer-pass-1');
    assert.equal((await v.get('/api/activity')).status, 403);
  } finally {
    await srv.stop();
    await nr.close();
  }
});

test('restart/update endpoints only act on discovered Node-RED containers', async () => {
  const nr = await fakeNodeRed({ login: 'credentials' });
  d.state.list = [
    { Id: id64('aaaa1111'), Names: ['/nodered-a'], Image: 'nodered/node-red:latest', State: 'running', Status: 'Up', Labels: {}, Mounts: [], Ports: [{ PrivatePort: 1880, PublicPort: nr.port, Type: 'tcp' }] },
    { Id: id64('dash1'), Names: ['/nodered-user-admin'], Image: 'ghcr.io/octo/nodered-user-admin:abc', State: 'running', Status: 'Up', Labels: { 'nodered-admin.role': 'dashboard' }, Mounts: [], Ports: [] },
    { Id: id64('redis1'), Names: ['/redis'], Image: 'redis', State: 'running', Status: 'Up', Labels: {}, Mounts: [], Ports: [] },
  ];
  d.state.restartDelay = 300;
  d.state.pulledId = OLD_IMAGE;
  const srv = await startServer({ env: { DOCKER_API: d.url, SCAN_HOST_PORTS: '0' } });
  try {
    const c = srv.client();
    await c.login(ADMIN, ADMIN_PW);
    const list = (await c.get('/api/instances')).body;
    assert.deepEqual(list.instances.map((i) => i.container), ['aaaa11110000']);

    d.clear();
    for (const id of ['dash10000000', 'redis1000000', 'ffffffffffff', '..%2F..%2Fx']) {
      const r = await c.post(`/api/instances/${id}/restart`);
      assert.equal(r.status, 404, id);
      assert.equal((await c.post(`/api/instances/${id}/update`)).status, 404, id);
    }
    assert.ok(!d.requests.some((r) => r.method !== 'GET'), 'nothing but discovery reached Docker');

    const [a, b] = await Promise.all([c.post('/api/instances/aaaa11110000/restart'), c.post('/api/instances/aaaa11110000/restart')]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409], 'a second click while busy is refused');
    const ok = a.status === 200 ? a : b;
    assert.deepEqual(ok.body, { ok: true, message: 'Restarted.' });
    assert.equal(d.find('POST', '/containers/aaaa11110000/restart').length, 1);

    const up = await c.post('/api/instances/aaaa11110000/update');
    assert.equal(up.status, 200);
    assert.deepEqual(up.body, { ok: true, updated: false, message: 'Already on the newest nodered/node-red:latest. Restarted it.' });

    d.state.pullBody = '{"error":"toomanyrequests: rate limit"}';
    const fail = await c.post('/api/instances/aaaa11110000/update');
    assert.equal(fail.status, 500);
    assert.match(fail.body.error, /rate limit/);
    d.state.pullBody = '{"status":"ok"}\n';
    // Not busy any more after a failure.
    assert.equal((await c.post('/api/instances/aaaa11110000/restart')).status, 200);

    // Non-admins can't.
    await c.post('/api/users', { username: 'viewer', permissions: 'read', password: 'viewer-pass-1' });
    const v = srv.client();
    await v.login('viewer', 'viewer-pass-1');
    assert.equal((await v.post('/api/instances/aaaa11110000/restart')).status, 403);
    assert.equal((await v.get('/api/instances')).status, 200, 'but can see the list');
  } finally {
    await srv.stop();
    await nr.close();
    d.state.restartDelay = 0;
  }
});

test('without DOCKER_API the endpoints say so', async () => {
  const srv = await startServer({ env: { DOCKER_API: '' } });
  try {
    const c = srv.client();
    await c.login(ADMIN, ADMIN_PW);
    const r = await c.post('/api/instances/aaaa11110000/restart');
    assert.equal(r.status, 400);
    assert.match(r.body.error, /not configured/);
  } finally {
    await srv.stop();
  }
});
