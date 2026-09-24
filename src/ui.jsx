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

// timeZone: an IANA name to render in (e.g. the server's), else the browser's.
export function formatWhen(iso, timeZone) {
  if (!iso) return '—';
  const d = new Date(iso);
  const opts = { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  try {
    return d.toLocaleString(undefined, timeZone ? { ...opts, timeZone } : opts);
  } catch {
    // An unknown zone name: fall back to the browser's.
    return d.toLocaleString(undefined, opts);
  }
}

// A short timezone abbreviation (e.g. "UTC", "GMT+3") for the given zone, to
// render as a compact suffix beside a formatted time.
export function zoneAbbrev(timeZone, iso) {
  if (!timeZone) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(iso ? new Date(iso) : new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value || timeZone;
  } catch {
    return timeZone;
  }
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

// A shimmering placeholder shown while data loads. `w` is a CSS width.
export function Skeleton({ w = '100%', h = 14, radius = 6, className = '' }) {
  return <span className={`skeleton ${className}`} style={{ width: w, height: h, borderRadius: radius }} aria-hidden="true" />;
}

// A determinate progress bar with a percentage label. `percent` 0–100.
export function ProgressBar({ percent, label }) {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="progress-label">
        {label ? `${label} ` : ''}
        {pct}%
      </span>
    </div>
  );
}

// A block of skeleton lines, for a loading list/table.
export function SkeletonLines({ lines = 4 }) {
  return (
    <div className="skeleton-lines" role="status" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} w={`${90 - (i % 3) * 15}%`} />
      ))}
    </div>
  );
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

// A code block with a copy button, for commands and settings snippets. The
// button sits in its own bar, so long lines scroll under nothing.
export function CodeBlock({ children }) {
  return (
    <div className="codeblock">
      <div className="codeblock-bar">
        <CopyButton text={children} />
      </div>
      <pre>
        <code>{children}</code>
      </pre>
    </div>
  );
}

// ---------- dialogs ----------

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const isShown = (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;

// A modal: focus moves inside when it opens (an autoFocus control wins, else the
// first control), Tab cycles inside it, and closing puts focus back where it was.
export function Dialog({ title, onClose, children, wide = false }) {
  const ref = useRef(null);
  // Taken during the first render: by the time effects run, an autoFocus
  // control inside (ConfirmDialog's Cancel) already holds focus.
  const opener = useRef(null);
  if (opener.current === null) opener.current = document.activeElement || false;

  useEffect(() => {
    const el = ref.current;
    // A dialog replacing another in one step (Reset password -> New password)
    // saw a control that is gone now; the closed one has just restored focus.
    if (!(opener.current && document.contains(opener.current))) opener.current = document.activeElement || false;
    if (el && !el.contains(document.activeElement)) {
      const first = [...el.querySelectorAll(FOCUSABLE)].find(isShown);
      (first || el).focus();
    }
    return () => {
      const o = opener.current;
      // The opener may be gone (a deleted row): then leave focus where the browser put it.
      if (o && typeof o.focus === 'function' && document.contains(o)) o.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') return onClose();
      if (e.key !== 'Tab' || !ref.current) return undefined;
      const items = [...ref.current.querySelectorAll(FOCUSABLE)].filter(isShown);
      const active = document.activeElement;
      const inside = ref.current.contains(active);
      if (items.length === 0) {
        e.preventDefault();
        return ref.current.focus();
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (!inside || (e.shiftKey && (active === first || active === ref.current))) {
        e.preventDefault();
        return (e.shiftKey ? last : first).focus();
      }
      if (!e.shiftKey && active === last) {
        e.preventDefault();
        return first.focus();
      }
      return undefined;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="backdrop"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        // Without this the browser moves focus to the page after the handler,
        // undoing the focus we just gave back to the opener.
        e.preventDefault();
        onClose();
      }}
    >
      <div ref={ref} className={`card dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
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

// A labelled password box with an eye button that shows or hides what was
// typed. The button sits outside the <label>, so the field's accessible name
// stays just the label text.
export function PasswordInput({ label, value, onChange, autoComplete = 'current-password', ...rest }) {
  const [shown, setShown] = useState(false);
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <span className="password-field">
        <input id={id} type={shown ? 'text' : 'password'} value={value} onChange={onChange} autoComplete={autoComplete} {...rest} />
        <button
        type="button"
        className="ghost icon-button eye"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        title={shown ? 'Hide password' : 'Show password'}
      >
          <Icon name={shown ? 'eye-off' : 'eye'} />
        </button>
      </span>
    </div>
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
  close: 'M4 4l8 8M12 4l-8 8',
  activity: 'M1.5 8h3l2-5 3 10 2-5h3',
  eye: 'M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8zM8 10a2 2 0 100-4 2 2 0 000 4z',
  'eye-off': 'M1.5 8s2.5-4.5 6.5-4.5c1.2 0 2.3.4 3.2 1M14.5 8s-2.5 4.5-6.5 4.5c-1.2 0-2.3-.4-3.2-1M6.6 6.6a2 2 0 002.8 2.8M2 2l12 12',
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
