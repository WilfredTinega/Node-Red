import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { Icon, PasswordInput } from './ui.jsx';
import InstancesPage from './pages/InstancesPage.jsx';
import UsersPage from './pages/UsersPage.jsx';
import BackupsPage from './pages/BackupsPage.jsx';
import GithubPage from './pages/GithubPage.jsx';
import AccountPage from './pages/AccountPage.jsx';

// Sidebar entries. adminOnly pages are hidden from read-only users.
const PAGES = [
  { id: 'instances', label: 'Instances', icon: 'instances', component: InstancesPage },
  { id: 'users', label: 'Users', icon: 'users', component: UsersPage, adminOnly: true },
  { id: 'backups', label: 'Backups', icon: 'backup', component: BackupsPage, adminOnly: true },
  { id: 'github', label: 'GitHub', icon: 'github', component: GithubPage, adminOnly: true },
  { id: 'account', label: 'My account', icon: 'account', component: AccountPage },
];

const pageFromHash = () => window.location.hash.replace(/^#\/?/, '') || 'instances';

export default function App() {
  const [me, setMe] = useState(undefined); // undefined = loading, null = logged out

  useEffect(() => {
    api.me().then(setMe, () => setMe(null));
  }, []);

  // Any 401 from a page means the session is gone.
  const onAuthError = useCallback((err) => {
    if (err?.status === 401) setMe(null);
  }, []);

  if (me === undefined) return <main className="center muted">Loading…</main>;
  if (me === null) return <Login onLogin={setMe} />;
  return <Shell me={me} setMe={setMe} onAuthError={onAuthError} />;
}

function Shell({ me, setMe, onAuthError }) {
  const [pageId, setPageId] = useState(pageFromHash);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    const onHash = () => {
      setPageId(pageFromHash());
      setNavOpen(false);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const visible = PAGES.filter((p) => !p.adminOnly || me.admin);
  const page = visible.find((p) => p.id === pageId) || visible[0];
  const Page = page.component;

  return (
    <div className={`shell${navOpen ? ' nav-open' : ''}`}>
      <header className="topbar">
        <button className="ghost icon-button nav-toggle" onClick={() => setNavOpen((o) => !o)} aria-label="Menu" aria-expanded={navOpen}>
          <Icon name="menu" size={18} />
        </button>
        <a className="brand" href="#/instances">
          <img src="/upande-logo.png" alt="Upande" width="30" height="30" />
          <span className="brand-name">Node-RED</span>
        </a>
        <div className="who">
          <span className="who-name">{me.username}</span>
          <span className="tag">{me.admin ? 'admin' : 'read only'}</span>
          <button
            className="ghost small"
            onClick={() =>
              api
                .logout()
                .catch(() => {})
                .finally(() => setMe(null))
            }
          >
            <Icon name="logout" size={14} /> Log out
          </button>
        </div>
      </header>

      <nav className="sidebar" aria-label="Main">
        {visible.map((p) => (
          // onClick too: tapping the page already open changes no hash, so the menu would stay open.
          <a key={p.id} href={`#/${p.id}`} className={`nav-item${p.id === page.id ? ' active' : ''}`} aria-current={p.id === page.id ? 'page' : undefined} onClick={() => setNavOpen(false)}>
            <Icon name={p.icon} />
            {p.label}
          </a>
        ))}
      </nav>
      {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} />}

      <main className="main">
        <Page me={me} setMe={setMe} onAuthError={onAuthError} />
      </main>
    </div>
  );
}

// Counts down to `until` (a timestamp) once a second; null when it has passed.
function useCountdown(until) {
  const [left, setLeft] = useState(() => (until ? Math.max(0, until - Date.now()) : 0));
  useEffect(() => {
    if (!until) return undefined;
    const tick = () => setLeft(Math.max(0, until - Date.now()));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [until]);
  return until && left > 0 ? left : null;
}

const formatCountdown = (ms) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [lockedUntil, setLockedUntil] = useState(null);
  const lockLeft = useCountdown(lockedUntil);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onLogin(await api.login(username, password));
    } catch (err) {
      // The server sends how long the lockout lasts; show it counting down.
      if (err.data?.retryAfterMs) setLockedUntil(Date.now() + err.data.retryAfterMs);
      setError(err.status === 429 ? '' : err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="center">
      <form className="card login" onSubmit={submit}>
        <img className="login-logo" src="/upande-logo.png" alt="Upande" width="64" height="64" />
        <h1>Node-RED</h1>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus />
        </label>
        <PasswordInput label="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {lockLeft ? (
          <p className="error" role="status">
            Too many failed attempts. Try again in <strong>{formatCountdown(lockLeft)}</strong>.
          </p>
        ) : (
          error && <p className="error">{error}</p>
        )}
        <button disabled={busy || Boolean(lockLeft)}>{busy ? 'Logging in…' : 'Log in'}</button>
      </form>
    </main>
  );
}
