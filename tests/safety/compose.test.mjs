// Installing the dashboard must never create a Node-RED instance: the
// production compose file defines only the dashboard and its Docker proxy, and
// the local test Node-RED only starts when its profile is asked for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// Top-level service names and the indented block of each, from the compose YAML.
function services(yaml) {
  const out = {};
  let inServices = false;
  let current = null;
  for (const line of yaml.split('\n')) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (inServices && /^\S/.test(line)) inServices = false; // another top-level key
    if (!inServices) continue;
    const name = line.match(/^ {2}([\w-]+):\s*$/);
    if (name) {
      current = name[1];
      out[current] = '';
    } else if (current && /^ {4}/.test(line)) {
      out[current] += line + '\n';
    }
  }
  return out;
}

const isNodeRed = (block) => /image:\s*\S*node-?red\/node-?red/i.test(block);

test('docker-compose.yml starts no Node-RED', () => {
  const svc = services(read('docker-compose.yml'));
  assert.deepEqual(Object.keys(svc).sort(), ['docker-proxy', 'nodered-user-admin']);
  for (const [name, block] of Object.entries(svc)) assert.ok(!isNodeRed(block), `${name} runs a Node-RED image`);
});

test('the local test Node-RED is opt-in through a profile', () => {
  const svc = services(read('docker-compose.local.yml'));
  for (const [name, block] of Object.entries(svc)) {
    if (!isNodeRed(block)) continue;
    assert.match(block, /^\s{4}profiles:\s*\[.+\]/m, `${name} would start on a plain "up"`);
  }
});

test('no code path creates a container from a Node-RED image', () => {
  // Containers are created in exactly two places: recreate() (same image
  // repository as the existing container) and runHelper() (the dashboard's own image).
  const src = read('docker.js') + read('server.js') + read('self-update.js') + read('backup.js');
  const creates = src.match(/\/containers\/create/g) || [];
  assert.equal(creates.length, 2, 'unexpected container-create call');
  assert.ok(!/nodered\/node-red|node-red:latest/.test(src), 'a Node-RED image name appears in the code');
});
