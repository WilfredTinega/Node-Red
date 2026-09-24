import { addUserViaApi, expect, loginAs, test } from './fixtures.js';
import { CONTAINERS } from './support/mocks.js';
import { AUTH_HOST_DIR } from './support/stack.js';

const rows = (page) => page.locator('.instances-table tbody tr');
const row = (page, name) => rows(page).filter({ has: page.locator('.instance-name').getByText(name, { exact: true }) });
const cells = (r) => r.locator('td');

test.describe('instances', () => {
  test('lists every instance with its address, status and login', async ({ page, stack }) => {
    await loginAs(page, 'instances');
    await expect(rows(page)).toHaveCount(5);
    await expect(page.locator('.page-header p')).toHaveText('127.0.0.1 · 3 of 5 online');

    const main = row(page, 'nodered-main');
    await expect(main.locator('.tag')).toHaveText('docker');
    await expect(main.getByRole('link', { name: `127.0.0.1:${stack.nr.main.port}` })).toHaveAttribute('href', `http://127.0.0.1:${stack.nr.main.port}`);
    await expect(cells(main).nth(3)).toHaveText('Online');
    await expect(cells(main).nth(4)).toHaveText('Login required');
    await expect(main.getByRole('button', { name: 'Restart' })).toBeVisible();
    await expect(main.getByRole('button', { name: 'Update' })).toBeVisible();
    // Already uses the shared logins: nothing to connect.
    await expect(main.getByRole('button', { name: 'Connect' })).toHaveCount(0);

    const open = row(page, 'nodered-open');
    await expect(cells(open).nth(3)).toHaveText('Online');
    await expect(cells(open).nth(4)).toHaveText('No login');
    await expect(cells(open).nth(4)).toHaveClass(/error/);
    await expect(open.getByRole('button', { name: 'Connect' })).toBeVisible();

    const stopped = row(page, 'nodered-stopped');
    await expect(cells(stopped).nth(1)).toHaveText('No published port');
    await expect(cells(stopped).nth(3)).toHaveText('Stopped');
    await expect(cells(stopped).nth(3).locator('.status')).toHaveAttribute('title', 'Exited (0) 3 days ago');
    await expect(cells(stopped).nth(4)).toHaveText('—');

    const pkg = row(page, 'Package NR');
    await expect(pkg.locator('.tag')).toHaveText('package');
    await expect(cells(pkg).nth(3)).toHaveText('Online');
    await expect(cells(pkg).nth(4)).toHaveText('Login required');
    await expect(pkg.getByRole('button', { name: 'Update…' })).toBeVisible();
    await expect(pkg.getByRole('button', { name: 'Connect' })).toBeVisible();
    await expect(pkg.getByRole('button', { name: 'Restart' })).toHaveCount(0);

    const gone = row(page, 'Gone NR');
    await expect(cells(gone).nth(3)).toHaveText('Not responding');
    await expect(cells(gone).nth(4)).toHaveText('—');

    // Without a host port scan the server has no version to report.
    for (const name of ['nodered-main', 'nodered-open', 'Package NR']) await expect(cells(row(page, name)).nth(2)).toHaveText('—');
  });

  test('shows the version the server reports', async ({ page }) => {
    // Versions only come from the host port scan, which the tests keep off
    // (it would probe real Node-RED on this machine), so add them to the answer.
    await page.route('**/api/instances', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      for (const i of body.instances) if (i.name === 'nodered-main') i.version = '4.0.9';
      await route.fulfill({ response: res, json: body });
    });
    await loginAs(page, 'instances');
    await expect(cells(row(page, 'nodered-main')).nth(2)).toHaveText('4.0.9');
    await expect(cells(row(page, 'nodered-main')).nth(2)).not.toHaveClass(/muted/);
    await expect(cells(row(page, 'nodered-open')).nth(2)).toHaveClass(/muted/);
  });

  // The instruction Connect dialog is the fallback for a package install when
  // the host agent is not installed (the stack does not set HOST_AGENT_SOCKET).
  test('Connect (fallback) shows the auth folder and NODERED_INSTANCE for the port', async ({ page, stack }) => {
    await loginAs(page, 'instances');
    await row(page, 'Package NR').getByRole('button', { name: 'Connect' }).click();
    const dialog = page.getByRole('dialog', { name: 'Connect Package NR to the shared accounts' });
    await expect(dialog).toBeVisible();
    // A package install opens on the Package Install tab.
    await expect(dialog.getByRole('button', { name: 'Package install' })).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByText('Before you switch')).toBeVisible();
    const before = dialog.locator('.before-steps li');
    await expect(before).toHaveCount(3);
    const blocks = dialog.locator('pre code');
    await expect(blocks.nth(0)).toHaveText(`adminAuth: require('${AUTH_HOST_DIR}/adminAuth.js'),`);
    await expect(blocks.nth(1)).toHaveText(`Environment=NODERED_INSTANCE=${stack.nr.pkg.port}`);

    // The Docker tab shows the read-only mount and NODERED_INSTANCE for the port.
    await dialog.getByRole('button', { name: 'Docker' }).click();
    await expect(blocks.nth(0)).toHaveText(`-v ${AUTH_HOST_DIR}:/auth:ro\n-e NODERED_INSTANCE=${stack.nr.pkg.port}`);
    await expect(blocks.nth(1)).toHaveText("adminAuth: require('/auth/adminAuth.js'),");

    await dialog.getByRole('button', { name: 'Copy' }).first().click();
    await expect(dialog.getByRole('button', { name: 'Copied' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // A package install opens on the package tab.
    await row(page, 'Package NR').getByRole('button', { name: 'Connect' }).click();
    const pkgDialog = page.getByRole('dialog', { name: 'Connect Package NR to the shared accounts' });
    await expect(pkgDialog.getByRole('button', { name: 'Package install' })).toHaveAttribute('aria-pressed', 'true');
    await expect(pkgDialog.locator('pre code').nth(1)).toHaveText(`Environment=NODERED_INSTANCE=${stack.nr.pkg.port}`);
    await pkgDialog.getByRole('button', { name: 'Done' }).click();
    await expect(pkgDialog).toBeHidden();
  });

  test('a shared-login container without its NODERED_INSTANCE key gets a warning that opens Connect', async ({ page, stack }) => {
    const main = stack.docker.list.find((c) => c.Names[0] === '/nodered-main');
    const port = stack.nr.main.port;
    main.Env = [];
    await loginAs(page, 'instances');
    const mainRow = row(page, 'nodered-main');
    await expect(mainRow.locator('.tag').first()).toHaveText('docker');
    const tag = mainRow.getByRole('button', { name: 'instance key' });
    await expect(tag).toHaveClass(/warn/);
    await expect(tag).toHaveAttribute('title', `NODERED_INSTANCE is not set; this instance's key is ${port}. Per-instance access rules will not work until it is set.`);
    // The other containers are fine: one is not sharing the accounts, one has no port.
    await expect(page.locator('.instances-table .tag.warn')).toHaveCount(1);

    await tag.click();
    const dialog = page.getByRole('dialog', { name: 'Connect nodered-main to the shared accounts' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('pre code').nth(0)).toHaveText(`-v ${AUTH_HOST_DIR}:/auth:ro\n-e NODERED_INSTANCE=${port}`);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(tag).toBeFocused();

    // A key that differs from the published port is a mismatch too.
    main.Env = ['NODERED_INSTANCE=1880'];
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(mainRow.getByRole('button', { name: 'instance key' })).toHaveAttribute(
      'title',
      `NODERED_INSTANCE is 1880; this instance's key is ${port}. Per-instance access rules will not work until it is set.`,
    );

    // Set correctly: the warning goes.
    main.Env = [`NODERED_INSTANCE=${port}`];
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.locator('.instances-table .tag.warn')).toHaveCount(0);

    // A read-only user sees the warning, but not as a button.
    main.Env = [];
    await addUserViaApi(stack, { username: 'viewer@upande.com', permissions: 'read', password: 'viewer-password-1' });
    await loginAs(page, 'instances', { username: 'viewer@upande.com', password: 'viewer-password-1' });
    await expect(row(page, 'nodered-main').locator('.tag.warn')).toHaveText('instance key');
    await expect(page.locator('.instances-table tbody button')).toHaveCount(0);
  });

  test('Update… on a package install shows the commands to run', async ({ page }) => {
    await loginAs(page, 'instances');
    await row(page, 'Package NR').getByRole('button', { name: 'Update…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Update Package NR' });
    await expect(dialog.locator('pre code')).toContainText('npm install -g --unsafe-perm node-red@latest');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();
  });

  test('Restart asks first, calls Docker, and reports the result', async ({ page, stack }) => {
    stack.docker.state.restartDelay = 600;
    await loginAs(page, 'instances');
    const main = row(page, 'nodered-main');
    const restartPath = `/containers/${CONTAINERS.main.slice(0, 12)}/restart`;

    // Cancel does nothing.
    await main.getByRole('button', { name: 'Restart' }).click();
    let dialog = page.getByRole('dialog', { name: 'Restart nodered-main' });
    await expect(dialog).toContainText('The editor and running flows stop for a few seconds.');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect(stack.docker.find('POST', /\/restart$/)).toHaveLength(0);

    await main.getByRole('button', { name: 'Restart' }).click();
    dialog = page.getByRole('dialog', { name: 'Restart nodered-main' });
    await dialog.getByRole('button', { name: 'Restart' }).click();
    await expect(dialog).toBeHidden();
    await expect(main.getByRole('button', { name: 'Restarting…' })).toBeDisabled();
    await expect(main.getByRole('button', { name: 'Update' })).toBeDisabled();
    const notice = page.locator('.notice.result');
    await expect(notice).toHaveText(/nodered-main: Restarted\./);
    await expect(notice).toHaveClass(/ok/);
    expect(stack.docker.find('POST', /\/restart$/).map((r) => r.path)).toEqual([restartPath]);
    await expect(main.getByRole('button', { name: 'Restart' })).toBeEnabled();

    await notice.getByRole('button', { name: 'Dismiss' }).click();
    await expect(notice).toHaveCount(0);
  });

  test('Update asks first, pulls the image and reports the result', async ({ page, stack }) => {
    await loginAs(page, 'instances');
    const main = row(page, 'nodered-main');
    await main.getByRole('button', { name: 'Update' }).click();
    const dialog = page.getByRole('dialog', { name: 'Update nodered-main' });
    await expect(dialog.locator('code')).toHaveText('nodered/node-red:4.0.9');
    await dialog.getByRole('button', { name: 'Update' }).click();
    await expect(page.locator('.notice.result.ok')).toHaveText(/Already on the newest nodered\/node-red:4\.0\.9\. Restarted it\./);

    const pulls = stack.docker.find('POST', /^\/images\/create$/);
    expect(pulls).toHaveLength(1);
    expect(pulls[0].query.get('fromImage')).toBe('nodered/node-red');
    expect(pulls[0].query.get('tag')).toBe('4.0.9');
    expect(stack.docker.find('POST', /\/restart$/).map((r) => r.path)).toEqual([`/containers/${CONTAINERS.main.slice(0, 12)}/restart`]);
  });

  test('a failed restart shows an error notice', async ({ page, stack }) => {
    await loginAs(page, 'instances');
    await expect(row(page, 'nodered-main')).toBeVisible();
    // Docker stops answering between listing and restarting.
    await stack.docker.close();
    await row(page, 'nodered-main').getByRole('button', { name: 'Restart' }).click();
    await page.getByRole('dialog', { name: 'Restart nodered-main' }).getByRole('button', { name: 'Restart' }).click();
    await expect(page.locator('.notice.result.error')).toHaveText(/nodered-main: That container is not a Node-RED instance on this server\./);
  });

  test('a read-only user sees the list but no actions', async ({ page, stack }) => {
    await addUserViaApi(stack, { username: 'viewer@upande.com', permissions: 'read', password: 'viewer-password-1' });
    await loginAs(page, 'instances', { username: 'viewer@upande.com', password: 'viewer-password-1' });
    await expect(page.locator('.topbar .tag')).toHaveText('read only');
    await expect(rows(page)).toHaveCount(5);
    await expect(page.locator('.instances-table thead th')).toHaveCount(5);
    await expect(page.locator('.instances-table tbody button')).toHaveCount(0);
    await expect(page.locator('.instances-table tbody tr').first().locator('td')).toHaveCount(5);

    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link')).toHaveText(['Instances', 'My account']);
    // Admin pages typed into the address bar fall back to Instances.
    for (const hash of ['users', 'backups', 'github']) {
      await page.goto(`/#/${hash}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Instances' })).toBeVisible();
    }

    // And the server refuses the actions too.
    const res = await page.request.post(`/api/instances/${CONTAINERS.main.slice(0, 12)}/restart`, { headers: { 'X-Requested-With': 'fetch' }, data: {} });
    expect(res.status()).toBe(403);
    expect(stack.docker.find('POST', /\/restart$/)).toHaveLength(0);
  });
});
