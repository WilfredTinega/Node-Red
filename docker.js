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
  // Rolls back to the old container if the new one won't start.
  async function recreate(id, ref, log = () => {}) {
    const old = await inspect(id);
    const name = old.Name.replace(/^\//, '');
    const oldImage = await call('GET', `/images/${old.Image}/json`).catch(() => ({ Config: {} }));
    const config = withoutImageDefaults(old.Config, oldImage.Config || {});
    config.Image = ref;
    if (config.Hostname === old.Id.slice(0, 12)) delete config.Hostname;

    // Anonymous volumes aren't in Binds; carry them over by name, or the new
    // container would start with an empty /data and lose every flow.
    // Volumes given with --mount are already in HostConfig.Mounts; adding them
    // to Binds too would make create fail with "duplicate mount point".
    const hostConfig = { ...old.HostConfig };
    const binds = [...(hostConfig.Binds || [])];
    const mounted = new Set((hostConfig.Mounts || []).map((m) => m.Target));
    for (const m of old.Mounts || []) {
      if (m.Type === 'volume' && !mounted.has(m.Destination) && !binds.some((b) => b.split(':')[1] === m.Destination)) {
        binds.push(`${m.Name}:${m.Destination}${m.RW ? '' : ':ro'}`);
      }
    }
    hostConfig.Binds = binds;

    const endpoints = {};
    for (const [net, cfg] of Object.entries(old.NetworkSettings?.Networks || {})) {
      endpoints[net] = { Aliases: cfg.Aliases, IPAMConfig: cfg.IPAMConfig, Links: cfg.Links };
    }

    const backupName = `${name}-before-update-${Date.now()}`;
    log(`Stopping ${name}…`);
    await call('POST', `/containers/${id}/stop?t=20`, null, 60000);
    await call('POST', `/containers/${id}/rename?name=${encodeURIComponent(backupName)}`);

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
      await call('POST', `/containers/${id}/start`).catch(() => {});
      throw new Error(`Update failed and ${name} was restored: ${e.message}`);
    }
    await call('DELETE', `/containers/${id}`).catch(() => {});
    return created.Id;
  }

  // The running container carrying `role` (e.g. this dashboard itself).
  async function findByRole(role) {
    const filters = encodeURIComponent(JSON.stringify({ label: [`nodered-admin.role=${role}`], status: ['running'] }));
    const list = await call('GET', `/containers/json?filters=${filters}`);
    return list[0] || null;
  }

  // Starts a throwaway container from `image` that runs `cmd` on the host
  // network (so it can reach the Docker proxy) and removes itself afterwards.
  async function runHelper(image, cmd, env) {
    const helper = await call('POST', '/containers/create', {
      Image: image,
      Cmd: cmd,
      Env: env,
      Labels: { 'nodered-admin.role': 'updater' },
      HostConfig: { NetworkMode: 'host', AutoRemove: true },
    });
    await call('POST', `/containers/${helper.Id}/start`);
    return helper.Id;
  }

  return { restart, update, pull, recreate, findByRole, runHelper, inspect };
}
