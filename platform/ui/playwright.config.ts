import { defineConfig, devices } from '@playwright/test';

// Isolated platform e2e: own ports, throwaway repos + data dir, seeded flows.
// Run: npx playwright test   (from platform/ui)
const WEB = 5184;
const API = 8092;

export default defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${WEB}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node e2e/support/platform-fixture.mjs',
      url: `http://localhost:${API}/api/projects`,
      env: { E2E_PLATFORM_PORT: String(API) },
      stdout: 'ignore',
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: 'npm run dev',
      url: `http://localhost:${WEB}`,
      env: { VITE_PORT: String(WEB), PLATFORM_API: `http://localhost:${API}` },
      stdout: 'ignore',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
