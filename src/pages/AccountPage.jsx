import { useState } from 'react';
import { api } from '../api.js';
import { Card, ConfirmDialog, MIN_PASSWORD, Notice, PageHeader, PasswordInput, useAction } from '../ui.jsx';

export default function AccountPage({ me, setMe, onAuthError }) {
  return (
    <>
      <PageHeader title="My account" />
      <Card title="Profile">
        <dl className="details">
          <dt>Username</dt>
          <dd>{me.username}</dd>
          <dt>Access</dt>
          <dd>{me.admin ? 'Full access (admin)' : me.instances ? 'Set per instance' : 'Read only'}</dd>
          <dt>Instances</dt>
          <dd>{me.instances ? `${Object.keys(me.instances).length} chosen instances` : 'All instances'}</dd>
        </dl>
        {me.locked && <Notice>This is the built-in administrator account. It always has full access and cannot be deleted.</Notice>}
      </Card>
      {me.admin && <FullAccessCard me={me} setMe={setMe} onAuthError={onAuthError} />}
      <ChangePassword onAuthError={onAuthError} />
    </>
  );
}

// An admin can step down to read only; only another admin can restore it.
// The built-in administrator can't, so there is always a way back in.
function FullAccessCard({ me, setMe, onAuthError }) {
  const [asking, setAsking] = useState(false);
  const { busy, error, setError, run } = useAction(onAuthError);

  async function confirm() {
    const user = await run(() => api.demoteSelf());
    if (user) {
      setAsking(false);
      setMe(user);
    }
  }

  return (
    <Card title="Full access">
      {me.locked ? (
        <p className="muted">This account always keeps full access.</p>
      ) : (
        <>
          <p>You have full access on this dashboard and on every instance.</p>
          <button
            type="button"
            className="ghost danger"
            onClick={() => {
              setError('');
              setAsking(true);
            }}
          >
            Give up full access
          </button>
        </>
      )}
      {asking && (
        <ConfirmDialog title="Give up full access?" confirmLabel="Give up full access" busyLabel="Saving…" danger onConfirm={confirm} onClose={() => setAsking(false)} error={error} busy={busy}>
          <p>
            Your account becomes <strong>read only</strong> on this dashboard and on every instance, immediately. You will no longer be able to manage
            users, backups or GitHub here, or deploy flows.
          </p>
          <p>Only an admin can give you full access back.</p>
        </ConfirmDialog>
      )}
    </Card>
  );
}

function ChangePassword({ onAuthError }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [message, setMessage] = useState(null); // { ok, text }
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (next !== repeat) return setMessage({ ok: false, text: 'The new passwords do not match.' });
    setBusy(true);
    try {
      await api.changeOwnPassword(current, next);
      setCurrent('');
      setNext('');
      setRepeat('');
      setMessage({ ok: true, text: 'Password changed. Use it next time you log in to Node-RED.' });
    } catch (err) {
      onAuthError(err);
      setMessage({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Change password">
      <form className="grid" onSubmit={submit}>
        <label>
          Current password
          <PasswordInput value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </label>
        <label>
          New password
          <PasswordInput value={next} onChange={(e) => setNext(e.target.value)} minLength={MIN_PASSWORD} autoComplete="new-password" required />
        </label>
        <label>
          Repeat new password
          <PasswordInput value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" required />
        </label>
        {message && <p className={message.ok ? 'ok' : 'error'}>{message.text}</p>}
        <div>
          <button disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
        </div>
      </form>
    </Card>
  );
}
