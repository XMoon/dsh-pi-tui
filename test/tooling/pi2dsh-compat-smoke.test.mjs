import assert from 'node:assert/strict'
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { join } from 'node:path'

import { testLifecycle } from '../support/temp-lifecycle.ts'
import {
  candidateArgument,
  compatibilityFailureLine,
  isolatedEnvironment,
  isRetryableRegistryFailure,
  redact,
  requireExactVersion,
  resolveTarball,
  retryDiagnostic,
  run,
  validateCandidatePackageData,
} from '../../scripts/lib/dsh-smoke-harness.mjs'
import {
  assertNoPi2dshSurfaceFailures,
  CI_ECOSYSTEM_TIMEOUT_MS,
  CLEANUP_BUDGET_MS,
  fixtureImportViolations,
  forcePeersArgument,
  GATE_BUDGET_MS,
  hasFreshResizeWidth,
  pi2dshCompatibilityFailureLine,
  resolvePublishedPairing,
  RESIZE_FAILURE_PHASE,
  validateFixturePackageData,
} from '../../scripts/pi2dsh-compat-smoke.mjs'
import { selectPublishedPi2dshPairing } from '../../scripts/lib/pi2dsh-compat-selection.mjs'

// ---------------------------------------------------------------------------
// The published-pairing selector (pure, no registry I/O).
// ---------------------------------------------------------------------------

const TUI_VERSION = '0.5.6'

function candidateTui({ peers = {}, engines } = {}) {
  return {
    name: '@xmoon76/dsh-pi-tui',
    version: TUI_VERSION,
    peerDependencies: peers,
    ...(engines === undefined ? {} : { engines }),
  }
}

function publishedBridge({ version = '0.28.0', tuiPeer = '^0.5.0', peers = {} } = {}) {
  return {
    name: 'pi2dsh',
    version,
    peerDependencies: {
      '@xmoon76/dsh-pi-tui': tuiPeer,
      ...peers,
    },
  }
}

test('the selector picks the highest published DSH intersection, not the checkout target', () => {
  const selection = selectPublishedPi2dshPairing({
    consumerPackage: publishedBridge({ peers: {
      '@deepseek-ai/dsh-agent': '>=0.2.0',
      '@deepseek-ai/dsh-commands': '>=0.2.1',
    } }),
    candidatePackage: candidateTui({ peers: { '@deepseek-ai/dsh-agent': '>=0.2.1' } }),
    publishedDshVersions: ['0.2.0', '0.2.3', '0.2.1'],
  })
  assert.deepEqual(selection, { pi2dshVersion: '0.28.0', dshVersion: '0.2.3', tuiPeerDrift: false })
})

test('npm prerelease rules decide whether a published prerelease is selectable', () => {
  const versions = ['0.2.1', '0.2.2-rc.1']
  assert.equal(selectPublishedPi2dshPairing({
    consumerPackage: publishedBridge({ peers: { '@deepseek-ai/dsh-agent': '>=0.2.0' } }),
    candidatePackage: candidateTui(),
    publishedDshVersions: versions,
  }).dshVersion, '0.2.1', 'a bare >= range must not admit a prerelease of another tuple')
  assert.equal(selectPublishedPi2dshPairing({
    consumerPackage: publishedBridge({ peers: { '@deepseek-ai/dsh-agent': '>=0.2.2-rc.1' } }),
    candidatePackage: candidateTui(),
    publishedDshVersions: versions,
  }).dshVersion, '0.2.2-rc.1', 'a matching prerelease comparator must admit it')
})

test('any unsatisfied DSH family peer excludes that version', () => {
  const selection = selectPublishedPi2dshPairing({
    consumerPackage: publishedBridge({ peers: {
      '@deepseek-ai/dsh-agent': '>=0.2.0',
      '@deepseek-ai/dsh-commands': '>=0.2.3',
    } }),
    candidatePackage: candidateTui({ peers: { '@deepseek-ai/dsh-session': '>=0.2.0' } }),
    publishedDshVersions: ['0.2.2', '0.2.3'],
  })
  assert.equal(selection.dshVersion, '0.2.3')

  assert.throws(() => selectPublishedPi2dshPairing({
    consumerPackage: publishedBridge({ peers: { '@deepseek-ai/dsh-agent': '>=0.2.0' } }),
    candidatePackage: candidateTui({ peers: { '@deepseek-ai/dsh-session': '^0.3.0' } }),
    publishedDshVersions: ['0.2.2', '0.2.3'],
  }), /no installable published DSH intersection/u)
})

test('a lagging TUI peer is a drift warning, not a reason to drop a runnable DSH', () => {
  const selection = selectPublishedPi2dshPairing({
    consumerPackage: publishedBridge({
      tuiPeer: '^0.4.0',
      peers: { '@deepseek-ai/dsh-agent': '>=0.2.0' },
    }),
    candidatePackage: candidateTui(),
    publishedDshVersions: ['0.2.2'],
  })
  assert.equal(selection.tuiPeerDrift, true)
  assert.equal(selection.dshVersion, '0.2.2')
})

test('invalid metadata and an empty intersection fail with a diagnosable reason', () => {
  const consumer = publishedBridge({ peers: { '@deepseek-ai/dsh-agent': '>=0.2.0' } })
  const candidate = candidateTui()
  const versions = ['0.2.0']
  const cases = [
    [{ ...consumer, name: 'other-bridge' }, candidate, versions, /not 'pi2dsh'/u],
    [{ ...consumer, version: 'latest' }, candidate, versions, /exact semver/u],
    [{ ...consumer, peerDependencies: 'broken' }, candidate, versions, /peerDependencies is not an object/u],
    [{ ...consumer, peerDependencies: {} }, candidate, versions, /does not declare a @xmoon76\/dsh-pi-tui peer/u],
    [{ ...consumer, peerDependencies: { '@xmoon76/dsh-pi-tui': 'not a range' } }, candidate, versions, /invalid semver range/u],
    [consumer, candidate, [], /empty or not an array/u],
    [consumer, candidate, ['0.2.0', 'latest'], /not an exact semver/u],
    [publishedBridge({ peers: { '@deepseek-ai/dsh-agent': '^0.3.0' } }), candidate, versions, /no installable published DSH intersection/u],
    [consumer, candidateTui({ peers: { '@deepseek-ai/dsh-agent': 'not a range' } }), versions, /invalid semver range/u],
  ]
  for (const [consumerPackage, candidatePackage, publishedDshVersions, expected] of cases) {
    assert.throws(
      () => selectPublishedPi2dshPairing({ consumerPackage, candidatePackage, publishedDshVersions }),
      expected,
    )
  }
})

test('engines.dsh uses includePrerelease semantics, separately from peer ranges', () => {
  // No DSH peers at all: only engines.dsh can admit the prerelease.
  assert.equal(selectPublishedPi2dshPairing({
    consumerPackage: publishedBridge(),
    candidatePackage: candidateTui({ engines: { dsh: '>=0.2.2-rc.1' } }),
    publishedDshVersions: ['0.2.1', '0.2.2-rc.1'],
  }).dshVersion, '0.2.2-rc.1')
  // A peer range keeps npm's default rule: engines.dsh must not rescue a
  // version the peer excludes, so this pair has no intersection at all.
  assert.throws(() => selectPublishedPi2dshPairing({
    consumerPackage: publishedBridge(),
    candidatePackage: candidateTui({
      peers: { '@deepseek-ai/dsh-agent': '>=0.2.0' },
      engines: { dsh: '>=0.2.2-rc.1' },
    }),
    publishedDshVersions: ['0.2.1', '0.2.2-rc.1'],
  }), /no installable published DSH intersection/u)
})

test('a package that declares no DSH peer gets no invented constraint', () => {
  const selection = selectPublishedPi2dshPairing({
    consumerPackage: publishedBridge(),
    candidatePackage: candidateTui(),
    publishedDshVersions: ['0.1.0', '0.2.0'],
  })
  assert.equal(selection.dshVersion, '0.2.0')
})

test('investigative mode skips only the bridge DSH peers, never the candidate constraints', () => {
  const consumer = publishedBridge({ peers: { '@deepseek-ai/dsh-agent': '^0.3.0' } })
  const versions = ['0.2.0', '0.2.1']
  assert.throws(() => selectPublishedPi2dshPairing({
    consumerPackage: consumer,
    candidatePackage: candidateTui(),
    publishedDshVersions: versions,
  }), /no installable published DSH intersection/u)
  assert.equal(selectPublishedPi2dshPairing({
    consumerPackage: consumer,
    candidatePackage: candidateTui(),
    publishedDshVersions: versions,
    investigativeForcePeers: true,
  }).dshVersion, '0.2.1')
  assert.equal(selectPublishedPi2dshPairing({
    consumerPackage: consumer,
    candidatePackage: candidateTui({ peers: { '@deepseek-ai/dsh-agent': '>=0.2.1' } }),
    publishedDshVersions: versions,
    investigativeForcePeers: true,
  }).dshVersion, '0.2.1', 'the candidate DSH peers still apply in investigative mode')
})

// ---------------------------------------------------------------------------
// The script path: registry metadata fetch -> selection -> exact install spec.
// ---------------------------------------------------------------------------

const LATEST_VIEW = 'view pi2dsh@latest --json --registry=https://registry.npmjs.org'
const DSH_VERSIONS_VIEW = 'view @deepseek-ai/dsh versions --json --registry=https://registry.npmjs.org'

function injectedRun(responses) {
  return (command, args) => {
    assert.equal(command, 'npm')
    const response = responses[args.join(' ')]
    if (response === undefined) {
      return { status: 1, stdout: '', stderr: `unexpected npm invocation: ${args.join(' ')}` }
    }
    return { status: 0, stdout: typeof response === 'string' ? response : JSON.stringify(response), stderr: '' }
  }
}

test('the registry fetch -> selection -> install spec path freezes the exact pair', () => {
  const resolution = resolvePublishedPairing({
    candidatePackage: candidateTui({ peers: { '@deepseek-ai/dsh-agent': '>=0.2.1' } }),
    env: {},
    runCommand: injectedRun({
      [LATEST_VIEW]: publishedBridge({ peers: { '@deepseek-ai/dsh-agent': '>=0.2.0' } }),
      [DSH_VERSIONS_VIEW]: ['0.2.1', '0.2.3'],
    }),
  })
  assert.equal(resolution.pi2dshVersion, '0.28.0')
  assert.equal(resolution.dshVersion, '0.2.3')
  assert.equal(resolution.bridgeSpec, 'pi2dsh@0.28.0', 'the bridge install uses the resolved exact version, never latest')
  assert.equal(resolution.dshFamilySpec, '@deepseek-ai/dsh@0.2.3', 'the DSH family pin uses the resolved exact version')
  assert.equal(resolution.tuiPeerDrift, false)
})

test('the same path fails closed when no published DSH satisfies both sides', () => {
  assert.throws(() => resolvePublishedPairing({
    candidatePackage: candidateTui({ peers: { '@deepseek-ai/dsh-agent': '>=0.2.2-rc.1' } }),
    env: {},
    runCommand: injectedRun({
      [LATEST_VIEW]: publishedBridge({ peers: { '@deepseek-ai/dsh-agent': '^0.2.1-rc.2' } }),
      [DSH_VERSIONS_VIEW]: ['0.2.1-rc.2', '0.2.2-rc.1'],
    }),
  }), error => error?.name === 'CompatFailure'
    && error?.phase === 'ECOSYSTEM_CONTRACT_BLOCKER'
    && /no installable published DSH intersection/u.test(error.message)
    && /0\.2\.1-rc\.2/u.test(error.message), 'the failure must name the actual metadata')
})

test('registry failures and malformed metadata are infrastructure failures', () => {
  assert.throws(() => resolvePublishedPairing({
    candidatePackage: candidateTui(),
    env: {},
    runCommand: () => ({ status: 1, stdout: '', stderr: 'registry unreachable' }),
  }), error => error?.phase === 'INFRA_INSTALL_FAILURE' && /could not be read/u.test(error.message))

  assert.throws(() => resolvePublishedPairing({
    candidatePackage: candidateTui(),
    env: {},
    runCommand: injectedRun({ [LATEST_VIEW]: 'not json', [DSH_VERSIONS_VIEW]: [] }),
  }), error => error?.phase === 'INFRA_INSTALL_FAILURE' && /invalid JSON/u.test(error.message))
})

test('the investigative selector flag is explicit and off by default', () => {
  const previous = process.env.PI2DSH_COMPAT_FORCE_PEERS
  try {
    delete process.env.PI2DSH_COMPAT_FORCE_PEERS
    assert.equal(forcePeersArgument([]), false)
    assert.equal(forcePeersArgument(['--force-peers']), true)
    process.env.PI2DSH_COMPAT_FORCE_PEERS = '1'
    assert.equal(forcePeersArgument([]), true)
  } finally {
    if (previous === undefined) delete process.env.PI2DSH_COMPAT_FORCE_PEERS
    else process.env.PI2DSH_COMPAT_FORCE_PEERS = previous
  }
})

// ---------------------------------------------------------------------------
// Shared harness behavior the consumer smoke relies on.
// ---------------------------------------------------------------------------

test('pi2dsh smoke isolates credential-bearing parent environment variables', () => {
  const canary = 'PI2DSH_COMPAT_TEST_SECRET'
  const previous = process.env[canary]
  process.env[canary] = 'must-not-reach-the-TUI'
  try {
    const env = isolatedEnvironment('/tmp/compat-work', '/tmp/compat-home', '/tmp/compat-dsh', '/tmp/evidence.json')
    assert.equal(env[canary], undefined, 'the isolated environment must not inherit arbitrary parent variables')
    assert.equal(env.HOME, '/tmp/compat-home', 'the TUI must receive the temporary HOME')
    assert.equal(env.DSH_HOME, '/tmp/compat-dsh', 'the TUI must receive the temporary DSH_HOME')
    assert.equal(env.DSH_SMOKE_EVIDENCE, '/tmp/evidence.json', 'the TUI must receive the isolated evidence path')
    assert.equal(env.DSH_SMOKE_HEADER_EVIDENCE, '/tmp/compat-work/header-evidence.json', 'the TUI must receive the isolated durable-header evidence path')
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
    'hyphen-secret',
    'hyphen-auth-secret',
    'hyphen-query-secret',
  ]
  const output = redact([
    'Authorization: Bearer bearer-secret',
    'Authorization=Basic basic-secret',
    'NPM_TOKEN=npm-secret',
    'https://user:url-secret@example.test/',
    'https://example.test/?access_token=query-secret',
    'AWS_SECRET_ACCESS_KEY=aws-secret',
    'x-token=hyphen-secret',
    'foo-authorization=hyphen-auth-secret',
    'https://example.test/?x-token=hyphen-query-secret',
    '  @deepseek-ai/dsh-credentials: 0.2.1-rc.2 || 0.2.1-rc.3',
    '  @deepseek-ai/dsh-authorization: >=0.2.2-rc.1',
  ].join('\n'))
  for (const secret of secrets) {
    assert.ok(!output.includes(secret), `diagnostics must not expose ${secret}`)
  }
  assert.match(output, /\[REDACTED\]/u, 'redacted diagnostics must retain an explicit marker')
  // Package peer names contain credential-like words; a redacted version range
  // would make the no-intersection diagnostic unexplainable.
  assert.match(output, /@deepseek-ai\/dsh-credentials: 0\.2\.1-rc\.2 \|\| 0\.2\.1-rc\.3/u)
  assert.match(output, /@deepseek-ai\/dsh-authorization: >=0\.2\.2-rc\.1/u)
})

test('the shared smoke failure detector is consumer-neutral', () => {
  assert.equal(compatibilityFailureLine('ordinary fallback text'), undefined, 'ordinary TUI text must not fail the gate')
  assert.equal(compatibilityFailureLine('component fallback is available'), undefined, 'benign component fallback text must not fail the gate')
  assert.equal(compatibilityFailureLine('TUI fallback is available'), undefined, 'benign TUI fallback text must not fail the gate')
  assert.ok(compatibilityFailureLine('fallback to headless mode') !== undefined, 'an unprefixed headless fallback must fail the gate')
  assert.ok(compatibilityFailureLine('capability mismatch: unstable surface') !== undefined, 'an unprefixed capability mismatch must fail the gate')
  assert.ok(compatibilityFailureLine('surface degraded to inert') !== undefined, 'explicit surface inert degradation must fail the gate')
  assert.equal(compatibilityFailureLine('[pi2dsh] unsupported surface capability'), undefined,
    'the shared detector must not claim a pi2dsh-specific diagnostic')
  assert.equal(compatibilityFailureLine('pi2dsh degraded to headless'), undefined,
    'the shared detector must not claim a pi2dsh-specific diagnostic')
})

test('the pi2dsh smoke keeps its own surface-failure diagnostics', () => {
  assert.ok(pi2dshCompatibilityFailureLine('[pi2dsh] unsupported surface capability') !== undefined, 'a prefixed pi2dsh capability failure must fail the pi2dsh gate')
  assert.ok(pi2dshCompatibilityFailureLine('pi2dsh degraded to headless') !== undefined, 'explicit pi2dsh headless degradation must fail the pi2dsh gate')
  assert.ok(pi2dshCompatibilityFailureLine('surface degraded to inert') !== undefined, 'a generic surface failure must still fail the pi2dsh gate')
  assert.equal(pi2dshCompatibilityFailureLine('ordinary fallback text'), undefined, 'benign text must not fail the pi2dsh gate')
})

test('pi2dsh smoke rechecks late lifecycle diagnostics', (t) => {
  const life = testLifecycle(t)
  const directory = life.tempDir('pi2dsh-compat-diagnostics-')
  const logPath = join(directory, 'tui.log')
  for (const phase of ['raw input', 'resize', 'dispose']) {
    writeFileSync(logPath, `${phase}: surface degraded to inert\n`)
    assert.throws(
      () => assertNoPi2dshSurfaceFailures(logPath, { capturePane: () => '' }),
      error => error?.phase === 'COMPAT_BOOT_FAILURE'
        && error.message.startsWith('published pi2dsh reported an incompatible surface:'),
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
