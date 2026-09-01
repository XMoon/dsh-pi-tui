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
 *   distribution) is pinned by a direct unit test.
 * - Case C (ephemeral -> durable source) flows through the same post-commit
 *   seam with a distributionPath that is never under tmpdir(); its
 *   validation is reclaimableEphemeralRoot's unit matrix.
 * - Cases E/F are covered both as unit rejections and end-to-end.
 * @module @xmoon76/dsh-pi-tui/dev-bootstrap-ephemeral.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
  const root = bootstrapTest.ephemeralSourcePackRoot(context)
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
  const generation = bootstrapTest.ephemeralSourcePackRoot(context)
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
  const foreign = bootstrapTest.ephemeralSourcePackRoot(context)
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
  const generation = bootstrapTest.ephemeralSourcePackRoot(context)
  life.defer(() => rmSync(generation, { recursive: true, force: true }))
  bootstrapTest.reclaimEphemeralRoot(generation, join(generation, 'pack'))
  assert.equal(existsSync(generation), true, 'the active generation must survive')
  bootstrapTest.reclaimEphemeralRoot(generation, join(scratchDir(life), 'pack'))
  assert.equal(existsSync(generation), false, 'a superseded generation must be removed')
})

test('Case D: a successful npm bootstrap reclaims the previous ephemeral generation', async (t) => {
  const life = testLifecycle(t)
  const { root, context } = sourceFixture(life)
  const generation = bootstrapTest.ephemeralSourcePackRoot(context)
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
  const generation = bootstrapTest.ephemeralSourcePackRoot(context)
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
  const generation = bootstrapTest.ephemeralSourcePackRoot(context)
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
  const generation = bootstrapTest.ephemeralSourcePackRoot(context)
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

test('commitDevelopmentState rolls back when the ENV write itself fails after replacing the file', async (t) => {
  const life = testLifecycle(t)
  const { context } = sourceFixture(life)
  writeFileSync(context.envPath, 'OLD-ENV-MARKER\n')
  // The env writer replaces the file and then throws (the .envrc half of
  // writeDevelopmentEnvironment failing): the checkpoint must still roll
  // the env file back to the previous content.
  await assert.rejects(
    async () => bootstrapTest.commitDevelopmentState(
      context,
      () => {
        writeFileSync(context.envPath, 'NEW-ENV-MARKER\n')
        throw new Error('envrc write failed')
      },
      () => { throw new Error('must not be reached') },
    ),
    /envrc write failed/u,
  )
  assert.equal(readFileSync(context.envPath, 'utf8'), 'OLD-ENV-MARKER\n', 'the env file must be rolled back when the env write fails')
})

test('commitDevelopmentState removes a previously absent env file on failure', async (t) => {
  const life = testLifecycle(t)
  const { context } = sourceFixture(life)
  assert.equal(existsSync(context.envPath), false, 'fixture starts without an env file')
  await assert.rejects(
    async () => bootstrapTest.commitDevelopmentState(
      context,
      () => writeFileSync(context.envPath, 'NEW-ENV-MARKER\n'),
      () => { throw new Error('state write failed') },
    ),
    /state write failed/u,
  )
  assert.equal(existsSync(context.envPath), false, 'a failed commit must not leave a stray env file behind')
})

test('commitDevelopmentState rollback never follows a swapped-in symlink', async (t) => {
  const life = testLifecycle(t)
  const { context } = sourceFixture(life)
  writeFileSync(context.envPath, 'OLD-ENV-MARKER\n')
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
})

test('commitDevelopmentState removes a swapped-in symlink when there was no previous env', async (t) => {
  const life = testLifecycle(t)
  const { context } = sourceFixture(life)
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
})

test('commitDevelopmentState never reads through an initially symlinked env path', async (t) => {
  const life = testLifecycle(t)
  const { context } = sourceFixture(life)
  const decoy = join(life.tempDir('dsh-ephemeral-decoy3-'), 'decoy-env')
  writeFileSync(decoy, 'DECOY-CONTENT\n')
  // The env path is a symlink BEFORE the commit starts: the snapshot must
  // not follow it, and the failed commit must remove the link (never copy
  // the target's content into a new file).
  symlinkSync(decoy, context.envPath)
  await assert.rejects(
    async () => bootstrapTest.commitDevelopmentState(
      context,
      () => { throw new Error('env write refused') },
      () => { throw new Error('must not be reached') },
    ),
    /env write refused/u,
  )
  assert.equal(existsSync(context.envPath), false, 'an unsafe env path must be removed, not copied')
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
      () => {
        writeFileSync(context.envPath, 'NEW-ENV-MARKER\n')
        writeFileSync(envrcPath, 'source .dsh-dev-env\n')
      },
      () => { throw new Error('state write failed') },
    ),
    /state write failed/u,
  )
  assert.equal(readFileSync(context.envPath, 'utf8'), 'OLD-ENV-MARKER\n', 'the env file must roll back')
  assert.equal(existsSync(envrcPath), false, 'a .envrc created by the failed commit must be removed')
})

test('commitDevelopmentState restores a pre-existing .envrc on failure', async (t) => {
  const life = testLifecycle(t)
  const { context } = sourceFixture(life)
  writeFileSync(context.envPath, 'OLD-ENV-MARKER\n')
  const envrcPath = join(context.root, '.envrc')
  writeFileSync(envrcPath, 'OLD-ENVRC\n')
  await assert.rejects(
    async () => bootstrapTest.commitDevelopmentState(
      context,
      () => {
        writeFileSync(context.envPath, 'NEW-ENV-MARKER\n')
        writeFileSync(envrcPath, 'NEW-ENVRC\n')
      },
      () => { throw new Error('state write failed') },
    ),
    /state write failed/u,
  )
  assert.equal(readFileSync(context.envPath, 'utf8'), 'OLD-ENV-MARKER\n', 'the env file must roll back')
  assert.equal(readFileSync(envrcPath, 'utf8'), 'OLD-ENVRC\n', 'the pre-existing .envrc must be restored')
})

test('ownership comparison is canonical: a symlinked worktree path still matches its own marker', async (t) => {
  const life = testLifecycle(t)
  const { root, context } = sourceFixture(life)
  const link = join(life.tempDir('dsh-ephemeral-link-'), 'worktree-link')
  symlinkSync(root, link, 'dir')
  const linkedContext = resolveDshDevContext({ root: link, mode: 'source', config: join(link, 'source.json'), environment: {} })
  const generation = bootstrapTest.ephemeralSourcePackRoot(linkedContext)
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

test('Case A: a successful source-mode bootstrap reclaims the previous ephemeral generation', { skip: process.platform === 'win32' }, async (t) => {
  const life = testLifecycle(t)
  const { root, config, context, harness } = sourceBootstrapFixture(life)
  const pnpm = fakePackPnpm(life)
  const runBootstrap = () => withPnpmExecutable(pnpm, async () => {
    const previousPackages = process.env.DSH_FAKE_PACKAGES
    const previousVersion = process.env.DSH_FAKE_VERSION
    process.env.DSH_FAKE_PACKAGES = JSON.stringify(['@deepseek-ai/dsh'])
    process.env.DSH_FAKE_VERSION = VERSION
    try {
      return await bootstrapDevelopmentEnvironment({
        root,
        mode: 'source',
        config,
        'dsh-dir': harness,
        environment: { XDG_CACHE_HOME: join(root, 'cache') },
      })
    } finally {
      if (previousPackages === undefined) delete process.env.DSH_FAKE_PACKAGES
      else process.env.DSH_FAKE_PACKAGES = previousPackages
      if (previousVersion === undefined) delete process.env.DSH_FAKE_VERSION
      else process.env.DSH_FAKE_VERSION = previousVersion
    }
  })

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
