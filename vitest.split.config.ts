import { defineConfig } from 'vitest/config'

/**
 * Split-process Vitest discovery and isolation.
 *
 * The config is the ONE project-selection authority for the split-process
 * Pilot and the split-upgrade suite. Every project carries its own explicit
 * include, worker count and isolation settings; the root deliberately has no
 * wildcard include, so a missing/unknown `--project` can never broaden
 * discovery to another project or to the opt-in native suites.
 *
 * This config exists for split-process Vitest E2E coverage; it does not
 * replace the repository's node:test lanes or add itself to any release gate.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'split-process',
          include: [
            'test/integration/split-multi-client.vitest.ts',
            'test/integration/split-terminal-engine.vitest.ts',
          ],
          environment: 'node',
          pool: 'forks',
          maxWorkers: 1,
          fileParallelism: false,
          retry: 0,
          testTimeout: 600_000,
          hookTimeout: 120_000,
          teardownTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'split-upgrade',
          include: [
            'test/integration/split-upgrade/client-reload.vitest.ts',
            'test/integration/split-upgrade/reload-target-source.vitest.ts',
            'test/integration/split-upgrade/cross-build-compatibility.vitest.ts',
          ],
          environment: 'node',
          pool: 'forks',
          maxWorkers: 2,
          fileParallelism: true,
          retry: 0,
          testTimeout: 600_000,
          hookTimeout: 120_000,
          teardownTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'split-upgrade-systemd',
          include: ['test/integration/split-upgrade/managed-daemon-systemd.vitest.ts'],
          environment: 'node',
          pool: 'forks',
          maxWorkers: 1,
          fileParallelism: false,
          retry: 0,
          testTimeout: 600_000,
          hookTimeout: 120_000,
          teardownTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'split-upgrade-launchd',
          include: ['test/integration/split-upgrade/managed-daemon-launchd.vitest.ts'],
          environment: 'node',
          pool: 'forks',
          maxWorkers: 1,
          fileParallelism: false,
          retry: 0,
          testTimeout: 600_000,
          hookTimeout: 120_000,
          teardownTimeout: 60_000,
        },
      },
    ],
    reporters: ['default'],
    globals: false,
    watch: false,
    snapshotOptions: { updateSnapshot: 'none' },
  },
})
