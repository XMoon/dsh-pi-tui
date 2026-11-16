/**
 * Split-process upgrade smoke wiring guard.
 *
 * The real dual-artifact lane is `scripts/split-process-upgrade-smoke.mjs`. It
 * needs two genuinely packaged `.tgz` payloads and a real installation of the
 * exact DSH runtime this checkout pins, so it stays an explicit manual
 * qualification lane. This test only proves the registry, selector grammar,
 * preflight ordering, case ownership and output/cleanup contracts; it is NOT
 * evidence that U01-U09 passed.
 *
 * @module split-process-upgrade-smoke-wiring.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { testLifecycle } from '../support/temp-lifecycle.ts'

import {
  allowsSameArtifactVersion,
  parseUpgradeArguments,
  projectSelectedUpgradeVerdicts,
} from '../../scripts/split-process-upgrade-smoke.mjs'
import {
  listDefaultUpgradeCases,
  listSelectableUpgradeCases,
  selectedUpgradePassLine,
} from '../../scripts/lib/split-upgrade-selection.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'split-process-upgrade-smoke.mjs')
const CASE_DIR = join(ROOT, 'scripts', 'smoke', 'split-upgrade')
const CASE_NAMES = Object.freeze([
  'cross-build-compatibility.mjs',
  'manual-client-reload.mjs',
  'reload-source-isolation.mjs',
  'managed-daemon-upgrade.mjs',
])

function readCase(name) {
  return readFileSync(join(CASE_DIR, name), 'utf8')
}

function withTempDir(t) {
  return testLifecycle(t).tempDir('split-upgrade-wiring-')
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd,
    timeout: 10_000,
    env: { ...process.env, TMPDIR: cwd },
  })
}

test('the upgrade smoke is a package script and parses as ESM', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts?.['smoke:split-upgrade'], 'node scripts/split-process-upgrade-smoke.mjs')
  const result = spawnSync(process.execPath, ['--check', SCRIPT], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('the upgrade registry is the ONE frozen 4-case / 3-suite fact list in execution order', () => {
  const registry = listSelectableUpgradeCases()
  assert.ok(Object.isFrozen(registry), 'the registry must be frozen')
  assert.deepEqual(registry.map(entry => [entry.suite, entry.id]), [
    ['upgrade', 'upgrade.cross-build-compatibility'],
    ['client-reload', 'client-reload.production-command'],
    ['client-reload', 'client-reload.target-source-isolation'],
    ['managed-daemon', 'managed-daemon.cross-build-upgrade-rollback'],
  ])
  assert.equal(new Set(registry.map(entry => entry.id)).size, 4, 'case ids must be unique')
  for (const entry of registry) {
    assert.ok(Object.isFrozen(entry), `the registry entry ${entry.id} must be frozen`)
    assert.deepEqual(Object.keys(entry).sort(),
      entry.defaultLane === false ? ['defaultLane', 'id', 'run', 'suite', 'title'] : ['id', 'run', 'suite', 'title'])
    assert.equal(typeof entry.run, 'function', `the registry entry ${entry.id} must name its real run`)
    assert.ok(entry.title.length > 0 && !/\bU0[1-9]\b/u.test(entry.title),
      'titles state a condition and observable behavior, never an internal Uxx code')
  }
  // The default lane keeps its historical U01-U09 meaning: the native case is
  // opt-in only and is never silently skipped or counted as covered.
  assert.deepEqual(listDefaultUpgradeCases().map(entry => entry.id), [
    'upgrade.cross-build-compatibility',
    'client-reload.production-command',
    'client-reload.target-source-isolation',
  ])
  assert.equal(listSelectableUpgradeCases().find(entry => entry.id === 'managed-daemon.cross-build-upgrade-rollback').defaultLane, false)
  assert.equal(selectedUpgradePassLine('upgrade.cross-build-compatibility'),
    'SPLIT_UPGRADE_SELECTED_PASS id=upgrade.cross-build-compatibility scope=SELECTABLE_ONLY')
})

test('the selector grammar accepts the fixed forms and rejects every ambiguous one', () => {
  const full = parseUpgradeArguments(['--', '--old', 'old.tgz', '--new', 'new.tgz'])
  assert.equal(full.mode, 'full')
  assert.equal(full.old, resolve('old.tgz'))
  assert.equal(full.new, resolve('new.tgz'))
  assert.equal(full.evidence, undefined)

  const ordered = parseUpgradeArguments(['--new', 'new.tgz', '--evidence', 'ev.json', '--old', 'old.tgz'])
  assert.equal(ordered.evidence, resolve('ev.json'), 'old/new/evidence order stays free')

  assert.deepEqual(parseUpgradeArguments(['--list']), { mode: 'list' })
  assert.deepEqual(parseUpgradeArguments(['--help']), { mode: 'help' })
  assert.deepEqual(parseUpgradeArguments(['-h']), { mode: 'help' })

  const caseSelection = parseUpgradeArguments([
    '--old', 'old.tgz', '--new', 'new.tgz', '--case', 'upgrade.cross-build-compatibility',
  ])
  assert.equal(caseSelection.mode, 'case')
  assert.equal(caseSelection.id, 'upgrade.cross-build-compatibility')
  assert.deepEqual(caseSelection.cases.map(entry => entry.id), ['upgrade.cross-build-compatibility'])

  const upgradeSuite = parseUpgradeArguments([
    '--old', 'old.tgz', '--new', 'new.tgz', '--suite', 'upgrade',
  ])
  assert.deepEqual(upgradeSuite.cases.map(entry => entry.id), ['upgrade.cross-build-compatibility'])

  const clientReloadSuite = parseUpgradeArguments([
    '--old', 'old.tgz', '--new', 'new.tgz', '--suite', 'client-reload',
  ])
  assert.deepEqual(clientReloadSuite.cases.map(entry => entry.id), [
    'client-reload.production-command',
    'client-reload.target-source-isolation',
  ], 'a suite follows the registry execution order')

  const inputError = (args, pattern) => assert.throws(
    () => parseUpgradeArguments(args),
    error => error?.code === 'INPUT_SMOKE_SELECTION_INVALID' && pattern.test(error.message),
  )
  inputError(['--case', 'does-not-exist', '--old', 'old.tgz', '--new', 'new.tgz'], /unknown case/u)
  inputError(['--suite', 'does-not-exist', '--old', 'old.tgz', '--new', 'new.tgz'], /unknown suite/u)
  inputError(['--old', 'old.tgz', '--new', 'new.tgz', '--case', 'upgrade.cross-build-compatibility', '--suite', 'upgrade'],
    /mutually exclusive/u)
  inputError(['--old', 'old.tgz', '--new', 'new.tgz', '--case', 'upgrade.cross-build-compatibility', '--case', 'upgrade.cross-build-compatibility'],
    /--case may appear only once/u)
  inputError(['--old', 'old.tgz', '--new', 'new.tgz', '--suite', 'client-reload', '--suite', 'upgrade'],
    /--suite may appear only once/u)
  inputError(['--list', '--old', 'old.tgz'], /--list cannot be combined/u)
  inputError(['--help', '--list'], /--help cannot be combined/u)
  inputError(['--old', 'old.tgz'], /both --old <tgz> and --new <tgz> are required/u)
  inputError(['--old', 'same.tgz', '--new', 'same.tgz'], /must name different artifacts/u)
  inputError(['--old', '--new', 'new.tgz'], /--old requires a path/u)
  inputError(['--old', 'old.tgz', '--new', 'new.tgz', '--bogus'], /unknown option/u)
  inputError(['--old', 'old.tgz', '--new', 'new.tgz', 'extra.tgz'], /unexpected positional/u)
  inputError(['--', '--', '--old', 'old.tgz', '--new', 'new.tgz'], /unknown option/u)
})

test('only an exclusively opt-in native selection may pair one package version', () => {
  const pairing = (...selector) => parseUpgradeArguments(['--old', 'old.tgz', '--new', 'new.tgz', ...selector])
  assert.equal(allowsSameArtifactVersion(pairing()), false, 'the full lane keeps the different-version input rule')
  assert.equal(allowsSameArtifactVersion(pairing('--case', 'upgrade.cross-build-compatibility')), false)
  assert.equal(allowsSameArtifactVersion(pairing('--suite', 'client-reload')), false)
  assert.equal(allowsSameArtifactVersion(pairing('--case', 'managed-daemon.cross-build-upgrade-rollback')), true)
  assert.equal(allowsSameArtifactVersion(pairing('--suite', 'managed-daemon')), true)
  assert.equal(allowsSameArtifactVersion(parseUpgradeArguments(['--list'])), false)
})

test('a selected native verdict never becomes a pass unless it really qualified', () => {
  const native = 'managed-daemon.cross-build-upgrade-rollback'
  const notVerified = projectSelectedUpgradeVerdicts([{
    id: native,
    defaultLane: false,
    status: 'NOT_VERIFIED',
    reason: 'NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: no isolated user manager',
  }])
  assert.equal(notVerified.failed, true)
  assert.deepEqual(notVerified.lines, [
    `SPLIT_UPGRADE_SELECTED_NOT_VERIFIED id=${native} scope=SELECTABLE_ONLY reason=NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: no isolated user manager`,
  ])
  assert.ok(!notVerified.lines.some(line => line.startsWith('SPLIT_UPGRADE_SELECTED_PASS')))

  const wrongScope = projectSelectedUpgradeVerdicts([{ id: native, defaultLane: false, status: 'PASS', scope: 'SELECTABLE_ONLY' }])
  assert.equal(wrongScope.failed, true)
  assert.ok(!wrongScope.lines.some(line => line.startsWith('SPLIT_UPGRADE_SELECTED_PASS')))

  const qualified = projectSelectedUpgradeVerdicts([{ id: native, defaultLane: false, status: 'PASS', scope: 'REAL_SYSTEMD_USER_L6' }])
  assert.equal(qualified.failed, false)
  assert.deepEqual(qualified.lines, [selectedUpgradePassLine(native)])

  // The historical default-lane cases keep their historical successful line.
  const historical = projectSelectedUpgradeVerdicts([{ id: 'upgrade.cross-build-compatibility', defaultLane: true, status: 'PASS' }])
  assert.equal(historical.failed, false)
  assert.deepEqual(historical.lines, [selectedUpgradePassLine('upgrade.cross-build-compatibility')])
})

test('both artifacts are pin-qualified and the default-lane version rule runs before any work root', (t) => {
  const dir = withTempDir(t)
  const targetPin = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).devDependencies['@deepseek-ai/dsh-agent']
  const writeArtifact = (name, version, dshPin) => {
    const source = join(dir, `source-${name}`)
    mkdirSync(join(source, 'package'), { recursive: true })
    writeFileSync(join(source, 'package', 'package.json'), JSON.stringify({
      name: '@xmoon76/dsh-pi-tui',
      version,
      // Distinguishes the fixture artifacts so same-version candidates still
      // carry different packaged bytes, exactly like two real builds.
      description: `fixture artifact ${name}`,
      devDependencies: { '@deepseek-ai/dsh-agent': dshPin },
    }))
    const artifact = join(dir, `${name}.tgz`)
    const tar = spawnSync('tar', ['-czf', artifact, '-C', source, 'package'], { encoding: 'utf8' })
    assert.equal(tar.status, 0, tar.stderr)
    rmSync(source, { recursive: true, force: true })
    return artifact
  }
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 30_000,
    env: { ...process.env, TMPDIR: dir },
  })
  // The failure report is the ONE allowed artifact (a private directory under
  // TMPDIR); no work root, harness install or profile may appear.
  const workEntries = () => readdirSync(dir)
    .filter(name => !name.endsWith('.tgz') && !name.startsWith('dsh-pi-tui-smoke-failure-'))

  const pinnedNew = writeArtifact('new', '0.5.7', targetPin)
  const wrongPinOld = writeArtifact('wrong-old', '0.5.6', '0.2.2-rc.2')
  const sameVersionOld = writeArtifact('same-old', '0.5.7', targetPin)
  const sameVersionWrongPinNew = writeArtifact('same-wrong-new', '0.5.7', '0.2.2-rc.2')

  const wrongPin = run(['--old', wrongPinOld, '--new', pinnedNew])
  assert.notEqual(wrongPin.status, 0, 'a differently pinned artifact must be refused')
  assert.match(wrongPin.stderr, /INPUT_DSH_PIN_MISMATCH/u)
  assert.deepEqual(workEntries(), [], 'pin qualification must happen before any work root or installation')

  const sameVersionFull = run(['--old', sameVersionOld, '--new', pinnedNew])
  assert.notEqual(sameVersionFull.status, 0, 'the full lane must keep the different-version rule')
  assert.match(sameVersionFull.stderr, /must carry different package versions/u)
  assert.deepEqual(workEntries(), [], 'the default-lane version rule must run before any work root or installation')

  // The opt-in native selection is the only one that skips the version rule;
  // its artifacts are still pin-qualified before any profile work.
  const nativeWrongPin = run([
    '--old', sameVersionOld, '--new', sameVersionWrongPinNew,
    '--case', 'managed-daemon.cross-build-upgrade-rollback',
  ])
  assert.notEqual(nativeWrongPin.status, 0, 'the native selection must still refuse a differently pinned artifact')
  assert.match(nativeWrongPin.stderr, /INPUT_DSH_PIN_MISMATCH/u)
  assert.deepEqual(workEntries(), [], 'the native selection must pin-qualify before any profile work')
  for (const artifact of [pinnedNew, wrongPinOld, sameVersionOld, sameVersionWrongPinNew]) {
    assert.ok(existsSync(artifact), 'the preflight must not remove its input artifacts')
  }
})

test('--list and --help are side-effect free and never announce a qualification', (t) => {
  const dir = withTempDir(t)
  const listed = runCli(['--list'], dir)
  assert.equal(listed.status, 0, listed.stderr)
  assert.equal(listed.stderr, '')
  const lines = listed.stdout.trimEnd().split('\n')
  assert.equal(lines[0], 'SPLIT_UPGRADE_SELECTABLE_CASES scope=SELECTABLE_ONLY')
  assert.deepEqual(lines.slice(1), listSelectableUpgradeCases().map(
    entry => `suite=${entry.suite} case=${entry.id} title=${entry.title}`,
  ))
  assert.ok(lines.some(line => line.includes('case=managed-daemon.cross-build-upgrade-rollback')),
    '--list must name the opt-in native case')
  assert.ok(!listed.stdout.includes('SPLIT_UPGRADE_SMOKE_PASS'))
  assert.ok(!listed.stdout.includes('SPLIT_UPGRADE_SELECTED_PASS'))
  assert.ok(!listed.stdout.includes('IDENTITY') && !listed.stdout.includes('qualified=true'))
  assert.deepEqual(readdirSync(dir), [], '--list may not create a work root or failure report')

  const helped = runCli(['--help'], dir)
  assert.equal(helped.status, 0, helped.stderr)
  assert.match(helped.stdout, /pnpm smoke:split-upgrade -- --list/u)
  assert.match(helped.stdout, /--case upgrade\.cross-build-compatibility/u)
  assert.match(helped.stdout, /--suite client-reload/u)
  assert.deepEqual(readdirSync(dir), [], '--help may not create a work root')
})

test('the cross-build case owns the real old/new pair, reexec handoff and both live negatives', () => {
  const source = readCase('cross-build-compatibility.mjs')
  // The active profile owns the exact Client peer set before the old bundle.
  const store = source.indexOf('installPlugin(dsh, `@deepseek-ai/dsh-client-store@${targetDshVersion}`')
  const zustand = source.indexOf("installPlugin(dsh, 'zustand@4.5.7'")
  const immer = source.indexOf("installPlugin(dsh, 'immer@10.2.0'")
  const oldBundle = source.indexOf('installPlugin(dsh, oldArtifact.path')
  assert.ok(store >= 0 && zustand > store && immer > zustand && oldBundle > immer,
    'the profile peer set is installed before the old bundle')
  assert.match(source, /assertProfileClientPeers\(profileDir, targetDshVersion, 'old profile install'\)/u)
  assert.match(source, /assertProfileClientPeers\(profileDir, targetDshVersion, 'upgraded profile install'\)/u)
  assert.match(source, /newBuildId !== oldBuildId/u)
  assert.match(source, /installedPayloadHash\(oldProfilePackage\)/u)
  assert.match(source, /sideBuildDir = join\(dshHome, 'profiles', 'split-upgrade-side-build'\)/u)
  assert.match(source, /installSideBuild\(sideBuildDir, newArtifact\.path, env, targetDshVersion\)/u)
  const support = readFileSync(join(ROOT, 'scripts', 'lib', 'split-upgrade-support.mjs'), 'utf8')
  const sideBuild = support.slice(support.indexOf('export function installSideBuild'), support.indexOf('export function killProcessGroup'))
  assert.match(sideBuild, /'@deepseek-ai\/dsh-client-store': targetDshVersion/u)
  assert.match(sideBuild, /zustand: '4\.5\.7'/u)
  assert.match(sideBuild, /immer: '10\.2\.0'/u)
  assert.doesNotMatch(sideBuild, /@deepseek-ai\/cordis|'@deepseek-ai\/dsh':/u,
    'the side-build must not copy the DSH family or a second Cordis')

  // U07 fixed qualification inputs and negatives (behaviour is owned by E3).
  assert.match(source, /SPLIT_PROCESS_CLIENT_REEXEC_PROBE: '1'/u)
  assert.match(source, /SPLIT_PROCESS_CLIENT_REEXEC_TARGET_PACKAGE_ROOT: sideBuildPackagePath/u)
  // Negative 1: wrong expected Host never connects.
  assert.match(source, /SPLIT_PROCESS_CLIENT_EXPECTED_INSTANCE_ID: randomUUID\(\)/u)
  assert.match(source, /HOST_IDENTITY_MISMATCH/u)
  // Negative 2: the injected child failure is forwarded only to the child.
  assert.match(source, /SPLIT_PROCESS_CLIENT_REEXEC_CHILD_FAILURE: 'client-bootstrap'/u)
  assert.match(source, /qualification forced client bootstrap failure/u)
  // Case-owned failure injection and cleanup.
  assert.match(source, /failpoint\('upgrade\.cross-build-compatibility\.after-old-host-spawn'\)/u)
  assert.match(source, /\} finally \{/u)
  assert.match(source, /stopHostForCleanup\(host\)/u)
  assert.doesNotMatch(source, /copyFileSync|cpSync/u)
  assert.doesNotMatch(source, /writeFileSync\(.*newArtifact\.path/u)
  // The historical Full JSON compatibility summary stays owned by the real
  // cross-build case; selected U08/U09 fragments never carry it.
  const compatibility = source.slice(
    source.indexOf('fragment.compatibility = {'),
    source.indexOf('return fragment'),
  )
  for (const field of [
    "protocol: 'dsh-pi-tui/local/1'",
    'dshVersion: targetDshVersion',
    'oldBuildId,',
    'newBuildId,',
    'differentBundleVersions: oldArtifact.manifest.version !== newArtifact.manifest.version',
    'differentBuildIds: oldBuildId !== newBuildId',
    'sameProtocol: true',
    'sameDshRuntime: true',
  ]) {
    assert.ok(compatibility.includes(field), `the Full compatibility evidence must keep ${field}`)
  }
  const manual = readCase('manual-client-reload.mjs')
  const isolation = readCase('reload-source-isolation.mjs')
  assert.ok(!manual.includes('compatibility:') && !isolation.includes('compatibility:'),
    'selected U08/U09 cases must not synthesize a cross-build compatibility summary')
})

test('the production /reload-client case never uses a signal or override for the user command', () => {
  const source = readCase('manual-client-reload.mjs')
  assert.match(source, /send\('\/reload-client\\r'\)/u)
  assert.doesNotMatch(source, /SPLIT_PROCESS_CLIENT_REEXEC_PROBE|SPLIT_PROCESS_CLIENT_REEXEC_TARGET_PACKAGE_ROOT/u,
    'the U08 production command must never set the qualification override')
  assert.equal(source.indexOf('signalBusiness('), -1, 'U08 must never simulate the user command with SIGUSR2')
  assert.match(source, /installPlugin\(dsh, newArtifact\.path, harnessDir, env, false\)/u)
  assert.match(source, /assertProfileClientPeers\(profileDir, targetDshVersion, 'U08 upgraded profile install'\)/u)
  assert.match(source, /productionTargetResolvedFromProfile: true/u)
  assert.match(source, /qualificationTargetOverrideUsed: false/u)
  assert.match(source, /alreadyCurrentKeptOldSurface: true/u)
  assert.match(source, /attachmentsKeptOldSurface: true/u)
  // The destructive target-invalid round runs the official remove transaction.
  assert.match(source, /'plugin', '--profile', 'pi-tui', 'remove', EXPECTED_PACKAGE_NAME/u)
  assert.match(source, /Client reload failed: the installed replacement Client is unavailable or incompatible/u)
  assert.match(source, /installedTargetOfficiallyRemoved: true/u)
  assert.match(source, /failpoint\('client-reload\.production-command\.after-host-spawn'\)/u)
  assert.match(source, /registerIsolatedHome\(dshHome\)/u)
  // Both rounds land in ONE case-owned cleanup boundary.
  assert.match(source, /export async function runManualClientReload\(context\)/u)
  assert.match(source, /return \{ userCommandReload, userCommandReloadTargetInvalid \}/u)
})

test('the target-source-isolation case proves both entries in ONE live Client process', () => {
  const source = readCase('reload-source-isolation.mjs')
  assert.match(source, /SPLIT_PROCESS_CLIENT_REEXEC_PROBE: '1'/u)
  assert.match(source, /SPLIT_PROCESS_CLIENT_REEXEC_TARGET_PACKAGE_ROOT: sideNewPackage/u)
  assert.match(source, /send\('\/reload-client\\r'\)/u)
  assert.match(source, /signalBusiness\('SIGUSR2'\)/u)
  assert.match(source, /Client reload skipped: this Client already runs the installed build/u)
  assert.match(source, /assertEqual\(client\.records\.filter\(record => record\.m4r === 'handoff-requested'\)\.length, 0/u)
  assert.match(source, /qualificationRequested\.source, 'qualification'/u)
  assert.match(source, /qualificationRequested\.targetBuildId, sideNewBuildId/u)
  assert.match(source, /replacementRestored\.clientBuildId, sideNewBuildId/u)
  assert.match(source, /manualResolvedProfileOnly: true/u)
  assert.match(source, /manualNeverReachedProcessStop: true/u)
  assert.match(source, /qualificationUsedOverride: true/u)
  assert.match(source, /failpoint\('client-reload\.target-source-isolation\.after-host-spawn'\)/u)
  assert.match(source, /registerIsolatedHome\(dshHome\)/u)
})

test('the extracted upgrade modules resolve every free identifier', () => {
  const files = [
    'scripts/split-process-upgrade-smoke.mjs',
    'scripts/lib/split-upgrade-selection.mjs',
    'scripts/lib/split-upgrade-support.mjs',
    'scripts/smoke/split-upgrade/cross-build-compatibility.mjs',
    'scripts/smoke/split-upgrade/manual-client-reload.mjs',
    'scripts/smoke/split-upgrade/reload-source-isolation.mjs',
    'scripts/smoke/split-upgrade/managed-daemon-upgrade.mjs',
  ].map(file => join(ROOT, file))
  const program = ts.createProgram({
    rootNames: files,
    options: {
      allowJs: true,
      checkJs: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
      strict: false,
      noImplicitAny: false,
      types: ['node'],
    },
  })
  const unresolved = ts.getPreEmitDiagnostics(program)
    .filter(diagnostic => diagnostic.code === 2304)
    .map(diagnostic => `${basename(diagnostic.file?.fileName ?? 'unknown')}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`)
  assert.deepEqual(unresolved, [], 'a moved helper or process constructor must never become a free variable')
})


test('the runner owns ONE harness/setup boundary, ONE scope and the registered-home backstop', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  assert.doesNotMatch(source, /extraIsolatedHomes/u, 'the module-level mutable home list must be gone')
  assert.match(source, /const isolatedHomes = new Set\(\)/u)
  assert.match(source, /const registerIsolatedHome = path => \{ isolatedHomes\.add\(path\) \}/u)
  assert.match(source, /for \(const isolatedHome of isolatedHomes\) killIsolatedProcesses\(isolatedHome\)/u)
  assert.match(source, /SPLIT_UPGRADE_FAILPOINT_CLEANUP leftovers=/u)
  assert.match(source, /SPLIT_UPGRADE_FAILPOINT_CLEANUP_OK/u)
  assert.match(source, /for \(const run of \[\.\.\.activeProcesses\]\)/u)
  assert.match(source, /else if \(!KEEP\) \{\n\s+rmSync\(workRoot/u)
  // The shared DSH CLI harness is installed exactly once in the runner.
  assert.equal((source.match(/runPnpmInstall\(harnessDir, env, distribution\)/gu) ?? []).length, 1)
  assert.equal((source.match(/loadDshDistribution\(/gu) ?? []).length, 1)
  assert.doesNotMatch(source, /installPlugin\(/u, 'cases own their profile installs; the runner must not')
})

test('the failure report path stays bounded and keeps the --evidence FAIL twin', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  assert.match(source, /diagnostics = createSmokeDiagnostics\(\{[\s\S]{0,300}lane: 'split-upgrade'/u)
  assert.match(source, /process\.stderr\.write\(`\$\{diagnostics\.identityLine\(\)\}\\n`\)/u)
  assert.match(source, /emitInputFailure\(\{[\s\S]{0,200}evidencePath: options\?\.evidence/u)
  assert.match(source, /SPLIT_PROCESS_UPGRADE_SMOKE_FAILURE: \$\{safeFailureSummary\(error\)\}/u)
  // The raw caught error is part of the default output; KEEP only preserves the
  // scene and no FORENSICS-only branch exists anymore.
  assert.match(source, /process\.stderr\.write\(`\$\{error instanceof Error \? \(error\.stack \?\? `\$\{error\.name\}: \$\{error\.message\}`\) : String\(error \?\? ''\)\}\\n`\)/u)
  assert.doesNotMatch(source, /FORENSICS/u)
  assert.doesNotMatch(source, /forensicErrorText/u)
  assert.match(source, /export \{ waitForAcceptedHandoff, waitForReloadNotice \} from '\.\/lib\/split-upgrade-support\.mjs'/u,
    'the shared diagnostics tooling keeps its single import path')
  const support = readFileSync(join(ROOT, 'scripts', 'lib', 'split-upgrade-support.mjs'), 'utf8')
  assert.equal((support.match(/export async function waitForReloadNotice/gu) ?? []).length, 1)
  assert.equal((support.match(/export async function waitForAcceptedHandoff/gu) ?? []).length, 1)
  // The 120s historical C1 wait default survives as an explicit Upgrade wrapper.
  assert.match(support, /export async function waitForUpgradeC1WorkEvent\(workRoot, predicate, label, timeoutMs = 120_000\)/u)
})

test('the extracted upgrade modules import without starting a lane', (t) => {
  const dir = withTempDir(t)
  const urls = [
    'scripts/lib/split-upgrade-selection.mjs',
    'scripts/lib/split-upgrade-support.mjs',
    ...CASE_NAMES.map(name => `scripts/smoke/split-upgrade/${name}`),
    'scripts/split-process-upgrade-smoke.mjs',
  ].map(relative => JSON.stringify(pathToFileURL(join(ROOT, relative)).href))
  const probe = `for (const url of [${urls.join(', ')}]) await import(url)`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    encoding: 'utf8',
    timeout: 15_000,
    cwd: dir,
    env: { ...process.env, TMPDIR: dir },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '', 'an import must not announce a checkpoint, identity or PASS')
  assert.deepEqual(readdirSync(dir), [], 'an import may not create a work root or report directory')
})
