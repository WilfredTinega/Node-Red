// Dialogs are modal for the keyboard too: focus moves in when one opens, Tab
// cycles inside it, and closing puts focus back on the control that opened it.
import { addUserViaApi, expect, loginAs, test } from './fixtures.js';

test.describe('dialog focus', () => {
  test('a confirm dialog: Cancel focused, Tab cycles, Escape returns focus to the opener', async ({ page, stack }) => {
    await addUserViaApi(stack, { username: 'focus@upande.com', permissions: 'read', password: 'focus-password' });
    await loginAs(page, 'users');
    const opener = page.locator('.users-table tbody tr', { hasText: 'focus@upande.com' }).getByRole('button', { name: 'Delete focus@upande.com' });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Delete user' });
    const cancel = dialog.getByRole('button', { name: 'Cancel' });
    const confirm = dialog.getByRole('button', { name: 'Delete user' });
    await expect(cancel).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(confirm).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(confirm).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(cancel).toBeFocused();
    // Focus never left the dialog.
    expect(await page.evaluate(() => document.activeElement.closest('[role="dialog"]') !== null)).toBe(true);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    expect(stack.readJson(stack.files.users).some((u) => u.username === 'focus@upande.com')).toBe(true);
  });

  test('a plain dialog: the first control is focused, Shift+Tab wraps to the last, the backdrop closes it', async ({ page, stack }) => {
    await loginAs(page, 'instances');
    const opener = page.locator('.instances-table tbody tr', { hasText: 'nodered-open' }).getByRole('button', { name: 'Connect' });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: /^Connect nodered-open/ });
    await expect(dialog.getByRole('button', { name: 'Docker' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Done' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Docker' })).toBeFocused();
    // Done closes it and focus goes back too.
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();

    // A form dialog: the first field is focused, and the opener gets focus back after a click on the backdrop.
    await page.goto('/#/users');
    const reset = page.locator('.users-table tbody tr', { hasText: 'administrator' }).getByRole('button', { name: 'Reset password' });
    await reset.click();
    const resetDialog = page.getByRole('dialog', { name: 'Reset password for administrator' });
    await expect(resetDialog.getByRole('radio', { name: 'Generate a random password' })).toBeFocused();
    await page.mouse.click(5, 5);
    await expect(resetDialog).toBeHidden();
    await expect(reset).toBeFocused();
    expect(stack.readJson(stack.files.users)).toHaveLength(1);
  });
});
