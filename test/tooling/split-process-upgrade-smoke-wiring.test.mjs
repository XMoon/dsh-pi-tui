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
import { readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { testLifecycle } from '../support/temp-lifecycle.ts'

import { parseUpgradeArguments } from '../../scripts/split-process-upgrade-smoke.mjs'
import {
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

test('the upgrade registry is the ONE frozen 3-case / 2-suite fact list in execution order', () => {
  const registry = listSelectableUpgradeCases()
  assert.ok(Object.isFrozen(registry), 'the registry must be frozen')
  assert.deepEqual(registry.map(entry => [entry.suite, entry.id]), [
    ['upgrade', 'upgrade.cross-build-compatibility'],
    ['client-reload', 'client-reload.production-command'],
    ['client-reload', 'client-reload.target-source-isolation'],
  ])
  assert.equal(new Set(registry.map(entry => entry.id)).size, 3, 'case ids must be unique')
  for (const entry of registry) {
    assert.ok(Object.isFrozen(entry), `the registry entry ${entry.id} must be frozen`)
    assert.deepEqual(Object.keys(entry).sort(), ['id', 'run', 'suite', 'title'])
    assert.equal(typeof entry.run, 'function', `the registry entry ${entry.id} must name its real run`)
    assert.ok(entry.title.length > 0 && !/\bU0[1-9]\b/u.test(entry.title),
      'titles state a condition and observable behavior, never an internal Uxx code')
  }
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
  assert.ok(!listed.stdout.includes('SPLIT_UPGRADE_SMOKE_PASS'))
  assert.ok(!listed.stdout.includes('IDENTITY') && !listed.stdout.includes('qualified=true'))
  assert.deepEqual(readdirSync(dir), [], '--list may not create a work root or failure report')

  const helped = runCli(['--help'], dir)
  assert.equal(helped.status, 0, helped.stderr)
  assert.match(helped.stdout, /pnpm smoke:split-upgrade -- --list/u)
  assert.match(helped.stdout, /--case upgrade\.cross-build-compatibility/u)
  assert.match(helped.stdout, /--suite client-reload/u)
  assert.deepEqual(readdirSync(dir), [], '--help may not create a work root')
})

test('artifact and selector preflight complete before any distribution load or work root', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  const lane = source.slice(source.indexOf('async function runLane()'))
  const parse = lane.indexOf('parseUpgradeArguments(process.argv.slice(2))')
  const inspectOld = lane.indexOf("inspectArtifact(options.old, 'old')")
  const inspectNew = lane.indexOf("inspectArtifact(options.new, 'new')")
  const pinOld = lane.indexOf("requireExactSmokeDshPin('old'")
  const pinNew = lane.indexOf("requireExactSmokeDshPin('new'")
  const identity = lane.indexOf('diagnostics.identityLine()')
  assert.ok(parse >= 0 && inspectOld > parse && inspectNew > inspectOld,
    'the selector and both artifacts are read before any setup')
  assert.ok(pinOld > inspectNew && pinNew > pinOld && identity > pinNew,
    'both exact pins qualify before the identity line is announced')
  const scene = source.slice(source.indexOf('async function runScene('))
  const distribution = scene.indexOf('loadDshDistribution(')
  const root = scene.search(/[A-Za-z]+Sync\(join\(tmpdir\(\), 'dsh-split-upgrade-'\)\)/u)
  const install = scene.indexOf('runPnpmInstall(harnessDir, env, distribution)')
  assert.ok(distribution >= 0 && root > distribution && install > root,
    'the distribution load and work root live inside the protected setup after preflight')
  assert.match(source, /workRoot = [A-Za-z]+Sync\(join\(tmpdir\(\), 'dsh-split-upgrade-'\)\)/u)
  assert.match(source, /relative\(realpathSync\(PACKAGE_ROOT\), realpathSync\(workRoot\)\)/u)
  assert.match(source, /workRootFromCheckout\.startsWith\(`\.\.\$\{sep\}`\)/u)
  assert.doesNotMatch(source, /join\(PACKAGE_ROOT, 'temp', 'split-upgrade-'\)/u)

  // The process scope is created exactly once, after input preflight, and is
  // never a module-level side effect (historical bug: scope at import time).
  const beforeScene = source.slice(0, source.indexOf('async function runScene('))
  assert.doesNotMatch(beforeScene, /createSplitProcessScope\(\)/u)
  assert.equal((source.match(/createSplitProcessScope\(\)/gu) ?? []).length, 1)
})

test('the full and selected lanes dispatch through the SAME registry functions', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  const scene = source.slice(source.indexOf('async function runScene('))
  assert.match(scene, /for \(const entry of listSelectableUpgradeCases\(\)\) \{\n\s+diagnostics\.checkpoint\(`case\/\$\{entry\.id\}`\)\n\s+const fragment = await entry\.run\(context\)/u)
  assert.match(scene, /for \(const entry of options\.cases\) \{\n\s+diagnostics\.checkpoint\(`case\/\$\{entry\.id\}`\)\n\s+const fragment = await entry\.run\(context\)/u)
  // No second execution list and no inline implementation survives in the runner.
  for (const legacy of [
    'runUserCommandReloadRound',
    'runUnavailableTargetRound',
    'runReloadSourceIsolationRound',
    'qualification-host-foundation',
    'host-rpc-proof',
    'crossBuildSurface',
  ]) {
    assert.ok(!source.includes(legacy), `the runner must not inline the case body: ${legacy}`)
  }
  // The registry imports the three real module functions.
  const selection = readFileSync(join(ROOT, 'scripts', 'lib', 'split-upgrade-selection.mjs'), 'utf8')
  for (const name of ['runCrossBuildCompatibility', 'runManualClientReload', 'runReloadSourceIsolation']) {
    assert.match(selection, new RegExp(`import \\{ ${name} \\} from`, 'u'))
    assert.match(selection, new RegExp(`run: ${name}`, 'u'))
  }
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

  // U07: a real SIGUSR2 handoff, new OS PID, restored same Host/Session.
  const reexec = source.indexOf("clientA.signalBusiness('SIGUSR2')")
  assert.ok(reexec > 0)
  assert.match(source, /SPLIT_PROCESS_CLIENT_REEXEC_PROBE: '1'/u)
  assert.match(source, /SPLIT_PROCESS_CLIENT_REEXEC_TARGET_PACKAGE_ROOT: sideBuildPackagePath/u)
  assert.match(source, /m4r === 'handoff-restored'/u)
  assert.match(source, /clientClosed\.sessionOpen, false/u)
  assert.match(source, /c1Restored\.clientBuildId, newBuildId/u)
  assert.match(source, /newOsPid: c1Pid !== clientAPid/u)
  // Negative 1: wrong expected Host never connects.
  assert.match(source, /SPLIT_PROCESS_CLIENT_EXPECTED_INSTANCE_ID: randomUUID\(\)/u)
  assert.match(source, /HOST_IDENTITY_MISMATCH/u)
  // Negative 2: the injected child failure is forwarded only to the child.
  assert.match(source, /SPLIT_PROCESS_CLIENT_REEXEC_CHILD_FAILURE: 'client-bootstrap'/u)
  assert.match(source, /qualification forced client bootstrap failure/u)
  // U02/U04 remain real cross-build qualification after the handoff.
  assert.ok(source.indexOf('qualification-host-foundation') > reexec)
  assert.ok(source.indexOf('host-rpc-proof') > reexec)
  assert.match(source, /assertIdentityKept\(clientBAuth\.host, hostABefore/u)
  assert.match(source, /clientBAuth\.host\.buildId === oldBuildId/u)
  assert.ok(source.indexOf('crossBuildSurface') > reexec)
  assert.match(source, /SPLIT_PROCESS_CLIENT_SESSION: sessionId/u)
  assert.match(source, /waitForScreen\('cross-build-hold'/u)
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

test('the cases snapshot failure handles before their own cleanup', () => {
  const runner = readFileSync(SCRIPT, 'utf8')
  assert.match(runner, /const failureProcesses = \[\]/u)
  assert.match(runner, /const captureFailure = handles => \{/u)
  assert.match(runner, /captureFailure,/u)
  const cross = readCase('cross-build-compatibility.mjs')
  assert.match(cross, /let detachedHost/u)
  assert.match(cross, /detachedHost = \{ pid: newHost\.hostPid, starttime: newHost\.hostStarttime, scopeDir: newScopeDir \}/u)
  assert.match(cross, /await stopRecordedHostForCleanup\(detachedHost\)/u)
  assert.match(cross, /captureFailure\(failureHandles\)/u)
  for (const name of ['manual-client-reload.mjs', 'reload-source-isolation.mjs']) {
    const source = readCase(name)
    assert.match(source, /context\.captureFailure\(\[\.\.\.hosts, \.\.\.clients\]\)/u)
  }
})

test('the manual reload case forwards the real process constructors into both rounds', () => {
  const source = readCase('manual-client-reload.mjs')
  assert.match(source, /const scope = \{ \.\.\.context, hosts, clients \}/u,
    'the case-local scope must carry every context field, including the process constructors')
  assert.match(source, /async function runUserCommandReloadRound\(context\) \{\n  const \{\n    EntryProcess, SurfaceEntryProcess,/u)
  assert.match(source, /async function runUnavailableTargetRound\(context\) \{\n  const \{\n    EntryProcess, SurfaceEntryProcess,/u)
})

test('the manual reload case keeps the second real old-build TUI through the cross-build reexec', () => {
  const source = readCase('manual-client-reload.mjs')
  const peerStart = source.indexOf("const peerClient = new SurfaceEntryProcess(join(sideOldPackage, 'dist', 'local-client.mjs')")
  const command = source.indexOf("reloadClient.send('/reload-client\\r')")
  assert.ok(peerStart > 0, 'U08 must start the second old-build Client from the real old installation')
  assert.ok(command > peerStart, 'the second Client must join Session X before `/reload-client` is sent')
  assert.match(source, /assertNotEqual\(peerPid, reloadClientPid/u)
  assert.match(source, /assertNotEqual\(peerClient\.child\.pid, reloadClient\.child\.pid/u)
  assert.match(source, /const assertPeerKept = \(label\) =>/u)
  assert.match(source, /record\.rootFiberUid, peerStatusBefore\.rootFiberUid/u)
  assert.match(source, /record\.generationId, peerStatusBefore\.generationId/u)
  assert.match(source, /record\.surfaceRevision, peerStatusBefore\.surfaceRevision/u)
  assert.match(source, /record\.host\?\.instanceId, hostIdentity\.instanceId/u)
  assert.match(source, /secondClientIndependentWrite: true/u)
  assert.match(source, /secondClientExitCode: peerExit\.code/u)
})

test('the production /reload-client case never uses a signal or override for the user command', () => {
  const source = readCase('manual-client-reload.mjs')
  assert.match(source, /send\('\/reload-client\\r'\)/u)
  assert.doesNotMatch(source, /SPLIT_PROCESS_CLIENT_REEXEC_PROBE|SPLIT_PROCESS_CLIENT_REEXEC_TARGET_PACKAGE_ROOT/u,
    'the U08 production command must never set the qualification override')
  assert.equal(source.indexOf('signalBusiness('), -1, 'U08 must never simulate the user command with SIGUSR2')
  assert.match(source, /installPlugin\(dsh, newArtifact\.path, harnessDir, env, false\)/u)
  assert.match(source, /assertProfileClientPeers\(profileDir, targetDshVersion, 'U08 upgraded profile install'\)/u)
  assert.match(source, /reloadRequested\.targetBuildId, newBuildId/u)
  assert.match(source, /replacementRestored\.clientBuildId, newBuildId/u)
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
  assert.match(source, /const scope = \{ \.\.\.context, hosts, clients \}/u)
  assert.match(source, /async function runReloadSourceIsolationRound\(context\) \{\n  const \{\n    EntryProcess, SurfaceEntryProcess,/u)
})

test('the extracted upgrade modules resolve every free identifier', () => {
  const files = [
    'scripts/split-process-upgrade-smoke.mjs',
    'scripts/lib/split-upgrade-selection.mjs',
    'scripts/lib/split-upgrade-support.mjs',
    'scripts/smoke/split-upgrade/cross-build-compatibility.mjs',
    'scripts/smoke/split-upgrade/manual-client-reload.mjs',
    'scripts/smoke/split-upgrade/reload-source-isolation.mjs',
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
  assert.match(source, /proveFailpointCleanup\(isolatedHomes, publishedScopes\)/u)
  assert.match(source, /const collectPublishedScopes = \(\) =>/u)
  assert.match(source, /if \(leftovers > 0 \|\| seats !== 'free'\)/u)
  assert.match(source, /SPLIT_UPGRADE_FAILPOINT_CLEANUP leftovers=/u)
  assert.match(source, /SPLIT_UPGRADE_FAILPOINT_CLEANUP_OK/u)
  assert.match(source, /for \(const run of \[\.\.\.activeProcesses\]\)/u)
  assert.match(source, /else if \(!KEEP\) \{\n\s+rmSync\(workRoot/u)
  // The shared DSH CLI harness is installed exactly once in the runner.
  assert.equal((source.match(/runPnpmInstall\(harnessDir, env, distribution\)/gu) ?? []).length, 1)
  assert.equal((source.match(/loadDshDistribution\(/gu) ?? []).length, 1)
  assert.doesNotMatch(source, /installPlugin\(/u, 'cases own their profile installs; the runner must not')
})

test('full and selected outputs keep the historical FULL / Selected-only boundary', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  const scene = source.slice(source.indexOf('async function runScene('))
  // Full assigns the historical status/verdict only after every registered case ran.
  const fullLoop = scene.indexOf('for (const entry of listSelectableUpgradeCases())')
  const fullStatus = scene.indexOf("evidence.status = 'PASS'")
  const fullVerdict = scene.indexOf("evidence.verdict = 'cross-build-compatible'")
  const fullMarker = scene.indexOf('SPLIT_UPGRADE_SMOKE_PASS (cross-build-compatible)')
  assert.ok(fullLoop >= 0 && fullStatus > fullLoop && fullVerdict > fullStatus && fullMarker > fullVerdict)
  // Selected writes a partial SELECTABLE_ONLY document and only per-case markers.
  assert.match(scene, /scope: 'SELECTABLE_ONLY'/u)
  assert.match(scene, /selectedCases: \[\]/u)
  assert.ok(scene.indexOf('writeRequestedEvidence(options.evidence, selectedEvidence)') < scene.indexOf('process.stdout.write(`${JSON.stringify(selectedEvidence'))
  assert.ok(scene.indexOf('process.stdout.write(`${JSON.stringify(selectedEvidence') < scene.indexOf('selectedUpgradePassLine(id)'))
  assert.doesNotMatch(scene.slice(scene.indexOf('// Selected mode'), scene.indexOf('} catch (error)')),
    /evidence\.status|evidence\.verdict|SPLIT_UPGRADE_SMOKE_PASS/u,
    'a selected run never carries the Full status/verdict/marker')
  // The requested evidence lands BEFORE the full marker.
  assert.ok(source.indexOf('writeRequestedEvidence(options.evidence, evidence)')
    < source.indexOf("'SPLIT_UPGRADE_SMOKE_PASS"))
})

test('the failure report path stays bounded and keeps the --evidence FAIL twin', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  assert.match(source, /diagnostics = createSmokeDiagnostics\(\{[\s\S]{0,300}lane: 'split-upgrade'/u)
  assert.match(source, /process\.stderr\.write\(`\$\{diagnostics\.identityLine\(\)\}\\n`\)/u)
  assert.match(source, /diagnostics\.reportFailure\(error, \{\n\s+processes: \[\.\.\.failureProcesses, \.\.\.activeProcesses\],\n\s+evidencePath: options\.evidence,\n\s+\}\)/u)
  assert.match(source, /emitInputFailure\(\{[\s\S]{0,200}evidencePath: options\?\.evidence/u)
  assert.match(source, /SPLIT_PROCESS_UPGRADE_SMOKE_FAILURE: \$\{safeFailureSummary\(error\)\}/u)
  assert.match(source, /if \(KEEP\) process\.stderr\.write\(`SPLIT_PROCESS_UPGRADE_SMOKE_FORENSICS: \$\{forensicErrorText\(error\)\}\\n`\)/u)
  assert.doesNotMatch(source, /SPLIT_PROCESS_UPGRADE_SMOKE_FAILURE: \$\{error instanceof Error \? error\.message/u)
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

test('the upgrade-specific tooling no longer locks an inline main() shape', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  // The old pseudo-guards looked for U02-U06 strings inside main()'s source. The
  // real cases are now separate owner modules; the runner may not retain them.
  for (const gone of ["checkpoint('U01-U06/base-pairing')", 'const hosts = []', 'const clients = []']) {
    assert.ok(!source.includes(gone), `the runner must not keep inline case machinery: ${gone}`)
  }
  const files = [SCRIPT, ...CASE_NAMES.map(name => join(CASE_DIR, name))]
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    assert.doesNotMatch(text, /EXPECTED_CASE_COUNT/u)
  }
  assert.doesNotMatch(source, /readdirSync\(CASE_DIR/u)
})
