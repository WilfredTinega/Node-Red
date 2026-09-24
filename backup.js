// Scheduled backups of every Node-RED instance's flows to a private GitHub repo.
// Each run creates one new branch named by date and time, holding one folder
// per instance. Uses GitHub's REST API, so no git binary is needed.
import fs from 'node:fs';
import { github, normalizeRepo, REPO_RE } from './github.js';

const HISTORY_SIZE = 30;
const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12];

export const DEFAULT_SETTINGS = {
  repo: '',
  branchPrefix: 'backup/',
  schedule: { mode: 'daily', time: '00:00', everyHours: 6, weekday: 0 },
  loginUser: '',
  loginSecret: null,
  systemLoginSecret: null,
  history: [],
};

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
// Git refs can't contain ':' so the time uses '-'.
const branchStamp = (d) => `${localDate(d)}_${localTime(d).replaceAll(':', '-')}`;
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'instance';

// Next run strictly after `from`, in the server's local time (TZ).
export function nextRun(schedule, from = new Date()) {
  if (!schedule || schedule.mode === 'off') return null;
  const [h, m] = (schedule.time || '00:00').split(':').map(Number);
  const at = (base, days, hours, minutes) => {
    const d = new Date(base);
    d.setDate(d.getDate() + days);
    d.setHours(hours, minutes, 0, 0);
    return d;
  };
  if (schedule.mode === 'hours') {
    // Every N hours counted from midnight: N=6 runs at 00:00, 06:00, 12:00, 18:00.
    // A hand-edited file with 0 or junk here would otherwise loop forever.
    const every = HOUR_STEPS.includes(Number(schedule.everyHours)) ? Number(schedule.everyHours) : 6;
    for (let day = 0; day <= 1; day++) {
      for (let hour = 0; hour < 24; hour += every) {
        const t = at(from, day, hour, 0);
        if (t > from) return t;
      }
    }
  }
  if (schedule.mode === 'daily') {
    const t = at(from, 0, h, m);
    return t > from ? t : at(from, 1, h, m);
  }
  if (schedule.mode === 'weekly') {
    const days = (schedule.weekday - from.getDay() + 7) % 7;
    const t = at(from, days, h, m);
    return t > from ? t : at(from, days + 7, h, m);
  }
  return null;
}

export function validateSettings(input, current) {
  const out = { ...current };
  if (input.repo !== undefined) {
    const repo = normalizeRepo(input.repo);
    if (repo && !REPO_RE.test(repo)) throw new Error('Repository must look like owner/name.');
    out.repo = repo;
  }
  if (input.branchPrefix !== undefined) {
    const p = String(input.branchPrefix).trim();
    if (!/^[A-Za-z0-9._/-]*$/.test(p) || p.includes('..') || p.startsWith('/') || p.includes('//')) {
      throw new Error('Branch prefix may only use letters, numbers, . _ - and /.');
    }
    out.branchPrefix = p;
  }
  if (input.schedule !== undefined) {
    const s = { ...current.schedule, ...input.schedule };
    if (!['off', 'daily', 'hours', 'weekly'].includes(s.mode)) throw new Error('Unknown frequency.');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) throw new Error('Time must be HH:MM (24-hour).');
    s.everyHours = Number(s.everyHours);
    if (!HOUR_STEPS.includes(s.everyHours)) throw new Error(`Hours must be one of ${HOUR_STEPS.join(', ')}.`);
    s.weekday = Number(s.weekday);
    if (!(s.weekday >= 0 && s.weekday <= 6)) throw new Error('Unknown weekday.');
    out.schedule = { mode: s.mode, time: s.time, everyHours: s.everyHours, weekday: s.weekday };
  }
  if (input.loginUser !== undefined) out.loginUser = String(input.loginUser).trim();
  return out;
}

// Checks the token can push to the repo and that the repo is private.
export async function checkRepo(token, repo) {
  const info = await github(token, 'GET', `/repos/${repo}`);
  if (!info.private) throw new Error(`${repo} is public. Flows can contain secrets, so backups only go to a private repository.`);
  if (info.permissions && !info.permissions.push) throw new Error(`The token cannot write to ${repo}.`);
  return { defaultBranch: info.default_branch, htmlUrl: info.html_url };
}

// Logs in to one Node-RED (when it needs a login) and returns its flows.
async function fetchFlows(baseUrl, login, credentials) {
  const headers = { 'Node-RED-API-Version': 'v2' };
  let token = null;
  if (login === 'required') {
    if (!credentials) throw new Error('needs a login, but no backup login is available');
    const res = await fetch(`${baseUrl}/auth/token`, {
      method: 'POST',
      body: new URLSearchParams({
        client_id: 'node-red-admin',
        grant_type: 'password',
        scope: 'read',
        username: credentials.username,
        password: credentials.password,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`login as ${credentials.username} was refused (${res.status})`);
    token = (await res.json()).access_token;
    headers.Authorization = `Bearer ${token}`;
  }
  try {
    const res = await fetch(`${baseUrl}/flows`, { headers, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`GET /flows returned ${res.status}`);
    const body = await res.json();
    return Array.isArray(body) ? { flows: body, rev: null } : { flows: body.flows, rev: body.rev };
  } finally {
    if (token) {
      // Revoke the short-lived token instead of leaving it valid for 7 days.
      fetch(`${baseUrl}/auth/revoke`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }
  }
}

// Returns the commit to branch from. An empty repo gets a README first,
// because GitHub's Git Data API refuses to work on a repo with no commits.
async function baseCommit(token, repo, defaultBranch) {
  try {
    const ref = await github(token, 'GET', `/repos/${repo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`);
    return ref.object.sha;
  } catch (e) {
    if (e.status !== 409 && e.status !== 404) throw e;
    const readme = '# Node-RED backups\n\nEach branch is one backup, named by the date and time it ran.\n';
    const created = await github(token, 'PUT', `/repos/${repo}/contents/README.md`, {
      message: 'Start Node-RED backups',
      content: Buffer.from(readme).toString('base64'),
    });
    return created.commit.sha;
  }
}

// systemLogin: { username, ensure(storedSecret) -> { password, secret } } is the
// dashboard-managed read-only account used when no login is set here. Its
// encrypted password lives in this file only (systemLoginSecret), never on the user.
export function createBackups({ file, encrypt, decrypt, hasKey, getToken, isConnected, listInstances, probeHost, systemLogin }) {
  let running = false;
  let nextRunAt = null;

  function load() {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { ...DEFAULT_SETTINGS, ...saved, schedule: { ...DEFAULT_SETTINGS.schedule, ...saved.schedule } };
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`backups: cannot read ${file}: ${e.message}`);
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  function save(settings) {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }

  const reschedule = (settings = load()) => {
    nextRunAt = settings.repo && isConnected() ? nextRun(settings.schedule) : null;
  };

  function credentialsFor(settings) {
    if (settings.loginUser && settings.loginSecret) {
      return { username: settings.loginUser, password: decrypt(settings.loginSecret) };
    }
    const { password, secret } = systemLogin.ensure(settings.systemLoginSecret || null);
    if (secret !== settings.systemLoginSecret) {
      settings.systemLoginSecret = secret;
      save(settings);
    }
    return { username: systemLogin.username, password };
  }

  // What the page shows: never the token or the login password.
  function publicState() {
    const s = load();
    return {
      repo: s.repo,
      githubConnected: isConnected(),
      branchPrefix: s.branchPrefix,
      schedule: s.schedule,
      loginUser: s.loginUser,
      loginSet: Boolean(s.loginSecret),
      defaultLoginUser: systemLogin.username,
      canStoreSecrets: hasKey(),
      running,
      nextRunAt: nextRunAt && nextRunAt.toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      history: s.history,
    };
  }

  function update(input) {
    const current = load();
    const next = validateSettings(input, current);
    if (input.loginPassword !== undefined && input.loginPassword !== '') {
      if (!hasKey()) throw new Error('The password key is missing, so the login cannot be stored safely.');
      next.loginSecret = encrypt(String(input.loginPassword));
    }
    if (input.loginUser === '') next.loginSecret = null;
    // A new login name without a new password would pair it with the old user's password.
    else if (next.loginUser !== current.loginUser && !input.loginPassword) next.loginSecret = null;
    save(next);
    reschedule(next);
    return publicState();
  }

  async function test() {
    const s = load();
    if (!s.repo) throw new Error('Choose a backup repository first.');
    const { htmlUrl } = await checkRepo(getToken(), s.repo);
    return { ok: true, message: `Connected to ${s.repo}, a private repository.`, url: htmlUrl };
  }

  async function run(trigger) {
    if (running) throw new Error('A backup is already running.');
    running = true;
    const startedAt = new Date();
    const entry = { at: startedAt.toISOString(), trigger, ok: false, branch: null, url: null, instances: [], message: '' };
    try {
      const s = load();
      if (!s.repo) throw new Error('Backups are not set up: no repository chosen.');
      const token = getToken();
      const { defaultBranch, htmlUrl } = await checkRepo(token, s.repo);

      const { instances } = await listInstances();
      const online = instances.filter((i) => i.status === 'online' && i.port);
      if (online.length === 0) throw new Error('No online Node-RED instances to back up.');

      // The login only goes to instances known to use the shared accounts:
      // containers mounting /auth, or instances.json entries saying so. Anything
      // else that asks for a login (including every other machine) gets none.
      const shared = (i) => i.sharedLogins === true;
      let credentials = null;
      let credentialsError = null;
      if (online.some((i) => i.login === 'required' && shared(i))) {
        try {
          credentials = credentialsFor(s);
        } catch (e) {
          credentialsError = e.message;
        }
      }
      const files = [];
      const used = new Set();
      for (const i of online) {
        let folder = slug(`${i.name}-${i.port}`);
        while (used.has(folder)) folder += '-x';
        used.add(folder);
        const result = { name: i.name, port: i.port, folder, ok: false };
        try {
          if (i.login === 'required' && !shared(i)) throw new Error('not using the shared accounts, no login sent');
          if (i.login === 'required' && credentialsError) throw new Error(credentialsError);
          const { flows, rev } = await fetchFlows(`http://${i.host || probeHost}:${i.port}`, i.login, credentials);
          files.push({ path: `${folder}/flows.json`, content: JSON.stringify(flows, null, 2) + '\n' });
          Object.assign(result, { ok: true, nodes: flows.length, rev });
        } catch (e) {
          result.error = e.message;
        }
        entry.instances.push(result);
      }

      const saved = entry.instances.filter((i) => i.ok);
      if (saved.length === 0) {
        throw new Error(`Could not read flows from any instance: ${entry.instances.map((i) => `${i.name}: ${i.error}`).join('; ')}`);
      }

      files.push({
        path: 'backup-info.json',
        content:
          JSON.stringify(
            { backedUpAt: startedAt.toISOString(), localTime: `${localDate(startedAt)} ${localTime(startedAt)}`, trigger, instances: entry.instances },
            null,
            2,
          ) + '\n',
      });

      const parent = await baseCommit(token, s.repo, defaultBranch);
      const parentCommit = await github(token, 'GET', `/repos/${s.repo}/git/commits/${parent}`);
      const tree = await github(token, 'POST', `/repos/${s.repo}/git/trees`, {
        base_tree: parentCommit.tree.sha,
        tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
      });
      const failed = entry.instances.length - saved.length;
      const message =
        `Node-RED backup ${localDate(startedAt)} ${localTime(startedAt)}\n\n` +
        entry.instances.map((i) => `- ${i.name} (:${i.port}): ${i.ok ? `${i.nodes} nodes` : `FAILED, ${i.error}`}`).join('\n');
      const commit = await github(token, 'POST', `/repos/${s.repo}/git/commits`, { message, tree: tree.sha, parents: [parent] });

      // Two runs in the same second (a manual one right after the schedule)
      // would want the same name; GitHub answers 422, so add -2, -3...
      const stamp = `${s.branchPrefix}${branchStamp(startedAt)}`;
      let branch = stamp;
      for (let n = 2; ; n++) {
        try {
          await github(token, 'POST', `/repos/${s.repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
          break;
        } catch (e) {
          if (e.status !== 422 || n > 5) throw e;
          branch = `${stamp}-${n}`;
        }
      }

      Object.assign(entry, {
        ok: true,
        branch,
        url: `${htmlUrl}/tree/${branch}`,
        message: `Backed up ${saved.length} of ${entry.instances.length} instances${failed ? ` (${failed} failed)` : ''}.`,
      });
    } catch (e) {
      entry.message = e.message;
    } finally {
      running = false;
      entry.durationMs = Date.now() - startedAt.getTime();
      const s = load();
      s.history = [entry, ...(s.history || [])].slice(0, HISTORY_SIZE);
      save(s);
      console.log(`[backup] ${entry.ok ? 'ok' : 'FAILED'} ${entry.branch || ''} ${entry.message}`);
    }
    return entry;
  }

  function start() {
    reschedule();
    setInterval(() => {
      if (!nextRunAt || Date.now() < nextRunAt.getTime()) return;
      const due = nextRunAt;
      // Book the following slot first, so a slow run can't trigger twice. Count
      // from now, not from the missed slot, so waking from a long sleep runs once
      // instead of catching up every missed slot 20 seconds apart.
      nextRunAt = nextRun(load().schedule, new Date(Math.max(Date.now(), due.getTime() + 1000)));
      run('schedule').catch((e) => console.error('[backup]', e));
    }, 20000).unref();
  }

  return { publicState, update, test, run, start, reschedule: () => reschedule() };
}
