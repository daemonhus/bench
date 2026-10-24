import { test, expect } from './helpers/input';
import type { Page } from '@playwright/test';

// Expected behaviour from the UX review: one page frame, a usable phone layout, a way to remove
// a project, and no dialog focus-ring artefacts.

const SIZES = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'ultrawide', width: 3440, height: 1440 },
];

const SETTINGS_HIDDEN = 'Settings is hidden for now (SETTINGS_ENABLED in PlatformShell)';

const left = (page: Page, sel: string) => page.locator(sel).first().evaluate(e => Math.round(e.getBoundingClientRect().left));

for (const s of SIZES) {
  test.describe(`${s.name}`, () => {
    test.use({ viewport: { width: s.width, height: s.height } });

    test('Projects and Flows start their content at the same left edge', async ({ page }) => {
      const edges: Record<string, number> = {};
      await page.goto('/projects');
      await page.waitForSelector('.project-card');
      edges.projectsList = await left(page, '.project-list-title');
      await page.goto('/flows');
      await page.waitForSelector('.flows-list-header');
      edges.flows = await left(page, '.flows-list-header h1');
      const all = Object.values(edges);
      expect(Math.max(...all) - Math.min(...all), JSON.stringify(edges)).toBeLessThanOrEqual(1);
    });

    test('an empty facet column does not leave a gap before the project list', async ({ page }) => {
      await page.goto('/projects');
      await page.waitForSelector('.project-card');
      await expect(page.locator('.overview-col-facets')).toBeHidden();
    });
  });
}

test.describe('phone layout', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('navigation is a bottom bar and nothing scrolls sideways', async ({ page }) => {
    for (const url of ['/projects', '/flows']) {
      await page.goto(url);
      await page.waitForSelector('.platform-rail');
      const m = await page.evaluate(() => {
        const r = document.querySelector('.platform-rail')!.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, h: innerHeight, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
      });
      expect(m.top, `${url}: rail at the bottom`).toBeGreaterThan(m.h / 2);
      expect(Math.round(m.bottom)).toBeLessThanOrEqual(m.h);
      expect(m.sw, `${url}: no sideways scroll`).toBeLessThanOrEqual(m.cw);
    }
  });

  test('every rail control is on screen and at least 44px wide', async ({ page }) => {
    await page.goto('/projects');
    const boxes = await page.locator('.platform-rail-btn').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width, h: r.height }; }));
    expect(boxes.length).toBe(5); // Activity, Projects, Flows, Map + theme (the logo is not a rail button); Settings is hidden for now
    for (const b of boxes) { expect(b.l).toBeGreaterThanOrEqual(0); expect(b.r).toBeLessThanOrEqual(390); expect(b.w).toBeGreaterThanOrEqual(44); expect(b.h).toBeGreaterThanOrEqual(44); }
  });

  test('flow rows show the flow name and stay inside the screen', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('flows-layout', 'table'));
    await page.goto('/flows');
    await page.waitForSelector('.flows-table-row');
    const rows = await page.locator('.flows-table-row').evaluateAll(els => els.map(e => {
      const n = e.querySelector('.ft-flow-name')!.getBoundingClientRect();
      const r = e.getBoundingClientRect();
      return { nameW: n.width, nameRight: n.right, rowRight: r.right, text: e.querySelector('.ft-flow-name')!.textContent };
    }));
    for (const r of rows) {
      expect(r.nameW, `${r.text} has room to read`).toBeGreaterThan(120);
      expect(r.rowRight).toBeLessThanOrEqual(390);
    }
  });
});

test.describe('Edit project dialog', () => {
  test('focused fields do not draw a ring around their label', async ({ page }) => {
    await page.goto('/projects');
    await page.waitForSelector('.project-card');
    await page.getByRole('button', { name: 'Edit alpha' }).click();
    const field = page.locator('.modal-field').first();
    await expect(field.locator('input')).toBeFocused();
    const outline = await field.evaluate(e => getComputedStyle(e).outlineStyle);
    expect(outline).toBe('none');
  });

  test('the edit control is visible without hovering and named after its project', async ({ page }) => {
    await page.goto('/projects');
    await page.waitForSelector('.project-card');
    const btn = page.getByRole('button', { name: 'Edit alpha' });
    await expect(btn).toBeVisible();
    expect(await btn.evaluate(e => getComputedStyle(e).opacity)).toBe('1');
  });

  test('removing a project asks first, and Keep leaves it alone', async ({ page }) => {
    await page.goto('/projects');
    await page.waitForSelector('.project-card');
    await page.getByRole('button', { name: 'Edit alpha' }).click();
    await page.getByRole('button', { name: 'Remove project…' }).click();
    await expect(page.getByRole('alert')).toContainText('Its repository is not touched');
    await page.getByRole('button', { name: 'Keep project' }).click();
    await expect(page.getByRole('alert')).toBeHidden();
    await expect(page.getByRole('dialog', { name: 'Edit project' })).toBeVisible();
  });

  test('confirming removal deletes the project and closes the dialog', async ({ page, request }) => {
    const info = await (await request.get('/api/projects')).json();
    const repoPath = info.find((p: { name: string }) => p.name === 'beta').repoPath;
    const res = await request.post('/api/projects', { data: { name: 'zz-removable', repoPath } });
    test.skip(!res.ok(), 'fixture refused a second project on the same repo');
    await page.goto('/projects');
    await page.waitForSelector('.project-card');
    await page.getByRole('button', { name: 'Edit zz-removable' }).click();
    await page.getByRole('button', { name: 'Remove project…' }).click();
    await page.getByRole('button', { name: 'Remove project', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.locator('.project-card', { hasText: 'zz-removable' })).toHaveCount(0);
  });

  test('cards show the repository name, with the full path in the tooltip', async ({ page }) => {
    await page.goto('/projects');
    await page.waitForSelector('.project-card');
    const path = page.locator('.project-card-path').first();
    const text = (await path.textContent()) ?? '';
    expect(text.startsWith('…/') || !text.includes('/var/')).toBe(true);
    expect(await path.getAttribute('title')).toMatch(/^\//);
  });
});

test.describe('project cards', () => {
  test('a card shows risk, exposure and the key numbers as tiles; open findings are hoverable squares', async ({ page }) => {
    await page.goto('/projects');
    const card = page.locator('.project-card', { hasText: 'alpha' });
    await expect(card).toBeVisible();
    // One risk badge, its breakdown in the tooltip.
    await expect(card.locator('.pc-risk')).toHaveAttribute('title', /^Risk \d+/);
    // No service profile in the fixture: no exposure chips (and no "unknown" placeholder).
    await expect(card.locator('.pc-meta')).not.toContainText('exposure');
    // A tile, or one half of a split tile.
    const tile = (label: string) => card.locator('.pc-tile:not(.pc-tile--split), .pc-tile-half', { has: page.locator('.pc-tile-label', { hasText: label }) });
    await expect(tile('Open findings').locator('.pc-tile-value')).toHaveText('3');
    // One hoverable square per open finding, worst first (at most 10, then "+N more" to the list).
    const squares = tile('Open findings').locator('.ovp-kind-square');
    await expect(squares).toHaveCount(3);
    await expect(tile('Open findings').locator('.pc-squares-more')).toHaveCount(0);
    // Open findings and Past SLA share one tile, split in half, each with its own label.
    const split = card.locator('.pc-tile--split');
    await expect(split.locator('.pc-tile-half')).toHaveCount(2);
    await expect(split.locator('.pc-tile-label')).toHaveText(['Open findings', 'Past SLA']);
    await expect(tile('Past SLA').locator('.pc-tile-value')).toHaveText('0'); // all just created
    await expect(tile('Past SLA').locator('.pc-tile-sub')).toHaveText('all within deadline');
    await expect(tile('Last baseline').locator('.pc-tile-value')).toHaveText('today');
    // The baseline tile also says what has landed since; there's no separate Unreviewed tile.
    await expect(tile('Last baseline').locator('.pc-tile-sub')).toContainText('unreviewed');
    await expect(card.locator('.pc-tile-label')).toHaveText(['Open findings', 'Past SLA', 'Last baseline', 'Activity', 'Size']);
    // Activity: the default branch's last push (the fixture repo was just committed to) and its pace.
    await expect(tile('Activity').locator('.pc-tile-value')).toHaveText('today');
    await expect(tile('Activity').locator('.pc-tile-sub')).toHaveText(/^(\d+(\.\d)? commits?\/mo|under 1 commit\/mo|no commits this year)$/);
    await expect(tile('Activity')).toHaveAttribute('title', /^Last push today\. \d+ commits? on \S+ over the last 1 month; newest .*commits per week\.$/);
    // A year of weekly history behind it, GitHub-style: decorative, hidden from assistive tech.
    await expect(tile('Activity').locator('svg.pc-activity-graph')).toHaveAttribute('aria-hidden', 'true');
    await expect(tile('Activity').locator('.pc-activity-graph-line')).toHaveAttribute('d', /^M[\d.]+,[\d.]+C/);
    await expect(tile('Size').locator('.pc-tile-value')).toHaveText('4'); // every feature counts
    // Hovering a square shows bench's finding card; its title opens the finding's page.
    await squares.first().hover();
    const mini = card.locator('.ovp-map-card');
    await expect(mini).toBeVisible();
    await expect(mini).toContainText(/high/i); // worst first
    await mini.locator('.ovp-map-card-title').click();
    await expect(page).toHaveURL(/\/p\/alpha#\/finding\//);
    await expect(page.locator('.fd-title')).toBeVisible();
  });

  test("each tile opens its page in the project: findings, Changes, Features", async ({ page }) => {
    await page.goto('/projects');
    const card = page.locator('.project-card', { hasText: 'alpha' });
    const link = (label: string) => card.getByRole('link', { name: new RegExp(`^${label}: open`) });
    await expect(link('Open findings')).toHaveAttribute('href', '/p/alpha#/findings?status=open');
    await expect(link('Past SLA')).toHaveAttribute('href', '/p/alpha#/findings?overdue=1');
    await expect(link('Last baseline')).toHaveAttribute('href', '/p/alpha#/delta');
    await expect(link('Size')).toHaveAttribute('href', '/p/alpha#/features');

    // A click anywhere on the tile, its number included, lands on the link, not the card.
    await card.locator('.pc-tile', { has: page.locator('.pc-tile-label', { hasText: 'Activity' }) }).click();
    await expect(page).toHaveURL(/\/p\/alpha#\/delta$/);
    await expect(page.locator('.tab-bar-tab-active', { hasText: 'Changes' })).toBeVisible();

    // The finding squares inside the Open findings tile still open their own findings.
    await page.goto('/projects');
    await card.locator('.ovp-kind-square').first().click();
    await expect(page).toHaveURL(/\/p\/alpha#\/finding\//);
  });

  test('projects can be sorted by size', async ({ page }) => {
    await page.goto('/projects');
    await expect(page.locator('.project-card').first()).toBeVisible();
    await page.locator('.features-sort-btn', { hasText: 'Size' }).click();
    await expect(page.locator('.features-sort-btn-active')).toHaveText(/Size/);
  });

  test('hovering a card lifts it (firmer border, soft shadow) without changing its surface or using the accent', async ({ page }) => {
    await page.goto('/projects');
    await page.waitForSelector('.project-card');
    const card = page.locator('.project-card').first();
    const read = () => card.evaluate(e => { const c = getComputedStyle(e); return { border: c.borderTopColor, bg: c.backgroundColor, shadow: c.boxShadow }; });
    const before = await read();
    await card.hover({ position: { x: 200, y: 40 } });
    await page.waitForTimeout(300);
    const after = await read();
    expect(after.bg).toBe(before.bg); // the surface stays, so the recessed tiles keep their depth
    expect(after.border).not.toBe(before.border);
    expect(after.shadow).not.toBe('none');
    expect(after.border).not.toContain('129, 140, 248'); // not the accent
    expect(after.shadow).not.toContain('20px'); // the old 0 4px 20px glow
  });
});

test.describe('wording and clarity', () => {
  test('flow detail is titled by the flow\'s name, and its breadcrumb does not repeat it', async ({ page }) => {
    await page.goto('/flows');
    await page.locator('.flow-card', { hasText: 'Login path' }).click();
    await expect(page.locator('.flow-detail-name').first()).toHaveText('Login path');
    await expect(page.locator('.flow-detail-heading .flow-path')).not.toContainText('Login path');
    await expect(page.locator('.flow-detail-stat-label', { hasText: 'Open findings' })).toBeVisible();
  });

  test('settings: SSO off says so once; the last enabled login method explains why it is locked', async ({ page }) => {
    test.skip(true, SETTINGS_HIDDEN);
    await page.goto('/settings');
    await page.getByRole('button', { name: /Authentication/ }).click();
    await expect(page.getByText(/Enable SSO/)).toHaveCount(1);
    await expect(page.getByText(/required: at least one method must stay on/)).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Password' })).toHaveAttribute('aria-disabled', 'true');
  });

  test('settings labels use sentence case', async ({ page }) => {
    test.skip(true, SETTINGS_HIDDEN);
    await page.goto('/settings');
    await page.getByRole('button', { name: /Scoring/ }).click();
    await expect(page.getByText('Staleness (per day)')).toBeVisible();
    await page.getByRole('button', { name: /Editor/ }).click();
    await expect(page.getByText('Font size (px)')).toBeVisible();
  });

  test('the logo is Home (Bench); Projects is its own rail item', async ({ page }) => {
    await page.goto('/flows');
    await page.getByRole('button', { name: 'Bench' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('button', { name: 'Bench' })).toHaveAttribute('aria-current', 'page');
    await page.locator('.platform-rail-btn[title="Projects"]').click();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.locator('.project-card').first()).toBeVisible();
  });
});

test.describe('tab bars match bench', () => {
  const tabStyle = (page: import('@playwright/test').Page, sel: string) =>
    page.locator(sel).first().evaluate((e) => {
      const c = getComputedStyle(e);
      const bar = e.closest('.tab-bar')!;
      return {
        font: c.fontSize, weight: c.fontWeight, color: c.color,
        barHeight: Math.round(bar.getBoundingClientRect().height),
        underline: getComputedStyle(e, '::after').content !== 'none' && getComputedStyle(e, '::after').height,
      };
    });

  test('flow page tabs and saved views both use bench\'s tab bar', async ({ page }) => {
    await page.goto('/flows');
    const views = await tabStyle(page, '.flows-view-tabs .tab-bar-tab-active');
    await page.locator('.flow-card', { hasText: 'Login path' }).locator('.flow-card-title').click();
    const flow = await tabStyle(page, '.flow-detail-tab-bar .tab-bar-tab-active');
    expect(views).toEqual(flow);
    expect(flow).toMatchObject({ font: '13px', weight: '500', barHeight: 52, underline: '2px' });
  });

  test('switching flow tabs does not move the tab bar', async ({ page }) => {
    await page.goto('/flows');
    await page.locator('.flow-card', { hasText: 'Login path' }).locator('.flow-card-title').click();
    const ys = new Set<number>();
    for (const name of ['Flow', 'Map', 'Findings', 'Baselines', 'Flow']) {
      await page.locator('.flow-detail-tab-bar').getByRole('button', { name, exact: true }).click();
      await expect(page.locator('.flow-detail-tab-bar').getByRole('button', { name, exact: true })).toHaveAttribute('aria-current', 'page');
      ys.add(Math.round((await page.locator('.flow-detail-tab-bar').boundingBox())!.y));
    }
    expect([...ys]).toHaveLength(1);
  });

  test('the first tab lines up with the page title', async ({ page }) => {
    for (const [url, tab, title] of [['/flows', '.flows-view-tabs .tab-bar-tab', '.flows-list-header h1']]) {
      await page.goto(url);
      const x = await page.locator(tab).first().evaluate((e) => { const r = document.createRange(); r.selectNodeContents(e); return r.getBoundingClientRect().left; });
      const t = (await page.locator(title).boundingBox())!.x;
      expect(Math.abs(x - t), url).toBeLessThanOrEqual(2);
    }
  });
});

test.describe('buttons and titles match bench', () => {
  test('page titles share bench\'s title style and top edge', async ({ page }) => {
    const seen: string[] = [];
    for (const [url, sel] of [['/projects', 'h2.project-list-title'], ['/flows', '.flows-list-header h1']]) {
      await page.goto(url);
      const t = page.locator(sel);
      await expect(t).toHaveClass(/overview-section-title/);
      seen.push(await t.evaluate((e) => { const c = getComputedStyle(e); return `${c.fontSize} ${c.fontWeight} ${c.letterSpacing} y=${Math.round(e.getBoundingClientRect().y)}`; }));
    }
    expect(new Set(seen).size, seen.join(' | ')).toBe(1);
  });

  test('header, dialog and page buttons are bench\'s action buttons', async ({ page }) => {
    const style = (sel: string) => page.locator(sel).first().evaluate((e) => {
      const c = getComputedStyle(e); return { font: c.fontSize, radius: c.borderRadius, h: Math.round(e.getBoundingClientRect().height) };
    });
    await page.goto('/projects');
    const add = await style('.add-project-trigger');
    await page.getByRole('button', { name: 'Edit alpha' }).click();
    const save = await style('[role="dialog"] .baseline-action-btn-primary');
    const cancel = await style('[role="dialog"] .baseline-action-btn-outline');
    await page.keyboard.press('Escape');
    await page.goto('/flows');
    const newFlow = await style('.flows-list-actions .baseline-action-btn-primary');
    const newFolder = await style('.flows-list-actions .baseline-action-btn-outline');
    for (const b of [save, cancel, newFlow, newFolder]) expect(b).toEqual(add);
    expect(add).toEqual({ font: '13px', radius: '5px', h: 34 });
    expect(await page.locator('.flows-btn-primary, .flows-btn-ghost, .modal-btn').count()).toBe(0);
  });

  test('no control falls back to the browser font', async ({ page }) => {
    for (const url of ['/projects', '/flows']) {
      await page.goto(url);
      await page.waitForTimeout(300);
      const fonts = await page.evaluate(() => [...new Set([...document.querySelectorAll('button, input, select, textarea')]
        .map((e) => getComputedStyle(e).fontFamily.split(',')[0].trim().replace(/"/g, '')))]);
      expect(fonts.filter((f) => /^(arial|helvetica|times)/i.test(f)), url).toEqual([]);
    }
  });
});

test.describe('search, filters and sort match bench', () => {
  test('search is bench\'s SearchBox: borderless pill, "/" focuses it, ✕ clears it', async ({ page }) => {
    for (const url of ['/projects', '/flows']) {
      await page.goto(url);
      const box = page.locator('.annotation-search.filter-search');
      await expect(box).toBeVisible();
      expect(await box.evaluate((e) => getComputedStyle(e).borderTopWidth)).toBe('0px');
      await page.mouse.click(5, 5);
      await page.keyboard.press('/');
      await expect(box.locator('input')).toBeFocused();
      await page.keyboard.type('zzz');
      await box.locator('.annotation-search-clear').click();
      await expect(box.locator('input')).toHaveValue('');
    }
  });

  test('flow filters are bench dropdowns with a Filter label and reset', async ({ page }) => {
    await page.goto('/flows');
    const bar = page.locator('.flows-filter-bar .activity-filters');
    await expect(bar.locator('.activity-filters-label')).toHaveText('Filter');
    await expect(bar.locator('.multi-select-trigger')).toHaveText([/Status/, /Project/, /Tag/, /Owner/]);
    await bar.locator('.multi-select-trigger', { hasText: 'Status' }).click();
    await expect(page.getByRole('listbox', { name: 'Status' }).getByRole('option')).toHaveCount(3);
    expect(await page.locator('.flows-filter-chip, .flows-filter-popover, select.flow-sort-select').count()).toBe(0);
  });

  test('sort is bench\'s sort toggle; clicking the active one reverses it', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('flows-layout', 'table'));
    await page.goto('/flows');
    const names = () => page.locator('.flows-table-row .ft-flow-name').allTextContents();
    const sortName = page.locator('.flows-filter-bar .features-sort-btn', { hasText: 'Name' });
    await sortName.click();
    await expect(sortName).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(names).toEqual(['Cross project', 'Empty flow', 'Login path']);
    await sortName.click();
    await expect.poll(names).toEqual(['Login path', 'Empty flow', 'Cross project']);

    await page.goto('/projects');
    const cards = () => page.locator('.project-card .project-card-name').allTextContents();
    await expect.poll(cards).toEqual(['alpha', 'beta']);
    await page.locator('.project-list-header .features-sort-btn', { hasText: 'Name' }).click();
    await expect.poll(cards).toEqual(['beta', 'alpha']);
    expect(await page.locator('select.project-sort-select').count()).toBe(0);
  });
});

test('toolbar controls share one height and baseline (platform Flows and the embedded workbench)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const TRACKS = '.annotation-search, .multi-select-pill, .features-sort-toggle, .activity-kind-toggles';
  const measure = (scope: string) => page.locator(scope).first().evaluate((root, sel) =>
    [...root.querySelectorAll(sel)].filter((e) => (e as HTMLElement).offsetParent)
      .map((e) => { const r = e.getBoundingClientRect(); return { h: Math.round(r.height), top: Math.round(r.top) }; }), TRACKS);
  await page.goto('/flows');
  const flows = await measure('.flows-filter-bar');
  expect(flows.length).toBeGreaterThanOrEqual(6);
  expect(new Set(flows.map((m) => m.h)).size, JSON.stringify(flows)).toBe(1);
  expect(new Set(flows.map((m) => m.top)).size, JSON.stringify(flows)).toBe(1);
  await page.goto('/p/alpha#/findings');
  await page.waitForSelector('.findings-title-row .annotation-search');
  const bench = await measure('.findings-title-row');
  expect(new Set(bench.map((m) => m.h)).size, JSON.stringify(bench)).toBe(1);
  expect(bench[0].h).toBe(flows[0].h);
});

test.describe('expanding search', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  for (const [url, row] of [['/flows', '.flows-filter-bar'], ['/projects', '.project-list-header']]) {
    test(`${url}: leads the right-aligned controls and expands into the free space`, async ({ page }) => {
      await page.goto(url);
      const box = page.locator(`${row} .annotation-search--expand`);
      const rowBox = (await page.locator(row).boundingBox())!;
      const idle = (await box.boundingBox())!;
      const firstControl = async () => (await page.locator(row).locator('button').first().boundingBox())!.x;
      const before = await firstControl();
      // Search leads its group of controls, which is pushed to the row's right end.
      expect(idle.x + idle.width).toBeLessThanOrEqual(before);
      expect(rowBox.x + rowBox.width - ((await page.locator(row).locator('button').last().boundingBox())!.x)).toBeLessThan(200);
      await page.mouse.click(5, 890);
      await page.keyboard.press('/');
      await expect(box).toHaveClass(/annotation-search--open/);
      await expect.poll(async () => (await box.boundingBox())!.width).toBeGreaterThan(idle.width + 40);
      expect(await firstControl()).toBe(before); // nothing else moves
      // A query keeps it open after focus leaves; clearing and leaving collapses it.
      await page.keyboard.type('zz');
      await page.mouse.click(5, 890);
      await expect(box).toHaveClass(/annotation-search--open/);
      await box.locator('.annotation-search-clear').click();
      await page.mouse.click(5, 890);
      await expect(box).not.toHaveClass(/annotation-search--open/);
      await expect.poll(async () => Math.round((await box.boundingBox())!.width)).toBe(Math.round(idle.width));
    });
  }
});

test.describe('step 5: theme, focus rings, tab panels', () => {
  test('Settings\' theme picker is the same setting as the rail button, applied straight away', async ({ page }) => {
    test.skip(true, SETTINGS_HIDDEN);
    await page.goto('/settings');
    const html = () => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    const start = await html();
    const other = start === 'dark' ? 'Light' : 'Dark';
    const same = start === 'dark' ? 'Dark' : 'Light';
    const picker = page.getByRole('group', { name: 'Theme' });
    await expect(picker.getByRole('button', { name: same })).toHaveAttribute('aria-pressed', 'true');
    await picker.getByRole('button', { name: other }).click();
    expect(await html()).toBe(other.toLowerCase()); // no Save needed
    await expect(page.locator('.platform-rail-label', { hasText: other })).toBeVisible();
    await page.getByRole('button', { name: /^Switch to/ }).click(); // the rail button
    await expect(picker.getByRole('button', { name: same })).toHaveAttribute('aria-pressed', 'true');
    expect(await html()).toBe(start);
  });

  test('keyboard focus uses bench\'s one ring (saved-view delete, card menu items)', async ({ page }) => {
    await page.goto('/flows');
    // Chrome snaps the 1.5px outline to device pixels, so compare with a reference control
    // that uses bench's global rule rather than with a literal width.
    const ring = () => page.evaluate(() => { const s = getComputedStyle(document.activeElement!); return `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor} ${s.outlineOffset}`; });
    await page.getByRole('button', { name: 'New flow' }).focus();
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
    const reference = await ring();
    expect(reference).toMatch(/^solid/);
    const close = page.locator('.flows-view-tab-close').first();
    await close.focus();
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    expect(await ring()).toBe(reference);
    await page.locator('.flow-card-menu-btn').first().focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem').first()).toBeFocused();
    expect((await ring()).split(' ').slice(0, 3).join(' ')).toBe(reference.split(' ').slice(0, 3).join(' ')); // inset offset
    await page.keyboard.press('Escape');
  });

  test('Findings and Baselines tabs do not repeat their name or offer a close button', async ({ page }) => {
    await page.goto('/flows');
    await page.locator('.flow-card', { hasText: 'Login path' }).locator('.flow-card-title').click();
    for (const tab of ['Findings', 'Baselines']) {
      await page.locator('.flow-detail-tab-bar').getByRole('button', { name: tab, exact: true }).click();
      await expect(page.locator('.flow-tab-panel')).toBeVisible();
      await expect(page.locator('.flow-tab-panel .baselines-close')).toHaveCount(0);
      await expect(page.locator('.flow-tab-panel .baselines-panel-title')).toHaveCount(0);
    }
    const btn = page.locator('.baselines-new-btn');
    if (await btn.count()) {
      const panel = (await page.locator('.flow-tab-panel').boundingBox())!;
      expect((await btn.boundingBox())!.width).toBeLessThan(panel.width / 2);
    }
  });
});

test('the rail gives its few items room (desktop)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/flows');
  const boxes = await page.locator('.platform-rail-group').first().locator('.platform-rail-btn')
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ top: r.top, h: r.height })));
  expect(boxes).toHaveLength(4); // Activity, Projects, Flows, Map
  for (const b of boxes) expect(b.h).toBeGreaterThanOrEqual(52);
  for (let i = 1; i < boxes.length; i++) expect(boxes[i].top - (boxes[i - 1].top + boxes[i - 1].h)).toBeGreaterThanOrEqual(12);
  // The active marker still sits on the rail's left edge.
  const spine = await page.locator('.platform-rail-btn-active').evaluate((e) => e.getBoundingClientRect().left + parseFloat(getComputedStyle(e, '::before').left));
  expect(Math.abs(Math.round(spine))).toBe(0);
});

test('Settings is hidden for now: no rail button, and /settings lands on the home page', async ({ page }) => {
  await page.goto('/flows');
  await expect(page.locator('.platform-rail')).toBeVisible();
  await expect(page.locator('.platform-rail-btn[title="Settings"]')).toHaveCount(0);
  await page.goto('/settings');
  await expect(page.locator('.home-header h1')).toHaveText('Bench');
  await expect(page.locator('.settings-page')).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
});
