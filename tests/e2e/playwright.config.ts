import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 30_000,
  fullyParallel: false, // tests share a daemon + tmux session
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:7686',
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
});
