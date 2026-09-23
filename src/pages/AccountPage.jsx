import { useState } from 'react';
import { api } from '../api.js';
import { Card, MIN_PASSWORD, Notice, PageHeader } from '../ui.jsx';

export default function AccountPage({ me, onAuthError }) {
  return (
    <>
      <PageHeader title="My account" />
      <Card title="Profile">
        <dl className="details">
          <dt>Username</dt>
          <dd>{me.username}</dd>
          <dt>Access</dt>
          <dd>{me.admin ? 'Full access (admin)' : 'Read only'}</dd>
          <dt>Instances</dt>
          <dd>{me.instances ? `${Object.keys(me.instances).length} chosen instances` : 'All instances'}</dd>
        </dl>
        {me.locked && <Notice>This is the built-in administrator account. It always has full access and cannot be deleted.</Notice>}
      </Card>
      <ChangePassword onAuthError={onAuthError} />
    </>
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
          <button disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
        </div>
      </form>
    </Card>
  );
}
