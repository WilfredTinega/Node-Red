import { useId, useState } from 'react';
import { api } from '../api.js';
import Select from '../Select.jsx';
import { Card, ErrorText, Notice, PageHeader, Status, formatWhen, timeAgo, useAction, useLoad } from '../ui.jsx';
import { RepoPicker, useRepos } from './GithubPage.jsx';
import './BackupsPage.css';

const MODES = [
  { value: 'off', label: 'Off' },
  { value: 'daily', label: 'Daily' },
  { value: 'hours', label: 'Every N hours' },
  { value: 'weekly', label: 'Weekly' },
];
const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12].map((n) => ({ value: n, label: n === 1 ? 'Every hour' : `Every ${n} hours` }));
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((label, value) => ({ value, label }));

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const pad = (n) => String(n).padStart(2, '0');
const normalizeRepo = (v) =>
  v
    .trim()
    .replace(/^https:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');

function prefixError(p) {
  const v = p.trim();
  if (!/^[A-Za-z0-9._/-]*$/.test(v) || v.includes('..') || v.startsWith('/') || v.includes('//')) {
    return 'Branch prefix may only use letters, numbers, . _ - and /.';
  }
  return '';
}

// The same stamp the server puts in branch names, in the server's timezone.
function branchStamp(date, timeZone) {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
        .formatToParts(date)
        .map((p) => [p.type, p.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}_${parts.hour}-${parts.minute}-${parts.second}`;
  } catch {
    const d = date;
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  }
}

function hoursHint(every) {
  const times = [];
  for (let h = 0; h < 24; h += every) times.push(`${pad(h)}:00`);
  const list = times.length <= 6 ? times.join(', ') : `${times.slice(0, 3).join(', ')} … ${times[times.length - 1]}`;
  return `Counted from midnight: runs at ${list}.`;
}

function formatDuration(ms) {
  if (ms == null) return '—';
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

const formatTrigger = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : '—');

const fromState = (s) => ({
  repo: s.repo || '',
  branchPrefix: s.branchPrefix ?? 'backup/',
  mode: s.schedule.mode,
  time: s.schedule.time,
  everyHours: s.schedule.everyHours,
  weekday: s.schedule.weekday,
  loginUser: s.loginUser || '',
  loginPassword: '',
});

// Which field a server validation message belongs to.
function fieldOf(message) {
  if (/^Repository|public|cannot write/i.test(message)) return 'repo';
  if (/^Branch prefix/.test(message)) return 'branchPrefix';
  if (/^Time/.test(message)) return 'time';
  if (/^Hours/.test(message)) return 'everyHours';
  if (/weekday/i.test(message)) return 'weekday';
  if (/frequency/i.test(message)) return 'mode';
  if (/login|password key/i.test(message)) return 'loginPassword';
  return 'form';
}

export default function BackupsPage({ onAuthError }) {
  // Poll faster while a backup is running, so the page notices when it ends.
  const [fast, setFast] = useState(false);
  const backup = useLoad(api.getBackup, onAuthError, fast ? 5000 : 60000);
  const state = backup.data;
  if (state && state.running !== fast) setFast(state.running);

  return (
    <>
      <PageHeader title="Backups" subtitle="The flows of every online instance, saved as a new branch in a private GitHub repository." />
      {!state && (backup.error ? <Notice kind="error">{backup.error}</Notice> : <p className="muted">Loading…</p>)}
      {state && (
        <>
          {!state.githubConnected && (
            <Notice kind="warn">
              GitHub is not connected, so backups cannot run. <a href="#/github">Connect an account on the GitHub page</a>.
            </Notice>
          )}
          <StatusCard state={state} reload={backup.reload} setState={backup.setData} onAuthError={onAuthError} />
          <SettingsCard saved={state} setSaved={backup.setData} onAuthError={onAuthError} />
          <HistoryCard history={state.history || []} timeZone={state.timezone} />
        </>
      )}
    </>
  );
}

// ---------- status + actions ----------

function StatusCard({ state, reload, setState, onAuthError }) {
  const test = useAction(onAuthError);
  const run = useAction(onAuthError);
  const [testResult, setTestResult] = useState(null);
  const [runResult, setRunResult] = useState(null);

  const ready = state.githubConnected && state.repo;
  const running = state.running || run.busy;
  const disabled = !ready || running || test.busy;

  async function doTest() {
    setTestResult(null);
    const r = await test.run(() => api.testBackup());
    if (r) setTestResult(r);
  }

  async function doRun() {
    setRunResult(null);
    setTestResult(null);
    test.setError('');
    setState((s) => (s ? { ...s, running: true } : s));
    const r = await run.run(() => api.runBackup());
    if (r) setRunResult(r);
    reload();
  }

  let line;
  if (running) line = <Status status="busy" label="Backup running…" />;
  else if (!state.githubConnected) line = <span className="muted">Not set up: GitHub is not connected.</span>;
  else if (!state.repo) line = <span className="muted">Not set up: choose a repository below.</span>;
  else if (state.schedule.mode === 'off' || !state.nextRunAt) line = <span>Scheduled backups are off.</span>;
  else
    line = (
      <span>
        Next backup <strong>{formatWhen(state.nextRunAt, state.timezone)}</strong> <span className="muted">({timeAgo(state.nextRunAt)})</span>
      </span>
    );

  const last = state.history?.[0];
  const tz = state.timezone;

  return (
    <Card
      className="bk-card"
      title="Status"
      actions={
        <>
          <button type="button" className="ghost" onClick={doTest} disabled={disabled}>
            {test.busy ? 'Testing…' : 'Test connection'}
          </button>
          <button type="button" onClick={doRun} disabled={disabled}>
            {running ? 'Backing up…' : 'Back up now'}
          </button>
        </>
      }
    >
      <div className="bk-status" aria-live="polite">
        <p>{line}</p>
        {last && !running && (
          <p className="muted">
            Last backup {formatWhen(last.at, tz)} ({timeAgo(last.at)}): {last.ok ? 'ok' : 'failed'}
          </p>
        )}
        {tz && (state.nextRunAt || last) && !running && <p className="muted small-text">Times in {tz}.</p>}
      </div>
      {test.error && <Notice kind="error">{test.error}</Notice>}
      {testResult && (
        <Notice kind="ok">
          {testResult.message}{' '}
          {testResult.url && (
            <a href={testResult.url} target="_blank" rel="noreferrer">
              Open repository
            </a>
          )}
        </Notice>
      )}
      {run.error && <Notice kind="error">{run.error}</Notice>}
      {runResult && <RunResult entry={runResult} />}
    </Card>
  );
}

function RunResult({ entry }) {
  const partial = entry.ok && entry.instances?.some((i) => !i.ok);
  return (
    <Notice kind={entry.ok ? (partial ? 'warn' : 'ok') : 'error'}>
      <div className="bk-result">
        <strong>{entry.ok ? 'Backup finished' : 'Backup failed'}</strong>
        <span>{entry.message}</span>
        {entry.url && (
          <a href={entry.url} target="_blank" rel="noreferrer">
            <code>{entry.branch}</code>
          </a>
        )}
        {entry.instances?.length > 0 && <InstanceList instances={entry.instances} />}
      </div>
    </Notice>
  );
}

function InstanceList({ instances }) {
  return (
    <ul className="bk-instances">
      {instances.map((i) => (
        <li key={i.folder || `${i.name}-${i.port}`}>
          <Status status={i.ok ? 'success' : 'failed'} label={`${i.name}${i.port ? ` :${i.port}` : ''}`} />
          {i.ok ? <span className="muted">{i.nodes} nodes</span> : <span className="error">{i.error}</span>}
        </li>
      ))}
    </ul>
  );
}

// ---------- settings ----------

function SettingsCard({ saved, setSaved, onAuthError }) {
  const [form, setForm] = useState(() => fromState(saved));
  const [serverError, setServerError] = useState(null); // { field, message }
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState(false);
  const save = useAction(onAuthError);
  const repos = useRepos(saved.githubConnected);
  const ids = {
    repo: useId(),
    prefix: useId(),
    time: useId(),
    user: useId(),
    password: useId(),
    repoMsg: useId(),
    prefixMsg: useId(),
    timeMsg: useId(),
  };

  const set = (patch) => {
    setForm((f) => ({ ...f, ...patch }));
    setServerError(null);
    setDone(false);
  };

  const original = fromState(saved);
  const dirty = JSON.stringify(original) !== JSON.stringify(form);
  const usesTime = form.mode === 'daily' || form.mode === 'weekly';
  const repo = normalizeRepo(form.repo);
  const picked = repos.find((r) => r.fullName.toLowerCase() === repo.toLowerCase());
  const userChanged = form.loginUser.trim() !== saved.loginUser;

  const errors = {
    repo: repo && !REPO_RE.test(repo) ? 'Repository must look like owner/name.' : '',
    branchPrefix: prefixError(form.branchPrefix),
    time: usesTime && !TIME_RE.test(form.time) ? 'Time must be HH:MM (24-hour), for example 02:30.' : '',
    loginPassword:
      form.loginUser.trim() && !form.loginPassword && (userChanged || !saved.loginSet) ? `Enter the password for ${form.loginUser.trim()}.` : '',
  };
  // Format problems show as they're typed; a missing password only after Save.
  const shown = { ...errors, repo: tried ? errors.repo : '', loginPassword: tried ? errors.loginPassword : '' };
  if (serverError && serverError.field !== 'form') shown[serverError.field] = serverError.message;
  const invalid = Object.values(errors).some(Boolean);

  async function submit(e) {
    e.preventDefault();
    setTried(true);
    if (invalid) return;
    const payload = {
      repo,
      branchPrefix: form.branchPrefix.trim(),
      schedule: {
        mode: form.mode,
        time: TIME_RE.test(form.time) ? form.time : saved.schedule.time,
        everyHours: form.everyHours,
        weekday: form.weekday,
      },
      loginUser: form.loginUser.trim(),
      ...(form.loginPassword && { loginPassword: form.loginPassword }),
    };
    setServerError(null);
    save.setError('');
    const next = await save.run(async () => {
      try {
        return await api.saveBackup(payload);
      } catch (err) {
        if (err.status !== 401) setServerError({ field: fieldOf(err.message), message: err.message });
        throw err;
      }
    });
    if (next) {
      setSaved(next);
      setForm(fromState(next));
      setTried(false);
      setDone(true);
    }
  }

  function normalizeTime() {
    const m = form.time.trim().match(/^(\d{1,2})[:.h]?(\d{2})$/);
    if (m && Number(m[1]) < 24) set({ time: `${pad(Number(m[1]))}:${m[2]}` });
  }

  const example = `${form.branchPrefix.trim()}${branchStamp(saved.nextRunAt ? new Date(saved.nextRunAt) : new Date(), saved.timezone)}`;
  const loginAs = saved.loginUser && saved.loginSet ? saved.loginUser : saved.defaultLoginUser;

  const timeField = (
    <div className="field bk-time">
      <label htmlFor={ids.time}>Time</label>
      <input
        id={ids.time}
        value={form.time}
        onChange={(e) => set({ time: e.target.value })}
        onBlur={normalizeTime}
        inputMode="numeric"
        placeholder="HH:MM"
        maxLength={5}
        autoComplete="off"
        aria-invalid={Boolean(shown.time) || undefined}
        aria-describedby={ids.timeMsg}
      />
    </div>
  );

  return (
    <Card className="bk-card" title="Settings">
      <form className="bk-form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor={ids.repo}>Repository</label>
          <RepoPicker
            id={ids.repo}
            value={form.repo}
            onChange={(v) => set({ repo: v })}
            repos={repos}
            showPrivacy
            invalid={Boolean(shown.repo)}
            describedBy={ids.repoMsg}
          />
          <div id={ids.repoMsg}>
            {shown.repo ? (
              <p className="error">{shown.repo}</p>
            ) : picked && !picked.private ? (
              <p className="error">{picked.fullName} is public. Backups are refused for public repositories.</p>
            ) : picked && !picked.canPush ? (
              <p className="error">The connected account cannot write to {picked.fullName}.</p>
            ) : (
              <p className="bk-hint">Must be a private repository.</p>
            )}
          </div>
        </div>

        <div className="field">
          <label htmlFor={ids.prefix}>Branch prefix</label>
          <input
            id={ids.prefix}
            value={form.branchPrefix}
            onChange={(e) => set({ branchPrefix: e.target.value })}
            placeholder="backup/"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={Boolean(shown.branchPrefix) || undefined}
            aria-describedby={ids.prefixMsg}
          />
          <div id={ids.prefixMsg}>
            {shown.branchPrefix ? (
              <p className="error">{shown.branchPrefix}</p>
            ) : (
              <p className="bk-hint">
                Each backup creates a branch like <code>{example}</code>
              </p>
            )}
          </div>
        </div>

        <div className="field">
          <div className="bk-schedule">
            <div className="field bk-mode">
              <span className="field-label">Frequency</span>
              <Select value={form.mode} onChange={(mode) => set({ mode })} options={MODES} ariaLabel="Frequency" />
            </div>
            {form.mode === 'hours' && (
              <div className="field">
                <span className="field-label">Interval</span>
                <Select value={form.everyHours} onChange={(everyHours) => set({ everyHours })} options={HOUR_STEPS} ariaLabel="Interval" />
              </div>
            )}
            {form.mode === 'weekly' && (
              <div className="field">
                <span className="field-label">Day</span>
                <Select value={form.weekday} onChange={(weekday) => set({ weekday })} options={WEEKDAYS} ariaLabel="Day of the week" />
              </div>
            )}
            {usesTime && timeField}
          </div>
          <div id={ids.timeMsg}>
            {shown.time && <p className="error">{shown.time}</p>}
            {['mode', 'everyHours', 'weekday'].map((f) => shown[f] && <p key={f} className="error">{shown[f]}</p>)}
            {form.mode !== 'off' && (
              <p className="bk-hint">
                {form.mode === 'hours' && `${hoursHint(form.everyHours)} `}
                Times are in {saved.timezone || 'the server timezone'}.
              </p>
            )}
          </div>
        </div>

        <fieldset className="bk-login">
          <legend>Instance login</legend>
          <p className="bk-hint">
            {loginAs ? (
              <>
                Instances that need a login are read as <strong>{loginAs}</strong>.
              </>
            ) : (
              'No default login is available, so instances that need a login are skipped unless you set one here.'
            )}
          </p>
          <div className="bk-login-row">
            <div className="field">
              <label htmlFor={ids.user}>Username</label>
              <input
                id={ids.user}
                value={form.loginUser}
                onChange={(e) => set({ loginUser: e.target.value })}
                placeholder="Optional"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="field">
              <label htmlFor={ids.password}>Password</label>
              <input
                id={ids.password}
                type="password"
                value={form.loginPassword}
                onChange={(e) => set({ loginPassword: e.target.value })}
                placeholder={saved.loginSet && !userChanged ? 'Stored, leave blank to keep' : ''}
                autoComplete="new-password"
                disabled={!form.loginUser.trim() || !saved.canStoreSecrets}
                aria-invalid={Boolean(shown.loginPassword) || undefined}
              />
            </div>
          </div>
          {shown.loginPassword && <p className="error">{shown.loginPassword}</p>}
          {!saved.canStoreSecrets && <p className="error">The password key is missing, so a login password cannot be stored.</p>}
          {saved.loginUser && saved.defaultLoginUser && (
            <p className="bk-hint">Clear the username to use {saved.defaultLoginUser} again.</p>
          )}
        </fieldset>

        {serverError?.field === 'form' && <ErrorText>{serverError.message}</ErrorText>}
        {save.error && !serverError && <ErrorText>{save.error}</ErrorText>}
        <div className="bk-save">
          <button disabled={save.busy || !dirty}>{save.busy ? 'Saving…' : 'Save'}</button>
          {done && !dirty && <span className="ok">Saved.</span>}
          {dirty && !save.busy && (
            <button type="button" className="ghost" onClick={() => {
                set(fromState(saved));
                setTried(false);
              }}>
              Discard changes
            </button>
          )}
        </div>
      </form>
    </Card>
  );
}

// ---------- history ----------

// Times are shown in the server's timezone, the one the branch names use.
function HistoryCard({ history, timeZone }) {
  return (
    <Card className="bk-card" title="History" actions={timeZone && history.length > 0 ? <span className="muted small-text">Times in {timeZone}</span> : undefined}>
      {history.length === 0 ? (
        <p className="muted">No backups yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="bk-history">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Trigger</th>
                <th scope="col">Result</th>
                <th scope="col">Branch</th>
                <th scope="col">Instances</th>
                <th scope="col">Duration</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => {
                const savedCount = (h.instances || []).filter((i) => i.ok).length;
                return (
                  <tr key={h.at}>
                    <td className="bk-nowrap" title={timeAgo(h.at)}>
                      {formatWhen(h.at, timeZone)}
                    </td>
                    <td>{formatTrigger(h.trigger)}</td>
                    <td>
                      <Status status={h.ok ? 'success' : 'failed'} label={h.ok ? 'ok' : 'failed'} title={h.message} />
                      {!h.ok && h.message && <div className="bk-cell-error">{h.message}</div>}
                    </td>
                    <td>
                      {h.url ? (
                        <a href={h.url} target="_blank" rel="noreferrer">
                          <code>{h.branch}</code>
                        </a>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      {h.instances?.length ? (
                        <details className="bk-details">
                          <summary>
                            {savedCount}/{h.instances.length} saved
                          </summary>
                          <InstanceList instances={h.instances} />
                        </details>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="bk-nowrap">{formatDuration(h.durationMs)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
