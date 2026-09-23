export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
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
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  return data;
}

const enc = encodeURIComponent;

export const api = {
  me: () => request('GET', '/api/me'),
  login: (username, password) => request('POST', '/api/login', { username, password }),
  logout: () => request('POST', '/api/logout'),
  changeOwnPassword: (current, next) => request('POST', '/api/me/password', { current, next }),
  listInstances: () => request('GET', '/api/instances'),
  listUsers: () => request('GET', '/api/users'),
  viewPassword: (username) => request('GET', `/api/users/${enc(username)}/password`),
  addUser: (user) => request('POST', '/api/users', user),
  updateUser: (username, changes) => request('PUT', `/api/users/${enc(username)}`, changes),
  deleteUser: (username) => request('DELETE', `/api/users/${enc(username)}`),
};
