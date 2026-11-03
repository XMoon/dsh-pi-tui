/**
 * M4-C2-D split-process upgrade smoke wiring guard.
 *
 * The real dual-artifact lane is `scripts/split-process-upgrade-smoke.mjs`.
 * It needs two genuinely packaged `.tgz` payloads and a real DSH rc.4
 * installation, so it stays an explicit manual qualification lane. This test
 * only prevents its argument contract and package wiring from rotting; it is
 * NOT evidence that U02–U06 passed.
 *
 * @module split-process-upgrade-smoke-wiring.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseUpgradeArguments } from '../../scripts/split-process-upgrade-smoke.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'split-process-upgrade-smoke.mjs')

test('the upgrade smoke is a package script and parses as ESM', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts?.['smoke:split-upgrade'], 'node scripts/split-process-upgrade-smoke.mjs')
  const result = spawnSync(process.execPath, ['--check', SCRIPT], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('the upgrade smoke requires two different old/new artifact paths', () => {
  const oldPath = join(ROOT, 'temp', 'old.tgz')
  const newPath = join(ROOT, 'temp', 'new.tgz')
  assert.deepEqual(
    (() => {
      const parsed = parseUpgradeArguments(['--', '--old', oldPath, '--new', newPath])
      return { old: parsed.old, new: parsed.new, evidence: parsed.evidence }
    })(),
    { old: oldPath, new: newPath, evidence: undefined },
  )
  assert.throws(() => parseUpgradeArguments(['--old', 'old.tgz']), /both --old <tgz> and --new <tgz> are required/u)
  assert.throws(() => parseUpgradeArguments(['--old', 'same.tgz', '--new', 'same.tgz']), /must name different artifacts/u)
  assert.throws(() => parseUpgradeArguments(['--old', 'old.tgz', '--new', 'new.tgz', '--bogus']), /unknown argument/u)
  assert.throws(() => parseUpgradeArguments(['--old', '--new', 'new.tgz']), /--old requires a path/u)
})

test('the upgrade smoke proves cross-build compatibility instead of a build refusal', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  assert.match(source, /oldArtifact\.sha256 === newArtifact\.sha256/u)
  assert.match(source, /newBuildId !== oldBuildId/u)
  // U02 uses the real qualification control on the new Client and reads its
  // structured RPC proof; it must not treat a build refusal as the outcome.
  assert.match(source, /qualification-host-foundation/u)
  assert.match(source, /host-rpc-proof/u)
  assert.match(source, /assertIdentityKept\(clientBAuth\.host, hostABefore/u)
  assert.match(source, /clientBAuth\.host\.buildId === oldBuildId/u)
  // U04 must be the real PTY surface resuming the running old Session.
  assert.match(source, /SurfaceEntryProcess/u)
  assert.match(source, /SPLIT_PROCESS_CLIENT_SESSION: sessionId/u)
  assert.match(source, /sessionOpen === true && record\.openSessionId === sessionId/u)
  assert.match(source, /waitForScreen\('c2d-upgrade-hold'/u)
  assert.match(source, /crossBuildClient/u)
  assert.match(source, /crossBuildSurface/u)
  assert.match(source, /cross-build-compatible/u)
  assert.match(source, /SPLIT_UPGRADE_SMOKE_PASS/u)
  assert.match(source, /SPLIT_UPGRADE_KEEP/u)
  assert.doesNotMatch(source, /HOST_BUILD_INCOMPATIBLE/u,
    'the upgrade lane must not present a cross-build refusal as its success path')
  // The lane must never derive the old artifact by mutating the new one.
  assert.doesNotMatch(source, /writeFileSync\(.*newArtifact\.path/u)
})

test('both Client peer owners are real and every upgrade root is isolated', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  // The work root is a real OS temp root outside the checkout; a repo-local
  // split-upgrade-* root would borrow the checkout's node_modules (issue #476).
  assert.match(source, /const workRoot = [A-Za-z]+Sync\(join\(tmpdir\(\), 'dsh-split-upgrade-'\)\)/u)
  assert.match(source, /relative\(realpathSync\(PACKAGE_ROOT\), realpathSync\(workRoot\)\)/u)
  assert.match(source, /workRootFromCheckout\.startsWith\(`\.\.\$\{sep\}`\)/u)
  assert.doesNotMatch(source, /join\(PACKAGE_ROOT, 'temp', 'split-upgrade-'\)/u)
  assert.doesNotMatch(source, /mkdirSync\(join\(PACKAGE_ROOT, 'temp'\)/u)

  // The active profile owns the exact Client peer set and installs it before
  // the old bundle; the harness is only the DSH CLI anchor.
  const profileStoreInstall = source.indexOf(
    'installPlugin(dsh, `@deepseek-ai/dsh-client-store@${targetDshVersion}`, harnessDir, env, false)',
  )
  const zustandInstall = source.indexOf("installPlugin(dsh, 'zustand@4.5.7', harnessDir, env, false)")
  const immerInstall = source.indexOf("installPlugin(dsh, 'immer@10.2.0', harnessDir, env, false)")
  const oldInstall = source.indexOf('installPlugin(dsh, oldArtifact.path, harnessDir, env, false)')
  assert.ok(profileStoreInstall >= 0, 'the active profile must install the Client store through the official CLI')
  assert.ok(zustandInstall > profileStoreInstall && immerInstall > zustandInstall,
    'the published store\'s zustand/immer engine peers must follow the store install')
  assert.ok(oldInstall > immerInstall, 'the active profile peer set must be installed before the old bundle')
  const harnessManifest = source.slice(
    source.indexOf("name: 'dsh-split-upgrade-harness'"),
    source.indexOf('runPnpmInstall(harnessDir, env, distribution)'),
  )
  assert.doesNotMatch(harnessManifest, /dsh-client-store|zustand|immer/u,
    'the isolated harness must not pretend to own the Client peer set')
  assert.match(source, /assertProfileClientPeers\(profileDir, targetDshVersion, 'old profile install'\)/u)
  assert.match(source, /assertProfileClientPeers\(profileDir, targetDshVersion, 'upgraded profile install'\)/u)
  assert.match(source, /manifest\.dependencies\?\.\[name\] === version/u)
  assert.match(source, /realpathSync\(createRequireFrom\(join\(profileDir, 'package\.json'\)\)\.resolve\(name\)\)/u)

  // The side-build is a sibling profile project with its own exact peer
  // closure, never a child of the active profile and never a second DSH or
  // Cordis family.
  assert.match(source, /const sideBuildDir = join\(dshHome, 'profiles', 'split-upgrade-side-build'\)/u)
  assert.match(source, /function installSideBuild\(dir, tarball, env, targetDshVersion\)/u)
  assert.match(source, /installSideBuild\(sideBuildDir, newArtifact\.path, env, targetDshVersion\)/u)
  const sideBuildSource = source.slice(
    source.indexOf('function installSideBuild'),
    source.indexOf('function killProcessGroup'),
  )
  assert.match(sideBuildSource, /'@deepseek-ai\/dsh-client-store': targetDshVersion/u)
  assert.match(sideBuildSource, /zustand: '4\.5\.7'/u)
  assert.match(sideBuildSource, /immer: '10\.2\.0'/u)
  assert.doesNotMatch(sideBuildSource, /@deepseek-ai\/cordis|'@deepseek-ai\/dsh':/u,
    'the side-build must not copy the DSH family or a second Cordis')
  assert.match(source, /the side-by-side \$\{name\} resolves outside its own package/u)
})

test('the upgrade lane owns the real Client reexec handoff and its two live negatives', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  const reexecIndex = source.indexOf("clientA.signalBusiness('SIGUSR2')")
  assert.ok(reexecIndex > 0, 'the upgrade lane must trigger the real reexec probe')
  // Client A stays the live PTY Client until the side-by-side build exists.
  assert.match(source, /SPLIT_PROCESS_CLIENT_REEXEC_PROBE: '1'/u)
  assert.match(source, /SPLIT_PROCESS_CLIENT_REEXEC_TARGET_PACKAGE_ROOT: sideBuildPackagePath/u)
  assert.match(source, /m4r === 'handoff-restored'/u)
  assert.match(source, /clientClosed\.sessionOpen, false/u)
  assert.match(source, /clientClosed\.owners/u)
  assert.match(source, /c1Restored\.clientBuildId, newBuildId/u)
  assert.match(source, /assertEqual\(await seatIsFree\(clientSeatName\), false/u)
  // The OLD Client exits only AFTER the replacement ran; the reexec is not
  // another same-PID surface revision.
  const oldClientExitIndex = source.indexOf("clientA.send('/exit\\r')")
  assert.ok(oldClientExitIndex > reexecIndex, 'the old Client must exit only after the reexec handoff was driven')
  assert.match(source, /newOsPid: c1Pid !== clientAPid/u)
  assert.match(source, /oldParentWaitedDuringChild: true/u)
  // Negative 1: a wrong expected Host never connects and never publishes ready.
  assert.match(source, /SPLIT_PROCESS_CLIENT_EXPECTED_INSTANCE_ID: randomUUID\(\)/u)
  assert.match(source, /HOST_IDENTITY_MISMATCH/u)
  assert.match(source, /noHostConnect: true/u)
  assert.match(source, /noPathPidOrSecret: true/u)
  // Negative 2: the fault is injected into the CHILD only.
  assert.match(source, /SPLIT_PROCESS_CLIENT_REEXEC_CHILD_FAILURE: 'client-bootstrap'/u)
  assert.match(source, /qualification forced client bootstrap failure/u)
  assert.match(source, /noAutoRecovery: true/u)
  assert.match(source, /noReplay: true/u)
  // The original U02/U04 cross-build qualification and the durable Session
  // release/U05/U06 ordering must remain AFTER the reexec section.
  assert.ok(source.indexOf('qualification-host-foundation') > reexecIndex,
    'U02 must still run after the reexec handoff')
  assert.ok(source.indexOf('crossBuildSurface') > reexecIndex,
    'U04 must still run after the reexec handoff')
  assert.ok(source.indexOf('writeFileSync(releaseBarrier', reexecIndex) > reexecIndex,
    'the admitted Turn must still be released after the reexec handoff')
  assert.ok(source.indexOf('SPLIT_UPGRADE_SMOKE_PASS') > reexecIndex)
  // A real installed package is the only target: no copied/faked dist payload.
  assert.doesNotMatch(source, /copyFileSync|cpSync/u)
  assert.match(source, /function installSideBuild/u)
})

test('M4 PR4 U08 drives the PRODUCTION /reload-client command through the real PTY', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  const start = source.indexOf('async function runUserCommandReloadRound')
  const targetInvalid = source.indexOf('async function runUnavailableTargetRound')
  const isolation = source.indexOf('async function runReloadSourceIsolationRound')
  assert.ok(start > 0 && targetInvalid > start && isolation > targetInvalid, 'the U08/U09 rounds must exist')
  // The PRODUCTION positive/negative round: it must never set the qualification
  // override or simulate the user command with SIGUSR2.
  const u08 = source.slice(start, targetInvalid)
  // The destructive removal negative lives in its OWN isolated round.
  const targetInvalidRound = source.slice(targetInvalid, isolation)

  // A SECOND, fully isolated profile/home round: U07's round is untouched.
  assert.match(u08, /const dshHome = join\(roundRoot, 'dsh-home'\)/u)
  assert.match(u08, /isolatedEnvironment\(envWork, home, dshHome/u)
  assert.match(u08, /extraIsolatedHomes\.push\(dshHome\)/u)

  // The command is typed into the real PTY. No SIGUSR2 simulation, no
  // qualification target override, and no copied/faked payload.
  assert.match(u08, /send\('\/reload-client\\r'\)/u)
  assert.doesNotMatch(u08, /SPLIT_PROCESS_CLIENT_REEXEC_PROBE|SPLIT_PROCESS_CLIENT_REEXEC_TARGET_PACKAGE_ROOT/u)
  assert.equal(u08.indexOf('signalBusiness('), -1, 'U08 must never simulate the user command with SIGUSR2')
  assert.doesNotMatch(u08, /copyFileSync|cpSync/u)
  assert.doesNotMatch(u08, /writeFileSync\([^)]*dist/u)
  assert.doesNotMatch(u08, /writeFileSync\([^)]*(oldArtifact|newArtifact)\.path/u)

  // The official in-place profile upgrade installs the NEW candidate; the
  // command resolves the PROFILE package and the handoff restores the Host.
  assert.match(u08, /installPlugin\(dsh, newArtifact\.path, harnessDir, env, false\)/u)
  assert.match(u08, /assertProfileClientPeers\(profileDir, targetDshVersion, 'U08 upgraded profile install'\)/u)
  assert.match(u08, /newBuildId, oldBuildId/u)
  assert.match(u08, /reloadRequested\.targetBuildId, newBuildId/u)
  assert.match(u08, /reloadRequested\.targetBundleVersion, newArtifact\.manifest\.version/u)
  assert.match(u08, /replacementRestored\.clientBuildId, newBuildId/u)
  assert.match(u08, /productionTargetResolvedFromProfile: true/u)
  assert.match(u08, /qualificationTargetOverrideUsed: false/u)
  assert.match(u08, /handoffRequestedByUserCommand: true/u)
  assert.match(u08, /promptNotReplayed: true/u)

  // The two real PTY negatives keep the old/live surface and never stop it.
  assert.match(u08, /Client reload skipped: this Client already runs the installed build/u)
  assert.match(u08, /Client reload blocked: remove or submit the staged attachments first/u)
  assert.match(u08, /alreadyCurrentKeptOldSurface: true/u)
  assert.match(u08, /attachmentsKeptOldSurface: true/u)

  // Negative 3: the official removal round.
  assert.match(targetInvalidRound, /'plugin', '--profile', 'pi-tui', 'remove', EXPECTED_PACKAGE_NAME/u)
  assert.match(targetInvalidRound, /Client reload failed: the installed replacement Client is unavailable or incompatible/u)
  assert.match(targetInvalidRound, /targetInvalidKeptOldSurface: true/u)
  assert.match(targetInvalidRound, /installedTargetOfficiallyRemoved: true/u)
  assert.match(targetInvalidRound, /targetInvalidRefused: true/u)
  assert.match(targetInvalidRound, /turnHeldAcrossRefusal: true/u)
  assert.match(source, /runUnavailableTargetRound\(\{/u)
})

test('M4 PR4 U09 proves the manual command ignores a live qualification target override', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  const start = source.indexOf('async function runReloadSourceIsolationRound')
  const end = source.indexOf('async function main()')
  assert.ok(start > 0 && end > start, 'the U09 source-isolation round must exist')
  const u09 = source.slice(start, end)
  // The SAME qualification process owns BOTH entries: probe + side-by-side
  // override AND the public manual command.
  assert.match(u09, /SPLIT_PROCESS_CLIENT_REEXEC_PROBE: '1'/u)
  assert.match(u09, /SPLIT_PROCESS_CLIENT_REEXEC_TARGET_PACKAGE_ROOT: sideNewPackage/u)
  assert.match(u09, /send\('\/reload-client\\r'\)/u)
  assert.match(u09, /signalBusiness\('SIGUSR2'\)/u)
  // The manual command resolves the PROFILE (the running old build), so it is
  // already-current; the qualification request uses the override build.
  assert.match(u09, /Client reload skipped: this Client already runs the installed build/u)
  assert.match(u09, /assertEqual\(client\.records\.filter\(record => record\.m4r === 'handoff-requested'\)\.length, 0/u)
  assert.match(u09, /qualificationRequested\.source, 'qualification'/u)
  assert.match(u09, /qualificationRequested\.targetBuildId, sideNewBuildId/u)
  assert.match(u09, /replacementRestored\.clientBuildId, sideNewBuildId/u)
  assert.match(u09, /manualResolvedProfileOnly: true/u)
  assert.match(u09, /manualNeverReachedProcessStop: true/u)
  assert.match(u09, /qualificationUsedOverride: true/u)
  assert.match(u09, /sameProcessBothEntries: true/u)
  assert.match(source, /runReloadSourceIsolationRound\(\{/u)
})
