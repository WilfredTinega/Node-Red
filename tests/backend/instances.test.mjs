// Instance discovery: Docker API (mocked), host port scan (fake Node-REDs on
// our own ports), instances.json, and how they merge. This machine listens on
// other ports too (a real Node-RED, databases...), so assertions only look at
// the ports these tests opened.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mockServer, fakeNodeRed, startServer, tempDir, ADMIN, ADMIN_PW } from './helpers.mjs';

const closeLater = [];
let nrA, nrB, nrH, nrOpen, nrOld, nrR, closedPort, closedPort2, dockerMock;

// A port nothing listens on: bind one, then close it.
async function deadPort() {
  const s = await mockServer(() => ({}));
  await s.close();
  return s.port;
}

const container = (o) => ({ Id: `${o.id}${'0'.repeat(64 - o.id.length)}`, Names: [`/${o.name}`], Labels: {}, Mounts: [], Ports: [], State: 'running', Status: 'Up 1 hour', ...o });

before(async () => {
  nrA = await fakeNodeRed({ login: 'credentials', version: '4.0.9' }); // docker, 127.0.0.1 only
  nrB = await fakeNodeRed({ login: 'open', version: '3.1.0' }); // labelled docker, non-1880 port
  nrH = await fakeNodeRed({ login: 'credentials', version: '4.1.0-beta.1' }, { host: '0.0.0.0' }); // host install, all interfaces
  nrOpen = await fakeNodeRed({ login: 'open', version: '' }); // host install, no version in the page
  nrOld = await mockServer((r) =>
    r.path === '/' ? { text: '<script src="red/red.js"></script>' } : r.path === '/auth/login' ? { json: { type: 'strategy' } } : undefined,
  );
  nrR = await fakeNodeRed({ login: 'credentials' }); // "another machine" from instances.json
  closedPort = await deadPort();
  closedPort2 = await deadPort();
  closeLater.push(nrA, nrB, nrH, nrOpen, nrOld, nrR);

  const containers = [
    container({
      id: 'aaaa1111',
      name: 'nodered-a',
      Image: 'nodered/node-red:4.0.9',
      Ports: [
        { IP: '0.0.0.0', PrivatePort: 1880, PublicPort: nrA.port, Type: 'tcp' },
        { IP: '::', PrivatePort: 1880, PublicPort: nrA.port, Type: 'tcp' },
        { PrivatePort: 1880, PublicPort: nrA.port, Type: 'udp' },
        { PrivatePort: 1234, Type: 'tcp' },
      ],
      Mounts: [{ Type: 'bind', Destination: '/auth' }],
      env: [`NODERED_INSTANCE=${nrA.port}`, 'TZ=UTC'],
    }),
    // Shared logins, but NODERED_INSTANCE says 1880 while the host port is another.
    container({
      id: '77775555',
      name: 'nodered-wrongkey',
      Image: 'nodered/node-red',
      Ports: [{ IP: '0.0.0.0', PrivatePort: 1880, PublicPort: closedPort2, Type: 'tcp' }],
      Mounts: [{ Type: 'bind', Destination: '/auth' }],
      env: ['NODERED_INSTANCE=1880'],
    }),
    container({ id: '88885555', name: 'nodered-nokey', Image: 'nodered/node-red', Mounts: [{ Type: 'bind', Destination: '/auth' }], env: ['TZ=UTC'] }),
    container({
      id: 'bbbb2222',
      name: 'custom-flows',
      Image: 'acme/flows:1',
      Labels: { 'nodered-admin.instance': 'true' },
      Ports: [
        { IP: '0.0.0.0', PrivatePort: 3000, PublicPort: nrB.port, Type: 'tcp' },
        { IP: '0.0.0.0', PrivatePort: 9000, PublicPort: closedPort, Type: 'tcp' },
      ],
    }),
    container({ id: 'cccc3333', name: 'nodered-stopped', Image: 'nodered/node-red', State: 'exited', Status: 'Exited (0) 1 day ago' }),
    container({ id: 'dddd4444', name: 'nodered-user-admin', Image: 'ghcr.io/acme/nodered-user-admin:abc', Labels: { 'nodered-admin.role': 'dashboard' } }),
    container({ id: 'eeee5555', name: 'updater', Image: 'ghcr.io/acme/nodered-user-admin:abc', Labels: { 'nodered-admin.role': 'updater' } }),
    container({ id: 'ffff6666', name: 'redis', Image: 'redis:7', Ports: [{ PrivatePort: 6379, PublicPort: 6399, Type: 'tcp' }] }),
    container({ id: '99996666', name: 'nodered-hidden', Image: 'nodered/node-red', Labels: { 'nodered-admin.instance': 'false' } }),
  ];
  dockerMock = await mockServer((r) => {
    if (r.method === 'GET' && r.path === '/containers/json') return { json: containers };
    const m = r.method === 'GET' && r.path.match(/^\/containers\/([0-9a-f]+)\/json$/);
    const c = m && containers.find((x) => x.Id === m[1]);
    return c ? { json: { Id: c.Id, Config: { Env: c.env || [] } } } : undefined;
  });
  closeLater.push(dockerMock);
});
after(() => Promise.all(closeLater.map((s) => s.close())));

const ours = () => new Set([nrA, nrB, nrH, nrOpen, nrOld, nrR].map((s) => s.port).concat(closedPort, closedPort2));

async function instances(srv) {
  const c = srv.client();
  await c.login(ADMIN, ADMIN_PW);
  const r = await c.get('/api/instances');
  assert.equal(r.status, 200);
  return r.body;
}

test('docker discovery, with the port scan off', async () => {
  const srv = await startServer({ env: { DOCKER_API: `${dockerMock.url}/`, SCAN_HOST_PORTS: '0', PUBLIC_HOST: 'example.test', AUTH_HOST_DIR: '/opt/x' } });
  try {
    const body = await instances(srv);
    assert.equal(body.publicHost, 'example.test');
    assert.equal(body.authHostDir, '/opt/x');
    assert.equal(body.canManageContainers, true);
    assert.deepEqual(body.errors, []);
    assert.equal(dockerMock.find('GET', '/containers/json').at(-1).url, '/containers/json?all=1');

    const names = body.instances.map((i) => i.name);
    assert.ok(!names.includes('nodered-user-admin'), 'the dashboard is not a Node-RED');
    assert.ok(!names.includes('updater'), 'the update helper is not a Node-RED');
    assert.ok(!names.includes('redis'));
    assert.ok(!names.includes('nodered-hidden'), 'nodered-admin.instance=false hides it');

    const a = body.instances.filter((i) => i.name === 'nodered-a');
    assert.equal(a.length, 1, 'IPv4 and IPv6 bindings collapse to one row; udp ignored');
    assert.deepEqual(a[0], {
      name: 'nodered-a',
      source: 'docker',
      container: 'aaaa11110000',
      image: 'nodered/node-red:4.0.9',
      state: 'running',
      detail: 'Up 1 hour',
      sharedLogins: true,
      instanceEnv: String(nrA.port),
      keyMismatch: false,
      port: nrA.port,
      status: 'online',
      login: 'required',
      key: String(nrA.port),
    });
    // Only shared-login containers are inspected for NODERED_INSTANCE.
    const inspected = dockerMock.requests.filter((r) => /\/containers\/[0-9a-f]+\/json$/.test(r.path)).map((r) => r.path.split('/')[2].slice(0, 8)).sort();
    assert.deepEqual(inspected, ['77775555', '88885555', 'aaaa1111']);

    const wrong = body.instances.find((i) => i.name === 'nodered-wrongkey');
    assert.equal(wrong.instanceEnv, '1880');
    assert.equal(wrong.keyMismatch, true, 'NODERED_INSTANCE differs from the published host port');
    assert.equal(wrong.key, String(closedPort2), 'the key the dashboard uses is still the host port');
    const nokey = body.instances.find((i) => i.name === 'nodered-nokey');
    assert.equal(nokey.instanceEnv, null);
    assert.equal(nokey.keyMismatch, true, 'missing NODERED_INSTANCE');

    const b = body.instances.filter((i) => i.name === 'custom-flows');
    assert.deepEqual(b.map((i) => i.port).sort(), [nrB.port, closedPort].sort(), 'Node-RED off 1880: every TCP port');
    assert.equal(b.find((i) => i.port === nrB.port).login, 'open');
    assert.equal(b.find((i) => i.port === nrB.port).status, 'online');
    assert.equal(b.find((i) => i.port === closedPort).status, 'unreachable');
    assert.equal(b[0].sharedLogins, false);
    assert.equal(b[0].instanceEnv, null);
    assert.equal(b[0].keyMismatch, false, 'not using the shared logins: the key does not matter');

    const stopped = body.instances.find((i) => i.name === 'nodered-stopped');
    assert.equal(stopped.port, null);
    assert.equal(stopped.status, 'offline');
    assert.equal(stopped.key, null);
    // Sorted by port, portless last.
    assert.equal(body.instances.at(-1).port, null);
  } finally {
    await srv.stop();
  }
});

test('instances.json: names, other machines, and ports that are down', async () => {
  const srv = await startServer({ env: { DOCKER_API: '', SCAN_HOST_PORTS: '0' } });
  try {
    srv.writeJson('instances.json', [
      { name: 'Remote box', host: '127.0.0.1', port: nrR.port, sharedLogins: false },
      { name: 'Down', port: closedPort },
      { port: nrOpen.port },
      { name: 'no port' },
      { name: 'string port', port: '1880' },
    ]);
    const body = await instances(srv);
    assert.equal(body.canManageContainers, false);
    assert.deepEqual(body.errors, []);
    assert.equal(body.instances.length, 3);
    const remote = body.instances.find((i) => i.name === 'Remote box');
    assert.deepEqual(remote, { name: 'Remote box', source: 'config', port: nrR.port, host: '127.0.0.1', sharedLogins: false, status: 'online', login: 'required', key: `127.0.0.1:${nrR.port}` });
    const down = body.instances.find((i) => i.name === 'Down');
    assert.equal(down.status, 'unreachable');
    assert.equal(down.key, String(closedPort));
    assert.equal(down.sharedLogins, null);
    assert.ok(body.instances.some((i) => i.name === `Port ${nrOpen.port}` && i.login === 'open'));

    srv.writeJson('instances.json', { not: 'an array' });
    const broken = await instances(srv);
    assert.equal(broken.instances.length, 0);
    assert.match(broken.errors[0], /must contain a JSON array/);
  } finally {
    await srv.stop();
  }
});

test('Docker API failures are reported, not fatal', async () => {
  const down = await mockServer(() => ({ status: 500, json: { message: 'nope' } }));
  const srv = await startServer({ env: { DOCKER_API: down.url, SCAN_HOST_PORTS: '0' } });
  try {
    srv.writeJson('instances.json', [{ name: 'Still here', port: nrOpen.port }]);
    const body = await instances(srv);
    assert.match(body.errors[0], /Docker discovery failed: Docker API returned 500/);
    assert.deepEqual(body.instances.map((i) => i.name), ['Still here']);
  } finally {
    await srv.stop();
    await down.close();
  }
});

test('port scan finds host installs, parses versions and merges with docker', async () => {
  const srv = await startServer({ env: { DOCKER_API: dockerMock.url, SCAN_HOST_PORTS: '1' } });
  try {
    srv.writeJson('instances.json', [{ name: 'Named host install', port: nrH.port, sharedLogins: true }]);
    const body = await instances(srv);
    const mine = body.instances.filter((i) => ours().has(i.port));

    // Docker row gets the scanned version and binding.
    const a = mine.filter((i) => i.port === nrA.port);
    assert.equal(a.length, 1, 'a docker port is not listed again as a host install');
    assert.equal(a[0].source, 'docker');
    assert.equal(a[0].version, '4.0.9');
    assert.equal(a[0].localOnly, true);

    const b = mine.find((i) => i.port === nrB.port);
    assert.equal(b.source, 'docker');
    assert.equal(b.version, '3.1.0');

    const h = mine.filter((i) => i.port === nrH.port);
    assert.equal(h.length, 1, 'the configured name is merged into the scanned row');
    assert.deepEqual(h[0], {
      name: 'Named host install',
      source: 'host',
      port: nrH.port,
      localOnly: false,
      version: '4.1.0-beta.1',
      sharedLogins: true,
      status: 'online',
      login: 'required',
      key: String(nrH.port),
    });

    const open = mine.find((i) => i.port === nrOpen.port);
    assert.equal(open.name, `node-red :${nrOpen.port}`);
    assert.equal(open.version, null, 'no ?v= in the page');
    assert.equal(open.login, 'open');
    assert.equal(open.localOnly, true);
    assert.equal(open.sharedLogins, null);

    const old = mine.find((i) => i.port === nrOld.port);
    assert.equal(old.source, 'host', 'red/red.js (not minified) counts too');
    assert.equal(old.login, 'strategy');

    // The fake GitHub/Docker mock and this dashboard's own port are not Node-RED.
    assert.ok(!body.instances.some((i) => i.port === dockerMock.port));
    assert.ok(!body.instances.some((i) => i.port === srv.port));
  } finally {
    await srv.stop();
  }
});

// The socket tables in the kernel's format: one LISTEN (0A) row per port.
function fakeProcNet(dir, v4Ports, v6Ports) {
  const hex = (p) => p.toString(16).toUpperCase().padStart(4, '0');
  const row = (addr, port) => `   0: ${addr}:${hex(port)} ${'0'.repeat(addr.length)}:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0000000000000000 100 0 0 10 0`;
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
  fs.writeFileSync(path.join(dir, 'tcp'), [header, ...v4Ports.map(([addr, p]) => row(addr, p)), ''].join('\n'));
  fs.writeFileSync(path.join(dir, 'tcp6'), [header, ...v6Ports.map(([addr, p]) => row(addr, p)), ''].join('\n'));
}

test("HOST_NET_DIR: the scan reads the host's tables from there, and skips the published PUBLIC_PORT", async () => {
  const dir = tempDir('hostnet');
  // nrH on every interface, nrOpen on ::1 only, nrOld is "the dashboard's published port".
  fakeProcNet(dir, [['00000000', nrH.port], ['0100007F', nrOld.port]], [['00000000000000000000000001000000', nrOpen.port]]);
  nrOld.clear();
  const srv = await startServer({ env: { DOCKER_API: '', SCAN_HOST_PORTS: '1', HOST_NET_DIR: dir, PUBLIC_PORT: String(nrOld.port) } });
  try {
    const body = await instances(srv);
    assert.deepEqual(body.errors, []);
    // Exactly the fake table's Node-REDs: this machine's real ports were not read.
    assert.deepEqual(body.instances.map((i) => i.port).sort(), [nrH.port, nrOpen.port].sort());
    assert.equal(body.instances.find((i) => i.port === nrH.port).localOnly, false);
    assert.equal(body.instances.find((i) => i.port === nrOpen.port).localOnly, true);
    assert.equal(nrOld.find('GET', '/').length, 0, 'the published port is never probed');
  } finally {
    await srv.stop();
  }
});

test('HOST_NET_DIR pointing nowhere: the scan finds nothing and reports no error', async () => {
  const srv = await startServer({ env: { DOCKER_API: '', SCAN_HOST_PORTS: '1', HOST_NET_DIR: '/nonexistent/hostnet' } });
  try {
    srv.writeJson('instances.json', [{ name: 'Named', port: nrOpen.port }]);
    const body = await instances(srv);
    assert.deepEqual(body.errors, []);
    assert.deepEqual(body.instances.map((i) => i.name), ['Named']);
  } finally {
    await srv.stop();
  }
});
