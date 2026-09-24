// Update (recreate) of Node-RED containers against a stateful Docker model:
// every way /data can be mounted comes back on the same volume or host path,
// nothing is deleted with its volumes, and failures put the original back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDocker } from '../../docker.js';
import { dockerModel } from './docker-model.mjs';
import { safetyDir, snapshot } from './util.mjs';

const REF = 'nodered/node-red:latest';
const IMAGE_CONFIG = (version) => ({
  Env: ['PATH=/usr/local/bin:/usr/bin', `NODE_RED_VERSION=v${version}`, 'NODE_PATH=/usr/src/node-red/node_modules:/data/node_modules', 'FLOWS=flows.json'],
  Cmd: ['npm', 'start', '--cache', '/data/.npm', '--', '--userDir', '/data'],
  WorkingDir: '/usr/src/node-red',
  User: 'node-red',
  ExposedPorts: { '1880/tcp': {} },
  Volumes: { '/data': {} },
  Labels: { 'org.opencontainers.image.version': version, 'org.label-schema.name': 'node-red' },
});
const FLOW_FILES = {
  'flows.json': Buffer.from('[{"id":"t1","type":"tab","label":"Pumps"},{"id":"n1","type":"inject","z":"t1"}]\n'),
  'flows_cred.json': Buffer.from('{"$":"c0ffee-encrypted-credentials"}\n'),
  '.config.runtime.json': Buffer.from('{"instanceId":"abc","_credentialSecret":"auto-generated-secret"}\n'),
  'settings.js': Buffer.from('module.exports = { adminAuth: require("/auth/adminAuth.js") };\n'),
};

const USER_ENV = ['NODERED_INSTANCE=1880', 'TZ=Africa/Nairobi', 'NODE_RED_CREDENTIAL_SECRET=keep-me-exactly'];
const base = (extra = {}) => ({
  Image: REF,
  Env: USER_ENV,
  Labels: { 'farm.owner': 'ops' },
  ...extra,
  HostConfig: {
    PortBindings: { '1880/tcp': [{ HostIp: '', HostPort: '1880' }] },
    RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
    NetworkMode: 'bridge',
    ...extra.HostConfig,
  },
});

// Where /data's files live for a container: a volume in the model or a real host folder.
function dataOf(d, c, dest = '/data') {
  const mnt = c.Mounts.find((x) => x.Destination === dest);
  if (!mnt) return null;
  if (mnt.Type === 'volume') return { kind: 'volume', ref: mnt.Name, files: d.model.volumes[mnt.Name]?.files };
  if (mnt.Type === 'bind') return { kind: 'bind', ref: mnt.Source, files: Object.fromEntries(fs.readdirSync(mnt.Source).map((f) => [f, fs.readFileSync(path.join(mnt.Source, f))])) };
  return { kind: mnt.Type, ref: null, files: null };
}
const mountKey = (x) => `${x.Type}|${x.Type === 'volume' ? x.Name : x.Source}|${x.Destination}|${x.RW ? 'rw' : 'ro'}`;
const sortedMounts = (c) => c.Mounts.map(mountKey).sort();

// Each case: how the container was started. `seed` puts the flows where /data is.
const hostDir = safetyDir('bind-data');
fs.mkdirSync(path.join(hostDir, 'data'), { recursive: true });
fs.mkdirSync(path.join(hostDir, 'auth'), { recursive: true });
for (const [f, b] of Object.entries(FLOW_FILES)) fs.writeFileSync(path.join(hostDir, 'data', f), b);

const CASES = {
  'bind-mounted /data (-v /host/path:/data)': () => base({ HostConfig: { Binds: [`${hostDir}/data:/data`, `${hostDir}/auth:/auth:ro`] } }),
  'named volume via Binds (-v nodered_data:/data)': () => base({ HostConfig: { Binds: ['nodered_data:/data'] } }),
  "anonymous volume from the image's VOLUME /data": () => base({ HostConfig: { Binds: [`${hostDir}/auth:/auth`] } }),
  'named volume via --mount (HostConfig.Mounts)': () => base({ HostConfig: { Mounts: [{ Type: 'volume', Source: 'nr_mounted', Target: '/data' }] } }),
  'anonymous volume via --mount / compose "- /data" (no Source)': () => base({ HostConfig: { Mounts: [{ Type: 'volume', Target: '/data' }, { Type: 'bind', Source: `${hostDir}/auth`, Target: '/auth' }] } }),
  'compose-created container (project network, labels, Mounts API)': () =>
    base({
      Labels: {
        'com.docker.compose.project': 'farm',
        'com.docker.compose.service': 'nodered',
        'com.docker.compose.container-number': '1',
        'com.docker.compose.config-hash': 'abc123',
        'com.docker.compose.project.working_dir': '/srv/farm',
      },
      HostConfig: {
        NetworkMode: 'farm_default',
        Binds: [`${hostDir}/auth:/auth:rw`],
        Mounts: [{ Type: 'volume', Source: 'farm_nodered_data', Target: '/data', VolumeOptions: {} }],
      },
      NetworkingConfig: { EndpointsConfig: { farm_default: { Aliases: ['nodered', 'farm-nodered-1'] } } },
    }),
  'tmpfs (--tmpfs and --mount type=tmpfs) next to a named /data': () =>
    base({ HostConfig: { Binds: ['tmpfs_case_data:/data'], Tmpfs: { '/tmp': 'rw,size=64m' }, Mounts: [{ Type: 'tmpfs', Target: '/run/cache' }] } }),
  'read-only extra volume and user/workdir overrides': () =>
    base({ User: '1000:1000', WorkingDir: '/data', HostConfig: { Binds: ['ro_case_data:/data', 'shared_lib:/lib/extra:ro'] } }),
};

async function setup(spec) {
  const d = await dockerModel();
  const oldImage = d.addImage(REF, IMAGE_CONFIG('4.0.8'));
  const body = spec();
  const c = await d.run('nodered', body);
  // Node-RED wrote its files into /data (wherever that is).
  const data = c.Mounts.find((x) => x.Destination === '/data');
  if (data.Type === 'volume') for (const [f, b] of Object.entries(FLOW_FILES)) d.model.volumes[data.Name].files[f] = Buffer.from(b);
  d.clear();
  const newImage = d.addImage('nodered/node-red:new-build', IMAGE_CONFIG('4.1.0'));
  d.model.pullTo = newImage;
  return { d, c, oldImage, newImage, before: structuredClone(d.view(c)), volumesBefore: Object.keys(d.model.volumes).sort() };
}

const envOnly = (env, imgEnv) => env.filter((e) => !imgEnv.includes(e));

test('update keeps every data mount, env, label, port, restart policy and network', { concurrency: true }, async (t) => {
  await Promise.all(
    Object.entries(CASES).map(([name, spec]) =>
      t.test(name, async () => {
        const { d, c, newImage, before, volumesBefore } = await setup(spec);
        try {
          const dataBefore = dataOf(d, before);
          const r = await createDocker(d.url).update(c.Id);
          assert.equal(r.updated, true, r.message);
          const now = Object.values(d.model.containers);
          assert.equal(now.length, 1, 'exactly one container remains');
          const n = now[0];
          assert.notEqual(n.Id, before.Id);
          assert.equal(n.Name, '/nodered');
          assert.equal(n.Image, newImage);
          assert.ok(n.State.Running);

          // Same data mounts: same volume names / host paths, targets and rw/ro.
          const keep = (ms) => ms.filter((k) => !k.startsWith('tmpfs|'));
          assert.deepEqual(keep(sortedMounts(n)), keep(sortedMounts(before)));
          assert.deepEqual(sortedMounts(n), sortedMounts(before), 'tmpfs mounts too');
          assert.deepEqual(n.HostConfig.Tmpfs, before.HostConfig.Tmpfs);
          const dataAfter = dataOf(d, n);
          assert.equal(dataAfter.ref, dataBefore.ref, '/data is the same volume or host folder');
          for (const [f, b] of Object.entries(FLOW_FILES)) assert.ok(dataAfter.files[f].equals(b), `${f} byte-for-byte`);

          // Nothing deleted: every volume still exists; the old container went without v=1 or force.
          assert.deepEqual(Object.keys(d.model.volumes).sort(), volumesBefore);
          assert.deepEqual(d.model.removedVolumes, []);
          for (const mu of d.mutations().filter((x) => x.method === 'DELETE')) {
            assert.doesNotMatch(mu.url, /[?&]v=(1|true)/, 'never removes volumes');
            assert.doesNotMatch(mu.url, /[?&]force=(1|true)/, 'the old one is stopped, not force-removed');
            assert.ok(mu.url.startsWith(`/containers/${before.Id}`), 'only the old container is removed');
          }
          // The old one is removed only after the new one is confirmed running.
          const calls = d.requests.map((x) => `${x.method} ${x.path}`);
          const iDelete = calls.indexOf(`DELETE /containers/${before.Id}`);
          const iCheck = calls.lastIndexOf(`GET /containers/${n.Id}/json`);
          assert.ok(iCheck > 0 && iDelete > iCheck, 'removed after the running check');

          // Identical apart from the image.
          const oldImgEnv = IMAGE_CONFIG('4.0.8').Env;
          const newImgEnv = IMAGE_CONFIG('4.1.0').Env;
          assert.deepEqual(envOnly(n.Config.Env, newImgEnv).sort(), envOnly(before.Config.Env, oldImgEnv).sort());
          assert.ok(n.Config.Env.includes('NODE_RED_CREDENTIAL_SECRET=keep-me-exactly'));
          assert.ok(n.Config.Env.includes('FLOWS=flows.json'));
          const userLabels = (l, img) => Object.fromEntries(Object.entries(l).filter(([k]) => !(k in img.Labels)));
          assert.deepEqual(userLabels(n.Config.Labels, IMAGE_CONFIG('4.1.0')), userLabels(before.Config.Labels, IMAGE_CONFIG('4.0.8')));
          assert.deepEqual(n.HostConfig.PortBindings, before.HostConfig.PortBindings);
          assert.deepEqual(n.HostConfig.RestartPolicy, before.HostConfig.RestartPolicy);
          assert.equal(n.HostConfig.NetworkMode, before.HostConfig.NetworkMode);
          assert.deepEqual(n.NetworkSettings.Networks, before.NetworkSettings.Networks);
          assert.deepEqual(n.Config.ExposedPorts, before.Config.ExposedPorts);
          assert.equal(n.Config.User, before.Config.User);
          assert.equal(n.Config.WorkingDir, before.Config.WorkingDir);
          assert.deepEqual(n.Config.Cmd, before.Config.Cmd);
        } finally {
          await d.close();
        }
      }),
    ),
  );
});

test('a failed update restores the original container untouched', { concurrency: true }, async (t) => {
  const failures = { create: 'create failed', start: 'port is already allocated', exits: 'the new container exited', rename: 'rename failed' };
  const jobs = [];
  for (const [name, spec] of Object.entries(CASES)) {
    for (const [mode, msg] of Object.entries(failures)) {
      jobs.push(
        t.test(`${mode} fails: ${name}`, async () => {
          const { d, c, before, volumesBefore } = await setup(spec);
          try {
            d.model.fail[mode] = true;
            await assert.rejects(createDocker(d.url).update(c.Id), new RegExp(`restored: .*${msg}`));
            const now = Object.values(d.model.containers);
            assert.equal(now.length, 1, 'the new container is gone, the old one is back');
            assert.deepEqual(d.view(now[0]), before, 'the original container is exactly as it was');
            assert.deepEqual(Object.keys(d.model.volumes).sort(), volumesBefore);
            assert.deepEqual(d.model.removedVolumes, []);
            const data = dataOf(d, now[0]);
            for (const [f, b] of Object.entries(FLOW_FILES)) assert.ok(data.files[f].equals(b), f);
            for (const mu of d.mutations().filter((x) => x.method === 'DELETE')) {
              assert.doesNotMatch(mu.url, /[?&]v=(1|true)/);
              assert.ok(!mu.url.startsWith(`/containers/${before.Id}`), 'never deletes the original');
            }
          } finally {
            await d.close();
          }
        }),
      );
    }
  }
  await Promise.all(jobs);
});

test('a container started with --rm is refused before anything is stopped', async () => {
  const { d, c, before, volumesBefore } = await setup(() => base({ HostConfig: { AutoRemove: true } }));
  try {
    await assert.rejects(createDocker(d.url).update(c.Id), /started with --rm/);
    assert.deepEqual(d.mutations().filter((x) => !x.url.startsWith('/images/create')), [], 'only the pull happened');
    assert.deepEqual(d.view(d.model.containers[c.Id]), before);
    assert.deepEqual(Object.keys(d.model.volumes).sort(), volumesBefore);
  } finally {
    await d.close();
  }
});

test('same image: only a restart, nothing recreated', async () => {
  const { d, c, before } = await setup(CASES["anonymous volume from the image's VOLUME /data"]);
  try {
    d.model.pullTo = before.Image;
    const r = await createDocker(d.url).update(c.Id);
    assert.equal(r.updated, false);
    assert.deepEqual(d.mutations().map((x) => `${x.method} ${x.url.split('?')[0]}`), ['POST /images/create', `POST /containers/${c.Id}/restart`]);
  } finally {
    await d.close();
  }
});

test('the bind-mounted host folders are untouched on disk', () => {
  // Runs last in this file: every case above used these folders.
  const snap = snapshot(path.join(hostDir, 'data'));
  for (const [f, b] of Object.entries(FLOW_FILES)) assert.ok(snap[f].equals(b), f);
  assert.deepEqual(Object.keys(snap).sort(), Object.keys(FLOW_FILES).sort());
});
