import fs from 'node:fs';
import { expect, loginAs, test } from './fixtures.js';
import { BUILD_SHA, BUILDING_SHA, CONTAINERS, FAILED_SHA, GOOD_TOKEN, run } from './support/mocks.js';

const card = (page, title) => page.locator('section.card', { has: page.getByRole('heading', { level: 2, name: title, exact: true }) });

async function connect(stack, dashboard) {
  const api = await stack.client();
  expect((await api('POST', '/api/github/connect', { token: GOOD_TOKEN })).status).toBe(200);
  if (dashboard) expect((await api('PUT', '/api/github', dashboard)).status).toBe(200);
  return api;
}

test.describe('GitHub', () => {
  test('connect with a token, then disconnect after confirming', async ({ page, stack }) => {
    await loginAs(page, 'github');
    const account = card(page, 'Account');
    const token = account.getByLabel('Personal access token');
    const connectButton = account.getByRole('button', { name: 'Connect' });
    await expect(connectButton).toBeDisabled();
    await expect(card(page, 'Dashboard updates')).toContainText('Connect a GitHub account above first.');

    // A token GitHub refuses is not stored.
    await token.fill('ghp_wrong');
    await connectButton.click();
    await expect(account.locator('.error')).toHaveText('GitHub GET /user: 401 Bad credentials');
    expect(fs.existsSync(stack.files.github)).toBe(false);

    await token.fill(GOOD_TOKEN);
    await connectButton.click();
    await expect(account.getByText('Octo Tester')).toBeVisible();
    await expect(account.getByRole('link', { name: '@octo-e2e' })).toHaveAttribute('href', 'https://github.com/octo-e2e');
    await expect(account).toContainText(/Connected \d+ seconds? ago/);
    await expect(account.locator('img.gh-avatar')).toHaveJSProperty('complete', true);
    expect(await account.locator('img.gh-avatar').evaluate((img) => img.naturalWidth)).toBe(1);
    expect(stack.gh.find('GET', /^\/user$/).at(-1).headers.authorization).toBe(`Bearer ${GOOD_TOKEN}`);
    // Stored encrypted, never as the plain token.
    const saved = fs.readFileSync(stack.files.github, 'utf8');
    expect(saved).not.toContain(GOOD_TOKEN);
    expect(JSON.parse(saved).tokenSecret).toMatch(/^v1:/);
    await expect(card(page, 'Dashboard updates').getByRole('combobox', { name: 'Repository' })).toBeEnabled();

    await account.getByRole('button', { name: 'Disconnect' }).click();
    let dialog = page.getByRole('dialog', { name: 'Disconnect GitHub?' });
    await expect(dialog).toContainText('Scheduled backups and dashboard updates stop');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(account.getByText('Octo Tester')).toBeVisible();

    await account.getByRole('button', { name: 'Disconnect' }).click();
    dialog = page.getByRole('dialog', { name: 'Disconnect GitHub?' });
    await dialog.getByRole('button', { name: 'Disconnect' }).click();
    await expect(dialog).toBeHidden();
    await expect(account.getByLabel('Personal access token')).toBeVisible();
    expect(stack.readJson(stack.files.github)).toMatchObject({ tokenSecret: null, account: null });
  });

  test('choose the dashboard repository and branch, and save', async ({ page, stack }) => {
    await connect(stack);
    await loginAs(page, 'github');
    const dash = card(page, 'Dashboard updates');
    await expect(dash).toContainText('Choose the dashboard repository to check for updates.');
    await expect(dash.getByRole('button', { name: 'Save' })).toBeDisabled();

    const repo = dash.getByRole('combobox', { name: 'Repository' });
    const branch = dash.getByLabel('Branch');
    await repo.fill('public');
    await page.getByRole('listbox', { name: 'Repositories' }).getByRole('option', { name: 'acme/public-site' }).click();
    // Picking a repository fills in its default branch.
    await expect(branch).toHaveValue('trunk');

    // Keep the pointer off the list, or hovering would move the highlight.
    await page.mouse.move(0, 0);
    await repo.fill('');
    await repo.press('ArrowDown');
    await expect(page.getByRole('listbox', { name: 'Repositories' }).getByRole('option')).toHaveCount(3);
    await repo.press('ArrowDown');
    await expect(page.getByRole('option', { name: 'acme/nodered-user-admin' })).toHaveAttribute('aria-selected', 'true');
    await repo.press('Enter');
    await expect(repo).toHaveValue('acme/nodered-user-admin');
    await expect(branch).toHaveValue('main');
    await branch.fill('release');
    await dash.getByRole('button', { name: 'Save' }).click();
    await expect(dash.getByText('Saved.')).toBeVisible();
    expect(stack.readJson(stack.files.github)).toMatchObject({ dashboardRepo: 'acme/nodered-user-admin', dashboardBranch: 'release' });
    // The Actions runs are then checked for that branch.
    await expect(dash).toContainText('No successful build on release yet');
    const runs = stack.gh.find('GET', /\/actions\/workflows\/docker\.yml\/runs$/).at(-1);
    expect(runs.path).toBe('/repos/acme/nodered-user-admin/actions/workflows/docker.yml/runs');
    expect(runs.query.get('branch')).toBe('release');

    // A bad name is refused by the server.
    await repo.fill('not a repo');
    await dash.getByRole('button', { name: 'Save' }).click();
    await expect(dash.locator('.error')).toHaveText('Repository must look like owner/name.');
  });

  test('update states: none, available, building and failed', async ({ page, stack }) => {
    await connect(stack, { dashboardRepo: 'acme/nodered-user-admin', dashboardBranch: 'main' });
    await loginAs(page, 'github');
    const dash = card(page, 'Dashboard updates');
    const refresh = dash.getByRole('button', { name: 'Refresh' });
    const details = dash.locator('.gh-details');

    await expect(details).toContainText('No successful build on main yet');
    await expect(details).toContainText('local build');

    stack.gh.state.runs = [run({ sha: BUILD_SHA, message: 'Add feature X' })];
    await refresh.click();
    await expect(details.locator('.gh-available')).toHaveText('Update available');
    await expect(details.getByRole('link', { name: BUILD_SHA.slice(0, 7) })).toHaveAttribute('href', /actions\/runs\//);
    await expect(details).toContainText('Add feature X');
    await expect(dash.getByRole('button', { name: `Update to ${BUILD_SHA.slice(0, 7)}` })).toBeVisible();
    await expect(dash.locator('.notice.error')).toHaveCount(0);

    // A newer push is still building: the finished build stays available.
    stack.gh.state.runs = [run({ sha: BUILDING_SHA, status: 'in_progress', minutesAgo: 1 }), run({ sha: BUILD_SHA, message: 'Add feature X' })];
    await refresh.click();
    await expect(details.getByRole('link', { name: 'Build in progress' })).toBeVisible();
    await expect(details.locator('.gh-available')).toHaveText('Update available');

    // The newest build failed.
    stack.gh.state.runs = [run({ sha: FAILED_SHA, conclusion: 'failure', message: 'Broken build', minutesAgo: 2 }), run({ sha: BUILD_SHA, message: 'Add feature X' })];
    await refresh.click();
    const failed = dash.locator('.notice.error');
    await expect(failed).toContainText(`The latest build failed: Broken build (${FAILED_SHA.slice(0, 7)}).`);
    await expect(failed.getByRole('link', { name: 'View the run' })).toHaveAttribute('href', /actions\/runs\/ffffff/);
    await expect(details.getByRole('link', { name: 'Build in progress' })).toHaveCount(0);

    // Only failures and nothing to update to.
    stack.gh.state.runs = [run({ sha: FAILED_SHA, conclusion: 'failure', message: 'Broken build' })];
    await refresh.click();
    await expect(details).toContainText('No successful build on main yet');
    await expect(dash.getByRole('button', { name: /^Update to/ })).toHaveCount(0);
    await expect(failed).toBeVisible();
  });

  test('Update asks first, then starts the updater container and shows the Updating screen', async ({ page, stack }) => {
    stack.gh.state.runs = [run({ sha: BUILD_SHA, message: 'Add feature X' })];
    await connect(stack, { dashboardRepo: 'acme/nodered-user-admin', dashboardBranch: 'main' });
    await loginAs(page, 'github');
    const dash = card(page, 'Dashboard updates');
    const button = dash.getByRole('button', { name: `Update to ${BUILD_SHA.slice(0, 7)}` });

    await button.click();
    let dialog = page.getByRole('dialog', { name: 'Update the dashboard?' });
    await expect(dialog).toContainText(`Updates from dev to ${BUILD_SHA.slice(0, 7)} (Add feature X).`);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect(stack.docker.find('POST', /^\/containers\/create$/)).toHaveLength(0);

    await button.click();
    dialog = page.getByRole('dialog', { name: 'Update the dashboard?' });
    await dialog.getByRole('button', { name: 'Update' }).click();
    await expect(page.getByRole('status')).toHaveText('Updating… the dashboard will restart');
    await expect(page.locator('.gh-updating')).toContainText('The dashboard restarts in a few seconds and this page reloads.');

    const image = `ghcr.io/acme/nodered-user-admin:${BUILD_SHA}`;
    const pull = stack.docker.find('POST', /^\/images\/create$/);
    expect(pull).toHaveLength(1);
    expect(pull[0].query.get('fromImage')).toBe('ghcr.io/acme/nodered-user-admin');
    expect(pull[0].query.get('tag')).toBe(BUILD_SHA);
    const auth = JSON.parse(Buffer.from(pull[0].headers['x-registry-auth'], 'base64url').toString());
    expect(auth).toEqual({ username: 'octo-e2e', password: GOOD_TOKEN, serveraddress: 'ghcr.io' });

    const created = stack.docker.find('POST', /^\/containers\/create$/);
    expect(created).toHaveLength(1);
    expect(created[0].body).toMatchObject({
      Image: image,
      Cmd: ['node', 'self-update.js', CONTAINERS.dashboard, image],
      Labels: { 'nodered-admin.role': 'updater' },
      HostConfig: { NetworkMode: 'host', AutoRemove: true },
    });
    expect(created[0].body.Env).toEqual([`DOCKER_API=${stack.docker.url}`]);
    expect(stack.docker.find('POST', /^\/containers\/be1b1[0-9]*\/start$/)).toHaveLength(1);
    expect(stack.readJson(stack.files.dashboardUpdate)).toMatchObject({ from: 'dev', to: BUILD_SHA, image, by: 'administrator' });
  });
});
