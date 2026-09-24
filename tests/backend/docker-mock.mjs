// A fake Docker Engine API (as seen through the socket proxy). Holds a few
// containers and images; tests change `state` to steer the answers.
import { mockServer } from './helpers.mjs';

export const OLD_IMAGE = 'sha256:old0000000000000000000000000000000000000000000000000000000000';
export const NEW_IMAGE = 'sha256:new0000000000000000000000000000000000000000000000000000000000';
export const id64 = (short) => `${short}${'0'.repeat(64 - short.length)}`;

export function nodeRedInspect(o = {}) {
  return {
    Id: id64('aaaa1111'),
    Name: '/nodered-a',
    Image: OLD_IMAGE,
    State: { Running: true, ExitCode: 0 },
    Config: {
      Image: 'nodered/node-red:latest',
      Hostname: 'aaaa11110000',
      Env: ['NODERED_INSTANCE=1890', 'PATH=/usr/local/bin', 'NODE_RED_VERSION=v4.0.8'],
      Cmd: ['npm', 'start'],
      WorkingDir: '/usr/src/node-red',
      Labels: { 'org.opencontainers.image.version': '4.0.8', 'com.docker.compose.service': 'nodered' },
    },
    HostConfig: { Binds: ['/opt/nodered-auth:/auth'], PortBindings: { '1880/tcp': [{ HostPort: '1890' }] }, RestartPolicy: { Name: 'unless-stopped' } },
    Mounts: [
      { Type: 'bind', Source: '/opt/nodered-auth', Destination: '/auth', RW: true },
      { Type: 'volume', Name: 'anon123', Destination: '/data', RW: true },
      { Type: 'volume', Name: 'viamount', Destination: '/extra', RW: true },
    ],
    NetworkSettings: { Networks: { bridge: { Aliases: null, IPAMConfig: null, Links: null } } },
    ...o,
  };
}

// The Node-RED container the tests update; one of its volumes came from --mount.
export const freshNodeRed = () =>
  nodeRedInspect({ HostConfig: { ...nodeRedInspect().HostConfig, Mounts: [{ Type: 'volume', Source: 'viamount', Target: '/extra' }] } });

export async function dockerMock(opts = {}) {
  const state = {
    containers: { [id64('aaaa1111')]: freshNodeRed() },
    // What discovery lists (GET /containers/json without filters).
    list: opts.list || [],
    roleList: opts.roleList || [],
    pullBody: '{"status":"Pulling from nodered/node-red"}\n{"status":"Digest: sha256:abc"}\n{"status":"Status: Downloaded newer image"}\n',
    pullStatus: 200,
    pullDelay: 0,
    // image name -> Id, for GET /images/<name>/json
    images: { [OLD_IMAGE]: { Id: OLD_IMAGE, Config: { Env: ['PATH=/usr/local/bin', 'NODE_RED_VERSION=v4.0.8'], Cmd: ['npm', 'start'], WorkingDir: '/usr/src/node-red', Labels: { 'org.opencontainers.image.version': '4.0.8' } } } },
    pulledId: OLD_IMAGE,
    newRunning: true,
    startFails: false,
    createFails: false,
    renameFails: false,
    restartDelay: 0,
    created: 0,
  };
  const srv = await mockServer((r) => {
    const u = new URL(r.url, 'http://x');
    const p = u.pathname;
    let m;
    if (r.method === 'GET' && p === '/containers/json') {
      return { json: u.searchParams.get('filters') ? state.roleList : state.list };
    }
    if (r.method === 'POST' && p === '/images/create') {
      return { status: state.pullStatus, text: state.pullBody, headers: { 'Content-Type': 'application/json' }, delay: state.pullDelay };
    }
    if (r.method === 'GET' && (m = p.match(/^\/images\/(.+)\/json$/))) {
      const name = decodeURIComponent(m[1]);
      if (state.images[name]) return { json: state.images[name] };
      return { json: { Id: state.pulledId, Config: {} } };
    }
    if (r.method === 'POST' && p === '/containers/create') {
      if (state.createFails) return { status: 403, text: 'Forbidden' };
      const newId = id64(`new${++state.created}`);
      state.containers[newId] = { Id: newId, Name: `/${u.searchParams.get('name') || 'helper'}`, State: { Running: state.newRunning, ExitCode: state.newRunning ? 0 : 1 }, Config: r.body };
      return { status: 201, json: { Id: newId, Warnings: [] } };
    }
    if ((m = p.match(/^\/containers\/([^/]+)(\/[a-z]+)?$/))) {
      // Docker accepts any unique id prefix, like the 12-character short id.
      const key = Object.keys(state.containers).find((k) => k.startsWith(m[1]) || state.containers[k].Name === `/${m[1]}`);
      const c = key && state.containers[key];
      if (!c) return { status: 404, json: { message: `No such container: ${m[1]}` } };
      const action = m[2];
      if (r.method === 'GET' && action === '/json') return { json: c };
      if (r.method === 'POST' && action === '/restart') return { status: 204, text: '', delay: state.restartDelay };
      if (r.method === 'POST' && action === '/stop') return { status: 204, text: '' };
      if (r.method === 'POST' && action === '/rename') {
        if (state.renameFails) return { status: 500, json: { message: 'rename failed (test)' } };
        c.Name = `/${u.searchParams.get('name')}`;
        return { status: 204, text: '' };
      }
      if (r.method === 'POST' && action === '/start') {
        if (state.startFails && key.startsWith('new')) return { status: 500, json: { message: 'port is already allocated' } };
        return { status: 204, text: '' };
      }
      if (r.method === 'DELETE' && !action) {
        delete state.containers[key];
        return { status: 204, text: '' };
      }
    }
  });
  return Object.assign(srv, { state, calls: () => srv.requests.map((x) => `${x.method} ${x.path}`) });
}
