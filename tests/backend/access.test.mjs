// Per-instance access: the API that stores it, and nodered/adminAuth.js that
// every Node-RED uses to apply it at login.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { startServer, tempDir, ROOT, ADMIN, ADMIN_PW } from './helpers.mjs';

let srv;
let c;
before(async () => {
  srv = await startServer();
  c = srv.client();
  await c.login(ADMIN, ADMIN_PW);
});
after(() => srv?.stop());

test('PUT instances map, then null', async () => {
  await c.post('/api/users', { username: 'kim', permissions: 'read', password: 'kim-password-1' });
  let r = await c.put('/api/users/kim', { instances: { 1890: 'read', '10.0.0.5:1880': '*' } });
  assert.deepEqual(r.body, { ok: true, password: null });
  let kim = (await c.get('/api/users')).body.find((u) => u.username === 'kim');
  assert.deepEqual(kim.instances, { 1890: 'read', '10.0.0.5:1880': '*' });
  assert.deepEqual(srv.readJson('users.json').find((u) => u.username === 'kim').instances, { 1890: 'read', '10.0.0.5:1880': '*' });

  r = await c.put('/api/users/kim', { instances: null });
  assert.equal(r.status, 200);
  kim = (await c.get('/api/users')).body.find((u) => u.username === 'kim');
  assert.equal(kim.instances, null);
  assert.ok(!('instances' in srv.readJson('users.json').find((u) => u.username === 'kim')));

  // Leaving instances out keeps the current map.
  await c.put('/api/users/kim', { instances: { 1890: 'read' } });
  await c.put('/api/users/kim', { permissions: '*' });
  kim = (await c.get('/api/users')).body.find((u) => u.username === 'kim');
  assert.deepEqual(kim.instances, { 1890: 'read' });
  assert.equal(kim.permissions, '*');
});

test('POST a user with an instances map', async () => {
  const r = await c.post('/api/users', { username: 'lee', permissions: 'read', password: 'lee-password-1', instances: { 1891: '*' } });
  assert.equal(r.status, 201);
  const lee = (await c.get('/api/users')).body.find((u) => u.username === 'lee');
  assert.deepEqual(lee.instances, { 1891: '*' });
  assert.equal((await c.post('/api/users', { username: 'lee2', permissions: 'read', password: 'lee-password-1', instances: null })).status, 201);
  assert.equal((await c.get('/api/users')).body.find((u) => u.username === 'lee2').instances, null);
});

test('instances validation errors', async () => {
  const bad = [[], 'all', 5, true, { 'bad key': 'read' }, { '': 'read' }, { 1890: 'write' }, { 1890: null }, { ['x'.repeat(101)]: 'read' }];
  for (const instances of bad) {
    const r = await c.put('/api/users/kim', { instances });
    assert.equal(r.status, 400, JSON.stringify(instances));
    const p = await c.post('/api/users', { username: 'zed', permissions: 'read', password: 'zed-password-1', instances });
    assert.equal(p.status, 400, JSON.stringify(instances));
  }
  assert.deepEqual(srv.readJson('users.json').find((u) => u.username === 'kim').instances, { 1890: 'read' });
  assert.ok(!srv.readJson('users.json').some((u) => u.username === 'zed'));
});

// ---------- nodered/adminAuth.js ----------

const hash = (p) => bcrypt.hashSync(p, 4);
const USERS = [
  { username: 'all', permissions: '*', password: hash('all-pw') },
  { username: 'reader', permissions: 'read', password: hash('reader-pw') },
  { username: 'mapped', permissions: '*', instances: { 1890: 'read', 1891: '*' }, password: hash('mapped-pw') },
  { username: 'none', permissions: '*', instances: {}, password: hash('none-pw') },
  { username: 'php', permissions: 'read', password: hash('php-pw').replace(/^\$2[ab]\$/, '$2y$') },
];

// A users folder like /opt/nodered-auth: users.json plus a copy of adminAuth.js.
function authDir(users = USERS) {
  const dir = tempDir('auth');
  fs.copyFileSync(path.join(ROOT, 'nodered', 'adminAuth.js'), path.join(dir, 'adminAuth.js'));
  if (users) fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(users));
  return dir;
}

const PAIRS = [
  ['all', 'all-pw'],
  ['reader', 'reader-pw'],
  ['mapped', 'mapped-pw'],
  ['none', 'none-pw'],
  ['php', 'php-pw'],
  ['reader', 'wrong-pw'],
  ['ghost', 'x'],
];

test('adminAuth: access per instance', () => {
  const dir = authDir();
  const run = (env) => {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'tests/backend/fixtures/adminauth-probe.cjs'), path.join(dir, 'adminAuth.js'), JSON.stringify(PAIRS)], {
      env: { PATH: process.env.PATH, ...env },
      cwd: dir,
    });
    return JSON.parse(out);
  };
  const at1890 = run({ NODERED_INSTANCE: '1890' });
  assert.equal(at1890.type, 'credentials');
  const [all, reader, mapped, none, php, wrong, ghost] = at1890.results;
  assert.deepEqual(all.authenticate, { username: 'all', permissions: '*' });
  assert.deepEqual(all.users, { username: 'all', permissions: '*' });
  assert.deepEqual(reader.authenticate, { username: 'reader', permissions: 'read' });
  assert.deepEqual(mapped.authenticate, { username: 'mapped', permissions: 'read' }, 'the map wins over permissions');
  assert.deepEqual(mapped.users, { username: 'mapped', permissions: 'read' });
  assert.equal(none.authenticate, null, 'an empty map allows no instance');
  assert.equal(none.users, null);
  assert.deepEqual(php.authenticate, { username: 'php', permissions: 'read' }, '$2y$ hashes work');
  assert.equal(wrong.authenticate, null);
  assert.equal(ghost.authenticate, null);
  assert.equal(ghost.users, null);

  const at1891 = run({ NODERED_INSTANCE: '1891' }).results;
  assert.deepEqual(at1891[2].authenticate, { username: 'mapped', permissions: '*' });

  // Not listed: refused, both for login and for an existing token's user lookup.
  const at1892 = run({ NODERED_INSTANCE: '1892' }).results;
  assert.equal(at1892[2].authenticate, null);
  assert.equal(at1892[2].users, null);
  assert.deepEqual(at1892[0].authenticate, { username: 'all', permissions: '*' });

  // Without NODERED_INSTANCE the key is PORT, then 1880.
  assert.deepEqual(run({ PORT: '1891' }).results[2].authenticate, { username: 'mapped', permissions: '*' });
  assert.equal(run({}).results[2].authenticate, null);
  // A key that is an Object.prototype name is not "listed".
  assert.equal(run({ NODERED_INSTANCE: 'constructor' }).results[2].users, null);
});

test('adminAuth: reads users.json on every login, and survives it missing', () => {
  const dir = authDir(null);
  const out = JSON.parse(
    execFileSync(process.execPath, [path.join(ROOT, 'tests/backend/fixtures/adminauth-probe.cjs'), path.join(dir, 'adminAuth.js'), JSON.stringify([['all', 'all-pw']])], {
      env: { PATH: process.env.PATH },
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
  );
  assert.equal(out.results[0].authenticate, null);
});

test('adminAuth: required from an ES module (no require.main) finds bcryptjs', async () => {
  const dir = authDir();
  process.env.NODERED_INSTANCE = '1890';
  try {
    const require = createRequire(import.meta.url);
    const auth = require(path.join(dir, 'adminAuth.js'));
    assert.deepEqual(await auth.authenticate('mapped', 'mapped-pw'), { username: 'mapped', permissions: 'read' });
    assert.equal(await auth.authenticate('mapped', 'nope'), null);
    assert.equal(await auth.authenticate('mapped', undefined), null, 'a missing password is refused, not thrown');
    // users.json is read fresh each time.
    fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ ...USERS[2], instances: { 1890: '*' } }]));
    assert.deepEqual(await auth.users('mapped'), { username: 'mapped', permissions: '*' });
  } finally {
    delete process.env.NODERED_INSTANCE;
  }
});

test('adminAuth: finds bcryptjs next to Node-RED, also under a process manager', () => {
  // A fake Node-RED install: nr/red.js with bcryptjs in nr/node_modules,
  // and the users folder somewhere else with no node_modules.
  const base = tempDir('nr');
  const nr = path.join(base, 'nr');
  fs.mkdirSync(path.join(nr, 'node_modules'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules', 'bcryptjs'), path.join(nr, 'node_modules', 'bcryptjs'));
  const dir = authDir();
  fs.writeFileSync(
    path.join(nr, 'red.js'),
    `const a = require(${JSON.stringify(path.join(dir, 'adminAuth.js'))});
     a.authenticate('all', 'all-pw').then((u) => process.stdout.write(JSON.stringify(u)));`,
  );
  const run = (args) => spawnSync(process.execPath, args, { cwd: base, env: { PATH: process.env.PATH }, encoding: 'utf8' });

  const direct = run([path.join(nr, 'red.js')]);
  assert.equal(direct.stdout, JSON.stringify({ username: 'all', permissions: '*' }), direct.stderr);

  // pm2 style: require.main is the wrapper (no bcryptjs near it), argv[1] is red.js.
  const pm2 = path.join(base, 'pm2');
  fs.mkdirSync(pm2);
  fs.writeFileSync(path.join(pm2, 'wrapper.js'), `process.argv[1] = ${JSON.stringify(path.join(nr, 'red.js'))}; require(process.argv[1]);`);
  const wrapped = run([path.join(pm2, 'wrapper.js')]);
  assert.equal(wrapped.stdout, JSON.stringify({ username: 'all', permissions: '*' }), wrapped.stderr);

  // Nowhere to find it: a clear error naming what it tried.
  const lonely = path.join(base, 'lonely');
  fs.mkdirSync(lonely);
  fs.writeFileSync(path.join(lonely, 'main.js'), `require(${JSON.stringify(path.join(dir, 'adminAuth.js'))});`);
  const missing = run([path.join(lonely, 'main.js')]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /cannot find bcryptjs/);
});

test('adminAuth.js stays CommonJS', () => {
  const src = fs.readFileSync(path.join(ROOT, 'nodered', 'adminAuth.js'), 'utf8');
  assert.match(src, /module\.exports\s*=/);
  assert.doesNotMatch(src, /^\s*(import|export)\s/m);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'nodered', 'package.json'), 'utf8')).type, 'commonjs');
});
