// Recovery: set the locked administrator's password from inside the container.
//   docker exec <dashboard container> node reset-admin.js [new password]
// Without an argument it uses DEFAULT_ADMIN_PASSWORD, or makes a random one and
// prints it. The account is created if it is missing. Only the hash is stored;
// the viewable copy (if that setting is on) is dropped until the next change.
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs';

const USERS_FILE = process.env.USERS_FILE || '/auth/users.json';
const LOCKED_ADMIN = process.env.LOCKED_ADMIN || 'administrator';
const MIN_PASSWORD = 10;

const given = process.argv[2] || process.env.DEFAULT_ADMIN_PASSWORD || '';
const generated = !given;
const password = given || crypto.randomBytes(12).toString('base64url');
if (password.length < MIN_PASSWORD) {
  console.error(`The password must be at least ${MIN_PASSWORD} characters.`);
  process.exit(2);
}

let users = [];
let stat = null;
try {
  stat = fs.statSync(USERS_FILE);
  users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  if (!Array.isArray(users)) throw new Error('not a JSON array');
} catch (e) {
  if (e.code !== 'ENOENT') {
    console.error(`Cannot read ${USERS_FILE}: ${e.message}`);
    process.exit(1);
  }
}

let user = users.find((u) => u.username === LOCKED_ADMIN);
if (!user) {
  user = { username: LOCKED_ADMIN };
  users.unshift(user);
}
user.permissions = '*';
delete user.instances;
delete user.secret;
// $2a$: the prefix every Node-RED's bcrypt accepts (same as server.js).
user.password = bcrypt.hashSync(password, 10).replace(/^\$2b\$/, '$2a$');

// Same temp-file + rename as the server, keeping the file's mode and owner so
// the dashboard (another uid than root) can still write it afterwards.
const tmp = `${USERS_FILE}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(users, null, 2) + '\n', { mode: stat ? stat.mode & 0o777 : 0o644 });
if (stat && process.getuid && process.getuid() === 0) fs.chownSync(tmp, stat.uid, stat.gid);
fs.renameSync(tmp, USERS_FILE);

console.log(`${LOCKED_ADMIN}: password ${generated ? `set to ${password}` : 'set'} (${USERS_FILE}). It works at the next login; no restart needed.`);
