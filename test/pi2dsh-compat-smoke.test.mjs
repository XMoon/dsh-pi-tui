import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertNoCompatibilityFailures,
  candidateArgument,
  compatibilityFailureLine,
  fixtureImportViolations,
  hasFreshResizeWidth,
  isolatedEnvironment,
  isRetryableRegistryFailure,
  redact,
  requireExactVersion,
  retryDiagnostic,
  RESIZE_FAILURE_PHASE,
  validateCandidatePackageData,
  validateFixturePackageData,
  validateManifest,
  CI_ECOSYSTEM_TIMEOUT_MS,
  CLEANUP_BUDGET_MS,
  GATE_BUDGET_MS,
  run,
} from '../scripts/pi2dsh-compat-smoke.mjs'

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
  } finally {
    if (previous === undefined) delete process.env[canary]
    else process.env[canary] = previous
  }
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

test('pi2dsh smoke pins the required published compatibility baseline', () => {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), 'test', 'compat', 'pi2dsh.json'), 'utf8'))
  assert.doesNotThrow(() => validateManifest(manifest))
  assert.throws(() => validateManifest({ ...manifest, pi2dshVersion: '0.20.1' }), /must pin 0\.20\.0/u)
  assert.throws(() => validateManifest({ ...manifest, dshVersion: '0.1.1-rc.3' }), /must pin 0\.1\.1-rc\.2/u)
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

test('pi2dsh smoke rechecks late lifecycle diagnostics', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi2dsh-compat-diagnostics-'))
  const logPath = join(directory, 'tui.log')
  try {
    for (const phase of ['raw input', 'resize', 'dispose']) {
      writeFileSync(logPath, `${phase}: surface degraded to inert\n`)
      assert.throws(
        () => assertNoCompatibilityFailures(logPath, { capturePane: () => '' }),
        error => error?.phase === 'COMPAT_BOOT_FAILURE',
        `${phase} diagnostics must fail the compatibility check`,
      )
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('pi2dsh smoke bounds a hung subprocess', () => {
  const result = run(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { timeout: 25 })
  assert.equal(result.status, null, 'a timed-out child must not report a successful exit')
  assert.equal(result.error?.code, 'ETIMEDOUT', 'a hung child must be classified as a timeout')
})

test('pi2dsh smoke terminates descendants of a timed-out subprocess', { skip: process.platform === 'win32' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi2dsh-compat-process-'))
  const childPidPath = join(directory, 'child.pid')
  let childPid
  try {
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
  } finally {
    if (childPid !== undefined) {
      try {
        process.kill(childPid, 'SIGKILL')
      } catch {
        // The descendant was already terminated by the process-group cleanup.
      }
    }
    rmSync(directory, { recursive: true, force: true })
  }
})
