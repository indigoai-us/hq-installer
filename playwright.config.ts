import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:1420',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm vite --port 1420',
    url: 'http://localhost:1420',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      VITE_COGNITO_USER_POOL_ID: process.env.VITE_COGNITO_USER_POOL_ID ?? 'us-east-1_TESTPOOL',
      VITE_COGNITO_CLIENT_ID: process.env.VITE_COGNITO_CLIENT_ID ?? 'test-client-id',
      VITE_COGNITO_DOMAIN: process.env.VITE_COGNITO_DOMAIN ?? 'https://mock-cognito.auth.us-east-1.amazoncognito.com',
    },
  },
});
