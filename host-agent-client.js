// Talks to the host agent (host-agent/host-agent.js) over its unix socket.
// This side is unprivileged: it only sends a request and reads the reply. The
// agent, which runs as root, is what actually restarts/updates/connects.
import net from 'node:net';
import fs from 'node:fs';

const SOCKET = process.env.HOST_AGENT_SOCKET || '';
const TOKEN = process.env.HOST_AGENT_TOKEN || '';

// Available when a socket path is configured and the file exists.
export const hostAgentEnabled = () => Boolean(SOCKET) && fs.existsSync(SOCKET);

export function callHostAgent(action, params = {}, { timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!SOCKET) return reject(new Error('The host agent is not configured (HOST_AGENT_SOCKET).'));
    const sock = net.createConnection(SOCKET);
    let buf = '';
    const done = (fn, arg) => {
      sock.destroy();
      fn(arg);
    };
    const timer = setTimeout(() => done(reject, new Error('The host agent did not respond in time.')), timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify({ action, ...params, ...(TOKEN && { token: TOKEN }) }) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      try {
        done(resolve, JSON.parse(buf.slice(0, nl)));
      } catch (e) {
        done(reject, new Error(`The host agent sent a bad reply: ${e.message}`));
      }
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      done(reject, new Error(`Cannot reach the host agent: ${e.code === 'ENOENT' ? 'it is not installed or running.' : e.message}`));
    });
  });
}
