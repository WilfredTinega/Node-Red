// Backend for the Node-RED user admin page.
// Reads and writes the same users.json that every Node-RED instance's
// adminAuth block checks at login, so changes apply on the next login.
import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackups } from './backup.js';
import { createDocker, registryAuth } from './docker.js';
import { callHostAgent, hostAgentEnabled } from './host-agent-client.js';
import { createGithubAccount, github } from './github.js';

const USERS_FILE = process.env.USERS_FILE || '/auth/users.json';
const PORT = Number(process.env.PORT || 1881);
const SECURE_COOKIE = process.env.SECURE_COOKIE === '1';
const SESSION_MS = 8 * 60 * 60 * 1000;
const MIN_PASSWORD = 10;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const PERMISSIONS = ['*', 'read'];
const COOKIE = 'nrua_session';
// Kept outside the users file's folder, so a copy of users.json (or a
// Node-RED container that mounts it) cannot decrypt the stored passwords.
const SECRET_KEY_FILE = process.env.SECRET_KEY_FILE || '/secrets/password.key';
// This account always keeps full access and cannot be deleted, so there is
// always a way back in.
const LOCKED_ADMIN = process.env.LOCKED_ADMIN || 'administrator';
// Used only when LOCKED_ADMIN doesn't exist yet (e.g. a fresh install). Unset
// means a random password, written once to INITIAL_PASSWORD_FILE.
const DEFAULT_ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || '';
const INITIAL_PASSWORD_FILE = process.env.INITIAL_PASSWORD_FILE || '/secrets/initial-admin-password';
// Dashboard settings (viewable passwords on/off), next to the key.
const SETTINGS_FILE = process.env.SETTINGS_FILE || '/secrets/settings.json';
// The read-only account backups log in with. The dashboard creates and rotates
// it itself; its password is kept only encrypted in the backup settings.
const BACKUP_USER = 'nodered-backup';

// ---------- instance discovery settings ----------
// DOCKER_API: a read-only Docker socket proxy; blank disables container discovery.
const DOCKER_API = (process.env.DOCKER_API || '').replace(/\/$/, '');
// Where this process reaches the host's ports: host.docker.internal from the
// compose network, 127.0.0.1 with network_mode: host.
const PROBE_HOST = process.env.PROBE_HOST || '127.0.0.1';
// Find Node-RED installed as a plain package by checking every port the host
// listens on. HOST_NET_DIR holds the host's socket tables: /proc/1/net mounted
// read-only from the compose network, or /proc/net with network_mode: host.
const SCAN_HOST_PORTS = process.env.SCAN_HOST_PORTS !== '0';
const HOST_NET_DIR = process.env.HOST_NET_DIR || '/proc/net';
// The host port this page is published on, so the scan never probes itself.
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT || PORT);
// Ports never probed: well-known services that don't serve Node-RED, the Docker
// API, and any listed in SCAN_SKIP_PORTS (comma separated).
const SCAN_SKIP_PORTS = new Set([
  22, 25, 53, 110, 143, 465, 587, 993, 995, 1883, 2375, 2376, 3306, 5432, 5672, 6379, 8883, 9092, 11211, 27017,
  ...(process.env.SCAN_SKIP_PORTS || '').split(',').map(Number).filter(Boolean),
]);
// Optional names for scanned ports, and instances on other machines.
const INSTANCES_FILE = process.env.INSTANCES_FILE || '/config/instances.json';
// Address shown on the page; blank means "the address you opened this page with".
const PUBLIC_HOST = process.env.PUBLIC_HOST || '';
// Where the shared users folder lives on the server, for the setup instructions.
const AUTH_HOST_DIR = process.env.AUTH_HOST_DIR || '/opt/nodered-auth';
// Backup settings and history, next to the key.
const BACKUP_FILE = process.env.BACKUP_FILE || '/secrets/backup.json';
// The connected GitHub account (encrypted token) and where dashboard updates come from.
const GITHUB_FILE = process.env.GITHUB_FILE || '/secrets/github.json';
// Remembers an update in flight, so the restarted dashboard can report how it went.
const DASHBOARD_UPDATE_FILE = process.env.DASHBOARD_UPDATE_FILE || '/secrets/dashboard-update.json';
// Baked in by the GitHub Actions build (the commit it was built from).
const APP_REVISION = process.env.APP_REVISION || 'dev';
// The GitHub Actions workflow that builds and publishes the dashboard image.
const DASHBOARD_WORKFLOW = process.env.DASHBOARD_WORKFLOW || 'docker.yml';
const REGISTRY = process.env.DASHBOARD_REGISTRY || 'ghcr.io';

const sessions = new Map(); // token -> { username, expires }
const failures = new Map(); // ip -> { count, until }

// ---------- users file ----------

function readUsers() {
  const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  if (!Array.isArray(users)) throw new Error(`${USERS_FILE} must contain a JSON array`);
  return users;
}

// Write to a temp file and rename, so Node-RED never reads a half-written file.
// An existing file keeps its permissions. A new one is world-readable (0644):
// it holds only bcrypt hashes, and every Node-RED, whatever uid it runs as,
// must read it while only this process (its own uid) writes it.
function writeUsers(users) {
  const tmp = `${USERS_FILE}.tmp`;
  let mode = 0o644;
  try {
    mode = fs.statSync(USERS_FILE).mode & 0o777;
  } catch {}
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2) + '\n', { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, USERS_FILE);
}

// Temp file and rename for the files under /secrets, which only this process reads.
function writeSecretFile(file, text) {
  fs.writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

// ---------- settings ----------

function loadSettings() {
  try {
    return { viewablePasswords: false, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`WARNING: cannot read ${SETTINGS_FILE}: ${e.message}`);
    return { viewablePasswords: false };
  }
}

let settings = loadSettings();

// Full access everywhere. Node-RED ignores the main permission once an
// `instances` map exists, so a mapped user is not an admin here either.
const isAdmin = (u) =>
  (u.permissions === '*' || (Array.isArray(u.permissions) && u.permissions.includes('*'))) && !u.instances;

// Written as $2a$ (same algorithm as $2b$), which every Node-RED version accepts.
const hash = (password) => bcrypt.hashSync(password, 10).replace(/^\$2b\$/, '$2a$');

// Node-RED's bcrypt accepts $2a$/$2b$; PHP-style $2y$ hashes are rewritten on read.
const checkPassword = (password, stored) =>
  typeof stored === 'string' && bcrypt.compareSync(password, stored.replace(/^\$2y\$/, '$2a$'));

const generatePassword = () => crypto.randomBytes(12).toString('base64url');

// Compared against when the username doesn't exist, so a wrong username takes
// as long as a wrong password and doesn't reveal which accounts exist.
const DUMMY_HASH = hash(generatePassword());

// ---------- viewable passwords ----------
// Node-RED only ever checks `password` (bcrypt). `secret` is an AES-256-GCM
// copy of the same password so admins can view it later; Node-RED ignores it.
// It is only written while the viewablePasswords setting is on (off by default).

function loadKey() {
  try {
    if (fs.existsSync(SECRET_KEY_FILE)) {
      const key = Buffer.from(fs.readFileSync(SECRET_KEY_FILE, 'utf8').trim(), 'hex');
      if (key.length !== 32) throw new Error('key must be 64 hex characters');
      return key;
    }
    const key = crypto.randomBytes(32);
    fs.writeFileSync(SECRET_KEY_FILE, key.toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
    console.log(`Created password key ${SECRET_KEY_FILE}`);
    return key;
  } catch (e) {
    console.error(`WARNING: viewing passwords is disabled, ${SECRET_KEY_FILE}: ${e.message}`);
    return null;
  }
}

const KEY = loadKey();

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const b64 = (buf) => buf.toString('base64');
  return `v1:${b64(iv)}:${b64(cipher.getAuthTag())}:${b64(data)}`;
}

function decrypt(secret) {
  const [version, iv, tag, data] = secret.split(':');
  if (version !== 'v1') throw new Error(`unknown secret version ${version}`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

const viewableOn = () => Boolean(settings.viewablePasswords && KEY);

// The one place a password is set, so the hash and the viewable copy never drift apart.
function setPassword(user, plain) {
  user.password = hash(plain);
  if (viewableOn()) user.secret = encrypt(plain);
  else delete user.secret;
}

function publicUser(u) {
  return {
    username: u.username,
    permissions: u.permissions,
    admin: isAdmin(u),
    locked: u.username === LOCKED_ADMIN,
    // Managed by the dashboard itself (the backup login); access can't be edited.
    system: Boolean(u.system),
    viewable: Boolean(viewableOn() && u.secret),
    // null = same access on every instance; otherwise { instanceKey: '*' | 'read' }
    instances: u.instances || null,
  };
}

const publicSettings = () => ({ viewablePasswords: Boolean(settings.viewablePasswords), canStoreSecrets: Boolean(KEY) });

// The backup account, created on demand. `stored` is the encrypted password
// the backup settings remember; a new one is made when there is none, when it
// doesn't open, or when it no longer matches the user record (deleted or
// reset by hand). Returns the plaintext and the encrypted copy to store.
function ensureBackupAccount(stored) {
  if (!KEY) throw new Error(`the password key is missing, so the ${BACKUP_USER} login cannot be stored`);
  let password = null;
  try {
    if (stored) password = decrypt(stored);
  } catch {}
  const users = readUsers();
  let user = users.find((u) => u.username === BACKUP_USER);
  if (user && password && checkPassword(password, user.password)) return { password, secret: stored };
  password = generatePassword();
  if (!user) {
    user = { username: BACKUP_USER };
    users.push(user);
  }
  // Read-only everywhere, never viewable: nobody needs to know this password.
  Object.assign(user, { permissions: 'read', system: true, password: hash(password) });
  delete user.instances;
  delete user.secret;
  writeUsers(users);
  console.log(`[backup] set a new password for the ${BACKUP_USER} account`);
  return { password, secret: encrypt(password) };
}

// ---------- errors ----------

class HttpError extends Error {
  // `extra` adds fields next to `error` in the JSON answer.
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters.`);
  }
}

function validatePermissions(permissions) {
  if (!PERMISSIONS.includes(permissions)) {
    throw new HttpError(400, `Permissions must be one of: ${PERMISSIONS.join(', ')}.`);
  }
}

// null means "every instance, at the user's main access level". A map limits
// the user to the listed instances; instances left out refuse the login.
function validateInstanceAccess(instances) {
  if (instances === null) return null;
  if (typeof instances !== 'object' || Array.isArray(instances)) {
    throw new HttpError(400, 'Instance access must be null or an object.');
  }
  const out = {};
  for (const [key, permissions] of Object.entries(instances)) {
    if (!/^[\w.:-]{1,100}$/.test(key)) throw new HttpError(400, `Bad instance key "${key}".`);
    validatePermissions(permissions);
    out[key] = permissions;
  }
  return out;
}

// Either an explicit password or { generate: true }. Returns [plaintext, generated].
function passwordFromBody(body) {
  if (body.generate) return [generatePassword(), true];
  validatePassword(body.password);
  return [body.password, false];
}

function assertAnotherAdminRemains(users, username) {
  if (!users.some((u) => u.username !== username && isAdmin(u))) {
    throw new HttpError(400, 'There must always be at least one admin (permissions "*").');
  }
}

function endSessionsFor(username) {
  for (const [token, s] of sessions) if (s.username === username) sessions.delete(token);
}

// ---------- sessions ----------

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setSessionCookie(res, token, maxAgeMs) {
  const attrs = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (SECURE_COOKIE) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

// Resolves the session to the user's current record, so a deleted or
// demoted user loses access immediately.
function requireAuth(req, res, next) {
  const token = readCookie(req, COOKIE);
  const session = token && sessions.get(token);
  if (!session || session.expires < Date.now()) {
    if (token) sessions.delete(token);
    throw new HttpError(401, 'Please log in.');
  }
  const user = readUsers().find((u) => u.username === session.username);
  if (!user) {
    sessions.delete(token);
    throw new HttpError(401, 'Please log in.');
  }
  req.user = user;
  req.sessionToken = token;
  next();
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req.user)) throw new HttpError(403, 'Only admins can manage users.');
  next();
}

// ---------- app ----------

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

// Browsers can't send this header cross-site without a CORS preflight,
// which this server never approves, so it blocks CSRF on state changes.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.get('X-Requested-With') !== 'fetch') {
    throw new HttpError(403, 'Missing request header.');
  }
  next();
});

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const f = failures.get(ip);
  // The remaining lockout goes with the error, so the page can count it down.
  const lockedOut = (until) => {
    const retryAfterMs = Math.max(0, until - Date.now());
    res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
    return { retryAfterMs };
  };
  if (f && f.until > Date.now()) {
    throw new HttpError(429, 'Too many failed attempts.', lockedOut(f.until));
  }
  const { username, password } = req.body || {};
  const user =
    typeof username === 'string' && readUsers().find((u) => u.username === username.trim());
  const ok = typeof password === 'string' && checkPassword(password, user ? user.password : DUMMY_HASH);
  if (!user || !ok) {
    const lockExpired = f && f.until && f.until <= Date.now();
    const count = (lockExpired ? 0 : f?.count || 0) + 1;
    const until = count >= MAX_FAILURES ? Date.now() + LOCKOUT_MS : 0;
    failures.set(ip, { count, until });
    throw new HttpError(401, 'Wrong username or password.', until ? lockedOut(until) : undefined);
  }
  failures.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username: user.username, expires: Date.now() + SESSION_MS });
  setSessionCookie(res, token, SESSION_MS);
  res.json(publicUser(user));
});

app.post('/api/logout', (req, res) => {
  const token = readCookie(req, COOKIE);
  if (token) sessions.delete(token);
  setSessionCookie(res, '', 0);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json(publicUser(req.user));
});

app.post('/api/me/password', requireAuth, (req, res) => {
  const { current, next: newPassword } = req.body || {};
  if (typeof current !== 'string' || !checkPassword(current, req.user.password)) {
    throw new HttpError(400, 'Current password is wrong.');
  }
  validatePassword(newPassword);
  const users = readUsers();
  setPassword(users.find((u) => u.username === req.user.username), newPassword);
  writeUsers(users);
  endSessionsFor(req.user.username);
  // Keep the session that made the change.
  sessions.set(req.sessionToken, { username: req.user.username, expires: Date.now() + SESSION_MS });
  res.json({ ok: true });
});

// An admin giving up their own full access. The session stays; the page just
// loses the admin parts. The locked admin can't, so there is always a way back in.
app.post('/api/me/demote', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw new HttpError(400, 'You do not have full access to give up.');
  if (req.user.username === LOCKED_ADMIN) throw new HttpError(400, `${LOCKED_ADMIN} cannot give up full access.`);
  const users = readUsers();
  const user = users.find((u) => u.username === req.user.username);
  assertAnotherAdminRemains(users, user.username);
  user.permissions = 'read';
  writeUsers(users);
  console.log(`[audit] ${user.username} gave up full access`);
  res.json(publicUser(user));
});

app.get('/api/settings', requireAuth, requireAdmin, (req, res) => res.json(publicSettings()));

app.put('/api/settings', requireAuth, requireAdmin, (req, res) => {
  const { viewablePasswords } = req.body || {};
  if (typeof viewablePasswords !== 'boolean') throw new HttpError(400, 'viewablePasswords must be true or false.');
  if (viewablePasswords && !KEY) throw new HttpError(400, 'The password key is missing, so passwords cannot be stored viewable.');
  settings = { ...settings, viewablePasswords };
  writeSecretFile(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
  if (!viewablePasswords) {
    // Off means off: the encrypted copies go now, not at the next reset.
    const users = readUsers();
    if (users.some((u) => u.secret)) {
      for (const u of users) delete u.secret;
      writeUsers(users);
    }
  }
  console.log(`[audit] ${req.user.username} turned viewable passwords ${viewablePasswords ? 'on' : 'off'}`);
  res.json(publicSettings());
});

app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
  res.json(readUsers().map(publicUser));
});

app.get('/api/users/:username/password', requireAuth, requireAdmin, (req, res) => {
  if (!settings.viewablePasswords) {
    throw new HttpError(409, 'Viewable passwords are turned off in Settings. Passwords are stored as hashes only.');
  }
  if (!KEY) throw new HttpError(503, 'Viewing passwords is disabled: the password key is missing.');
  const user = readUsers().find((u) => u.username === req.params.username);
  if (!user) throw new HttpError(404, 'User not found.');
  if (!user.secret) {
    throw new HttpError(404, 'This password was set before viewing was enabled. Reset it to make it viewable.');
  }
  let password;
  try {
    password = decrypt(user.secret);
  } catch (e) {
    throw new HttpError(500, `Cannot decrypt this password (${e.message}). Was the key changed?`);
  }
  console.log(`[audit] ${req.user.username} viewed the password of ${user.username}`);
  res.set('Cache-Control', 'no-store');
  res.json({ password });
});

app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
  const body = req.body || {};
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  if (!username || username.length > 100 || /\s/.test(username)) {
    throw new HttpError(400, 'Username is required and cannot contain spaces.');
  }
  validatePermissions(body.permissions);
  const users = readUsers();
  if (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    throw new HttpError(409, `User ${username} already exists.`);
  }
  const [plain, generated] = passwordFromBody(body);
  const user = { username, permissions: body.permissions };
  const instances = body.instances === undefined ? null : validateInstanceAccess(body.instances);
  if (instances) user.instances = instances;
  setPassword(user, plain);
  users.push(user);
  writeUsers(users);
  res.status(201).json({ ok: true, password: generated ? plain : null });
});

app.put('/api/users/:username', requireAuth, requireAdmin, (req, res) => {
  const body = req.body || {};
  const users = readUsers();
  const user = users.find((u) => u.username === req.params.username);
  if (!user) throw new HttpError(404, 'User not found.');

  let shown = null;
  const wasAdmin = isAdmin(user);
  if (body.permissions !== undefined) {
    validatePermissions(body.permissions);
    if (user.username === LOCKED_ADMIN && body.permissions !== '*') {
      throw new HttpError(400, `${LOCKED_ADMIN} always has full access.`);
    }
    if (user.system && body.permissions !== user.permissions) {
      throw new HttpError(400, `${user.username} is managed by the dashboard; its access cannot be changed.`);
    }
    user.permissions = body.permissions;
  }
  if (body.instances !== undefined) {
    if (user.username === LOCKED_ADMIN && body.instances !== null) {
      throw new HttpError(400, `${LOCKED_ADMIN} always has full access on every instance.`);
    }
    if (user.system && body.instances !== null) {
      throw new HttpError(400, `${user.username} is managed by the dashboard; its access cannot be changed.`);
    }
    const instances = validateInstanceAccess(body.instances);
    if (instances) user.instances = instances;
    else delete user.instances;
  }
  // Demoting or limiting to instances both end admin access.
  if (wasAdmin && !isAdmin(user)) assertAnotherAdminRemains(users, user.username);
  if (body.generate || body.password !== undefined) {
    const [plain, generated] = passwordFromBody(body);
    setPassword(user, plain);
    if (generated) shown = plain;
    endSessionsFor(user.username);
    // An admin resetting their own password keeps the session that made the change.
    if (user.username === req.user.username) {
      sessions.set(req.sessionToken, { username: user.username, expires: Date.now() + SESSION_MS });
    }
  }
  writeUsers(users);
  res.json({ ok: true, password: shown, user: publicUser(user) });
});

app.delete('/api/users/:username', requireAuth, requireAdmin, (req, res) => {
  if (req.params.username === req.user.username) {
    throw new HttpError(400, 'You cannot delete your own account.');
  }
  const users = readUsers();
  const user = users.find((u) => u.username === req.params.username);
  if (!user) throw new HttpError(404, 'User not found.');
  if (user.username === LOCKED_ADMIN) throw new HttpError(400, `${LOCKED_ADMIN} cannot be deleted.`);
  if (isAdmin(user)) assertAnotherAdminRemains(users, user.username);
  writeUsers(users.filter((u) => u !== user));
  endSessionsFor(user.username);
  res.json({ ok: true });
});

// ---------- Node-RED instances ----------

async function dockerInstances() {
  if (!DOCKER_API) return [];
  const res = await fetch(`${DOCKER_API}/containers/json?all=1`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`Docker API returned ${res.status}`);
  const containers = await res.json();
  const nodeReds = containers.filter((c) => {
    const label = c.Labels?.['nodered-admin.instance'];
    if (label === 'false') return false;
    // The dashboard and its update helper run an image called nodered-user-admin,
    // which the name match below would take for Node-RED. Updating the dashboard
    // from the instances list would stop it half-way through recreating itself.
    if (label !== 'true' && c.Labels?.['nodered-admin.role']) return false;
    return label === 'true' || /node-?red/i.test(c.Image);
  });
  const instances = [];
  for (const c of nodeReds) {
    // One row per published host port of Node-RED's 1880 (IPv4 and IPv6 bindings
    // collapse). A container that moved Node-RED off 1880 lists all its TCP ports.
    const published = (c.Ports || []).filter((p) => p.PublicPort && p.Type === 'tcp');
    const editor = published.filter((p) => p.PrivatePort === 1880);
    const ports = [...new Set((editor.length ? editor : published).map((p) => p.PublicPort))];
    const sharedLogins = (c.Mounts || []).some((m) => m.Destination === '/auth');
    // A shared-login container must know its own key, or per-instance access
    // (and, in Docker, mapped users at all) won't work on it.
    const instanceEnv = sharedLogins ? await containerInstanceEnv(c.Id) : null;
    const base = {
      name: (c.Names?.[0] || c.Id.slice(0, 12)).replace(/^\//, ''),
      source: 'docker',
      container: c.Id.slice(0, 12),
      image: c.Image,
      state: c.State,
      detail: c.Status,
      sharedLogins,
      instanceEnv,
    };
    const row = (port) => ({ ...base, port, keyMismatch: sharedLogins && (!instanceEnv || (port !== null && instanceEnv !== String(port))) });
    if (ports.length === 0) instances.push(row(null));
    for (const port of ports) instances.push(row(port));
  }
  return instances;
}

// NODERED_INSTANCE from the container's environment, or null when it isn't
// set or the container can't be inspected.
async function containerInstanceEnv(id) {
  try {
    const res = await fetch(`${DOCKER_API}/containers/${id}/json`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const env = (await res.json()).Config?.Env || [];
    const found = env.find((e) => e.startsWith('NODERED_INSTANCE='));
    return found ? found.slice('NODERED_INSTANCE='.length) || null : null;
  } catch {
    return null;
  }
}

function configuredInstances() {
  if (!fs.existsSync(INSTANCES_FILE)) return [];
  const list = JSON.parse(fs.readFileSync(INSTANCES_FILE, 'utf8'));
  if (!Array.isArray(list)) throw new Error(`${INSTANCES_FILE} must contain a JSON array`);
  return list
    .filter((i) => Number.isInteger(i.port))
    .map((i) => ({
      name: String(i.name || `Port ${i.port}`),
      source: 'config',
      port: i.port,
      host: typeof i.host === 'string' ? i.host : null,
      sharedLogins: typeof i.sharedLogins === 'boolean' ? i.sharedLogins : null,
    }));
}

// Every TCP port the host is listening on, from the kernel's socket tables.
// Returns port -> { localOnly } where localOnly means bound to loopback only.
// Addresses are hex in host byte order: IPv4 127.x.x.x ends in 7F, and
// IPv6 covers ::1 and IPv4-mapped ::ffff:127.x.x.x.
const isLoopback = (addr) =>
  addr.length === 8
    ? addr.endsWith('7F')
    : addr === '00000000000000000000000001000000' || /^0000000000000000FFFF0000[0-9A-F]{6}7F$/.test(addr);
function hostListeningPorts() {
  const ports = new Map();
  for (const file of [path.join(HOST_NET_DIR, 'tcp'), path.join(HOST_NET_DIR, 'tcp6')]) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4 || cols[3] !== '0A') continue; // 0A = LISTEN
      const [addr, portHex] = cols[1].split(':');
      const port = parseInt(portHex, 16);
      const entry = ports.get(port) || { localOnly: true };
      if (!isLoopback(addr)) entry.localOnly = false;
      ports.set(port, entry);
    }
  }
  return ports;
}

// The editor page always loads red/red(.min).js, even with a custom title or
// login. Matching the title instead would also catch this admin page.
// Returns { version } for a Node-RED editor page (it loads red.min.js?v=<version>), else null.
async function looksLikeNodeRed(port) {
  try {
    const res = await fetch(`http://${PROBE_HOST}:${port}/`, { signal: AbortSignal.timeout(1500), redirect: 'manual' });
    const html = (await res.text()).slice(0, 50000);
    const m = html.match(/red\/red(?:\.min)?\.js(?:\?v=([\w.-]+))?/);
    return m ? { version: m[1] || null } : null;
  } catch {
    return null;
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Node-RED ports found on the host, cached briefly because checking every
// listening port takes a moment.
let scanCache = { at: 0, found: [] };
async function scanHostForNodeRed() {
  if (!SCAN_HOST_PORTS) return [];
  if (Date.now() - scanCache.at < 15000) return scanCache.found;
  const listening = [...hostListeningPorts()].filter(([port]) => port !== PORT && port !== PUBLIC_PORT && !SCAN_SKIP_PORTS.has(port));
  const checks = await mapLimit(listening, 16, async ([port, info]) => {
    const found = await looksLikeNodeRed(port);
    return found ? { port, localOnly: info.localOnly, version: found.version } : null;
  });
  scanCache = { at: Date.now(), found: checks.filter(Boolean) };
  return scanCache.found;
}

// Asks Node-RED's /auth/login how it logs in: {"type":"credentials"} when
// adminAuth is on, {} when anyone can open the editor.
async function probe(instance) {
  if (!instance.port || (instance.state && instance.state !== 'running')) {
    return { ...instance, status: 'offline', login: 'unknown' };
  }
  try {
    const res = await fetch(`http://${instance.host || PROBE_HOST}:${instance.port}/auth/login`, {
      signal: AbortSignal.timeout(3000),
    });
    const body = await res.json().catch(() => null);
    const login = !body ? 'unknown' : body.type === 'credentials' ? 'required' : body.type ? body.type : 'open';
    return { ...instance, status: 'online', login };
  } catch {
    return { ...instance, status: 'unreachable', login: 'unknown' };
  }
}

// Merges three sources into one list, one row per port:
//   docker  - containers from the Docker API (also shows stopped ones)
//   host    - Node-RED found on a host port that no container published,
//             i.e. installed as a normal npm/systemd package
//   config  - instances.json: names for host ports, and other machines
async function listInstances() {
  const errors = [];
  const [docker, scanned, configured] = await Promise.all([
    dockerInstances().catch((e) => (errors.push(`Docker discovery failed: ${e.message}`), [])),
    scanHostForNodeRed().catch((e) => (errors.push(`Port scan failed: ${e.message}`), [])),
    Promise.resolve()
      .then(configuredInstances)
      .catch((e) => (errors.push(`Cannot read ${INSTANCES_FILE}: ${e.message}`), [])),
  ]);

  const local = configured.filter((c) => !c.host);
  const found = [...docker];
  const seen = new Set(docker.map((d) => d.port).filter(Boolean));

  for (const d of found) {
    const s = scanned.find((x) => x.port === d.port);
    if (s) Object.assign(d, { localOnly: s.localOnly, version: s.version });
  }
  for (const s of scanned) {
    if (seen.has(s.port)) continue;
    seen.add(s.port);
    const c = local.find((x) => x.port === s.port);
    found.push({
      name: c?.name || `node-red :${s.port}`,
      source: 'host',
      port: s.port,
      localOnly: s.localOnly,
      version: s.version,
      sharedLogins: c?.sharedLogins ?? null,
    });
  }
  // Configured entries not found any other way: other machines, or a host
  // port that's currently down (probe shows it as not responding).
  for (const c of configured) {
    if (!c.host && seen.has(c.port)) continue;
    found.push(c);
  }

  const instances = (await Promise.all(found.map(probe)))
    .map((i) => ({ ...i, key: instanceKey(i) }))
    .sort((a, b) => (a.port ?? Infinity) - (b.port ?? Infinity) || a.name.localeCompare(b.name));
  return { instances, errors };
}

// How users.json refers to an instance. Each Node-RED learns its own key from
// NODERED_INSTANCE (set it to the host port for containers); a host install
// falls back to its own port, which is the same number.
const instanceKey = (i) => (i.host ? `${i.host}:${i.port}` : i.port ? String(i.port) : null);

app.get('/api/instances', requireAuth, async (req, res) => {
  const { instances, errors } = await listInstances();
  res.set('Cache-Control', 'no-store');
  res.json({
    publicHost: PUBLIC_HOST,
    authHostDir: AUTH_HOST_DIR,
    canManageContainers: Boolean(docker),
    canManageHost: hostAgentEnabled(),
    instances,
    errors,
  });
});

// ---------- restart / update containers ----------

const docker = DOCKER_API ? createDocker(DOCKER_API) : null;
const busyContainers = new Set();

// Only act on containers discovery reports as Node-RED, never on an arbitrary id.
async function nodeRedContainer(id) {
  if (!docker) throw new HttpError(400, 'Docker access is not configured.');
  const { instances } = await listInstances();
  const inst = instances.find((i) => i.source === 'docker' && i.container === id);
  if (!inst) throw new HttpError(404, 'That container is not a Node-RED instance on this server.');
  if (busyContainers.has(id)) throw new HttpError(409, `${inst.name} is already being restarted or updated.`);
  // Marked here, in the same tick as the check, so two clicks can't both pass it.
  busyContainers.add(id);
  return inst;
}

async function containerAction(req, res, action) {
  const inst = await nodeRedContainer(req.params.id);
  scanCache.at = 0; // ports may move while the container restarts
  try {
    const result = await action(inst);
    console.log(`[docker] ${req.user.username}: ${result.message}`);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error(`[docker] ${req.user.username} on ${inst.name}: ${e.message}`);
    throw new HttpError(500, e.message);
  } finally {
    busyContainers.delete(inst.container);
    scanCache.at = 0;
  }
}

app.post('/api/instances/:id/restart', requireAuth, requireAdmin, (req, res) =>
  containerAction(req, res, (inst) => docker.restart(inst.container)),
);

app.post('/api/instances/:id/update', requireAuth, requireAdmin, (req, res) =>
  containerAction(req, res, (inst) => docker.update(inst.container)),
);

// Connect a Docker container to the shared accounts (edit its settings.js + recreate).
app.post('/api/instances/:id/connect', requireAuth, requireAdmin, (req, res) =>
  containerAction(req, res, (inst) => docker.connect(inst.container, { authDir: AUTH_HOST_DIR, hostPort: inst.port })),
);

// ---------- host-installed instances (via the root host agent) ----------

const busyHosts = new Set();

// Only act on a port discovery reports as a host-installed (source 'host') Node-RED.
async function hostInstance(port) {
  if (!hostAgentEnabled()) throw new HttpError(400, 'The host agent is not installed, so host instances cannot be managed from here.');
  const { instances } = await listInstances();
  const inst = instances.find((i) => i.source === 'host' && !i.host && String(i.port) === String(port));
  if (!inst) throw new HttpError(404, 'That port is not a host-installed Node-RED instance on this server.');
  if (busyHosts.has(String(port))) throw new HttpError(409, `${inst.name} is already being worked on.`);
  busyHosts.add(String(port));
  return inst;
}

async function hostAction(req, res, action, params) {
  const inst = await hostInstance(req.params.port);
  scanCache.at = 0;
  try {
    const result = await callHostAgent(action, { port: inst.port, ...params });
    console.log(`[host] ${req.user.username}: ${action} ${inst.name} (:${inst.port}): ${result.ok ? 'ok' : 'FAILED'} ${result.message || ''}`);
    if (!result.ok) throw new HttpError(500, result.message || `${action} failed.`, { steps: result.steps || [] });
    res.json({ ok: true, ...result });
  } finally {
    busyHosts.delete(String(inst.port));
    scanCache.at = 0;
  }
}

app.post('/api/hosts/:port/restart', requireAuth, requireAdmin, (req, res) => hostAction(req, res, 'restart'));
app.post('/api/hosts/:port/update', requireAuth, requireAdmin, (req, res) => hostAction(req, res, 'update'));
app.post('/api/hosts/:port/connect', requireAuth, requireAdmin, (req, res) => hostAction(req, res, 'connect', { authDir: AUTH_HOST_DIR }));

// ---------- GitHub account ----------

const githubAccount = createGithubAccount({ file: GITHUB_FILE, encrypt, decrypt, hasKey: () => Boolean(KEY) });

const asBadRequest = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (e) {
    throw e instanceof HttpError ? e : new HttpError(400, e.message);
  }
};

app.get('/api/github', requireAuth, requireAdmin, (req, res) => res.json(githubAccount.publicState()));

app.post(
  '/api/github/connect',
  requireAuth,
  requireAdmin,
  asBadRequest(async (req) => {
    const state = await githubAccount.connect(req.body?.token);
    backups.reschedule();
    console.log(`[github] ${req.user.username} connected ${state.account.login}`);
    return state;
  }),
);

app.post(
  '/api/github/disconnect',
  requireAuth,
  requireAdmin,
  asBadRequest(async (req) => {
    const state = githubAccount.disconnect();
    backups.reschedule();
    console.log(`[github] ${req.user.username} disconnected GitHub`);
    return state;
  }),
);

app.put('/api/github', requireAuth, requireAdmin, asBadRequest(async (req) => githubAccount.updateSettings(req.body || {})));

app.get('/api/github/repos', requireAuth, requireAdmin, asBadRequest(async () => githubAccount.repos()));

// ---------- dashboard updates ----------
// GitHub Actions builds the image on every push and tags it with the commit.
// An update is available once a build for a newer commit has finished.

// This process's own container id, so the update can't pick another container
// carrying the dashboard label. Docker mounts /etc/hostname etc. from
// /var/lib/docker/containers/<id>/ even with host networking.
function ownContainerId() {
  if (process.env.SELF_CONTAINER_ID) return process.env.SELF_CONTAINER_ID;
  for (const file of ['/proc/self/mountinfo', '/proc/self/cgroup']) {
    try {
      const m = fs.readFileSync(file, 'utf8').match(/\/containers\/([0-9a-f]{64})\/|docker[-/]([0-9a-f]{64})/);
      if (m) return m[1] || m[2];
    } catch {}
  }
  return null;
}

function readPendingUpdate() {
  try {
    return JSON.parse(fs.readFileSync(DASHBOARD_UPDATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function dashboardStatus() {
  const { dashboardRepo: repo, dashboardBranch: branch, connected } = githubAccount.publicState();
  const status = { revision: APP_REVISION, repo, branch, workflow: DASHBOARD_WORKFLOW, lastUpdate: readPendingUpdate() };
  if (!connected || !repo) return { ...status, configured: false };

  const runs = await github(
    githubAccount.token(),
    'GET',
    `/repos/${repo}/actions/workflows/${encodeURIComponent(DASHBOARD_WORKFLOW)}/runs?branch=${encodeURIComponent(branch)}&event=push&per_page=10`,
  );
  // null (not undefined) when there is no such build, so the field is always in the JSON.
  const describe = (r) => (r ? { sha: r.head_sha, at: r.updated_at, url: r.html_url, message: r.head_commit?.message?.split('\n')[0] || '' } : null);
  const ready = runs.workflow_runs.find((r) => r.status === 'completed' && r.conclusion === 'success');
  const latest = runs.workflow_runs[0];
  const building = latest && latest.status !== 'completed' ? latest : null;
  const failed = latest && latest.status === 'completed' && latest.conclusion !== 'success' ? latest : null;
  return {
    ...status,
    configured: true,
    canUpdate: Boolean(docker),
    image: ready ? `${REGISTRY}/${repo.toLowerCase()}:${ready.head_sha}` : null,
    latestBuild: describe(ready),
    building: describe(building),
    failedBuild: describe(failed),
    updateAvailable: Boolean(ready && ready.head_sha !== APP_REVISION),
  };
}

app.get('/api/dashboard', requireAuth, requireAdmin, asBadRequest(async () => dashboardStatus()));

// One update at a time: a second click while the pull runs would start a second helper.
let dashboardUpdating = false;

app.post(
  '/api/dashboard/update',
  requireAuth,
  requireAdmin,
  asBadRequest(async (req) => {
    if (!docker) throw new Error('Docker access is not configured, so the dashboard cannot update itself.');
    if (dashboardUpdating) throw new HttpError(409, 'An update is already in progress.');
    dashboardUpdating = true;
    try {
      const status = await dashboardStatus();
      if (!status.updateAvailable) throw new Error('There is no newer finished build to update to.');
      const self = await docker.findByRole('dashboard', ownContainerId());
      if (!self) throw new Error('Cannot find this dashboard\'s container (label nodered-admin.role=dashboard).');
      // The helper joins this container's network, so it reaches the Docker
      // proxy the same way this process does (compose network or host).
      const network = self.HostConfig?.NetworkMode || (await docker.inspect(self.Id).catch(() => ({}))).HostConfig?.NetworkMode || 'host';

      const { account } = githubAccount.publicState();
      await docker.pull(status.image, registryAuth(account.login, githubAccount.token(), REGISTRY));
      fs.writeFileSync(
        DASHBOARD_UPDATE_FILE,
        JSON.stringify({ from: APP_REVISION, to: status.latestBuild.sha, image: status.image, at: new Date().toISOString(), by: req.user.username }) + '\n',
        { mode: 0o600 },
      );
      try {
        await docker.runHelper(status.image, ['node', 'self-update.js', self.Id, status.image], [`DOCKER_API=${DOCKER_API}`], network);
      } catch (e) {
        // Nothing was swapped, so don't leave a record the next start would report as rolled back.
        fs.rmSync(DASHBOARD_UPDATE_FILE, { force: true });
        throw e;
      }
      console.log(`[dashboard] ${req.user.username} started update ${APP_REVISION} -> ${status.latestBuild.sha}`);
      return { ok: true, message: 'Updating. The dashboard restarts in a few seconds and this page reloads.', to: status.latestBuild.sha };
    } finally {
      dashboardUpdating = false;
    }
  }),
);

// ---------- GitHub backups ----------

const backups = createBackups({
  file: BACKUP_FILE,
  encrypt,
  decrypt,
  hasKey: () => Boolean(KEY),
  getToken: () => githubAccount.token(),
  isConnected: () => githubAccount.publicState().connected,
  listInstances,
  probeHost: PROBE_HOST,
  publicHost: PUBLIC_HOST,
  systemLogin: { username: BACKUP_USER, ensure: ensureBackupAccount },
});

app.get('/api/backup', requireAuth, requireAdmin, (req, res) => {
  res.json(backups.publicState());
});

app.put('/api/backup', requireAuth, requireAdmin, (req, res) => {
  try {
    res.json(backups.update(req.body || {}));
  } catch (e) {
    throw new HttpError(400, e.message);
  }
});

app.post('/api/backup/test', requireAuth, requireAdmin, async (req, res) => {
  try {
    res.json(await backups.test());
  } catch (e) {
    throw new HttpError(400, e.message);
  }
});

app.post('/api/backup/run', requireAuth, requireAdmin, async (req, res) => {
  try {
    res.json(await backups.run(`manual (${req.user.username})`));
  } catch (e) {
    throw new HttpError(409, e.message);
  }
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// ---------- static React build ----------

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
app.use(express.static(dist));
app.get('/{*splat}', (req, res) => res.sendFile(path.join(dist, 'index.html')));

app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
  // Client errors from express itself (bad JSON, body too large, missing file).
  if (err.expose && err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: `Server error: ${err.message}` });
});

// Drop expired sessions and lockouts once an hour.
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.expires < now) sessions.delete(t);
  for (const [ip, f] of failures) if (f.until && f.until < now) failures.delete(ip);
}, 60 * 60 * 1000).unref();

// Make sure the locked admin exists with full access, creating the users file
// if this is a fresh install. An existing account's password is never touched.
function ensureLockedAdmin() {
  let users;
  try {
    users = readUsers();
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    users = [];
  }
  const existing = users.find((u) => u.username === LOCKED_ADMIN);
  if (existing) {
    if (existing.permissions !== '*' || existing.instances) {
      existing.permissions = '*';
      delete existing.instances;
      writeUsers(users);
      console.log(`Restored full access for ${LOCKED_ADMIN}`);
    }
  } else {
    let plain = DEFAULT_ADMIN_PASSWORD;
    if (!plain) {
      // No password chosen: make one and leave it where only the server's
      // admin can read it. It is never logged.
      plain = generatePassword();
      fs.writeFileSync(INITIAL_PASSWORD_FILE, plain + '\n', { mode: 0o600 });
      fs.chmodSync(INITIAL_PASSWORD_FILE, 0o600);
      console.log(`Initial administrator password written to ${INITIAL_PASSWORD_FILE}`);
    }
    const user = { username: LOCKED_ADMIN, permissions: '*' };
    setPassword(user, plain);
    users.unshift(user);
    writeUsers(users);
    console.log(`Created default account ${LOCKED_ADMIN}`);
  }
  return users.length;
}

try {
  console.log(`Using ${USERS_FILE} (${ensureLockedAdmin()} users)`);
} catch (e) {
  console.error(`WARNING: cannot read ${USERS_FILE}: ${e.message}`);
}
// Keep the shared login module next to users.json current, so every Node-RED
// that requires it picks up the latest rules on its next restart.
try {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), 'nodered', 'adminAuth.js');
  const dest = path.join(path.dirname(USERS_FILE), 'adminAuth.js');
  const content = fs.readFileSync(src, 'utf8');
  const current = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
  // Someone else's adminAuth.js may be what running instances log in with.
  // Ours say where their source is: "(nodered/adminAuth.js)".
  if (current !== null && !current.includes('(nodered/adminAuth.js)')) {
    console.error(`WARNING: ${dest} was not written by this dashboard, so it was left as it is. Move it away to let the dashboard install its own.`);
  } else if (current !== content) {
    fs.writeFileSync(`${dest}.tmp`, content, { mode: 0o644 });
    fs.renameSync(`${dest}.tmp`, dest);
    console.log(`Updated ${dest}`);
  }
} catch (e) {
  console.error(`WARNING: cannot install adminAuth.js next to ${USERS_FILE}: ${e.message}`);
}
// Node-RED runs as another user, so a users.json only its owner can read (a
// 0600 file from an older dashboard, or one created by hand) refuses every login.
try {
  const mode = fs.statSync(USERS_FILE).mode & 0o777;
  if ((mode & 0o044) === 0) {
    console.error(`WARNING: ${USERS_FILE} is mode ${mode.toString(8)}; Node-RED cannot read it. Run: chmod 644 ${USERS_FILE}`);
  }
} catch {}

// Finish the record of an update that restarted this dashboard: either this
// is the new revision, or the helper rolled back and we're still the old one.
// The helper checks the new container is still running 5 seconds after start
// and rolls back if not, so the new revision waits longer than that before
// calling it 'ok'; otherwise a crash in those seconds would leave 'ok' behind.
const UPDATE_CONFIRM_MS = Number(process.env.DASHBOARD_UPDATE_CONFIRM_MS || 10000);
function finishPendingUpdate() {
  const pending = readPendingUpdate();
  if (!pending || pending.result) return;
  pending.result = APP_REVISION === pending.to ? 'ok' : 'rolled back';
  pending.finishedAt = new Date().toISOString();
  try {
    fs.writeFileSync(DASHBOARD_UPDATE_FILE, JSON.stringify(pending) + '\n', { mode: 0o600 });
  } catch {}
  console.log(`[dashboard] update to ${pending.to}: ${pending.result}`);
}
const pendingUpdate = readPendingUpdate();
if (pendingUpdate && !pendingUpdate.result) {
  if (APP_REVISION === pendingUpdate.to) setTimeout(finishPendingUpdate, UPDATE_CONFIRM_MS).unref();
  else finishPendingUpdate();
}

backups.start();
app.listen(PORT, () => console.log(`Node-RED user admin listening on :${PORT}`));
