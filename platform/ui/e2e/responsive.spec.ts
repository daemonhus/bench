import { test, expect } from './helpers/input';

// The platform shell at the three canvas sizes: no sideways scroll, no clipped controls, and the
// rail/navigation stays reachable. (The embedded workbench has its own suite in the repo-root e2e/.)
const SIZES = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'ultrawide', width: 3440, height: 1440 },
];

for (const s of SIZES) {
  test.describe(`${s.name} (${s.width}x${s.height})`, () => {
    test.use({ viewport: { width: s.width, height: s.height } });

    test('projects page: no sideways scroll, controls inside the viewport', async ({ page }) => {
      await page.goto('/projects');
      await page.waitForSelector('.project-card');
      const m = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
        clipped: [...document.querySelectorAll('button, a[href], [role="button"]')]
          .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1); })
          .map(e => (e.getAttribute('title') || e.textContent || e.className).trim().slice(0, 40)),
      }));
      expect(m.sw).toBeLessThanOrEqual(m.cw);
      expect(m.clipped).toEqual([]);
    });

    test('the open workbench has no sideways scroll either', async ({ page }) => {
      await page.goto('/projects');
      await page.locator('.project-card', { hasText: 'alpha' }).locator('.project-card-open').click();
      await page.waitForSelector('.tab-bar');
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      expect(m.sw).toBeLessThanOrEqual(m.cw);
    });
  });
}
