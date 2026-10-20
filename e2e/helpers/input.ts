import { test as base, expect, type Locator, type Page } from '@playwright/test';

/**
 * Input helpers for keyboard <-> mouse focus tests.
 *
 * Rules (see plan/keyboard-focus-tests.md):
 *  - drive the UI with trusted input only: page.keyboard.*, page.mouse.*, locator.press/click.
 *    Never dispatchEvent(new KeyboardEvent(...)).
 *  - `.focus()` is allowed only to ARRANGE a starting point, never as the action under test.
 *  - assert real state (document.activeElement, :focus-visible), not just CSS classes.
 */

export type LastInput = 'keyboard' | 'pointer' | null;

// Records the most recent trusted input type so a failing assertion can say
// which modality was active.
const PROBE = () => {
  const w = window as unknown as { __lastInput: LastInput };
  w.__lastInput = null;
  addEventListener('keydown', (e) => { if (e.isTrusted) w.__lastInput = 'keyboard'; }, true);
  addEventListener('pointerdown', (e) => { if (e.isTrusted) w.__lastInput = 'pointer'; }, true);
};

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(PROBE);
    await use(page);
  },
});
export { expect };

/** The project every spec runs against (registered by support/fixture-server.mjs). */
export const PROJECT = 'e2e';

/** App URL for a workbench hash route: '/#/findings' opens `/p/e2e#/findings`; '/' is the project's landing route. */
export const appUrl = (hash: string) => `/p/${PROJECT}${hash.replace(/^\//, '')}`;

/** The project's REST path for a workbench endpoint: '/api/findings' is `/api/projects/e2e/findings`. */
export const api = (path: string) => `/api/projects/${PROJECT}${path.replace(/^\/api/, '')}`;

/** Park the mouse in a corner so a stale :hover can't leak into assertions. */
export async function parkMouse(page: Page) {
  await page.mouse.move(0, 1);
}

/** Navigate to a hash route and wait for a nav area to exist. */
export async function openView(page: Page, hash: string, areaSelector: string) {
  await page.goto(appUrl(hash));
  await page.waitForSelector(areaSelector, { timeout: 10_000 });
  await parkMouse(page);
}

export async function lastInput(page: Page): Promise<LastInput> {
  return page.evaluate(() => (window as unknown as { __lastInput: LastInput }).__lastInput);
}

/** data-nav-area of the element that is, or contains, document.activeElement. */
export async function activeArea(page: Page): Promise<string | null> {
  return page.evaluate(
    () => document.activeElement?.closest('[data-nav-area]')?.getAttribute('data-nav-area') ?? null,
  );
}

/** ids (data-nav-id) of items currently carrying the nav-focused treatment. */
export async function navFocusedIds(page: Page): Promise<string[]> {
  return page.locator('[data-nav-focused="true"]').evaluateAll(
    els => els.map(e => e.getAttribute('data-nav-id') ?? e.getAttribute('data-finding-id') ?? e.id ?? ''),
  );
}

/** Real browser answer to "would a focus ring be drawn here right now?" */
export async function matchesFocusVisible(locator: Locator): Promise<boolean> {
  return locator.evaluate(el => el.matches(':focus-visible'));
}

export async function outlineStyle(locator: Locator): Promise<string> {
  return locator.evaluate(el => getComputedStyle(el).outlineStyle);
}

/** Index of the nav-focused element among `itemSelector` matches, or -1. */
export async function focusedIndex(page: Page, itemSelector: string): Promise<number> {
  return page.locator(itemSelector).evaluateAll(
    els => els.findIndex(e => e.getAttribute('data-nav-focused') === 'true'),
  );
}

/** Wait one animation frame (scrollIntoView / state flushes land in rAF). */
export async function nextFrame(page: Page) {
  await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

/** Phone layout (<= 639px): the file tree and the activity sidebar are off-canvas drawers there. */
export const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 640;

/** A focusable pane that exists at every size: the file tree on wide screens, the code on a phone. */
export const primaryPane = (page: Page) =>
  page.locator(isPhone(page) ? '[data-nav-area="codeview"]' : '[data-nav-area="filetree"]');

/** Open /#/browse with a file showing, without clicking the tree (it is a closed drawer on a phone). */
export async function openBrowseFile(page: Page, file = 'CLAUDE.md') {
  await page.goto(appUrl(`/#/browse/${file}`));
  await page.waitForSelector('[data-line-id]', { timeout: 10_000 });
  await page.waitForTimeout(400);
}
