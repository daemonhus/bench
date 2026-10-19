import { test, expect } from './helpers/input';
import type { Page } from '@playwright/test';

// One theme setting, two owners (the platform shell and the embedded workbench, whose own toggle is
// hidden inside the platform). Whatever the user does with the shell toggle, from any page, the
// visible theme must flip exactly once per click, stay put across navigation, and the workbench's
// (hidden) state must agree.

const html = (page: Page) => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
const shellToggle = (page: Page) => page.locator('.platform-rail-btn[title^="Switch to"]');
const benchToggle = (page: Page) => page.locator('.theme-toggle-slider'); // hidden in the platform: read, don't click
const stored = (page: Page) => page.evaluate(() => localStorage.getItem('bench-theme'));
const openAlpha = async (page: Page) => {
  await page.locator('.project-card', { hasText: 'alpha' }).locator('.project-card-open').click();
  await benchToggle(page).waitFor({ state: 'attached' });
};
const toProjects = async (page: Page) => {
  await page.locator('.platform-rail-btn[title="Projects"]').click();
  await page.waitForSelector('.project-card');
};

test.beforeEach(async ({ page }) => {
  await page.goto('/projects');
  await page.evaluate(() => localStorage.removeItem('bench-theme'));
  await page.reload();
  await page.waitForSelector('.project-card');
});

test('toggle in the shell, then open a workbench: the theme sticks and both agree', async ({ page }) => {
  expect(await html(page)).toBe('dark');
  await shellToggle(page).click();
  expect(await html(page)).toBe('light');

  await openAlpha(page);
  await page.waitForTimeout(300); // let the workbench's own effects run
  expect(await html(page)).toBe('light'); // it used to snap back to its stale 'dark'
  await expect(benchToggle(page)).toHaveAttribute('aria-label', 'Switch to dark mode');
  await expect(shellToggle(page)).toHaveAttribute('aria-label', 'Switch to dark mode');
});

test('the shell toggle flips exactly once per click while a workbench is open', async ({ page }) => {
  await openAlpha(page);
  await shellToggle(page).click();
  expect(await html(page)).toBe('light');
  await shellToggle(page).click();
  expect(await html(page)).toBe('dark');
  await shellToggle(page).click();
  expect(await html(page)).toBe('light');
  await expect(benchToggle(page)).toHaveAttribute('aria-label', 'Switch to dark mode');
  expect(await stored(page)).toBe('light');
});

test('toggling in different places, with navigation in between, flips once per click', async ({ page }) => {
  const seq: string[] = [];
  await shellToggle(page).click(); seq.push((await html(page))!);   // light
  await openAlpha(page);
  await shellToggle(page).click(); seq.push((await html(page))!);   // dark
  await toProjects(page);
  await shellToggle(page).click(); seq.push((await html(page))!);   // light
  await openAlpha(page);
  await toProjects(page);
  await shellToggle(page).click(); seq.push((await html(page))!);   // dark
  expect(seq).toEqual(['light', 'dark', 'light', 'dark']);
  expect(await stored(page)).toBe('dark');
});

test('a saved theme is what both the shell and the workbench start with', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('bench-theme', 'light'));
  await page.reload();
  await page.waitForSelector('.project-card');
  expect(await html(page)).toBe('light');
  await openAlpha(page);
  expect(await html(page)).toBe('light');
  await expect(benchToggle(page)).toHaveAttribute('aria-label', 'Switch to dark mode');
});

test('changing the theme in another tab updates this one (shell and workbench)', async ({ page, context }) => {
  await openAlpha(page);
  expect(await html(page)).toBe('dark');
  const other = await context.newPage();
  await other.goto('/projects');
  await other.waitForSelector('.project-card');
  await other.locator('.platform-rail-btn[title^="Switch to"]').click();
  await expect.poll(() => html(page)).toBe('light');
  await expect(shellToggle(page)).toHaveAttribute('aria-label', 'Switch to dark mode');
  await expect(benchToggle(page)).toHaveAttribute('aria-label', 'Switch to dark mode');
});
