import { defineConfig, devices } from '@playwright/test'

// In the Docker sidecar the frontend is already served by nginx on the
// app-network. Set PLAYWRIGHT_BASE_URL to skip the Vite dev-server startup.
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173'
const useExternalServer = !!process.env.PLAYWRIGHT_BASE_URL

export default defineConfig({
  testDir: './src/__tests__/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Only spin up the dev server when running locally (no external URL provided).
  webServer: useExternalServer ? undefined : {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
