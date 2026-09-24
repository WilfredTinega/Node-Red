// A stateful model of the Docker Engine API, faithful to what matters for
// data safety: how Binds, HostConfig.Mounts, Tmpfs and the image's VOLUMEs
// become a container's mounts, which volumes are anonymous, and what stop
// (with AutoRemove) and DELETE (with v / force) remove. Volumes hold files,
// so a test can check the flows are still there, byte for byte.
import crypto from 'node:crypto';
import { mockServer } from '../backend/helpers.mjs';

const hex = (n = 64) => crypto.randomBytes(n / 2).toString('hex');

export async function dockerModel() {
  const m = {
    images: {}, // id -> { Id, RepoTags, Config }
    tags: {}, // 'repo:tag' -> image id
    volumes: {}, // name -> { anonymous, files: { name: Buffer } }
    containers: {}, // id -> inspect-shaped object
    removedVolumes: [],
    fail: { create: false, start: false, exits: false, rename: false },
    // When set, the next pull makes the tag point at this image.
    pullTo: null,
  };

  function addImage(ref, config) {
    const Id = `sha256:${hex()}`;
    m.images[Id] = { Id, RepoTags: [ref], Config: structuredClone(config) };
    m.tags[ref] = Id;
    return Id;
  }

  function volume(name, anonymous) {
    if (!m.volumes[name]) m.volumes[name] = { anonymous, files: {} };
    return name;
  }

  const inUse = (name, exceptId) =>
    Object.values(m.containers).some((c) => c.Id !== exceptId && c.Mounts.some((x) => x.Type === 'volume' && x.Name === name));

  function removeContainer(c, withVolumes) {
    delete m.containers[c.Id];
    if (!withVolumes) return;
    for (const x of c.Mounts) {
      // Docker only removes volumes it created for this container (anonymous ones).
      if (x.Type === 'volume' && x._anonymousHere && !inUse(x.Name, c.Id)) {
        delete m.volumes[x.Name];
        m.removedVolumes.push(x.Name);
      }
    }
  }

  // What `docker create` does with the request body.
  function create(name, body) {
    if (m.fail.create) return { status: 500, json: { message: 'create failed (test)' } };
    if (name && Object.values(m.containers).some((c) => c.Name === `/${name}`)) {
      return { status: 409, json: { message: `Conflict. The container name "/${name}" is already in use` } };
    }
    const imageId = m.tags[body.Image] || (m.images[body.Image] && body.Image);
    if (!imageId) return { status: 404, json: { message: `No such image: ${body.Image}` } };
    const img = m.images[imageId].Config;
    const hc = structuredClone(body.HostConfig || {});
    const mounts = [];
    const taken = new Set();
    const add = (x) => {
      if (taken.has(x.Destination)) throw Object.assign(new Error(`Duplicate mount point: ${x.Destination}`), { status: 400 });
      taken.add(x.Destination);
      mounts.push(x);
    };
    try {
      for (const b of hc.Binds || []) {
        const [src, dst, opts = ''] = b.split(':');
        const RW = !opts.split(',').includes('ro');
        if (src.startsWith('/')) add({ Type: 'bind', Source: src, Destination: dst, Mode: opts, RW, Propagation: 'rprivate' });
        else add({ Type: 'volume', Name: volume(src, false), Source: `/var/lib/docker/volumes/${src}/_data`, Destination: dst, Driver: 'local', Mode: opts || 'z', RW, Propagation: '' });
      }
      for (const x of hc.Mounts || []) {
        if (x.Type === 'bind') add({ Type: 'bind', Source: x.Source, Destination: x.Target, Mode: '', RW: !x.ReadOnly, Propagation: 'rprivate' });
        else if (x.Type === 'tmpfs') add({ Type: 'tmpfs', Source: '', Destination: x.Target, Mode: '', RW: !x.ReadOnly, Propagation: '' });
        else if (x.Type === 'volume') {
          const anon = !x.Source;
          const n = volume(x.Source || hex(), anon);
          add({ Type: 'volume', Name: n, Source: `/var/lib/docker/volumes/${n}/_data`, Destination: x.Target, Driver: 'local', Mode: 'z', RW: !x.ReadOnly, Propagation: '', ...(anon && { _anonymousHere: true }) });
        }
      }
      for (const dst of Object.keys(hc.Tmpfs || {})) taken.add(dst); // not listed in Mounts, like Docker
      for (const dst of Object.keys({ ...(img.Volumes || {}), ...(body.Volumes || {}) })) {
        if (taken.has(dst)) continue;
        const n = volume(hex(), true);
        add({ Type: 'volume', Name: n, Source: `/var/lib/docker/volumes/${n}/_data`, Destination: dst, Driver: 'local', Mode: '', RW: true, Propagation: '', _anonymousHere: true });
      }
    } catch (e) {
      return { status: e.status || 500, json: { message: e.message } };
    }
    const Id = hex();
    // The daemon fills unset fields from the image and merges Env and Labels.
    const envKeys = new Set((body.Env || []).map((e) => e.split('=')[0]));
    const Config = {
      ...structuredClone(body),
      Hostname: body.Hostname || Id.slice(0, 12),
      Env: [...(img.Env || []).filter((e) => !envKeys.has(e.split('=')[0])), ...(body.Env || [])],
      Cmd: body.Cmd ?? img.Cmd,
      Entrypoint: body.Entrypoint ?? img.Entrypoint ?? null,
      WorkingDir: body.WorkingDir ?? img.WorkingDir,
      User: body.User ?? img.User ?? '',
      ExposedPorts: { ...(img.ExposedPorts || {}), ...(body.ExposedPorts || {}) },
      Volumes: { ...(img.Volumes || {}), ...(body.Volumes || {}) },
      Labels: { ...(img.Labels || {}), ...(body.Labels || {}) },
    };
    delete Config.HostConfig;
    delete Config.NetworkingConfig;
    const nets = body.NetworkingConfig?.EndpointsConfig || {};
    const mode = hc.NetworkMode || 'bridge';
    const Networks = Object.keys(nets).length
      ? Object.fromEntries(Object.entries(nets).map(([k, v]) => [k, { Aliases: v.Aliases ?? null, IPAMConfig: v.IPAMConfig ?? null, Links: v.Links ?? null }]))
      : mode === 'host' ? { host: { Aliases: null, IPAMConfig: null, Links: null } } : { [mode === 'default' ? 'bridge' : mode]: { Aliases: null, IPAMConfig: null, Links: null } };
    m.containers[Id] = {
      Id,
      Name: `/${name || hex(12)}`,
      Image: imageId,
      Created: new Date().toISOString(),
      State: { Status: 'created', Running: false, ExitCode: 0 },
      Config,
      HostConfig: hc,
      Mounts: mounts,
      NetworkSettings: { Networks },
    };
    return { status: 201, json: { Id, Warnings: [] } };
  }

  const publicMounts = (c) => c.Mounts.map(({ _anonymousHere, ...x }) => x);
  const view = (c) => ({ ...structuredClone({ ...c, Mounts: publicMounts(c) }) });

  const srv = await mockServer((r) => {
    const u = new URL(r.url, 'http://x');
    const p = u.pathname;
    let g;
    if (r.method === 'GET' && p === '/containers/json') {
      let list = Object.values(m.containers);
      const f = u.searchParams.get('filters') ? JSON.parse(u.searchParams.get('filters')) : {};
      for (const l of f.label || []) {
        const [k, v] = l.split('=');
        list = list.filter((c) => (v === undefined ? k in c.Config.Labels : c.Config.Labels[k] === v));
      }
      if (f.status) list = list.filter((c) => f.status.includes(c.State.Running ? 'running' : 'exited'));
      else if (u.searchParams.get('all') !== '1') list = list.filter((c) => c.State.Running);
      return {
        json: list.map((c) => ({
          Id: c.Id,
          Names: [c.Name],
          Image: c.Config.Image,
          ImageID: c.Image,
          State: c.State.Running ? 'running' : 'exited',
          Status: c.State.Running ? 'Up' : 'Exited',
          Labels: c.Config.Labels,
          HostConfig: { NetworkMode: c.HostConfig.NetworkMode || 'default' },
          Mounts: publicMounts(c),
          Ports: Object.entries(c.HostConfig.PortBindings || {}).flatMap(([k, bs]) =>
            (bs || []).map((b) => ({ PrivatePort: Number(k.split('/')[0]), PublicPort: Number(b.HostPort), Type: k.split('/')[1] || 'tcp' })),
          ),
        })),
      };
    }
    if (r.method === 'POST' && p === '/images/create') {
      const ref = `${u.searchParams.get('fromImage')}:${u.searchParams.get('tag')}`;
      if (m.pullTo) m.tags[ref] = m.pullTo;
      if (!m.tags[ref]) return { status: 404, json: { message: `pull access denied for ${ref}` } };
      return { text: '{"status":"Pulling"}\n{"status":"Status: Downloaded newer image"}\n', headers: { 'Content-Type': 'application/json' } };
    }
    if (r.method === 'GET' && (g = p.match(/^\/images\/(.+)\/json$/))) {
      const name = decodeURIComponent(g[1]);
      const id = m.tags[name] || (m.images[name] && name);
      return id ? { json: m.images[id] } : { status: 404, json: { message: `No such image: ${name}` } };
    }
    if (r.method === 'POST' && p === '/containers/create') return create(u.searchParams.get('name'), r.body || {});
    if ((g = p.match(/^\/containers\/([^/]+)(\/[a-z]+)?$/))) {
      const c = Object.values(m.containers).find((x) => x.Id.startsWith(g[1]) || x.Name === `/${g[1]}`);
      if (!c) return { status: 404, json: { message: `No such container: ${g[1]}` } };
      const action = g[2];
      if (r.method === 'GET' && action === '/json') return { json: view(c) };
      if (r.method === 'POST' && action === '/stop') {
        if (!c.State.Running) return { status: 304, text: '' };
        c.State = { Status: 'exited', Running: false, ExitCode: 0 };
        if (c.HostConfig.AutoRemove) removeContainer(c, true); // --rm also removes anonymous volumes
        return { status: 204, text: '' };
      }
      if (r.method === 'POST' && action === '/restart') {
        c.State = { Status: 'running', Running: true, ExitCode: 0 };
        return { status: 204, text: '' };
      }
      if (r.method === 'POST' && action === '/rename') {
        if (m.fail.rename) return { status: 500, json: { message: 'rename failed (test)' } };
        const to = `/${u.searchParams.get('name')}`;
        if (Object.values(m.containers).some((x) => x !== c && x.Name === to)) return { status: 409, json: { message: 'name in use' } };
        c.Name = to;
        return { status: 204, text: '' };
      }
      if (r.method === 'POST' && action === '/start') {
        if (c.State.Running) return { status: 304, text: '' };
        const isNew = c.State.Status === 'created';
        if (isNew && m.fail.start) return { status: 500, json: { message: 'port is already allocated' } };
        const ports = (x) => Object.values(x.HostConfig.PortBindings || {}).flat().map((b) => b.HostPort);
        const clash = Object.values(m.containers).find((x) => x !== c && x.State.Running && ports(x).some((hp) => ports(c).includes(hp)));
        if (clash) return { status: 500, json: { message: 'port is already allocated' } };
        c.State = isNew && m.fail.exits ? { Status: 'exited', Running: false, ExitCode: 1 } : { Status: 'running', Running: true, ExitCode: 0 };
        return { status: 204, text: '' };
      }
      if (r.method === 'DELETE' && !action) {
        const force = ['1', 'true'].includes(u.searchParams.get('force'));
        if (c.State.Running && !force) return { status: 409, json: { message: 'You cannot remove a running container. Stop the container before attempting removal or force remove' } };
        removeContainer(c, ['1', 'true'].includes(u.searchParams.get('v')));
        return { status: 204, text: '' };
      }
    }
    return { status: 404, json: { message: `model: no route ${r.method} ${p}` } };
  });

  // Creates and starts a container the way `docker run` would.
  async function run(name, body) {
    const res = create(name, body);
    if (res.status !== 201) throw new Error(res.json.message);
    const c = m.containers[res.json.Id];
    c.State = { Status: 'running', Running: true, ExitCode: 0 };
    return c;
  }

  const mutations = () => srv.requests.filter((x) => x.method !== 'GET').map((x) => ({ method: x.method, url: x.url, body: x.body }));
  return Object.assign(srv, { model: m, addImage, run, volume, view, mutations });
}
