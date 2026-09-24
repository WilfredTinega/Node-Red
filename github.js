// The GitHub account the dashboard is connected to. One token serves both the
// flow backups and the dashboard's own updates. It is stored encrypted.
import fs from 'node:fs';

export const GITHUB_API = (process.env.GITHUB_API || 'https://api.github.com').replace(/\/$/, '');

export async function github(token, method, path, body, { raw = false, timeout = 30000 } = {}) {
  const res = await fetch(path.startsWith('http') ? path : `${GITHUB_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'nodered-user-admin',
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  if (raw && res.ok) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`GitHub ${method} ${path.split('?')[0].replace(GITHUB_API, '')}: ${res.status} ${data.message || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// owner/name, where neither part is only dots: "../.." would walk the API path.
const REPO_RE = /^(?!\.+\/)[\w.-]+\/(?!\.+$)[\w.-]+$/;
export const normalizeRepo = (value) =>
  String(value || '')
    .trim()
    .replace(/^https:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');

export function createGithubAccount({ file, encrypt, decrypt, hasKey }) {
  function load() {
    try {
      return { dashboardRepo: '', dashboardBranch: 'main', ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`github: cannot read ${file}: ${e.message}`);
      return { tokenSecret: null, account: null, dashboardRepo: '', dashboardBranch: 'main' };
    }
  }

  function save(s) {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }

  function token() {
    const s = load();
    if (!s.tokenSecret) throw new Error('GitHub is not connected. Connect an account on the GitHub page first.');
    return decrypt(s.tokenSecret);
  }

  function publicState() {
    const s = load();
    return {
      connected: Boolean(s.tokenSecret),
      account: s.account || null,
      dashboardRepo: s.dashboardRepo,
      dashboardBranch: s.dashboardBranch,
      canStoreSecrets: hasKey(),
    };
  }

  // Checks the token against GitHub before storing it, so a typo never replaces a working one.
  async function connect(rawToken) {
    if (!hasKey()) throw new Error('The password key is missing, so the token cannot be stored safely.');
    const t = String(rawToken || '').trim();
    if (!t) throw new Error('Paste a GitHub token.');
    const user = await github(t, 'GET', '/user');
    const s = load();
    s.tokenSecret = encrypt(t);
    s.account = { login: user.login, name: user.name || null, avatarUrl: user.avatar_url, htmlUrl: user.html_url, connectedAt: new Date().toISOString() };
    save(s);
    return publicState();
  }

  function disconnect() {
    const s = load();
    s.tokenSecret = null;
    s.account = null;
    save(s);
    return publicState();
  }

  function updateSettings(input) {
    const s = load();
    if (input.dashboardRepo !== undefined) {
      const repo = normalizeRepo(input.dashboardRepo);
      if (repo && !REPO_RE.test(repo)) throw new Error('Repository must look like owner/name.');
      s.dashboardRepo = repo;
    }
    if (input.dashboardBranch !== undefined) {
      const b = String(input.dashboardBranch).trim() || 'main';
      if (!/^[A-Za-z0-9._/-]+$/.test(b) || b.includes('..')) throw new Error('Branch name is not valid.');
      s.dashboardBranch = b;
    }
    save(s);
    return publicState();
  }

  // Repositories the token can see, newest activity first, for the pickers.
  async function repos() {
    const list = await github(token(), 'GET', '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member');
    return list.map((r) => ({ fullName: r.full_name, private: r.private, canPush: Boolean(r.permissions?.push), defaultBranch: r.default_branch }));
  }

  return { load, token, publicState, connect, disconnect, updateSettings, repos };
}

export { REPO_RE };
