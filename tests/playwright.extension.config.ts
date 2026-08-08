import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './extension',
  testMatch: '**/*.spec.ts',
  testIgnore: '**/*.benchmark.spec.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  timeout: 45_000,
  expect: {
    timeout: 10_000
  }
})
