import { test, expect } from '@playwright/test';

/**
 * Profile tab (service profile) end-to-end:
 * - #/profile deep link renders the form
 * - unconfigured banner shows on other tabs and links to Profile
 * - setting fields + Save persists across reload
 * - write gate: unconfigured profile blocks finding creation with 412
 *
 * NOTE: assumes a fresh database. The banner/gate assertions are skipped
 * when the profile is already configured (e.g. reusing a dev DB).
 */

test.describe('Profile tab - service profile', () => {
  test('profile tab renders form via #/profile and nav tab', async ({ page }) => {
    await page.goto('/#/profile');
    await expect(page.locator('.profile-title')).toHaveText('Profile');

    // All four multi-select groups and six radio groups present
    await expect(page.locator('.profile-choices-check')).toHaveCount(4);
    await expect(page.locator('.profile-choices-radio')).toHaveCount(6);

    // Tab bar has the Config tab, marked active
    const tab = page.locator('.tab-bar-tab', { hasText: 'Profile' });
    await expect(tab).toHaveClass(/tab-bar-tab-active/);
  });

  test('write gate: unconfigured profile rejects finding creation with 412', async ({ request }) => {
    const profile = await (await request.get('/api/profile')).json();
    test.skip(!!profile.updatedAt, 'profile already configured in this database');

    const res = await request.post('/api/findings', { data: {} });
    expect(res.status()).toBe(412);
    expect((await res.json()).error).toContain('service profile not configured');
  });

  test('unconfigured banner links to config; save persists and clears it', async ({ page }) => {
    await page.goto('/#/delta');
    await page.waitForSelector('.tab-bar');

    const banner = page.locator('.profile-banner');
    const configured = !(await banner.isVisible().catch(() => false));
    test.skip(configured, 'profile already configured in this database');

    await banner.locator('.profile-banner-link').click();
    await expect(page.locator('.profile-title')).toBeVisible();

    // Fill some fields
    await page.locator('#profile-owner').fill('platform-team');
    await page.locator('.profile-choices-radio').first().locator('.profile-choice', { hasText: 'Full' }).click();
    // Multi-select: pick WAF, then None (exclusive) in Edge Protections
    const edgeGroup = page.locator('.profile-choices-check').first();
    await edgeGroup.locator('.profile-choice', { hasText: 'WAF' }).click();
    await edgeGroup.locator('.profile-choice', { hasText: 'None' }).click();
    // 'none' is exclusive: WAF should be deselected and disabled
    await expect(edgeGroup.locator('.profile-choice-active')).toHaveCount(1);
    await expect(edgeGroup.locator('.profile-choice-disabled')).toHaveCount(4);

    // Auto-save: after the debounce the status indicator settles on Saved
    await expect(page.locator('.profile-save-status')).toHaveText(/Saved/, { timeout: 5000 });

    // Persisted across reload
    await page.goto('/#/profile');
    await expect(page.locator('#profile-owner')).toHaveValue('platform-team');
    await expect(page.locator('.profile-updated-at')).toBeVisible();

    // Banner gone on other tabs
    await page.goto('/#/delta');
    await page.waitForSelector('.tab-bar');
    await expect(page.locator('.profile-banner')).toHaveCount(0);
  });
});
