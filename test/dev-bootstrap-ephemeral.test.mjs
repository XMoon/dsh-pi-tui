/**
 * Regression tests for the ephemeral source-pack generation lifecycle
 * (Phase F of the /tmp hygiene plan): every ephemeral generation carries an
 * owner marker; a later bootstrap of the SAME worktree reclaims exactly the
 * superseded generation, only after the new state committed — never another
 * worktree's root, never a forged/symlinked path, and never on failure.
 *
 * Coverage map against the plan's §10.4 matrix:
 * - Case A/B timing is covered through the same orchestration seam (the
 *   post-commit reclaim in bootstrapDevelopmentEnvironment): Case D below
 *   proves the success path deletes A, Case B proves a failing source
 *   bootstrap leaves A untouched, and condition 11 (A === active
 *   distribution) is pinned by a direct unit test. Two further end-to-end
 *   regressions pin "pack succeeded, then install / state commit failed":
 *   the uncommitted generation B is discarded while A survives.
 * - Case C (ephemeral -> durable source) flows through the same post-commit
 *   seam with a distributionPath that is never under tmpdir(); its
 *   validation is reclaimableEphemeralRoot's unit matrix.
 * - Cases E/F are covered both as unit rejections and end-to-end.
 * @module @xmoon76/dsh-pi-tui/dev-bootstrap-ephemeral.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapDevelopmentEnvironment, _test as bootstrapTest } from '../scripts/dev-bootstrap.mjs'
import { DEV_STATE_FILE, hashFile, resolveDshDevContext } from '../scripts/dsh-dev-context.mjs'
import { testLifecycle } from './support/temp-lifecycle.ts'

const SHA = 'b'.repeat(40)
const VERSION = '0.1.2-alpha.1'
const REPOSITORY = 'deepseek-ai/deepseek-harness'

// chmod-based failure injection needs POSIX permission enforcement as a
// non-root user; skip where the platform cannot provide it.
const chmodEnforced = process.platform !== 'win32' && process.getuid !== undefined && process.getuid() !== 0

// Git repository-local environment variables must not leak into the fake
// harness checkout's git commands (same hermeticity rule as the other
// dev-environment suites).
const GIT_REPO_LOCAL_ENV = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_PREFIX', 'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_COMMON_DIR',
]
for (const name of GIT_REPO_LOCAL_ENV) delete process.env[name]

function git(cwd, args) {
  const env = { ...process.env }
  for (const name of GIT_REPO_LOCAL_ENV) delete env[name]
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env })
  assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

/** A minimal source-mode workspace whose state file points at a generation. */
function sourceFixture(life) {
  const root = life.tempDir('dsh-ephemeral-fixture-')
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 'ephemeral-fixture', private: true, packageManager: 'pnpm@11.7.0' }, null, 2)}\n`)
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  const config = join(root, 'source.json')
  writeFileSync(config, `${JSON.stringify({ schemaVersion: 1, repository: REPOSITORY, ref: SHA, expectedVersion: VERSION })}\n`)
  const context = resolveDshDevContext({ root, mode: 'source', config, environment: {} })
  return { root, config, context }
}

/** Commit a dev state that references the given ephemeral generation. */
function commitEphemeralState(context, generationRoot) {
  writeFileSync(join(context.root, DEV_STATE_FILE), `${JSON.stringify({
    schemaVersion: 1,
    mode: 'source',
    node: String(process.versions.node.split('.')[0]),
    pnpm: '11.7.0',
    root: context.root,
    packageJsonHash: hashFile(join(context.root, 'package.json')),
    lockfileHash: hashFile(join(context.root, 'pnpm-lock.yaml')),
    repository: REPOSITORY,
    ref: SHA,
    expectedVersion: VERSION,
    distribution: join(generationRoot, 'pack'),
    ephemeral: true,
  })}\n`)
}

/** A fake pnpm that satisfies bootstrap's probes without touching the network. */
function fakePnpm(life) {
  const path = join(life.tempDir('dsh-ephemeral-pnpm-'), 'fake-pnpm.mjs')
  writeFileSync(path, `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.log('11.7.0')
} else {
  process.exit(0)
}
`)
  chmodSync(path, 0o755)
  return path
}

async function withPnpmExecutable(path, run) {
  const previous = process.env.PNPM_EXECUTABLE
  process.env.PNPM_EXECUTABLE = path
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.PNPM_EXECUTABLE
    else process.env.PNPM_EXECUTABLE = previous
  }
}

test('an ephemeral generation carries an owner-only marker identifying this worktree', async (t) => {
  const life = testLifecycle(t)
  const { context } = sourceFixture(life)
  const { root } = bootstrapTest.ephemeralSourcePackRoot(context)
  life.defer(() => rmSync(root, { recursive: true, force: true }))
  assert.ok(basename(root).startsWith(bootstrapTest.EPHEMERAL_ROOT_PREFIX), `root basename must keep the project shape: ${root}`)
  assert.equal(dirname(root), tmpdir(), 'the generation must live directly in the OS temp root')
  const markerPath = join(root, bootstrapTest.EPHEMERAL_MARKER_NAME)
  const info = statSync(markerPath)
  assert.equal(info.isFile(), true, 'the marker must be a regular file')
  assert.equal(info.isSymbolicLink(), false)
  assert.equal(info.mode & 0o777, 0o600, 'the marker must be owner-only')
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
  assert.equal(marker.schemaVersion, 1)
  assert.equal(marker.kind, bootstrapTest.EPHEMERAL_MARKER_KIND)
  assert.equal(marker.workspaceRoot, context.root)
  assert.equal(typeof marker.createdAt, 'string')
  assert.equal(marker.pid, process.pid)
})

test('reclaimableEphemeralRoot accepts the committed previous generation of this worktree', async (t) => {
  const life = testLifecycle(t)
  const { context } = sourceFixture(life)
  const { root: generation } = bootstrapTest.ephemeralSourcePackRoot(context)
  life.defer(() => rmSync(generation, { recursive: true, force: true }))
  commitEphemeralState(context, generation)
  assert.equal(bootstrapTest.reclaimableEphemeralRoot(context), generation)
})

test('reclaimableEphemeralRoot rejects every forged or foreign shape (Case E/F)', async (t) => {
  const life = testLifecycle(t)
  const { context } = sourceFixture(life)
  const scratch = life.tempDir('dsh-ephemeral-reject-')

  const markerOf = (generation, workspaceRoot) => {
    writeFileSync(join(generation, bootstrapTest.EPHEMERAL_MARKER_NAME), `${JSON.stringify({
      schemaVersion: 1,
      kind: bootstrapTest.EPHEMERAL_MARKER_KIND,
      workspaceRoot,
      createdAt: new Date().toISOString(),
      pid: process.pid,
    })}\n`)
  }
  const generationUnder = (parent, name = bootstrapTest.EPHEMERAL_ROOT_PREFIX + 'forge1') => {
    mkdirSync(parent, { recursive: true })
    const generation = join(parent, name)
    mkdirSync(generation)
    return generation
  }

  // No state at all.
  assert.equal(bootstrapTest.reclaimableEphemeralRoot(context), undefined)

  // npm-mode / non-ephemeral / non-absolute / wrong basename states.
  commitEphemeralState(context, join(scratch, bootstrapTest.EPHEMERAL_ROOT_PREFIX + 'x', 'pack'))
  assert.equal(bootstrapTest.reclaimableEphemeralRoot(context), undefined, 'distribution outside tmpdir must be rejected')
  const nested = generationUnder(join(scratch, 'nested'))
  markerOf(nested, context.root)
  const state = JSON.parse(readFileSync(join(context.root, DEV_STATE_FILE), 'utf8'))
  state.distribution = join(nested, 'pack')
  writeFileSync(join(context.root, DEV_STATE_FILE), `${JSON.stringify(state)}\n`)
  assert.equal(bootstrapTest.reclaimableEphemeralRoot(context), undefined, 'a generation not directly inside tmpdir must be rejected')
  state.distribution = join(tmpdir(), 'not-our-prefix-x', 'pack')
  writeFileSync(join(context.root, DEV_STATE_FILE), `${JSON.stringify(state)}\n`)
  assert.equal(bootstrapTest.reclaimableEphemeralRoot(context), undefined, 'wrong basename prefix must be rejected')
  state.mode = 'npm'
  writeFileSync(join(context.root, DEV_STATE_FILE), `${JSON.stringify(state)}\n`)
  assert.equal(bootstrapTest.reclaimableEphemeralRoot(context), undefined, 'npm state must be rejected')
  state.mode = 'source'
  state.ephemeral = false
  writeFileSync(join(context.root, DEV_STATE_FILE), `${JSON.stringify(state)}\n`)
  assert.equal(bootstrapTest.reclaimableEphemeralRoot(context), undefined, 'non-ephemeral state must be rejected')

  // Real tmpdir generation, but forged root / marker / ownership.
  const { root: foreign } = bootstrapTest.ephemeralSourcePackRoot(context)
  life.defer(() => rmSync(foreign, { recursive: true, force: true }))
  state.ephemeral = true
  state.distribution = join(foreign, 'pack')
  writeFileSync(join(context.root, DEV_STATE_FILE), `${JSON.stringify(state)}\n`)

  const markerPath = join(foreign, bootstrapTest.EPHEMERAL_MARKER_NAME)
  const originalMarker = readFileSync(markerPath, 'utf8')
  const rewriteMarker = (mutate) => {
    const marker = JSON.parse(originalMarker)
    mutate(marker)
    writeFileSync(markerPath, `${JSON.stringify(marker)}\n`)
  }
  rewriteMarker(marker => { marker.workspaceRoot = '/other/worktree' })
  assert.equal(bootstrapTest.reclaimableEphemeralRoot(context), undefined, 'another worktree marker must be rejected (Case E)')
  rewriteMarker(marker => { marker.kind = 'something-else' })
  assert.equal(bootstrapTest.reclaimableEphemeralRoot(context), undefined, 'wrong marker kind must be rejected')
  rewriteMarker(marker => { marker.schemaVersion = 99 })
  assert.equal(bootstrapTest.reclaimableEphemeralRoot(context), undefined, 'wrong marker schema must be rejected')
  rmSync(markerPath)
  assert.equal(bootstrapTest.reclaimableEphemeralRoot(context), undefined, 'missing marker must be rejected')
  writeFileSync(markerPath, 'not json')
  assert.equal(bootstrapTest.reclaimableEphemeralRoot(context), undefined, 'invalid marker JSON must be rejected')
  writeFileSync(markerPath, originalMarker)
  chmodSync(markerPath, 0o600)
  assert.equal(bootstrapTest.reclaimableEphemeralRoot(context), foreign, 'restored marker must be accepted again')

  // Forged mode and hardlinked marker are not acceptable ownership proof.
  chmodSync(markerPath, 0o644)
  assert.equal(bootstrapTest.reclaimableEphemeralRoot(context), undefined, 'a non-owner-only marker mode must be rejected')
  chmodSync(markerPath, 0o600)
  assert.equal(bootstrapTest.reclaimableEphemeralRoot(context), foreign, 'the restored owner-only mode must be accepted again')
  const hardlink = join(scratch, 'marker-hardlink')
  linkSync(markerPath, hardlink)
  assert.equal(bootstrapTest.reclaimableEphemeralRoot(context), undefined, 'a hardlinked marker must be rejected')
  rmSync(hardlink)
  assert.equal(bootstrapTest.reclaimableEphemeralRoot(context), foreign, 'a single-link marker must be accepted again')

  // Symlinked marker and symlinked candidate root.
  rmSync(markerPath)
  symlinkSync(join(scratch, 'decoy-marker'), markerPath, 'file')
  assert.equal(bootstrapTest.reclaimableEphemeralRoot(context), undefined, 'symlinked marker must be rejected')
  rmSync(markerPath)
  writeFileSync(markerPath, originalMarker)

  const viaLink = join(scratch, 'linked-generation')
  symlinkSync(foreign, viaLink, 'dir')
  const linkedState = { ...state, distribution: join(viaLink, 'pack') }
  writeFileSync(join(context.root, DEV_STATE_FILE), `${JSON.stringify(linkedState)}\n`)
  assert.equal(bootstrapTest.reclaimableEphemeralRoot(context), undefined, 'symlinked candidate root must be rejected')
})

function scratchDir(life) {
  const dir = join(life.tempDir('dsh-ephemeral-active-'), 'g')
  mkdirSync(dir)
  return dir
}

test('reclaimEphemeralRoot never removes the generation the new state still points at (condition 11)', async (t) => {
  const life = testLifecycle(t)
  const { context } = sourceFixture(life)
  const { root: generation } = bootstrapTest.ephemeralSourcePackRoot(context)
  life.defer(() => rmSync(generation, { recursive: true, force: true }))
  bootstrapTest.reclaimEphemeralRoot(generation, join(generation, 'pack'))
  assert.equal(existsSync(generation), true, 'the active generation must survive')
  bootstrapTest.reclaimEphemeralRoot(generation, join(scratchDir(life), 'pack'))
  assert.equal(existsSync(generation), false, 'a superseded generation must be removed')
})

test('Case D: a successful npm bootstrap reclaims the previous ephemeral generation', async (t) => {
  const life = testLifecycle(t)
  const { root, context } = sourceFixture(life)
  const { root: generation } = bootstrapTest.ephemeralSourcePackRoot(context)
  commitEphemeralState(context, generation)
  const pnpm = fakePnpm(life)
  await withPnpmExecutable(pnpm, () => bootstrapDevelopmentEnvironment({ root, mode: 'npm', environment: {} }))
  assert.equal(existsSync(generation), false, 'the superseded ephemeral generation must be reclaimed after commit')
  const state = JSON.parse(readFileSync(join(root, DEV_STATE_FILE), 'utf8'))
  assert.equal(state.mode, 'npm', 'the new state must be committed as npm mode')
})

test('Case E end-to-end: another worktree generation survives a successful bootstrap', async (t) => {
  const life = testLifecycle(t)
  const { root, context } = sourceFixture(life)
  const { root: generation } = bootstrapTest.ephemeralSourcePackRoot(context)
  const markerPath = join(generation, bootstrapTest.EPHEMERAL_MARKER_NAME)
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
  marker.workspaceRoot = '/other/worktree'
  writeFileSync(markerPath, `${JSON.stringify(marker)}\n`)
  commitEphemeralState(context, generation)
  const pnpm = fakePnpm(life)
  await withPnpmExecutable(pnpm, () => bootstrapDevelopmentEnvironment({ root, mode: 'npm', environment: {} }))
  assert.equal(existsSync(generation), true, 'a foreign worktree generation must never be reclaimed')
  rmSync(generation, { recursive: true, force: true })
})

test('Case B: a failing source bootstrap leaves the previous generation and state untouched', async (t) => {
  const life = testLifecycle(t)
  const { root, config, context } = sourceFixture(life)
  const { root: generation } = bootstrapTest.ephemeralSourcePackRoot(context)
  commitEphemeralState(context, generation)
  const stateBefore = readFileSync(join(root, DEV_STATE_FILE), 'utf8')
  // The fixture carries no scripts/lib/dsh-distribution.mjs, so the source
  // bootstrap fails mid-flight — exactly the "new generation fails before
  // the state commits" scenario.
  await assert.rejects(
    () => bootstrapDevelopmentEnvironment({ root, mode: 'source', config, environment: {} }),
    /no source distribution helper/u,
  )
  assert.equal(existsSync(generation), true, 'the previous generation must stay usable after a failed bootstrap')
  assert.equal(readFileSync(join(root, DEV_STATE_FILE), 'utf8'), stateBefore, 'the committed state must not be switched on failure')
  rmSync(generation, { recursive: true, force: true })
})

test('a state commit failure rolls the environment back and never reclaims the previous generation', async (t) => {
  const life = testLifecycle(t)
  const { root, context } = sourceFixture(life)
  const { root: generation } = bootstrapTest.ephemeralSourcePackRoot(context)
  commitEphemeralState(context, generation)
  const stateBefore = readFileSync(join(root, DEV_STATE_FILE), 'utf8')
  // A previous, still-sourced environment file for this worktree.
  writeFileSync(context.envPath, 'OLD-ENV-MARKER\n')
  // Break the state COMMIT (after the env write): the lockfile is required
  // by writeState, so its absence fails exactly the second half of the
  // env+state checkpoint.
  rmSync(join(root, 'pnpm-lock.yaml'))
  const pnpm = fakePnpm(life)
  await assert.rejects(
    () => withPnpmExecutable(pnpm, () => bootstrapDevelopmentEnvironment({ root, mode: 'npm', environment: {} })),
    /cannot write local state/u,
  )
  assert.equal(readFileSync(context.envPath, 'utf8'), 'OLD-ENV-MARKER\n', 'the environment must roll back to the previous generation')
  assert.equal(readFileSync(join(root, DEV_STATE_FILE), 'utf8'), stateBefore, 'the committed state must never be switched on failure')
  assert.equal(existsSync(generation), true, 'the previous generation must never be reclaimed after a failed commit')
  rmSync(generation, { recursive: true, force: true })
})

test('a .envrc shim creation failure aborts the commit before the env file is touched', { skip: !chmodEnforced && 'chmod permission enforcement unavailable' }, async (t) => {
  const life = testLifecycle(t)
  const { context } = sourceFixture(life)
  writeFileSync(context.envPath, 'OLD-ENV-MARKER\n')
  const envrcPath = join(context.root, '.envrc')
  assert.equal(existsSync(envrcPath), false, 'fixture starts without .envrc')
  // The shim is created FIRST: when its (atomic) write fails, nothing else
  // has been modified yet, so the failed commit must leave both the env
  // file and the .envrc state exactly as they were.
  chmodSync(context.root, 0o500)
  try {
    await assert.rejects(
      async () => bootstrapTest.commitDevelopmentState(
        context,
        () => writeFileSync(context.envPath, 'NEW-ENV-MARKER\n'),
        () => { throw new Error('must not be reached') },
      ),
      /EACCES/u,
    )
  } finally {
    chmodSync(context.root, 0o700)
  }
  assert.equal(readFileSync(context.envPath, 'utf8'), 'OLD-ENV-MARKER\n', 'a failed shim creation must leave the env file untouched')
  assert.equal(existsSync(envrcPath), false, 'no shim may appear when its creation fails')
})

test('commitDevelopmentState removes a previously absent env file on failure', async (t) => {
  const life = testLifecycle(t)
  const { context } = sourceFixture(life)
  const envrcPath = join(context.root, '.envrc')
  assert.equal(existsSync(context.envPath), false, 'fixture starts without an env file')
  assert.equal(existsSync(envrcPath), false, 'fixture starts without .envrc')
  await assert.rejects(
    async () => bootstrapTest.commitDevelopmentState(
      context,
      () => bootstrapTest.writeDevelopmentEnvironmentFile(context, join(context.root, "pack"), { ephemeral: true }),
      () => { throw new Error('state write failed') },
    ),
    /state write failed/u,
  )
  assert.equal(existsSync(context.envPath), false, 'a failed commit must not leave a stray env file behind')
  assert.equal(existsSync(envrcPath), false, 'a shim created by the failed commit must be removed again')
})

test('commitDevelopmentState rollback never follows a swapped-in symlink', async (t) => {
  const life = testLifecycle(t)
  const { context } = sourceFixture(life)
  writeFileSync(context.envPath, 'OLD-ENV-MARKER\n')
  const envrcPath = join(context.root, '.envrc')
  const decoy = join(life.tempDir('dsh-ephemeral-decoy-'), 'decoy-env')
  writeFileSync(decoy, 'DECOY-CONTENT\n')
  // The env writer replaces the file, then the path is swapped to a
  // symlink before the state write fails: rollback must remove the link
  // and restore the previous content as a regular file — never follow it.
  await assert.rejects(
    async () => bootstrapTest.commitDevelopmentState(
      context,
      () => {
        writeFileSync(context.envPath, 'NEW-ENV-MARKER\n')
        rmSync(context.envPath)
        symlinkSync(decoy, context.envPath)
      },
      () => { throw new Error('state write failed') },
    ),
    /state write failed/u,
  )
  assert.equal(statSync(context.envPath).isSymbolicLink(), false, 'the rolled-back env path must be a regular file')
  assert.equal(readFileSync(context.envPath, 'utf8'), 'OLD-ENV-MARKER\n', 'the previous content must be restored')
  assert.equal(readFileSync(decoy, 'utf8'), 'DECOY-CONTENT\n', 'the symlink target must never be touched')
  assert.equal(existsSync(envrcPath), false, 'a shim created by the failed commit must be removed again')
})

test('commitDevelopmentState removes a swapped-in symlink when there was no previous env', async (t) => {
  const life = testLifecycle(t)
  const { context } = sourceFixture(life)
  const envrcPath = join(context.root, '.envrc')
  const decoy = join(life.tempDir('dsh-ephemeral-decoy2-'), 'decoy-env')
  writeFileSync(decoy, 'DECOY-CONTENT\n')
  await assert.rejects(
    async () => bootstrapTest.commitDevelopmentState(
      context,
      () => {
        writeFileSync(context.envPath, 'NEW-ENV-MARKER\n')
        rmSync(context.envPath)
        symlinkSync(decoy, context.envPath)
      },
      () => { throw new Error('state write failed') },
    ),
    /state write failed/u,
  )
  assert.equal(existsSync(context.envPath), false, 'a failed commit with no previous env must leave the path absent')
  assert.equal(readFileSync(decoy, 'utf8'), 'DECOY-CONTENT\n', 'the symlink target must never be touched')
  assert.equal(existsSync(envrcPath), false, 'a shim created by the failed commit must be removed again')
})

test('an initially symlinked env path is never touched when the env write refuses', async (t) => {
  const life = testLifecycle(t)
  const { context } = sourceFixture(life)
  const decoy = join(life.tempDir('dsh-ephemeral-decoy3-'), 'decoy-env')
  writeFileSync(decoy, 'DECOY-CONTENT\n')
  // The env path is a symlink BEFORE the commit starts: the real env
  // writer (writeAtomic) refuses to replace it and throws WITHOUT
  // modifying anything, so the failed commit must leave the user's link
  // exactly as it was — never read through it, never remove it.
  symlinkSync(decoy, context.envPath)
  await assert.rejects(
    async () => bootstrapTest.commitDevelopmentState(
      context,
      () => bootstrapTest.writeDevelopmentEnvironmentFile(context, join(context.root, "pack"), { ephemeral: true }),
      () => { throw new Error('must not be reached') },
    ),
    /refusing to replace symlink/u,
  )
  assert.equal(lstatSync(context.envPath).isSymbolicLink(), true, 'a symlink the commit never replaced must survive')
  assert.equal(readlinkSync(context.envPath), decoy, 'the symlink must keep pointing at the user file')
  assert.equal(readFileSync(decoy, 'utf8'), 'DECOY-CONTENT\n', 'the symlink target must never be read or touched')
})

test('commitDevelopmentState rolls back a newly created .envrc on failure', async (t) => {
  const life = testLifecycle(t)
  const { context } = sourceFixture(life)
  writeFileSync(context.envPath, 'OLD-ENV-MARKER\n')
  const envrcPath = join(context.root, '.envrc')
  assert.equal(existsSync(envrcPath), false, 'fixture starts without .envrc')
  await assert.rejects(
    async () => bootstrapTest.commitDevelopmentState(
      context,
      () => bootstrapTest.writeDevelopmentEnvironmentFile(context, join(context.root, "pack"), { ephemeral: true }),
      () => { throw new Error('state write failed') },
    ),
    /state write failed/u,
  )
  assert.equal(readFileSync(context.envPath, 'utf8'), 'OLD-ENV-MARKER\n', 'the env file must roll back')
  assert.equal(existsSync(envrcPath), false, 'a .envrc created by the failed commit must be removed')
})

test('a pre-existing regular .envrc keeps inode, type, content, and mode through a failed commit', async (t) => {
  const life = testLifecycle(t)
  const { context } = sourceFixture(life)
  writeFileSync(context.envPath, 'OLD-ENV-MARKER\n')
  const envrcPath = join(context.root, '.envrc')
  writeFileSync(envrcPath, 'ORIGINAL-ENVRC\n')
  chmodSync(envrcPath, 0o644)
  const before = statSync(envrcPath)
  // The real writer never modifies an existing .envrc (it only creates the
  // shim when absent); the failed commit must therefore not touch it at
  // all — not its content, not its inode, and especially not its mode.
  await assert.rejects(
    async () => bootstrapTest.commitDevelopmentState(
      context,
      () => bootstrapTest.writeDevelopmentEnvironmentFile(context, join(context.root, 'pack'), { ephemeral: true }),
      () => { throw new Error('state write failed') },
    ),
    /state write failed/u,
  )
  const after = statSync(envrcPath)
  assert.equal(after.ino, before.ino, 'an untouched .envrc must keep its inode')
  assert.equal(after.isFile(), true, 'an untouched .envrc must stay a regular file')
  assert.equal(after.isSymbolicLink(), false)
  assert.equal(after.mode & 0o777, 0o644, 'an untouched .envrc must keep its original mode (no silent 0600 rewrite)')
  assert.equal(readFileSync(envrcPath, 'utf8'), 'ORIGINAL-ENVRC\n', 'an untouched .envrc must keep its content')
  assert.equal(readFileSync(context.envPath, 'utf8'), 'OLD-ENV-MARKER\n', 'the env file must still roll back')
})

test('a pre-existing symlink .envrc survives a failed commit untouched', async (t) => {
  const life = testLifecycle(t)
  const { context } = sourceFixture(life)
  writeFileSync(context.envPath, 'OLD-ENV-MARKER\n')
  const envrcTarget = join(life.tempDir('dsh-ephemeral-envrc-'), 'user-envrc')
  writeFileSync(envrcTarget, 'USER-ENVRC\n')
  const envrcPath = join(context.root, '.envrc')
  symlinkSync(envrcTarget, envrcPath, 'file')
  // A user-managed .envrc symlink: the bootstrap never modifies it, so a
  // failed commit must never delete or replace it.
  await assert.rejects(
    async () => bootstrapTest.commitDevelopmentState(
      context,
      () => bootstrapTest.writeDevelopmentEnvironmentFile(context, join(context.root, 'pack'), { ephemeral: true }),
      () => { throw new Error('state write failed') },
    ),
    /state write failed/u,
  )
  assert.equal(lstatSync(envrcPath).isSymbolicLink(), true, 'the user .envrc symlink must survive')
  assert.equal(readlinkSync(envrcPath), envrcTarget, 'the user .envrc symlink must keep its target')
  assert.equal(readFileSync(envrcPath, 'utf8'), 'USER-ENVRC\n', 'the symlink must still resolve to the user file')
  assert.equal(readFileSync(context.envPath, 'utf8'), 'OLD-ENV-MARKER\n', 'the env file must still roll back')
})

test('a .envrc entry swapped in after shim creation survives rollback', async (t) => {
  const life = testLifecycle(t)
  const { context } = sourceFixture(life)
  writeFileSync(context.envPath, 'OLD-ENV-MARKER\n')
  const envrcPath = join(context.root, '.envrc')
  const decoy = join(life.tempDir('dsh-ephemeral-envrc-swap-'), 'swapped-envrc')
  writeFileSync(decoy, 'SWAPPED-ENVRC\n')
  assert.equal(existsSync(envrcPath), false, 'fixture starts without .envrc')
  // The commit creates its shim, then the path is swapped to the user's
  // symlink before the state write fails: rollback must remove only the
  // file IT created (by inode) and leave the swapped entry alone.
  await assert.rejects(
    async () => bootstrapTest.commitDevelopmentState(
      context,
      () => {
        bootstrapTest.writeDevelopmentEnvironmentFile(context, join(context.root, 'pack'), { ephemeral: true })
        rmSync(envrcPath)
        symlinkSync(decoy, envrcPath, 'file')
      },
      () => { throw new Error('state write failed') },
    ),
    /state write failed/u,
  )
  assert.equal(lstatSync(envrcPath).isSymbolicLink(), true, 'an entry swapped in mid-commit must survive rollback')
  assert.equal(readlinkSync(envrcPath), decoy, 'the swapped symlink must keep its target')
  assert.equal(readFileSync(decoy, 'utf8'), 'SWAPPED-ENVRC\n', 'the swapped target must never be touched')
  assert.equal(readFileSync(context.envPath, 'utf8'), 'OLD-ENV-MARKER\n', 'the env file must still roll back')
})

test('an env snapshot failure after shim creation removes only the shim this commit created', { skip: !chmodEnforced && 'chmod permission enforcement unavailable' }, async (t) => {
  const life = testLifecycle(t)
  const { context } = sourceFixture(life)
  const envrcPath = join(context.root, '.envrc')
  assert.equal(existsSync(envrcPath), false, 'fixture starts without .envrc')
  // An unreadable env file makes the pre-write SNAPSHOT fail after the
  // shim was already created: the failed commit must still remove the
  // shim it created and leave the env file itself untouched.
  writeFileSync(context.envPath, 'SECRET-OLD-ENV\n')
  chmodSync(context.envPath, 0o000)
  try {
    await assert.rejects(
      async () => bootstrapTest.commitDevelopmentState(
        context,
        () => { throw new Error('must not be reached') },
        () => { throw new Error('must not be reached') },
      ),
      /EACCES/u,
    )
  } finally {
    chmodSync(context.envPath, 0o600)
  }
  assert.equal(existsSync(envrcPath), false, 'a shim created before the snapshot failure must be removed')
  assert.equal(readFileSync(context.envPath, 'utf8'), 'SECRET-OLD-ENV\n', 'the unreadable env file must be untouched')
})

test('writeFileExclusively never replaces an existing entry', (t) => {
  const life = testLifecycle(t)
  const parent = life.tempDir('dsh-ephemeral-exclusive-')
  const created = join(parent, 'shim')
  const published = bootstrapTest.writeFileExclusively(created, 'CONTENT-1\n')
  assert.equal(published.created, true, 'an absent path is created')
  assert.notEqual(published.identity, undefined, 'creation pins the inode identity')
  assert.equal(readFileSync(created, 'utf8'), 'CONTENT-1\n')
  assert.equal(statSync(created).mode & 0o777, 0o600, 'the exclusive create keeps the owner-only mode')
  assert.equal(statSync(created).ino, published.identity.ino, 'the pinned identity is the published inode')
  const before = statSync(created)
  assert.equal(bootstrapTest.writeFileExclusively(created, 'CONTENT-2\n').created, false, 'an existing regular file is never replaced')
  assert.equal(readFileSync(created, 'utf8'), 'CONTENT-1\n', 'the existing content must survive')
  assert.equal(statSync(created).ino, before.ino, 'the existing inode must survive')
  const linked = join(parent, 'link-shim')
  symlinkSync(created, linked, 'file')
  assert.equal(bootstrapTest.writeFileExclusively(linked, 'CONTENT-3\n').created, false, 'an existing symlink is never replaced')
  assert.equal(lstatSync(linked).isSymbolicLink(), true, 'the symlink must survive')
  assert.equal(readdirSync(parent).filter(name => name.includes('.tmp')).length, 0, 'no publish temporary may be left behind')
})

test('ownership comparison is canonical: a symlinked worktree path still matches its own marker', async (t) => {
  const life = testLifecycle(t)
  const { root, context } = sourceFixture(life)
  const link = join(life.tempDir('dsh-ephemeral-link-'), 'worktree-link')
  symlinkSync(root, link, 'dir')
  const linkedContext = resolveDshDevContext({ root: link, mode: 'source', config: join(link, 'source.json'), environment: {} })
  const { root: generation } = bootstrapTest.ephemeralSourcePackRoot(linkedContext)
  commitEphemeralState(linkedContext, generation)
  assert.equal(bootstrapTest.reclaimableEphemeralRoot(linkedContext), generation, 'the canonical root must match through the symlink')
  rmSync(generation, { recursive: true, force: true })
})

test('rollback never recursively deletes a directory sitting at the env path', async (t) => {
  const life = testLifecycle(t)
  const { context } = sourceFixture(life)
  // A pre-existing DIRECTORY at the env path: the snapshot records it as
  // unsafe, and a failed commit must NOT delete it or its contents.
  mkdirSync(context.envPath, { recursive: true })
  writeFileSync(join(context.envPath, 'precious.txt'), 'keep me')
  await assert.rejects(
    async () => bootstrapTest.commitDevelopmentState(
      context,
      () => { throw new Error('env write refused') },
      () => { throw new Error('must not be reached') },
    ),
    /env write refused/u,
  )
  assert.equal(existsSync(join(context.envPath, 'precious.txt')), true, 'the directory contents must survive rollback')
  assert.equal(readFileSync(join(context.envPath, 'precious.txt'), 'utf8'), 'keep me')
})

test('rollback never recursively deletes a directory sitting at the .envrc path', async (t) => {
  const life = testLifecycle(t)
  const { context } = sourceFixture(life)
  writeFileSync(context.envPath, 'OLD-ENV-MARKER\n')
  const envrcPath = join(context.root, '.envrc')
  mkdirSync(envrcPath, { recursive: true })
  writeFileSync(join(envrcPath, 'precious.txt'), 'keep me')
  await assert.rejects(
    async () => bootstrapTest.commitDevelopmentState(
      context,
      () => { throw new Error('env write refused') },
      () => { throw new Error('must not be reached') },
    ),
    /env write refused/u,
  )
  assert.equal(existsSync(join(envrcPath, 'precious.txt')), true, 'the .envrc directory contents must survive rollback')
  assert.equal(readFileSync(context.envPath, 'utf8'), 'OLD-ENV-MARKER\n', 'the env file must still roll back')
})

test('rollback fails closed when the env path is swapped to a directory mid-commit', async (t) => {
  const life = testLifecycle(t)
  const { context } = sourceFixture(life)
  writeFileSync(context.envPath, 'OLD-ENV-MARKER\n')
  const envrcPath = join(context.root, '.envrc')
  assert.equal(existsSync(envrcPath), false, 'fixture starts without .envrc')
  const swapped = join(life.tempDir('dsh-ephemeral-swap-'), 'swapped-dir')
  await assert.rejects(
    async () => bootstrapTest.commitDevelopmentState(
      context,
      () => {
        writeFileSync(context.envPath, 'NEW-ENV-MARKER\n')
        rmSync(context.envPath)
        mkdirSync(swapped)
        symlinkSync(swapped, context.envPath, 'dir')
        rmSync(context.envPath)
        mkdirSync(context.envPath)
        writeFileSync(join(context.envPath, 'precious.txt'), 'keep me')
      },
      () => { throw new Error('state write failed') },
    ),
    /state write failed/u,
  )
  assert.equal(existsSync(join(context.envPath, 'precious.txt')), true, 'a swapped-in directory must never be deleted')
  assert.equal(existsSync(envrcPath), false, 'the fail-closed env rollback must still remove the shim this commit created')
})

test('discardOwnedEphemeralRoot never recursively removes a replaced generation root', async (t) => {
  const life = testLifecycle(t)
  const { context } = sourceFixture(life)
  const scratch = life.tempDir('dsh-ephemeral-discard-')
  const owned = bootstrapTest.ephemeralSourcePackRoot(context)
  const generation = owned.root
  assert.notEqual(owned.markerIdentity, undefined, 'creation pins the marker identity')
  assert.deepEqual(bootstrapTest.ephemeralMarkerIdentity(generation), owned.markerIdentity, 'the fresh marker satisfies the owner contract')

  // The generation root is replaced while the bootstrap is in flight (a
  // different directory now sits at the path, with its own marker file):
  // the identity revalidation must refuse the recursive removal.
  rmSync(generation, { recursive: true, force: true })
  mkdirSync(generation)
  writeFileSync(join(generation, bootstrapTest.EPHEMERAL_MARKER_NAME), `${JSON.stringify({
    schemaVersion: 1,
    kind: bootstrapTest.EPHEMERAL_MARKER_KIND,
    workspaceRoot: context.root,
    createdAt: new Date().toISOString(),
    pid: process.pid,
  })}\n`, { mode: 0o600 })
  writeFileSync(join(generation, 'not-ours.txt'), 'keep me')
  bootstrapTest.discardOwnedEphemeralRoot(owned)
  assert.equal(existsSync(join(generation, 'not-ours.txt')), true, 'a replaced root must never be recursively deleted')

  // The original marker FILE moved into a replacement root keeps its inode
  // (rename), nlink, and mode — the marker identity alone is therefore not
  // proof; the root directory inode must differ and the discard must refuse.
  rmSync(generation, { recursive: true, force: true })
  const stolen = bootstrapTest.ephemeralSourcePackRoot(context)
  const stolenMarker = join(scratch, 'stolen-marker')
  renameSync(join(stolen.root, bootstrapTest.EPHEMERAL_MARKER_NAME), stolenMarker)
  rmSync(stolen.root, { recursive: true, force: true })
  mkdirSync(generation)
  renameSync(stolenMarker, join(generation, bootstrapTest.EPHEMERAL_MARKER_NAME))
  writeFileSync(join(generation, 'also-not-ours.txt'), 'keep me too')
  bootstrapTest.discardOwnedEphemeralRoot({ ...stolen, root: generation })
  assert.equal(existsSync(join(generation, 'also-not-ours.txt')), true, 'a moved marker in a replacement root must never authorize deletion')
  rmSync(generation, { recursive: true, force: true })

  // A hardlinked marker is not acceptable ownership proof either: even the
  // ORIGINAL root loses its provable identity while the extra link exists,
  // so the discard fails closed and leaves the root to OS temp hygiene.
  const shared = bootstrapTest.ephemeralSourcePackRoot(context)
  const hardlink = join(scratch, 'marker-hardlink')
  linkSync(join(shared.root, bootstrapTest.EPHEMERAL_MARKER_NAME), hardlink)
  assert.equal(bootstrapTest.ephemeralMarkerIdentity(shared.root), undefined, 'a hardlinked marker must not prove ownership')
  bootstrapTest.discardOwnedEphemeralRoot(shared)
  assert.equal(existsSync(shared.root), true, 'a root whose marker is hardlinked must survive (fail closed)')
  rmSync(hardlink)

  // The intact generation with matching root and marker identities is
  // discarded.
  const intact = bootstrapTest.ephemeralSourcePackRoot(context)
  bootstrapTest.discardOwnedEphemeralRoot(intact)
  assert.equal(existsSync(intact.root), false, 'an owned, identity-matching root must be discarded')
})

test('removePinnedDirectory removes only the exact directory created by this process', (t) => {
  const life = testLifecycle(t)
  const { context } = sourceFixture(life)
  const owned = bootstrapTest.ephemeralSourcePackRoot(context)
  // A replaced root (a different directory now at the path) is never
  // recursively removed, even with the original identity pinned.
  rmSync(owned.root, { recursive: true, force: true })
  mkdirSync(owned.root)
  writeFileSync(join(owned.root, 'not-ours.txt'), 'keep me')
  bootstrapTest.removePinnedDirectory(owned.root, owned.rootIdentity, 'test root')
  assert.equal(existsSync(join(owned.root, 'not-ours.txt')), true, 'a replaced root must never be recursively removed')
  rmSync(owned.root, { recursive: true, force: true })

  // The intact root with the matching identity is removed recursively.
  const intact = bootstrapTest.ephemeralSourcePackRoot(context)
  writeFileSync(join(intact.root, 'marker-adjacent.txt'), 'inside')
  bootstrapTest.removePinnedDirectory(intact.root, intact.rootIdentity, 'test root')
  assert.equal(existsSync(intact.root), false, 'an owned, identity-matching root must be removed recursively')
})

test('reclaimEphemeralRoot revalidates the ownership contract before removal', async (t) => {
  const life = testLifecycle(t)
  const { context } = sourceFixture(life)
  const { root: generation } = bootstrapTest.ephemeralSourcePackRoot(context)
  commitEphemeralState(context, generation)
  assert.equal(bootstrapTest.reclaimableEphemeralRoot(context), generation)
  // The candidate is replaced between the reclaim decision and the removal
  // (a foreign directory with a foreign marker now sits at the path): with
  // the dev context supplied, the revalidation must refuse the removal.
  rmSync(generation, { recursive: true, force: true })
  mkdirSync(generation)
  writeFileSync(join(generation, 'not-ours.txt'), 'keep me')
  bootstrapTest.reclaimEphemeralRoot(generation, join(scratchDir(life), 'pack'), context)
  assert.equal(existsSync(join(generation, 'not-ours.txt')), true, 'a replaced candidate must never be reclaimed')
  // Without a context the historical two-argument behavior is unchanged
  // (unit-level removal used by the condition-11 test).
  bootstrapTest.reclaimEphemeralRoot(generation, join(scratchDir(life), 'pack'))
  assert.equal(existsSync(generation), false, 'the two-argument form keeps removing the candidate')
})

test('reclaimEphemeralRoot validation failures are non-fatal', { skip: !chmodEnforced && 'chmod permission enforcement unavailable' }, async (t) => {
  const life = testLifecycle(t)
  const { context } = sourceFixture(life)
  const { root: generation } = bootstrapTest.ephemeralSourcePackRoot(context)
  commitEphemeralState(context, generation)
  // An unreadable generation root makes the ownership revalidation throw
  // EACCES: the reclaim must warn and return — never throw — so a
  // successful bootstrap is not turned into a failure by its cleanup.
  chmodSync(generation, 0o000)
  try {
    assert.doesNotThrow(() => bootstrapTest.reclaimEphemeralRoot(generation, join(scratchDir(life), 'pack'), context))
  } finally {
    chmodSync(generation, 0o700)
  }
  assert.equal(existsSync(generation), true, 'an unverifiable candidate must survive (fail closed)')
})

test('discardOwnedEphemeralRoot validation failures are non-fatal', { skip: !chmodEnforced && 'chmod permission enforcement unavailable' }, async (t) => {
  const life = testLifecycle(t)
  const { context } = sourceFixture(life)
  const owned = bootstrapTest.ephemeralSourcePackRoot(context)
  // An unreadable generation root makes the identity revalidation throw
  // EACCES: the discard must warn and return — never throw — so the
  // original bootstrap error is preserved.
  chmodSync(owned.root, 0o000)
  try {
    assert.doesNotThrow(() => bootstrapTest.discardOwnedEphemeralRoot(owned))
  } finally {
    chmodSync(owned.root, 0o700)
  }
  assert.equal(existsSync(owned.root), true, 'an unverifiable root must survive (fail closed)')
})

test('commitDevelopmentState keeps the new env on success', async (t) => {
  const life = testLifecycle(t)
  const { context } = sourceFixture(life)
  writeFileSync(context.envPath, 'OLD-ENV-MARKER\n')
  await bootstrapTest.commitDevelopmentState(
    context,
    () => writeFileSync(context.envPath, 'NEW-ENV-MARKER\n'),
    () => {},
  )
  assert.equal(readFileSync(context.envPath, 'utf8'), 'NEW-ENV-MARKER\n')
})

// ── Case A: source-mode ephemeral -> ephemeral (end-to-end) ────────────────

/** A fake pnpm that drives the REAL source-pack + prepare scripts hermetically.
 * The fake shells out to the host `tar` to build the pack tarballs — the
 * same host-tool dependence the existing dev-environment / dsh-source-identity
 * suites already rely on (POSIX-only dev tooling; source mode is unsupported
 * on Windows by dev-bootstrap itself).
 */
function fakePackPnpm(life) {
  const path = join(life.tempDir('dsh-ephemeral-pnpm-'), 'fake-pnpm.mjs')
  writeFileSync(path, `#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
const args = process.argv.slice(2)
if (args.includes('--version')) {
  console.log('11.7.0')
  process.exit(0)
}
if (args.includes('release:pack')) {
  const output = args[args.indexOf('--out') + 1]
  if (output === undefined) process.exit(2)
  mkdirSync(output, { recursive: true })
  for (const name of JSON.parse(process.env.DSH_FAKE_PACKAGES)) {
    const temporary = mkdtempSync(join(dirname(output), '.dsh-source-pack-fixture-'))
    const packageDirectory = join(temporary, 'package')
    mkdirSync(packageDirectory, { recursive: true })
    writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({ name, version: process.env.DSH_FAKE_VERSION }))
    const fileName = name.replace(/^@/u, '').replaceAll('/', '-') + '.tgz'
    const packed = spawnSync('tar', ['-czf', join(output, fileName), '-C', temporary, 'package'], { encoding: 'utf8' })
    rmSync(temporary, { recursive: true, force: true })
    if (packed.status !== 0) process.exit(packed.status ?? 1)
  }
  writeFileSync(join(output, 'publish-order.txt'), 'fixture\\n')
  process.exit(0)
}
if (args.includes('install')) {
  // Materialize the distribution's packages the way pnpm would: a symlinked
  // package inside the .pnpm virtual store with an @file+ entry, so
  // assertSourceResolution accepts the install.
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  // The pack script's install runs in the harness checkout (no deps): keep
  // it untouched so the source identity stays clean. Only the prepare
  // script's install (temporary package.json with file: deps) materializes.
  if (Object.keys(deps).length === 0) process.exit(0)
  // Failure injection for the "pack succeeded, then the install failed"
  // regression: the prepare script's install runs in the worktree with
  // non-empty file: dependencies.
  if (process.env.DSH_FAKE_FAIL_INSTALL === '1') process.exit(9)
  for (const name of Object.keys(deps)) {
    const packageDirectory = join(process.cwd(), 'node_modules', '.pnpm', name.replaceAll('/', '+') + '@file+distribution+dsh.tgz', 'node_modules', ...name.split('/'))
    mkdirSync(packageDirectory, { recursive: true })
    writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({ name, version: process.env.DSH_FAKE_VERSION }))
    const link = join(process.cwd(), 'node_modules', ...name.split('/'))
    mkdirSync(dirname(link), { recursive: true })
    rmSync(link, { force: true })
    symlinkSync(packageDirectory, link, 'dir')
  }
  mkdirSync(join(process.cwd(), 'node_modules', '.pnpm'), { recursive: true })
  writeFileSync(join(process.cwd(), 'node_modules', '.pnpm', 'lock.yaml'), "lockfileVersion: '9.0'\\n")
  process.exit(0)
}
process.exit(0)
`)
  chmodSync(path, 0o755)
  return path
}

/**
 * A hermetic source-mode workspace: the REAL distribution scripts copied
 * into the fixture (they are self-contained .mjs files), a fake Harness
 * checkout (a real git repo with the expected remote), and a source config
 * pinned to the checkout HEAD. Building the checkout uses the host `git` —
 * the same dependence as the existing dev-environment / dsh-source-identity
 * suites; dev-bootstrap source mode is POSIX-only anyway.
 */
function sourceBootstrapFixture(life) {
  const root = life.tempDir('dsh-ephemeral-casea-')
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 'ephemeral-casea-fixture', private: true, packageManager: 'pnpm@11.7.0' }, null, 2)}\n`)
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n- packages/*\n')
  mkdirSync(join(root, 'test', 'compat'), { recursive: true })
  writeFileSync(join(root, 'test', 'compat', 'pi2dsh.json'), `${JSON.stringify({ issue: 26, consumer: 'pi2dsh', pi2dshVersion: '0.24.0', dshVersion: VERSION, contracts: [] }, null, 2)}\n`)
  const scriptsDir = fileURLToPath(new URL('../scripts', import.meta.url))
  cpSync(scriptsDir, join(root, 'scripts'), { recursive: true })

  const harness = life.tempDir('dsh-ephemeral-harness-')
  mkdirSync(join(harness, 'apps', 'cli'), { recursive: true })
  writeFileSync(join(harness, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh-root', version: VERSION, private: true }, null, 2)}\n`)
  writeFileSync(join(harness, 'apps', 'cli', 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh', version: VERSION }, null, 2)}\n`)
  git(harness, ['init', '-q'])
  git(harness, ['config', 'user.email', 'test@example.invalid'])
  git(harness, ['config', 'user.name', 'Test'])
  git(harness, ['add', '.'])
  git(harness, ['commit', '-qm', 'fixture'])
  git(harness, ['remote', 'add', 'origin', 'https://github.com/deepseek-ai/deepseek-harness.git'])
  const ref = git(harness, ['rev-parse', 'HEAD'])

  const config = join(root, 'source.json')
  writeFileSync(config, `${JSON.stringify({ schemaVersion: 1, repository: REPOSITORY, ref, expectedVersion: VERSION })}\n`)
  const context = resolveDshDevContext({ root, mode: 'source', config, environment: { XDG_CACHE_HOME: join(root, 'cache') } })
  return { root, config, context, harness }
}

/**
 * Every ephemeral generation root currently living directly in the OS temp
 * root (the exact leak surface of the P1 regressions below).
 */
function ephemeralRootsInTmpdir() {
  return readdirSync(tmpdir(), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith(bootstrapTest.EPHEMERAL_ROOT_PREFIX))
    .map(entry => join(tmpdir(), entry.name))
    .sort()
}

/** Run a hermetic source bootstrap; extraEnv injects failure switches. */
function sourceBootstrapRunner(life, { root, config, harness }) {
  const pnpm = fakePackPnpm(life)
  return (extraEnv = {}) => withPnpmExecutable(pnpm, async () => {
    const saved = {}
    const setEnv = (name, value) => {
      saved[name] = process.env[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    setEnv('DSH_FAKE_PACKAGES', JSON.stringify(['@deepseek-ai/dsh']))
    setEnv('DSH_FAKE_VERSION', VERSION)
    for (const [name, value] of Object.entries(extraEnv)) setEnv(name, value)
    try {
      return await bootstrapDevelopmentEnvironment({
        root,
        mode: 'source',
        config,
        'dsh-dir': harness,
        environment: { XDG_CACHE_HOME: join(root, 'cache') },
      })
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
}

test('Case A: a successful source-mode bootstrap reclaims the previous ephemeral generation', { skip: process.platform === 'win32' }, async (t) => {
  const life = testLifecycle(t)
  const { root, config, context, harness } = sourceBootstrapFixture(life)
  const runBootstrap = sourceBootstrapRunner(life, { root, config, harness })

  const first = await runBootstrap()
  const generationA = dirname(first.distributionPath)
  assert.ok(basename(generationA).startsWith(bootstrapTest.EPHEMERAL_ROOT_PREFIX), `A must be an ephemeral generation: ${generationA}`)
  assert.equal(existsSync(generationA), true, 'A must exist after the first bootstrap')

  const second = await runBootstrap()
  const generationB = dirname(second.distributionPath)
  assert.notEqual(generationA, generationB, 'B must be a fresh generation')
  assert.equal(existsSync(generationA), false, 'the superseded generation A must be reclaimed after B commits')
  assert.equal(existsSync(generationB), true, 'the new generation B must remain')

  const state = JSON.parse(readFileSync(join(root, DEV_STATE_FILE), 'utf8'))
  assert.equal(state.distribution, second.distributionPath, 'the committed state must point at B')
  assert.equal(state.ephemeral, true, 'the committed state must stay ephemeral')
  const env = readFileSync(context.envPath, 'utf8')
  assert.ok(env.includes(second.distributionPath), 'the env must point at B')
})

test('pack success then a materialization failure discards the uncommitted generation (A survives)', { skip: process.platform === 'win32' }, async (t) => {
  const life = testLifecycle(t)
  const { root, config, harness } = sourceBootstrapFixture(life)
  const runBootstrap = sourceBootstrapRunner(life, { root, config, harness })

  const first = await runBootstrap()
  const generationA = dirname(first.distributionPath)
  const stateAfterFirst = readFileSync(join(root, DEV_STATE_FILE), 'utf8')

  // The second bootstrap builds a fresh pack B successfully, then the
  // worktree install fails: B was never committed, so it must be discarded
  // by the same run instead of leaking into the OS temp root.
  const before = ephemeralRootsInTmpdir()
  await assert.rejects(
    () => runBootstrap({ DSH_FAKE_FAIL_INSTALL: '1' }),
    /materialize DSH source distribution/u,
  )
  assert.equal(existsSync(generationA), true, 'the committed generation A must survive the failed bootstrap')
  const leaked = ephemeralRootsInTmpdir().filter(path => !before.includes(path))
  assert.deepEqual(leaked, [], 'the uncommitted generation B must be discarded, not leaked')
  assert.equal(readFileSync(join(root, DEV_STATE_FILE), 'utf8'), stateAfterFirst, 'the committed state must still point at A')
})

test('pack success then a state commit failure discards the uncommitted generation (A survives)', { skip: process.platform === 'win32' }, async (t) => {
  const life = testLifecycle(t)
  const { root, config, context, harness } = sourceBootstrapFixture(life)
  const runBootstrap = sourceBootstrapRunner(life, { root, config, harness })

  const first = await runBootstrap()
  const generationA = dirname(first.distributionPath)
  const stateAfterFirst = readFileSync(join(root, DEV_STATE_FILE), 'utf8')

  // Fail exactly the second half of the env+state checkpoint: writeState()
  // requires pnpm-lock.yaml, so its absence fails the commit after the pack
  // and the install both succeeded (source installs run --lockfile=false,
  // so nothing earlier needs the file).
  rmSync(join(root, 'pnpm-lock.yaml'))
  const before = ephemeralRootsInTmpdir()
  await assert.rejects(
    () => runBootstrap(),
    /cannot write local state/u,
  )
  assert.equal(existsSync(generationA), true, 'the committed generation A must survive the failed commit')
  const leaked = ephemeralRootsInTmpdir().filter(path => !before.includes(path))
  assert.deepEqual(leaked, [], 'the uncommitted generation B must be discarded, not leaked')
  assert.equal(readFileSync(join(root, DEV_STATE_FILE), 'utf8'), stateAfterFirst, 'the committed state must still point at A')
  assert.ok(readFileSync(context.envPath, 'utf8').includes(generationA), 'the rolled-back env must still point at A')
})

test('a stale shell recovers to the committed ephemeral generation instead of the canonical cache', { skip: process.platform === 'win32' }, async (t) => {
  const life = testLifecycle(t)
  const { root, config, harness } = sourceBootstrapFixture(life)
  const pnpm = fakePackPnpm(life)
  const runBootstrap = sourceBootstrapRunner(life, { root, config, harness })

  const first = await runBootstrap()
  const generationA = dirname(first.distributionPath)
  const second = await runBootstrap()
  const generationB = dirname(second.distributionPath)
  assert.equal(existsSync(generationA), false, 'A must be reclaimed after B commits')

  // A long-lived shell still exports the reclaimed generation A: its next
  // bootstrap must recover to the committed generation B — not hard-load A,
  // not switch to the canonical cache (which would reclaim the working B).
  const staleShell = {
    DSH_DEV_ROOT: root,
    DSH_DEV_MODE: 'source',
    DSH_SOURCE_CONFIG: config,
    DSH_SOURCE_DISTRIBUTION: join(generationA, 'pack'),
    DSH_DEV_EPHEMERAL: '1',
  }
  const before = ephemeralRootsInTmpdir()
  const logs = []
  const originalLog = console.log
  console.log = (...args) => { logs.push(args.join(' ')) }
  const previousPackages = process.env.DSH_FAKE_PACKAGES
  const previousVersion = process.env.DSH_FAKE_VERSION
  process.env.DSH_FAKE_PACKAGES = JSON.stringify(['@deepseek-ai/dsh'])
  process.env.DSH_FAKE_VERSION = VERSION
  let result
  try {
    result = await withPnpmExecutable(pnpm, () => bootstrapDevelopmentEnvironment({
      root,
      mode: 'source',
      config,
      environment: { ...staleShell, XDG_CACHE_HOME: join(root, 'cache') },
    }))
  } finally {
    console.log = originalLog
    if (previousPackages === undefined) delete process.env.DSH_FAKE_PACKAGES
    else process.env.DSH_FAKE_PACKAGES = previousPackages
    if (previousVersion === undefined) delete process.env.DSH_FAKE_VERSION
    else process.env.DSH_FAKE_VERSION = previousVersion
  }
  assert.equal(result.distributionPath, second.distributionPath, 'the stale shell must adopt the committed generation B')
  assert.ok(logs.some(line => line.includes('committed ephemeral')), 'the committed-generation recovery path must be taken')
  assert.equal(logs.some(line => line.includes('materialize DSH source distribution')), false, 'no unnecessary materialization may run')
  assert.equal(existsSync(generationB), true, 'B must survive the stale shell bootstrap')
  const leaked = ephemeralRootsInTmpdir().filter(path => !before.includes(path))
  assert.deepEqual(leaked, [], 'no new ephemeral generation may be created')
  const state = JSON.parse(readFileSync(join(root, DEV_STATE_FILE), 'utf8'))
  assert.equal(state.distribution, second.distributionPath, 'the committed state must still point at B')
  assert.equal(state.ephemeral, true, 'the committed state must stay ephemeral')
})

test('a malformed ephemeral state is a cache miss, not an exception', (t) => {
  const life = testLifecycle(t)
  const { context } = sourceFixture(life)
  const pnpm = '11.7.0'
  const base = {
    schemaVersion: 1,
    mode: 'source',
    node: String(process.versions.node.split('.')[0]),
    pnpm,
    root: context.root,
    packageJsonHash: hashFile(join(context.root, 'package.json')),
    lockfileHash: hashFile(join(context.root, 'pnpm-lock.yaml')),
    repository: REPOSITORY,
    ref: SHA,
    expectedVersion: VERSION,
    ephemeral: true,
  }
  const used = join(context.root, 'pack')
  // A malformed distribution field (old version, partial write, manual
  // edit) must be treated as a cache miss — never crash the bootstrap.
  for (const malformed of [null, 42, {}, [], 'relative/path']) {
    const state = { ...base, distribution: malformed }
    assert.doesNotThrow(() => bootstrapTest.stateCoreMatches(context, state, pnpm, used))
    assert.equal(bootstrapTest.stateCoreMatches(context, state, pnpm, used), false,
      `distribution=${JSON.stringify(malformed)} must be a cache miss`)
  }
  // A valid ephemeral state referencing the exact distribution in use
  // still matches.
  const valid = { ...base, distribution: used }
  assert.equal(bootstrapTest.stateCoreMatches(context, valid, pnpm, used), true)
  // ... and a different distribution is a miss, not a match.
  assert.equal(bootstrapTest.stateCoreMatches(context, valid, pnpm, join(context.root, 'other-pack')), false)
})
