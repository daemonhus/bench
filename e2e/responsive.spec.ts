import { test, expect, openView, appUrl } from './helpers/input';
import type { Page } from '@playwright/test';

// The same expectations at three canvas sizes. A user on a phone, a laptop and an ultrawide monitor
// should get the same product: nothing clipped or unreachable, chrome that lines up with the page it
// sits above, touch-sized controls on small screens, dialogs that fit.

const SIZES = {
  mobile: { width: 390, height: 844 },
  desktop: { width: 1440, height: 900 },
  ultrawide: { width: 3440, height: 1440 },
} as const;
type Size = keyof typeof SIZES;

const VIEWS: { name: string; hash: string; ready: string; frame: 'column' | 'full' }[] = [
  { name: 'Overview', hash: '/#/overview', ready: '.ovp-project-title', frame: 'column' },
  { name: 'Browse', hash: '/#/browse/CLAUDE.md', ready: '[data-line-id]', frame: 'full' },
  { name: 'Changes', hash: '/#/delta', ready: '[data-nav-area="delta-header"]', frame: 'column' },
  { name: 'Findings', hash: '/#/findings', ready: '[data-nav-area="findings-list"]', frame: 'column' },
  { name: 'Features', hash: '/#/features', ready: '[data-nav-area="features-list"]', frame: 'column' },
  { name: 'Profile', hash: '/#/profile', ready: '.profile-title', frame: 'column' },
];

async function go(page: Page, size: Size, hash: string, ready: string) {
  await page.setViewportSize(SIZES[size]);
  await openView(page, hash, ready);
  await page.waitForTimeout(400);
}

/** Visible interactive controls that an ancestor clips (overflow hidden) without any way to scroll to them. */
const clippedControls = (page: Page) => page.evaluate(() => {
  const out: string[] = [];
  for (const e of Array.from(document.querySelectorAll<HTMLElement>('button, a[href], select, input:not([type=hidden]), textarea, [role=button]'))) {
    const r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || e.closest('[inert], [aria-hidden="true"]')) continue;
    // a fixed-position control (or one inside a fixed wrapper) is laid out against the viewport, not clipped by ancestors
    let fixed = false;
    for (let q: HTMLElement | null = e; q && q !== document.body; q = q.parentElement) if (getComputedStyle(q).position === 'fixed') { fixed = true; break; }
    if (fixed) continue;
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      const clipsX = cs.overflowX !== 'visible';
      if (!clipsX) continue;
      const pr = p.getBoundingClientRect();
      const outside = r.right > pr.right + 1 || r.left < pr.left - 1;
      const canScroll = (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && p.scrollWidth > p.clientWidth;
      if (outside && !canScroll) { out.push(`${e.className.toString().split(' ')[0] || e.tagName}  (clipped by .${p.className.toString().split(' ')[0]})`); break; }
      if (outside && canScroll) break; // reachable by scrolling that container
    }
  }
  return Array.from(new Set(out));
});

for (const size of Object.keys(SIZES) as Size[]) {
  test.describe(`${size} (${SIZES[size].width}x${SIZES[size].height})`, () => {
    for (const v of VIEWS) {
      test(`${v.name}: no horizontal page overflow, no clipped controls`, async ({ page }) => {
        await go(page, size, v.hash, v.ready);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        expect(overflow).toBeLessThanOrEqual(0);
        expect(await clippedControls(page)).toEqual([]);
        // A page view must not scroll sideways inside its own container either (a scrollable
        // container hides overflow from the document check and the clipped-control check).
        // (Browse is exempt: long code lines scroll inside the code pane by design.)
        const sideways = await page.evaluate((name) =>
          name === 'Browse' ? [] : Array.from(document.querySelectorAll<HTMLElement>('.main-panel, [class$="-view"], .overview-section'))
            .filter((e) => e.getClientRects().length && e.scrollWidth > e.clientWidth + 1)
            .map((e) => `${e.className.toString().split(' ')[0]} (${e.scrollWidth} > ${e.clientWidth})`), v.name);
        expect(sideways).toEqual([]);
      });
    }

    test('chrome: every tab, quick-add and the theme toggle are reachable; the active tab is in view', async ({ page }) => {
      await go(page, size, '/#/findings', '[data-nav-area="findings-list"]');
      const state = await page.evaluate(() => {
        const vw = innerWidth;
        const controls = Array.from(document.querySelectorAll<HTMLElement>('.tab-bar button'));
        const bad: string[] = [];
        for (const b of controls) {
          const r = b.getBoundingClientRect();
          const inView = r.left >= -1 && r.right <= vw + 1;
          let scroller: HTMLElement | null = null;
          for (let p = b.parentElement; p && !p.matches('.tab-bar'); p = p.parentElement) {
            const o = getComputedStyle(p).overflowX;
            if ((o === 'auto' || o === 'scroll') && p.scrollWidth > p.clientWidth) { scroller = p; break; }
          }
          if (!inView && !scroller) bad.push((b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 20));
        }
        const active = document.querySelector('.tab-bar-tab-active')!.getBoundingClientRect();
        const theme = document.querySelector('.theme-toggle-slider')!.getBoundingClientRect();
        const quick = Array.from(document.querySelectorAll('.quick-add-btn')).map((e) => e.getBoundingClientRect());
        return {
          unreachable: bad,
          activeVisible: active.left >= -1 && active.right <= vw + 1,
          themeVisible: theme.left >= -1 && theme.right <= vw + 1,
          quickVisible: quick.every((r) => r.left >= -1 && r.right <= vw + 1),
        };
      });
      expect(state.unreachable).toEqual([]);
      expect(state.activeVisible).toBe(true);
      expect(state.themeVisible).toBe(true);
      expect(state.quickVisible).toBe(true);
    });

    test('chrome: switching tabs keeps the new active tab in view', async ({ page }) => {
      await go(page, size, '/#/findings', '[data-nav-area="findings-list"]');
      for (const label of ['Profile', 'Browse', 'Features']) {
        await page.locator('.tab-bar-tab', { hasText: label }).first().click();
        await page.waitForTimeout(250);
        const visible = await page.evaluate(() => {
          const r = document.querySelector('.tab-bar-tab-active')!.getBoundingClientRect();
          return r.left >= -1 && r.right <= innerWidth + 1;
        });
        expect(visible).toBe(true);
      }
    });

    test('header and banner share one frame, and it matches the view', async ({ page }) => {
      for (const v of VIEWS) {
        await go(page, size, v.hash, v.ready);
        // The frame IS the chrome's inline padding (full-width bars inset to the page's content edges).
        // It is measured against the workbench's own width: the platform rail takes the rest of the viewport.
        const m = await page.evaluate(() => {
          const pad = (el: Element | null) => {
            if (!el) return null;
            const cs = getComputedStyle(el);
            return { left: parseFloat(cs.paddingLeft), right: parseFloat(cs.paddingRight), width: el.getBoundingClientRect().width };
          };
          return { bar: pad(document.querySelector('.tab-bar')), banner: pad(document.querySelector('.profile-banner')), vw: document.querySelector('.app-shell')!.getBoundingClientRect().width, frame: document.querySelector('.app-shell')?.getAttribute('data-frame') };
        });
        expect(m.frame, `${v.name} frame attribute`).toBe(v.frame);
        // the tab bar and banner share one frame at every size (Profile shows no banner)
        if (m.banner) {
          expect(Math.abs(m.bar!.left - m.banner.left), `${v.name} left`).toBeLessThanOrEqual(1);
          expect(Math.abs(m.bar!.right - m.banner.right), `${v.name} right`).toBeLessThanOrEqual(1);
        }
        const content = m.vw - m.bar!.left - m.bar!.right;
        if (v.frame === 'full') {
          // a full-bleed view: chrome spans the viewport, inset by the gutter (not capped to a centred column)
          expect(m.bar!.left, `${v.name} bar inset`).toBeLessThanOrEqual(size === 'mobile' ? 8 : 24);
          expect(content, `${v.name} spans the viewport`).toBeGreaterThanOrEqual(m.vw - 2 * 24 - 1);
        } else if (size === 'ultrawide') {
          // a document page: a centred column no wider than --page-max (content = column minus its gutters)
          expect(content, `${v.name} column`).toBeLessThanOrEqual(2000 - 2 * 24 + 1);
          expect(m.bar!.left, `${v.name} centred`).toBeGreaterThan(24);
          expect(Math.abs(m.bar!.left - m.bar!.right), `${v.name} symmetric`).toBeLessThanOrEqual(1);
        }
      }
    });

    test('Changes: the changed-files panel is docked at the screen edge on wide screens and never steals width on mobile', async ({ page }) => {
      await go(page, size, '/#/delta', '[data-nav-area="delta-header"]');
      const g = await page.evaluate(() => {
        const panel = document.querySelector('.delta-sidebar-wrapper')?.getBoundingClientRect() ?? null;
        const header = document.querySelector('.delta-header')?.getBoundingClientRect() ?? null;
        const barLeft = document.querySelector('.tab-bar-tabs')!.getBoundingClientRect().left;
        const rail = document.querySelector('.platform-rail')?.getBoundingClientRect();
        return { panel, header, barLeft, vw: innerWidth, railWidth: rail && rail.width < 200 ? rail.width : 0 };
      });
      if (size === 'mobile') {
        // the page content owns the full width; the panel is a drawer, not a column
        // (the platform's page gutter is 24px a side)
        expect(g.header!.width).toBeGreaterThanOrEqual(g.vw - 48);
      } else {
        expect(g.panel!.right).toBeGreaterThanOrEqual(g.vw - 1);
        // header card lines up with the tab bar's left edge (same column)
        // The header centres its column on the viewport, the tab bar on the workbench beside the
        // platform's side rail, so they differ by half the rail's width.
        expect(Math.abs(g.header!.left - g.barLeft)).toBeLessThanOrEqual(2 + g.railWidth / 2);
      }
    });

    if (size === 'mobile') {
      test('touch targets: controls are at least 24px in both directions (WCAG 2.5.8)', async ({ page }) => {
        const offenders: Record<string, number> = {};
        for (const v of VIEWS.filter((x) => x.name !== 'Browse')) {
          await go(page, size, v.hash, v.ready);
          const small = await page.evaluate(() => {
            const out: string[] = [];
            for (const e of Array.from(document.querySelectorAll<HTMLElement>('button, a[href], select, input:not([type=hidden]), [role=button]'))) {
              const r = e.getBoundingClientRect();
              if (r.width < 1 || r.height < 1 || e.closest('[inert], [aria-hidden="true"]')) continue;
              // links inside running text are exempt
              if (e.tagName === 'A' && e.closest('p, li, .profile-hint')) continue;
              if (r.width < 24 || r.height < 24) out.push(e.className.toString().split(' ')[0] || e.tagName.toLowerCase());
            }
            return out;
          });
          for (const s of small) offenders[`${v.name}:${s}`] = (offenders[`${v.name}:${s}`] ?? 0) + 1;
        }
        expect(offenders).toEqual({});
      });

      test('tab bar and quick-add controls are comfortably tappable (>= 32px)', async ({ page }) => {
        await go(page, size, '/#/findings', '[data-nav-area="findings-list"]');
        const small = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.tab-bar button')).filter((b) => b.getClientRects().length > 0 && (b.getBoundingClientRect().height < 32 || b.getBoundingClientRect().width < 32)).map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 18)));
        expect(small).toEqual([]);
      });
    }

    test('dialogs fit the screen and are centred (keyboard shortcuts, set baseline)', async ({ page }) => {
      await go(page, size, '/#/delta', '[data-nav-area="delta-header"]');
      const openers = [
        async () => { await page.locator('.delta-edit-pencil[data-tooltip="Set new baseline"]').click(); },
      ];
      // The shortcuts button is a keyboard aid and is hidden on phones.
      if (size !== 'mobile') openers.unshift(async () => { await page.locator('.shortcuts-fab').click(); });
      for (const open of openers) {
        await open();
        const dlg = page.getByRole('dialog');
        await expect(dlg).toBeVisible();
        const r = await dlg.evaluate((el) => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, vw: innerWidth, vh: innerHeight, body: (el.querySelector('[class*="body"]') as HTMLElement | null)?.scrollHeight ?? 0 }; });
        expect(r.l).toBeGreaterThanOrEqual(0);
        expect(r.r).toBeLessThanOrEqual(r.vw + 1);
        expect(r.t).toBeGreaterThanOrEqual(0);
        expect(r.b).toBeLessThanOrEqual(r.vh + 1);
        expect(Math.abs((r.l + r.r) / 2 - r.vw / 2)).toBeLessThanOrEqual(2); // centred
        expect(r.w).toBeLessThanOrEqual(Math.max(720, r.vw * 0.95)); // no absurd stretching on ultrawide
        await page.keyboard.press('Escape');
        await expect(dlg).toBeHidden();
      }
    });
  });
}

// ── Ultrawide: the page column is centred, and the wheel over the empty margins still scrolls it ─
test.describe('ultrawide: the margins scroll the page', () => {
  for (const v of VIEWS.filter((x) => ['Overview', 'Changes', 'Findings', 'Features', 'Profile'].includes(x.name))) {
    test(`${v.name}: the wheel over the left margin scrolls the page`, async ({ page }) => {
      await go(page, 'ultrawide', v.hash, v.ready);
      // The content column starts well inside the panel: the strip left of it is empty margin.
      const probe = await page.evaluate(() => {
        const panel = document.querySelector('.main-panel')!.getBoundingClientRect();
        return { x: panel.left + 40, y: panel.top + panel.height / 2 };
      });
      const scroller = () => page.evaluate(({ x, y }) => {
        for (let e = document.elementFromPoint(x, y) as HTMLElement | null; e; e = e.parentElement) {
          const s = getComputedStyle(e).overflowY;
          if ((s === 'auto' || s === 'scroll') && e.scrollHeight > e.clientHeight) return e.scrollTop;
        }
        return null;
      }, probe);
      // A page that fits the screen has nothing to scroll.
      // (Only page-sized scrollers: a panel's own list, like the Overview's commit log, doesn't count.)
      const overflows = await page.evaluate(() => {
        const w = document.querySelector('.main-panel')!.clientWidth;
        return [...document.querySelectorAll<HTMLElement>('.main-panel *')]
          .some((e) => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 4 && e.clientWidth > w / 2);
      });
      test.skip(!overflows, 'the page fits the screen');
      expect(await scroller(), 'the scroller reaches under the margin').not.toBeNull();
      await page.mouse.move(probe.x, probe.y);
      await page.mouse.wheel(0, 400);
      await expect.poll(scroller).toBeGreaterThan(0);
    });
  }
});

// ── Phone: Browse's file panel and activity sidebar are off-canvas drawers ─────────────────────
test.describe('phone: Browse drawers', () => {
  const open = async (page: Page) => {
    await page.setViewportSize(SIZES.mobile);
    await openView(page, '/#/browse/CLAUDE.md', '[data-line-id]');
    await page.waitForTimeout(400);
  };
  const files = (page: Page) => page.locator('.left-panel');
  const activity = (page: Page) => page.locator('.sidebar-wrapper');
  // The real "open" controls live in the file header (the drawers' own Hide/Collapse buttons are inside them).
  const showFiles = (page: Page) => page.locator('button[data-tooltip="Show file panel"]');
  const showActivity = (page: Page) => page.locator('button[data-tooltip="Open sidebar"]');
  const within = (page: Page, sel: string) => page.locator(sel).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.left >= -1 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1;
  });

  test('closed drawers are inert (no focus, no tab stops) and the code owns the screen', async ({ page }) => {
    await open(page);
    for (const d of [files(page), activity(page)]) {
      await expect(d).toHaveAttribute('inert', '');
    }
    const code = await page.locator('[data-nav-area="codeview"]').boundingBox();
    expect(code!.width).toBeGreaterThanOrEqual(390 - 2);
    // nothing inside a closed drawer can take focus
    const focusable = await page.evaluate(() => {
      const el = document.querySelector('.left-panel button') as HTMLElement | null;
      el?.focus();
      return document.activeElement === el;
    });
    expect(focusable).toBe(false);
  });

  test('the toggles that open the drawers are visible, labelled and tappable', async ({ page }) => {
    await open(page);
    for (const t of [showFiles(page), showActivity(page)]) {
      await expect(t).toBeVisible();
      expect(((await t.getAttribute('aria-label')) ?? '').length).toBeGreaterThan(0);
      const b = await t.boundingBox();
      expect(Math.min(b!.width, b!.height)).toBeGreaterThanOrEqual(24);
    }
  });

  for (const d of [
    { name: 'file panel', panel: files, toggle: showFiles, sel: '.left-panel', backdropX: 380 },        // slides in from the left
    { name: 'activity sidebar', panel: activity, toggle: showActivity, sel: '.sidebar-wrapper', backdropX: 10 }, // from the right
  ]) {
    test(`${d.name}: opens on screen with focus inside; Escape and the backdrop close it; focus returns`, async ({ page }) => {
      await open(page);
      const toggle = d.toggle(page);
      await toggle.click();
      await expect(d.panel(page)).not.toHaveAttribute('inert', '');
      await expect.poll(() => within(page, d.sel)).toBe(true); // after the slide-in
      await expect.poll(() => page.evaluate((sel) => !!document.activeElement?.closest(sel), d.sel)).toBe(true);
      await expect(page.locator('.mobile-drawer-backdrop')).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(d.panel(page)).toHaveAttribute('inert', '');
      await expect(page.locator('.mobile-drawer-backdrop')).toHaveCount(0);

      await d.toggle(page).click();
      await expect(d.panel(page)).not.toHaveAttribute('inert', '');
      await page.locator('.mobile-drawer-backdrop').click({ position: { x: d.backdropX, y: 400 } });
      await expect(d.panel(page)).toHaveAttribute('inert', '');
      // focus is somewhere sensible, not lost on <body>
      expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
    });
  }

  test('only one drawer is open at a time', async ({ page }) => {
    await open(page);
    await showFiles(page).click();
    await expect(files(page)).not.toHaveAttribute('inert', '');
    await page.keyboard.press('Escape');
    await showActivity(page).click();
    await expect(activity(page)).not.toHaveAttribute('inert', '');
    await expect(files(page)).toHaveAttribute('inert', '');
  });

  test('choosing a file in the drawer opens it and closes the drawer', async ({ page }) => {
    await open(page);
    await showFiles(page).click();
    await expect(files(page)).not.toHaveAttribute('inert', '');
    await page.locator('.left-panel .tree-dir', { hasText: 'docs' }).click();
    await page.locator('.left-panel .tree-file', { hasText: 'notes.md' }).click();
    await expect(page.locator('.file-header')).toContainText('notes.md');
    await expect(files(page)).toHaveAttribute('inert', '');
  });

  test('keyboard (hardware keyboard on a tablet/phone): F6 then Enter on the file-panel toggle opens it', async ({ page }) => {
    await open(page);
    await page.keyboard.press('F6');
    const target = showFiles(page);
    for (let i = 0; i < 40 && !(await target.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('ArrowRight');
    await expect(target).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(files(page)).not.toHaveAttribute('inert', '');
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.left-panel'))).toBe(true);
  });
});

test.describe('overview column order as the page narrows', () => {
  const tops = (page: import('@playwright/test').Page) => page.evaluate(() => {
    const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
    const f = box('.ovp-col-findings'), s = box('.ovp-col-surface'), r = box('.ovp-col-repo');
    return { findings: { x: f.left, y: f.top }, surface: { x: s.left, y: s.top }, repo: { x: r.left, y: r.top } };
  });

  test('phone: findings first, directly above the attack surface; repository last', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(appUrl('/#/overview'));
    await page.waitForSelector('.ovp-col-findings');
    const t = await tops(page);
    expect(t.findings.y).toBeLessThan(t.surface.y);
    expect(t.surface.y).toBeLessThan(t.repo.y);
  });

  for (const width of [1000, 1440, 1920]) test(`desktop ${width}px: two even columns, findings stacked on the attack surface beside the repository`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(appUrl('/#/overview'));
    await page.waitForSelector('.ovp-col-findings');
    const t = await tops(page);
    expect(Math.round(t.findings.x)).toBe(Math.round(t.surface.x));
    expect(t.findings.y).toBeLessThan(t.surface.y);
    expect(t.repo.x).toBeLessThan(t.findings.x);
    expect(Math.round(t.repo.y)).toBe(Math.round(t.findings.y));
    // Findings and the attack surface are stacked with the normal gap, whatever the repository's height.
    const gap = await page.evaluate(() => document.querySelector('.ovp-col-surface')!.getBoundingClientRect().top - document.querySelector('.ovp-col-findings')!.getBoundingClientRect().bottom);
    expect(Math.round(gap)).toBe(16);
    const widths = await page.evaluate(() => ['.ovp-col-repo', '.ovp-col-findings'].map((s) => Math.round(document.querySelector(s)!.getBoundingClientRect().width)));
    expect(Math.abs(widths[0] - widths[1])).toBeLessThanOrEqual(1); // 50/50
  });

  test('ultrawide: three columns side by side', async ({ page }) => {
    await page.setViewportSize({ width: 3440, height: 1440 });
    await page.goto(appUrl('/#/overview'));
    await page.waitForSelector('.ovp-col-findings');
    const t = await tops(page);
    expect(t.repo.x).toBeLessThan(t.findings.x);
    expect(t.findings.x).toBeLessThan(t.surface.x);
    expect(Math.round(t.findings.y)).toBe(Math.round(t.surface.y));
  });
});

test.describe('expanding search in the workbench toolbars', () => {
  for (const [hash, row] of [['#/findings', '.findings-title-row'], ['#/features', '.features-title-row-right']]) {
    test(`${hash}: the search is last in its row and grows into the free space when focused`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(appUrl('/' + hash));
      const box = page.locator(`${row} .annotation-search--expand`);
      await expect(box).toBeVisible();
      const idle = (await box.boundingBox())!.width;
      await page.mouse.click(5, 880);
      await page.keyboard.press('/');
      await expect(box.locator('input')).toBeFocused();
      await expect(box).toHaveClass(/annotation-search--open/);
      await expect.poll(async () => (await box.boundingBox())!.width).toBeGreaterThan(idle + 40);
    });
  }
});
