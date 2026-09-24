import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, ADMIN, ADMIN_PW, ROOT } from './helpers.mjs';

let srv;
const extra = [];
before(async () => {
  // No users.json at all: a fresh install.
  srv = await startServer();
});
after(async () => {
  await srv?.stop();
  await Promise.all(extra.map((s) => s.stop()));
});

test('fresh install creates the locked admin with DEFAULT_ADMIN_PASSWORD, hash only', async () => {
  const users = srv.readJson('users.json');
  assert.equal(users.length, 1);
  assert.equal(users[0].username, ADMIN);
  assert.equal(users[0].permissions, '*');
  assert.match(users[0].password, /^\$2a\$10\$/);
  assert.equal(users[0].secret, undefined, 'no viewable copy unless the setting is on');
  assert.equal(users[0].instances, undefined);
  // Every Node-RED reads it, whatever uid it runs as; only the dashboard writes it.
  assert.equal(fs.statSync(path.join(srv.dir, 'users.json')).mode & 0o777, 0o644);
  assert.ok(!fs.existsSync(path.join(srv.dir, 'initial-admin-password')), 'no password file when one was given');
  // The shared login module is installed next to users.json, unchanged.
  const installed = fs.readFileSync(path.join(srv.dir, 'adminAuth.js'), 'utf8');
  assert.equal(installed, fs.readFileSync(path.join(ROOT, 'nodered', 'adminAuth.js'), 'utf8'));
  const key = fs.readFileSync(path.join(srv.dir, 'password.key'), 'utf8').trim();
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(path.join(srv.dir, 'password.key')).mode & 0o777, 0o600);
});

test('without DEFAULT_ADMIN_PASSWORD a random one is written to INITIAL_PASSWORD_FILE and never logged', async () => {
  const s = await startServer({ env: { DEFAULT_ADMIN_PASSWORD: '' } });
  extra.push(s);
  const file = path.join(s.dir, 'initial-admin-password');
  const password = fs.readFileSync(file, 'utf8').trim();
  assert.ok(password.length >= 16, password);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const lines = s.log().split('\n').filter((l) => l.includes('Initial administrator password'));
  assert.deepEqual(lines, [`Initial administrator password written to ${file}`]);
  assert.ok(!s.log().includes(password), 'the password itself is not in the log');
  assert.equal(s.readJson('users.json')[0].secret, undefined);
  const r = await s.client().login(ADMIN, password);
  assert.equal(r.body.locked, true);
});

test('login, /api/me and logout', async () => {
  const c = srv.client();
  assert.equal((await c.get('/api/me')).status, 401);
  const r = await c.login(ADMIN, ADMIN_PW);
  assert.deepEqual(r.body, { username: ADMIN, permissions: '*', admin: true, locked: true, system: false, viewable: false, instances: null });
  const setCookie = r.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.equal((await c.get('/api/me')).body.username, ADMIN);
  const out = await c.post('/api/logout');
  assert.equal(out.status, 200);
  assert.equal(c.cookie, null);
  assert.equal((await c.get('/api/me')).status, 401);
});

test('a logged-out token stays dead even if replayed', async () => {
  const c = srv.client();
  await c.login(ADMIN, ADMIN_PW);
  const token = c.cookie;
  await c.post('/api/logout');
  c.cookie = token;
  assert.equal((await c.get('/api/me')).status, 401);
});

test('wrong username and wrong password give the same answer', async () => {
  const c = srv.client();
  const a = await c.post('/api/login', { username: 'nobody', password: 'whatever-123' });
  const b = await c.post('/api/login', { username: ADMIN, password: 'whatever-123' });
  assert.equal(a.status, 401);
  assert.deepEqual(a.body, b.body);
  const d = await c.post('/api/login', { username: ADMIN });
  assert.equal(d.status, 401);
  // Two failures from above plus this one: reset the counter with a good login.
  await c.login(ADMIN, ADMIN_PW);
});

test('non-GET /api requests need X-Requested-With: fetch', async () => {
  const c = srv.client();
  const r = await c.post('/api/login', { username: ADMIN, password: ADMIN_PW }, { csrf: false });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /header/i);
  const wrong = await c.post('/api/login', { username: ADMIN, password: ADMIN_PW }, { csrf: false, headers: { 'X-Requested-With': 'XMLHttpRequest' } });
  assert.equal(wrong.status, 403);
  await c.login(ADMIN, ADMIN_PW);
  // Logged in, a state change without the header is still refused.
  const add = await c.post('/api/users', { username: 'x', permissions: 'read', password: 'long-enough-pw' }, { csrf: false });
  assert.equal(add.status, 403);
  assert.equal((await c.del('/api/users/x', { csrf: false })).status, 403);
  assert.equal((await c.post('/api/logout', undefined, { csrf: false })).status, 403);
  // GET needs no header.
  assert.equal((await c.get('/api/users', { csrf: false })).status, 200);
});

test('bad JSON is a 400, not a server error', async () => {
  const c = srv.client();
  const r = await c.req('POST', '/api/login', undefined, { raw: '{nope', headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 400);
  assert.ok(r.body.error);
});

test('unknown /api route is a JSON 404', async () => {
  const c = srv.client();
  const r = await c.get('/api/nope');
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, { error: 'Not found.' });
});

test('password reset and delete end the other user\'s sessions', async () => {
  const admin = srv.client();
  await admin.login(ADMIN, ADMIN_PW);
  assert.equal((await admin.post('/api/users', { username: 'bob', permissions: 'read', password: 'bob-password-1' })).status, 201);

  const bob = srv.client();
  await bob.login('bob', 'bob-password-1');
  assert.equal((await bob.get('/api/me')).status, 200);
  // Non-admins can't manage users.
  assert.equal((await bob.get('/api/users')).status, 403);

  // Changing only permissions keeps bob logged in (the session reads the current record).
  await admin.put('/api/users/bob', { permissions: '*' });
  assert.equal((await bob.get('/api/me')).body.admin, true);
  await admin.put('/api/users/bob', { permissions: 'read' });
  assert.equal((await bob.get('/api/me')).body.admin, false);

  const reset = await admin.put('/api/users/bob', { generate: true });
  assert.equal(reset.status, 200);
  assert.equal(typeof reset.body.password, 'string');
  assert.equal((await bob.get('/api/me')).status, 401);
  assert.equal((await srv.client().post('/api/login', { username: 'bob', password: 'bob-password-1' })).status, 401);

  await bob.login('bob', reset.body.password);
  assert.equal((await admin.del('/api/users/bob')).status, 200);
  assert.equal((await bob.get('/api/me')).status, 401);
});

test('own password change keeps this session and ends the others', async () => {
  const admin = srv.client();
  await admin.login(ADMIN, ADMIN_PW);
  await admin.post('/api/users', { username: 'carol', permissions: '*', password: 'carol-password-1' });
  const a = srv.client();
  const b = srv.client();
  await a.login('carol', 'carol-password-1');
  await b.login('carol', 'carol-password-1');

  assert.equal((await a.post('/api/me/password', { current: 'wrong-wrong-1', next: 'carol-password-2' })).status, 400);
  assert.equal((await a.post('/api/me/password', { current: 'carol-password-1', next: 'short' })).status, 400);
  assert.equal((await a.post('/api/me/password', { current: 'carol-password-1', next: 'carol-password-2' })).status, 200);
  assert.equal((await a.get('/api/me')).status, 200);
  assert.equal((await b.get('/api/me')).status, 401);

  // Same through the admin endpoint on your own account.
  await b.login('carol', 'carol-password-2');
  assert.equal((await a.put('/api/users/carol', { password: 'carol-password-3' })).status, 200);
  assert.equal((await a.get('/api/me')).status, 200);
  assert.equal((await b.get('/api/me')).status, 401);
  await admin.del('/api/users/carol');
});

test('a user removed from users.json by hand loses access at once', async () => {
  const admin = srv.client();
  await admin.login(ADMIN, ADMIN_PW);
  await admin.post('/api/users', { username: 'dave', permissions: 'read', password: 'dave-password-1' });
  const dave = srv.client();
  await dave.login('dave', 'dave-password-1');
  srv.writeJson('users.json', srv.readJson('users.json').filter((u) => u.username !== 'dave'));
  assert.equal((await dave.get('/api/me')).status, 401);
});

// Last, because it locks out 127.0.0.1 for this server.
test('five failures lock the address out, even for the right password, and say for how long', async () => {
  const c = srv.client();
  for (let i = 0; i < 4; i++) {
    const r = await c.post('/api/login', { username: ADMIN, password: `wrong-${i}-xxxxxx` });
    assert.equal(r.status, 401, `attempt ${i + 1}`);
    assert.deepEqual(r.body, { error: 'Wrong username or password.' });
    assert.equal(r.headers.get('retry-after'), null);
  }
  // The fifth failure trips the lock and already carries the countdown.
  const fifth = await c.post('/api/login', { username: ADMIN, password: 'wrong-4-xxxxxx' });
  assert.equal(fifth.status, 401);
  assert.equal(fifth.body.error, 'Wrong username or password.');
  assert.ok(fifth.body.retryAfterMs > 14 * 60 * 1000 && fifth.body.retryAfterMs <= 15 * 60 * 1000, String(fifth.body.retryAfterMs));
  assert.equal(fifth.headers.get('retry-after'), String(Math.ceil(fifth.body.retryAfterMs / 1000)));

  const locked = await c.post('/api/login', { username: ADMIN, password: ADMIN_PW });
  assert.equal(locked.status, 429);
  assert.deepEqual(Object.keys(locked.body).sort(), ['error', 'retryAfterMs']);
  assert.equal(locked.body.error, 'Too many failed attempts.');
  assert.ok(locked.body.retryAfterMs > 0 && locked.body.retryAfterMs <= fifth.body.retryAfterMs);
  const header = Number(locked.headers.get('retry-after'));
  assert.ok(Number.isInteger(header) && header >= 1 && header <= 900, locked.headers.get('retry-after'));
  assert.equal(header, Math.ceil(locked.body.retryAfterMs / 1000), 'whole seconds, rounded up');
});
