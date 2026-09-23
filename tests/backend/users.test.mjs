import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { startServer, tempDir, ADMIN, ADMIN_PW } from './helpers.mjs';

const servers = [];
const start = async (opts) => {
  const s = await startServer(opts);
  servers.push(s);
  return s;
};
after(() => Promise.all(servers.map((s) => s.stop())));

async function adminClient(srv) {
  const c = srv.client();
  await c.login(ADMIN, ADMIN_PW);
  return c;
}

test('add, list, view and reset passwords (encrypted secret round trip)', async () => {
  const srv = await start();
  const c = await adminClient(srv);

  const add = await c.post('/api/users', { username: ' erin ', permissions: 'read', password: 'erin-password-1' });
  assert.equal(add.status, 201);
  assert.deepEqual(add.body, { ok: true, password: null });

  const stored = srv.readJson('users.json').find((u) => u.username === 'erin');
  assert.ok(stored, 'username is trimmed');
  assert.match(stored.password, /^\$2a\$/, 'new hashes are $2a$');
  assert.ok(bcrypt.compareSync('erin-password-1', stored.password));
  assert.match(stored.secret, /^v1:[^:]+:[^:]+:[^:]+$/);
  assert.ok(!stored.secret.includes('erin-password-1'));

  const view = await c.get('/api/users/erin/password');
  assert.equal(view.status, 200);
  assert.deepEqual(view.body, { password: 'erin-password-1' });
  assert.equal(view.headers.get('cache-control'), 'no-store');

  const gen = await c.post('/api/users', { username: 'frank', permissions: '*', generate: true });
  assert.equal(gen.status, 201);
  assert.equal(typeof gen.body.password, 'string');
  assert.ok(gen.body.password.length >= 10);
  assert.equal((await c.get('/api/users/frank/password')).body.password, gen.body.password);
  await srv.client().login('frank', gen.body.password);

  const reset = await c.put('/api/users/erin', { password: 'erin-password-2' });
  assert.deepEqual(reset.body, { ok: true, password: null });
  assert.equal((await c.get('/api/users/erin/password')).body.password, 'erin-password-2');
  await srv.client().login('erin', 'erin-password-2');

  const list = await c.get('/api/users');
  assert.deepEqual(
    list.body.map((u) => u.username),
    [ADMIN, 'erin', 'frank'],
  );
  const erin = list.body.find((u) => u.username === 'erin');
  assert.deepEqual(erin, { username: 'erin', permissions: 'read', admin: false, locked: false, viewable: true, instances: null });
  // Never the hash or the secret.
  assert.ok(!list.text.includes('$2a$'));
  assert.ok(!list.text.includes('v1:'));

  assert.equal((await c.get('/api/users/nobody/password')).status, 404);
  assert.equal((await c.put('/api/users/nobody', { permissions: 'read' })).status, 404);
  assert.equal((await c.del('/api/users/nobody')).status, 404);

  // Non-admins can't view passwords.
  const erinC = srv.client();
  await erinC.login('erin', 'erin-password-2');
  assert.equal((await erinC.get('/api/users/frank/password')).status, 403);
});

test('validation: username, permissions, password length, duplicates', async () => {
  const srv = await start();
  const c = await adminClient(srv);
  const bad = [
    [{ username: '', permissions: 'read', password: 'long-enough-1' }, 400],
    [{ username: 'has space', permissions: 'read', password: 'long-enough-1' }, 400],
    [{ username: 'x'.repeat(101), permissions: 'read', password: 'long-enough-1' }, 400],
    [{ username: 'ok', permissions: 'write', password: 'long-enough-1' }, 400],
    [{ username: 'ok', permissions: ['*'], password: 'long-enough-1' }, 400],
    [{ username: 'ok', permissions: 'read', password: 'short' }, 400],
    [{ username: 'ok', permissions: 'read' }, 400],
    [{ username: 'Administrator', permissions: 'read', password: 'long-enough-1' }, 409],
  ];
  for (const [body, status] of bad) {
    const r = await c.post('/api/users', body);
    assert.equal(r.status, status, JSON.stringify(body));
    assert.ok(r.body.error);
  }
  assert.equal(srv.readJson('users.json').length, 1, 'nothing was written');
});

test('$2y$ hashes (PHP) are accepted at login', async () => {
  const dir = tempDir('y');
  const y = bcrypt.hashSync('php-made-password', 10).replace(/^\$2[ab]\$/, '$2y$');
  const srv = await start({
    dir,
    users: [
      { username: ADMIN, permissions: '*', password: bcrypt.hashSync(ADMIN_PW, 10) },
      { username: 'php', permissions: 'read', password: y },
    ],
  });
  const r = await srv.client().post('/api/login', { username: 'php', password: 'php-made-password' });
  assert.equal(r.status, 200);
  assert.equal(r.body.viewable, false, 'no secret stored for hand-made hashes');
  const c = await adminClient(srv);
  const view = await c.get('/api/users/php/password');
  assert.equal(view.status, 404);
  assert.match(view.body.error, /Reset it/);
  // An existing locked admin's password is never touched on start.
  assert.ok(bcrypt.compareSync(ADMIN_PW, srv.readJson('users.json')[0].password));
});

test('the locked admin cannot be demoted, deleted or limited to instances', async () => {
  const srv = await start();
  const c = await adminClient(srv);
  await c.post('/api/users', { username: 'gina', permissions: '*', password: 'gina-password-1' });
  const gina = srv.client();
  await gina.login('gina', 'gina-password-1');

  for (const who of [c, gina]) {
    assert.equal((await who.put(`/api/users/${ADMIN}`, { permissions: 'read' })).status, 400);
    assert.equal((await who.put(`/api/users/${ADMIN}`, { instances: { 1890: 'read' } })).status, 400);
    assert.equal((await who.put(`/api/users/${ADMIN}`, { instances: {} })).status, 400);
    assert.equal((await who.del(`/api/users/${ADMIN}`)).status, 400);
  }
  // A combined request fails as a whole: nothing is written.
  assert.equal((await gina.put(`/api/users/${ADMIN}`, { permissions: '*', instances: { 1890: '*' } })).status, 400);
  const admin = srv.readJson('users.json').find((u) => u.username === ADMIN);
  assert.equal(admin.permissions, '*');
  assert.equal(admin.instances, undefined);

  // Harmless no-ops are allowed, and another admin may reset its password.
  assert.equal((await gina.put(`/api/users/${ADMIN}`, { permissions: '*', instances: null })).status, 200);
  const reset = await gina.put(`/api/users/${ADMIN}`, { password: 'new-admin-pass' });
  assert.equal(reset.status, 200);
  await srv.client().login(ADMIN, 'new-admin-pass');
});

test('start restores full access for a locked admin edited by hand', async () => {
  const srv = await start({
    users: [
      { username: 'alice', permissions: '*', password: bcrypt.hashSync('alice-password', 10) },
      { username: ADMIN, permissions: 'read', instances: { 1890: 'read' }, password: bcrypt.hashSync(ADMIN_PW, 10) },
    ],
  });
  const admin = srv.readJson('users.json').find((u) => u.username === ADMIN);
  assert.equal(admin.permissions, '*');
  assert.equal(admin.instances, undefined);
  assert.equal(srv.readJson('users.json').length, 2);
});

test('start adds the locked admin to an existing file that lacks it', async () => {
  const srv = await start({ users: [{ username: 'alice', permissions: '*', password: bcrypt.hashSync('alice-password', 10) }] });
  const users = srv.readJson('users.json');
  assert.deepEqual(users.map((u) => u.username), [ADMIN, 'alice']);
  await srv.client().login(ADMIN, ADMIN_PW);
});

test('LOCKED_ADMIN and DEFAULT_ADMIN_PASSWORD can be changed', async () => {
  const srv = await start({ env: { LOCKED_ADMIN: 'root', DEFAULT_ADMIN_PASSWORD: 'another-default' } });
  const r = await srv.client().login('root', 'another-default');
  assert.equal(r.body.locked, true);
});

test('last-admin guard and self-delete', async () => {
  const srv = await start();
  const c = await adminClient(srv);
  await c.post('/api/users', { username: 'hank', permissions: '*', password: 'hank-password-1' });
  const hank = srv.client();
  await hank.login('hank', 'hank-password-1');
  assert.equal((await hank.del('/api/users/hank')).status, 400);

  // Normally the locked admin is always another admin. Take it out by hand
  // to reach the guard.
  srv.writeJson('users.json', srv.readJson('users.json').filter((u) => u.username !== ADMIN));
  const demote = await hank.put('/api/users/hank', { permissions: 'read' });
  assert.equal(demote.status, 400);
  assert.match(demote.body.error, /at least one admin/);
  assert.equal(srv.readJson('users.json')[0].permissions, '*');

  // With a second admin it works.
  await hank.post('/api/users', { username: 'ivy', permissions: '*', password: 'ivy-password-1' });
  assert.equal((await hank.put('/api/users/ivy', { permissions: 'read' })).status, 200);
  assert.equal((await hank.put('/api/users/ivy', { permissions: '*' })).status, 200);
  assert.equal((await hank.del('/api/users/ivy')).status, 200);
});

test('viewing is disabled without a usable key, and setting passwords still works', async () => {
  const dir = tempDir('nokey');
  // A key file with the wrong length disables viewing instead of crashing.
  const fs = await import('node:fs');
  fs.writeFileSync(`${dir}/password.key`, 'abcd\n');
  const srv = await start({ dir });
  const c = await adminClient(srv);
  assert.equal((await c.get('/api/me')).body.viewable, false);
  assert.equal((await c.post('/api/users', { username: 'jo', permissions: 'read', password: 'jo-password-1' })).status, 201);
  assert.equal(srv.readJson('users.json').find((u) => u.username === 'jo').secret, undefined);
  assert.equal((await c.get('/api/users/jo/password')).status, 503);
});
