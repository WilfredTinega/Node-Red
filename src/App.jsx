import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import Select from './Select.jsx';

const PERMISSION_OPTIONS = [
  { value: '*', label: 'Full access', hint: 'Edit and deploy flows, manage users' },
  { value: 'read', label: 'Read only', hint: 'View flows, cannot deploy' },
];
const MIN_PASSWORD = 10;

export default function App() {
  const [me, setMe] = useState(undefined); // undefined = loading, null = logged out

  useEffect(() => {
    api.me().then(setMe, () => setMe(null));
  }, []);

  // Any 401 from a child means the session is gone.
  const onAuthError = useCallback((err) => {
    if (err.status === 401) setMe(null);
  }, []);

  if (me === undefined) return <main className="center muted">Loading…</main>;
  if (me === null) return <Login onLogin={setMe} />;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <img src="/upande-logo.png" alt="Upande" width="32" height="32" />
          <h1>Node-RED</h1>
        </div>
        <div className="who">
          <span>
            {me.username} · {me.admin ? 'admin' : 'read only'}
          </span>
          <button className="ghost" onClick={() => api.logout().finally(() => setMe(null))}>
            Log out
          </button>
        </div>
      </header>
      <main className="content">
        <Instances onAuthError={onAuthError} />
        {me.admin && <UserManager me={me} onAuthError={onAuthError} />}
        <OwnPassword onAuthError={onAuthError} />
      </main>
    </div>
  );
}

function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onLogin(await api.login(username, password));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="center">
      <form className="card login" onSubmit={submit}>
        <img className="login-logo" src="/upande-logo.png" alt="Upande" width="64" height="64" />
        <h1>Node-RED</h1>
        <p className="muted">Log in with your Node-RED account.</p>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        {error && <p className="error">{error}</p>}
        <button disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button>
      </form>
    </main>
  );
}

const STATUS_LABELS = { online: 'Online', offline: 'Stopped', unreachable: 'Not responding' };
const LOGIN_LABELS = { required: 'Login required', open: 'No login', unknown: '—' };

function Instances({ onAuthError }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listInstances()
      .then(
        (d) => {
          setData(d);
          setError('');
        },
        (err) => {
          onAuthError(err);
          setError(err.message);
        },
      )
      .finally(() => setLoading(false));
  }, [onAuthError]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, [load]);

  const host = data?.publicHost || window.location.hostname;
  const instances = data?.instances || [];

  return (
    <section className="card">
      <div className="section-head">
        <h2>Instances</h2>
        <div className="head-actions">
          <span className="muted">
            {host} · {instances.filter((i) => i.status === 'online').length} of {instances.length} online
          </span>
          <button className="ghost small" onClick={load} disabled={loading}>
            {loading ? 'Checking…' : 'Refresh'}
          </button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {data?.errors?.map((e) => (
        <p key={e} className="error">
          {e}
        </p>
      ))}
      {data && instances.length === 0 && <p className="muted">No Node-RED instances found.</p>}
      {instances.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Address</th>
                <th>Status</th>
                <th>Login</th>
                <th>Shared accounts</th>
              </tr>
            </thead>
            <tbody>
              {instances.map((i) => {
                const address = i.port ? `${i.host || (i.localOnly ? '127.0.0.1' : host)}:${i.port}` : null;
                const kind = i.source === 'docker' ? 'docker' : i.host ? 'remote' : 'package';
                return (
                  <tr key={`${i.name}-${i.host || ''}-${i.port}`}>
                    <td>
                      {i.name}
                      <span className="tag" title={kind === 'package' ? 'Installed with npm, not in Docker' : undefined}>
                        {kind}
                      </span>
                    </td>
                    <td>
                      {address && i.localOnly ? (
                        <span title="Only reachable from the server itself">
                          {address} <span className="tag">server only</span>
                        </span>
                      ) : address ? (
                        <a href={`http://${address}`} target="_blank" rel="noreferrer">
                          {address}
                        </a>
                      ) : (
                        <span className="muted">No published port</span>
                      )}
                    </td>
                    <td>
                      <span className={`status ${i.status}`} title={i.detail}>
                        <span className="dot" aria-hidden="true" />
                        {STATUS_LABELS[i.status] || i.status}
                      </span>
                    </td>
                    <td className={i.login === 'open' ? 'error' : undefined}>{LOGIN_LABELS[i.login] || i.login}</td>
                    <td className="muted">{i.sharedLogins === true ? 'Yes' : i.sharedLogins === false ? 'No' : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function UserManager({ me, onAuthError }) {
  const [users, setUsers] = useState([]);
  const [error, setError] = useState('');
  const [resetting, setResetting] = useState(null); // username
  const [deleting, setDeleting] = useState(null); // username
  const [shown, setShown] = useState(null); // { username, password }

  const load = useCallback(() => {
    api.listUsers().then(setUsers, (err) => {
      onAuthError(err);
      setError(err.message);
    });
  }, [onAuthError]);

  useEffect(load, [load]);

  async function run(action) {
    setError('');
    try {
      await action();
      load();
    } catch (err) {
      onAuthError(err);
      setError(err.message);
    }
  }

  const changePermissions = (u, permissions) =>
    run(() => api.updateUser(u.username, { permissions }));

  return (
    <>
      <section className="card">
        <div className="section-head">
          <h2>Accounts</h2>
          <span className="muted">{users.length} users</span>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Username</th>
                <th>Access</th>
                <th>Password</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.username}>
                  <td>
                    {u.username}
                    {u.username === me.username && <span className="tag">you</span>}
                  </td>
                  <td>
                    {u.locked ? (
                      <span className="locked" title={`${u.username} always has full access`}>
                        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                          <rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                          <path d="M5.5 7V5a2.5 2.5 0 015 0v2" fill="none" stroke="currentColor" strokeWidth="1.5" />
                        </svg>
                        Full access
                      </span>
                    ) : (
                      <Select
                        value={typeof u.permissions === 'string' ? u.permissions : '*'}
                        onChange={(permissions) => changePermissions(u, permissions)}
                        options={PERMISSION_OPTIONS}
                        ariaLabel={`Access for ${u.username}`}
                      />
                    )}
                  </td>
                  <td>
                    <PasswordCell user={u} onAuthError={onAuthError} />
                  </td>
                  <td className="actions">
                    <button className="ghost" onClick={() => setResetting(u.username)}>
                      Reset password
                    </button>
                    <button className="ghost danger" onClick={() => setDeleting(u.username)} disabled={u.username === me.username || u.locked}
                      title={u.locked ? `${u.username} cannot be deleted` : undefined}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <AddUser
        onAdded={(username, password) => {
          load();
          if (password) setShown({ username, password });
        }}
        onAuthError={onAuthError}
      />

      {resetting && (
        <ResetDialog
          username={resetting}
          onClose={() => setResetting(null)}
          onDone={(password) => {
            setResetting(null);
            if (password) setShown({ username: resetting, password });
          }}
          onAuthError={onAuthError}
        />
      )}
      {deleting && (
        <DeleteDialog
          username={deleting}
          onClose={() => setDeleting(null)}
          onDone={() => {
            setDeleting(null);
            load();
          }}
          onAuthError={onAuthError}
        />
      )}
      {shown && <ShownPassword {...shown} onClose={() => setShown(null)} />}
    </>
  );
}

// Hidden by default; fetched from the server only when an admin clicks Show.
function PasswordCell({ user, onAuthError }) {
  const [password, setPassword] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  // A reset or a list reload makes any revealed value stale.
  useEffect(() => {
    setPassword(null);
    setError('');
  }, [user]);

  if (!user.viewable) {
    return (
      <span className="muted" title="Set before viewing was enabled. Reset it to make it viewable.">
        Not stored
      </span>
    );
  }

  async function show() {
    setError('');
    try {
      setPassword((await api.viewPassword(user.username)).password);
    } catch (err) {
      onAuthError(err);
      setError(err.message);
    }
  }

  function copy() {
    navigator.clipboard?.writeText(password).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  }

  if (error) return <span className="error">{error}</span>;
  if (password === null) {
    return (
      <span className="pw">
        <span className="muted">••••••••••</span>
        <button className="ghost small" onClick={show}>
          Show
        </button>
      </span>
    );
  }
  return (
    <span className="pw">
      <code>{password}</code>
      <button className="ghost small" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
      <button className="ghost small" onClick={() => setPassword(null)}>
        Hide
      </button>
    </span>
  );
}

// Shared "generate or type a password" control.
function PasswordChoice({ generate, setGenerate, password, setPassword }) {
  return (
    <fieldset className="choice">
      <label className="inline">
        <input type="radio" checked={generate} onChange={() => setGenerate(true)} />
        Generate a random password
      </label>
      <label className="inline">
        <input type="radio" checked={!generate} onChange={() => setGenerate(false)} />
        Type a password
      </label>
      {!generate && (
        <input
          type="text"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={MIN_PASSWORD}
          placeholder={`At least ${MIN_PASSWORD} characters`}
          autoComplete="new-password"
          required
        />
      )}
    </fieldset>
  );
}

function AddUser({ onAdded, onAuthError }) {
  const [username, setUsername] = useState('');
  const [permissions, setPermissions] = useState('read');
  const [generate, setGenerate] = useState(true);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      const res = await api.addUser({ username, permissions, ...(generate ? { generate: true } : { password }) });
      onAdded(username.trim(), res.password);
      setUsername('');
      setPassword('');
    } catch (err) {
      onAuthError(err);
      setError(err.message);
    }
  }

  return (
    <section className="card">
      <h2>Add user</h2>
      <form className="grid" onSubmit={submit}>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="name@upande.com" required />
        </label>
        <div className="field">
          <span className="field-label">Access</span>
          <Select value={permissions} onChange={setPermissions} options={PERMISSION_OPTIONS} ariaLabel="Access" />
        </div>
        <PasswordChoice generate={generate} setGenerate={setGenerate} password={password} setPassword={setPassword} />
        {error && <p className="error">{error}</p>}
        <div>
          <button>Add user</button>
        </div>
      </form>
    </section>
  );
}

function ResetDialog({ username, onClose, onDone, onAuthError }) {
  const [generate, setGenerate] = useState(true);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      const res = await api.updateUser(username, generate ? { generate: true } : { password });
      onDone(res.password);
    } catch (err) {
      onAuthError(err);
      setError(err.message);
    }
  }

  return (
    <Dialog title={`Reset password for ${username}`} onClose={onClose}>
      <form onSubmit={submit}>
        <PasswordChoice generate={generate} setGenerate={setGenerate} password={password} setPassword={setPassword} />
        {error && <p className="error">{error}</p>}
        <div className="buttons">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button>Reset password</button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteDialog({ username, onClose, onDone, onAuthError }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function confirmDelete() {
    setBusy(true);
    setError('');
    try {
      await api.deleteUser(username);
      onDone();
    } catch (err) {
      onAuthError(err);
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Dialog title="Delete user" onClose={onClose}>
      <p>
        Delete <strong>{username}</strong>? They will no longer be able to log in to Node-RED or this page.
      </p>
      {error && <p className="error">{error}</p>}
      <div className="buttons">
        <button type="button" className="ghost" onClick={onClose} autoFocus>
          Cancel
        </button>
        <button type="button" className="destructive" onClick={confirmDelete} disabled={busy}>
          {busy ? 'Deleting…' : 'Delete user'}
        </button>
      </div>
    </Dialog>
  );
}

function ShownPassword({ username, password, onClose }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard?.writeText(password).then(() => setCopied(true), () => {});

  return (
    <Dialog title="New password" onClose={onClose}>
      <p>
        New password for <strong>{username}</strong>. Copy it and send it to them securely.
      </p>
      <div className="secret">
        <code>{password}</code>
        <button className="ghost" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="buttons">
        <button onClick={onClose}>Done</button>
      </div>
    </Dialog>
  );
}

function OwnPassword({ onAuthError }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [message, setMessage] = useState(null); // { ok, text }

  async function submit(e) {
    e.preventDefault();
    if (next !== repeat) return setMessage({ ok: false, text: 'The new passwords do not match.' });
    try {
      await api.changeOwnPassword(current, next);
      setCurrent('');
      setNext('');
      setRepeat('');
      setMessage({ ok: true, text: 'Password changed. Use it next time you log in to Node-RED.' });
    } catch (err) {
      onAuthError(err);
      setMessage({ ok: false, text: err.message });
    }
  }

  return (
    <section className="card">
      <h2>Change my password</h2>
      <form className="grid" onSubmit={submit}>
        <label>
          Current password
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        </label>
        <label>
          New password
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} minLength={MIN_PASSWORD} autoComplete="new-password" required />
        </label>
        <label>
          Repeat new password
          <input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" required />
        </label>
        {message && <p className={message.ok ? 'ok' : 'error'}>{message.text}</p>}
        <div>
          <button>Change password</button>
        </div>
      </form>
    </section>
  );
}

function Dialog({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}
