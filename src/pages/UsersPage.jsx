import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import Select from '../Select.jsx';
import {
  Card,
  ConfirmDialog,
  CopyButton,
  Dialog,
  ErrorText,
  Icon,
  LockedBadge,
  PageHeader,
  PasswordChoice,
  PERMISSION_OPTIONS,
  ShownPassword,
  useAction,
  useLoad,
} from '../ui.jsx';
import './UsersPage.css';

const INSTANCE_OPTIONS = [
  { value: '', label: 'No access' },
  { value: 'read', label: 'Read only' },
  { value: '*', label: 'Full access' },
];

const instanceCount = (map) => Object.keys(map || {}).length;
const instancesLabel = (map) => {
  if (!map) return 'All instances';
  const n = instanceCount(map);
  return `${n} instance${n === 1 ? '' : 's'}`;
};

export default function UsersPage({ me, setMe, onAuthError }) {
  const { data: users, error, reload } = useLoad(api.listUsers, onAuthError);
  const settings = useLoad(api.getSettings, onAuthError);
  const [rowErrors, setRowErrors] = useState({}); // username -> message
  const [saving, setSaving] = useState({}); // username -> true
  const [editing, setEditing] = useState(null); // user whose instance access is open
  const [resetting, setResetting] = useState(null); // username
  const [deleting, setDeleting] = useState(null); // username
  const [shown, setShown] = useState(null); // { username, password }

  const setRowError = (username, message) => setRowErrors((e) => ({ ...e, [username]: message }));

  // After an admin changes their own account, the shell must see it at once:
  // losing admin access hides this page. Returns false when the page is going away.
  const refreshMe = useCallback(
    async (username, updated) => {
      if (username !== me.username) return true;
      const fresh = updated || (await api.me().catch(() => null));
      if (fresh) setMe(fresh);
      return !fresh || Boolean(fresh.admin);
    },
    [me.username, setMe],
  );

  async function changePermissions(u, permissions) {
    setRowError(u.username, '');
    setSaving((s) => ({ ...s, [u.username]: true }));
    try {
      const res = await api.updateUser(u.username, { permissions });
      if (await refreshMe(u.username, res.user)) await reload();
    } catch (err) {
      onAuthError(err);
      setRowError(u.username, err.message);
    } finally {
      setSaving((s) => ({ ...s, [u.username]: false }));
    }
  }

  const list = users || [];
  const viewable = Boolean(settings.data?.viewablePasswords);

  return (
    <>
      <PageHeader title="Users" subtitle={users ? `${list.length} user${list.length === 1 ? '' : 's'}` : undefined} />

      <Card title="Accounts" className="page-card">
        {settings.data && <ViewableSetting settings={settings.data} setSettings={settings.setData} onChanged={reload} onAuthError={onAuthError} />}
        <ErrorText>{settings.error}</ErrorText>
        <ErrorText>{error}</ErrorText>
        {!users && !error && <p className="muted">Loading…</p>}
        {list.length > 0 && (
          <div className="table-wrap">
            <table className="users-table">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Access</th>
                  <th>Instances</th>
                  <th>Password</th>
                  <th>
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((u) => (
                  <UserRow
                    key={u.username}
                    user={u}
                    isMe={u.username === me.username}
                    viewable={viewable}
                    saving={Boolean(saving[u.username])}
                    error={rowErrors[u.username]}
                    onPermissions={(p) => changePermissions(u, p)}
                    onInstances={() => setEditing(u)}
                    onReset={() => setResetting(u.username)}
                    onDelete={() => setDeleting(u.username)}
                    onAuthError={onAuthError}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <AddUser
        onAdded={(username, password) => {
          reload();
          if (password) setShown({ username, password });
        }}
        onAuthError={onAuthError}
      />

      {editing && (
        <InstanceAccessDialog
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={async (updated) => {
            setEditing(null);
            if (await refreshMe(editing.username, updated)) reload();
          }}
          onAuthError={onAuthError}
        />
      )}
      {resetting && (
        <ResetDialog
          username={resetting}
          onClose={() => setResetting(null)}
          onDone={(password) => {
            const username = resetting;
            setResetting(null);
            reload();
            if (password) setShown({ username, password });
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
            reload();
          }}
          onAuthError={onAuthError}
        />
      )}
      {shown && <ShownPassword {...shown} onClose={() => setShown(null)} />}
    </>
  );
}

const PER_INSTANCE_WHY = 'Access is set per instance; such users cannot manage this dashboard';
const SYSTEM_WHY = 'Used by scheduled backups';

function UserRow({ user: u, isMe, viewable, saving, error, onPermissions, onInstances, onReset, onDelete, onAuthError }) {
  const lockedWhy = `${u.username} is the built-in administrator: it always has full access on every instance.`;
  const deleteWhy = u.locked ? `${u.username} cannot be deleted.` : isMe ? 'You cannot delete your own account.' : undefined;
  const deleteTitle = deleteWhy || (u.system ? 'It is recreated at the next backup' : undefined);

  return (
    <>
      <tr className={error ? 'has-error' : undefined}>
        <td className="nowrap">
          {u.username}
          {isMe && <span className="tag">you</span>}
          {u.system && (
            <span className="tag" title={SYSTEM_WHY}>
              system
            </span>
          )}
        </td>
        <td>
          {u.locked ? (
            <LockedBadge title={lockedWhy} />
          ) : u.instances ? (
            <span className="muted nowrap per-instance" title={PER_INSTANCE_WHY} aria-label={`Access for ${u.username}: per instance`}>
              Per instance
            </span>
          ) : (
            <span title={u.system ? SYSTEM_WHY : undefined} className="disabled-wrap">
              <Select
                value={typeof u.permissions === 'string' ? u.permissions : '*'}
                onChange={onPermissions}
                options={PERMISSION_OPTIONS}
                ariaLabel={`Access for ${u.username}`}
                disabled={saving || u.system}
              />
            </span>
          )}
        </td>
        <td>
          {u.locked ? (
            <span title={lockedWhy} className="disabled-wrap">
              <button type="button" className="ghost instances-button" disabled aria-label={`Instances for ${u.username}: all instances, locked`}>
                <Icon name="lock" size={14} />
                All instances
              </button>
            </span>
          ) : (
            <span title={u.system ? SYSTEM_WHY : undefined} className="disabled-wrap">
              <button
                type="button"
                className="ghost instances-button"
                onClick={onInstances}
                disabled={u.system}
                aria-label={`Instances for ${u.username}: ${instancesLabel(u.instances)}`}
              >
                {instancesLabel(u.instances)}
              </button>
            </span>
          )}
        </td>
        <td>
          <PasswordCell user={u} viewable={viewable} onAuthError={onAuthError} />
        </td>
        <td>
          <div className="actions">
            <button className="ghost" onClick={onReset}>
              Reset password
            </button>
            <span title={deleteTitle} className="disabled-wrap">
              <button className="ghost danger" onClick={onDelete} disabled={Boolean(deleteWhy)} aria-label={`Delete ${u.username}`}>
                Delete
              </button>
            </span>
          </div>
        </td>
      </tr>
      {error && (
        <tr className="row-error">
          <td colSpan={5}>
            <p className="error" role="alert">
              {error}
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

// ---------- viewable passwords setting ----------

// On: an encrypted copy of each new password is kept so admins can Show it.
// Off (the default): only the bcrypt hash exists, and turning it off deletes
// every stored copy, so that asks first.
function ViewableSetting({ settings, setSettings, onChanged, onAuthError }) {
  const [asking, setAsking] = useState(false);
  const { busy, error, setError, run } = useAction(onAuthError);
  const on = Boolean(settings.viewablePasswords);
  const canStore = settings.canStoreSecrets !== false;
  const helpId = useId();

  async function save(viewablePasswords) {
    const next = await run(() => api.saveSettings({ viewablePasswords }));
    if (next) {
      setSettings(next);
      setAsking(false);
      onChanged();
    }
    return next;
  }

  return (
    <div className="viewable-setting">
      <div className="switch-row">
        <span className="switch-label" id={`${helpId}-label`}>
          Store passwords viewable
        </span>
        <span title={canStore ? undefined : 'The password key is missing, so passwords cannot be stored viewable.'} className="disabled-wrap">
          <button
            type="button"
            role="switch"
            className="switch"
            aria-checked={on}
            aria-labelledby={`${helpId}-label`}
            disabled={busy || !canStore}
            onClick={() => {
              setError('');
              if (on) setAsking(true);
              else save(true);
            }}
          >
            <span className="track" aria-hidden="true" />
            {on ? 'On' : 'Off'}
          </button>
        </span>
      </div>
      <ErrorText>{!asking && error}</ErrorText>
      {asking && (
        <ConfirmDialog title="Turn off viewable passwords?" confirmLabel="Turn off" busyLabel="Turning off…" danger onConfirm={() => save(false)} onClose={() => setAsking(false)} error={error} busy={busy}>
          <p>
            Every stored password copy is <strong>deleted now</strong> and Show stops working.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

// Hidden by default; fetched from the server only when an admin clicks Show.
// viewable: the dashboard-wide setting; user.viewable: this account has a copy.
function PasswordCell({ user, viewable, onAuthError }) {
  const [password, setPassword] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // A reset or a list reload makes any revealed value stale.
  useEffect(() => {
    setPassword(null);
    setError('');
  }, [user]);

  if (!viewable) {
    return (
      <span className="muted nowrap" title="Only the password hash is stored. Turn on Store passwords viewable to keep a copy admins can show.">
        Hashed
      </span>
    );
  }
  if (!user.viewable) {
    return (
      <span className="muted nowrap" title="Set while passwords were stored as hashes only. Reset it to keep a viewable copy.">
        Not stored
      </span>
    );
  }

  async function show() {
    setError('');
    setBusy(true);
    try {
      setPassword((await api.viewPassword(user.username)).password);
    } catch (err) {
      onAuthError(err);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (password === null) {
    return (
      <span className="pw-cell">
        <span className="pw">
          <span className="muted" aria-hidden="true">
            ••••••••••
          </span>
          <button className="ghost small" onClick={show} disabled={busy} aria-label={`Show password for ${user.username}`}>
            {busy ? 'Showing…' : 'Show'}
          </button>
        </span>
        {error && <span className="error">{error}</span>}
      </span>
    );
  }
  return (
    <span className="pw">
      <code>{password}</code>
      <CopyButton text={password} />
      <button className="ghost small" onClick={() => setPassword(null)}>
        Hide
      </button>
    </span>
  );
}

// ---------- instance access ----------

// Instances a user can be limited to: local ones with a key. Remote machines
// don't read this server's accounts file.
function useAccessInstances(onAuthError) {
  const { data, error, loading, reload } = useLoad(api.listInstances, onAuthError);
  const instances = useMemo(() => {
    const seen = new Set();
    return (data?.instances || []).filter((i) => {
      if (!i.key || i.host || seen.has(i.key)) return false;
      seen.add(i.key);
      return true;
    });
  }, [data]);
  return { instances, error, loading: loading && !data, reload };
}

// "All instances" vs "Only chosen instances" with a row per instance.
// value: null (all) or { key: '*' | 'read' }. knownKeys: keys to keep showing
// even when discovery doesn't find them right now.
function InstanceAccessChoice({ value, onChange, knownKeys = [], onAuthError, disabled }) {
  const lastMap = useRef(value || {});
  if (value) lastMap.current = value;
  const name = useId();
  const chosen = value !== null;

  return (
    <fieldset className="choice instance-choice" disabled={disabled}>
      <legend className="field-label">Instances</legend>
      <label className="inline">
        <input type="radio" name={name} checked={!chosen} onChange={() => onChange(null)} />
        All instances (uses the account&apos;s access above)
      </label>
      <label className="inline">
        <input type="radio" name={name} checked={chosen} onChange={() => onChange({ ...lastMap.current })} />
        Only chosen instances
      </label>
      {chosen && <InstanceRows value={value} onChange={onChange} knownKeys={knownKeys} onAuthError={onAuthError} />}
    </fieldset>
  );
}

function InstanceRows({ value, onChange, knownKeys, onAuthError }) {
  const { instances, error, loading, reload } = useAccessInstances(onAuthError);

  const found = new Set(instances.map((i) => i.key));
  const missing = [...new Set([...knownKeys, ...Object.keys(value)])].filter((k) => !found.has(k)).sort();

  function set(key, permission) {
    const next = { ...value };
    if (permission) next[key] = permission;
    else delete next[key];
    onChange(next);
  }

  if (loading) return <p className="muted">Looking for instances…</p>;

  return (
    <div className="access-rows">
      {error && (
        <p className="error">
          {error}{' '}
          <button type="button" className="ghost small" onClick={reload}>
            Retry
          </button>
        </p>
      )}
      {instances.length === 0 && missing.length === 0 && !error && <p className="muted">No instances found.</p>}
      {instances.map((i) => {
        const notConnected = i.login === 'open' || i.sharedLogins === false;
        return (
          <div key={i.key} className="access-row">
            <div className="access-name">
              <span>{i.name}</span>
              {!i.name.endsWith(`:${i.port}`) && <span className="muted">:{i.port}</span>}
              {notConnected && (
                <span className="warn-text">
                  {i.login === 'open' ? 'No login on this instance' : 'Not using the shared accounts'}, so these rules don&apos;t apply until it&apos;s connected. Use Connect on the Instances page.
                </span>
              )}
            </div>
            <Select value={value[i.key] || ''} onChange={(p) => set(i.key, p)} options={INSTANCE_OPTIONS} ariaLabel={`Access on ${i.name} (port ${i.port})`} />
          </div>
        );
      })}
      {missing.map((key) => (
        <div key={key} className="access-row">
          <div className="access-name">
            <span>{key.includes(':') ? key : `Port ${key}`}</span>
            <span className="muted">not found right now</span>
          </div>
          <Select value={value[key] || ''} onChange={(p) => set(key, p)} options={INSTANCE_OPTIONS} ariaLabel={`Access on ${key}`} />
        </div>
      ))}
    </div>
  );
}

const hasChosen = (map) => map === null || Object.values(map).some(Boolean);

function InstanceAccessDialog({ user, onClose, onSaved, onAuthError }) {
  const [value, setValue] = useState(user.instances ? { ...user.instances } : null);
  const { busy, error, setError, run } = useAction(onAuthError);
  const knownKeys = useMemo(() => Object.keys(user.instances || {}), [user]);

  async function submit(e) {
    e.preventDefault();
    if (!hasChosen(value)) return setError('Choose at least one instance, or pick All instances.');
    const res = await run(() => api.updateUser(user.username, { instances: value }));
    if (res) onSaved(res.user);
    return undefined;
  }

  return (
    <Dialog title={`Instance access for ${user.username}`} onClose={busy ? () => {} : onClose} wide>
      <form onSubmit={submit}>
        <InstanceAccessChoice
          value={value}
          onChange={(v) => {
            setValue(v);
            setError('');
          }}
          knownKeys={knownKeys}
          onAuthError={onAuthError}
          disabled={busy}
        />
        <ErrorText>{error}</ErrorText>
        <div className="buttons">
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------- add / reset / delete ----------

function AddUser({ onAdded, onAuthError }) {
  const [username, setUsername] = useState('');
  const [permissions, setPermissions] = useState('read');
  const [instances, setInstances] = useState(null);
  const [generate, setGenerate] = useState(true);
  const [password, setPassword] = useState('');
  const { busy, error, setError, run } = useAction(onAuthError);

  async function submit(e) {
    e.preventDefault();
    if (!hasChosen(instances)) return setError('Choose at least one instance, or pick All instances.');
    const name = username.trim();
    const res = await run(() =>
      api.addUser({ username: name, permissions, ...(instances && { instances }), ...(generate ? { generate: true } : { password }) }),
    );
    if (!res) return undefined;
    onAdded(name, res.password);
    setUsername('');
    setPassword('');
    setInstances(null);
    return undefined;
  }

  return (
    <Card title="Add user" className="page-card">
      <form className="grid add-user" onSubmit={submit}>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="name@upande.com" autoComplete="off" required />
        </label>
        <div className="field">
          <span className="field-label">Access</span>
          <Select value={permissions} onChange={setPermissions} options={PERMISSION_OPTIONS} ariaLabel="Access" />
        </div>
        <fieldset className="choice">
          <legend className="field-label">Password</legend>
          <PasswordChoice generate={generate} setGenerate={setGenerate} password={password} setPassword={setPassword} />
        </fieldset>
        <InstanceAccessChoice
          value={instances}
          onChange={(v) => {
            setInstances(v);
            setError('');
          }}
          onAuthError={onAuthError}
        />
        <ErrorText>{error}</ErrorText>
        <div>
          <button disabled={busy}>{busy ? 'Adding…' : 'Add user'}</button>
        </div>
      </form>
    </Card>
  );
}

function ResetDialog({ username, onClose, onDone, onAuthError }) {
  const [generate, setGenerate] = useState(true);
  const [password, setPassword] = useState('');
  const { busy, error, run } = useAction(onAuthError);

  async function submit(e) {
    e.preventDefault();
    const res = await run(() => api.updateUser(username, generate ? { generate: true } : { password }));
    if (res) onDone(res.password);
  }

  return (
    <Dialog title={`Reset password for ${username}`} onClose={busy ? () => {} : onClose}>
      <form onSubmit={submit}>
        <PasswordChoice generate={generate} setGenerate={setGenerate} password={password} setPassword={setPassword} />
        <ErrorText>{error}</ErrorText>
        <div className="buttons">
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button disabled={busy}>{busy ? 'Resetting…' : 'Reset password'}</button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteDialog({ username, onClose, onDone, onAuthError }) {
  const { busy, error, run } = useAction(onAuthError);
  const confirmDelete = useCallback(async () => {
    const res = await run(() => api.deleteUser(username));
    if (res) onDone();
  }, [run, username, onDone]);

  return (
    <ConfirmDialog title="Delete user" confirmLabel="Delete user" busyLabel="Deleting…" danger onConfirm={confirmDelete} onClose={onClose} error={error} busy={busy}>
      <p>
        Delete <strong>{username}</strong>? They will no longer be able to log in to Node-RED or this page.
      </p>
    </ConfirmDialog>
  );
}
