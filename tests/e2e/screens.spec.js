// Screenshots of every page in light and dark, at both sizes, for a person
// to look over: test-results/screens/<project>-<scheme>-<page>.png
import path from 'node:path';
import { addUserViaApi, expect, expectNoHorizontalScroll, loginAs, openSelect, test } from './fixtures.js';
import { BUILD_SHA, BUILDING_SHA, GOOD_TOKEN, run } from './support/mocks.js';
import { ROOT } from './support/stack.js';

const DIR = path.join(ROOT, 'test-results', 'screens');

for (const scheme of ['light', 'dark']) {
  test(`every page in ${scheme}`, async ({ page, stack }, testInfo) => {
    test.setTimeout(60000);
    const file = (name) => path.join(DIR, `${testInfo.project.name}-${scheme}-${name}.png`);
    // Whole page from the top (a scrolled page would draw the fixed top bar mid-way).
    const shot = async (name) => {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: file(name), fullPage: true, animations: 'disabled' });
    };
    // Just the viewport: a full-page shot resizes it, which closes an open Select.
    const view = (name) => page.screenshot({ path: file(name), animations: 'disabled' });
    await page.emulateMedia({ colorScheme: scheme });

    // Something on every page: accounts, GitHub, a backup, an update.
    const api = await stack.client();
    await api('POST', '/api/github/connect', { token: GOOD_TOKEN });
    await api('PUT', '/api/github', { dashboardRepo: 'acme/nodered-user-admin' });
    await api('PUT', '/api/backup', { repo: 'acme/flows-backup', schedule: { mode: 'hours', everyHours: 6 } });
    expect((await api('POST', '/api/backup/run')).body.ok).toBe(true);
    stack.gh.state.runs = [run({ sha: BUILDING_SHA, status: 'in_progress', minutesAgo: 1 }), run({ sha: BUILD_SHA, message: 'Add feature X' })];
    await addUserViaApi(stack, { username: 'reader@upande.com', permissions: 'read', password: 'reader-password' });
    await addUserViaApi(stack, { username: 'limited.user.with.a.long.name@upande.com', permissions: '*', password: 'limited-password', instances: { [String(stack.nr.main.port)]: 'read' } });

    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
    await page.getByLabel('Username').fill('administrator');
    await page.getByLabel('Password').fill('wrong');
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.locator('form .error')).toBeVisible();
    await shot('login');

    await loginAs(page, 'instances');
    await expect(page.locator('.instances-table tbody tr')).toHaveCount(5);
    await shot('instances');
    await page.locator('.instances-table tbody tr', { hasText: 'nodered-open' }).getByRole('button', { name: 'Connect' }).click();
    await view('instances-connect-dialog');
    await page.keyboard.press('Escape');

    await page.goto('/#/users');
    await expect(page.locator('.users-table tbody tr', { hasText: 'limited.user' })).toBeVisible();
    await page.locator('.users-table tbody tr', { hasText: 'reader@upande.com' }).getByRole('button', { name: /^Show password/ }).click();
    await expect(page.locator('.users-table .pw code')).toBeVisible();
    await shot('users');
    await page.locator('.users-table tbody tr', { hasText: 'limited.user' }).getByRole('button', { name: /^Instances for/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('.access-row')).toHaveCount(4);
    await openSelect(page, dialog.locator('.access-row .select-button').last());
    await view('users-access-dialog');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await page.goto('/#/backups');
    await expect(page.locator('.bk-history tbody tr')).toHaveCount(1);
    await page.locator('.bk-history summary').click();
    await shot('backups');

    await page.goto('/#/github');
    await expect(page.getByText('Update available')).toBeVisible();
    await shot('github');

    await page.goto('/#/account');
    await expect(page.getByRole('heading', { name: 'Change password' })).toBeVisible();
    await shot('account');

    if (testInfo.project.name === 'phone') {
      await page.getByRole('button', { name: 'Menu' }).click();
      await expect(page.locator('.sidebar')).toBeInViewport({ ratio: 1 });
      await view('menu-open');
      await page.locator('.nav-scrim').click({ position: { x: 370, y: 400 } });
    }

    // Logged in as a read-only user.
    await page.getByRole('button', { name: 'Log out' }).click();
    await loginAs(page, 'instances', { username: 'reader@upande.com', password: 'reader-password' });
    await expect(page.locator('.instances-table tbody tr')).toHaveCount(5);
    await expectNoHorizontalScroll(page);
    await shot('instances-read-only');
  });
}
