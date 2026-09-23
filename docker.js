// Restart and update Node-RED containers through the Docker socket proxy.
// Update = pull the newest image for the container's own tag, then recreate
// the container with the same name, ports, volumes, env and networks.
const TIMEOUT = 30000;

export function createDocker(api) {
  async function call(method, path, body, timeout = TIMEOUT) {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
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

  async function update(id, log = () => {}) {
    const old = await inspect(id);
    const name = old.Name.replace(/^\//, '');
    const ref = old.Config.Image.includes(':') || old.Config.Image.includes('@') ? old.Config.Image : `${old.Config.Image}:latest`;
    if (ref.includes('@')) throw new Error(`${name} is pinned to an image digest; change it by hand.`);
    const [fromImage, tag] = [ref.slice(0, ref.lastIndexOf(':')), ref.slice(ref.lastIndexOf(':') + 1)];

    log(`Pulling ${ref}…`);
    // The pull streams progress; the call returns once the stream ends.
    await call('POST', `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag)}`, null, 10 * 60000);
    const pulled = await call('GET', `/images/${encodeURIComponent(ref)}/json`);
    if (pulled.Id === old.Image) {
      await restart(id);
      return { updated: false, message: `Already on the newest ${ref}. Restarted it.` };
    }

    const oldImage = await call('GET', `/images/${old.Image}/json`).catch(() => ({ Config: {} }));
    const config = withoutImageDefaults(old.Config, oldImage.Config || {});
    config.Image = ref;
    if (config.Hostname === old.Id.slice(0, 12)) delete config.Hostname;

    // Anonymous volumes aren't in Binds; carry them over by name, or the new
    // container would start with an empty /data and lose every flow.
    const hostConfig = { ...old.HostConfig };
    const binds = [...(hostConfig.Binds || [])];
    for (const m of old.Mounts || []) {
      if (m.Type === 'volume' && !binds.some((b) => b.split(':')[1] === m.Destination)) {
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
    return { updated: true, message: `Updated ${name} to the newest ${ref} and started it.` };
  }

  return { restart, update };
}
