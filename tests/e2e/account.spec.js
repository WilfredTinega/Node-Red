import { ADMIN, addUserViaApi, expect, loginAs, loginWithForm, test } from './fixtures.js';

test.describe('my account', () => {
  test('shows who is logged in', async ({ page }) => {
    await loginAs(page, 'account');
    const profile = page.locator('.details');
    await expect(profile).toContainText('administrator');
    await expect(profile).toContainText('Full access (admin)');
    await expect(profile).toContainText('All instances');
    await expect(page.locator('.notice')).toContainText('built-in administrator account');
  });

  test('change your own password, then log in with it', async ({ page, stack }) => {
    await addUserViaApi(stack, { username: 'me@upande.com', permissions: 'read', password: 'old-password-1', instances: { [String(stack.nr.main.port)]: 'read' } });
    await loginAs(page, 'account', { username: 'me@upande.com', password: 'old-password-1' });
    await expect(page.locator('.details')).toContainText('Set per instance');
    await expect(page.locator('.details')).toContainText('1 chosen instances');
    // Nothing to give up: the account is not an admin.
    await expect(page.getByRole('heading', { name: 'Full access' })).toHaveCount(0);

    const current = page.getByLabel('Current password');
    const next = page.getByLabel('New password', { exact: true });
    const repeat = page.getByLabel('Repeat new password');
    const submit = page.getByRole('button', { name: 'Change password' });

    // Mismatch and a wrong current password are refused.
    await current.fill('old-password-1');
    await next.fill('new-password-22');
    await repeat.fill('new-password-23');
    await submit.click();
    await expect(page.locator('form .error')).toHaveText('The new passwords do not match.');
    await current.fill('not-my-password');
    await repeat.fill('new-password-22');
    await submit.click();
    await expect(page.locator('form .error')).toHaveText('Current password is wrong.');

    await current.fill('old-password-1');
    await submit.click();
    await expect(page.locator('form .ok')).toHaveText('Password changed. Use it next time you log in to Node-RED.');
    await expect(current).toHaveValue('');
    // The session that made the change stays logged in.
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'My account' })).toBeVisible();

    await page.getByRole('button', { name: 'Log out' }).click();
    await loginWithForm(page, 'me@upande.com', 'old-password-1');
    await expect(page.locator('form .error')).toHaveText('Wrong username or password.');
    await loginWithForm(page, 'me@upande.com', 'new-password-22');
    // Logged in again, back on the page that was open.
    await expect(page.getByRole('heading', { level: 1, name: 'My account' })).toBeVisible();
    await expect(page.locator('.topbar .who-name')).toHaveText('me@upande.com');
  });

  test('an admin can give up full access, and only an admin can give it back', async ({ page, stack }) => {
    await addUserViaApi(stack, { username: 'admin2@upande.com', permissions: '*', password: 'admin2-password' });
    await loginAs(page, 'account', { username: 'admin2@upande.com', password: 'admin2-password' });
    await expect(page.locator('.topbar .tag')).toHaveText('admin');
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link')).toHaveText(['Instances', 'Users', 'Backups', 'GitHub', 'My account']);

    const card = page.locator('section.card', { has: page.getByRole('heading', { name: 'Full access' }) });
    const button = card.getByRole('button', { name: 'Give up full access' });
    await button.click();
    const dialog = page.getByRole('dialog', { name: 'Give up full access?' });
    await expect(dialog).toContainText('read only on this dashboard and on every instance, immediately');
    await expect(dialog).toContainText('Only an admin can give you full access back.');
    // Cancel changes nothing, and focus returns to the button.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(button).toBeFocused();
    await expect(page.locator('.topbar .tag')).toHaveText('admin');
    expect(stack.readJson(stack.files.users).find((u) => u.username === 'admin2@upande.com').permissions).toBe('*');

    await button.click();
    await page.getByRole('dialog', { name: 'Give up full access?' }).getByRole('button', { name: 'Give up full access' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // Read only at once: the admin pages leave the menu, the page stays on My account.
    await expect(page.locator('.topbar .tag')).toHaveText('read only');
    await expect(nav.getByRole('link')).toHaveText(['Instances', 'My account']);
    await expect(page.getByRole('heading', { level: 1, name: 'My account' })).toBeVisible();
    await expect(page).toHaveURL(/#\/account$/);
    await expect(page.locator('.details')).toContainText('Read only');
    await expect(card).toHaveCount(0);
    expect(stack.readJson(stack.files.users).find((u) => u.username === 'admin2@upande.com').permissions).toBe('read');
    // And the server agrees: the admin API is closed to them now.
    expect((await page.request.get('/api/users')).status()).toBe(403);
    expect((await page.request.post('/api/me/demote', { headers: { 'X-Requested-With': 'fetch' }, data: {} })).status()).toBe(400);
  });

  test('the administrator cannot give up full access', async ({ page, stack }) => {
    await loginAs(page, 'account');
    const card = page.locator('section.card', { has: page.getByRole('heading', { name: 'Full access' }) });
    await expect(card).toContainText('This account always keeps full access.');
    await expect(card.getByRole('button')).toHaveCount(0);
    const res = await page.request.post('/api/me/demote', { headers: { 'X-Requested-With': 'fetch' }, data: {} });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe('administrator cannot give up full access.');
    expect(stack.readJson(stack.files.users).find((u) => u.username === ADMIN.username).permissions).toBe('*');
  });

  test('the administrator can change its own password too', async ({ page }) => {
    await loginAs(page, 'account');
    await page.getByLabel('Current password').fill(ADMIN.password);
    await page.getByLabel('New password', { exact: true }).fill('a-new-admin-pass');
    await page.getByLabel('Repeat new password').fill('a-new-admin-pass');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.locator('form .ok')).toBeVisible();
    await page.getByRole('button', { name: 'Log out' }).click();
    await loginWithForm(page, ADMIN.username, 'a-new-admin-pass');
    await expect(page.getByRole('heading', { level: 1, name: 'My account' })).toBeVisible();
    await expect(page.locator('.topbar .tag')).toHaveText('admin');
  });
});
