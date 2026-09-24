// Restart and update Node-RED containers through the Docker socket proxy.
// Update = pull the newest image for the container's own tag, then recreate
// the container with the same name, ports, volumes, env and networks.
const TIMEOUT = 30000;

// Registry credentials in the form the Docker Engine API expects.
export const registryAuth = (username, password, serveraddress) =>
  Buffer.from(JSON.stringify({ username, password, serveraddress })).toString('base64url');

// A tag after the last '/' — "host:5000/img" has a port, not a tag.
export function splitRef(ref) {
  const slash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  return colon > slash ? [ref.slice(0, colon), ref.slice(colon + 1)] : [ref, 'latest'];
}

// The pull stream is one JSON object per line and reports failures inline.
// A one-line stream parses as a single object, so handle both forms.
export function pullError(out) {
  const lines = typeof out === 'string' ? out.split('\n') : [out];
  for (const line of lines) {
    let msg;
    try {
      msg = typeof line === 'string' ? (line.trim() ? JSON.parse(line) : null) : line;
    } catch {
      continue;
    }
    if (msg && (msg.error || msg.errorDetail)) return msg.error || msg.errorDetail.message || 'unknown error';
  }
  return null;
}

export function createDocker(api) {
  async function call(method, path, body, timeout = TIMEOUT, extraHeaders = {}) {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: { ...(body && { 'Content-Type': 'application/json' }), ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok && res.status !== 304) {
      const msg = (data && data.message) || text || res.statusText;
      // The proxy answers 403 when the endpoint is not allowed by its settings.
      if (res.status === 403) throw new Error(`Docker refused ${method} ${path.split('?')[0]}: updates are not enabled on the Docker proxy.`);
      throw new Error(`Docker ${method} ${path.split('?')[0]}: ${res.status} ${msg}`);
    }
    return data;
  }

  const inspect = (id) => call('GET', `/containers/${id}/json`);

  async function restart(id) {
    await call('POST', `/containers/${id}/restart?t=10`, null, 60000);
    return { message: 'Restarted.' };
  }

  // Values the old image supplied are dropped, so the new image's defaults
  // (e.g. its NODE_RED_VERSION env) apply instead of being pinned to the old ones.
  function withoutImageDefaults(config, imageConfig) {
    const out = { ...config };
    const imageEnv = new Set(imageConfig.Env || []);
    out.Env = (config.Env || []).filter((e) => !imageEnv.has(e));
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    for (const key of ['Cmd', 'Entrypoint', 'WorkingDir', 'User', 'ExposedPorts', 'Volumes', 'Healthcheck', 'StopSignal']) {
      if (same(config[key], imageConfig[key])) delete out[key];
    }
    const imageLabels = imageConfig.Labels || {};
    out.Labels = Object.fromEntries(Object.entries(config.Labels || {}).filter(([k, v]) => imageLabels[k] !== v));
    return out;
  }

  // Pulls an image; the call streams progress and returns when it ends.
  // The stream reports failures inline, so check the image really arrived.
  async function pull(ref, auth) {
    const [fromImage, tag] = splitRef(ref);
    const out = await call(
      'POST',
      `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag)}`,
      null,
      10 * 60000,
      auth ? { 'X-Registry-Auth': auth } : {},
    );
    const failure = pullError(out);
    if (failure) throw new Error(`Pulling ${ref} failed: ${failure}`);
    return call('GET', `/images/${encodeURIComponent(`${fromImage}:${tag}`)}/json`);
  }

  async function update(id) {
    const old = await inspect(id);
    const name = old.Name.replace(/^\//, '');
    if (old.Config.Image.includes('@')) throw new Error(`${name} is pinned to an image digest; change it by hand.`);
    const [repo, tag] = splitRef(old.Config.Image);
    const ref = `${repo}:${tag}`;
    const pulled = await pull(ref);
    if (pulled.Id === old.Image) {
      await restart(id);
      return { updated: false, message: `Already on the newest ${ref}. Restarted it.` };
    }
    await recreate(id, ref);
    return { updated: true, message: `Updated ${name} to the newest ${ref} and started it.` };
  }

  // Replaces a container with one running `ref`, keeping everything else.
  // Rolls back to the old container if the new one won't start. `opts` may add
  // mounts (addBinds) and env (addEnv) — used by connect. A function in `opts`
  // is treated as the log callback (back-compat with recreate(id, ref, log)).
  async function recreate(id, ref, opts = {}) {
    if (typeof opts === 'function') opts = { log: opts };
    const { addBinds = [], addEnv = [], log = () => {} } = opts;
    const old = await inspect(id);
    const name = old.Name.replace(/^\//, '');
    // Stopping an --rm container deletes it and its anonymous volumes (its /data).
    if (old.HostConfig?.AutoRemove) throw new Error(`${name} was started with --rm, so stopping it would delete it; recreate it by hand.`);
    const oldImage = await call('GET', `/images/${old.Image}/json`).catch(() => ({ Config: {} }));
    const config = withoutImageDefaults(old.Config, oldImage.Config || {});
    config.Image = ref;
    // Add env that isn't already set (by name), and remember it for the bind step.
    const envNames = new Set((config.Env || []).map((e) => e.split('=')[0]));
    config.Env = [...(config.Env || []), ...addEnv.filter((e) => !envNames.has(e.split('=')[0]))];
    if (config.Hostname === old.Id.slice(0, 12)) delete config.Hostname;

    // Anonymous volumes aren't in Binds; carry them over by name, or the new
    // container would start with an empty /data and lose every flow.
    // Volumes given with --mount are already in HostConfig.Mounts; adding them
    // to Binds too would make create fail with "duplicate mount point".
    const hostConfig = { ...old.HostConfig };
    const binds = [...(hostConfig.Binds || [])];
    // An anonymous --mount (compose's `- /data`) has no Source; give it the
    // volume the old container used, or the new one gets a fresh, empty one.
    const volumeAt = (target) => (old.Mounts || []).find((m) => m.Type === 'volume' && m.Destination === target)?.Name;
    hostConfig.Mounts = (hostConfig.Mounts || []).map((m) =>
      m.Type === 'volume' && !m.Source && volumeAt(m.Target) ? { ...m, Source: volumeAt(m.Target) } : m,
    );
    if (hostConfig.Mounts.some((m) => m.Type === 'volume' && !m.Source)) {
      throw new Error(`${name} has a volume Docker can't name; recreate it by hand.`);
    }
    const mounted = new Set(hostConfig.Mounts.map((m) => m.Target));
    for (const m of old.Mounts || []) {
      if (m.Type === 'volume' && !mounted.has(m.Destination) && !binds.some((b) => b.split(':')[1] === m.Destination)) {
        binds.push(`${m.Name}:${m.Destination}${m.RW ? '' : ':ro'}`);
      }
    }
    // Add new binds (e.g. the /auth mount) if that target isn't already mounted.
    for (const b of addBinds) {
      const target = b.split(':')[1];
      if (!binds.some((x) => x.split(':')[1] === target) && !mounted.has(target)) binds.push(b);
    }
    hostConfig.Binds = binds;

    const endpoints = {};
    for (const [net, cfg] of Object.entries(old.NetworkSettings?.Networks || {})) {
      endpoints[net] = { Aliases: cfg.Aliases, IPAMConfig: cfg.IPAMConfig, Links: cfg.Links };
    }

    const backupName = `${name}-before-update-${Date.now()}`;
    log(`Stopping ${name}…`);
    await call('POST', `/containers/${id}/stop?t=20`, null, 60000);
    try {
      await call('POST', `/containers/${id}/rename?name=${encodeURIComponent(backupName)}`);
    } catch (e) {
      if (old.State?.Running !== false) await call('POST', `/containers/${id}/start`).catch(() => {});
      throw new Error(`Update failed and ${name} was restored: ${e.message}`);
    }

    let created = null;
    try {
      log('Starting the updated container…');
      created = await call('POST', `/containers/create?name=${encodeURIComponent(name)}`, {
        ...config,
        HostConfig: hostConfig,
        NetworkingConfig: { EndpointsConfig: endpoints },
      });
      await call('POST', `/containers/${created.Id}/start`);
      await new Promise((r) => setTimeout(r, 5000));
      const check = await inspect(created.Id);
      if (!check.State.Running) throw new Error(`the new container exited (code ${check.State.ExitCode})`);
    } catch (e) {
      // Put the old container back exactly as it was.
      if (created) await call('DELETE', `/containers/${created.Id}?force=true`).catch(() => {});
      await call('POST', `/containers/${id}/rename?name=${encodeURIComponent(name)}`).catch(() => {});
      if (old.State?.Running !== false) await call('POST', `/containers/${id}/start`).catch(() => {});
      throw new Error(`Update failed and ${name} was restored: ${e.message}`);
    }
    // No v=1 and no force: the old container's volumes stay, even anonymous ones.
    await call('DELETE', `/containers/${id}`).catch(() => {});
    return created.Id;
  }

  // The running container carrying `role` (e.g. this dashboard itself). With
  // `ownId` (this process's own container) only that one counts; without it,
  // more than one match is refused rather than guessed.
  async function findByRole(role, ownId = null) {
    const filters = encodeURIComponent(JSON.stringify({ label: [`nodered-admin.role=${role}`], status: ['running'] }));
    const list = (await call('GET', `/containers/json?filters=${filters}`)).filter((c) => !c.Labels || c.Labels['nodered-admin.role'] === role);
    if (ownId) return list.find((c) => c.Id.startsWith(ownId) || ownId.startsWith(c.Id)) || null;
    if (list.length > 1) throw new Error(`${list.length} running containers are labelled nodered-admin.role=${role}; stop the extra ones first.`);
    return list[0] || null;
  }

  // Starts a throwaway container from `image` that runs `cmd` on `network`
  // (the caller's own, so it reaches the Docker proxy the same way) and
  // removes itself afterwards.
  async function runHelper(image, cmd, env, network = 'host') {
    const helper = await call('POST', '/containers/create', {
      Image: image,
      Cmd: cmd,
      Env: env,
      Labels: { 'nodered-admin.role': 'updater' },
      HostConfig: { NetworkMode: network, AutoRemove: true },
    });
    await call('POST', `/containers/${helper.Id}/start`);
    return helper.Id;
  }

  // Run a command in a running container and return { code, output }.
  async function exec(id, cmd) {
    const created = await call('POST', `/containers/${id}/exec`, { AttachStdout: true, AttachStderr: true, Cmd: cmd });
    const out = await call('POST', `/exec/${created.Id}/start`, { Detach: false, Tty: true }, 60000);
    const info = await call('GET', `/exec/${created.Id}/json`);
    return { code: info.ExitCode ?? 0, output: typeof out === 'string' ? out : '' };
  }

  // Connect a container to the shared accounts: make its /data/settings.js load
  // the shared adminAuth (backed up first, idempotent), then recreate it with
  // the /auth mount and NODERED_INSTANCE so the change takes effect. Flows in
  // /data are untouched.
  async function connect(id, { authDir, hostPort, log = () => {} }) {
    const old = await inspect(id);
    const dataMount = (old.Mounts || []).some((m) => m.Destination === '/data');
    if (!dataMount) throw new Error('the container has no /data mount, so its settings cannot be edited safely');
    // Real newlines; the block contains single quotes, so it is passed to the
    // shell as an argument ($1) and written with `printf %s` — never embedded in
    // the script text, which would break the quoting and corrupt settings.js.
    const block =
      `\n// >>> nodered-user-admin: shared accounts (managed by the dashboard; do not edit)\n` +
      `process.env.NODERED_INSTANCE = process.env.NODERED_INSTANCE || '${hostPort}';\n` +
      `module.exports.adminAuth = require('/auth/adminAuth.js');\n` +
      `// <<< nodered-user-admin\n`;
    // Idempotent: skip if the block is already there; back up before appending.
    const script =
      `f=/data/settings.js; [ -f "$f" ] || { echo "no settings.js"; exit 1; }; ` +
      `grep -q "nodered-user-admin: shared accounts" "$f" || { cp "$f" "$f.bak-$(date +%Y%m%d-%H%M%S)"; printf '%s' "$1" >> "$f"; }`;
    log('Editing settings.js…');
    const r = await exec(id, ['sh', '-c', script, 'nrua', block]);
    if (r.code !== 0) throw new Error(`could not edit settings.js: ${r.output.trim() || `exit ${r.code}`}`);
    log('Recreating the container with the shared accounts mounted…');
    const newId = await recreate(id, old.Config.Image, {
      addBinds: [`${authDir}:/auth:ro`],
      addEnv: [`NODERED_INSTANCE=${hostPort}`],
      log,
    });
    return { updated: true, message: 'Connected to the shared accounts and restarted.', container: newId };
  }

  return { restart, update, pull, recreate, connect, exec, findByRole, runHelper, inspect };
}
