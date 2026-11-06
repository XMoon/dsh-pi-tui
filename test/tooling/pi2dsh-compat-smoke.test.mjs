import assert from 'node:assert/strict'
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { join } from 'node:path'

import { testLifecycle } from '../support/temp-lifecycle.ts'
import { API_VERSION } from '../../src/extension/public-types.ts'
import { UNSTABLE_API_LEVEL } from '../../src/extension/unstable-types.ts'
import {
  assertNoCompatibilityFailures,
  assertOfficialPresetHeader,
  candidateArgument,
  compatibilityFailureLine,
  fixtureImportViolations,
  hasFreshResizeWidth,
  isolatedEnvironment,
  isRetryableRegistryFailure,
  redact,
  requireExactVersion,
  resolveTarball,
  retryDiagnostic,
  RESIZE_FAILURE_PHASE,
  classifyConsumerMetadata,
  dispositionFileArgument,
  isPullRequestRef,
  PI2DSH_COMPAT_DISPOSITIONS,
  skipUnsupportedDshPeerOnPrArgument,
  unsupportedDshPeerSkipAllowed,
  writeDispositionFile,
  failConsumerMetadata,
  validateCandidatePackageData,
  validateConsumerMetadata,
  validateFixturePackageData,
  validateManifest,
  validateTargetDshManifest,
  smokeOfficialPresetMounts,
  officialPresetStatusCommand,
  officialPresetStatusVisible,
  settingsSearchSnapshot,
  presetDegradationLine,
  CI_ECOSYSTEM_TIMEOUT_MS,
  CLEANUP_BUDGET_MS,
  GATE_BUDGET_MS,
  REQUIRED_CONTRACTS,
  run,
} from '../../scripts/pi2dsh-compat-smoke.mjs'

test('pi2dsh smoke isolates credential-bearing parent environment variables', () => {
  const canary = 'PI2DSH_COMPAT_TEST_SECRET'
  const previous = process.env[canary]
  process.env[canary] = 'must-not-reach-the-TUI'
  try {
    const env = isolatedEnvironment('/tmp/compat-work', '/tmp/compat-home', '/tmp/compat-dsh', '/tmp/evidence.json')
    assert.equal(env[canary], undefined, 'the isolated environment must not inherit arbitrary parent variables')
    assert.equal(env.HOME, '/tmp/compat-home', 'the TUI must receive the temporary HOME')
    assert.equal(env.DSH_HOME, '/tmp/compat-dsh', 'the TUI must receive the temporary DSH_HOME')
    assert.equal(env.PI2DSH_COMPAT_EVIDENCE, '/tmp/evidence.json', 'the TUI must receive the isolated evidence path')
    assert.equal(env.PI2DSH_COMPAT_HEADER_EVIDENCE, '/tmp/compat-work/header-evidence.json', 'the TUI must receive the isolated durable-header evidence path')
    assert.equal(env.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN, 'false')
    assert.equal(env.PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS, 'false')
  } finally {
    if (previous === undefined) delete process.env[canary]
    else process.env[canary] = previous
  }
})

test('pi2dsh smoke rejects a symlinked candidate tarball', (t) => {
  const life = testLifecycle(t)
  const directory = life.tempDir('dsh-pi2dsh-candidate-link-')
  const target = join(directory, 'external.tgz')
  const candidate = join(directory, 'candidate.tgz')
  writeFileSync(target, 'not a tarball')
  symlinkSync(target, candidate)
  assert.throws(() => resolveTarball(candidate), /candidate tarball not found/u)
})

test('pi2dsh smoke accepts pnpm separator arguments and enforces installed versions', () => {
  assert.equal(candidateArgument(['--', '/tmp/candidate.tgz']), '/tmp/candidate.tgz')
  assert.equal(candidateArgument(['/tmp/candidate.tgz']), '/tmp/candidate.tgz')
  assert.doesNotThrow(() => requireExactVersion('DSH', '0.1.1-rc.2', '0.1.1-rc.2'))
  assert.throws(() => requireExactVersion('pi2dsh', '0.19.0', '0.20.0'), /version mismatch/u)
  assert.doesNotThrow(() => validateCandidatePackageData({ name: '@xmoon76/dsh-pi-tui', version: '0.3.4' }, { name: '@xmoon76/dsh-pi-tui', version: '0.3.4' }))
  assert.throws(() => validateCandidatePackageData({ name: 'unrelated-package', version: '0.3.4' }, { name: '@xmoon76/dsh-pi-tui', version: '0.3.4' }), /candidate package mismatch/u)
  assert.throws(() => validateCandidatePackageData({ name: '@xmoon76/dsh-pi-tui', version: '0.3.3' }, { name: '@xmoon76/dsh-pi-tui', version: '0.3.4' }), /candidate package mismatch/u)
})

test('pi2dsh smoke treats the compatibility manifest as its version source of truth', () => {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), 'test', 'compat', 'pi2dsh.json'), 'utf8'))
  assert.doesNotThrow(() => validateManifest(manifest))
  assert.throws(() => validateManifest({ ...manifest, pi2dshVersion: 'not-a-version' }), /exact pi2dsh version/u)
  assert.throws(() => validateManifest({ ...manifest, dshVersion: 'not-a-version' }), /exact target DSH version/u)
})

test('the required contracts are derived from the production extension surface, not hand-written', () => {
  // The published pi2dsh bridge hosts Pi components ONLY when the host
  // reports the CURRENT apiVersion and advertises the unstable raw-surface
  // capability; on any other api version it logs a warning and mounts no
  // component, so a contract list frozen at an older api version would
  // certify a pairing the bridge cannot use. The required list therefore
  // follows the production constants, and the manifest must carry exactly
  // that list.
  assert.ok(REQUIRED_CONTRACTS.includes(`apiVersion=${API_VERSION}`),
    'the required contracts must name the production api version')
  assert.ok(REQUIRED_CONTRACTS.includes(`extensions/unstable.UNSTABLE_API_LEVEL=${UNSTABLE_API_LEVEL}`),
    'the required contracts must name the production unstable API level')
  assert.equal(REQUIRED_CONTRACTS.includes('apiVersion=1'), API_VERSION === 1,
    'the required contracts must not carry a stale api version')

  const manifest = JSON.parse(readFileSync(join(process.cwd(), 'test', 'compat', 'pi2dsh.json'), 'utf8'))
  for (const contract of REQUIRED_CONTRACTS) {
    assert.ok(manifest.contracts.includes(contract), `the manifest must declare ${contract}`)
  }
  // The stale v1 contract is refused: a manifest still naming it would pass
  // the real runtime smoke (the host does report v2) while recording a
  // contract the bridge never negotiated.
  const stale = { ...manifest, contracts: manifest.contracts.filter(contract => contract !== `apiVersion=${API_VERSION}`) }
  assert.throws(() => validateManifest(stale), /missing a required contract/u)
})

test('official preset validation is independent of pi2dsh consumer metadata', () => {
  assert.equal(validateTargetDshManifest({ dshVersion: '0.1.2-alpha.1' }), '0.1.2-alpha.1')
  assert.doesNotThrow(() => validateTargetDshManifest({ dshVersion: '0.1.2-alpha.1', consumer: 'unreleased-bridge' }))
  assert.throws(() => validateTargetDshManifest({ dshVersion: 'not-a-version' }), /exact target DSH version/u)
  assert.equal(typeof smokeOfficialPresetMounts, 'function', 'the real official matrix must be independently callable')
  assert.equal(officialPresetStatusCommand(), '/preset status')
  assert.equal(officialPresetStatusVisible('ptc', 'preset: ptc · default: ptc'), true)
  assert.equal(officialPresetStatusVisible('ptc', 'preset: standard · default: ptc'), false)
})

test('pi2dsh metadata preflight blocks an unsupported consumer contract', () => {
  const manifest = { dshVersion: '0.1.2-alpha.1' }
  const candidate = { name: '@xmoon76/dsh-pi-tui', version: '0.4.0-alpha.1' }
  const supported = {
    name: 'pi2dsh',
    version: '0.23.0',
    peerDependencies: {
      '@xmoon76/dsh-pi-tui': '^0.4.0-alpha.1',
      '@deepseek-ai/dsh-agent': '>=0.1.2-alpha.1',
      '@deepseek-ai/dsh-commands': '>=0.1.2-alpha.1',
    },
  }
  assert.doesNotThrow(() => validateConsumerMetadata(supported, manifest, candidate))

  // A DSH peer mismatch and a missing dsh-peer set stay BLOCKING.
  for (const consumerPackage of [
    { ...supported, peerDependencies: { ...supported.peerDependencies, '@deepseek-ai/dsh-agent': '^0.1.1' } },
    { ...supported, peerDependencies: { '@xmoon76/dsh-pi-tui': '^0.4.0-alpha.1' } },
  ]) {
    assert.throws(
      () => validateConsumerMetadata(consumerPackage, manifest, candidate),
      error => error?.name === 'CompatFailure'
        && error?.phase === 'ECOSYSTEM_CONTRACT_BLOCKER'
        && error.message.includes('DSH 0.1.2-alpha.1')
        && error.message.includes('@xmoon76/dsh-pi-tui 0.4.0-alpha.1'),
    )
  }
})

test('pi2dsh metadata preflight classifies the four peer-declaration cases', () => {
  const manifest = { dshVersion: '0.1.2-alpha.1' }
  const candidate = { name: '@xmoon76/dsh-pi-tui', version: '0.4.0-alpha.1' }
  const base = {
    name: 'pi2dsh',
    version: '0.24.0',
    peerDependencies: {
      '@xmoon76/dsh-pi-tui': '^0.4.0-alpha.1',
      '@deepseek-ai/dsh-agent': '>=0.1.2-alpha.1',
      '@deepseek-ai/dsh-commands': '>=0.1.2-alpha.1',
    },
  }

  // 1. TUI peer current + DSH peers covering → ok.
  assert.equal(classifyConsumerMetadata(base, manifest, candidate).kind, 'ok')

  // 2. TUI peer stale ONLY (DSH peers still cover) → stale-tui-peer, not thrown.
  const stale = { ...base, peerDependencies: { ...base.peerDependencies, '@xmoon76/dsh-pi-tui': '^0.3.3' } }
  const classification = validateConsumerMetadata(stale, manifest, candidate)
  assert.equal(classification.kind, 'stale-tui-peer')
  assert.equal(classification.tuiRange, '^0.3.3')
  // The narrow allowance is required: without it the preflight still blocks.
  assert.throws(
    () => failConsumerMetadata(stale, manifest, candidate, [`  @xmoon76/dsh-pi-tui: ${classification.tuiRange}`]),
    error => error?.name === 'CompatFailure' && error?.phase === 'ECOSYSTEM_CONTRACT_BLOCKER',
  )

  // 3. TUI peer MISSING entirely → block (never a stale range: "declared too
  // old" can be proven stale by the runtime smoke, "never declared" cannot).
  const missing = { ...base, peerDependencies: { '@deepseek-ai/dsh-agent': '>=0.1.2-alpha.1' } }
  const missingClassification = classifyConsumerMetadata(missing, manifest, candidate)
  assert.equal(missingClassification.kind, 'block')
  assert.match(missingClassification.problems.join('\n'), /@xmoon76\/dsh-pi-tui: \(missing\)/)

  // 4. DSH peer mismatch → block, never classified as stale.
  const dshMismatch = classifyConsumerMetadata(
    { ...base, peerDependencies: { ...base.peerDependencies, '@deepseek-ai/dsh-agent': '^0.1.1' } },
    manifest,
    candidate,
  )
  assert.equal(dshMismatch.kind, 'block')
})

test('pi2dsh metadata classifies a published DSH peer set that excludes rc1 as a typed unsupported peer case', () => {
  const manifest = { dshVersion: '0.2.2-rc.1', pi2dshVersion: '0.28.0-next.1' }
  const candidate = { name: '@xmoon76/dsh-pi-tui', version: '0.5.6' }
  const published = {
    name: 'pi2dsh',
    version: '0.28.0-next.1',
    peerDependencies: {
      '@xmoon76/dsh-pi-tui': '^0.5.1',
      '@deepseek-ai/dsh-agent': '0.2.2-alpha.3',
      '@deepseek-ai/dsh-commands': '0.2.2-alpha.3',
    },
  }
  const classification = classifyConsumerMetadata(published, manifest, candidate)
  assert.equal(classification.kind, 'unsupported-dsh-peer')
  assert.deepEqual(classification.peers.map(([name]) => name), ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-commands'])
  // The default preflight still BLOCKS this classification; only the narrow
  // PR-only caller decision may turn it into a typed skip.
  assert.throws(
    () => validateConsumerMetadata(published, manifest, candidate),
    error => error?.name === 'CompatFailure'
      && error?.phase === 'ECOSYSTEM_CONTRACT_BLOCKER'
      && error.message.includes('DSH 0.2.2-rc.1')
      && error.message.includes('@deepseek-ai/dsh-agent: 0.2.2-alpha.3'),
  )

  // A truly compatible published peer set is `ok` and must proceed to the
  // REAL PTY smoke, never to a typed skip.
  const compatible = {
    ...published,
    peerDependencies: { ...published.peerDependencies, '@deepseek-ai/dsh-agent': '0.2.2-rc.1', '@deepseek-ai/dsh-commands': '>=0.2.2-rc.1' },
  }
  assert.equal(classifyConsumerMetadata(compatible, manifest, candidate).kind, 'ok')
  assert.equal(unsupportedDshPeerSkipAllowed({
    classification: classifyConsumerMetadata(compatible, manifest, candidate),
    skipRequested: true,
    ref: 'refs/pull/464/merge',
    dispositionFile: '/tmp/disposition',
  }), false, 'a compatible pairing is never skipped')
})

test('the typed unsupported-DSH-peer skip is allowed only for an explicit PR ref', () => {
  const manifest = { dshVersion: '0.2.2-rc.1', pi2dshVersion: '0.28.0-next.1' }
  const candidate = { name: '@xmoon76/dsh-pi-tui', version: '0.5.6' }
  const unsupported = {
    name: 'pi2dsh',
    version: '0.28.0-next.1',
    peerDependencies: {
      '@xmoon76/dsh-pi-tui': '^0.5.1',
      '@deepseek-ai/dsh-agent': '0.2.2-alpha.3',
    },
  }
  const classification = classifyConsumerMetadata(unsupported, manifest, candidate)
  assert.equal(classification.kind, 'unsupported-dsh-peer')
  // PR + explicit flag + a disposition path: allowed.
  assert.equal(unsupportedDshPeerSkipAllowed({
    classification, skipRequested: true, ref: 'refs/pull/464/merge', dispositionFile: '/tmp/disposition',
  }), true)
  // Every other combination fails closed into the blocking preflight.
  for (const entry of [
    { name: 'flag missing', skipRequested: false, ref: 'refs/pull/464/merge' },
    { name: 'release tag', skipRequested: true, ref: 'refs/tags/v0.5.6' },
    { name: 'prerelease tag', skipRequested: true, ref: 'refs/tags/next-v0.5.6-alpha.1' },
    { name: 'main branch', skipRequested: true, ref: 'refs/heads/main' },
    { name: 'comp branch', skipRequested: true, ref: 'refs/heads/comp/dsh-0.2.2' },
    { name: 'plain pull prefix', skipRequested: true, ref: 'refs/pull/464' },
    { name: 'malformed PR ref', skipRequested: true, ref: 'refs/pull/x/merge' },
    { name: 'missing ref', skipRequested: true, ref: undefined },
    { name: 'empty ref', skipRequested: true, ref: '' },
  ]) {
    assert.equal(unsupportedDshPeerSkipAllowed({
      classification, skipRequested: entry.skipRequested, ref: entry.ref, dispositionFile: '/tmp/disposition',
    }), false, entry.name)
  }
  // The skip also needs a usable disposition path; without it the caller must
  // fail closed instead of exiting successfully with nothing to read.
  for (const dispositionFile of [undefined, '', null]) {
    assert.equal(unsupportedDshPeerSkipAllowed({
      classification, skipRequested: true, ref: 'refs/pull/464/merge', dispositionFile,
    }), false, `dispositionFile=${JSON.stringify(dispositionFile)}`)
  }
  assert.equal(isPullRequestRef('refs/pull/1/merge'), true)
  assert.equal(isPullRequestRef('refs/pull/1/head'), false)
  assert.equal(isPullRequestRef('refs/heads/refs/pull/1/merge'), false)
  assert.equal(skipUnsupportedDshPeerOnPrArgument(['--skip-unsupported-dsh-peer-on-pr']), true)
  assert.equal(skipUnsupportedDshPeerOnPrArgument(['--allow-stale-tui-peer']), false)
})

test('the unsupported-DSH-peer classification demands that nothing else is wrong', () => {
  const manifest = { dshVersion: '0.2.2-rc.1', pi2dshVersion: '0.28.0-next.1' }
  const candidate = { name: '@xmoon76/dsh-pi-tui', version: '0.5.6' }
  const base = {
    name: 'pi2dsh',
    version: '0.28.0-next.1',
    peerDependencies: {
      '@xmoon76/dsh-pi-tui': '^0.5.1',
      '@deepseek-ai/dsh-agent': '0.2.2-alpha.3',
    },
  }
  const kindOf = (consumerPackage) => classifyConsumerMetadata(consumerPackage, manifest, candidate).kind

  // Missing DSH peers, missing/invalid/stale TUI peer, malformed metadata,
  // invalid DSH ranges and an unpinned consumer identity all stay BLOCKING.
  assert.equal(kindOf({ ...base, peerDependencies: { '@xmoon76/dsh-pi-tui': '^0.5.1' } }), 'block')
  assert.equal(kindOf({ ...base, peerDependencies: { ...base.peerDependencies, '@xmoon76/dsh-pi-tui': undefined } }), 'block')
  assert.equal(kindOf({ ...base, peerDependencies: { ...base.peerDependencies, '@xmoon76/dsh-pi-tui': 'not a range' } }), 'block')
  assert.equal(kindOf({ ...base, peerDependencies: { ...base.peerDependencies, '@xmoon76/dsh-pi-tui': '^0.4.0' } }), 'block')
  assert.equal(kindOf({ ...base, peerDependencies: 'broken' }), 'block')
  assert.equal(kindOf({ ...base, peerDependencies: { ...base.peerDependencies, '@deepseek-ai/dsh-agent': 'not a range' } }), 'block')
  assert.equal(kindOf({ ...base, peerDependencies: { ...base.peerDependencies, '@deepseek-ai/dsh-tools': 42 } }), 'block',
    'a non-string DSH peer range is broken metadata, not a typed peer mismatch')
  assert.equal(kindOf({ ...base, peerDependencies: { ...base.peerDependencies, '@deepseek-ai/dsh-session': '' } }), 'block')
  assert.equal(kindOf({ ...base, version: '0.28.0' }), 'block')
  assert.equal(kindOf({ ...base, name: 'other-bridge' }), 'block')
  assert.equal(kindOf(null), 'block')
  assert.equal(kindOf({ ...base, peerDependencies: { ...base.peerDependencies, '@deepseek-ai/dsh-agent': '^0.2.2-alpha.3' } }), 'ok',
    'a peer set that covers rc1 is compatible even with the alpha.3 floor range')
})

test('the pi2dsh disposition path is explicit, absolute and transport-safe', (t) => {
  const life = testLifecycle(t)
  const directory = life.tempDir('pi2dsh-disposition-')
  const previous = process.env.PI2DSH_COMPAT_DISPOSITION_FILE
  delete process.env.PI2DSH_COMPAT_DISPOSITION_FILE
  try {
    assert.equal(dispositionFileArgument([]), undefined)
    assert.equal(dispositionFileArgument(['--disposition-file', join(directory, 'disposition')]), join(directory, 'disposition'))
    assert.throws(() => dispositionFileArgument(['--disposition-file', 'relative-disposition']), /must be absolute/u)
    assert.throws(() => dispositionFileArgument(['--disposition-file', '--allow-stale-tui-peer']), /requires an absolute temp file path/u)
    process.env.PI2DSH_COMPAT_DISPOSITION_FILE = join(directory, 'from-env')
    assert.equal(dispositionFileArgument([]), join(directory, 'from-env'))
    assert.equal(dispositionFileArgument(['--disposition-file', join(directory, 'explicit')]), join(directory, 'explicit'),
      'the explicit CLI option wins over the environment')
  } finally {
    if (previous === undefined) delete process.env.PI2DSH_COMPAT_DISPOSITION_FILE
    else process.env.PI2DSH_COMPAT_DISPOSITION_FILE = previous
  }

  // Exactly two dispositions are transportable, and the write is atomic.
  assert.deepEqual([...PI2DSH_COMPAT_DISPOSITIONS].sort(), ['passed', 'skipped-unsupported-dsh-peer'])
  const passedPath = join(directory, 'passed')
  writeDispositionFile(passedPath, 'passed')
  assert.equal(readFileSync(passedPath, 'utf8'), 'passed\n')
  const skippedPath = join(directory, 'skipped')
  writeDispositionFile(skippedPath, 'skipped-unsupported-dsh-peer')
  assert.equal(readFileSync(skippedPath, 'utf8'), 'skipped-unsupported-dsh-peer\n')
  assert.throws(() => writeDispositionFile(skippedPath, 'PASSED'), /unknown pi2dsh compatibility disposition/u)
  assert.doesNotThrow(() => writeDispositionFile(undefined, 'passed'))
})

test('pi2dsh preset checks inspect the filtered /help frame rather than stale pane text', () => {
  const goalPane = [
    'transcript mentioned /goal before the overlay',
    '╭────────────────────────╮',
    '│ > goal                 │',
    '│                        │',
    '│ ❯ /goal               │',
    '│                        │',
    '│ Type to search · Enter/Space to change · Esc to cancel │',
    '╰────────────────────────╯',
  ].join('\n')
  assert.deepEqual(settingsSearchSnapshot(goalPane), {
    searchVisible: true,
    query: 'goal',
    commandRows: ['/goal'],
    noMatches: false,
  })

  const minimalPane = [
    'transcript mentioned /goal before the overlay',
    '╭────────────────────────╮',
    '│ > goal                 │',
    '│ No matching settings   │',
    '│ Type to search · Enter/Space to change · Esc to cancel │',
    '╰────────────────────────╯',
  ].join('\n')
  assert.deepEqual(settingsSearchSnapshot(minimalPane), {
    searchVisible: true,
    query: 'goal',
    commandRows: [],
    noMatches: true,
  })

  // A capturing overlay is composited over the host frame, so the overlay's
  // left border can share a line with stale host text. The parser must slice
  // the inner frame before looking for query text or command rows.
  const compositedPane = [
    '╭──────────────────────────────────────────────────────────────────────────────╮',
    '│ 🐋  session session-1                                                        │',
    '│ de╭──────────────────────────────────────────────────────────────────────╮   │',
    '│ /h│ >                                                                    │   │',
    '╰───│                                                                      │───╯',
    '    │   (1/48)                                                             │',
    '────│   Type to search · Enter/Space to change · Esc to cancel             │────',
    '❯   ╰──────────────────────────────────────────────────────────────────────╯',
  ].join('\n')
  assert.deepEqual(settingsSearchSnapshot(compositedPane), {
    searchVisible: true,
    query: '',
    commandRows: [],
    noMatches: false,
  })

  const compositedGoalPane = [
    '╭──────────────────────────────────────────────────────────────────────────────╮',
    '│ 🐋  session session-1                                                        │',
    '│ de╭──────────────────────────────────────────────────────────────────────╮   │',
    '│ /h│ > goal                                                               │   │',
    '╰───│ ›/goal                                                             │───╯',
    '    │                                                                      │',
    '────│   Type to search · Enter/Space to change · Esc to cancel             │────',
    '❯   ╰──────────────────────────────────────────────────────────────────────╯',
  ].join('\n')
  assert.deepEqual(settingsSearchSnapshot(compositedGoalPane), {
    searchVisible: true,
    query: 'goal',
    commandRows: ['/goal'],
    noMatches: false,
  })
})

test('pi2dsh preset degradation diagnostics never count as a healthy mount', () => {
  assert.equal(presetDegradationLine('preset mounted successfully'), undefined)
  assert.equal(
    presetDegradationLine('tui-runner: launch preset unavailable; falling back to default'),
    'tui-runner: launch preset unavailable; falling back to default',
  )
  assert.equal(
    presetDegradationLine('skill catalog unavailable for preset standard'),
    'skill catalog unavailable for preset standard',
  )
})

test('pi2dsh preset smoke requires a durable canonical session header', (t) => {
  const life = testLifecycle(t)
  const directory = life.tempDir('pi2dsh-compat-header-')
  const evidencePath = join(directory, 'header.json')
  writeFileSync(evidencePath, JSON.stringify({ sessionId: 'session-1', agentPreset: 'minimal' }))
  assert.doesNotThrow(() => assertOfficialPresetHeader('minimal', evidencePath))
  writeFileSync(evidencePath, JSON.stringify({ sessionId: 'session-1', agentPreset: 'standard' }))
  assert.throws(
    () => assertOfficialPresetHeader('minimal', evidencePath),
    error => error?.phase === 'COMPAT_BOOT_FAILURE' && error.message.includes('durable header mismatch'),
  )
  writeFileSync(evidencePath, JSON.stringify({ sessionId: 'session-1', error: 'inspect failed' }))
  assert.throws(
    () => assertOfficialPresetHeader('minimal', evidencePath),
    error => error?.phase === 'COMPAT_BOOT_FAILURE' && error.message.includes('durable header probe failed'),
  )
})

test('pi2dsh smoke classifies resize failures as surface failures', () => {
  assert.equal(RESIZE_FAILURE_PHASE, 'COMPAT_SURFACE_FAILURE')
  assert.equal(hasFreshResizeWidth([80, 96], [80]), true, 'a new allocated width proves resize propagation')
  assert.equal(hasFreshResizeWidth([80, 96], [80, 96]), false, 'pre-existing widths cannot satisfy the resize check')
  assert.equal(hasFreshResizeWidth([80, 0], [80]), false, 'non-positive widths cannot satisfy the resize check')
})

test('pi2dsh smoke keeps the aggregate budget below the CI job ceiling', () => {
  assert.ok(GATE_BUDGET_MS > 0, 'the compatibility gate must have a positive budget')
  assert.ok(GATE_BUDGET_MS + CLEANUP_BUDGET_MS < CI_ECOSYSTEM_TIMEOUT_MS, 'gate plus cleanup must fit under the CI timeout')
})

test('pi2dsh smoke retries only transient registry failures', () => {
  assert.equal(isRetryableRegistryFailure({ status: 1, stderr: 'ERR_PNPM_FETCH_404 Not Found' }), false, 'not-found failures are permanent')
  assert.equal(isRetryableRegistryFailure({ status: 1, stderr: 'ERR_PNPM_META_FETCH_FAIL ECONNRESET' }), true, 'connection resets are transient')
  assert.equal(isRetryableRegistryFailure({ status: 1, stderr: 'request timed out while contacting the registry' }), true, 'network timeouts are transient')
  assert.equal(isRetryableRegistryFailure({ status: 1, stderr: 'ERR_PNPM_META_FETCH_FAIL 401 Unauthorized' }), false, 'authentication failures are permanent')
})

test('pi2dsh smoke redacts retry diagnostics', () => {
  const message = retryDiagnostic('pi2dsh@0.20.0?token=retry-secret')
  assert.ok(!message.includes('retry-secret'), 'retry output must not expose a secret-bearing spec')
  assert.match(message, /retrying registry install/u)
})

test('pi2dsh smoke scans side-effect, dynamic, and relative fixture imports', () => {
  const fixturePath = join(process.cwd(), 'test', 'fixtures', 'pi2dsh-compat', 'index.mjs')
  assert.ok(fixtureImportViolations(fixturePath, 'import "@xmoon76/dsh-pi-tui/extensions/unstable"').length > 0, 'host imports must be rejected')
  assert.ok(fixtureImportViolations(fixturePath, 'import(`@xmoon76/dsh-pi-tui/${name}`)').length > 0, 'dynamic template imports must be rejected')
  assert.ok(fixtureImportViolations(fixturePath, 'import("../../../src/private")').length > 0, 'relative repository imports must be rejected')
  assert.ok(fixtureImportViolations(fixturePath, 'import(name)').length > 0, 'non-literal dynamic imports must be rejected')
  assert.ok(fixtureImportViolations(fixturePath, 'import()').length > 0, 'empty dynamic imports must be rejected')
  assert.ok(fixtureImportViolations(fixturePath, 'import "pi2dsh"; import "lodash"').length > 0, 'non-public bare packages must be rejected')
  assert.ok(fixtureImportViolations(fixturePath, 'import /*comment*/("@xmoon76/dsh-pi-tui/extensions/unstable")').length > 0, 'commented dynamic host imports must be rejected')
  assert.ok(fixtureImportViolations(fixturePath, 'require /*comment*/("@xmoon76/pi-tui")').length > 0, 'commented require host imports must be rejected')
  assert.ok(fixtureImportViolations(fixturePath, 'import { createRequire as load } from "node:module"; load("@xmoon76/dsh-pi-tui")').length > 0, 'createRequire loaders must be rejected')
  assert.ok(fixtureImportViolations(fixturePath, 'const load = require; load("@xmoon76/dsh-pi-tui")').length > 0, 'aliased require loaders must be rejected')
  assert.ok(fixtureImportViolations(fixturePath, 'process.getBuiltinModule("node:module")').length > 0, 'builtin loader access must be rejected')
  assert.ok(fixtureImportViolations(fixturePath, 'process["dlopen"](path)').length > 0, 'computed dlopen access must be rejected')
  assert.ok(fixtureImportViolations(fixturePath, 'process["mainModule"]').length > 0, 'computed mainModule access must be rejected')
  assert.ok(fixtureImportViolations(fixturePath, 'eval?.("code")').length > 0, 'optional indirect eval must be rejected')
  assert.ok(fixtureImportViolations(fixturePath, '(0, eval)("code")').length > 0, 'indirect eval must be rejected')
  assert.ok(fixtureImportViolations(fixturePath, 'globalThis["eval"]("code")').length > 0, 'computed global eval must be rejected')
  assert.ok(fixtureImportViolations(fixturePath, 'import "node:module"').length > 0, 'module loader builtins must be rejected')
  assert.deepEqual(fixtureImportViolations(fixturePath, '// createRequire and Function( are documentation\nconst note = "process[\\\"dlopen\\\"]"'), [], 'comments and strings must not trigger loader bans')
  assert.deepEqual(fixtureImportViolations(fixturePath, 'import "node:fs"; import "./local.mjs"'), [], 'public builtins and fixture-local imports are allowed')
})

test('pi2dsh smoke validates fixture package metadata before installation', () => {
  const valid = {
    name: 'dsh-pi2dsh-compat-fixture',
    version: '0.0.0',
    private: true,
    type: 'module',
    pi: { extensions: ['index.mjs'] },
  }
  assert.doesNotThrow(() => validateFixturePackageData(valid))
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'scripts', 'exports']) {
    assert.throws(() => validateFixturePackageData({ ...valid, [key]: {} }), /unsupported metadata|unexpected identity/u, `${key} must be rejected`)
  }
})

test('pi2dsh smoke redacts common credential forms from diagnostics', () => {
  const secrets = [
    'bearer-secret',
    'basic-secret',
    'npm-secret',
    'url-secret',
    'query-secret',
    'aws-secret',
  ]
  const output = redact([
    'Authorization: Bearer bearer-secret',
    'Authorization=Basic basic-secret',
    'NPM_TOKEN=npm-secret',
    'https://user:url-secret@example.test/',
    'https://example.test/?access_token=query-secret',
    'AWS_SECRET_ACCESS_KEY=aws-secret',
  ].join('\n'))
  for (const secret of secrets) {
    assert.ok(!output.includes(secret), `diagnostics must not expose ${secret}`)
  }
  assert.match(output, /\[REDACTED\]/u, 'redacted diagnostics must retain an explicit marker')
})

test('pi2dsh smoke detects published fallback diagnostics without false positives', () => {
  assert.equal(compatibilityFailureLine('ordinary fallback text'), undefined, 'ordinary TUI text must not fail the gate')
  assert.equal(compatibilityFailureLine('component fallback is available'), undefined, 'benign component fallback text must not fail the gate')
  assert.equal(compatibilityFailureLine('TUI fallback is available'), undefined, 'benign TUI fallback text must not fail the gate')
  assert.ok(compatibilityFailureLine('fallback to headless mode') !== undefined, 'an unprefixed headless fallback must fail the gate')
  assert.ok(compatibilityFailureLine('capability mismatch: unstable surface') !== undefined, 'an unprefixed capability mismatch must fail the gate')
  assert.ok(compatibilityFailureLine('[pi2dsh] unsupported surface capability') !== undefined, 'a prefixed pi2dsh capability failure must fail the gate')
  assert.ok(compatibilityFailureLine('pi2dsh degraded to headless') !== undefined, 'explicit pi2dsh headless degradation must fail the gate')
  assert.ok(compatibilityFailureLine('surface degraded to inert') !== undefined, 'explicit surface inert degradation must fail the gate')
})

test('pi2dsh smoke rechecks late lifecycle diagnostics', (t) => {
  const life = testLifecycle(t)
  const directory = life.tempDir('pi2dsh-compat-diagnostics-')
  const logPath = join(directory, 'tui.log')
  for (const phase of ['raw input', 'resize', 'dispose']) {
    writeFileSync(logPath, `${phase}: surface degraded to inert\n`)
    assert.throws(
      () => assertNoCompatibilityFailures(logPath, { capturePane: () => '' }),
      error => error?.phase === 'COMPAT_BOOT_FAILURE',
      `${phase} diagnostics must fail the compatibility check`,
    )
  }
})

test('pi2dsh smoke bounds a hung subprocess', () => {
  const result = run(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { timeout: 25 })
  assert.equal(result.status, null, 'a timed-out child must not report a successful exit')
  assert.equal(result.error?.code, 'ETIMEDOUT', 'a hung child must be classified as a timeout')
})

test('pi2dsh smoke terminates descendants of a timed-out subprocess', { skip: process.platform === 'win32' }, async (t) => {
  const life = testLifecycle(t)
  const directory = life.tempDir('pi2dsh-compat-process-')
  const childPidPath = join(directory, 'child.pid')
  let childPid
  const childCode = [
    "const { spawn } = require('node:child_process')",
    "const { writeFileSync } = require('node:fs')",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore' })",
    'writeFileSync(process.argv[1], String(child.pid))',
    'setInterval(() => {}, 10000)',
  ].join(';')
  const result = run(process.execPath, ['-e', childCode, childPidPath], { timeout: 500 })
  assert.equal(result.error?.code, 'ETIMEDOUT', 'the parent process must time out')
  childPid = Number(readFileSync(childPidPath, 'utf8'))
  life.defer(() => {
    try {
      process.kill(childPid, 'SIGKILL')
    } catch {
      // The descendant was already terminated by the process-group cleanup.
    }
  })
  assert.ok(Number.isInteger(childPid) && childPid > 0, 'the timed-out child must have started a descendant')

  const deadline = Date.now() + 2_000
  let alive = true
  while (Date.now() < deadline) {
    try {
      process.kill(childPid, 0)
    } catch (error) {
      if (error?.code === 'ESRCH') {
        alive = false
        break
      }
      throw error
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(alive, false, 'a timed-out process group must not leave its descendant running')
})
