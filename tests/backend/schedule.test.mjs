// nextRun() and settings validation from backup.js, tested directly.
process.env.TZ = 'Africa/Nairobi';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRun, validateSettings, DEFAULT_SETTINGS } from '../../backup.js';
import { REPO_RE, normalizeRepo } from '../../github.js';

// Local time, like the server's TZ. 2026-09-24 is a Thursday.
const at = (y, mo, d, h = 0, mi = 0, s = 0, ms = 0) => new Date(y, mo - 1, d, h, mi, s, ms);
const same = (a, b) => assert.equal(a?.toString(), b?.toString());

test('off and missing schedules never run', () => {
  assert.equal(nextRun({ mode: 'off', time: '10:00' }, at(2026, 9, 24)), null);
  assert.equal(nextRun(null), null);
  assert.equal(nextRun(undefined), null);
  assert.equal(nextRun({ mode: 'bogus', time: '10:00' }, at(2026, 9, 24)), null);
});

test('daily', () => {
  const s = { mode: 'daily', time: '02:30' };
  same(nextRun(s, at(2026, 9, 24, 1, 0)), at(2026, 9, 24, 2, 30));
  same(nextRun(s, at(2026, 9, 24, 2, 29, 59, 999)), at(2026, 9, 24, 2, 30));
  // Exactly on the boundary: strictly after, so tomorrow.
  same(nextRun(s, at(2026, 9, 24, 2, 30)), at(2026, 9, 25, 2, 30));
  same(nextRun(s, at(2026, 9, 24, 23, 59)), at(2026, 9, 25, 2, 30));
  // Month and year ends.
  same(nextRun(s, at(2026, 9, 30, 3)), at(2026, 10, 1, 2, 30));
  same(nextRun({ mode: 'daily', time: '00:00' }, at(2026, 12, 31, 0, 0, 1)), at(2027, 1, 1));
  same(nextRun({ mode: 'daily', time: '00:00' }, at(2026, 12, 31, 0, 0)), at(2027, 1, 1));
  // A missing time means midnight.
  same(nextRun({ mode: 'daily' }, at(2026, 9, 24, 12)), at(2026, 9, 25));
});

test('every N hours, counted from midnight', () => {
  const six = { mode: 'hours', everyHours: 6, time: '09:15' }; // time is ignored
  same(nextRun(six, at(2026, 9, 24, 5, 59)), at(2026, 9, 24, 6));
  same(nextRun(six, at(2026, 9, 24, 6, 0)), at(2026, 9, 24, 12), 'boundary');
  same(nextRun(six, at(2026, 9, 24, 0, 0)), at(2026, 9, 24, 6), 'midnight boundary');
  same(nextRun(six, at(2026, 9, 24, 18, 0, 0, 1)), at(2026, 9, 25, 0));
  same(nextRun(six, at(2026, 9, 30, 23, 0)), at(2026, 10, 1, 0));
  same(nextRun({ mode: 'hours', everyHours: 8 }, at(2026, 9, 24, 17)), at(2026, 9, 25, 0), '8h: 00, 08, 16');
  same(nextRun({ mode: 'hours', everyHours: 1 }, at(2026, 9, 24, 23, 30)), at(2026, 9, 25, 0));
  same(nextRun({ mode: 'hours', everyHours: 12 }, at(2026, 9, 24, 11, 59)), at(2026, 9, 24, 12));
  same(nextRun({ mode: 'hours', everyHours: '4' }, at(2026, 9, 24, 3)), at(2026, 9, 24, 4), 'numeric string');
});

test('every N hours with a bad value in the file does not hang', () => {
  // 0 used to loop forever, blocking the whole server.
  for (const everyHours of [0, -1, 5, 'x', undefined]) {
    const r = nextRun({ mode: 'hours', everyHours }, at(2026, 9, 24, 7));
    assert.ok(r instanceof Date && r > at(2026, 9, 24, 7), String(everyHours));
  }
});

test('weekly, including the week wrap', () => {
  const sunday = { mode: 'weekly', weekday: 0, time: '00:00' };
  same(nextRun(sunday, at(2026, 9, 24, 10)), at(2026, 9, 27)); // Thu -> Sun
  same(nextRun(sunday, at(2026, 9, 26, 23, 59)), at(2026, 9, 27)); // Sat night
  same(nextRun(sunday, at(2026, 9, 27, 0, 0)), at(2026, 10, 4), 'exactly on the boundary');
  same(nextRun(sunday, at(2026, 9, 27, 10)), at(2026, 10, 4), 'later the same day');

  const wed = { mode: 'weekly', weekday: 3, time: '18:45' };
  same(nextRun(wed, at(2026, 9, 24, 12)), at(2026, 9, 30, 18, 45)); // Thu -> next Wed
  same(nextRun(wed, at(2026, 9, 30, 18, 44)), at(2026, 9, 30, 18, 45));
  same(nextRun(wed, at(2026, 9, 30, 18, 45)), at(2026, 10, 7, 18, 45));

  const thu = { mode: 'weekly', weekday: 4, time: '09:00' };
  same(nextRun(thu, at(2026, 9, 24, 8)), at(2026, 9, 24, 9), 'same weekday, later today');
  same(nextRun(thu, at(2026, 9, 24, 9, 0, 0, 1)), at(2026, 10, 1, 9));

  const sat = { mode: 'weekly', weekday: 6, time: '23:59' };
  same(nextRun(sat, at(2026, 12, 27, 0)), at(2027, 1, 2, 23, 59), 'across a year end');
});

test('validateSettings', () => {
  const cur = structuredClone(DEFAULT_SETTINGS);
  const ok = validateSettings({ repo: ' https://github.com/Octo/Backups.git ', branchPrefix: 'nr/backup-', schedule: { mode: 'weekly', weekday: '3', time: '07:05' }, loginUser: ' bk ' }, cur);
  assert.equal(ok.repo, 'Octo/Backups');
  assert.equal(ok.branchPrefix, 'nr/backup-');
  assert.deepEqual(ok.schedule, { mode: 'weekly', time: '07:05', everyHours: 6, weekday: 3 });
  assert.equal(ok.loginUser, 'bk');
  assert.equal(validateSettings({ repo: '' }, cur).repo, '');
  assert.equal(validateSettings({ branchPrefix: '' }, cur).branchPrefix, '');

  const bad = [
    { repo: 'nope' },
    { repo: 'a/b/c' },
    { repo: '../..' },
    { repo: './x' },
    { repo: 'x/.' },
    { repo: 'x/..' },
    { repo: 'https://github.com/../..' },
    { branchPrefix: '../x' },
    { branchPrefix: '/x' },
    { branchPrefix: 'a//b' },
    { branchPrefix: 'a b' },
    { schedule: { mode: 'monthly' } },
    { schedule: { time: '24:00' } },
    { schedule: { time: '7:05' } },
    { schedule: { mode: 'hours', everyHours: 5 } },
    { schedule: { weekday: 7 } },
    { schedule: { weekday: 'x' } },
  ];
  for (const input of bad) assert.throws(() => validateSettings(input, cur), undefined, JSON.stringify(input));
});

test('REPO_RE: owner/name only, and never a segment made of dots (an API path walk)', () => {
  for (const ok of ['octo/repo', 'my.org/my-repo', 'a_b/c.d', '.github/x', 'x/.hidden', 'a..b/c']) assert.ok(REPO_RE.test(ok), ok);
  for (const bad of ['../..', '..', '.', '../x', './x', 'x/.', 'x/..', 'x/...', '.../x', 'a/b/c', '/x', 'x/', 'a b/c']) assert.ok(!REPO_RE.test(bad), bad);
  assert.equal(normalizeRepo(' https://github.com/Octo/Repo.git '), 'Octo/Repo');
  assert.ok(!REPO_RE.test(normalizeRepo('https://github.com/../../user')), 'walking out of /repos is refused');
});

test('the scheduler runs once per slot, and once after a long sleep', async (t) => {
  const { createBackups } = await import('../../backup.js');
  const { tempDir } = await import('./helpers.mjs');
  const fs = await import('node:fs');
  const file = `${tempDir('sched')}/backup.json`;
  fs.writeFileSync(file, JSON.stringify({ repo: 'octo/x', schedule: { mode: 'hours', everyHours: 1, time: '00:00', weekday: 0 } }));
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: at(2026, 9, 24, 10, 59, 50) });
  const b = createBackups({
    file,
    encrypt: (s) => s,
    decrypt: (s) => s,
    hasKey: () => true,
    // Fails at once and synchronously, so the history entry is written during the tick.
    getToken: () => {
      throw new Error('no token in this test');
    },
    isConnected: () => true,
    listInstances: async () => ({ instances: [], errors: [] }),
    probeHost: '127.0.0.1',
    systemLogin: {
      username: 'nodered-backup',
      ensure: () => {
        throw new Error('no instances in this test, so never asked');
      },
    },
  });
  assert.equal(b.publicState().defaultLoginUser, 'nodered-backup');
  b.start();
  same(new Date(b.publicState().nextRunAt), at(2026, 9, 24, 11));
  t.mock.timers.tick(20000); // 11:00:10
  let h = b.publicState().history;
  assert.equal(h.length, 1);
  assert.equal(h[0].trigger, 'schedule');
  assert.equal(h[0].message, 'no token in this test');
  same(new Date(b.publicState().nextRunAt), at(2026, 9, 24, 12));
  t.mock.timers.tick(20000);
  assert.equal(b.publicState().history.length, 1, 'not again in the same slot');

  // The machine sleeps for five hours: one run on waking, not five.
  t.mock.timers.setTime(at(2026, 9, 24, 17, 0, 5).getTime());
  t.mock.timers.tick(20000);
  t.mock.timers.tick(20000);
  t.mock.timers.tick(20000);
  h = b.publicState().history;
  assert.equal(h.length, 2);
  same(new Date(b.publicState().nextRunAt), at(2026, 9, 24, 18));
});
