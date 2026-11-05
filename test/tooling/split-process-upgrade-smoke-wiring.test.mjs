/**
 * Split-process upgrade smoke wiring guard.
 *
 * The real dual-artifact lane is `scripts/split-process-upgrade-smoke.mjs`.
 * It needs two genuinely packaged `.tgz` payloads and a real installation of
 * the exact DSH runtime this checkout pins, so it stays an explicit manual
 * qualification lane. This test only prevents its argument contract and
 * package wiring from rotting; it is NOT evidence that U02-U06 passed.
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
  assert.match(source, /waitForScreen\('cross-build-hold'/u)
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
  // Assigned inside the setup boundary, but still an OS temp root outside the checkout.
  assert.match(source, /workRoot = [A-Za-z]+Sync\(join\(tmpdir\(\), 'dsh-split-upgrade-'\)\)/u)
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
  assert.match(source, /sideBuildDir = join\(dshHome, 'profiles', 'split-upgrade-side-build'\)/u)
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

test('the upgrade lane qualifies BOTH artifact pins against the exact DSH runtime before any setup', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  assert.match(source, /requireExactSmokeDshPin,[\s\S]*?\} from '\.\/lib\/split-smoke-diagnostics\.mjs'/u,
    'the exact-pin rule is shared with the split-process lane, not restated per script')
  const main = source.slice(source.indexOf('async function main()'))
  const inspectOld = main.indexOf("inspectArtifact(options.old, 'old')")
  const inspectNew = main.indexOf("inspectArtifact(options.new, 'new')")
  const target = main.indexOf('targetDshVersion = npmDshVersion()')
  const guardOld = main.indexOf("requireExactSmokeDshPin('old', oldArtifact.manifest, targetDshVersion)")
  const guardNew = main.indexOf("requireExactSmokeDshPin('new', newArtifact.manifest, targetDshVersion)")
  const distribution = main.indexOf('loadDshDistribution(')
  // Located by shape, never by the temp-API token: the temp-hygiene gate text-scans
  // the whole test tree, strings and comments included.
  const workRoot = main.search(/[A-Za-z]+Sync\(join\(tmpdir\(\), 'dsh-split-upgrade-'\)\)/u)
  const install = main.indexOf('runPnpmInstall(harnessDir, env, distribution)')
  assert.ok(
    inspectOld >= 0 && inspectNew > inspectOld && target > inspectNew
      && guardOld > target && guardNew > guardOld
      && distribution > guardNew && workRoot > guardNew && install > workRoot,
    'the pinned artifacts must be read and qualified BEFORE the distribution load, the work root and any install',
  )
  assert.ok(target >= 0, 'the target pin comes from npmDshVersion(), not from engines or a compat matrix')
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
  // Surface Clients do NOT hold a profile-global Client seat, so this lane must
  // never derive their lifecycle from one. The handoff is qualified by the real
  // owner release, the new business PID, the same Host/Session restore and the
  // strictly-once durable prompt instead.
  assert.doesNotMatch(source, /seatIsFree\(clientSeatName\)/u,
    'the upgrade lane must not treat the qualification Client seat as a Surface lifecycle fact')
  assert.match(source, /record => record\.m4a0 === 'client-started' && record\.pid !== reloadClientPid/u,
    'U08 must observe the replacement as a NEW OS process')
  assert.match(source, /record => record\.m4r === 'handoff-restored' && record\.pid === replacementPid/u,
    'U08 must observe the replacement restoring the original Session')
  assert.match(source, /promptsAfterReload\.length, 1/u,
    'U08 must prove the admitted prompt was not replayed')
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

test('the PRODUCTION /reload-client command is driven through the real PTY, not a signal', () => {
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
  // The refusal negatives keep the OLD live surface through its real PID, its
  // Host identity and the untouched registry/launch bytes (never a seat probe).
  assert.match(u08, /assertOldSurfaceKept/u)
  assert.match(u08, /await assertOldSurfaceKept\('U08 already-current'\)/u)
  assert.match(u08, /await assertOldSurfaceKept\('U08 attachments refusal'\)/u)
  assert.match(u08, /assertIdentityKept\(safeIdentity\(\(await hostStatus\(host\)\)\.localHost\), hostIdentity, 'U08 Host after the command reload'\)/u)
  assert.doesNotMatch(u08, /seatIsFree\(`\\0dsh-pi-tui-c-/u,
    'U08 must not probe the qualification Client seat for a Surface lifecycle')

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

test('U08 keeps a SECOND old-build TUI through the cross-build reexec and the held Turn', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  const start = source.indexOf('async function runUserCommandReloadRound')
  const end = source.indexOf('async function runUnavailableTargetRound')
  assert.ok(start > 0 && end > start, 'the U08 round must exist')
  const u08 = source.slice(start, end)

  // B is a real OLD installed `dist/local-client.mjs` on its own wrapper/PTY.
  // It must join the SAME Session X BEFORE the production command is typed.
  const peerStart = u08.indexOf("const peerClient = new SurfaceEntryProcess(join(sideOldPackage, 'dist', 'local-client.mjs')")
  const command = u08.indexOf("reloadClient.send('/reload-client\\r')")
  assert.ok(peerStart > 0, 'U08 must start the second old-build Client from the real old installation')
  assert.ok(command > peerStart, 'the second Client must join Session X before `/reload-client` is sent')
  assert.match(u08, /SPLIT_PROCESS_CLIENT_SESSION: sessionId/u)
  assert.match(u08, /assertNotEqual\(peerPid, reloadClientPid/u)
  assert.match(u08, /assertNotEqual\(peerClient\.child\.pid, reloadClient\.child\.pid/u)
  assert.match(u08, /const assertPeerKept = \(label\) =>/u)
  // B's own identity is the before/post-boundary fact, never a heartbeat.
  assert.match(u08, /record\.rootFiberUid, peerStatusBefore\.rootFiberUid/u)
  assert.match(u08, /record\.generationId, peerStatusBefore\.generationId/u)
  assert.match(u08, /record\.surfaceRevision, peerStatusBefore\.surfaceRevision/u)
  assert.match(u08, /record\.host\?\.instanceId, hostIdentity\.instanceId/u)
  assert.match(u08, /the second Client released its own resources/u)
  const peerAfterRelease = u08.indexOf("assertPeerKept('U08 after the old Client released')")
  const peerAfterRestore = u08.indexOf("assertPeerKept('U08 after the replacement restored Session X')")
  const peerAfterExit = u08.indexOf("assertPeerKept('U08 after the replacement exited")
  assert.ok(peerAfterRelease > 0 && peerAfterRestore > peerAfterRelease && peerAfterExit > peerAfterRestore,
    'B must be re-verified at the old release, the A\' restore and the A\' exit')

  // The OLD A closure and the NEW A' PID/handoff stay the authority.
  const oldClosed = u08.indexOf("'U08 old-build reload Client released every owned Client resource'")
  const replacementStarted = u08.indexOf("record => record.m4a0 === 'client-started' && record.pid !== reloadClientPid")
  assert.ok(oldClosed > 0 && replacementStarted > oldClosed, 'the old release must precede the replacement process')
  assert.match(u08, /record => record\.m4r === 'handoff-restored' && record\.pid === replacementPid/u)
  assert.match(u08, /replacementRestored\.clientBuildId, newBuildId/u)
  assert.match(u08, /replacementRestored\.sessionHistoryOpen, true/u)

  // A' exits while the ORIGINAL Turn is STILL held; only then is the barrier
  // released, and the SECOND Client reads the settlement and writes again.
  const replacementExit = u08.indexOf("reloadClient.send('/exit\\r')")
  const heldAfterExit = u08.indexOf('U08 after the replacement exited with the original Turn still held')
  const release = u08.indexOf('writeFileSync(releaseBarrier')
  assert.ok(replacementExit > 0 && heldAfterExit > replacementExit && release > heldAfterExit,
    'the barrier must be released only AFTER A\' exited with the original Turn still held')
  assert.match(u08, /the admitted Turn was released by the Client exit/u)
  assert.match(u08, /the replacement Client still owned Client services after its release/u)
  assert.match(u08, /second Client read the original Turn settlement/u)
  assert.match(u08, /second Client committed after the reload/u)
  assert.match(u08, /the second Client prompt committed more than once/u)
  assert.match(u08, /second Client released every owned Client resource/u)
  assert.match(u08, /secondClientExitCode: peerExit\.code/u)
  const finalPeerScan = u08.indexOf("assertPeerKept('U08 after the second Client wrote the same Session')")
  const peerExit = u08.indexOf("peerClient.send('/exit\\r')")
  const hostStop = u08.indexOf("process.kill(hostIdentity.hostPid, 'SIGTERM')")
  assert.ok(finalPeerScan > 0 && peerExit > finalPeerScan,
    'B must be rescanned over the WHOLE post-release window after its own write and before its exit')
  assert.ok(peerExit > 0 && hostStop > peerExit,
    'the second Client must close normally before the Host stop remains the last owner-governed step')

  // The legal two-artifact pairing stays a HARD gate (never optional).
  assert.match(source, /requireExactSmokeDshPin\('old', oldArtifact\.manifest, targetDshVersion\)/u)
  assert.match(source, /requireExactSmokeDshPin\('new', newArtifact\.manifest, targetDshVersion\)/u)
  assert.match(source, /oldArtifact\.sha256 === newArtifact\.sha256/u)
  assert.match(source, /newBuildId !== oldBuildId/u)
})

test('the manual reload ignores a live qualification target override and resolves the active profile', () => {
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
  // The U09 handoff is qualified by the replacement build/PID and the restored
  // Host/Session, never by the absent profile-global Surface seat.
  assert.match(u09, /replacementRestored\.clientBuildId, sideNewBuildId/u)
  assert.match(u09, /replacementRestored\.sessionId, sessionId/u)
  assert.doesNotMatch(u09, /seatIsFree/u, 'U09 must not probe the qualification Client seat for a Surface lifecycle')
  assert.match(source, /runReloadSourceIsolationRound\(\{/u)
})

test('the upgrade lane declares every setup local it later assigns', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  const main = source.slice(source.indexOf('async function main()'))
  // A bare assignment to an undeclared name is a ReferenceError at run time and
  // only the REAL lane reaches this code, so pin the declarations here.
  for (const name of ['distribution', 'workRoot', 'home', 'dshHome', 'harnessDir',
    'sideBuildDir', 'sideBuildPackagePath', 'scratch', 'env', 'evidence']) {
    assert.match(main, new RegExp(`let ${name}$`, 'mu'),
      `the setup must declare \`${name}\` before assigning it`)
    assert.match(main, new RegExp(`^\\s*${name} = `, 'mu'),
      `the setup must assign \`${name}\` inside the boundary`)
  }
  // The declaration must precede the first assignment for each of them.
  for (const name of ['distribution', 'workRoot', 'dshHome', 'evidence']) {
    const declared = main.search(new RegExp(`let ${name}$`, 'mu'))
    const assigned = main.search(new RegExp(`^\\s*${name} = `, 'mu'))
    assert.ok(declared >= 0 && assigned > declared,
      `\`${name}\` must be declared before its first assignment`)
  }
})

test('the upgrade setup shares the report and cleanup boundary with the run', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  const main = source.slice(source.indexOf('async function main()'))
  const guard = main.indexOf("requireExactSmokeDshPin('new'")
  const root = main.search(/[A-Za-z]+Sync\(join\(tmpdir\(\), 'dsh-split-upgrade-'\)\)/u)
  // The REAL `try {` index, so moving the setup back out of it fails the guard.
  const setupTry = main.indexOf('try {', guard)
  const distributionLoad = main.indexOf('distribution = loadDshDistribution(', guard)
  assert.ok(guard > 0 && root > guard, 'no setup may run before both pins are qualified')
  assert.ok(setupTry > guard, 'the reporting/cleanup try must follow both pin guards')
  assert.ok(root > setupTry, 'the work root must be created INSIDE the reporting/cleanup try')
  assert.ok(distributionLoad > setupTry,
    'the distribution load must be inside the reporting/cleanup try, not before it')
  assert.ok(main.indexOf('if (workRoot === undefined) {', root) > 0,
    'the finally must tolerate a root that never appeared')
  const finallyIndex = main.indexOf('} finally {', root)
  const cleanup = main.slice(finallyIndex)
  assert.match(cleanup, /if \(workRoot === undefined\) \{/u, 'a missing work root must not break the cleanup')
  assert.match(cleanup, /else if \(!KEEP\) rmSync\(workRoot/u)
  assert.match(cleanup, /if \(dshHome !== undefined\) killIsolatedProcesses\(dshHome\)/u)
})

test('the split-upgrade lane reports every failure with a bounded default projection', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  assert.match(source, /import \{[\s\S]*createSmokeDiagnostics,[\s\S]*\} from '\.\/lib\/split-smoke-diagnostics\.mjs'/u)
  assert.match(source, /diagnostics = createSmokeDiagnostics\(\{[\s\S]{0,300}lane: 'split-upgrade'/u)
  assert.match(source, /process\.stderr\.write\(`\$\{diagnostics\.identityLine\(\)\}\\n`\)/u)
  const main = source.slice(source.indexOf('async function main()'))
  // The identity is announced only AFTER both pins qualified (the unqualified
  // CLI run asserting the absence of `qualified=true` covers the behaviour).
  assert.ok(main.indexOf('diagnostics.identityLine()') > main.indexOf("requireExactSmokeDshPin('new'"),
    'the identity line must be built only after both artifacts qualified')
  // Each named phase boundary is announced, so a default log locates the failure.
  for (const step of [
    "checkpoint('U01-U06/base-pairing')",
    "checkpoint('U07/reexec-request')",
    "checkpoint('U07/negative-wrong-instance')",
    "checkpoint('U07/negative-child-failure')",
    "checkpoint('U02/cross-build-attach')",
    "checkpoint('U04/cross-build-surface')",
    "checkpoint('U05/host-stop')",
    "checkpoint('U06/new-host-boot')",
    "checkpoint('U08/negative-already-current')",
    "checkpoint('U08/negative-attachments')",
    "checkpoint('U08/upgrade-install')",
    "checkpoint('U08/positive-reexec')",
    "checkpoint('U08/negative-target-invalid')",
    "checkpoint('U09/manual-already-current')",
    "checkpoint('U09/qualification-reexec')",
  ]) {
    assert.ok(source.includes(step), `the lane must announce ${step}`)
  }
  // Both failure paths report BEFORE the cleanup, and the FAIL twin lands on the
  // operator's --evidence path (never inside the deletable work root).
  const preflightReport = main.indexOf("diagnostics.reportFailure(error, { evidencePath: options.evidence })")
  const runReport = main.indexOf('processes: [...hosts, ...clients]')
  const finallyIndex = main.indexOf('} finally {')
  const workRootRemove = main.indexOf('rmSync(workRoot, { recursive: true, force: true })', finallyIndex)
  assert.ok(preflightReport > 0 && runReport > preflightReport && finallyIndex > runReport,
    'the preflight branch and the run catch must both report before the finally cleanup')
  assert.ok(workRootRemove > finallyIndex, 'the work root deletion must stay in the finally')
  assert.match(main.slice(runReport - 200, finallyIndex), /diagnostics\.reportFailure\(error, \{\s*processes: \[\.\.\.hosts, \.\.\.clients\],/u)
  assert.match(main.slice(runReport, finallyIndex), /evidencePath: options\.evidence/u)
  assert.match(main.slice(finallyIndex), /if \(!KEEP\) rmSync\(workRoot/u, 'the SPLIT_UPGRADE_KEEP semantics stay unchanged')
  // The PASS evidence keeps its original shape and marker.
  assert.match(source, /evidence\.status = 'PASS'/u)
  assert.match(source, /evidence\.verdict = 'cross-build-compatible'/u)
  // The default final line is the fixed classification only; the raw error text
  // appears in one place, and only when the operator asked for a kept scene.
  assert.match(source, /SPLIT_PROCESS_UPGRADE_SMOKE_FAILURE: \$\{safeFailureSummary\(error\)\}/u)
  assert.match(source, /if \(KEEP\) process\.stderr\.write\(`SPLIT_PROCESS_UPGRADE_SMOKE_FORENSICS: \$\{forensicErrorText\(error\)\}\\n`\)/u)
  assert.doesNotMatch(source, /SPLIT_PROCESS_UPGRADE_SMOKE_FAILURE: \$\{error instanceof Error \? error\.message/u)
  // A failure before the collector existed still leaves one safe report AND the
  // `--evidence` FAIL twin, and the PASS twin uses the same private write.
  assert.match(main, /emitInputFailure\(\{[\s\S]{0,160}evidencePath: options\?\.evidence/u,
    'an input failure before the collector still writes the --evidence FAIL twin')
  assert.match(main, /diagnostics\.reportFailure\(error, \{ evidencePath: options\.evidence \}\)/u)
  assert.match(source, /writeRequestedEvidence\(options\.evidence, evidence\)/u,
    'a requested PASS evidence document must fail the lane when it cannot land')
  assert.ok(source.indexOf('writeRequestedEvidence(options.evidence, evidence)')
    < source.indexOf("'SPLIT_UPGRADE_SMOKE_PASS"),
    'the PASS marker may only be announced after the requested evidence landed')
})

test('the reload waits fail early on a refusal yet still PASS only on a painted notice', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  assert.match(source, /export async function waitForReloadNotice\(client, expectedText, label, fromRecordIndex/u)
  assert.match(source, /export async function waitForAcceptedHandoff\(client, pid, label, fromRecordIndex/u)
  // PASS authority #1: the real PTY viewport, classified into the product's
  // FIXED NOTICE ROW SHAPE, checked FIRST inside the loop.
  const noticeWait = source.slice(
    source.indexOf('export async function waitForReloadNotice'),
    source.indexOf('const IGNORED_REASON_TYPES'),
  )
  const firstViewport = noticeWait.indexOf('const viewport = await client.viewport()')
  const shapeClassify = noticeWait.indexOf('const painted = classifyReloadNotices(viewport)')
  const paintPass = noticeWait.indexOf('if (painted.includes(expected)) return expected')
  const rejectionScan = noticeWait.indexOf("record?.m4r !== 'handoff-request-rejected'")
  assert.ok(firstViewport >= 0 && shapeClassify >= 0 && paintPass >= 0 && rejectionScan >= 0,
    'the wait must read the viewport, classify the fixed notice shape, then check the painted PASS and the rejection scan')
  assert.ok(firstViewport < shapeClassify && shapeClassify < paintPass,
    'the painted frame must be classified into the fixed notice shape before anything can PASS')
  assert.ok(paintPass < rejectionScan, 'telemetry may only ever shorten a wait, never satisfy it')
  // A bare substring of the expected wording is NOT a PASS criterion: a prompt
  // echo or composer line carrying the same bytes must not satisfy the wait.
  assert.doesNotMatch(noticeWait, /includes\(expectedText\)/u,
    'the notice wait must not PASS on a raw viewport substring')

  // PASS authority #2: an accepted handoff must be THIS PID's own record.
  const handoffWait = source.slice(
    source.indexOf('export async function waitForAcceptedHandoff'),
    source.indexOf('async function runUserCommandReloadRound'),
  )
  assert.match(handoffWait, /record\?\.m4r === 'handoff-requested' && record\.pid === pid/u)
  // Every command or signal has its OWN pre-send record boundary; no site reads
  // a refusal left by an earlier action.
  const boundaries = [
    'const alreadyCurrentFrom = reloadOldClient.records.length',
    'const attachmentsFrom = reloadOldClient.records.length',
    'const reloadRequestFrom = reloadClient.records.length',
    'const targetInvalidFrom = client.records.length',
    'const manualReloadFrom = client.records.length',
    'const qualificationFrom = client.records.length',
    'const reexecRequestFrom = clientA.records.length',
    'const childFailureRequestFrom = clientA2.records.length',
  ]
  for (const capture of boundaries) {
    const index = source.indexOf(capture)
    assert.ok(index > 0, `the wait needs its own boundary: ${capture}`)
    const after = source.slice(index, index + 400)
    assert.ok(/send\('\/reload-client\\r'\)|signalBusiness\('SIGUSR2'\)/u.test(after),
      `${capture} must be captured immediately before this action's command`)
  }
  for (const call of [
    "waitForReloadNotice(reloadOldClient, 'Client reload skipped: this Client already runs the installed build.',\n    'U08 already-current notice', alreadyCurrentFrom)",
    "waitForReloadNotice(reloadOldClient, 'Client reload blocked: remove or submit the staged attachments first.',\n    'U08 attachments refusal', attachmentsFrom)",
    'waitForReloadNotice(client, \'Client reload failed: the installed replacement Client is unavailable or incompatible.\',\n    \'U08 target-invalid notice\', targetInvalidFrom)',
    "waitForReloadNotice(client, 'Client reload skipped: this Client already runs the installed build.',\n    'U09 manual already-current notice', manualReloadFrom)",
  ]) {
    assert.ok(source.includes(call), `the painted-notice wait must own this site:\n${call}`)
  }
  // The Session-content and prompt proofs stay plain PTY waits: they are not
  // reload notices and must not be routed through the refusal classifier.
  assert.match(source, /waitForScreen\(holdPrompt, 'U08 old Client painted the admitted prompt', 120_000\)/u)
  assert.match(source, /waitForScreen\(holdPrompt, 'U09 the replacement painted the admitted prompt', 120_000\)/u)
  assert.match(source, /waitForScreen\('cross-build-hold'/u)
  // The untouched safety assertions around the converted waits still exist.
  assert.match(source, /waitForClearedComposer\(reloadOldClient, '\[image #', 'U08 staged placeholder cleared'\)/u)
  assert.match(source, /assertOldSurfaceKept/u)
  assert.match(source, /m4r === 'handoff-restored'/u)
  // The fault-injection negatives keep their own expectations.
  assert.match(source, /qualification forced client bootstrap failure/u)
  assert.match(source, /assertEqual\(childFailureExit\.code, 1/u)
  assert.match(source, /HOST_IDENTITY_MISMATCH/u)
})
