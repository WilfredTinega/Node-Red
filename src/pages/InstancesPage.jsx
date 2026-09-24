import { useCallback, useRef, useState } from 'react';
import { api } from '../api.js';
import { Card, CodeBlock, ConfirmDialog, Dialog, ErrorText, Notice, PageHeader, ProgressBar, Skeleton, Status, useLoad } from '../ui.jsx';
import { useActivity } from '../activity.jsx';
import './InstancesPage.css';

const STATUS_LABELS = { online: 'Online', offline: 'Stopped', unreachable: 'Not responding' };
const LOGIN_LABELS = { required: 'Login required', open: 'No login' };

const kindOf = (i) => (i.source === 'docker' ? 'docker' : i.host ? 'remote' : 'package');
const rowKey = (i) => `${i.source}-${i.container || ''}-${i.host || ''}-${i.port}-${i.name}`;
const rowBusyKey = (i) => i.container || `host-${i.port}`;

export default function InstancesPage({ me, onAuthError }) {
  const { data, error, loading, reload } = useLoad(api.listInstances, onAuthError, 30000);
  const [confirm, setConfirm] = useState(null); // { action: 'restart' | 'update' | 'connect', instance }
  const [dialog, setDialog] = useState(null); // { type: 'package-update' | 'connect', instance }  (fallback when the host agent is absent)
  const [busy, setBusy] = useState({}); // row key -> 'restart' | 'update' | 'connect'
  const [progress, setProgress] = useState({}); // row key -> percent
  const timers = useRef({});
  const { push } = useActivity();

  const host = data?.publicHost || window.location.hostname;
  const instances = data?.instances || [];
  const online = instances.filter((i) => i.status === 'online').length;
  const canManageContainers = me.admin && data?.canManageContainers;
  const canManageHost = me.admin && data?.canManageHost;

  // The server doesn't stream progress, so ease a bar toward ~95% over the
  // action's typical duration, then jump to 100% when it actually finishes.
  const startProgress = useCallback((key, action) => {
    const estimate = { restart: 12000, connect: 35000, update: 70000 }[action] || 20000;
    const started = Date.now();
    setProgress((p) => ({ ...p, [key]: 0 }));
    clearInterval(timers.current[key]);
    timers.current[key] = setInterval(() => {
      const elapsed = Date.now() - started;
      const pct = 95 * (1 - Math.exp(-elapsed / (estimate * 0.5)));
      setProgress((p) => ({ ...p, [key]: pct }));
    }, 300);
  }, []);

  const finishProgress = useCallback((key, ok) => {
    clearInterval(timers.current[key]);
    delete timers.current[key];
    if (ok) {
      setProgress((p) => ({ ...p, [key]: 100 }));
      setTimeout(() => setProgress((p) => ({ ...p, [key]: undefined })), 500);
    } else {
      setProgress((p) => ({ ...p, [key]: undefined }));
    }
  }, []);

  const runAction = useCallback(
    async (action, instance) => {
      const docker = Boolean(instance.container);
      const key = rowBusyKey(instance);
      setConfirm(null);
      setBusy((b) => ({ ...b, [key]: action }));
      startProgress(key, action);
      const call = docker
        ? { restart: api.restartInstance, update: api.updateInstance, connect: api.connectInstance }[action].bind(null, instance.container)
        : { restart: api.restartHost, update: api.updateHost, connect: api.connectHost }[action].bind(null, instance.port);
      let ok = false;
      try {
        const res = await call();
        ok = true;
        push({ kind: 'ok', title: instance.name, message: res.message || 'Done.', steps: res.steps });
      } catch (err) {
        onAuthError(err);
        push({ kind: 'error', title: instance.name, message: err.message, steps: err.data?.steps });
      } finally {
        finishProgress(key, ok);
        setBusy((b) => {
          const next = { ...b };
          delete next[key];
          return next;
        });
        reload();
      }
    },
    [onAuthError, reload, push, startProgress, finishProgress],
  );

  const closeDialog = useCallback(() => setDialog(null), []);
  const closeConfirm = useCallback(() => setConfirm(null), []);

  return (
    <>
      <PageHeader
        title="Instances"
        subtitle={data ? `${host} · ${online} of ${instances.length} online` : host}
        actions={
          <button className="ghost" onClick={reload} disabled={loading}>
            {loading ? 'Checking…' : 'Refresh'}
          </button>
        }
      />

      <Card className="page-card">
        <ErrorText>{error}</ErrorText>
        {data?.errors?.map((e) => (
          <Notice key={e} kind="error">
            {e}
          </Notice>
        ))}
        {!data && !error && (
          <div className="table-wrap">
            <table className="instances-table">
              <tbody>
                {Array.from({ length: 3 }, (_, i) => (
                  <tr key={i}>
                    <td>
                      <Skeleton w="60%" />
                    </td>
                    <td>
                      <Skeleton w="70%" />
                    </td>
                    <td>
                      <Skeleton w="50%" />
                    </td>
                    <td>
                      <Skeleton w="40%" />
                    </td>
                    <td>
                      <Skeleton w="50%" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && instances.length === 0 && <p className="muted">No Node-RED instances found.</p>}
        {instances.length > 0 && (
          <div className="table-wrap">
            <table className="instances-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Address</th>
                  <th>Version</th>
                  <th>Status</th>
                  <th>Login</th>
                  {me.admin && (
                    <th>
                      <span className="visually-hidden">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {instances.map((i) => (
                  <InstanceRow
                    key={rowKey(i)}
                    instance={i}
                    host={host}
                    admin={me.admin}
                    canManageContainers={canManageContainers}
                    canManageHost={canManageHost}
                    busy={busy[rowBusyKey(i)]}
                    progress={progress[rowBusyKey(i)]}
                    onConfirm={(action) => setConfirm({ action, instance: i })}
                    onDialog={(type) => setDialog({ type, instance: i })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {confirm?.action === 'restart' && (
        <ConfirmDialog title={`Restart ${confirm.instance.name}`} confirmLabel="Restart" onConfirm={() => runAction('restart', confirm.instance)} onClose={closeConfirm}>
          <p>The editor and running flows stop for a few seconds.</p>
        </ConfirmDialog>
      )}
      {confirm?.action === 'update' && (
        <ConfirmDialog title={`Update ${confirm.instance.name}`} confirmLabel="Update" onConfirm={() => runAction('update', confirm.instance)} onClose={closeConfirm}>
          {confirm.instance.image && (
            <p>
              <code>{confirm.instance.image}</code>
            </p>
          )}
          <p>Flows stop while it runs.</p>
        </ConfirmDialog>
      )}
      {confirm?.action === 'connect' && (
        <ConfirmDialog title={`Connect ${confirm.instance.name}`} confirmLabel="Connect" onConfirm={() => runAction('connect', confirm.instance)} onClose={closeConfirm}>
          <p>
            Logins on {confirm.instance.name} will use the shared accounts. Its <code>settings.js</code> is backed up first, then it restarts.
          </p>
        </ConfirmDialog>
      )}

      {dialog?.type === 'package-update' && <PackageUpdateDialog instance={dialog.instance} onClose={closeDialog} />}
      {dialog?.type === 'connect' && <ConnectDialog instance={dialog.instance} authHostDir={data?.authHostDir || '/opt/nodered-auth'} onClose={closeDialog} />}
    </>
  );
}

const BUSY_LABELS = { restart: 'Restarting…', update: 'Updating…', connect: 'Connecting…' };

function InstanceRow({ instance: i, host, admin, canManageContainers, canManageHost, busy, progress, onConfirm, onDialog }) {
  const kind = kindOf(i);
  const address = i.port ? `${i.host || (i.localOnly ? '127.0.0.1' : host)}:${i.port}` : null;
  const needsConnect = kind !== 'remote' && (i.login !== 'required' || i.sharedLogins === false);
  // The container shares the accounts file but doesn't know its own key, so
  // per-instance rules can't apply to it. Connect shows what to set.
  const keyWhy = i.keyMismatch
    ? `NODERED_INSTANCE is ${i.instanceEnv ?? 'not set'}; this instance's key is ${i.port ?? i.key ?? 'its port'}. Per-instance access rules will not work until it is set.`
    : null;

  return (
    <tr>
      <td>
        <span className="instance-name">{i.name}</span>
        <span className="tag" title={kind === 'package' ? 'Installed with npm, not in Docker' : kind === 'remote' ? 'On another machine' : undefined}>
          {kind}
        </span>
        {keyWhy &&
          (admin ? (
            <button type="button" className="tag warn" title={keyWhy} onClick={() => onDialog('connect')}>
              instance key
            </button>
          ) : (
            <span className="tag warn" title={keyWhy}>
              instance key
            </span>
          ))}
      </td>
      <td className="nowrap">
        {address && i.localOnly ? (
          <span title="Only reachable from the server itself">
            {address}
            <span className="tag">server only</span>
          </span>
        ) : address ? (
          <a href={`http://${address}`} target="_blank" rel="noreferrer">
            {address}
          </a>
        ) : (
          <span className="muted">No published port</span>
        )}
      </td>
      <td className={i.version ? undefined : 'muted'}>{i.version || '—'}</td>
      <td className="nowrap">
        <Status status={i.status} label={STATUS_LABELS[i.status] || i.status} title={i.detail} />
      </td>
      <td className={`nowrap${i.login === 'open' ? ' error' : ''}`}>{LOGIN_LABELS[i.login] || (i.login && i.login !== 'unknown' ? i.login : '—')}</td>
      {admin && (
        <td>
          {/* While an action runs the buttons are replaced by a progress bar, so
              the row doesn't jump as button labels change. */}
          {busy ? (
            <ProgressBar percent={progress ?? 0} label={BUSY_LABELS[busy] || 'Working…'} />
          ) : (
            <div className="actions">
              {/* Live buttons when we can manage this kind: Docker via the proxy,
                  host installs via the host agent. Otherwise the instruction dialog. */}
              {((kind === 'docker' && canManageContainers && i.container) || (kind === 'package' && canManageHost)) && (
                <>
                  <button className="ghost small" onClick={() => onConfirm('restart')}>
                    Restart
                  </button>
                  <button className="ghost small" onClick={() => onConfirm('update')}>
                    Update
                  </button>
                  {needsConnect && (
                    <button className="ghost small" onClick={() => onConfirm('connect')}>
                      Connect
                    </button>
                  )}
                </>
              )}
              {/* Fallback: no live management for this kind — show the manual steps. */}
              {kind === 'package' && !canManageHost && (
                <>
                  <button className="ghost small" onClick={() => onDialog('package-update')}>
                    Update…
                  </button>
                  {needsConnect && (
                    <button className="ghost small" onClick={() => onDialog('connect')}>
                      Connect
                    </button>
                  )}
                </>
              )}
              {kind === 'docker' && !canManageContainers && needsConnect && (
                <button className="ghost small" onClick={() => onDialog('connect')}>
                  Connect
                </button>
              )}
            </div>
          )}
        </td>
      )}
    </tr>
  );
}

function PackageUpdateDialog({ instance, onClose }) {
  return (
    <Dialog title={`Update ${instance.name}`} onClose={onClose} wide>
      <p>Run on the server:</p>
      <CodeBlock>{'sudo npm install -g --unsafe-perm node-red@latest\nsudo systemctl restart nodered'}</CodeBlock>
      <p className="muted">
        Installed with the Node-RED install script? Run <code>node-red-restart</code> instead of the systemctl command.
      </p>
      <div className="buttons">
        <button onClick={onClose}>Done</button>
      </div>
    </Dialog>
  );
}

function ConnectDialog({ instance, authHostDir, onClose }) {
  const kind = kindOf(instance);
  const port = instance.port || 1880;
  const [tab, setTab] = useState(kind === 'docker' ? 'docker' : 'package');

  return (
    <Dialog title={`Connect ${instance.name} to the shared accounts`} onClose={onClose} wide>
      <p className="before-title">Before you switch</p>
      <ol className="steps before-steps">
        <li>
          Change the <code>administrator</code> password and add everyone who needs access on the Users page first.
        </li>
        <li>
          Back up the instance&apos;s current <code>settings.js</code>.
        </li>
        <li>
          Keep the same <code>/data</code> (or <code>~/.node-red</code>) when recreating the container.
        </li>
      </ol>

      <div className="segmented" role="group" aria-label="Install type">
        {[
          ['docker', 'Docker'],
          ['package', 'Package install'],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            className={`ghost small${tab === id ? ' selected' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'docker' ? (
        <ol className="steps">
          <li>
            Recreate the container with these options added (in compose: under <code>volumes</code> and <code>environment</code>). The accounts folder is
            mounted read-only:
            <CodeBlock>{`-v ${authHostDir}:/auth:ro\n-e NODERED_INSTANCE=${port}`}</CodeBlock>
          </li>
          <li>
            In <code>/data/settings.js</code>, replace any existing <code>adminAuth</code> block with:
            <CodeBlock>{`adminAuth: require('/auth/adminAuth.js'),`}</CodeBlock>
          </li>
          <li>
            Restart the container:
            <CodeBlock>{`docker restart ${kind === 'docker' ? instance.name : '<container>'}`}</CodeBlock>
          </li>
        </ol>
      ) : (
        <ol className="steps">
          <li>
            In <code>~/.node-red/settings.js</code>, replace any existing <code>adminAuth</code> block with:
            <CodeBlock>{`adminAuth: require('${authHostDir}/adminAuth.js'),`}</CodeBlock>
          </li>
          {port !== 1880 && (
            <li>
              Node-RED listens on {port}, so add this under <code>[Service]</code> in its systemd unit (<code>sudo systemctl edit nodered</code>):
              <CodeBlock>{`Environment=NODERED_INSTANCE=${port}`}</CodeBlock>
            </li>
          )}
          <li>
            Restart Node-RED:
            <CodeBlock>{'sudo systemctl restart nodered'}</CodeBlock>
          </li>
        </ol>
      )}

      <div className="buttons">
        <button onClick={onClose}>Done</button>
      </div>
    </Dialog>
  );
}
