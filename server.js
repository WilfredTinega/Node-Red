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
import { createDocker } from './docker.js';

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
// Used only when LOCKED_ADMIN doesn't exist yet (e.g. a fresh install).
const DEFAULT_ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || 'oponde9422';

// ---------- instance discovery settings ----------
// DOCKER_API: a read-only Docker socket proxy; blank disables container discovery.
const DOCKER_API = (process.env.DOCKER_API || '').replace(/\/$/, '');
// Where this process reaches the host's ports. With network_mode: host that is 127.0.0.1.
const PROBE_HOST = process.env.PROBE_HOST || '127.0.0.1';
// Find Node-RED installed as a plain package by checking every port the host
// listens on. Needs network_mode: host, so /proc/net/tcp is the host's list.
const SCAN_HOST_PORTS = process.env.SCAN_HOST_PORTS !== '0';
// Optional names for scanned ports, and instances on other machines.
const INSTANCES_FILE = process.env.INSTANCES_FILE || '/config/instances.json';
// Address shown on the page; blank means "the address you opened this page with".
const PUBLIC_HOST = process.env.PUBLIC_HOST || '';
// Backup settings and history; lives next to the key because it holds the encrypted token.
const BACKUP_FILE = process.env.BACKUP_FILE || '/secrets/backup.json';

const sessions = new Map(); // token -> { username, expires }
const failures = new Map(); // ip -> { count, until }

// ---------- users file ----------

function readUsers() {
  const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  if (!Array.isArray(users)) throw new Error(`${USERS_FILE} must contain a JSON array`);
  return users;
}

// Write to a temp file and rename, so Node-RED never reads a half-written file.
function writeUsers(users) {
  const tmp = `${USERS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, USERS_FILE);
}

const isAdmin = (u) =>
  u.permissions === '*' || (Array.isArray(u.permissions) && u.permissions.includes('*'));

// Written as $2a$ (same algorithm as $2b$), which every Node-RED version accepts.
const hash = (password) => bcrypt.hashSync(password, 10).replace(/^\$2b\$/, '$2a$');

// Node-RED's bcrypt accepts $2a$/$2b$; PHP-style $2y$ hashes are rewritten on read.
const checkPassword = (password, stored) =>
  typeof stored === 'string' && bcrypt.compareSync(password, stored.replace(/^\$2y\$/, '$2a$'));

const generatePassword = () => crypto.randomBytes(12).toString('base64url');

// ---------- viewable passwords ----------
// Node-RED only ever checks `password` (bcrypt). `secret` is an AES-256-GCM
// copy of the same password so admins can view it later; Node-RED ignores it.

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

// The one place a password is set, so the hash and the viewable copy never drift apart.
function setPassword(user, plain) {
  user.password = hash(plain);
  if (KEY) user.secret = encrypt(plain);
  else delete user.secret;
}

function publicUser(u) {
  return {
    username: u.username,
    permissions: u.permissions,
    admin: isAdmin(u),
    locked: u.username === LOCKED_ADMIN,
    viewable: Boolean(KEY && u.secret),
    // null = same access on every instance; otherwise { instanceKey: '*' | 'read' }
    instances: u.instances || null,
  };
}

// ---------- errors ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
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
  if (f && f.until > Date.now()) {
    throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
  }
  const { username, password } = req.body || {};
  const user =
    typeof username === 'string' && readUsers().find((u) => u.username === username.trim());
  if (!user || typeof password !== 'string' || !checkPassword(password, user.password)) {
    const lockExpired = f && f.until && f.until <= Date.now();
    const count = (lockExpired ? 0 : f?.count || 0) + 1;
    failures.set(ip, { count, until: count >= MAX_FAILURES ? Date.now() + LOCKOUT_MS : 0 });
    throw new HttpError(401, 'Wrong username or password.');
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

app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
  res.json(readUsers().map(publicUser));
});

app.get('/api/users/:username/password', requireAuth, requireAdmin, (req, res) => {
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
  if (body.permissions !== undefined) {
    validatePermissions(body.permissions);
    if (user.username === LOCKED_ADMIN && body.permissions !== '*') {
      throw new HttpError(400, `${LOCKED_ADMIN} always has full access.`);
    }
    if (isAdmin(user) && body.permissions !== '*') assertAnotherAdminRemains(users, user.username);
    user.permissions = body.permissions;
  }
  if (body.instances !== undefined) {
    if (user.username === LOCKED_ADMIN && body.instances !== null) {
      throw new HttpError(400, `${LOCKED_ADMIN} always has full access on every instance.`);
    }
    const instances = validateInstanceAccess(body.instances);
    if (instances) user.instances = instances;
    else delete user.instances;
  }
  if (body.generate || body.password !== undefined) {
    const [plain, generated] = passwordFromBody(body);
    setPassword(user, plain);
    if (generated) shown = plain;
    if (user.username !== req.user.username) endSessionsFor(user.username);
  }
  writeUsers(users);
  res.json({ ok: true, password: shown });
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
  const instances = [];
  for (const c of containers) {
    const labelled = c.Labels?.['nodered-admin.instance'] === 'true';
    if (!labelled && !/node-?red/i.test(c.Image)) continue;
    // One row per published host port of Node-RED's 1880 (IPv4 and IPv6 bindings
    // collapse). A container that moved Node-RED off 1880 lists all its TCP ports.
    const published = (c.Ports || []).filter((p) => p.PublicPort && p.Type === 'tcp');
    const editor = published.filter((p) => p.PrivatePort === 1880);
    const ports = [...new Set((editor.length ? editor : published).map((p) => p.PublicPort))];
    const base = {
      name: (c.Names?.[0] || c.Id.slice(0, 12)).replace(/^\//, ''),
      source: 'docker',
      container: c.Id.slice(0, 12),
      image: c.Image,
      state: c.State,
      detail: c.Status,
      sharedLogins: (c.Mounts || []).some((m) => m.Destination === '/auth'),
    };
    if (ports.length === 0) instances.push({ ...base, port: null });
    for (const port of ports) instances.push({ ...base, port });
  }
  return instances;
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
const LOOPBACK = new Set(['0100007F', '00000000000000000000000001000000']);
function hostListeningPorts() {
  const ports = new Map();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
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
      if (!LOOPBACK.has(addr)) entry.localOnly = false;
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
  const listening = [...hostListeningPorts()].filter(([port]) => port !== PORT);
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
  res.json({ publicHost: PUBLIC_HOST, canManageContainers: Boolean(docker), instances, errors });
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
  return inst;
}

async function containerAction(req, res, action) {
  const inst = await nodeRedContainer(req.params.id);
  busyContainers.add(inst.container);
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

// ---------- GitHub backups ----------

const backups = createBackups({
  file: BACKUP_FILE,
  encrypt,
  decrypt,
  hasKey: () => Boolean(KEY),
  listInstances,
  probeHost: PROBE_HOST,
  // The locked admin has full access everywhere, so it can read every instance.
  defaultCredentials: () => {
    const u = readUsers().find((x) => x.username === LOCKED_ADMIN);
    return KEY && u?.secret ? { username: u.username, password: decrypt(u.secret) } : null;
  },
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
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
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
    const user = { username: LOCKED_ADMIN, permissions: '*' };
    setPassword(user, DEFAULT_ADMIN_PASSWORD);
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
  if (!fs.existsSync(dest) || fs.readFileSync(dest, 'utf8') !== content) {
    fs.writeFileSync(`${dest}.tmp`, content, { mode: 0o644 });
    fs.renameSync(`${dest}.tmp`, dest);
    console.log(`Updated ${dest}`);
  }
} catch (e) {
  console.error(`WARNING: cannot install adminAuth.js next to ${USERS_FILE}: ${e.message}`);
}

backups.start();
app.listen(PORT, () => console.log(`Node-RED user admin listening on :${PORT}`));
