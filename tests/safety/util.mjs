// Temp folders for the safety tests, and a byte-level snapshot of a folder tree.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRATCH =
  process.env.SAFETY_TMP || '/tmp/claude-1000/-home-tinega-my-bench/e57509ac-35ba-4220-a0d9-7f4270c311fd/scratchpad/safety';

export function safetyDir(prefix = 's') {
  const base = fs.existsSync(path.dirname(SCRATCH)) ? SCRATCH : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, `${prefix}-`));
}

// { relative path: Buffer } for every file under `dir`, plus modes and mtimes in `meta`.
export function snapshot(dir, withMeta = false) {
  const files = {};
  const meta = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p);
      if (e.isDirectory()) walk(p);
      else {
        files[rel] = fs.readFileSync(p);
        const st = fs.statSync(p);
        meta[rel] = { mode: st.mode & 0o777, mtimeMs: st.mtimeMs, ino: st.ino };
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return withMeta ? { files, meta } : files;
}
