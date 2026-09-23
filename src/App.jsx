import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { Icon } from './ui.jsx';
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
          <button className="ghost small" onClick={() => api.logout().finally(() => setMe(null))}>
            <Icon name="logout" size={14} /> Log out
          </button>
        </div>
      </header>

      <nav className="sidebar" aria-label="Main">
        {visible.map((p) => (
          <a key={p.id} href={`#/${p.id}`} className={`nav-item${p.id === page.id ? ' active' : ''}`} aria-current={p.id === page.id ? 'page' : undefined}>
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
