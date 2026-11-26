/**
 * Negative controls for the Split-process foundation inputs, candidate
 * disagreement, the shared official-record reader and the unstarted Scene IPC
 * admission.
 *
 * These tests use the REAL preflight, the REAL Supervisor IPC and the REAL
 * shared reader. Synthetic manifests are input fixtures only: they never
 * qualify a pairing and never prove an installation. The real native run, kill
 * and terminal receipt proof belongs to the external signal probe, never here.
 *
 * @module @xmoon76/dsh-pi-tui/test/tooling/split-process-foundation.test
 */

import assert from 'node:assert/strict'
import { waitForEntryClose } from '../support/entry-close.mjs'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { npmDshVersion, PACKAGE_ROOT } from '../../scripts/lib/dsh-distribution.mjs'
import {
  assertPostReadCandidateIdentity,
  inspectImmutableSplitCandidate,
} from '../../scripts/lib/split-smoke-profile.mjs'
import { prepareInstallCache, prepareNpmInstallCache } from '../../scripts/lib/test-install-cache.mjs'
import {
  assertKernelGroupSignalOwnership,
  kernelGroupLiveMemberPids,
} from '../support/split-kernel-group-ownership.mjs'
import { classifyKernelLiveness, serializeKernelIdentity } from '../support/split-upgrade-native-contract.mjs'
import { createSplitProcessScene } from '../support/split-process-fixture.ts'
import { readOfficialClientRecords } from '../support/split-process-client.ts'
import { SupervisorClient } from '../support/split-supervisor-client.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const TARGET_PIN = npmDshVersion()
const DSH_AGENT = '@deepseek-ai/dsh-agent'
const SOURCE_MANIFEST = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
const CANDIDATE_NAME = '@xmoon76/dsh-pi-tui'
const CANDIDATE_VERSION = SOURCE_MANIFEST.version

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function manifestOf({ name = CANDIDATE_NAME, version = CANDIDATE_VERSION, pin = TARGET_PIN } = {}) {
  const manifest = { name, version, devDependencies: {} }
  if (pin !== undefined) manifest.devDependencies[DSH_AGENT] = pin
  return manifest
}

/** One synthetic npm-layout artifact holding only `package/package.json`. */
function syntheticTarball(root, name, manifest) {
  const stage = join(root, `${name}-stage`)
  mkdirSync(join(stage, 'package'), { recursive: true })
  writeFileSync(join(stage, 'package', 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const path = join(root, `${name}.tgz`)
  const packed = spawnSync('tar', ['-czf', path, '-C', stage, 'package'], {
    encoding: 'utf8',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  assert.equal(packed.status, 0, `the synthetic fixture could not be packed: ${packed.stderr}`)
  return path
}

/** The exact immutable shape the preflight accepts (canonical + 0444 + 1 link). */
function immutableCandidate(root, name, manifest = manifestOf()) {
  const path = realpathSync(syntheticTarball(root, name, manifest))
  chmodSync(path, 0o444)
  return path
}

function privateBase(life, root, name) {
  const path = realpathSync(life.tempDir(`${name}-`, root))
  chmodSync(path, 0o700)
  return path
}

test('the immutable candidate preflight refuses every input bypass class', async t => {
  const life = testLifecycle(t)
  const root = realpathSync(life.tempDir('split-process-input-'))
  const good = immutableCandidate(root, 'good')

  // Positive control: the exact declared shape is accepted and hashed from the
  // real bytes.
  const accepted = inspectImmutableSplitCandidate(good)
  assert.equal(accepted.candidateSha256, sha256(good))
  assert.equal(accepted.manifestPin, TARGET_PIN)
  assert.equal(accepted.manifest.version, CANDIDATE_VERSION)

  assert.throws(() => inspectImmutableSplitCandidate(undefined), /INPUT_CANDIDATE_PATH_UNQUALIFIED/u)
  assert.throws(() => inspectImmutableSplitCandidate(''), /INPUT_CANDIDATE_PATH_UNQUALIFIED/u)
  assert.throws(() => inspectImmutableSplitCandidate('relative-candidate.tgz'), /INPUT_CANDIDATE_PATH_UNQUALIFIED/u)

  const aliasDir = join(root, 'alias')
  symlinkSync(root, aliasDir)
  assert.throws(() => inspectImmutableSplitCandidate(join(aliasDir, 'good.tgz')), /INPUT_CANDIDATE_PATH_NOT_CANONICAL/u)

  const linkPath = join(root, 'candidate-link.tgz')
  symlinkSync(good, linkPath)
  assert.throws(() => inspectImmutableSplitCandidate(linkPath), /INPUT_CANDIDATE_FILE_UNQUALIFIED/u)

  const hardlinkPath = join(root, 'candidate-hard.tgz')
  linkSync(good, hardlinkPath)
  assert.throws(() => inspectImmutableSplitCandidate(hardlinkPath), /INPUT_CANDIDATE_HARDLINK_UNQUALIFIED/u)

  const directoryPath = join(root, 'candidate-dir.tgz')
  mkdirSync(directoryPath)
  assert.throws(() => inspectImmutableSplitCandidate(directoryPath), /INPUT_CANDIDATE_FILE_UNQUALIFIED/u)

  const writable = immutableCandidate(root, 'writable')
  chmodSync(writable, 0o644)
  assert.throws(() => inspectImmutableSplitCandidate(writable), /INPUT_CANDIDATE_WRITABLE_UNQUALIFIED/u)

  const wrongSuffix = join(root, 'candidate.tar')
  copyFileSync(good, wrongSuffix)
  chmodSync(wrongSuffix, 0o444)
  assert.throws(() => inspectImmutableSplitCandidate(wrongSuffix), /INPUT_CANDIDATE_SUFFIX_UNQUALIFIED/u)

  // A real read-only artifact INSIDE the checkout is still refused. The
  // repository's own ignored scratch directory is the only fixture base that
  // can carry a canonical in-checkout path; the lifecycle owns its removal.
  const checkoutTemp = join(PACKAGE_ROOT, 'temp')
  mkdirSync(checkoutTemp, { recursive: true })
  const insideRoot = realpathSync(life.tempDir('candidate-inside-checkout-', checkoutTemp))
  const inside = immutableCandidate(insideRoot, 'inside')
  assert.throws(() => inspectImmutableSplitCandidate(inside), /INPUT_CANDIDATE_INSIDE_CHECKOUT/u)

  // A controlled bad manifest/pin is refused by the shared candidate preflight,
  // never accepted as if it were a real installation input.
  const badName = immutableCandidate(root, 'bad-name', manifestOf({ name: '@xmoon76/not-this-package' }))
  assert.throws(() => inspectImmutableSplitCandidate(badName), /candidate package mismatch|INFRA_INSTALL_FAILURE/u)
  const badVersion = immutableCandidate(root, 'bad-version', manifestOf({ version: '0.0.0-probe' }))
  assert.throws(() => inspectImmutableSplitCandidate(badVersion), /candidate package mismatch|INFRA_INSTALL_FAILURE/u)
  const badPin = immutableCandidate(root, 'bad-pin', manifestOf({ pin: '0.2.1-rc.4' }))
  assert.throws(() => inspectImmutableSplitCandidate(badPin), error => error?.code === 'INPUT_DSH_PIN_MISMATCH')
})

test('a candidate that disappears after its bytes are read is a changed input', t => {
  const life = testLifecycle(t)
  const root = life.tempDir('post-read-candidate-')
  const candidate = immutableCandidate(root, 'post-read')
  const before = lstatSync(candidate)
  rmSync(candidate)
  assert.throws(() => assertPostReadCandidateIdentity(candidate, before), error => {
    assert.equal(error.code, 'INPUT_CANDIDATE_CHANGED')
    assert.match(error.message, /after its bytes were read/u)
    return true
  })
})

test('the group-signal predicate binds ownership to the exact PID birth and ignores terminated members', () => {
  const shared = { platform: 'linux', ppid: 1, pgid: 4242, sid: 4242, uid: 501 }
  const leader = { kind: 'alive', identity: { ...shared, pid: 4242, startTicks: '777', state: 'S' } }
  const birth = serializeKernelIdentity(leader.identity)
  const readers = (observation, members) => ({ read: () => observation, listMembers: () => members })

  // Positive control: the exact live leader that owns its group/session.
  assert.equal(
    assertKernelGroupSignalOwnership(readers(leader, [leader]), 4242, birth, 'probe').identity.pid,
    4242,
  )

  // Two distinct Linux processes started in ONE clock tick share the serialized
  // birth, so a same-birth member with another PID does not prove that the
  // captured leader still owns the group.
  const sameTickStranger = { kind: 'alive', identity: { ...shared, pid: 5151, startTicks: '777', state: 'S' } }
  assert.equal(serializeKernelIdentity(sameTickStranger.identity), birth)
  assert.throws(
    () => assertKernelGroupSignalOwnership(readers(leader, [sameTickStranger]), 4242, birth, 'probe'),
    /no longer the live leader/u,
  )

  // A reused numeric PID is refused even though the group would still answer.
  const reused = { kind: 'alive', identity: { ...shared, pid: 4242, startTicks: '778', state: 'S' } }
  assert.throws(
    () => assertKernelGroupSignalOwnership(readers(reused, [reused]), 4242, birth, 'probe'),
    /replaced by another process/u,
  )

  // A same-birth Z/X/x task is a readable group member but NOT a live member.
  const terminated = { kind: 'alive', identity: { ...shared, pid: 4242, startTicks: '777', state: 'Z' } }
  assert.deepEqual(
    kernelGroupLiveMemberPids({ listMembers: () => [terminated] }, 4242, 'probe'),
    [],
  )
  // The product classifier is what makes that same-birth terminated leader a
  // terminal fact (the fallback reclaim must not escalate or report NOT_QUIESCED).
  assert.equal(classifyKernelLiveness(terminated).state, 'gone')
  // A genuinely live member keeps the group non-terminal.
  assert.deepEqual(
    kernelGroupLiveMemberPids({ listMembers: () => [leader] }, 4242, 'probe'),
    [4242],
  )
  // An unreadable group is unknown ownership, never a terminal empty group.
  assert.throws(
    () => kernelGroupLiveMemberPids({ listMembers: () => ({ kind: 'unknown', code: 'READ_FAILED' }) }, 4242, 'probe'),
    /cannot be enumerated/u,
  )
})

test('a symlinked private tmp base is refused before a Supervisor is forked', async t => {
  const life = testLifecycle(t)
  const root = life.tempDir('base-alias-')
  const canonicalBase = privateBase(life, root, 'base')
  const alias = join(root, 'base-alias')
  symlinkSync(canonicalBase, alias, 'dir')
  const candidate = immutableCandidate(life.tempDir('base-alias-candidate-'), 'candidate')
  const previousBase = process.env.SPLIT_VITEST_TMP_BASE
  const previousCandidate = process.env.SPLIT_VITEST_CANDIDATE_TGZ
  process.env.SPLIT_VITEST_TMP_BASE = alias
  process.env.SPLIT_VITEST_CANDIDATE_TGZ = candidate
  try {
    await assert.rejects(createSplitProcessScene(), /INPUT_UNQUALIFIED: SPLIT_VITEST_TMP_BASE must be a canonical path/u)
  } finally {
    if (previousBase === undefined) delete process.env.SPLIT_VITEST_TMP_BASE
    else process.env.SPLIT_VITEST_TMP_BASE = previousBase
    if (previousCandidate === undefined) delete process.env.SPLIT_VITEST_CANDIDATE_TGZ
    else process.env.SPLIT_VITEST_CANDIDATE_TGZ = previousCandidate
  }
})

test('a Worker/Supervisor candidate disagreement is refused before any install or Scene root', async t => {
  const life = testLifecycle(t)
  const root = realpathSync(life.tempDir('split-process-bootstrap-'))
  const candidate = immutableCandidate(root, 'candidate')
  const tmpBase = privateBase(life, root, 'base')
  const supervisor = new SupervisorClient({ runId: `split-process-foundation-${String(process.pid)}` })
  try {
    // A non-0700 private base is refused before a receipt, install or root.
    const unsafeBase = privateBase(life, root, 'unsafe-base')
    chmodSync(unsafeBase, 0o777)
    await assert.rejects(
      supervisor.request('BOOTSTRAP_PROCESS', {
        tarball: candidate,
        expectedSha256: sha256(candidate),
        tmpBase: unsafeBase,
        workerPid: process.pid,
        workerPpid: process.ppid,
        sceneId: 'unsafe-base-probe',
      }, { timeoutMs: 60_000 }),
      /SPLIT_VITEST_TMP_BASE must have mode 0700/u,
    )
    assert.deepEqual(readdirSync(unsafeBase), [])

    // The Supervisor re-reads the real bytes and refuses a Worker-supplied hash
    // that does not name them: no Scene root, no install, no Host.
    await assert.rejects(
      supervisor.request('BOOTSTRAP_PROCESS', {
        tarball: candidate,
        expectedSha256: '0'.repeat(64),
        tmpBase,
        workerPid: process.pid,
        workerPpid: process.ppid,
        sceneId: 'candidate-disagreement-probe',
      }, { timeoutMs: 60_000 }),
      /INPUT_CANDIDATE_CHANGED/u,
    )
    const entries = readdirSync(tmpBase)
    assert.deepEqual(entries.filter(name => name.startsWith('dsh-split-process-foundation.')), [])
    const receipts = readdirSync(join(tmpBase, 'split-resources'))
    assert.equal(receipts.length, 1)
    const receipt = JSON.parse(readFileSync(join(tmpBase, 'split-resources', receipts[0]), 'utf8'))
    assert.equal(receipt.sceneRoot, undefined)
    assert.equal(receipt.install.completed, false)
    assert.equal(receipt.hosts.length, 0)
    assert.match(String(receipt.errorName), /INPUT_CANDIDATE_CHANGED/u)

    // An unstarted Scene cannot be used to create an external resource through
    // the process API.
    for (const [type, payload] of [
      ['START_PROCESS_CLIENT', { label: 'probe', cwd: tmpBase, home: tmpBase }],
      ['PROCESS_CLIENT_INPUT', { clientId: 'probe', input: { type: 'type', text: 'x' } }],
      ['PROCESS_CLIENT_TEXT', { clientId: 'probe' }],
      ['CLOSE_PROCESS_CLIENT', { clientId: 'probe' }],
    ]) {
      await assert.rejects(supervisor.request(type, payload, { timeoutMs: 30_000 }), /no process scene/u)
    }
    assert.deepEqual(readdirSync(tmpBase).filter(name => name !== 'split-resources'), [])
  } finally {
    await supervisor.close({ timeoutMs: 30_000, allowKill: false })
  }
})

test('a symlinked private tmp base is refused at the Process BOOTSTRAP boundary before any receipt or root', async t => {
  const life = testLifecycle(t)
  const root = realpathSync(life.tempDir('split-process-bootstrap-alias-'))
  const canonicalBase = privateBase(life, root, 'base')
  const alias = join(root, 'base-alias')
  symlinkSync(canonicalBase, alias, 'dir')
  const candidate = immutableCandidate(root, 'candidate')
  const supervisor = new SupervisorClient({ runId: `split-process-alias-${String(process.pid)}` })
  try {
    // The resource owner mirrors the Worker's canonical-input contract; the
    // refusal happens before a durable receipt, Scene root or install exists.
    await assert.rejects(
      supervisor.request('BOOTSTRAP_PROCESS', {
        tarball: candidate,
        expectedSha256: sha256(candidate),
        tmpBase: alias,
        workerPid: process.pid,
        workerPpid: process.ppid,
        sceneId: 'tmp-base-alias-probe',
      }, { timeoutMs: 60_000 }),
      /BOOTSTRAP_PROCESS requires a canonical tmpBase/u,
    )
    assert.equal(existsSync(join(canonicalBase, 'split-resources')), false)
    assert.deepEqual(readdirSync(canonicalBase), [])
  } finally {
    await supervisor.close({ timeoutMs: 30_000, allowKill: false })
  }
})

test('the install cache keeps a private reusable root and refuses unsafe overrides', t => {
  const life = testLifecycle(t)
  const root = realpathSync(life.tempDir('process-cache-'))
  const tmpBase = privateBase(life, root, 'base')
  const inputs = privateBase(life, root, 'inputs')
  const candidate = join(inputs, 'candidate.tgz')
  writeFileSync(candidate, 'input fixture\n', { mode: 0o600 })
  const cache = privateBase(life, root, 'cache')

  assert.equal(prepareInstallCache({ tmpBase, override: cache, candidateTarballs: [candidate] }), cache)
  for (const name of ['pnpm-store', 'pnpm-cache']) {
    const stats = lstatSync(join(cache, name))
    assert.equal(stats.isDirectory(), true)
    assert.equal(stats.mode & 0o777, 0o700)
    if (typeof process.getuid === 'function') assert.equal(stats.uid, process.getuid())
  }

  const sentinel = join(cache, 'pnpm-store', 'sentinel')
  writeFileSync(sentinel, 'owned\n', { mode: 0o600 })
  assert.equal(prepareInstallCache({ tmpBase, override: cache, candidateTarballs: [candidate] }), cache)
  assert.equal(existsSync(sentinel), true)

  assert.throws(
    () => prepareInstallCache({ tmpBase, override: 'relative-cache', candidateTarballs: [candidate] }),
    /install cache root/u,
  )
  assert.throws(
    () => prepareInstallCache({ tmpBase, override: '', candidateTarballs: [candidate] }),
    /install cache root/u,
  )
  assert.throws(
    () => prepareInstallCache({ tmpBase, override: join(root, 'missing-cache'), candidateTarballs: [candidate] }),
    /install cache root/u,
  )

  const alias = join(root, 'cache-alias')
  symlinkSync(cache, alias)
  assert.throws(
    () => prepareInstallCache({ tmpBase, override: alias, candidateTarballs: [candidate] }),
    /install cache root/u,
  )

  const unsafeMode = privateBase(life, root, 'unsafe-mode')
  writeFileSync(join(unsafeMode, 'sentinel'), 'owned\n', { mode: 0o600 })
  chmodSync(unsafeMode, 0o755)
  assert.throws(
    () => prepareInstallCache({ tmpBase, override: unsafeMode, candidateTarballs: [candidate] }),
    /install cache root/u,
  )
  assert.equal(existsSync(join(unsafeMode, 'sentinel')), true)
  assert.equal(existsSync(join(unsafeMode, 'pnpm-store')), false)

  assert.throws(
    () => prepareInstallCache({ tmpBase, override: tmpBase, candidateTarballs: [candidate] }),
    /install cache root/u,
  )
  assert.equal(existsSync(join(tmpBase, 'pnpm-store')), false)

  assert.throws(
    () => prepareInstallCache({ tmpBase, override: inputs, candidateTarballs: [candidate] }),
    /install cache root/u,
  )
  assert.equal(existsSync(join(inputs, 'pnpm-store')), false)
  writeFileSync(join(inputs, 'sentinel'), 'owned\n', { mode: 0o600 })
  assert.throws(
    () => prepareInstallCache({ tmpBase, override: inputs, candidateTarballs: [candidate] }),
    /install cache root/u,
  )
  assert.equal(existsSync(join(inputs, 'sentinel')), true)

  mkdirSync(join(PACKAGE_ROOT, 'temp'), { recursive: true })
  const checkoutCache = realpathSync(life.tempDir('cache-inside-checkout-', join(PACKAGE_ROOT, 'temp')))
  chmodSync(checkoutCache, 0o700)
  writeFileSync(join(checkoutCache, 'sentinel'), 'owned\n', { mode: 0o600 })
  assert.throws(
    () => prepareInstallCache({ tmpBase, override: checkoutCache, candidateTarballs: [candidate] }),
    /install cache root/u,
  )
  assert.equal(existsSync(join(checkoutCache, 'sentinel')), true)
  assert.equal(existsSync(join(checkoutCache, 'pnpm-store')), false)
})

test('the install cache refuses an override that aliases only the second candidate directory', t => {
  const life = testLifecycle(t)
  const root = realpathSync(life.tempDir('install-cache-two-inputs-'))
  const tmpBase = privateBase(life, root, 'base')
  const firstInput = privateBase(life, root, 'inputs-first')
  const secondInput = privateBase(life, root, 'inputs-second')
  const first = join(firstInput, 'first.tgz')
  const second = join(secondInput, 'second.tgz')
  writeFileSync(first, 'first fixture\n', { mode: 0o600 })
  writeFileSync(second, 'second fixture\n', { mode: 0o600 })
  const firstSentinel = join(firstInput, 'sentinel')
  writeFileSync(firstSentinel, 'owned\n', { mode: 0o600 })

  // The override exists, is private and canonical, and overlaps ONLY the
  // second real candidate input directory. The first input stays safe.
  const aliased = realpathSync(life.tempDir('cache-two-inputs-', secondInput))
  chmodSync(aliased, 0o700)
  const secondSentinel = join(aliased, 'sentinel')
  writeFileSync(secondSentinel, 'owned\n', { mode: 0o600 })
  assert.throws(
    () => prepareInstallCache({ tmpBase, override: aliased, candidateTarballs: [first, second] }),
    /install cache root/u,
  )
  assert.equal(existsSync(join(aliased, 'pnpm-store')), false)
  assert.equal(existsSync(join(aliased, 'pnpm-cache')), false)
  assert.equal(existsSync(firstSentinel), true)
  assert.equal(existsSync(secondSentinel), true)

  // A valid root outside both input directories accepts the real two-input
  // shape and creates only the required subdirectories.
  const valid = privateBase(life, root, 'cache-two-inputs-valid')
  assert.equal(prepareInstallCache({ tmpBase, override: valid, candidateTarballs: [first, second] }), valid)
  for (const name of ['pnpm-store', 'pnpm-cache']) {
    assert.equal(lstatSync(join(valid, name)).isDirectory(), true)
  }
})

test('the install cache refuses a case-alias overlap on a case-insensitive volume', t => {
  const life = testLifecycle(t)
  const root = realpathSync(life.tempDir('process-cache-case-'))
  const tmpBase = join(root, 'RunBase')
  mkdirSync(tmpBase, { mode: 0o700 })
  const lowerBase = join(root, 'runbase')
  if (!existsSync(lowerBase)) {
    t.skip('case-insensitive filesystem required for the alias fixture')
    return
  }
  const baseStats = lstatSync(tmpBase)
  const aliasStats = lstatSync(lowerBase)
  if (aliasStats.dev !== baseStats.dev || aliasStats.ino !== baseStats.ino) {
    t.skip('case-insensitive filesystem required for the alias fixture')
    return
  }

  const cache = join(tmpBase, 'Cache')
  mkdirSync(cache, { mode: 0o700 })
  const inputs = privateBase(life, root, 'inputs')
  const candidate = join(inputs, 'candidate.tgz')
  writeFileSync(candidate, 'input fixture\n', { mode: 0o600 })
  const sentinel = join(tmpBase, 'sentinel')
  writeFileSync(sentinel, 'owned\n', { mode: 0o600 })

  // realpathSync keeps this spelling for the case-insensitive components, so
  // only actual directory identity can see that it is inside tmpBase.
  assert.throws(
    () => prepareInstallCache({
      tmpBase,
      override: join(lowerBase, 'cache'),
      candidateTarballs: [candidate],
    }),
    /install cache root/u,
  )
  assert.equal(existsSync(sentinel), true)
  assert.equal(existsSync(join(cache, 'pnpm-store')), false)
})

test('the npm install cache request creates only its npm child and refuses an unsafe existing child', t => {
  const life = testLifecycle(t)
  const root = realpathSync(life.tempDir('npm-cache-request-'))
  const tmpBase = privateBase(life, root, 'base')
  const inputs = privateBase(life, root, 'inputs')
  const candidate = join(inputs, 'candidate.tgz')
  writeFileSync(candidate, 'input fixture\n', { mode: 0o600 })

  // A new shared root gets only the npm child; the pnpm entry keeps ownership
  // of its own two children.
  const cache = privateBase(life, root, 'cache')
  const npmCache = prepareNpmInstallCache({ tmpBase, override: cache, candidateTarballs: [candidate] })
  assert.equal(npmCache, join(cache, 'npm-cache'))
  const npmStats = lstatSync(npmCache)
  assert.equal(npmStats.isDirectory(), true)
  assert.equal(npmStats.mode & 0o777, 0o700)
  if (typeof process.getuid === 'function') assert.equal(npmStats.uid, process.getuid())
  assert.equal(existsSync(join(cache, 'pnpm-store')), false)
  assert.equal(existsSync(join(cache, 'pnpm-cache')), false)

  // Reuse keeps existing content, and the pnpm entry can coexist on the same
  // root without changing the npm child.
  const npmSentinel = join(npmCache, 'sentinel')
  writeFileSync(npmSentinel, 'npm-owned\n', { mode: 0o600 })
  assert.equal(prepareNpmInstallCache({ tmpBase, override: cache, candidateTarballs: [candidate] }), npmCache)
  assert.equal(prepareInstallCache({ tmpBase, override: cache, candidateTarballs: [candidate] }), cache)
  assert.equal(readFileSync(npmSentinel, 'utf8'), 'npm-owned\n')
  for (const name of ['pnpm-store', 'pnpm-cache']) {
    assert.equal(lstatSync(join(cache, name)).isDirectory(), true)
  }
  assert.equal(prepareNpmInstallCache({ tmpBase, override: cache, candidateTarballs: [candidate] }), npmCache)

  // An existing symlink or wrong-mode npm child is refused without following,
  // repairing or deleting it; the pointed-to directory keeps its own content.
  const symlinkRoot = privateBase(life, root, 'cache-symlink-child')
  const symlinkTarget = privateBase(life, root, 'foreign-dir')
  const targetSentinel = join(symlinkTarget, 'sentinel')
  writeFileSync(targetSentinel, 'foreign-owned\n', { mode: 0o600 })
  symlinkSync(symlinkTarget, join(symlinkRoot, 'npm-cache'))
  assert.throws(
    () => prepareNpmInstallCache({ tmpBase, override: symlinkRoot, candidateTarballs: [candidate] }),
    /install cache root/u,
  )
  assert.equal(lstatSync(join(symlinkRoot, 'npm-cache')).isSymbolicLink(), true)
  assert.equal(readFileSync(targetSentinel, 'utf8'), 'foreign-owned\n')
  assert.deepEqual(readdirSync(symlinkTarget), ['sentinel'])

  const unsafeModeRoot = privateBase(life, root, 'cache-unsafe-mode')
  const unsafeChild = join(unsafeModeRoot, 'npm-cache')
  mkdirSync(unsafeChild, { mode: 0o700 })
  chmodSync(unsafeChild, 0o755)
  const modeSentinel = join(unsafeChild, 'sentinel')
  writeFileSync(modeSentinel, 'owned\n', { mode: 0o600 })
  assert.throws(
    () => prepareNpmInstallCache({ tmpBase, override: unsafeModeRoot, candidateTarballs: [candidate] }),
    /install cache root/u,
  )
  assert.equal(lstatSync(unsafeChild).mode & 0o777, 0o755)
  assert.equal(readFileSync(modeSentinel, 'utf8'), 'owned\n')

  // The empty explicit override is not the unset default.
  assert.throws(
    () => prepareNpmInstallCache({ tmpBase, override: '', candidateTarballs: [candidate] }),
    /install cache root/u,
  )
})

test('the shared official-record reader keeps complete-line strictness and only streams an incomplete tail', async t => {
  const life = testLifecycle(t)
  const root = realpathSync(life.tempDir('split-process-records-'))
  const recordFile = join(root, 'records.jsonl')

  // A missing or empty ledger is an empty read, not a failure.
  assert.deepEqual(readOfficialClientRecords(recordFile, 'probe'), [])
  writeFileSync(recordFile, '', { mode: 0o600 })
  assert.deepEqual(readOfficialClientRecords(recordFile, 'probe'), [])

  writeFileSync(recordFile, [
    '{"m4a0":"client-started","processRole":"client","pid":41}',
    '{"m4a0":"ready","processRole":"client","pid":41,"transport":"connected"}',
    '',
  ].join('\n'), { mode: 0o600 })
  const complete = readOfficialClientRecords(recordFile, 'probe')
  assert.equal(complete.length, 2)
  assert.equal(complete[1].transport, 'connected')

  // A torn tail is refused by default and ignored only by the streaming reader,
  // which still parses every COMPLETE line.
  writeFileSync(recordFile, '{"m4a0":"client-started","pid":41}\n{"m4a0":"rea', { mode: 0o600 })
  assert.throws(() => readOfficialClientRecords(recordFile, 'probe'), /incomplete trailing line/u)
  assert.deepEqual(
    readOfficialClientRecords(recordFile, 'probe', { allowIncompleteTail: true }),
    [{ m4a0: 'client-started', pid: 41 }],
  )

  // A malformed COMPLETE line is never swallowed, even while streaming.
  writeFileSync(recordFile, '{"m4a0":"client-started","pid":41}\nnot-json\n', { mode: 0o600 })
  assert.throws(
    () => readOfficialClientRecords(recordFile, 'probe', { allowIncompleteTail: true }),
    /client record line 2 is invalid JSON/u,
  )
})

test('the installed-entry qualification operations are refused before any process Scene exists', async () => {
  const supervisor = new SupervisorClient({ runId: `split-process-entry-admission-${String(process.pid)}` })
  try {
    for (const [type, payload] of [
      ['START_HOST_ATTEMPTS', { mode: 'seat-race', count: 2 }],
      ['SET_INSTALLATION_FAULT', { fault: 'host-runtime-absent' }],
      ['SIGNAL_ENTRY', { entryId: 'probe', signal: 'SIGTERM' }],
    ]) {
      await assert.rejects(
        supervisor.request(type, payload, { timeoutMs: 30_000 }),
        /no process scene/u,
      )
    }
  } finally {
    await supervisor.close({ timeoutMs: 30_000, allowKill: false })
  }
})

test('the real close waiter ignores exitCode until the inherited stdout closes', async t => {
  const life = testLifecycle(t)
  const directory = realpathSync(life.tempDir('close-authority-'))
  const release = join(directory, 'release')
  const released = join(directory, 'released')
  const grandchild = [
    "const fs = require('node:fs')",
    'const release = process.env.CLOSE_RELEASE',
    'const released = process.env.CLOSE_RELEASED',
    'const check = () => { if (fs.existsSync(release)) { fs.writeFileSync(released, "released\\n"); fs.unwatchFile(release); process.exit(0) } }',
    'fs.watchFile(release, { interval: 100 }, check)',
    'setTimeout(() => process.exit(2), 10_000)', // bounded fail-safe window: a stuck control cannot leak
    'check()',
  ].join(';')
  const child = spawn(process.execPath, ['-e', [
    "const { spawn } = require('node:child_process')",
    `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: ['ignore', 'inherit', 'ignore'], env: process.env })`,
    'process.exit(0)',
  ].join(';')], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, CLOSE_RELEASE: release, CLOSE_RELEASED: released },
  })
  let closeFired = false
  let settleClose
  const closePromise = new Promise(resolve => { settleClose = resolve })
  const handle = { closePromise, exited: false }
  child.once('close', (code, signal) => {
    closeFired = true
    handle.exited = true
    settleClose({ code, signal })
  })
  let waiter
  let primaryError
  try {
    await bounded(new Promise((resolve, reject) => {
      child.once('exit', resolve)
      child.once('error', reject)
    }), 5_000, 'the safe child exit')
    assert.equal(closeFired, false, 'close already fired before the inherited stdout was released')
    let settled = false
    waiter = waitForEntryClose(handle, 'close authority control', 5_000).then(value => {
      settled = true
      return value
    })
    waiter.catch(() => {})
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(settled, false, 'the close waiter settled before the real close event')
    writeFileSync(release, 'release\n', { mode: 0o600 })
    assert.deepEqual(await waiter, { code: 0, signal: null })
    assert.equal(closeFired, true)
    assert.equal(existsSync(released), true, 'the release watchdog, not the actual marker, settled the control')
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    // Release even on the intended early-waiter regression, then bounded-join
    // the registered close so the inherited stdout cannot leak. Cleanup errors
    // surface together with the primary failure instead of being swallowed.
    let cleanupError
    try { writeFileSync(release, 'release\n', { mode: 0o600 }) } catch (error) { cleanupError = error }
    if (!closeFired) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      try {
        await bounded(handle.closePromise, 5_000, 'the close control join')
      } catch (error) {
        cleanupError = cleanupError ?? error
      }
    }
    if (cleanupError !== undefined) {
      if (primaryError !== undefined) {
        throw new AggregateError([primaryError, cleanupError], 'the close control failed and its cleanup also failed')
      }
      throw cleanupError
    }
  }
})

function bounded(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${String(timeoutMs)}ms`)), timeoutMs)
    Promise.resolve(promise).then(value => {
      clearTimeout(timer)
      resolve(value)
    }, error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}
