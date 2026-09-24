// Toast notifications for immediate feedback. The durable record of who did
// what lives on the server (the Activity page reads /api/activity); toasts are
// just the transient popup shown right after an action.
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Icon } from './ui.jsx';

const ActivityContext = createContext(null);
const SUCCESS_MS = 6000;

let seq = 0;
const nextId = () => `a${Date.now()}-${seq++}`;

export function ActivityProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);

  // kind: 'ok' | 'error' | 'info'. Shows a toast; returns its id.
  const push = useCallback((entry) => {
    const item = { id: nextId(), kind: 'info', ...entry };
    setToasts((ts) => [...ts, item]);
    return item.id;
  }, []);

  return (
    <ActivityContext.Provider value={{ toasts, push, dismiss }}>
      {children}
      <ToastHost toasts={toasts} dismiss={dismiss} />
    </ActivityContext.Provider>
  );
}

export const useActivity = () => useContext(ActivityContext);

// Steps list, shared by toasts and the log.
function Steps({ steps }) {
  if (!steps?.length) return null;
  return (
    <ul className="steps-result">
      {steps.map((s, n) => (
        <li key={n} className={s.ok ? 'ok' : 'error'}>
          {s.ok ? '✓' : '✗'} {s.name}
          {s.detail ? ` — ${s.detail}` : ''}
        </li>
      ))}
    </ul>
  );
}

function ToastHost({ toasts, dismiss }) {
  return (
    <div className="toast-host" role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onClose={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

function Toast({ toast, onClose }) {
  // Success/info auto-close; errors stay until dismissed so they can be read.
  useEffect(() => {
    if (toast.kind === 'error') return undefined;
    const timer = setTimeout(onClose, SUCCESS_MS);
    return () => clearTimeout(timer);
  }, [toast, onClose]);

  return (
    <div className={`toast ${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
      <div className="toast-body">
        {toast.title && <strong className="toast-title">{toast.title}</strong>}
        {toast.message && <span className="toast-message">{toast.message}</span>}
        <Steps steps={toast.steps} />
      </div>
      <button className="ghost icon-button toast-close" onClick={onClose} aria-label="Dismiss">
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

export { Steps };
