import { defineConfig, devices } from '@playwright/test';

// The same e2e suite against the PRODUCTION build embedded in the Go server
// (minified, no Vite, no StrictMode double effects): `npm run build` + go:embed,
// served by the backend itself on :8095. Run: npx playwright test -c playwright.prod.config.ts
const API = 8095;
const FRESH_API = 8096;

export default defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${API}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', testIgnore: /profile\.spec/, use: { ...devices['Desktop Chrome'] } },
    { name: 'fresh-profile', testMatch: /profile\.spec/, use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${FRESH_API}` } },
  ],
  webServer: [
    {
      // Builds the frontend, embeds it, seeds data. (Builds once; the fresh server reuses the binary's dist.)
      command: 'node e2e/support/fixture-server.mjs',
      url: `http://localhost:${API}/api/git/info`,
      env: { E2E_API_PORT: String(API), E2E_PROD: '1' },
      stdout: 'ignore',
      reuseExistingServer: false,
      timeout: 300_000,
    },
    {
      command: 'node e2e/support/fixture-server.mjs',
      url: `http://localhost:${FRESH_API}/api/git/info`,
      env: { E2E_API_PORT: String(FRESH_API), E2E_FRESH: '1', E2E_PROD: '1' },
      stdout: 'ignore',
      reuseExistingServer: false,
      timeout: 300_000,
    },
  ],
});
