import { test, expect, openView } from './helpers/input';

// The unconfigured-profile banner needs a project whose profile was never written, so this runs
// on the fresh server (the seeded project's write gate is open, which writes the profile).
// It was part of responsive.spec.ts's per-size checks.
const SIZES = {
  mobile: { width: 390, height: 844 },
  desktop: { width: 1440, height: 900 },
  ultrawide: { width: 3440, height: 1440 },
};

for (const [size, viewport] of Object.entries(SIZES)) {
  test(`${size}: profile banner stays compact and its buttons are usable`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openView(page, '/#/findings', '[data-nav-area="findings-list"]');
    await page.waitForTimeout(400);
    const b = await page.evaluate(() => {
      const el = document.querySelector('.profile-banner') as HTMLElement;
      const btns = Array.from(el.querySelectorAll('button')).map((x) => { const r = x.getBoundingClientRect(); return { w: r.width, h: r.height, inView: r.right <= innerWidth + 1 && r.left >= -1 }; });
      return { height: el.getBoundingClientRect().height, btns };
    });
    expect(b.height).toBeLessThanOrEqual(size === 'mobile' ? 72 : 64);
    for (const x of b.btns) {
      expect(x.inView).toBe(true);
      expect(Math.min(x.w, x.h)).toBeGreaterThanOrEqual(size === 'mobile' ? 32 : 20);
    }
  });
}
