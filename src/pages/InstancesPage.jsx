import { useCallback, useState } from 'react';
import { api } from '../api.js';
import { Card, CodeBlock, ConfirmDialog, Dialog, ErrorText, Notice, PageHeader, Status, useLoad } from '../ui.jsx';
import './InstancesPage.css';

const STATUS_LABELS = { online: 'Online', offline: 'Stopped', unreachable: 'Not responding' };
const LOGIN_LABELS = { required: 'Login required', open: 'No login' };

const kindOf = (i) => (i.source === 'docker' ? 'docker' : i.host ? 'remote' : 'package');
const rowKey = (i) => `${i.source}-${i.container || ''}-${i.host || ''}-${i.port}-${i.name}`;

export default function InstancesPage({ me, onAuthError }) {
  const { data, error, loading, reload } = useLoad(api.listInstances, onAuthError, 30000);
  const [confirm, setConfirm] = useState(null); // { action: 'restart' | 'update', instance }
  const [dialog, setDialog] = useState(null); // { type: 'package-update' | 'connect', instance }
  const [busy, setBusy] = useState({}); // container id -> 'restart' | 'update'
  const [results, setResults] = useState([]); // [{ id, ok, text }]

  const host = data?.publicHost || window.location.hostname;
  const instances = data?.instances || [];
  const online = instances.filter((i) => i.status === 'online').length;
  const canManage = me.admin && data?.canManageContainers;

  const runAction = useCallback(
    async (action, instance) => {
      const id = instance.container;
      setConfirm(null);
      setBusy((b) => ({ ...b, [id]: action }));
      const resultId = `${Date.now()}-${id}`;
      try {
        const res = await (action === 'restart' ? api.restartInstance(id) : api.updateInstance(id));
        const text = action === 'restart' ? `${instance.name}: ${res.message || 'Restarted.'}` : res.message || `${instance.name} updated.`;
        setResults((r) => [{ id: resultId, ok: true, text }, ...r]);
      } catch (err) {
        onAuthError(err);
        setResults((r) => [{ id: resultId, ok: false, text: `${instance.name}: ${err.message}` }, ...r]);
      } finally {
        setBusy((b) => {
          const next = { ...b };
          delete next[id];
          return next;
        });
        reload();
      }
    },
    [onAuthError, reload],
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

      {results.map((r) => (
        <div key={r.id} className={`notice result ${r.ok ? 'ok' : 'error'}`} role="status">
          <span>{r.text}</span>
          <button className="ghost small" onClick={() => setResults((all) => all.filter((x) => x.id !== r.id))}>
            Dismiss
          </button>
        </div>
      ))}

      <Card className="page-card">
        <ErrorText>{error}</ErrorText>
        {data?.errors?.map((e) => (
          <Notice key={e} kind="error">
            {e}
          </Notice>
        ))}
        {!data && !error && <p className="muted">Looking for instances…</p>}
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
                    canManage={canManage}
                    busy={i.container ? busy[i.container] : undefined}
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
          <p>Restart the container? The editor and running flows stop for a few seconds.</p>
        </ConfirmDialog>
      )}
      {confirm?.action === 'update' && (
        <ConfirmDialog title={`Update ${confirm.instance.name}`} confirmLabel="Update" onConfirm={() => runAction('update', confirm.instance)} onClose={closeConfirm}>
          <p>
            Pulls the newest image for the container&apos;s current tag
            {confirm.instance.image && (
              <>
                {' '}
                (<code>{confirm.instance.image}</code>)
              </>
            )}{' '}
            and recreates it with the same ports, volumes and settings. If the new container fails to start, the old one is restored.
          </p>
          <p className="muted">This can take a few minutes. Flows stop while it runs.</p>
        </ConfirmDialog>
      )}

      {dialog?.type === 'package-update' && <PackageUpdateDialog instance={dialog.instance} onClose={closeDialog} />}
      {dialog?.type === 'connect' && <ConnectDialog instance={dialog.instance} authHostDir={data?.authHostDir || '/opt/nodered-auth'} onClose={closeDialog} />}
    </>
  );
}

function InstanceRow({ instance: i, host, admin, canManage, busy, onConfirm, onDialog }) {
  const kind = kindOf(i);
  const address = i.port ? `${i.host || (i.localOnly ? '127.0.0.1' : host)}:${i.port}` : null;
  const needsConnect = kind !== 'remote' && (i.login !== 'required' || i.sharedLogins === false);

  return (
    <tr>
      <td>
        <span className="instance-name">{i.name}</span>
        <span className="tag" title={kind === 'package' ? 'Installed with npm, not in Docker' : kind === 'remote' ? 'On another machine' : undefined}>
          {kind}
        </span>
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
          <div className="actions">
            {kind === 'docker' && canManage && i.container && (
              <>
                <button className="ghost small" onClick={() => onConfirm('restart')} disabled={Boolean(busy)}>
                  {busy === 'restart' ? 'Restarting…' : 'Restart'}
                </button>
                <button className="ghost small" onClick={() => onConfirm('update')} disabled={Boolean(busy)}>
                  {busy === 'update' ? 'Updating…' : 'Update'}
                </button>
              </>
            )}
            {kind === 'package' && (
              <button className="ghost small" onClick={() => onDialog('package-update')}>
                Update…
              </button>
            )}
            {needsConnect && (
              <button className="ghost small" onClick={() => onDialog('connect')} disabled={Boolean(busy)}>
                Connect
              </button>
            )}
          </div>
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
      <p>After this, logins on this instance use the accounts and access set on the Users page.</p>

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
            Recreate the container with these options added (in compose: under <code>volumes</code> and <code>environment</code>):
            <CodeBlock>{`-v ${authHostDir}:/auth\n-e NODERED_INSTANCE=${port}`}</CodeBlock>
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
