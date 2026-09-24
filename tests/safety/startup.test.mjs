// Starting the dashboard (and using it) writes only into its own folders: the
// shared users folder (users.json, adminAuth.js) and /secrets. A Node-RED
// userDir next to it, and the read-only config folder, stay byte-for-byte
// identical, down to their inodes and mtimes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer, fakeNodeRed, acceptsBackupAccount, ADMIN, ADMIN_PW, ROOT } from '../backend/helpers.mjs';
import { githubMock, GOOD_TOKEN } from '../backend/github-mock.mjs';
import { safetyDir, snapshot } from './util.mjs';

const OUR_ADMIN_AUTH = fs.readFileSync(path.join(ROOT, 'nodered', 'adminAuth.js'), 'utf8');
const USERDIR = {
  'flows.json': '[{"id":"t1","type":"tab"},{"id":"n1","type":"http in","z":"t1","url":"/","method":"get"}]\n',
  'flows_cred.json': '{"$":"deadbeef"}\n',
  'settings.js': "module.exports = { credentialSecret: false, adminAuth: { type: 'credentials', users: [] } };\n",
  '.config.runtime.json': '{"instanceId":"i1","_credentialSecret":"generated"}\n',
  '.config.nodes.json': '{"node-red":{"name":"node-red"}}\n',
  '.config.users.json': '{"admin":{"editor":{}}}\n',
  'lib/flows/lib.json': '[]\n',
  'node_modules/node-red-contrib-x/package.json': '{"name":"x"}\n',
};

function layout({ auth = 'empty' } = {}) {
  const root = safetyDir('host');
  const w = (rel, content, mode) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    if (mode) fs.chmodSync(p, mode);
  };
  for (const [f, c] of Object.entries(USERDIR)) {
    w(`data/${f}`, c); // Node-RED in Docker: /data
    w(`home/.node-red/${f}`, c); // host install: ~/.node-red
  }
  fs.mkdirSync(path.join(root, 'secrets'));
  w('config/instances.json', '[]\n');
  fs.chmodSync(path.join(root, 'config'), 0o555);
  if (auth !== 'missing') fs.mkdirSync(path.join(root, 'auth'));
  return { root, w };
}

const env = (root, extra = {}) => ({
  HOME: path.join(root, 'home'),
  USERS_FILE: path.join(root, 'auth', 'users.json'),
  SECRET_KEY_FILE: path.join(root, 'secrets', 'password.key'),
  BACKUP_FILE: path.join(root, 'secrets', 'backup.json'),
  GITHUB_FILE: path.join(root, 'secrets', 'github.json'),
  DASHBOARD_UPDATE_FILE: path.join(root, 'secrets', 'dashboard-update.json'),
  INSTANCES_FILE: path.join(root, 'config', 'instances.json'),
  ...extra,
});

const servers = [];
const closers = [];
after(async () => {
  for (const s of servers) await s.stop();
  for (const c of closers) await c();
});
async function start(root, extra) {
  const srv = await startServer({ dir: path.join(root, 'secrets'), env: env(root, extra) });
  servers.push(srv);
  return srv;
}

// Everything outside auth/ and secrets/ must be identical; returns what changed inside them.
function assertOnlyOwnFolders(root, before) {
  const now = snapshot(root, true);
  const changed = new Set();
  for (const rel of new Set([...Object.keys(before.files), ...Object.keys(now.files)])) {
    const a = before.files[rel];
    const b = now.files[rel];
    const same = a && b && a.equals(b) && before.meta[rel].mtimeMs === now.meta[rel].mtimeMs && before.meta[rel].ino === now.meta[rel].ino && before.meta[rel].mode === now.meta[rel].mode;
    if (same) continue;
    assert.match(rel, /^(auth|secrets)\//, `${rel} was ${!a ? 'created' : !b ? 'deleted' : 'changed'} outside the dashboard's own folders`);
    changed.add(rel);
  }
  for (const rel of Object.keys(now.files)) assert.doesNotMatch(rel, /\.tmp$/, `left a temp file ${rel}`);
  return changed;
}

test('fresh install: writes users.json and adminAuth.js into the shared folder and nothing else', async () => {
  const { root } = layout();
  const before = snapshot(root, true);
  const srv = await start(root);
  await srv.stop();
  const changed = assertOnlyOwnFolders(root, before);
  assert.deepEqual([...changed].sort(), ['auth/adminAuth.js', 'auth/users.json', 'secrets/password.key']);
  assert.equal(fs.readFileSync(path.join(root, 'auth', 'adminAuth.js'), 'utf8'), OUR_ADMIN_AUTH);
});

test('the shared folder does not exist yet: nothing is created anywhere, the page still starts', async () => {
  const { root } = layout({ auth: 'missing' });
  const before = snapshot(root, true);
  const srv = await start(root);
  await srv.stop();
  assert.equal(fs.existsSync(path.join(root, 'auth')), false, 'no folder is made on its own');
  assert.match(srv.log(), /WARNING: cannot read .*users.json/);
  assert.match(srv.log(), /WARNING: cannot install adminAuth.js/);
  assertOnlyOwnFolders(root, before);
});

test('an existing shared folder: other files, existing users and file permissions are kept; a foreign adminAuth.js is not overwritten', async () => {
  const { root, w } = layout();
  const existingUsers = [{ username: 'ops', password: '$2a$10$abcdefghijklmnopqrstuuFJ0nq4vYp0y2Tq0m6o8pZyqzvE5y5a', permissions: ['read', 'flows.write'], extra: { keep: true } }];
  w('auth/users.json', JSON.stringify(existingUsers, null, 2), 0o644);
  const foreign = "module.exports = { type: 'credentials', users: [{ username: 'legacy', password: 'x', permissions: '*' }] };\n";
  w('auth/adminAuth.js', foreign, 0o644);
  w('auth/notes.txt', 'do not touch\n');
  w('auth/old/users.json.bak', '[]\n');
  const before = snapshot(root, true);
  const srv = await start(root);
  await srv.stop();
  const changed = assertOnlyOwnFolders(root, before);
  assert.deepEqual([...changed].filter((f) => f.startsWith('auth/')), ['auth/users.json'], 'only users.json changed in the shared folder');
  assert.equal(fs.readFileSync(path.join(root, 'auth', 'adminAuth.js'), 'utf8'), foreign, 'foreign adminAuth.js left alone');
  assert.match(srv.log(), /was not written by this dashboard, so it was left as it is/);
  const users = JSON.parse(fs.readFileSync(path.join(root, 'auth', 'users.json'), 'utf8'));
  assert.deepEqual(users.slice(1), existingUsers, 'existing users kept exactly');
  assert.equal(users[0].username, ADMIN);
  assert.equal(fs.statSync(path.join(root, 'auth', 'users.json')).mode & 0o777, 0o644, 'permissions kept, so a Node-RED running as another user can still read it');
});

test('an unreadable users.json is never overwritten', async () => {
  const { root, w } = layout();
  w('auth/users.json', '{ not json');
  const before = snapshot(root, true);
  const srv = await start(root);
  await srv.stop();
  const changed = assertOnlyOwnFolders(root, before);
  assert.ok(!changed.has('auth/users.json'));
  assert.equal(fs.readFileSync(path.join(root, 'auth', 'users.json'), 'utf8'), '{ not json');
});

test('an older copy of our adminAuth.js is replaced atomically; a Node-RED that already loaded it keeps working', async () => {
  const { root, w } = layout();
  const older = OUR_ADMIN_AUTH.replace("'use strict';", "'use strict';\n// older release");
  w('auth/adminAuth.js', older);
  // First start writes users.json; the running "Node-RED" loads adminAuth.js now.
  const pre = await start(root);
  await pre.stop();
  w('auth/adminAuth.js', older);
  const inodeBefore = fs.statSync(path.join(root, 'auth', 'adminAuth.js')).ino;
  const require = createRequire(import.meta.url);
  const loaded = require(path.join(root, 'auth', 'adminAuth.js'));
  assert.deepEqual(await loaded.authenticate(ADMIN, ADMIN_PW), { username: ADMIN, permissions: '*' });

  const srv = await start(root);
  assert.equal(fs.readFileSync(path.join(root, 'auth', 'adminAuth.js'), 'utf8'), OUR_ADMIN_AUTH);
  assert.notEqual(fs.statSync(path.join(root, 'auth', 'adminAuth.js')).ino, inodeBefore, 'renamed into place, never rewritten in place');
  // Node's module cache (and Node-RED's settings object) keep the loaded copy until restart.
  assert.deepEqual(await loaded.authenticate(ADMIN, ADMIN_PW), { username: ADMIN, permissions: '*' });
  await srv.stop();
});

test('a whole session (users, instances, backups) never writes outside the dashboard folders', async () => {
  const { root, w } = layout();
  const gh = await githubMock();
  closers.push(() => gh.close());
  let srv;
  const nr = await fakeNodeRed({ login: 'credentials', users: acceptsBackupAccount(() => srv) });
  closers.push(() => nr.close());
  fs.chmodSync(path.join(root, 'config'), 0o755);
  w('config/instances.json', JSON.stringify([{ name: 'Farm', port: nr.port, sharedLogins: true }]));
  fs.chmodSync(path.join(root, 'config'), 0o555);
  const before = snapshot(root, true);
  srv = await start(root, { GITHUB_API: gh.url });
  const c = srv.client();
  await c.login(ADMIN, ADMIN_PW);
  assert.equal((await c.put('/api/settings', { viewablePasswords: true })).status, 200);
  assert.equal((await c.post('/api/users', { username: 'u1', permissions: 'read', password: 'u1-password-1' })).status, 201);
  assert.equal((await c.put('/api/users/u1', { permissions: '*', instances: { [nr.port]: 'read' } })).status, 200);
  assert.equal((await c.put('/api/users/u1', { generate: true })).status, 200);
  assert.equal((await c.del('/api/users/u1')).status, 200);
  assert.equal((await c.get('/api/instances')).status, 200);
  assert.equal((await c.post('/api/github/connect', { token: GOOD_TOKEN })).status, 200);
  assert.equal((await c.put('/api/backup', { repo: 'octo/private-full' })).status, 200);
  const run = await c.post('/api/backup/run');
  assert.equal(run.body.ok, true, run.text);
  await srv.stop();
  const changed = assertOnlyOwnFolders(root, before);
  assert.ok(changed.has('secrets/backup.json') && changed.has('secrets/github.json') && changed.has('secrets/settings.json'));
  for (const f of ['password.key', 'backup.json', 'github.json', 'settings.json']) {
    assert.equal(fs.statSync(path.join(root, 'secrets', f)).mode & 0o777, 0o600, `${f} is private to the dashboard`);
  }
  assert.equal(fs.statSync(path.join(root, 'auth', 'users.json')).mode & 0o777, 0o644, 'readable by every Node-RED');
  assert.equal(fs.statSync(path.join(root, 'auth', 'adminAuth.js')).mode & 0o777, 0o644);
});
