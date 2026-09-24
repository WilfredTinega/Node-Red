import { api } from '../api.js';
import { Card, ErrorText, PageHeader, SkeletonLines, formatWhen, timeAgo, useLoad } from '../ui.jsx';
import { Steps } from '../activity.jsx';

const ACTION_LABELS = { restart: 'Restarted', update: 'Updated', connect: 'Connected', backup: 'Backup' };

// A durable, server-side log of the actions taken from the dashboard and who
// ran them. Shared by every admin and kept across restarts (never cleared here).
export default function ActivityPage({ onAuthError }) {
  const { data, error, loading, reload } = useLoad(api.getActivity, onAuthError, 20000);
  const entries = data?.entries || [];

  return (
    <>
      <PageHeader
        title="Activity"
        subtitle={data ? `${entries.length} recorded action${entries.length === 1 ? '' : 's'}` : undefined}
        actions={
          <button className="ghost" onClick={reload} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      />
      <Card className="page-card">
        <ErrorText>{error}</ErrorText>
        {!data && !error && <SkeletonLines lines={6} />}
        {data && entries.length === 0 && <p className="muted">No actions yet. Restart, Update, Connect and backup results are recorded here.</p>}
        {entries.length > 0 && (
          <ul className="activity-log">
            {entries.map((e, n) => (
              <li key={n} className={`activity-item ${e.ok ? 'ok' : 'error'}`}>
                <div className="activity-head">
                  <span className={`dot ${e.ok ? 'ok' : 'error'}`} aria-hidden="true" />
                  <strong>
                    {ACTION_LABELS[e.action] || e.action} · {e.target}
                  </strong>
                  <span className="activity-time" title={formatWhen(e.at)}>
                    {timeAgo(e.at)}
                  </span>
                </div>
                <div className="activity-meta">
                  by <strong>{e.user}</strong>
                  {e.message ? ` — ${e.message}` : ''}
                </div>
                <Steps steps={e.steps} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
