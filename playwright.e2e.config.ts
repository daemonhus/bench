import { defineConfig, devices } from '@playwright/test';

// Isolated e2e: own ports, throwaway repo + DB, deterministic seed data.
// Leaves any dev servers on 5173/8081 alone. Run: npx playwright test -c playwright.e2e.config.ts
const WEB = 5183;
const API = 8091;
// Suites whose behaviour must hold at every canvas size.
const BEHAVIOUR = /(a11y-scan|chrome-nav|modals|card-actions|reachability|click-only|multi-select|interaction-chains|focus-modality)\.spec/;
const FRESH_WEB = 5185; // second stack: write gate ON, no seed (profile.spec)
const FRESH_API = 8093;

export default defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${WEB}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', testIgnore: /profile\.spec/, use: { ...devices['Desktop Chrome'] } },
    // The behaviour suites again at the other canvas sizes (the responsive.spec layout checks set their own).
    // Run: npx playwright test -c playwright.e2e.config.ts --project=ultrawide --project=phone
    { name: 'ultrawide', testMatch: BEHAVIOUR, use: { ...devices['Desktop Chrome'], viewport: { width: 3440, height: 1440 } } },
    { name: 'phone', testMatch: BEHAVIOUR, use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } } },
    {
      name: 'fresh-profile',
      testMatch: /profile\.spec/,
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${FRESH_WEB}` },
    },
  ],
  webServer: [
    {
      command: 'node e2e/support/fixture-server.mjs',
      url: `http://localhost:${API}/api/git/info`,
      env: { E2E_API_PORT: String(API) },
      stdout: 'ignore',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'node e2e/support/fixture-server.mjs',
      url: `http://localhost:${FRESH_API}/api/git/info`,
      env: { E2E_API_PORT: String(FRESH_API), E2E_FRESH: '1' },
      stdout: 'ignore',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npm run dev',
      url: `http://localhost:${FRESH_WEB}`,
      env: { VITE_PORT: String(FRESH_WEB), BENCH_API: `http://localhost:${FRESH_API}` },
      stdout: 'ignore',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npm run dev',
      url: `http://localhost:${WEB}`,
      env: { VITE_PORT: String(WEB), BENCH_API: `http://localhost:${API}` },
      stdout: 'ignore',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
