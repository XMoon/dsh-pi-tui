#!/usr/bin/env node
/**
 * The test-tree OWNERSHIP MAP: which production owner each test file
 * belongs to, and therefore which `test/<owner>/` directory it lives in.
 *
 * The map is the PLAN's classification, applied to the REAL current tree.
 * Every entry names ONE production owner (the layer whose contract the test
 * primarily proves); a test that spans several layers is filed under the
 * layer that owns the COMPOSITION it exercises.
 *
 * The map is DATA, not code: the migration driver reads it, and the
 * discovery guard asserts that no test file sits outside its owner
 * directory.
 *
 * @module @xmoon76/dsh-pi-tui/scripts/test-ownership
 */

/**
 * The production ownership directories under `test/`, and what each one
 * owns. The keys are the directory names; the values are the contract each
 * directory's tests prove.
 */
export const OWNERSHIP_DIRECTORIES = {
  app: 'application lifecycle, submission, session/currentness, command authority',
  architecture: 'AST / static ownership / no-new-debt guards',
  client: 'Client-local capability',
  domain: 'UI-neutral policy, fold, projection',
  extension: 'public extension semantics',
  integration: 'cross-owner real composition, wire, release-package qualification',
  runtime: 'Direct / Remote / parity adapter contracts',
  tooling: 'the development and release tooling itself',
  tui: 'terminal interaction and rendering',
}

/**
 * The test files that already live in their owner directory.
 *
 * The map records the CURRENT location of every migrated file, so the
 * migration driver can move the NEXT group without re-deriving the whole
 * inventory, and the guard can assert that every file sits in the
 * directory its owner names.
 */
export const OWNERSHIP_GROUPS = {
  // ── The development and release tooling itself ──────────────────────────
  // These prove the tooling: the scripts, the CI context, the packaging
  // lifecycle. They must be runnable without the product suite.
  tooling: [
    'test/tooling/bench-smoke.test.mjs',
    'test/tooling/dev-environment.test.mjs',
    'test/tooling/dev-bootstrap-ephemeral.test.mjs',
    'test/tooling/host-boundary-gates.test.mjs',
    'test/tooling/pre-push-hook.test.mjs',
    'test/tooling/pre-push-stages.test.mjs',
    'test/tooling/dsh-ci-context.test.mjs',
    'test/tooling/dsh-distribution.test.mjs',
    'test/tooling/dsh-npm-verify.test.mjs',
    'test/tooling/dsh-peer-window.test.mjs',
    'test/tooling/dsh-process.test.mjs',
    'test/tooling/dsh-runtime-boundary.test.mjs',
    'test/tooling/dsh-p1-profile-smoke.test.mjs',
    'test/tooling/dsh-source-identity.test.mjs',
    'test/tooling/dsh-source-leak.test.mjs',
    'test/tooling/release-context.test.mjs',
    'test/tooling/release-notes.test.mjs',
    'test/tooling/source-mode-rules.test.mjs',
    'test/tooling/tarball-source-install.test.mjs',
    'test/tooling/pi2dsh-compat-smoke.test.mjs',
    'test/tooling/dsh-preset-parity.test.mjs',
    'test/tooling/retired-source-scan.test.mjs',
    'test/tooling/runtime-hardening-profile.test.mjs',
    'test/tooling/run-with-temp-root.test.mjs',
    'test/tooling/test-discovery.test.mjs',
    'test/tooling/tern-pane-geometry.test.mjs',
    'test/tooling/tern-pane-instrument.test.mjs',
  ],
  // ── The static ownership rules over `src/**` ───────────────────────────
  architecture: [
    'test/architecture/client-boundary-gate.test.mjs',
    'test/architecture/application-architecture-gate.test.mjs',
    'test/architecture/host-keybindings-gate.test.mjs',
    'test/architecture/temp-hygiene-gate.test.mjs',
    'test/architecture/pi-vendor-diff-gate.test.mjs',
    'test/architecture/pi-divergence-ledger-gate.test.mjs',
    'test/architecture/raw-persistence-coupling-gate.test.mjs',
    'test/architecture/a2-ownership-cutover.test.ts',
    'test/architecture/a3-command-identity.test.ts',
    'test/architecture/a3-writer-admission.test.ts',
    'test/architecture/a4-surface-ownership.test.ts',
    'test/architecture/a5-composition-inventory.test.ts',
    'test/architecture/a5b-bootstrap-closure.test.ts',
  ],
  // ── The release-package qualification ───────────────────────────────────
  integration: [
    'test/integration/package/tarball-smoke.test.mjs',
  ],
}

/**
 * The owner of every file the map names: the directory the file lives in.
 */
export function ownershipOf(groups = OWNERSHIP_GROUPS) {
  const owners = {}
  for (const [owner, files] of Object.entries(groups)) {
    for (const file of files) {
      if (file in owners) throw new Error(`${file} is claimed by two owners`)
      owners[file] = owner
    }
  }
  return owners
}

/**
 * The move list for the files the map names that are NOT yet in their
 * owner directory: the source path (test-root relative) mapped to the
 * target path (test-root relative).
 */
export function ownershipMoves(groups = OWNERSHIP_GROUPS) {
  const moves = {}
  for (const [owner, files] of Object.entries(groups)) {
    for (const file of files) {
      if (file in moves) throw new Error(`${file} is claimed by two owners`)
      const target = `test/${owner}/${file.slice('test/'.length)}`
      if (target !== file) moves[file.slice('test/'.length)] = target.slice('test/'.length)
    }
  }
  return moves
}
