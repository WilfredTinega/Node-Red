// Every test gets its own dashboard (see support/stack.js), so tests never
// share users, sessions or GitHub settings and can run in any order.
import fs from 'node:fs';
import { test as base, expect } from '@playwright/test';
import { ADMIN, APP_PORT_BASE, startStack } from './support/stack.js';

export { expect, ADMIN };

export const test = base.extend({
  stack: async ({}, use, testInfo) => {
    if (testInfo.parallelIndex >= 20) throw new Error('At most 20 workers: the app ports are 18980-18999.');
    const stack = await startStack({ port: APP_PORT_BASE + testInfo.parallelIndex, name: testInfo.title });
    try {
      await use(stack);
    } finally {
      await stack.stop();
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('server.log', { body: stack.log(), contentType: 'text/plain' });
      } else {
        // Keep a failed test's data files for a look; drop the rest.
        fs.rmSync(stack.dir, { recursive: true, force: true });
      }
    }
  },

  baseURL: async ({ stack }, use) => use(stack.url),

  // Only the app and the local mocks may be reached. Anything else is a bug in
  // the page (or a test), so it fails loudly instead of touching the network.
  context: async ({ context }, use) => {
    const blocked = [];
    await context.route(
      (url) => url.hostname !== '127.0.0.1',
      (route) => {
        blocked.push(route.request().url());
        return route.abort('blockedbyclient');
      },
    );
    await use(context);
    expect(blocked, 'requests outside 127.0.0.1').toEqual([]);
  },
});

// Logs in through the API (sharing cookies with the page) and opens a page.
export async function loginAs(page, hash = 'instances', { username = ADMIN.username, password = ADMIN.password } = {}) {
  const res = await page.request.post('/api/login', { headers: { 'X-Requested-With': 'fetch' }, data: { username, password } });
  expect(res.ok(), `login as ${username}`).toBeTruthy();
  const onApp = page.url() !== 'about:blank';
  await page.goto(`/#/${hash}`);
  // A hash-only change does not reload an open page, so it would keep showing the login form.
  if (onApp) await page.reload();
  await expect(page.locator('.topbar')).toBeVisible();
}

// Logs in through the form.
export async function loginWithForm(page, username, password) {
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
}

export const isPhone = (testInfo) => testInfo.project.name === 'phone';

// Opens the sidebar on a phone (it is always shown on desktop).
export async function openNav(page, testInfo) {
  if (isPhone(testInfo)) {
    await page.getByRole('button', { name: 'Menu' }).click();
    await expect(page.locator('.sidebar')).toBeInViewport({ ratio: 1 });
  }
}

export async function goTo(page, testInfo, label) {
  await openNav(page, testInfo);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: label }).click();
}

// The page itself never scrolls sideways (tables scroll inside their own box).
export async function expectNoHorizontalScroll(page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.scrollingElement.scrollWidth,
    clientWidth: document.scrollingElement.clientWidth,
  }));
  expect(scrollWidth, `page is ${scrollWidth}px wide in a ${clientWidth}px viewport`).toBeLessThanOrEqual(clientWidth);
}

// The element actually on top at the centre of `locator`.
export async function topElementAt(locator) {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      self: el === top || el.contains(top),
      inBackdrop: Boolean(top?.closest('.backdrop')),
      inDialog: Boolean(top?.closest('.dialog')),
      inListbox: Boolean(top?.closest('[role="listbox"]')),
    };
  });
}

// Adds a user through the API as the administrator.
export async function addUserViaApi(stack, user) {
  const api = await stack.client();
  const res = await api('POST', '/api/users', user);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

// Opens a custom Select. The list closes on any scroll (it is fixed-position),
// so first let the scroll that brings the button into view finish; otherwise
// Playwright's own scroll-before-click would close the list as it opens.
export async function openSelect(page, button) {
  await button.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await button.click();
  await expect(page.getByRole('listbox')).toBeVisible();
  return page.getByRole('listbox');
}

// Chooses an option in a custom Select.
export async function choose(page, button, option) {
  const list = await openSelect(page, button);
  await list.getByRole('option', { name: option }).click();
  await expect(list).toBeHidden();
}
