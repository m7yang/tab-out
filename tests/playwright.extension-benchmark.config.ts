import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './extension',
  testMatch: '**/*.benchmark.spec.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  timeout: 30 * 60_000,
  expect: {
    timeout: 30_000
  }
})
