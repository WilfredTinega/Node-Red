// Shared building blocks for every page. Pages import from here instead of
// defining their own dialogs, buttons or date formatting.
import { useCallback, useEffect, useId, useRef, useState } from 'react';

export const MIN_PASSWORD = 10;

export const PERMISSION_OPTIONS = [
  { value: '*', label: 'Full access', hint: 'Edit and deploy flows, manage users' },
  { value: 'read', label: 'Read only', hint: 'View flows, cannot deploy' },
];

// ---------- data loading ----------

// Runs `fn` on mount (and every `intervalMs` if given). A 401 anywhere sends
// the app back to the login screen through onAuthError.
export function useLoad(fn, onAuthError, intervalMs) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fnRef.current());
      setError('');
    } catch (err) {
      onAuthError(err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [onAuthError]);

  useEffect(() => {
    reload();
    if (!intervalMs) return undefined;
    const t = setInterval(reload, intervalMs);
    return () => clearInterval(t);
  }, [reload, intervalMs]);

  return { data, setData, error, setError, loading, reload };
}

// Wraps an async action with busy + error state for a button or form.
export function useAction(onAuthError) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = useCallback(
    async (fn) => {
      setBusy(true);
      setError('');
      try {
        return await fn();
      } catch (err) {
        onAuthError(err);
        setError(err.message);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [onAuthError],
  );
  return { busy, error, setError, run };
}

// ---------- formatting ----------

export function formatWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const future = s < 0;
  const a = Math.abs(s);
  const [n, unit] = a < 60 ? [a, 'second'] : a < 3600 ? [Math.round(a / 60), 'minute'] : a < 86400 ? [Math.round(a / 3600), 'hour'] : [Math.round(a / 86400), 'day'];
  const label = `${n} ${unit}${n === 1 ? '' : 's'}`;
  return future ? `in ${label}` : `${label} ago`;
}

export const shortSha = (sha) => (sha && sha !== 'dev' ? sha.slice(0, 7) : sha || '—');

// ---------- layout pieces ----------

export function Card({ title, actions, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="section-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="head-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="head-actions">{actions}</div>}
    </div>
  );
}

export function ErrorText({ children }) {
  return children ? <p className="error">{children}</p> : null;
}

// kind: 'info' | 'ok' | 'warn' | 'error'
export function Notice({ kind = 'info', children }) {
  return <div className={`notice ${kind}`}>{children}</div>;
}

export function Status({ status, label, title }) {
  return (
    <span className={`status ${status}`} title={title}>
      <span className="dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export function CopyButton({ text, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ghost small"
      onClick={() =>
        navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => {},
        )
      }
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

// A code block with a copy button, for commands and settings snippets.
export function CodeBlock({ children }) {
  return (
    <div className="codeblock">
      <pre>
        <code>{children}</code>
      </pre>
      <CopyButton text={children} />
    </div>
  );
}

// ---------- dialogs ----------

export function Dialog({ title, onClose, children, wide = false }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`card dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

// Confirmation modal for anything irreversible or disruptive (never window.confirm).
export function ConfirmDialog({ title, children, confirmLabel, busyLabel, danger = false, onConfirm, onClose, error, busy }) {
  return (
    <Dialog title={title} onClose={busy ? () => {} : onClose}>
      {children}
      <ErrorText>{error}</ErrorText>
      <div className="buttons">
        <button type="button" className="ghost" onClick={onClose} disabled={busy} autoFocus>
          Cancel
        </button>
        <button type="button" className={danger ? 'destructive' : undefined} onClick={onConfirm} disabled={busy}>
          {busy ? busyLabel || 'Working…' : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

// "Generate or type a password" control used by Add user and Reset password.
export function PasswordChoice({ generate, setGenerate, password, setPassword }) {
  // A shared name makes the two radios one group, so arrow keys move between them.
  const name = useId();
  return (
    <fieldset className="choice">
      <label className="inline">
        <input type="radio" name={name} checked={generate} onChange={() => setGenerate(true)} />
        Generate a random password
      </label>
      <label className="inline">
        <input type="radio" name={name} checked={!generate} onChange={() => setGenerate(false)} />
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

export function ShownPassword({ username, password, onClose }) {
  return (
    <Dialog title="New password" onClose={onClose}>
      <p>
        New password for <strong>{username}</strong>. Copy it and send it to them securely.
      </p>
      <div className="secret">
        <code>{password}</code>
        <CopyButton text={password} />
      </div>
      <div className="buttons">
        <button onClick={onClose}>Done</button>
      </div>
    </Dialog>
  );
}

// ---------- icons (16px, stroke = currentColor) ----------

const paths = {
  instances: 'M2.5 3.5h11v4h-11zM2.5 8.5h11v4h-11zM5 5.5h.01M5 10.5h.01',
  users: 'M6 7a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM1.5 14c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5M11 2.2a2.5 2.5 0 010 4.6M12.5 9.8c1.2.6 2 1.9 2 3.7',
  backup: 'M8 2v8M4.5 6.5L8 10l3.5-3.5M2.5 11v2.5h11V11',
  github: 'M8 1.5a6.5 6.5 0 00-2 12.7c.3 0 .5-.2.5-.4v-1.3c-1.8.4-2.2-.8-2.2-.8-.3-.8-.7-1-.7-1-.6-.4 0-.4 0-.4.7 0 1 .7 1 .7.6 1 1.6.7 2 .5 0-.4.2-.7.4-.9-1.4-.2-3-.7-3-3.2 0-.7.3-1.3.7-1.7 0-.2-.3-.9.1-1.8 0 0 .5-.2 1.8.7a6 6 0 013.2 0c1.2-.9 1.8-.7 1.8-.7.3.9.1 1.6 0 1.8.4.4.7 1 .7 1.7 0 2.5-1.5 3-3 3.2.3.2.5.6.5 1.2v1.8c0 .2.1.5.5.4A6.5 6.5 0 008 1.5z',
  account: 'M8 8a3 3 0 100-6 3 3 0 000 6zM2.5 14.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5',
  menu: 'M2.5 4h11M2.5 8h11M2.5 12h11',
  lock: 'M3 7h10v7H3zM5.5 7V5a2.5 2.5 0 015 0v2',
  logout: 'M6 14H3V2h3M10.5 11L14 8l-3.5-3M14 8H6',
};

export function Icon({ name, size = 16 }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" className="icon">
      <path d={paths[name]} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function LockedBadge({ label = 'Full access', title }) {
  return (
    <span className="locked" title={title}>
      <Icon name="lock" size={14} />
      {label}
    </span>
  );
}
