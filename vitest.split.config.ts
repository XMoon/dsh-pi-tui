import { defineConfig } from 'vitest/config'

/**
 * Split-process Vitest discovery and isolation.
 *
 * This config exists for split-process Vitest E2E coverage; it does not
 * replace the repository's node:test lanes or add itself to any release gate.
 */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.vitest.ts'],
    environment: 'node',
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    retry: 0,
    testTimeout: 600_000,
    hookTimeout: 120_000,
    teardownTimeout: 60_000,
    reporters: ['default'],
    globals: false,
    watch: false,
    snapshotOptions: { updateSnapshot: 'none' },
  },
})
