import { useEffect, useId, useState } from 'react';
import { api } from '../api.js';
import { Card, ConfirmDialog, ErrorText, Notice, PageHeader, Status, formatWhen, shortSha, timeAgo, useAction, useLoad } from '../ui.jsx';
import './GithubPage.css';

const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=repo,read:packages&description=Node-RED%20dashboard';

export default function GithubPage({ onAuthError }) {
  const gh = useLoad(api.getGithub, onAuthError);
  const [updating, setUpdating] = useState(null);

  if (updating) return <Updating message={updating} />;

  const state = gh.data;
  return (
    <>
      <PageHeader title="GitHub" subtitle="One account for flow backups and dashboard updates." />
      {!state && (gh.error ? <Notice kind="error">{gh.error}</Notice> : <p className="muted">Loading…</p>)}
      {state && (
        <>
          {!state.canStoreSecrets && (
            <Notice kind="error">
              The password key is missing, so a GitHub token cannot be stored safely. Make the secrets folder writable and restart the dashboard.
            </Notice>
          )}
          <AccountCard state={state} setState={gh.setData} onAuthError={onAuthError} />
          <DashboardCard key={String(state.connected)} state={state} setState={gh.setData} onAuthError={onAuthError} onUpdating={setUpdating} />
        </>
      )}
    </>
  );
}

// ---------- account ----------

function AccountCard({ state, setState, onAuthError }) {
  const [token, setToken] = useState('');
  const [confirming, setConfirming] = useState(false);
  const connect = useAction(onAuthError);
  const disconnect = useAction(onAuthError);
  const account = state.account;

  async function submit(e) {
    e.preventDefault();
    const next = await connect.run(() => api.connectGithub(token));
    if (next) {
      setToken('');
      setState(next);
    }
  }

  async function doDisconnect() {
    const next = await disconnect.run(() => api.disconnectGithub());
    if (next) {
      setConfirming(false);
      setState(next);
    }
  }

  if (state.connected && account) {
    return (
      <Card className="gh-card" title="Account">
        <div className="gh-account">
          {account.avatarUrl && <img className="gh-avatar" src={account.avatarUrl} alt="" width="48" height="48" />}
          <div className="gh-account-text">
            {account.name && <strong>{account.name}</strong>}
            <a href={account.htmlUrl} target="_blank" rel="noreferrer">
              @{account.login}
            </a>
            <span className="muted" title={formatWhen(account.connectedAt)}>
              Connected {timeAgo(account.connectedAt)}
            </span>
          </div>
          <button type="button" className="ghost danger gh-account-action" onClick={() => setConfirming(true)}>
            Disconnect
          </button>
        </div>
        {confirming && (
          <ConfirmDialog
            title="Disconnect GitHub?"
            confirmLabel="Disconnect"
            busyLabel="Disconnecting…"
            danger
            busy={disconnect.busy}
            error={disconnect.error}
            onConfirm={doDisconnect}
            onClose={() => {
              setConfirming(false);
              disconnect.setError('');
            }}
          >
            <p>
              Scheduled backups and dashboard updates stop until a GitHub account is connected again. The token is deleted from this server; revoke it on
              GitHub too if it is no longer needed.
            </p>
          </ConfirmDialog>
        )}
      </Card>
    );
  }

  return (
    <Card className="gh-card" title="Account">
      <form className="grid gh-connect" onSubmit={submit}>
        <label>
          Personal access token
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="ghp_…"
            required
            disabled={!state.canStoreSecrets}
          />
        </label>
        <div className="gh-scopes">
          <p>
            Create a <strong>classic</strong> personal access token with these scopes:
          </p>
          <ul>
            <li>
              <code>repo</code>: write backups to the private backup repository, read the dashboard repository and its Actions runs
            </li>
            <li>
              <code>read:packages</code>: pull the dashboard image from ghcr.io
            </li>
          </ul>
          <a href={TOKEN_URL} target="_blank" rel="noreferrer">
            Create a token on GitHub
          </a>
        </div>
        <ErrorText>{connect.error}</ErrorText>
        <div>
          <button disabled={connect.busy || !token.trim() || !state.canStoreSecrets}>{connect.busy ? 'Connecting…' : 'Connect'}</button>
        </div>
      </form>
    </Card>
  );
}

// ---------- dashboard updates ----------

function DashboardCard({ state, setState, onAuthError, onUpdating }) {
  const connected = state.connected;
  const [repo, setRepo] = useState(state.dashboardRepo || '');
  const [branch, setBranch] = useState(state.dashboardBranch || 'main');
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const save = useAction(onAuthError);
  const update = useAction(onAuthError);
  const dash = useLoad(api.getDashboard, onAuthError, 60000);
  const repos = useRepos(connected);
  const repoId = useId();
  const branchId = useId();

  const dirty = repo.trim() !== (state.dashboardRepo || '') || (branch.trim() || 'main') !== (state.dashboardBranch || 'main');

  async function submit(e) {
    e.preventDefault();
    const next = await save.run(() => api.saveGithub({ dashboardRepo: repo, dashboardBranch: branch }));
    if (next) {
      setState(next);
      setRepo(next.dashboardRepo);
      setBranch(next.dashboardBranch);
      setSaved(true);
      dash.reload();
    }
  }

  async function doUpdate() {
    const result = await update.run(() => api.updateDashboard());
    if (result) onUpdating(result.message || 'Updating. The dashboard will restart.');
  }

  const d = dash.data;
  const refresh = (
    <button type="button" className="ghost small" onClick={dash.reload} disabled={dash.loading || !connected}>
      {dash.loading ? 'Checking…' : 'Refresh'}
    </button>
  );

  return (
    <Card className="gh-card" title="Dashboard updates" actions={refresh}>
      {!connected && <Notice>Connect a GitHub account above first.</Notice>}
      <form className="gh-repo-form" onSubmit={submit}>
        <fieldset disabled={!connected}>
          <div className="field gh-repo-field">
            <label htmlFor={repoId}>Repository</label>
            <RepoPicker
              id={repoId}
              value={repo}
              onChange={(v) => {
                setRepo(v);
                setSaved(false);
              }}
              onPick={(r) => r.defaultBranch && setBranch(r.defaultBranch)}
              repos={repos}
            />
          </div>
          <div className="field gh-branch-field">
            <label htmlFor={branchId}>Branch</label>
            <input
              id={branchId}
              value={branch}
              onChange={(e) => {
                setBranch(e.target.value);
                setSaved(false);
              }}
              placeholder="main"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <div className="gh-save">
            <button disabled={save.busy || !dirty}>{save.busy ? 'Saving…' : 'Save'}</button>
          </div>
        </fieldset>
        <ErrorText>{save.error}</ErrorText>
        {saved && !dirty && !save.error && <p className="ok">Saved.</p>}
      </form>

      {connected && (
        <div className="gh-status">
          {dash.error && <Notice kind="error">{dash.error}</Notice>}
          {d && <DashboardStatus d={d} onUpdate={() => setConfirming(true)} />}
          {!d && !dash.error && <p className="muted">Checking…</p>}
        </div>
      )}

      {confirming && d?.latestBuild && (
        <ConfirmDialog
          title="Update the dashboard?"
          confirmLabel="Update"
          busyLabel="Starting update…"
          busy={update.busy}
          error={update.error}
          onConfirm={doUpdate}
          onClose={() => {
            setConfirming(false);
            update.setError('');
          }}
        >
          <p>
            Updates from <code>{shortSha(d.revision)}</code> to <code>{shortSha(d.latestBuild.sha)}</code>
            {d.latestBuild.message && <> ({d.latestBuild.message})</>}. The dashboard restarts and is unavailable for a few seconds. If the new
            version does not start, the old one is put back.
          </p>
        </ConfirmDialog>
      )}
    </Card>
  );
}

function DashboardStatus({ d, onUpdate }) {
  const commitUrl = (sha) => (d.repo && sha && sha !== 'dev' ? `https://github.com/${d.repo}/commit/${sha}` : null);
  const running = commitUrl(d.revision);
  const failedIsNewer = d.failedBuild && (!d.latestBuild || new Date(d.failedBuild.at) > new Date(d.latestBuild.at));

  return (
    <>
      {!d.configured && <Notice>Choose the dashboard repository to check for updates.</Notice>}
      <dl className="details gh-details">
        <dt>Running</dt>
        <dd>
          {running ? (
            <a href={running} target="_blank" rel="noreferrer">
              <code>{shortSha(d.revision)}</code>
            </a>
          ) : (
            <code>{shortSha(d.revision)}</code>
          )}
          {d.revision === 'dev' && <span className="muted"> local build</span>}
        </dd>
        {d.configured && (
          <>
            <dt>Latest build</dt>
            <dd>
              {d.latestBuild ? (
                <>
                  <a href={d.latestBuild.url} target="_blank" rel="noreferrer">
                    <code>{shortSha(d.latestBuild.sha)}</code>
                  </a>
                  {d.latestBuild.message && <span> {d.latestBuild.message}</span>}
                  <span className="muted" title={formatWhen(d.latestBuild.at)}>
                    {' '}
                    · {timeAgo(d.latestBuild.at)}
                  </span>
                </>
              ) : (
                <span className="muted">No successful build on {d.branch} yet</span>
              )}
            </dd>
            <dt>State</dt>
            <dd className="gh-state">
              {d.updateAvailable ? (
                <span className="tag gh-available">Update available</span>
              ) : d.latestBuild ? (
                <Status status="success" label="Up to date" />
              ) : (
                <span className="muted">—</span>
              )}
              {d.building && (
                <a href={d.building.url} target="_blank" rel="noreferrer" className="gh-building">
                  <Status status="busy" label="Build in progress" />
                </a>
              )}
            </dd>
          </>
        )}
        {d.lastUpdate && (
          <>
            <dt>Last update</dt>
            <dd>
              <LastUpdate u={d.lastUpdate} />
            </dd>
          </>
        )}
      </dl>

      {failedIsNewer && (
        <Notice kind="error">
          The latest build failed{d.failedBuild.message ? `: ${d.failedBuild.message}` : ''} (<code>{shortSha(d.failedBuild.sha)}</code>).{' '}
          <a href={d.failedBuild.url} target="_blank" rel="noreferrer">
            View the run
          </a>
        </Notice>
      )}

      {d.updateAvailable && d.canUpdate && (
        <div className="gh-update-row">
          <button type="button" onClick={onUpdate}>
            Update to {shortSha(d.latestBuild?.sha)}
          </button>
        </div>
      )}
      {d.updateAvailable && !d.canUpdate && (
        <Notice kind="warn">
          A newer build is ready, but this dashboard cannot update itself: Docker write access is off on the socket proxy. Set <code>IMAGES=1</code> and{' '}
          <code>POST=1</code> on the proxy.
        </Notice>
      )}
    </>
  );
}

function LastUpdate({ u }) {
  const result = u.result === 'ok' ? <Status status="success" label="ok" /> : u.result ? <Status status="failed" label={u.result} /> : <Status status="busy" label="in progress" />;
  return (
    <span className="gh-last-update">
      to <code>{shortSha(u.to)}</code>
      <span className="muted" title={formatWhen(u.at)}>
        {' '}
        {timeAgo(u.at)}
        {u.by && ` by ${u.by}`}
      </span>
      {result}
    </span>
  );
}

// Shown after an update starts: waits for the restarted dashboard, then reloads.
function Updating({ message }) {
  useEffect(() => {
    const started = Date.now();
    let failedOnce = false;
    let stopped = false;
    const tick = async () => {
      let answered = false;
      try {
        await api.me();
        answered = true;
      } catch (err) {
        // Any HTTP answer below 500 (including 401, sessions reset on restart) means the server is back.
        answered = Boolean(err?.status && err.status < 500);
      }
      if (stopped) return;
      if (!answered) failedOnce = true;
      if ((answered && failedOnce) || Date.now() - started > 90000) {
        stopped = true;
        window.location.reload();
      }
    };
    const t = setInterval(tick, 2000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, []);

  return (
    <Card className="gh-card gh-updating">
      <div className="gh-spinner" aria-hidden="true" />
      <h2 role="status">Updating… the dashboard will restart</h2>
      <p className="muted">{message} This page reloads by itself.</p>
    </Card>
  );
}

// ---------- repository picker (shared with the Backups page) ----------

// Repositories the connected token can see. Failures are ignored: the field
// still accepts a typed owner/name.
export function useRepos(enabled) {
  const [repos, setRepos] = useState([]);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    api.githubRepos().then(
      (list) => live && setRepos(Array.isArray(list) ? list : []),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [enabled]);
  return repos;
}

// A text input with a filterable suggestion list (ARIA combobox).
export function RepoPicker({ id, value, onChange, onPick, repos, showPrivacy = false, invalid = false, describedBy, disabled }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();

  const q = value.trim().toLowerCase();
  const matches = repos.filter((r) => !q || r.fullName.toLowerCase().includes(q)).slice(0, 8);
  const exact = matches.length === 1 && matches[0].fullName.toLowerCase() === q;
  const show = open && matches.length > 0 && !exact;

  function pick(r) {
    onChange(r.fullName);
    onPick?.(r);
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!show) setOpen(true);
      else setActive((i) => Math.min(matches.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(-1, i - 1));
    } else if (e.key === 'Enter' && show && active >= 0) {
      e.preventDefault();
      pick(matches[active]);
    } else if (e.key === 'Escape' && show) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <div className="combo">
      <input
        id={id}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={show}
        aria-controls={listId}
        aria-activedescendant={show && active >= 0 ? `${listId}-${active}` : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        placeholder="owner/name"
        autoComplete="off"
        spellCheck={false}
      />
      {show && (
        <ul id={listId} role="listbox" className="combo-list" aria-label="Repositories">
          {matches.map((r, i) => (
            <li
              key={r.fullName}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`combo-option${i === active ? ' active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(r);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="combo-name">{r.fullName}</span>
              {showPrivacy && <span className={`tag${r.private ? '' : ' gh-public'}`}>{r.private ? 'private' : 'public'}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
