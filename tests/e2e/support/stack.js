// One complete, isolated copy of the dashboard for a test: fresh data files in
// a temp folder, fake Node-RED instances, a fake GitHub and a fake Docker API,
// and server.js running against all of them.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTAINERS, deadPort, dockerMock, fakeNodeRed, githubMock } from './mocks.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRATCH = '/tmp/claude-1000/-home-tinega-my-bench/e57509ac-35ba-4220-a0d9-7f4270c311fd/scratchpad/e2e';
const TMP = process.env.E2E_TMP || (fs.existsSync(path.dirname(SCRATCH)) ? SCRATCH : path.join(os.tmpdir(), 'nrua-e2e'));

export const ADMIN = { username: 'administrator', password: 'oponde9422' };
export const AUTH_HOST_DIR = '/srv/nodered-auth-e2e';
// The app under test only ever listens in 18980-18999.
export const APP_PORT_BASE = 18980;

export async function startStack({ port, name = 'test' }) {
  fs.mkdirSync(TMP, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP, `${name.replace(/[^\w-]+/g, '-').slice(0, 40)}-`));
  const nr = {
    main: await fakeNodeRed({ version: '4.0.9', login: true, nodes: 3 }),
    open: await fakeNodeRed({ version: '3.1.0', login: false, nodes: 2 }),
    pkg: await fakeNodeRed({ version: '4.1.0', login: true, nodes: 5 }),
  };
  const gonePort = await deadPort();
  const gh = await githubMock();
  const docker = await dockerMock({ mainPort: nr.main.port, openPort: nr.open.port });

  const files = {
    users: path.join(dir, 'users.json'),
    key: path.join(dir, 'password.key'),
    backup: path.join(dir, 'backup.json'),
    github: path.join(dir, 'github.json'),
    dashboardUpdate: path.join(dir, 'dashboard-update.json'),
    instances: path.join(dir, 'instances.json'),
    settings: path.join(dir, 'settings.json'),
    initialPassword: path.join(dir, 'initial-admin-password'),
    hostNet: path.join(dir, 'host-net'),
  };
  // Viewable passwords on, so the Users page's Show / Copy / Hide can be tested.
  fs.writeFileSync(files.settings, JSON.stringify({ viewablePasswords: true }));
  fs.mkdirSync(files.hostNet);
  fs.writeFileSync(
    files.instances,
    JSON.stringify([
      { name: 'Package NR', port: nr.pkg.port, sharedLogins: false },
      { name: 'Gone NR', port: gonePort },
    ]),
  );

  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TZ: process.env.TZ || 'UTC',
    PORT: String(port),
    USERS_FILE: files.users,
    SECRET_KEY_FILE: files.key,
    BACKUP_FILE: files.backup,
    GITHUB_FILE: files.github,
    DASHBOARD_UPDATE_FILE: files.dashboardUpdate,
    INSTANCES_FILE: files.instances,
    SETTINGS_FILE: files.settings,
    INITIAL_PASSWORD_FILE: files.initialPassword,
    DEFAULT_ADMIN_PASSWORD: ADMIN.password,
    // The scan is off; an empty folder in case it is ever switched on.
    HOST_NET_DIR: files.hostNet,
    SELF_CONTAINER_ID: CONTAINERS.dashboard,
    DASHBOARD_UPDATE_CONFIRM_MS: '1000',
    SCAN_HOST_PORTS: '0',
    PROBE_HOST: '127.0.0.1',
    GITHUB_API: gh.url,
    DOCKER_API: docker.url,
    AUTH_HOST_DIR,
  };
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const exited = new Promise((r) => child.once('exit', r));

  const started = Date.now();
  while (!log.includes(`listening on :${port}`)) {
    if (child.exitCode !== null) throw new Error(`server.js exited (${child.exitCode}):\n${log}`);
    if (Date.now() - started > 15000) {
      child.kill('SIGKILL');
      throw new Error(`server.js did not start on :${port}:\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }

  const url = `http://127.0.0.1:${port}`;

  // A logged-in API client, for setting things up and checking the server side.
  async function client(username = ADMIN.username, password = ADMIN.password) {
    const res = await fetch(`${url}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error(`login as ${username} failed: ${res.status}`);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    return async (method, p, body) => {
      const r = await fetch(`${url}${p}`, {
        method,
        headers: { Cookie: cookie, 'X-Requested-With': 'fetch', ...(body !== undefined && { 'Content-Type': 'application/json' }) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
  }

  const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

  async function stop() {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      const t = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(t);
    }
    await Promise.all([nr.main.close(), nr.open.close(), nr.pkg.close(), gh.close(), docker.close()]);
  }

  return { url, port, dir, files, nr, gonePort, gh, docker, client, readJson, stop, log: () => log };
}
