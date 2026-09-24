// A durable audit log of actions taken from the dashboard: who did what to
// which instance, when, and how it went. Kept in a file so it survives
// restarts and is the same for every admin (unlike a per-browser log).
import fs from 'node:fs';

export function createActivityLog(file, limit = 500) {
  function read() {
    try {
      const list = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(list) ? list : [];
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`activity: cannot read ${file}: ${e.message}`);
      return [];
    }
  }

  // entry: { user, action, target, ok, message, steps? }. Newest first.
  function add(entry) {
    try {
      const list = [{ at: new Date().toISOString(), ...entry }, ...read()].slice(0, limit);
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(list, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    } catch (e) {
      console.error(`activity: cannot write ${file}: ${e.message}`);
    }
  }

  return { read, add };
}
