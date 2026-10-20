#!/usr/bin/env node
/**
 * The test LANES: which patterns each verification lane owns.
 *
 * A lane is a PATTERN SET, not a hand-maintained path list. The discovery
 * rule (`scripts/test-discovery.mjs`) resolves the patterns into the
 * explicit, sorted file list the runner executes, so:
 *
 *   - a test that moves into an ownership directory keeps being discovered;
 *   - a lane that matches nothing FAILS CLOSED instead of reporting green;
 *   - the product and tooling lanes cannot silently overlap.
 *
 * The lane SPLIT is a contract:
 *
 *   - `product` — the tests of the PRODUCT's own behaviour (the bundle, the
 *     TUI, the application, the adapters, the package). It is the suite the
 *     packaging safety gate (`prepack`) runs.
 *   - `tooling` — the tests of the DEVELOPMENT AND RELEASE TOOLING itself
 *     (the scripts, the CI context, the static ownership gates). It is kept
 *     OUT of the packaging lifecycle so the artifact never depends on the
 *     developer git/CI environment.
 *   - `docs` — the tmux terminal-tooling tests (the historical `test:docs`
 *     name; the lane never tested `docs/**`).
 *
 * @module @xmoon76/dsh-pi-tui/scripts/test-lanes
 */

/**
 * The product lane owns every test that is not the tooling lane, the docs
 * lane, or the infrastructure directories — TypeScript AND the plain-JavaScript
 * package-qualification test.
 */
const PRODUCT_EXCLUDED = ['tooling/**', 'architecture/**', 'tmux/**']

export const LANES = {
  product: {
    description: 'the product behaviour suite (the packaging safety gate)',
    patterns: ['**/*.test.ts', '**/*.test.mjs'],
    suffixes: ['.test.ts', '.test.mjs'],
    exclude: PRODUCT_EXCLUDED,
  },
  tooling: {
    description: 'the development and release tooling suite',
    patterns: ['tooling/**', 'architecture/**'],
    suffixes: ['.test.mjs', '.test.ts'],
  },
  docs: {
    description: 'the tmux terminal-tooling suite',
    patterns: ['tmux/**'],
    suffixes: ['.test.mjs'],
  },
}
