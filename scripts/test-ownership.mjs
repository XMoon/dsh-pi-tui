#!/usr/bin/env node
/**
 * The test-tree OWNERSHIP MAP: which production owner each test file
 * belongs to, and therefore which `test/<owner>/` directory it moves into.
 *
 * The map is the PLAN's classification, applied to the REAL current tree.
 * Every entry names ONE production owner (the layer whose contract the test
 * primarily proves); a test that spans several layers is filed under the
 * layer that owns the COMPOSITION it exercises.
 *
 * The map is data, not code: the migration driver reads it, and the
 * discovery guard can assert that no test file sits outside its owner
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
 * The test files that own their OWNER directly: the file's PRIMARY
 * production contract is the named area, and the file moves into that
 * area's directory.
 *
 * A file that is NOT listed here stays where it is until its group is
 * migrated: the migration is done group by group, and each group is
 * independently reviewable and revertable.
 */
export const OWNERSHIP_GROUPS = {
  // ── Group 1: the tooling and the static architecture guards ──────────────
  // These prove the DEVELOPMENT TOOLING itself and the STATIC ownership
  // rules over `src/**`. They are the tooling lane's own content, and they
  // must be runnable without the product suite.
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
}

/**
 * The target path of every file in every group: the same basename under the
 * owner's directory.
 */
export function ownershipMoves(groups = OWNERSHIP_GROUPS) {
  const moves = {}
  for (const [owner, files] of Object.entries(groups)) {
    for (const file of files) {
      if (file in moves) throw new Error(`${file} is claimed by two owners`)
      moves[file] = `test/${owner}/${file.slice('test/'.length)}`
    }
  }
  return moves
}
