export class ApiError extends Error {
  constructor(status, message, data = {}) {
    super(message);
    this.status = status;
    this.data = data; // the rest of the error body, e.g. retryAfterMs on a lockout
  }
}

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: {
      'X-Requested-With': 'fetch',
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`, data);
  return data;
}

const enc = encodeURIComponent;

export const api = {
  me: () => request('GET', '/api/me'),
  login: (username, password) => request('POST', '/api/login', { username, password }),
  logout: () => request('POST', '/api/logout'),
  changeOwnPassword: (current, next) => request('POST', '/api/me/password', { current, next }),
  demoteSelf: () => request('POST', '/api/me/demote', {}),

  getSettings: () => request('GET', '/api/settings'),
  saveSettings: (settings) => request('PUT', '/api/settings', settings),

  listInstances: () => request('GET', '/api/instances'),
  restartInstance: (id) => request('POST', `/api/instances/${enc(id)}/restart`, {}),
  updateInstance: (id) => request('POST', `/api/instances/${enc(id)}/update`, {}),
  connectInstance: (id) => request('POST', `/api/instances/${enc(id)}/connect`, {}),
  restartHost: (port) => request('POST', `/api/hosts/${enc(port)}/restart`, {}),
  updateHost: (port) => request('POST', `/api/hosts/${enc(port)}/update`, {}),
  connectHost: (port) => request('POST', `/api/hosts/${enc(port)}/connect`, {}),

  listUsers: () => request('GET', '/api/users'),
  viewPassword: (username) => request('GET', `/api/users/${enc(username)}/password`),
  addUser: (user) => request('POST', '/api/users', user),
  updateUser: (username, changes) => request('PUT', `/api/users/${enc(username)}`, changes),
  deleteUser: (username) => request('DELETE', `/api/users/${enc(username)}`),

  getBackup: () => request('GET', '/api/backup'),
  saveBackup: (settings) => request('PUT', '/api/backup', settings),
  testBackup: () => request('POST', '/api/backup/test', {}),
  runBackup: () => request('POST', '/api/backup/run', {}),

  getGithub: () => request('GET', '/api/github'),
  connectGithub: (token) => request('POST', '/api/github/connect', { token }),
  disconnectGithub: () => request('POST', '/api/github/disconnect', {}),
  saveGithub: (settings) => request('PUT', '/api/github', settings),
  githubRepos: () => request('GET', '/api/github/repos'),

  getDashboard: () => request('GET', '/api/dashboard'),
  updateDashboard: () => request('POST', '/api/dashboard/update', {}),
};
