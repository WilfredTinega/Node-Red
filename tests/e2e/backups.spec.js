import { choose, expect, goTo, loginAs, test } from './fixtures.js';
import { GOOD_TOKEN } from './support/mocks.js';

const card = (page, title) => page.locator('section.card', { has: page.getByRole('heading', { level: 2, name: title, exact: true }) });
const STAMP = /\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/;

async function connectGithub(stack) {
  const api = await stack.client();
  const res = await api('POST', '/api/github/connect', { token: GOOD_TOKEN });
  expect(res.status).toBe(200);
  return api;
}

test.describe('backups', () => {
  test('without GitHub: a notice links to the GitHub page and nothing can run', async ({ page }) => {
    await loginAs(page, 'backups');
    const notice = page.locator('.notice.warn');
    await expect(notice).toContainText('GitHub is not connected, so backups cannot run.');
    const link = notice.getByRole('link', { name: 'Connect an account on the GitHub page' });
    await expect(link).toHaveAttribute('href', '#/github');
    const status = card(page, 'Status');
    await expect(status).toContainText('Not set up: GitHub is not connected.');
    await expect(status.getByRole('button', { name: 'Test connection' })).toBeDisabled();
    await expect(status.getByRole('button', { name: 'Back up now' })).toBeDisabled();
    await expect(card(page, 'History')).toContainText('No backups yet.');

    await link.click();
    await expect(page.getByRole('heading', { level: 1, name: 'GitHub' })).toBeVisible();
    await expect(page.locator('.nav-item.active')).toHaveText('GitHub');
  });

  test('set the repository, prefix and each frequency, and save', async ({ page, stack }) => {
    await connectGithub(stack);
    await loginAs(page, 'backups');
    await expect(page.locator('.notice.warn')).toHaveCount(0);
    const status = card(page, 'Status');
    await expect(status).toContainText('Not set up: choose a repository below.');
    const settings = card(page, 'Settings');

    // The repository picker suggests what the token can see.
    const repo = settings.getByRole('combobox', { name: 'Repository' });
    await repo.fill('acme/');
    const suggestions = page.getByRole('listbox', { name: 'Repositories' });
    await expect(suggestions.getByRole('option')).toHaveCount(3);
    await expect(suggestions.getByRole('option', { name: /acme\/public-site/ })).toContainText('public');
    await suggestions.getByRole('option', { name: /acme\/flows-backup/ }).click();
    await expect(repo).toHaveValue('acme/flows-backup');

    const prefix = settings.getByLabel('Branch prefix');
    await expect(prefix).toHaveValue('backup/');
    await prefix.fill('nr backups');
    await expect(settings.locator('.error')).toHaveText('Branch prefix may only use letters, numbers, . _ - and /.');
    await prefix.fill('nr-backups/');

    // Daily at a set time.
    await expect(settings.getByRole('button', { name: 'Frequency: Daily' })).toBeVisible();
    await settings.getByLabel('Time').fill('2.30');
    await settings.getByLabel('Time').blur();
    await expect(settings.getByLabel('Time')).toHaveValue('02:30');
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(settings.getByText('Saved.')).toBeVisible();
    let saved = stack.readJson(stack.files.backup);
    expect(saved).toMatchObject({ repo: 'acme/flows-backup', branchPrefix: 'nr-backups/', schedule: { mode: 'daily', time: '02:30' } });
    await expect(status).toContainText('Next backup');

    // Every N hours.
    await choose(page, settings.getByRole('button', { name: 'Frequency: Daily' }), 'Every N hours');
    await expect(settings.getByLabel('Time')).toHaveCount(0);
    await choose(page, settings.getByRole('button', { name: 'Interval: Every 6 hours' }), 'Every 4 hours');
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(settings.getByText('Saved.')).toBeVisible();
    saved = stack.readJson(stack.files.backup);
    expect(saved.schedule).toMatchObject({ mode: 'hours', everyHours: 4 });

    // Weekly on a chosen day.
    await choose(page, settings.getByRole('button', { name: 'Frequency: Every N hours' }), 'Weekly');
    await choose(page, settings.getByRole('button', { name: 'Day of the week: Sunday' }), 'Wednesday');
    await settings.getByLabel('Time').fill('23:15');
    // Unsaved changes can be discarded...
    await expect(settings.getByRole('button', { name: 'Discard changes' })).toBeVisible();
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(settings.getByText('Saved.')).toBeVisible();
    await expect(settings.getByRole('button', { name: 'Discard changes' })).toHaveCount(0);
    saved = stack.readJson(stack.files.backup);
    expect(saved.schedule).toEqual({ mode: 'weekly', time: '23:15', everyHours: 4, weekday: 3 });

    // Off.
    await choose(page, settings.getByRole('button', { name: 'Frequency: Weekly' }), 'Off');
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(status).toContainText('Scheduled backups are off.');
    expect(stack.readJson(stack.files.backup).schedule.mode).toBe('off');

    // A reload shows what was saved.
    await page.reload();
    await expect(card(page, 'Settings').getByRole('combobox', { name: 'Repository' })).toHaveValue('acme/flows-backup');
    await expect(card(page, 'Settings').getByLabel('Branch prefix')).toHaveValue('nr-backups/');
    await expect(card(page, 'Settings').getByRole('button', { name: 'Frequency: Off' })).toBeVisible();
  });

  test('a bad time and a missing login password are caught before saving', async ({ page, stack }) => {
    await connectGithub(stack);
    await loginAs(page, 'backups');
    const settings = card(page, 'Settings');
    await settings.getByLabel('Time').fill('25:00');
    await expect(settings.locator('.error')).toHaveText('Time must be HH:MM (24-hour), for example 02:30.');
    await settings.getByLabel('Time').fill('01:00');
    await settings.getByLabel('Username').fill('backup-reader');
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(settings.locator('.error')).toHaveText('Enter the password for backup-reader.');
    expect(stack.gh.requests.filter((r) => r.method === 'PUT')).toHaveLength(0);
  });

  test('test connection, then back up now: a new dated branch on GitHub and a history row', async ({ page, stack }) => {
    const api = await connectGithub(stack);
    await api('PUT', '/api/backup', { repo: 'acme/flows-backup', branchPrefix: 'nr-backups/' });
    await loginAs(page, 'backups');
    const status = card(page, 'Status');

    await status.getByRole('button', { name: 'Test connection' }).click();
    const ok = status.locator('.notice.ok', { hasText: 'Connected to' });
    await expect(ok).toContainText('Connected to acme/flows-backup, a private repository.');
    await expect(ok.getByRole('link', { name: 'Open repository' })).toHaveAttribute('href', 'https://github.com/acme/flows-backup');

    await status.getByRole('button', { name: 'Back up now' }).click();
    const result = status.locator('.notice', { hasText: 'Backup finished' });
    // Every online instance is backed up, login-required ones included.
    await expect(result).toContainText('Backed up 3 of 3 instances.');
    await expect(result.locator('.bk-instances li', { hasText: 'Package NR' })).toContainText('nodes');
    await expect(ok).toHaveCount(0);

    // GitHub got one tree, one commit and one new branch named by date and time.
    const trees = stack.gh.find('POST', /\/repos\/acme\/flows-backup\/git\/trees$/);
    const commits = stack.gh.find('POST', /\/repos\/acme\/flows-backup\/git\/commits$/);
    const refs = stack.gh.find('POST', /\/repos\/acme\/flows-backup\/git\/refs$/);
    expect(trees).toHaveLength(1);
    expect(commits).toHaveLength(1);
    expect(refs).toHaveLength(1);
    const paths = trees[0].body.tree.map((t) => t.path).sort();
    // Flows only: each instance's folder carries its address (host + port); no metadata files.
    expect(paths).toEqual(
      [
        `nodered-main_127.0.0.1-${stack.nr.main.port}/flows.json`,
        `nodered-open_127.0.0.1-${stack.nr.open.port}/flows.json`,
        `package-nr_127.0.0.1-${stack.nr.pkg.port}/flows.json`,
      ].sort(),
    );
    const mainFlows = JSON.parse(trees[0].body.tree.find((t) => t.path.startsWith('nodered-main')).content);
    expect(mainFlows).toEqual(stack.nr.main.flows);
    expect(commits[0].body.tree).toBe('newtree001');
    const ref = refs[0].body.ref;
    expect(ref).toMatch(new RegExp(`^refs/heads/nr-backups/${STAMP.source}$`));
    expect(refs[0].body.sha).toBe('newcommit001');
    const branch = ref.replace('refs/heads/', '');

    // Every login-required instance (the container and the package install)
    // was read with a read-only backup-account token; the open one got none.
    for (const nr of [stack.nr.main, stack.nr.pkg]) {
      const tokens = nr.find('POST', /^\/auth\/token$/);
      expect(tokens).toHaveLength(1);
      const body = new URLSearchParams(tokens[0].raw);
      expect(body.get('scope')).toBe('read');
      expect(body.get('username')).toBe('nodered-backup');
    }
    expect(stack.nr.open.find('POST', /^\/auth\/token$/)).toHaveLength(0);

    await expect(result.getByRole('link', { name: branch })).toHaveAttribute('href', `https://github.com/acme/flows-backup/tree/${branch}`);

    const history = card(page, 'History');
    const rows = history.locator('tbody tr');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Manual (administrator)');
    await expect(rows.first().locator('td').nth(2).locator('.status')).toHaveText('ok');
    await expect(rows.first().getByRole('link', { name: branch })).toHaveAttribute('href', `https://github.com/acme/flows-backup/tree/${branch}`);
    await rows.first().getByText('3/3 saved').click();
    await expect(rows.first().locator('.bk-instances li')).toHaveCount(3);
    await expect(rows.first().locator('.bk-instances')).toContainText('3 nodes');
    await expect(status).toContainText('Last backup');

    expect(stack.readJson(stack.files.backup).history[0]).toMatchObject({ ok: true, branch });
  });

  test('a public repository is refused', async ({ page, stack }, testInfo) => {
    const api = await connectGithub(stack);
    await api('PUT', '/api/backup', { repo: 'acme/nodered-user-admin' });
    await loginAs(page, 'backups');
    const settings = card(page, 'Settings');
    await expect(settings.locator('.error')).toHaveText('acme/nodered-user-admin is public. Backups are refused for public repositories.');
    const status = card(page, 'Status');
    await status.getByRole('button', { name: 'Back up now' }).click();
    await expect(status.locator('.notice', { hasText: 'Backup failed' })).toContainText('acme/nodered-user-admin is public.');
    await expect(card(page, 'History').locator('tbody tr td:nth-child(3) .status')).toHaveText('failed');
    expect(stack.gh.find('POST', /\/git\/refs$/)).toHaveLength(0);

    // The page can be reached from the menu, too.
    await goTo(page, testInfo, 'Instances');
    await goTo(page, testInfo, 'Backups');
    await expect(card(page, 'History').locator('tbody tr')).toHaveCount(1);
  });
});

// The server runs in UTC (support/stack.js); the browser is put far from it, so
// the page has to pick the server zone on purpose for the times to match branch names.
test.describe('backup times', () => {
  test.use({ timezoneId: 'Pacific/Auckland' });

  test('next, last and history times are shown in the server timezone', async ({ page, stack }) => {
    const api = await connectGithub(stack);
    await api('PUT', '/api/backup', { repo: 'acme/flows-backup', schedule: { mode: 'daily', time: '02:30' } });
    expect((await api('POST', '/api/backup/run')).body.ok).toBe(true);
    const { history, nextRunAt, timezone } = (await api('GET', '/api/backup')).body;
    expect(timezone).toBe('UTC');
    expect(new Date(nextRunAt).getUTCHours()).toBe(2);
    expect(new Date(nextRunAt).getUTCMinutes()).toBe(30);

    // What the When cell must say, built from the branch name's stamp (server time).
    const [, y, mo, d, h, mi] = history[0].branch.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-\d{2}$/);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const hour12 = String(Number(h) % 12 || 12).padStart(2, '0');
    const when = new RegExp(`^${months[Number(mo) - 1]} ${Number(d)}, ${y}, ${hour12}:${mi}\\s?${Number(h) < 12 ? 'AM' : 'PM'}$`);

    await loginAs(page, 'backups');
    const status = card(page, 'Status');
    await expect(status).toContainText(/Next backup .*02:30\s?AM/);
    await expect(status.locator('.tz-tag').first()).toHaveText('UTC');
    const lastLine = status.locator('p', { hasText: 'Last backup' });
    expect((await lastLine.textContent()).replace(/^Last backup /, '').replace(/ UTC \(.*$/, '')).toMatch(when);

    const history_ = card(page, 'History');
    await expect(history_.locator('.head-actions')).toHaveText('UTC');
    expect((await history_.locator('tbody tr td').first().textContent()).trim()).toMatch(when);
  });
});
