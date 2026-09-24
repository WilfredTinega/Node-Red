import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';

const script = path.resolve('reset-admin.js');

function run(dir, args, env = {}) {
  return execFileSync(process.execPath, [script, ...args], {
    env: { ...process.env, USERS_FILE: path.join(dir, 'users.json'), DEFAULT_ADMIN_PASSWORD: '', ...env },
    encoding: 'utf8',
  });
}

test('reset-admin.js sets a given password, keeps other users and the file mode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-admin-'));
  const file = path.join(dir, 'users.json');
  fs.writeFileSync(
    file,
    JSON.stringify([
      { username: 'administrator', password: '$2a$10$x', permissions: 'read', instances: { 1880: 'read' }, secret: 'v1:x:y:z' },
      { username: 'other@test', password: '$2a$10$y', permissions: 'read' },
    ]),
    { mode: 0o644 },
  );
  const out = run(dir, ['newpassword123']);
  assert.match(out, /administrator: password set/);
  const users = JSON.parse(fs.readFileSync(file, 'utf8'));
  const admin = users.find((u) => u.username === 'administrator');
  assert.ok(bcrypt.compareSync('newpassword123', admin.password));
  assert.match(admin.password, /^\$2a\$/);
  assert.equal(admin.permissions, '*');
  assert.equal(admin.instances, undefined);
  assert.equal(admin.secret, undefined, 'the viewable copy is dropped');
  assert.ok(users.some((u) => u.username === 'other@test'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reset-admin.js creates the account and prints a random password when none is given', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-admin-'));
  const out = run(dir, []);
  const password = out.match(/set to (\S+)/)[1];
  const users = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8'));
  assert.equal(users.length, 1);
  assert.ok(bcrypt.compareSync(password, users[0].password));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reset-admin.js refuses a short password', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-admin-'));
  assert.throws(() => run(dir, ['short']), /status 2|at least 10/);
  fs.rmSync(dir, { recursive: true, force: true });
});
