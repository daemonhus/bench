import { test, expect } from '@playwright/test';
import { appUrl } from './helpers/input';

// The fixture's CLAUDE.md keeps its first 3 lines from "initial"; "rewrite guide" changed the rest.
// A line's blame cell sits beside its row, in the line's wrapper.
const blameOf = (n: number) => `.blame-line:has(> [data-new-line="${n}"]) .blame-cell`;

test.describe('Browse blame', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(appUrl('/#/browse/CLAUDE.md'));
    await page.waitForSelector('[data-new-line="4"]', { timeout: 10000 });
  });

  test('on by default: each run of lines labelled once; B hides it, and that is kept', async ({ page }) => {
    await expect(page.locator('.blame-label')).toHaveCount(2);
    await expect(page.locator(`${blameOf(1)} .blame-label .blame-author`)).toHaveText('E2E');
    await expect(page.locator(`${blameOf(4)} .blame-label`)).toBeVisible();
    await expect(page.locator(`${blameOf(2)} .blame-label`)).toHaveCount(0);
    await expect(page.locator('.blame-toggle')).toHaveAttribute('aria-pressed', 'true');

    await page.locator('.diff-view').focus();
    await page.keyboard.press('b');
    await expect(page.locator('.blame-cell')).toHaveCount(0);
    await expect(page.locator('.blame-toggle')).toHaveAttribute('aria-pressed', 'false');
    expect(page.url()).toContain('?blame=0');

    // Remembered: the plain address opens with blame off.
    await page.goto(appUrl('/#/browse/CLAUDE.md'));
    await page.waitForSelector('[data-new-line="4"]');
    await expect(page.locator('.blame-cell')).toHaveCount(0);

    await page.locator('.blame-toggle').click();
    await expect(page.locator('.blame-label')).toHaveCount(2);
    expect(page.url()).not.toContain('blame=');
  });

  test('the column resizes from its right edge, and keeps its width', async ({ page }) => {
    const cell = page.locator(blameOf(1));
    await expect(page.locator('.blame-label')).toHaveCount(2);
    const before = (await cell.boundingBox())!.width;
    const handle = (await page.locator('.blame-resize-handle').boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 40);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 60, handle.y + 40, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await cell.boundingBox())!.width).toBeCloseTo(before + 60, -1);

    // Arrow keys on the handle step it too.
    await page.locator('.blame-resize-handle').focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await cell.boundingBox())!.width).toBeCloseTo(before + 36, -1);

    await page.reload();
    await expect(page.locator('.blame-label')).toHaveCount(2);
    await expect.poll(async () => (await cell.boundingBox())!.width).toBeCloseTo(before + 36, -1);
  });

  test("a label opens that commit's change to the file", async ({ page }) => {
    const label = page.locator(`${blameOf(4)} .blame-label`);
    await label.hover();
    await expect(label).toHaveAttribute('data-tooltip', /rewrite guide/);
    await label.click();
    await expect(page).toHaveURL(/#\/diff\/[0-9a-f]+\^?\/[0-9a-f]+\/CLAUDE\.md/);
    await expect(page.locator('.diff-row-insert').first()).toBeVisible();
  });

  test('a dragged range and its toolbar start at the gutter, right of the blame column', async ({ page }) => {
    await expect(page.locator('.blame-label')).toHaveCount(2);
    const gutter = (n: number) => page.locator(`[data-new-line="${n}"] .action-gutter`);
    const a = (await gutter(2).boundingBox())!, z = (await gutter(5).boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(z.x + z.width / 2, z.y + z.height / 2, { steps: 6 });
    await page.mouse.up();

    await expect(page.locator('.in-comment-range')).toHaveCount(4);
    const blameRight = (await page.locator(blameOf(2)).boundingBox())!;
    const range = (await page.locator('.comment-range-first').boundingBox())!;
    const toolbar = (await page.locator('.selection-toolbar').boundingBox())!;
    expect(range.x).toBeGreaterThanOrEqual(blameRight.x + blameRight.width - 1);
    expect(toolbar.x).toBeGreaterThanOrEqual(blameRight.x + blameRight.width - 1);
  });
});
