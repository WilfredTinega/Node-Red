import { ADMIN, addUserViaApi, choose, expect, loginAs, openSelect, test } from './fixtures.js';
import { GOOD_TOKEN } from './support/mocks.js';

const addCard = (page) => page.locator('section.card', { has: page.getByRole('heading', { name: 'Add user' }) });
const userRow = (page, username) => page.locator('.users-table tbody tr').filter({ has: page.locator('td:first-child', { hasText: username }) });
const onDisk = (stack, username) => stack.readJson(stack.files.users).find((u) => u.username === username);

async function canLogIn(stack, username, password) {
  const res = await fetch(`${stack.url}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: JSON.stringify({ username, password }),
  });
  return res.ok;
}

test.describe('users', () => {
  test('add a user with a typed password', async ({ page, stack }) => {
    await loginAs(page, 'users');
    await expect(page.locator('.page-header p')).toHaveText('1 user');
    const card = addCard(page);
    await card.getByLabel('Username').fill('typed@upande.com');
    await expect(card.getByRole('button', { name: 'Access: Read only' })).toBeVisible();
    await card.getByRole('radio', { name: 'Type a password' }).check();
    await card.getByPlaceholder('At least 10 characters').fill('typed-password-1');
    await card.getByRole('button', { name: 'Add user' }).click();

    const row = userRow(page, 'typed@upande.com');
    await expect(row).toBeVisible();
    await expect(page.locator('.page-header p')).toHaveText('2 users');
    // A typed password is not shown back.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Access for typed@upande.com: Read only' })).toBeVisible();
    await expect(card.getByLabel('Username')).toHaveValue('');
    expect(onDisk(stack, 'typed@upande.com')).toMatchObject({ permissions: 'read' });
    expect(onDisk(stack, 'typed@upande.com').password).toMatch(/^\$2a\$/);
    expect(await canLogIn(stack, 'typed@upande.com', 'typed-password-1')).toBe(true);
  });

  test('a duplicate username is refused with a message', async ({ page, stack }) => {
    await addUserViaApi(stack, { username: 'dup@upande.com', permissions: 'read', password: 'dup-password-1' });
    await loginAs(page, 'users');
    const card = addCard(page);
    await card.getByLabel('Username').fill('DUP@upande.com');
    await card.getByRole('button', { name: 'Add user' }).click();
    await expect(card.locator('.error')).toHaveText('User DUP@upande.com already exists.');
  });

  test('a generated password is shown once, then Show / Copy / Hide in the list', async ({ page, stack }) => {
    await loginAs(page, 'users');
    const card = addCard(page);
    await card.getByLabel('Username').fill('gen@upande.com');
    await expect(card.getByRole('radio', { name: 'Generate a random password' })).toBeChecked();
    await card.getByRole('button', { name: 'Add user' }).click();

    const shown = page.getByRole('dialog', { name: 'New password' });
    await expect(shown).toContainText('gen@upande.com');
    const password = (await shown.locator('.secret code').textContent()).trim();
    expect(password.length).toBeGreaterThanOrEqual(10);
    await shown.getByRole('button', { name: 'Copy' }).click();
    await expect(shown.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(password);
    await shown.getByRole('button', { name: 'Done' }).click();
    await expect(shown).toBeHidden();
    expect(await canLogIn(stack, 'gen@upande.com', password)).toBe(true);

    // Hidden in the list until asked for.
    const row = userRow(page, 'gen@upande.com');
    await expect(row).not.toContainText(password);
    await row.getByRole('button', { name: 'Show password for gen@upande.com' }).click();
    await expect(row.locator('.pw code')).toHaveText(password);
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await row.getByRole('button', { name: 'Copy' }).click();
    await expect(row.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(password);
    await row.getByRole('button', { name: 'Hide' }).click();
    await expect(row.locator('.pw code')).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Show password for gen@upande.com' })).toBeVisible();
  });

  test('change access with the custom select, by mouse and by keyboard', async ({ page, stack }) => {
    await addUserViaApi(stack, { username: 'sel@upande.com', permissions: 'read', password: 'sel-password-1' });
    await loginAs(page, 'users');
    const row = userRow(page, 'sel@upande.com');

    await openSelect(page, row.getByRole('button', { name: 'Access for sel@upande.com: Read only' }));
    const list = page.getByRole('listbox', { name: 'Access for sel@upande.com' });
    await expect(list.getByRole('option', { name: /Read only/ })).toHaveAttribute('aria-selected', 'true');
    await list.getByRole('option', { name: /Full access/ }).click();
    await expect(list).toBeHidden();
    await expect(row.getByRole('button', { name: 'Access for sel@upande.com: Full access' })).toBeVisible();
    await expect.poll(() => onDisk(stack, 'sel@upande.com').permissions).toBe('*');

    // Keyboard: open with Enter, move with the arrows, choose with Enter.
    const button = row.getByRole('button', { name: 'Access for sel@upande.com: Full access' });
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(list).toBeVisible();
    await expect(list).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(list.getByRole('option', { name: /Read only/ })).toHaveClass(/active/);
    await page.keyboard.press('Enter');
    await expect(list).toBeHidden();
    await expect(row.getByRole('button', { name: 'Access for sel@upande.com: Read only' })).toBeFocused();
    await expect.poll(() => onDisk(stack, 'sel@upande.com').permissions).toBe('read');

    // Escape closes without changing anything.
    await page.keyboard.press('ArrowDown');
    await expect(list).toBeVisible();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Escape');
    await expect(list).toBeHidden();
    await expect(row.getByRole('button', { name: 'Access for sel@upande.com: Read only' })).toBeFocused();
    expect(onDisk(stack, 'sel@upande.com').permissions).toBe('read');

    // A click outside closes it too.
    await openSelect(page, row.getByRole('button', { name: 'Access for sel@upande.com: Read only' }));
    await page.getByRole('heading', { level: 1, name: 'Users' }).click();
    await expect(list).toBeHidden();
  });

  test('limit a user to one instance, then back to all', async ({ page, stack }) => {
    await addUserViaApi(stack, { username: 'limited@upande.com', permissions: '*', password: 'limited-pass-1' });
    await loginAs(page, 'users');
    const row = userRow(page, 'limited@upande.com');
    await row.getByRole('button', { name: 'Instances for limited@upande.com: All instances' }).click();

    let dialog = page.getByRole('dialog', { name: 'Instance access for limited@upande.com' });
    await expect(dialog.getByRole('radio', { name: /All instances/ })).toBeChecked();
    await dialog.getByRole('radio', { name: 'Only chosen instances' }).check();
    // Every local instance with a port (the stopped one has none).
    await expect(dialog.locator('.access-row')).toHaveCount(4);
    await expect(dialog.locator('.access-row', { hasText: 'nodered-open' })).toContainText('No login on this instance');
    await expect(dialog.locator('.access-row', { hasText: 'Package NR' })).toContainText('Not using the shared accounts');

    // Nothing chosen yet: refused.
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.locator('.error')).toHaveText('Choose at least one instance, or pick All instances.');

    const mainPort = stack.nr.main.port;
    await choose(page, dialog.getByRole('button', { name: `Access on nodered-main (port ${mainPort}): No access` }), 'Read only');
    await expect(dialog.getByRole('button', { name: `Access on nodered-main (port ${mainPort}): Read only` })).toBeVisible();
    await expect(dialog.locator('.error')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();

    await expect(row.getByRole('button', { name: 'Instances for limited@upande.com: 1 instance' })).toBeVisible();
    expect(onDisk(stack, 'limited@upande.com').instances).toEqual({ [String(mainPort)]: 'read' });
    expect(onDisk(stack, 'limited@upande.com').permissions).toBe('*');
    // The main access no longer applies, so it is not offered.
    await expect(row.getByRole('button', { name: /^Access for limited@upande.com/ })).toHaveCount(0);
    await expect(row.locator('.per-instance')).toHaveText('Per instance');
    await expect(row.locator('.per-instance')).toHaveAttribute('title', 'Access is set per instance; such users cannot manage this dashboard');

    // Reopening shows what was saved.
    await row.getByRole('button', { name: 'Instances for limited@upande.com: 1 instance' }).click();
    dialog = page.getByRole('dialog', { name: 'Instance access for limited@upande.com' });
    await expect(dialog.getByRole('radio', { name: 'Only chosen instances' })).toBeChecked();
    await expect(dialog.locator('.per-instance-note')).toHaveText('Access is set per instance; such users cannot manage this dashboard.');
    await expect(dialog.getByRole('button', { name: `Access on nodered-main (port ${mainPort}): Read only` })).toBeVisible();
    await expect(dialog.getByRole('button', { name: `Access on nodered-open (port ${stack.nr.open.port}): No access` })).toBeVisible();

    // Cancel keeps it; All instances + Save clears it.
    await dialog.getByRole('radio', { name: /All instances/ }).check();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(onDisk(stack, 'limited@upande.com').instances).toEqual({ [String(mainPort)]: 'read' });
    await row.getByRole('button', { name: 'Instances for limited@upande.com: 1 instance' }).click();
    await dialog.getByRole('radio', { name: /All instances/ }).check();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(row.getByRole('button', { name: 'Instances for limited@upande.com: All instances' })).toBeVisible();
    expect(onDisk(stack, 'limited@upande.com').instances).toBeUndefined();
    await expect(row.getByRole('button', { name: 'Access for limited@upande.com: Full access' })).toBeVisible();
  });

  test('changing your own access or instances updates the page at once', async ({ page, stack }) => {
    await addUserViaApi(stack, { username: 'admin2@upande.com', permissions: '*', password: 'admin2-password' });
    await addUserViaApi(stack, { username: 'admin3@upande.com', permissions: '*', password: 'admin3-password' });
    const nav = page.getByRole('navigation', { name: 'Main' });

    // Main access to read only.
    await loginAs(page, 'users', { username: 'admin2@upande.com', password: 'admin2-password' });
    await expect(page.locator('.topbar .tag')).toHaveText('admin');
    await choose(page, userRow(page, 'admin2@upande.com').getByRole('button', { name: 'Access for admin2@upande.com: Full access' }), 'Read only');
    await expect(page.locator('.topbar .tag')).toHaveText('read only');
    await expect(nav.getByRole('link')).toHaveText(['Instances', 'My account']);
    await expect(page.getByRole('heading', { level: 1, name: 'Instances' })).toBeVisible();
    expect(onDisk(stack, 'admin2@upande.com').permissions).toBe('read');

    // Limited to chosen instances: no longer an admin either, whatever the main access says.
    await page.getByRole('button', { name: 'Log out' }).click();
    await loginAs(page, 'users', { username: 'admin3@upande.com', password: 'admin3-password' });
    await userRow(page, 'admin3@upande.com').getByRole('button', { name: 'Instances for admin3@upande.com: All instances' }).click();
    const dialog = page.getByRole('dialog', { name: 'Instance access for admin3@upande.com' });
    await dialog.getByRole('radio', { name: 'Only chosen instances' }).check();
    await choose(page, dialog.getByRole('button', { name: `Access on nodered-main (port ${stack.nr.main.port}): No access` }), 'Full access');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.topbar .tag')).toHaveText('read only');
    await expect(nav.getByRole('link')).toHaveText(['Instances', 'My account']);
    expect(onDisk(stack, 'admin3@upande.com')).toMatchObject({ permissions: '*', instances: { [String(stack.nr.main.port)]: '*' } });
    expect((await page.request.get('/api/users')).status()).toBe(403);
  });

  test('the backup account is a system user: access locked, delete allowed, comes back on its own', async ({ page, stack }) => {
    const api = await stack.client();
    expect((await api('POST', '/api/github/connect', { token: GOOD_TOKEN })).status).toBe(200);
    expect((await api('PUT', '/api/backup', { repo: 'acme/flows-backup' })).status).toBe(200);
    expect((await api('POST', '/api/backup/run')).body.ok).toBe(true);
    expect(onDisk(stack, 'nodered-backup')).toMatchObject({ permissions: 'read', system: true });

    await loginAs(page, 'users');
    const row = userRow(page, 'nodered-backup');
    await expect(row.locator('.tag')).toHaveText('system');
    await expect(row.locator('.tag')).toHaveAttribute('title', 'Used by scheduled backups');
    const access = row.getByRole('button', { name: 'Access for nodered-backup: Read only' });
    await expect(access).toBeDisabled();
    const instances = row.getByRole('button', { name: 'Instances for nodered-backup: All instances' });
    await expect(instances).toBeDisabled();
    await expect(row.locator('.disabled-wrap').nth(0)).toHaveAttribute('title', 'Used by scheduled backups');
    await expect(row.locator('.disabled-wrap').nth(1)).toHaveAttribute('title', 'Used by scheduled backups');
    // Nobody needs to know its password.
    await expect(row.locator('td').nth(3)).toHaveText('Not stored');
    const del = row.getByRole('button', { name: 'Delete nodered-backup' });
    await expect(del).toBeEnabled();
    await expect(row.locator('.disabled-wrap').last()).toHaveAttribute('title', 'It is recreated at the next backup');

    // The server refuses access changes too.
    const headers = { 'X-Requested-With': 'fetch' };
    let res = await page.request.put('/api/users/nodered-backup', { headers, data: { permissions: '*' } });
    expect(res.status()).toBe(400);
    res = await page.request.put('/api/users/nodered-backup', { headers, data: { instances: { [String(stack.nr.main.port)]: 'read' } } });
    expect(res.status()).toBe(400);
    expect(onDisk(stack, 'nodered-backup')).toMatchObject({ permissions: 'read' });

    await del.click();
    await page.getByRole('dialog', { name: 'Delete user' }).getByRole('button', { name: 'Delete user' }).click();
    await expect(row).toHaveCount(0);
    expect(onDisk(stack, 'nodered-backup')).toBeUndefined();

    // The next backup recreates it.
    expect((await api('POST', '/api/backup/run')).body.ok).toBe(true);
    expect(onDisk(stack, 'nodered-backup')).toMatchObject({ permissions: 'read', system: true });
  });

  test('viewable passwords: on shows them, off deletes the copies and keeps hashes only', async ({ page, stack }) => {
    const { password } = await addUserViaApi(stack, { username: 'gen@upande.com', permissions: 'read', generate: true });
    expect(onDisk(stack, 'gen@upande.com').secret).toMatch(/^v1:/);
    await loginAs(page, 'users');
    const toggle = page.getByRole('switch', { name: 'Store passwords viewable' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(toggle).toHaveText('On');
    await expect(page.locator('.viewable-setting')).toContainText('Off: only the password hash is stored (default). On: an encrypted copy is kept so admins can click Show.');
    const row = userRow(page, 'gen@upande.com');
    await row.getByRole('button', { name: 'Show password for gen@upande.com' }).click();
    await expect(row.locator('.pw code')).toHaveText(password);

    // Turning it off asks first.
    await toggle.click();
    const dialog = page.getByRole('dialog', { name: 'Turn off viewable passwords?' });
    await expect(dialog).toContainText('Every stored password copy is deleted now.');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(onDisk(stack, 'gen@upande.com').secret).toMatch(/^v1:/);

    await toggle.click();
    await page.getByRole('dialog', { name: 'Turn off viewable passwords?' }).getByRole('button', { name: 'Turn off' }).click();
    await expect(dialog).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(toggle).toHaveText('Off');
    // Only hashes now, for every account.
    for (const name of ['gen@upande.com', ADMIN.username]) await expect(userRow(page, name).locator('td').nth(3)).toHaveText('Hashed');
    await expect(page.getByRole('button', { name: /^Show password/ })).toHaveCount(0);
    for (const u of stack.readJson(stack.files.users)) expect(u.secret).toBeUndefined();
    expect(stack.readJson(stack.files.settings)).toMatchObject({ viewablePasswords: false });
    const res = await page.request.get('/api/users/gen@upande.com/password');
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toContain('turned off');

    // Still off after a reload; a generated password is still shown once.
    await page.reload();
    await expect(page.getByRole('switch', { name: 'Store passwords viewable' })).toHaveAttribute('aria-checked', 'false');
    await userRow(page, 'gen@upande.com').getByRole('button', { name: 'Reset password' }).click();
    await page.getByRole('dialog', { name: 'Reset password for gen@upande.com' }).getByRole('button', { name: 'Reset password' }).click();
    const shown = page.getByRole('dialog', { name: 'New password' });
    const reset = (await shown.locator('.secret code').textContent()).trim();
    expect(reset.length).toBeGreaterThanOrEqual(10);
    await shown.getByRole('button', { name: 'Done' }).click();
    await expect(userRow(page, 'gen@upande.com').locator('td').nth(3)).toHaveText('Hashed');
    expect(onDisk(stack, 'gen@upande.com').secret).toBeUndefined();
    expect(await canLogIn(stack, 'gen@upande.com', reset)).toBe(true);

    // Back on: no confirmation, old passwords have no copy, new ones do.
    await page.getByRole('switch', { name: 'Store passwords viewable' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('switch', { name: 'Store passwords viewable' })).toHaveAttribute('aria-checked', 'true');
    await expect(userRow(page, 'gen@upande.com').locator('td').nth(3)).toHaveText('Not stored');
    const card = addCard(page);
    await card.getByLabel('Username').fill('new@upande.com');
    await card.getByRole('button', { name: 'Add user' }).click();
    const newPassword = (await page.getByRole('dialog', { name: 'New password' }).locator('.secret code').textContent()).trim();
    await page.getByRole('dialog', { name: 'New password' }).getByRole('button', { name: 'Done' }).click();
    const newRow = userRow(page, 'new@upande.com');
    await newRow.getByRole('button', { name: 'Show password for new@upande.com' }).click();
    await expect(newRow.locator('.pw code')).toHaveText(newPassword);
  });

  test('add a user limited to chosen instances from the start', async ({ page, stack }) => {
    await loginAs(page, 'users');
    const card = addCard(page);
    await card.getByLabel('Username').fill('scoped@upande.com');
    await card.getByRole('radio', { name: 'Only chosen instances' }).check();
    const pkgPort = stack.nr.pkg.port;
    await choose(page, card.getByRole('button', { name: `Access on Package NR (port ${pkgPort}): No access` }), 'Full access');
    await card.getByRole('button', { name: 'Add user' }).click();
    await page.getByRole('dialog', { name: 'New password' }).getByRole('button', { name: 'Done' }).click();
    await expect(userRow(page, 'scoped@upande.com').getByRole('button', { name: /1 instance$/ })).toBeVisible();
    expect(onDisk(stack, 'scoped@upande.com')).toMatchObject({ permissions: 'read', instances: { [String(pkgPort)]: '*' } });
  });

  test('reset a password, typed or generated', async ({ page, stack }) => {
    await addUserViaApi(stack, { username: 'reset@upande.com', permissions: 'read', password: 'first-password' });
    await loginAs(page, 'users');
    const row = userRow(page, 'reset@upande.com');

    await row.getByRole('button', { name: 'Reset password' }).click();
    let dialog = page.getByRole('dialog', { name: 'Reset password for reset@upande.com' });
    await dialog.getByRole('radio', { name: 'Type a password' }).check();
    await dialog.getByPlaceholder('At least 10 characters').fill('second-password');
    await dialog.getByRole('button', { name: 'Reset password' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await canLogIn(stack, 'reset@upande.com', 'second-password')).toBe(true);
    expect(await canLogIn(stack, 'reset@upande.com', 'first-password')).toBe(false);

    await row.getByRole('button', { name: 'Reset password' }).click();
    dialog = page.getByRole('dialog', { name: 'Reset password for reset@upande.com' });
    await dialog.getByRole('button', { name: 'Reset password' }).click();
    const shown = page.getByRole('dialog', { name: 'New password' });
    const password = (await shown.locator('.secret code').textContent()).trim();
    await shown.getByRole('button', { name: 'Done' }).click();
    expect(await canLogIn(stack, 'reset@upande.com', password)).toBe(true);
  });

  test('delete asks first', async ({ page, stack }) => {
    await addUserViaApi(stack, { username: 'bye@upande.com', permissions: 'read', password: 'bye-password-1' });
    await loginAs(page, 'users');
    const row = userRow(page, 'bye@upande.com');

    await row.getByRole('button', { name: 'Delete bye@upande.com' }).click();
    let dialog = page.getByRole('dialog', { name: 'Delete user' });
    await expect(dialog).toContainText('Delete bye@upande.com?');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect(onDisk(stack, 'bye@upande.com')).toBeTruthy();

    await row.getByRole('button', { name: 'Delete bye@upande.com' }).click();
    dialog = page.getByRole('dialog', { name: 'Delete user' });
    await dialog.getByRole('button', { name: 'Delete user' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.users-table')).not.toContainText('bye@upande.com');
    expect(onDisk(stack, 'bye@upande.com')).toBeUndefined();
  });

  test('the administrator row cannot be changed, and the server agrees', async ({ page, stack }) => {
    await addUserViaApi(stack, { username: 'admin2@upande.com', permissions: '*', password: 'admin2-password' });
    // Checked while logged in as another admin, so "you cannot delete yourself" is not the reason.
    await loginAs(page, 'users', { username: 'admin2@upande.com', password: 'admin2-password' });
    const row = userRow(page, ADMIN.username);
    await expect(row.locator('.locked')).toHaveText('Full access');
    await expect(row.getByRole('button', { name: /^Access for administrator/ })).toHaveCount(0);
    const instances = row.getByRole('button', { name: 'Instances for administrator: all instances, locked' });
    await expect(instances).toBeDisabled();
    const del = row.getByRole('button', { name: 'Delete administrator' });
    await expect(del).toBeDisabled();
    await expect(row.locator('.disabled-wrap').last()).toHaveAttribute('title', 'administrator cannot be deleted.');
    // Greyed out.
    expect(Number(await del.evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(0.6);
    expect(Number(await instances.evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(0.6);
    // Reset password stays available.
    await expect(row.getByRole('button', { name: 'Reset password' })).toBeEnabled();

    const headers = { 'X-Requested-With': 'fetch' };
    let res = await page.request.put('/api/users/administrator', { headers, data: { permissions: 'read' } });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe('administrator always has full access.');
    res = await page.request.put('/api/users/administrator', { headers, data: { instances: { '1880': 'read' } } });
    expect(res.status()).toBe(400);
    res = await page.request.delete('/api/users/administrator', { headers });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe('administrator cannot be deleted.');
    expect(onDisk(stack, ADMIN.username)).toMatchObject({ permissions: '*' });
    expect(onDisk(stack, ADMIN.username).instances).toBeUndefined();
  });

  test('your own row: tagged "you" and Delete is disabled', async ({ page }) => {
    await loginAs(page, 'users');
    const row = userRow(page, ADMIN.username);
    await expect(row.locator('.tag')).toHaveText('you');
    await expect(row.getByRole('button', { name: 'Delete administrator' })).toBeDisabled();
  });
});
