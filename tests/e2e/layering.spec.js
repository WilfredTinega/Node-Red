// While a dialog is open, its backdrop covers the fixed top bar and sidebar,
// and a custom Select inside the dialog opens above the dialog.
import { addUserViaApi, expect, isPhone, loginAs, openSelect, test, topElementAt } from './fixtures.js';
import { BUILD_SHA, GOOD_TOKEN, run } from './support/mocks.js';

async function expectShellCovered(page, testInfo) {
  const targets = [page.locator('.topbar').getByRole('button', { name: 'Log out' }), page.locator('.topbar .brand')];
  if (isPhone(testInfo)) targets.push(page.getByRole('button', { name: 'Menu' }));
  else targets.push(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Instances' }), page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'My account' }));
  for (const t of targets) {
    const top = await topElementAt(t);
    expect(top.self, `${await t.textContent()} is covered`).toBe(false);
    expect(top.inBackdrop).toBe(true);
  }
  // A real click where "Log out" is lands on the backdrop, which closes the
  // dialog; it never logs out. On a phone a tall dialog can sit there itself:
  // then the click lands on the dialog, which stays open, and Escape closes it.
  const box = await targets[0].boundingBox();
  const { inDialog } = await topElementAt(targets[0]);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  if (inDialog) {
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await page.keyboard.press('Escape');
  }
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.topbar')).toBeVisible();
  expect((await page.request.get('/api/me')).status()).toBe(200);
}

test.describe('dialog layering', () => {
  test('Users page dialogs cover the top bar and sidebar', async ({ page, stack }, testInfo) => {
    await addUserViaApi(stack, { username: 'layer@upande.com', permissions: 'read', password: 'layer-password' });
    await loginAs(page, 'users');
    const row = page.locator('.users-table tbody tr', { hasText: 'layer@upande.com' });

    await row.getByRole('button', { name: 'Reset password' }).click();
    await expect(page.getByRole('dialog', { name: 'Reset password for layer@upande.com' })).toBeVisible();
    await expectShellCovered(page, testInfo);

    await row.getByRole('button', { name: 'Delete layer@upande.com' }).click();
    await expect(page.getByRole('dialog', { name: 'Delete user' })).toBeVisible();
    await expectShellCovered(page, testInfo);

    await row.getByRole('button', { name: /^Instances for layer@upande.com/ }).click();
    await expect(page.getByRole('dialog', { name: 'Instance access for layer@upande.com' })).toBeVisible();
    await expectShellCovered(page, testInfo);

    // The shown-once password dialog too.
    await page.locator('section.card', { hasText: 'Add user' }).getByLabel('Username').fill('shown@upande.com');
    await page.getByRole('button', { name: 'Add user' }).click();
    await expect(page.getByRole('dialog', { name: 'New password' })).toBeVisible();
    await expectShellCovered(page, testInfo);
  });

  test('Instances and GitHub dialogs cover the top bar and sidebar', async ({ page, stack }, testInfo) => {
    const api = await stack.client();
    await api('POST', '/api/github/connect', { token: GOOD_TOKEN });
    await api('PUT', '/api/github', { dashboardRepo: 'acme/nodered-user-admin' });
    stack.gh.state.runs = [run({ sha: BUILD_SHA })];

    await loginAs(page, 'instances');
    const main = page.locator('.instances-table tbody tr', { hasText: 'nodered-main' });
    for (const [button, title] of [
      ['Restart', 'Restart nodered-main'],
      ['Update', 'Update nodered-main'],
    ]) {
      await main.getByRole('button', { name: button, exact: true }).click();
      await expect(page.getByRole('dialog', { name: title })).toBeVisible();
      await expectShellCovered(page, testInfo);
    }
    await page.locator('.instances-table tbody tr', { hasText: 'nodered-open' }).getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByRole('dialog', { name: /^Connect nodered-open/ })).toBeVisible();
    await expectShellCovered(page, testInfo);
    await page.locator('.instances-table tbody tr', { hasText: 'Package NR' }).getByRole('button', { name: 'Update…' }).click();
    await expect(page.getByRole('dialog', { name: 'Update Package NR' })).toBeVisible();
    await expectShellCovered(page, testInfo);
    expect(stack.docker.find('POST', /\/restart$/)).toHaveLength(0);

    await page.goto('/#/github');
    await page.getByRole('button', { name: 'Disconnect' }).click();
    await expect(page.getByRole('dialog', { name: 'Disconnect GitHub?' })).toBeVisible();
    await expectShellCovered(page, testInfo);
    await page.getByRole('button', { name: `Update to ${BUILD_SHA.slice(0, 7)}` }).click();
    await expect(page.getByRole('dialog', { name: 'Update the dashboard?' })).toBeVisible();
    await expectShellCovered(page, testInfo);
    expect(stack.docker.find('POST', /^\/containers\/create$/)).toHaveLength(0);
  });

  test('a Select inside a dialog opens above it and works by mouse and keyboard', async ({ page, stack }) => {
    await addUserViaApi(stack, { username: 'pick@upande.com', permissions: 'read', password: 'pick-password' });
    await loginAs(page, 'users');
    await page.locator('.users-table tbody tr', { hasText: 'pick@upande.com' }).getByRole('button', { name: /^Instances for pick@upande.com/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Instance access for pick@upande.com' });
    await dialog.getByRole('radio', { name: 'Only chosen instances' }).check();

    // The last row, nearest the bottom of the dialog.
    const selects = dialog.locator('.access-row .select-button');
    await expect(selects).toHaveCount(4);
    const last = selects.last();
    const list = await openSelect(page, last);
    const options = list.getByRole('option');
    await expect(options).toHaveCount(3);
    // On top of everything, including the dialog, at every option.
    for (let i = 0; i < 3; i++) expect((await topElementAt(options.nth(i))).inListbox).toBe(true);
    // Fully on screen.
    await expect(list).toBeInViewport({ ratio: 1 });
    const z = await list.evaluate((el) => Number(getComputedStyle(el).zIndex));
    const dz = await page.locator('.backdrop').evaluate((el) => Number(getComputedStyle(el).zIndex));
    expect(z).toBeGreaterThan(dz);
    await options.filter({ hasText: 'Full access' }).click();
    await expect(list).toBeHidden();
    await expect(last).toContainText('Full access');
    // Choosing did not close the dialog.
    await expect(dialog).toBeVisible();

    // Keyboard, on the first row: Escape closes only the list, not the dialog.
    const first = selects.first();
    await first.focus();
    await page.keyboard.press('ArrowDown');
    await expect(list).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(list).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(first).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await expect(first).toContainText('Full access');

    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    const saved = stack.readJson(stack.files.users).find((u) => u.username === 'pick@upande.com').instances;
    expect(Object.values(saved)).toEqual(['*', '*']);
  });
});
