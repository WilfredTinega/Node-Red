#!/usr/bin/env node
// Node-RED admin host agent.
//
// A small root daemon you install on the server. The dashboard (unprivileged)
// connects to a local unix socket and asks for exactly three things on a
// host-installed Node-RED: restart it, update it, or connect it to the shared
// accounts. The agent detects how that Node-RED is run and does only that.
//
// It NEVER touches flows.json, flows_cred.json or .config.*.json. `connect`
// edits settings.js only, after copying it to settings.js.bak-<timestamp>.
//
// Why a separate agent: the dashboard container stays unprivileged. This file
// is the only thing that runs as root, its API is fixed to these actions, and
// the socket is root-only (0600). Read it before you install it.
//
// Protocol: newline-delimited JSON over the unix socket. Request
//   {"action":"restart|update|connect","port":1880,"authDir":"/opt/nodered-auth","token":"<shared secret>"}
// Response
//   {"ok":true,"message":"...","steps":[{"name":"...","ok":true,"detail":"..."}]}
'use strict';
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SOCKET = process.env.HOST_AGENT_SOCKET || '/run/nodered-admin.sock';
// The dashboard runs as this uid; the socket is handed to it (0600) so only it
// and root can use the agent. Matches the Dockerfile's ARG UID.
const DASHBOARD_UID = Number(process.env.DASHBOARD_UID || 10001);
// Optional shared secret: if HOST_AGENT_TOKEN is set, requests must match it.
const TOKEN = process.env.HOST_AGENT_TOKEN || '';
const CONNECT_TIMEOUT_MS = 45000;

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 60000, ...opts }).trim();
const trySh = (cmd, args, opts) => {
  try {
    return { ok: true, out: sh(cmd, args, opts) };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || '') || e.message };
  }
};
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);

// ---- find the Node-RED process listening on <port> and how it is managed ----

function pidOnPort(port) {
  // List every listening TCP socket with its owning pid, then match the port.
  // (Passing ss a "sport = :N" filter as one argv entry doesn't parse.)
  const out = trySh('ss', ['-Hltnp']).out;
  for (const line of out.split('\n')) {
    const local = line.trim().split(/\s+/)[3] || ''; // e.g. 0.0.0.0:1880, [::]:1880, 127.0.0.1:1880
    if (local.endsWith(`:${port}`)) {
      const m = line.match(/pid=(\d+)/);
      if (m) return Number(m[1]);
    }
  }
  // Fallback if ss is unavailable or ran without pids.
  const l = trySh('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  if (l.ok && l.out) return Number(l.out.split('\n')[0]);
  return null;
}

function procInfo(pid) {
  const read = (f) => {
    try {
      return fs.readFileSync(`/proc/${pid}/${f}`, 'utf8');
    } catch {
      return '';
    }
  };
  const env = {};
  for (const kv of read('environ').split('\0')) {
    const i = kv.indexOf('=');
    if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  const status = read('status');
  const uidLine = status.match(/^Uid:\s+(\d+)/m);
  const uid = uidLine ? Number(uidLine[1]) : 0;
  let user = String(uid);
  try {
    user = os.userInfo({ uid }).username;
  } catch {}
  return {
    uid,
    user,
    cwd: (() => {
      try {
        return fs.readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        return env.HOME ? path.join(env.HOME, '.node-red') : process.cwd();
      }
    })(),
    exe: (() => {
      try {
        return fs.readlinkSync(`/proc/${pid}/exe`);
      } catch {
        return 'node';
      }
    })(),
    cmdline: read('cmdline').split('\0').filter(Boolean),
    cgroup: read('cgroup'),
    env,
  };
}

// The Node-RED user directory: --userDir flag, else $HOME/.node-red, else cwd.
function userDir(info) {
  const args = info.cmdline;
  const i = args.findIndex((a) => a === '--userDir' || a === '-u');
  if (i >= 0 && args[i + 1]) return args[i + 1];
  const eq = args.find((a) => a.startsWith('--userDir='));
  if (eq) return eq.slice('--userDir='.length);
  if (info.env.HOME) return path.join(info.env.HOME, '.node-red');
  return info.cwd;
}

// How to restart: returns { kind, run() }.
function restarter(pid, info) {
  const sys = info.cgroup.match(/\d+:[^:]*:\/system\.slice\/(?:.*\/)?([^/]+)\.service/);
  const usr = info.cgroup.match(/\/user\.slice\/user-(\d+)\.slice\/user@\d+\.service\/(?:.*\/)?([^/]+)\.service/);
  const isPm2 = info.cmdline.join(' ').includes('PM2') || (info.env.pm_id !== undefined);

  if (sys && sys[1] !== 'user@') {
    const unit = sys[1];
    return { kind: `systemd unit ${unit}`, run: () => sh('systemctl', ['restart', unit]) };
  }
  if (usr) {
    const [, uid, unit] = usr;
    return {
      kind: `user systemd unit ${unit} (${info.user})`,
      run: () => sh('su', ['-', info.user, '-c', `XDG_RUNTIME_DIR=/run/user/${uid} systemctl --user restart ${unit}`]),
    };
  }
  if (isPm2) {
    const name = info.env.name || info.env.pm_id || 'node-red';
    return { kind: `pm2 (${info.user})`, run: () => sh('su', ['-', info.user, '-c', `pm2 restart ${name}`]) };
  }
  // Bare process: stop it and relaunch detached as the same user.
  return {
    kind: 'background process (no service manager)',
    run: () => {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
      const cmd = info.cmdline.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
      const log = path.join(userDir(info), 'node-red.log');
      sh('su', ['-s', '/bin/sh', info.user, '-c', `cd '${info.cwd}' && setsid nohup ${cmd} >> '${log}' 2>&1 &`]);
    },
  };
}

async function waitOnline(port) {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/auth/login`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

// ---- the three actions ----

function locate(port) {
  const pid = pidOnPort(port);
  if (!pid) throw new Error(`no process is listening on port ${port}`);
  const info = procInfo(pid);
  if (!/node/.test(info.exe) && !info.cmdline.join(' ').includes('node-red')) {
    throw new Error(`the process on port ${port} does not look like Node-RED`);
  }
  return { pid, info };
}

async function doRestart(port) {
  const steps = [];
  const { pid, info } = locate(port);
  const r = restarter(pid, info);
  const res = trySh; // for detail capture
  try {
    r.run();
    steps.push({ name: 'restart', ok: true, detail: r.kind });
  } catch (e) {
    steps.push({ name: 'restart', ok: false, detail: `${r.kind}: ${e.message}` });
    return { ok: false, message: `Could not restart Node-RED on ${port}.`, steps };
  }
  void res;
  const online = await waitOnline(port);
  steps.push({ name: 'verify', ok: online, detail: online ? 'answered on /auth/login' : 'did not answer within 45s' });
  return { ok: online, message: online ? `Restarted Node-RED on ${port}.` : `Restarted, but ${port} did not come back in time.`, steps };
}

function npmGlobalPrefix(info) {
  const nodeDir = path.dirname(info.exe);
  // <nodedir>/../lib/node_modules is the usual global root for a nvm/system node.
  return path.resolve(nodeDir, '..', 'lib', 'node_modules');
}

function noderedVersion(info) {
  try {
    const pkg = path.join(npmGlobalPrefix(info), 'node-red', 'package.json');
    return JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
  } catch {
    return null;
  }
}

async function doUpdate(port) {
  const steps = [];
  const { pid, info } = locate(port);
  const before = noderedVersion(info);
  const npm = path.join(path.dirname(info.exe), 'npm');
  const prefixOwnerUid = (() => {
    try {
      return fs.statSync(npmGlobalPrefix(info)).uid;
    } catch {
      return 0;
    }
  })();
  const runNpm =
    prefixOwnerUid === 0
      ? () => sh(npm, ['install', '-g', 'node-red@latest'], { timeout: 300000 })
      : () => sh('su', ['-s', '/bin/sh', String(prefixOwnerUid === info.uid ? info.user : os.userInfo({ uid: prefixOwnerUid }).username), '-c', `'${npm}' install -g node-red@latest`], { timeout: 300000 });
  try {
    runNpm();
    const after = noderedVersion(info);
    steps.push({ name: 'update', ok: true, detail: before && after ? `${before} → ${after}` : `installed node-red@latest${after ? ` (${after})` : ''}` });
  } catch (e) {
    steps.push({ name: 'update', ok: false, detail: e.message });
    return { ok: false, message: `Update failed on ${port}.`, steps };
  }
  const r = await doRestart(port);
  return { ok: r.ok, message: r.ok ? `Updated and restarted Node-RED on ${port}.` : r.message, steps: [...steps, ...r.steps] };
}

const BLOCK_START = '// >>> nodered-user-admin: shared accounts (managed by the dashboard; do not edit)';
const BLOCK_END = '// <<< nodered-user-admin';

async function doConnect(port, authDir) {
  if (!authDir) throw new Error('authDir is required');
  const steps = [];
  const { pid, info } = locate(port);
  const dir = userDir(info);
  const settings = path.join(dir, 'settings.js');
  if (!fs.existsSync(settings)) throw new Error(`settings.js not found at ${settings}`);

  const backup = `${settings}.bak-${stamp()}`;
  fs.copyFileSync(settings, backup);
  steps.push({ name: 'backup settings.js', ok: true, detail: backup });

  let text = fs.readFileSync(settings, 'utf8');
  const start = text.indexOf(BLOCK_START);
  if (start >= 0) {
    const end = text.indexOf(BLOCK_END, start);
    text = text.slice(0, start) + text.slice(end >= 0 ? end + BLOCK_END.length : text.length);
    text = text.replace(/\n{3,}$/, '\n');
  }
  const block =
    `\n${BLOCK_START}\n` +
    `process.env.NODERED_INSTANCE = process.env.NODERED_INSTANCE || '${port}';\n` +
    `module.exports.adminAuth = require(${JSON.stringify(path.join(authDir, 'adminAuth.js'))});\n` +
    `${BLOCK_END}\n`;
  fs.writeFileSync(`${settings}.tmp`, text.replace(/\s*$/, '\n') + block);
  // Keep the file's owner and mode.
  const st = fs.statSync(settings);
  fs.chownSync(`${settings}.tmp`, st.uid, st.gid);
  fs.chmodSync(`${settings}.tmp`, st.mode & 0o777);
  fs.renameSync(`${settings}.tmp`, settings);
  steps.push({ name: 'edit settings.js', ok: true, detail: 'adminAuth points at the shared accounts; NODERED_INSTANCE set' });

  const r = await doRestart(port);
  return {
    ok: r.ok,
    message: r.ok ? `Connected Node-RED on ${port} to the shared accounts.` : `settings.js updated, but the restart did not verify. Backup: ${backup}`,
    steps: [...steps, ...r.steps],
  };
}

async function handle(req) {
  if (TOKEN && req.token !== TOKEN) throw new Error('unauthorized');
  const port = Number(req.port);
  if (!(port > 0 && port < 65536)) throw new Error('a valid port is required');
  if (req.action === 'restart') return doRestart(port);
  if (req.action === 'update') return doUpdate(port);
  if (req.action === 'connect') return doConnect(port, req.authDir);
  throw new Error(`unknown action ${req.action}`);
}

// ---- socket server ----

try {
  if (fs.existsSync(SOCKET)) fs.unlinkSync(SOCKET);
} catch {}

const server = net.createServer((sock) => {
  let buf = '';
  sock.on('data', (d) => {
    buf += d;
    const nl = buf.indexOf('\n');
    if (nl < 0) return;
    const line = buf.slice(0, nl);
    buf = '';
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      sock.end(JSON.stringify({ ok: false, message: 'bad request' }) + '\n');
      return;
    }
    handle(req)
      .then((r) => sock.end(JSON.stringify(r) + '\n'))
      .catch((e) => sock.end(JSON.stringify({ ok: false, message: e.message, steps: [] }) + '\n'));
  });
});

server.listen(SOCKET, () => {
  // Give the socket to the dashboard's uid, 0600: only it and root can connect.
  fs.chmodSync(SOCKET, 0o600);
  try {
    fs.chownSync(SOCKET, DASHBOARD_UID, DASHBOARD_UID);
  } catch (e) {
    console.error(`could not chown ${SOCKET} to ${DASHBOARD_UID}: ${e.message}`);
  }
  console.log(`nodered-admin host agent listening on ${SOCKET} (owner uid ${DASHBOARD_UID})`);
});
