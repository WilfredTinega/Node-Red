// Guard against the "forgot to COPY a new module" crash loop: every local
// module server.js imports must be copied into the image by the Dockerfile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

test('the Dockerfile copies every local module server.js imports', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const imports = [...server.matchAll(/from '\.\/([\w.-]+\.js)'/g)].map((m) => m[1]);
  assert.ok(imports.length >= 4, 'expected several local imports');

  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const copied = new Set([...dockerfile.matchAll(/^COPY ([^\n]+?) \.\/$/gm)].flatMap((m) => m[1].split(/\s+/)));
  copied.add('server.js');

  for (const mod of imports) {
    assert.ok(copied.has(mod), `Dockerfile does not COPY ${mod} (imported by server.js)`);
  }
});
