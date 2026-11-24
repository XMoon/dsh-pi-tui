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
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { npmDshVersion, PACKAGE_ROOT } from '../../scripts/lib/dsh-distribution.mjs'
import {
  assertPostReadCandidateIdentity,
  inspectImmutableSplitCandidate,
} from '../../scripts/lib/split-smoke-profile.mjs'
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

test('the installed-entry qualification operations are refused before any process Scene exists', async t => {
  const life = testLifecycle(t)
  const root = realpathSync(life.tempDir('split-process-entry-admission-'))
  const tmpBase = privateBase(life, root, 'base')
  const supervisor = new SupervisorClient({ runId: `split-process-entry-admission-${String(process.pid)}` })
  try {
    for (const [type, payload] of [
      ['ENTRY_RECORDS', { entryId: 'probe' }],
      ['START_HOST_ATTEMPTS', { mode: 'seat-race', count: 2 }],
      ['SIGNAL_ENTRY', { entryId: 'probe', signal: 'SIGTERM' }],
      ['FINISH_ENTRY', { entryId: 'probe' }],
    ]) {
      await assert.rejects(
        supervisor.request(type, payload, { timeoutMs: 30_000 }),
        /no process scene|unknown entryId|no Scene/,
      )
    }
  } finally {
    await supervisor.close({ timeoutMs: 30_000, allowKill: false })
  }
})

test('the real close waiter ignores exitCode until the inherited stdout closes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'close-authority-'))
  const release = join(directory, 'release')
  const grandchild = [
    "const fs = require('node:fs')",
    'const release = process.env.CLOSE_RELEASE',
    'const check = () => { if (fs.existsSync(release)) { fs.unwatchFile(release); process.exit(0) } }',
    'fs.watchFile(release, check)',
    'check()',
  ].join(';')
  const child = spawn(process.execPath, ['-e', [
    "const { spawn } = require('node:child_process')",
    `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: ['ignore', 'inherit', 'ignore'], env: process.env })`,
    'process.exit(0)',
  ].join(';')], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, CLOSE_RELEASE: release },
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
  try {
    await new Promise((resolve, reject) => {
      child.once('exit', resolve)
      child.once('error', reject)
    })
    assert.equal(closeFired, false, 'close already fired before the inherited stdout was released')
    let settled = false
    const waiter = waitForEntryClose(handle, 'close authority control').then(value => {
      settled = true
      return value
    })
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(settled, false, 'the close waiter settled before the real close event')
    writeFileSync(release, 'release\n', { mode: 0o600 })
    assert.deepEqual(await waiter, { code: 0, signal: null })
    assert.equal(closeFired, true)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    rmSync(directory, { recursive: true, force: true })
  }
})
