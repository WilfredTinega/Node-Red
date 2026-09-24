import fs from 'node:fs';
import { expect, expectNoHorizontalScroll, goTo, isPhone, loginAs, test } from './fixtures.js';

const PAGES = [
  { hash: 'instances', label: 'Instances' },
  { hash: 'users', label: 'Users' },
  { hash: 'backups', label: 'Backups' },
  { hash: 'github', label: 'GitHub' },
  { hash: 'activity', label: 'Activity' },
  { hash: 'account', label: 'My account' },
];

// Many accounts written straight into users.json make the Users page long.
function addManyUsers(stack, n) {
  const users = stack.readJson(stack.files.users);
  for (let i = 0; i < n; i++) users.push({ username: `filler-user-${String(i).padStart(2, '0')}@upande.com`, permissions: 'read', password: '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva' });
  fs.writeFileSync(stack.files.users, JSON.stringify(users, null, 2));
}

test.describe('app shell', () => {
  test('the top bar stays fixed while a long page scrolls', async ({ page, stack }) => {
    addManyUsers(stack, 40);
    await loginAs(page, 'users');
    await expect(page.getByRole('cell', { name: 'filler-user-39@upande.com', exact: true })).toBeVisible();
    const topbar = page.locator('.topbar');
    const before = await topbar.boundingBox();
    expect(before.y).toBe(0);

    await page.evaluate(() => window.scrollTo(0, 3000));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
    const after = await topbar.boundingBox();
    expect(after.y).toBe(0);
    await expect(topbar.getByRole('button', { name: 'Log out' })).toBeInViewport();
    // Content scrolls underneath it: what is at the top-bar's position is the top bar.
    const onTop = await page.evaluate(() => document.elementFromPoint(window.innerWidth - 20, 20)?.closest('.topbar') !== null);
    expect(onTop).toBe(true);
  });

  test('the sidebar highlights the page that is open', async ({ page }, testInfo) => {
    await loginAs(page, 'instances');
    for (const p of PAGES) {
      await goTo(page, testInfo, p.label);
      await expect(page).toHaveURL(new RegExp(`#/${p.hash}$`));
      await expect(page.getByRole('heading', { level: 1, name: p.label })).toBeVisible();
      const nav = page.getByRole('navigation', { name: 'Main' });
      await expect(nav.getByRole('link', { name: p.label })).toHaveAttribute('aria-current', 'page');
      await expect(nav.locator('.nav-item.active')).toHaveCount(1);
      await expect(nav.locator('.nav-item.active')).toHaveText(p.label);
    }
  });

  test('an unknown page falls back to Instances', async ({ page }) => {
    await loginAs(page, 'no-such-page');
    await expect(page.getByRole('heading', { level: 1, name: 'Instances' })).toBeVisible();
    await expect(page.locator('.nav-item.active')).toHaveText('Instances');
  });

  test('the brand links back to Instances', async ({ page }) => {
    await loginAs(page, 'account');
    await page.locator('.topbar .brand').click();
    await expect(page.getByRole('heading', { level: 1, name: 'Instances' })).toBeVisible();
  });

  test('on a phone, the menu button opens and closes the sidebar, and the scrim closes it', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'phone layout only');
    await loginAs(page, 'instances');
    const menu = page.getByRole('button', { name: 'Menu' });
    const sidebar = page.locator('.sidebar');
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await expect(sidebar).not.toBeInViewport();

    await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    await expect(sidebar).toBeInViewport({ ratio: 1 });
    await expect(page.locator('.nav-scrim')).toBeVisible();

    await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await expect(sidebar).not.toBeInViewport();
    await expect(page.locator('.nav-scrim')).toHaveCount(0);

    await menu.click();
    await expect(sidebar).toBeInViewport({ ratio: 1 });
    // Tap the scrim to the right of the sidebar.
    await page.locator('.nav-scrim').click({ position: { x: 370, y: 400 } });
    await expect(sidebar).not.toBeInViewport();
    await expect(menu).toHaveAttribute('aria-expanded', 'false');

    // Choosing a page closes it too.
    await menu.click();
    await sidebar.getByRole('link', { name: 'Users' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
    await expect(sidebar).not.toBeInViewport();

    // So does tapping the page that is already open.
    await menu.click();
    await expect(sidebar).toBeInViewport({ ratio: 1 });
    await sidebar.getByRole('link', { name: 'Users' }).click();
    await expect(sidebar).not.toBeInViewport();
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
  });

  test('on desktop the sidebar is always shown and there is no menu button', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'desktop layout only');
    await loginAs(page, 'instances');
    await expect(page.getByRole('button', { name: 'Menu' })).toBeHidden();
    await expect(page.locator('.sidebar')).toBeInViewport({ ratio: 1 });
  });

  test('no page scrolls sideways', async ({ page, stack }, testInfo) => {
    addManyUsers(stack, 3);
    await loginAs(page, 'instances');
    for (const p of PAGES) {
      await goTo(page, testInfo, p.label);
      await expect(page.getByRole('heading', { level: 1, name: p.label })).toBeVisible();
      // Wait for each page's data so the widest content is on screen.
      if (p.hash === 'instances') await expect(page.locator('.instances-table tbody tr')).toHaveCount(5);
      if (p.hash === 'users') await expect(page.locator('.users-table tbody tr')).toHaveCount(4);
      if (p.hash === 'backups') await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
      if (p.hash === 'github') await expect(page.getByRole('heading', { name: 'Dashboard updates' })).toBeVisible();
      await expectNoHorizontalScroll(page);
    }
    await page.goto('/');
    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
