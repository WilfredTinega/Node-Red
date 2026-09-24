import { ADMIN, expect, loginAs, loginWithForm, test } from './fixtures.js';

test.describe('login', () => {
  test('a wrong password shows an error and stays on the login form', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Node-RED' })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Upande' })).toBeVisible();
    await loginWithForm(page, ADMIN.username, 'not-the-password');
    await expect(page.locator('form .error')).toHaveText('Wrong username or password.');
    await expect(page.getByRole('button', { name: 'Log in' })).toBeEnabled();
    await expect(page.locator('.topbar')).toHaveCount(0);
  });

  test('an unknown user gets the same error as a wrong password', async ({ page }) => {
    await page.goto('/');
    await loginWithForm(page, 'nobody-here', 'whatever-password');
    await expect(page.locator('form .error')).toHaveText('Wrong username or password.');
  });

  test('five wrong passwords lock the login for a while, with a countdown', async ({ page }) => {
    await page.goto('/');
    const button = page.getByRole('button', { name: 'Log in' });
    for (let i = 0; i < 4; i++) {
      await loginWithForm(page, ADMIN.username, `wrong-password-${i}`);
      await expect(page.locator('form .error')).toHaveText('Wrong username or password.');
      await expect(button).toBeEnabled();
    }
    await loginWithForm(page, ADMIN.username, 'wrong-password-5');
    const status = page.locator('form [role="status"]');
    await expect(status).toContainText('Too many failed attempts. Try again in');
    await expect(status.locator('strong')).toHaveText(/^1[45]:\d{2}$/);
    await expect(button).toBeDisabled();
    // It counts down.
    const first = await status.locator('strong').textContent();
    await expect.poll(() => status.locator('strong').textContent(), { timeout: 5000 }).not.toBe(first);
    // The right password is refused too while locked out.
    const res = await page.request.post('/api/login', { headers: { 'X-Requested-With': 'fetch' }, data: { username: ADMIN.username, password: ADMIN.password } });
    expect(res.status()).toBe(429);
    expect((await res.json()).retryAfterMs).toBeGreaterThan(0);
  });

  test('logging in lands on Instances, logging out returns to the form', async ({ page }) => {
    await page.goto('/');
    await loginWithForm(page, ADMIN.username, ADMIN.password);
    await expect(page.getByRole('heading', { level: 1, name: 'Instances' })).toBeVisible();
    await expect(page.locator('.topbar .tag')).toHaveText('admin');
    await expect(page.getByRole('link', { name: 'Instances' })).toHaveAttribute('aria-current', 'page');

    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
    // The session really is gone: a reload does not log back in.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
    const me = await page.request.get('/api/me');
    expect(me.status()).toBe(401);
  });

  test('a session that ends on the server sends the page back to the login form', async ({ page, stack, context }) => {
    await loginAs(page, 'instances');
    await expect(page.locator('.instances-table')).toBeVisible();

    // End the session server-side, keeping the browser's cookie (as when it expires).
    const cookie = (await context.cookies()).find((c) => c.name === 'nrua_session');
    const res = await fetch(`${stack.url}/api/logout`, { method: 'POST', headers: { Cookie: `nrua_session=${cookie.value}`, 'X-Requested-With': 'fetch' } });
    expect(res.ok).toBeTruthy();

    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();

    // And logging in again works.
    await loginWithForm(page, ADMIN.username, ADMIN.password);
    await expect(page.getByRole('heading', { level: 1, name: 'Instances' })).toBeVisible();
  });

  test('a 401 from any page action returns to login', async ({ page, context }) => {
    await loginAs(page, 'account');
    await context.clearCookies();
    await page.getByLabel('Current password').fill('whatever-old');
    await page.getByLabel('New password', { exact: true }).fill('abcdefghijk');
    await page.getByLabel('Repeat new password').fill('abcdefghijk');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
  });
});
