/**
 * `upgrade.cross-build-compatibility`: the ONE real old-Host / new-Client
 * cross-build scene.
 *
 * This case owns the frozen order: the old profile install, Host A plus an
 * admitted Turn, the side-by-side new build install while the Turn is held, the
 * real Client-only reexec handoff with its wrong-instance and child-failure
 * negatives, the new Client's official/private RPC proof, the new build's real
 * PTY surface, the owner-governed Host stop, and the post-stop profile upgrade
 * with a fresh Host identity and durable Session readback.
 *
 * U01-U07 are deliberately not split: every step depends on the SAME live Host
 * A, its admitted Turn and the exact bytes of the old installation.
 *
 * @module smoke/split-upgrade/cross-build-compatibility
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'

import { installPlugin } from '../../pi2dsh-compat-smoke.mjs'
import { hostSessionEvents, waitForHostSessionEvent } from '../../lib/split-smoke-sessions.mjs'
import { writeC1WorkFixture } from '../../lib/split-smoke-fixtures.mjs'
import {
  EXPECTED_PACKAGE_NAME,
  assert,
  assertDeepEqual,
  assertEqual,
  assertIdentityKept,
  assertMatch,
  assertNoSecret,
  assertNotEqual,
  assertProfileClientPeers,
  alive,
  c1WorkHadRelease,
  createRequireFrom,
  fetchStatus,
  hostStatus,
  installSideBuild,
  installedPayloadHash,
  killProcessGroup,
  productionBuildId,
  readHostLogRecords,
  readJson,
  readProcessStarttime,
  safeIdentity,
  scopeDirOf,
  scopeScratchDirs,
  seatIsFree,
  sessionLogFiles,
  sha256,
  stopHostForCleanup,
  stopRecordedHostForCleanup,
  waitForAcceptedHandoff,
  waitForUpgradeC1WorkEvent,
  waitGone,
} from '../../lib/split-upgrade-support.mjs'

/**
 * Run the complete cross-build scene in its own local Host/Client ownership
 * boundary. `failpoint` is the lane's fixed fault-injection control.
 */
export async function runCrossBuildCompatibility(context) {
  const {
    EntryProcess,
    SurfaceEntryProcess,
    workRoot,
    dshHome,
    harnessDir,
    env,
    dsh,
    anchor,
    targetDshVersion,
    oldArtifact,
    newArtifact,
    checkpoint,
    failpoint,
    captureFailure,
  } = context
  const fragment = { old: {}, new: {} }
  const hosts = []
  const clients = []
  const scratch = join(workRoot, 'scratch')
  let detachedHost
  // A sibling of the active profile, never a child: its own pnpm project must
  // not discover or rewrite the running old profile, while DSH's `profiles/**`
  // interception still applies to its installed Client build.
  const sideBuildDir = join(dshHome, 'profiles', 'split-upgrade-side-build')
  // Known before the install exists: the old Client receives this absolute
  // root as its qualification target and only reads it at the reexec trigger.
  const sideBuildPackagePath = join(sideBuildDir, 'node_modules', EXPECTED_PACKAGE_NAME)
  try {
      // ── Install the OLD build into the one canonical profile ────────────────
      // The Client's static platform peer belongs to the profile that will run
      // it, exactly like a production profile dependency; the harness only
      // anchors the DSH CLI installation (issue #476).
      const profileDir = join(dshHome, 'profiles', 'pi-tui')
      installPlugin(dsh, `@deepseek-ai/dsh-client-store@${targetDshVersion}`, harnessDir, env, false)
      installPlugin(dsh, 'zustand@4.5.7', harnessDir, env, false)
      installPlugin(dsh, 'immer@10.2.0', harnessDir, env, false)
      installPlugin(dsh, oldArtifact.path, harnessDir, env, false)
      const activeClientPeers = assertProfileClientPeers(profileDir, targetDshVersion, 'old profile install')
      fragment.clientPeers = {
        owner: 'active pi-tui profile',
        packages: activeClientPeers.map(([name, version]) => `${name}@${version}`),
      }
      const profilePackage = join(profileDir, 'node_modules', EXPECTED_PACKAGE_NAME)
      const oldProfilePackage = realpathSync(profilePackage)
      assert(existsSync(join(oldProfilePackage, 'dist', 'local-host.mjs')), 'the old profile install has no local Host entry')
      assert(existsSync(join(oldProfilePackage, 'dist', 'local-client.mjs')), 'the old profile install has no local Client entry')
      const oldBuildId = productionBuildId(oldProfilePackage, targetDshVersion)
      const oldPayloadHash = installedPayloadHash(oldProfilePackage)
      fragment.old.buildId = oldBuildId
      fragment.old.payloadSha256 = oldPayloadHash
      fragment.old.profilePackage = basename(oldProfilePackage)

      const c1Work = writeC1WorkFixture(profileDir, workRoot)
      const workRootPath = join(workRoot, 'c1-upgrade-work')
      mkdirSync(workRootPath, { recursive: true, mode: 0o700 })
      const releaseBarrier = join(workRoot, 'long-turn.release')
      const base = { cwd: profileDir, env: { ...env }, anchor, profile: 'pi-tui', scratch }
      const hostBase = {
        ...base,
        env: {
          ...base.env,
          SPLIT_PROCESS_EXTRA_PATCH: c1Work.patchPath,
          C1_SCENARIO: 'long-turn',
          C1_HOLD_LONG_TURN: releaseBarrier,
          C1_WORK_ROOT: workRootPath,
        },
      }

      // ── U01/U03: old Host A, old Client A, one real admitted Host Turn ──────
      checkpoint('U01-U06/base-pairing')
      const hostA = new EntryProcess('host', join(oldProfilePackage, 'dist', 'local-host.mjs'), hostBase)
      hosts.push(hostA)
      const hostAReady = await hostA.waitFor(record => record.m4a0 === 'ready', 'Host A ready', 240_000)
      assert(hostAReady.localHost.buildId === oldBuildId, 'Host A did not publish the old production buildId')
      assert(hostAReady.localHost.dshVersion === targetDshVersion,
        `Host A DSH version is not the pinned runtime ${targetDshVersion}`)
      const hostABefore = safeIdentity(hostAReady.localHost)
    failpoint('upgrade.cross-build-compatibility.after-old-host-spawn')

      const clientA = new SurfaceEntryProcess(join(oldProfilePackage, 'dist', 'local-client.mjs'), {
        ...base,
        workDir: workRoot,
        env: {
          ...base.env,
          // Qualification-only reexec trigger. The side-by-side target package
          // does not exist yet: the Client reads it only at the SIGUSR2 request.
          SPLIT_PROCESS_CLIENT_REEXEC_PROBE: '1',
          SPLIT_PROCESS_CLIENT_REEXEC_TARGET_PACKAGE_ROOT: sideBuildPackagePath,
        },
      })
      clients.push(clientA)
      const clientAReady = await clientA.waitFor(record => record.m4a0 === 'ready', 'Client A ready', 240_000)
      const clientAAuth = await clientA.waitFor(record => record.m4a0 === 'host-authenticated', 'Client A authenticated Host', 60_000)
      assertIdentityKept(clientAAuth.host, hostABefore, 'Client A authenticated Host')
      clientA.send('cross-build-hold\r')
      await clientA.waitForScreen('cross-build-hold', 'Client A prompt painted', 120_000)
      const sessionStatus = await clientA.waitFor(
        record => record.m4b2s === 'surface-status' && record.sessionOpen === true && typeof record.openSessionId === 'string',
        'Client A open Session',
        120_000,
      )
      const sessionId = sessionStatus.openSessionId
      const held = await waitForUpgradeC1WorkEvent(workRootPath, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'Host A Turn held')
      assert(held.agentStatus === 'running', `Host A Agent was ${JSON.stringify(held.agentStatus)} while the Turn was held`)
      fragment.work = { sessionId, agentStatusAtHold: 'running', turnHeld: true }
      await clientA.waitFor(
        record => record.m4a0 === 'ready' && record.transport === 'connected',
        'Client A connected transport',
        60_000,
      )
      const clientAPid = clientA.records.find(record => record.m4a0 === 'ready')?.pid
      assert(Number.isInteger(clientAPid), 'Client A ready record has no business PID')
      // Client A stays the live PTY Client until the side-by-side build exists
      // and Host A is proven unchanged; U07 then reexecutes it in place.
      assert(alive(hostAReady.pid), 'Host A died while Client A was attached')
      assertIdentityKept(safeIdentity((await hostStatus(hostA)).localHost), hostABefore, 'Host A while Client A is attached')
      assert(!c1WorkHadRelease(workRootPath), 'Host A Turn was released before the upgrade attempt')
      fragment.work.clientAPid = clientAPid

      // ── Install the NEW build side-by-side while Host A works ───────────────
      // The old Host and its admitted Turn already exist at this point, so this
      // is the real "introduce another installation while the old Host runs"
      // ordering. The old profile must keep both its resolution target and its
      // byte-identical payload; the production buildId is re-derived from disk.
      assert(alive(hostAReady.pid), 'Host A died before the side-by-side new install')
      assert(!c1WorkHadRelease(workRootPath), 'Host A Turn was released before the side-by-side new install')
      const sideBuildPackage = installSideBuild(sideBuildDir, newArtifact.path, env, targetDshVersion)
      for (const [name, version] of [
        ['@deepseek-ai/dsh-client-store', targetDshVersion],
        ['zustand', '4.5.7'],
        ['immer', '10.2.0'],
      ]) {
        const peerDir = realpathSync(join(sideBuildDir, 'node_modules', name))
        assert(readJson(join(peerDir, 'package.json')).version === version,
          `the side-by-side build installed a different ${name} version`)
        const resolvedPeer = realpathSync(createRequireFrom(join(sideBuildDir, 'package.json')).resolve(name))
        const peerRelative = relative(peerDir, resolvedPeer)
        assert(peerRelative !== '' && peerRelative !== '..' && !peerRelative.startsWith(`..${sep}`),
          `the side-by-side ${name} resolves outside its own package: ${resolvedPeer}`)
      }
      const newBuildId = productionBuildId(sideBuildPackage, targetDshVersion)
      assert(newBuildId !== oldBuildId, 'the two packaged builds produced the same production buildId')
      assert(productionBuildId(oldProfilePackage, targetDshVersion) === oldBuildId,
        'the side-by-side install changed the old profile production buildId')
      assert(installedPayloadHash(oldProfilePackage) === oldPayloadHash,
        'the side-by-side install changed bytes in the old profile payload')
      const profileAnchor = join(profileDir, 'package.json')
      const resolvedProfileIndex = realpathSync(createRequireFrom(profileAnchor).resolve(EXPECTED_PACKAGE_NAME))
      const resolvedProfilePackage = dirname(dirname(resolvedProfileIndex))
      assert(resolvedProfilePackage === oldProfilePackage, 'the profile no longer resolves the old installation after the side-by-side install')
      assert(alive(hostAReady.pid), 'Host A died on the side-by-side new install')
      assertIdentityKept(safeIdentity((await hostStatus(hostA)).localHost), hostABefore, 'Host A after the side-by-side new install')
      assert(!c1WorkHadRelease(workRootPath), 'Host A Turn was released by the side-by-side new install')
      fragment.new.buildId = newBuildId
      fragment.new.sideBuildPackage = basename(sideBuildPackage)
      fragment.new.installedAfterAdmittedWork = true
      fragment.old.profilePayloadUnchanged = true
      fragment.old.profileBuildIdUnchanged = true
      fragment.environment = {
        workRootOutsideCheckout: true,
        sideBuild: {
          location: relative(dshHome, sideBuildDir).split(sep).join('/'),
          siblingOfActiveProfile: true,
          packages: activeClientPeers.map(([name, version]) => `${name}@${version}`),
          reusesDshInstallationScope: true,
        },
      }

      // ── Capture old credentials while Host A still owns them ───────────────
      const scopeDir = scopeDirOf(dshHome, hostABefore.scopeId)
      const registryBefore = readFileSync(join(scopeDir, 'instance.json'))
      const launchBefore = readFileSync(join(scopeDir, 'launch.json'))
      const registryBeforeSha256 = createHash('sha256').update(registryBefore).digest('hex')
      const launchBeforeSha256 = createHash('sha256').update(launchBefore).digest('hex')
      const oldLaunch = readJson(join(scopeDir, 'launch.json'))
      const oldOrigin = new URL(oldLaunch.connectUrl).origin
      const oldToken = new URL(oldLaunch.connectUrl).searchParams.get('token')
      assert(typeof oldToken === 'string' && oldToken !== '', 'Host A launch material has no token')
      const oldConnectUrl = new URL(oldLaunch.connectUrl)
      oldConnectUrl.searchParams.set('interactions', 'answer')
      const oldConnect = await fetchStatus(oldConnectUrl.href)
      assert(oldConnect.status === 302 && oldConnect.setCookie !== '', `Host A rejected its own launch token with status ${String(oldConnect.status)}`)
      const oldCookie = oldConnect.setCookie.split(';')[0]
      assert(oldCookie.includes('='), 'Host A did not return a Cookie for its launch token')
      const oldCookieIdentity = await fetchStatus(`${oldOrigin}/api/pi-tui.local-host`, { headers: { cookie: oldCookie } })
      assert(oldCookieIdentity.status === 200, 'Host A did not accept its own minted Cookie')

      // ── U07: real Client-only reexec onto the SAME Host A / Session S ───────
      checkpoint('U07/reexec-request')
      // Client A is still the live PTY Client. The old Client must capture the
      // authoritative Session, release every Client resource through its ONE
      // stop coordinator, and only then spawn the NEW build's real entry as a
      // NEW OS PID. Host A, its Turn and its files must be untouched.
      const newClientEntry = join(sideBuildPackage, 'dist', 'local-client.mjs')
      const sessionLogsBeforeReexec = sessionLogFiles(dshHome)
      assert(alive(clientAPid), 'Client A was not a live Client before the reexec handoff')
      assert(alive(hostAReady.pid), 'Host A died before the reexec handoff')
      assert(!c1WorkHadRelease(workRootPath), 'Host A Turn was released before the reexec handoff')
      assertEqual(clientA.records.filter(record => record.m4b2s === 'client-closed').length, 0,
        'Client A closed itself before the reexec request')
      const reexecRequestFrom = clientA.records.length
      clientA.signalBusiness('SIGUSR2')
      const reexecRequested = await waitForAcceptedHandoff(
        clientA, clientAPid, 'Client A accepted the reexec handoff request', reexecRequestFrom,
      )
      assert(reexecRequested.sessionId === sessionId, 'the reexec request captured another Session')
      assert(reexecRequested.expectedHostInstanceId === hostABefore.instanceId, 'the reexec request captured another Host')
      assert(reexecRequested.targetBuildId === newBuildId, 'the reexec request captured another target build')
      assert(reexecRequested.targetBundleVersion === newArtifact.manifest.version, 'the reexec request captured another target version')
      const clientClosed = await clientA.waitFor(
        record => record.m4b2s === 'client-closed' && record.pid === clientAPid,
        'Client A released every owned Client resource',
        120_000,
      )
      assertEqual(clientClosed.sessionOpen, false, 'Client A still reported an open Session after its release')
      assertEqual(clientClosed.openSessionId, undefined, 'Client A still named an open Session after its release')
      assertEqual(clientClosed.surfaceMounted, false, 'Client A still reported a mounted surface after its release')
      assertEqual(clientClosed.activeWrappers, 0, 'Client A still owned an official transport wrapper after its release')
      assertEqual(clientClosed.liveSockets, 0, 'Client A still owned a live mux socket after its release')
      assertDeepEqual(clientClosed.owners, { typert: 0, connection: 0, remote: 0, fileUpload: 0, sessions: 0, jobs: 0 },
        'Client A still owned Client services after its release')
      const c1Started = await clientA.waitFor(
        record => record.m4a0 === 'client-started' && record.pid !== clientAPid,
        'the replacement Client started as a new OS process',
        120_000,
      )
      const c1Pid = c1Started.pid
      assert(Number.isInteger(c1Pid) && c1Pid !== clientAPid, 'the replacement Client did not get a new OS PID')
      assert(alive(clientAPid), 'the old Client parent exited before its replacement finished')
      const c1Auth = await clientA.waitFor(
        record => record.m4a0 === 'host-authenticated' && record.pid === c1Pid,
        'the replacement Client authenticated Host A',
        180_000,
      )
      assertIdentityKept(c1Auth.host, hostABefore, 'replacement Client authenticated Host A')
      assert(c1Auth.host.buildId === oldBuildId, 'the replacement Client authenticated another Host build')
      const c1Restored = await clientA.waitFor(
        record => record.m4r === 'handoff-restored' && record.pid === c1Pid,
        'the replacement Client restored the original Session',
        180_000,
      )
      assertEqual(c1Restored.expectedHostInstanceId, hostABefore.instanceId)
      assertEqual(c1Restored.hostInstanceId, hostABefore.instanceId)
      assertEqual(c1Restored.sessionId, sessionId)
      assertEqual(c1Restored.sessionOpen, true)
      assertEqual(c1Restored.sessionHistoryOpen, true)
      assertEqual(c1Restored.surfaceMounted, true)
      assertEqual(c1Restored.transport, 'connected')
      assertEqual(c1Restored.clientBuildId, newBuildId, 'the replacement Client did not run the target build')
      assertNotEqual(c1Restored.clientBuildId, oldBuildId, 'the replacement Client re-ran the old build')
      const c1Ready = await clientA.waitFor(
        record => record.m4a0 === 'ready' && record.pid === c1Pid,
        'the replacement Client ready',
        120_000,
      )
      assertEqual(c1Ready.transport, 'connected')
      assertEqual(c1Ready.host?.instanceId, hostABefore.instanceId)
      assertEqual(c1Ready.sessionOpen, true)
      assertEqual(c1Ready.openSessionId, sessionId)
      await clientA.waitForScreen('cross-build-hold', 'the replacement surface painted the admitted prompt', 120_000)
      // While C1 runs, the OLD PID is only the waiting parent and owns nothing;
      // the replacement is the ONE live surface process for this terminal.
      assert(alive(c1Pid), 'the replacement surface process is not alive')
      assert(alive(hostAReady.pid), 'Host A died during the reexec handoff')
      assert(readProcessStarttime(hostAReady.pid) === hostABefore.hostStarttime,
        'Host A starttime changed during the reexec handoff')
      assertIdentityKept(safeIdentity((await hostStatus(hostA)).localHost), hostABefore, 'Host A after the reexec handoff')
      assert(!c1WorkHadRelease(workRootPath), 'Host A Turn was released by the reexec handoff')
      assert(readFileSync(join(scopeDir, 'instance.json')).equals(registryBefore),
        'the reexec handoff mutated the old registry')
      assert(readFileSync(join(scopeDir, 'launch.json')).equals(launchBefore),
        'the reexec handoff mutated the old launch material')
      assertDeepEqual(sessionLogFiles(dshHome), sessionLogsBeforeReexec,
        'the reexec handoff created a new Session log')
      // Only the HUMAN-authored prompt counts: the Host also appends its own
      // runtime-context/time-context user-message snapshots on every turn.
      const promptsAfterReexec = (hostSessionEvents(dshHome, sessionId) ?? [])
        .filter(event => event.type === 'user/message'
          && event.data?.source?.kind === 'user'
          && JSON.stringify(event.data?.content ?? []).includes('cross-build-hold'))
      assertEqual(promptsAfterReexec.length, 1,
        `the reexec handoff replayed or duplicated the admitted prompt: ${JSON.stringify(promptsAfterReexec)}`)
      assertNoSecret('replacement Client records', JSON.stringify(clientA.records), [oldToken, oldCookie])
      assertNoSecret('replacement Client terminal', clientA.raw, [oldToken, oldCookie])
      // The replacement Client is addressed through the SAME real terminal.
      clientA.send('/exit\r')
      const reexecExit = await clientA.waitForExit(120_000)
      assertEqual(reexecExit.code, 0, `the replacement Client exit was ${JSON.stringify(reexecExit)}`)
      assertEqual(reexecExit.signal, null)
      assert(await waitGone(c1Pid), 'the replacement Client process did not exit')
      assert(await waitGone(clientAPid), 'the old Client waiting parent did not exit')
      assert(alive(hostAReady.pid), 'Host A died when the replacement Client exited')
      assert(!c1WorkHadRelease(workRootPath), 'Host A Turn was released when the replacement Client exited')
      assertIdentityKept(safeIdentity((await hostStatus(hostA)).localHost), hostABefore, 'Host A after the replacement Client exit')
      assert(readFileSync(join(scopeDir, 'instance.json')).equals(registryBefore),
        'the replacement Client exit mutated the old registry')
      assert(readFileSync(join(scopeDir, 'launch.json')).equals(launchBefore),
        'the replacement Client exit mutated the old launch material')
      await clientA.dispose()
      fragment.work.workContinuedAfterClientExit = true
      fragment.reexecHandoff = {
        oldClientPid: clientAPid,
        replacementClientPid: c1Pid,
        newOsPid: c1Pid !== clientAPid,
        oldParentWaitedDuringChild: true,
        oldClientOwnersReleased: true,
        oldClientSessionReferenceReleased: true,
        replacementClientWasNewOsProcess: c1Pid !== clientAPid,
        targetBundleVersion: newArtifact.manifest.version,
        targetBuildId: newBuildId,
        oldBuildId,
        clientBuildChanged: newBuildId !== oldBuildId,
        hostInstanceId: hostABefore.instanceId,
        hostInstanceIdKept: true,
        hostPidKept: true,
        hostStarttimeKept: true,
        hostBuildIdKept: c1Auth.host.buildId === oldBuildId,
        sessionId,
        sessionOpen: true,
        sessionHistoryOpen: true,
        surfacePromptVisible: true,
        registryBytesUnchanged: true,
        launchBytesUnchanged: true,
        noNewSessionLog: true,
        promptNotReplayed: true,
        workStillRunning: true,
        exitCode: reexecExit.code,
        secretLeak: false,
      }

      // ── U07 negative 1: a wrong expected Host instance is refused pre-connect ─
      checkpoint('U07/negative-wrong-instance')
      const registryBeforeRefusal = readFileSync(join(scopeDir, 'instance.json'))
      const launchBeforeRefusal = readFileSync(join(scopeDir, 'launch.json'))
      const sessionLogsBeforeRefusal = sessionLogFiles(dshHome)
      const wrongExpectation = new SurfaceEntryProcess(newClientEntry, {
        ...base,
        workDir: workRoot,
        env: { ...base.env, SPLIT_PROCESS_CLIENT_EXPECTED_INSTANCE_ID: randomUUID() },
      })
      clients.push(wrongExpectation)
      const wrongExpectationExit = await wrongExpectation.waitForExit(120_000)
      // The shared PTY harness stops its 25ms record poller on close; flush the
      // complete final JSONL lines once more before asserting on exit records.
      wrongExpectation.readRecords()
      assert(wrongExpectationExit.code !== 0,
        `a wrong expected Host instance exited ${JSON.stringify(wrongExpectationExit)}`)
      assert(!wrongExpectation.records.some(record => record.m4a0 === 'ready'),
        'a wrong expected Host instance published ready')
      assert(!wrongExpectation.records.some(record => record.m4a0 === 'host-authenticated'),
        'a wrong expected Host instance authenticated the live Host')
      const wrongFailure = wrongExpectation.records.find(record => record.m4a0 === 'failure')
      assert(wrongFailure?.code === 'HOST_IDENTITY_MISMATCH',
        `the wrong expected Host instance failed as ${JSON.stringify(wrongFailure)}; records=${JSON.stringify(wrongExpectation.records.slice(-6))}`)
      const wrongVisible = `${wrongExpectation.raw}\n${wrongExpectation.stderr}`
      const wrongFailureLines = wrongVisible.split('\n').filter(line => line.includes('Client handoff failed'))
      assertEqual(wrongFailureLines.length, 1, `the wrong expected Host produced ${String(wrongFailureLines.length)} handoff failure lines`)
      const wrongFailureLine = wrongFailureLines[0]
      assertMatch(wrongFailureLine, /Client handoff failed: the live local Host is not the expected instance\./u)
      assertMatch(wrongFailureLine, /The Host was not stopped or replaced\./u)
      assertMatch(wrongFailureLine, /Start a compatible Client manually to continue\./u)
      assertNoSecret('wrong expected Host terminal', wrongVisible, [oldToken, oldCookie])
      for (const privateValue of [scopeDir, sideBuildPackage, workRoot, String(hostABefore.hostPid)]) {
        assert(!wrongFailureLine.includes(privateValue), `the wrong expected Host failure leaked ${JSON.stringify(privateValue)}`)
      }
      assert(alive(hostAReady.pid), 'Host A died on the wrong expected Host refusal')
      assert(readProcessStarttime(hostAReady.pid) === hostABefore.hostStarttime,
        'Host A starttime changed on the wrong expected Host refusal')
      assertIdentityKept(safeIdentity((await hostStatus(hostA)).localHost), hostABefore,
        'Host A after the wrong expected Host refusal')
      assert(!c1WorkHadRelease(workRootPath), 'Host A Turn was released by the wrong expected Host refusal')
      assert(readFileSync(join(scopeDir, 'instance.json')).equals(registryBeforeRefusal),
        'the wrong expected Host refusal mutated the old registry')
      assert(readFileSync(join(scopeDir, 'launch.json')).equals(launchBeforeRefusal),
        'the wrong expected Host refusal mutated the old launch material')
      assertDeepEqual(sessionLogFiles(dshHome), sessionLogsBeforeRefusal,
        'the wrong expected Host refusal created a new Session log')
      await wrongExpectation.dispose()
      fragment.reexecRefusals = {
        wrongExpectedHost: {
          exitCode: wrongExpectationExit.code,
          errorCode: wrongFailure.code,
          noReady: true,
          noHostConnect: true,
          hostKept: true,
          registryBytesUnchanged: true,
          launchBytesUnchanged: true,
          noNewSession: true,
          noBusinessContextCreated: true,
          noPathPidOrSecret: true,
        },
      }

      // ── U07 negative 2: the replacement child fails after a real reexec ─────
      checkpoint('U07/negative-child-failure')
      // The one-shot fault injection exists only in the OLD Client's environment
      // and is passed to the CHILD, never applied to the old Client itself.
      const clientA2 = new SurfaceEntryProcess(join(oldProfilePackage, 'dist', 'local-client.mjs'), {
        ...base,
        workDir: workRoot,
        env: {
          ...base.env,
          SPLIT_PROCESS_CLIENT_SESSION: sessionId,
          SPLIT_PROCESS_CLIENT_REEXEC_PROBE: '1',
          SPLIT_PROCESS_CLIENT_REEXEC_TARGET_PACKAGE_ROOT: sideBuildPackagePath,
          SPLIT_PROCESS_CLIENT_REEXEC_CHILD_FAILURE: 'client-bootstrap',
        },
      })
      clients.push(clientA2)
      const clientA2Ready = await clientA2.waitFor(record => record.m4a0 === 'ready', 'second old Client ready', 240_000)
      const clientA2Pid = clientA2Ready.pid
      assert(Number.isInteger(clientA2Pid), 'the second old Client ready record has no business PID')
      await clientA2.waitFor(
        record => record.m4b2s === 'surface-status' && record.sessionOpen === true && record.openSessionId === sessionId,
        'the second old Client opened the existing Session',
        120_000,
      )
      const sessionLogsBeforeChildFailure = sessionLogFiles(dshHome)
      const childFailureRequestFrom = clientA2.records.length
      clientA2.signalBusiness('SIGUSR2')
      // The failed child ends the whole PTY process tree quickly. Wait for the
      // real exit first, then flush the complete record tail once (the shared
      // harness stops its 25ms poller on close) before asserting the sequence.
      const childFailureExit = await clientA2.waitForExit(120_000)
      clientA2.readRecords()
      assertEqual(childFailureExit.code, 1, `the failed handoff exit was ${JSON.stringify(childFailureExit)}`)
      assertEqual(childFailureExit.signal, null)
      // The special fault injection stays the expectation: this only proves THIS
      // action's request was accepted before the injected child failure.
      const reexecRequested2 = await waitForAcceptedHandoff(
        clientA2, clientA2Pid, 'the second old Client accepted the reexec request', childFailureRequestFrom,
      )
      assertEqual(reexecRequested2.sessionId, sessionId)
      const clientClosed2 = clientA2.records.find(
        record => record.m4b2s === 'client-closed' && record.pid === clientA2Pid,
      )
      assert(clientClosed2 !== undefined,
        `the second old Client never released its owners; records=${JSON.stringify(clientA2.records.slice(-6))}`)
      assertEqual(clientClosed2.sessionOpen, false)
      assertDeepEqual(clientClosed2.owners, { typert: 0, connection: 0, remote: 0, fileUpload: 0, sessions: 0, jobs: 0 })
      const childFailure = clientA2.records.find(
        record => record.m4a0 === 'failure' && record.pid !== clientA2Pid,
      )
      assert(childFailure !== undefined,
        `the replacement Client did not report its failure; records=${JSON.stringify(clientA2.records.slice(-6))}`)
      assertMatch(childFailure.error, /qualification forced client bootstrap failure/u)
      assert(!clientA2.records.some(record => record.m4a0 === 'ready' && record.pid !== clientA2Pid),
        'a failed replacement Client published ready')
      const parentExit = clientA2.records.find(
        record => record.m4r === 'handoff-parent-exit' && record.pid === clientA2Pid,
      )
      assert(parentExit !== undefined,
        `the old Client parent never reported the replacement exit; records=${JSON.stringify(clientA2.records.slice(-6))}`)
      assertEqual(parentExit.code, 1, `the old Client parent reported ${JSON.stringify(parentExit)}`)
      assertEqual(parentExit.signal, null)
      assert(await waitGone(childFailure.pid), 'the failed replacement Client process stayed alive')
      assert(await waitGone(clientA2Pid), 'the old Client parent stayed alive after the failed child')
      const childFailureVisible = `${clientA2.raw}\n${clientA2.stderr}`
      const childFailureLines = childFailureVisible.split('\n').filter(line => line.includes('Client handoff failed'))
      assertEqual(childFailureLines.length, 1, `the failed child produced ${String(childFailureLines.length)} handoff failure lines`)
      assertMatch(childFailureLines[0], /Client handoff failed: qualification forced client bootstrap failure\./u)
      assertMatch(childFailureLines[0], /Start a compatible Client manually to continue\./u)
      assertNoSecret('failed replacement terminal', childFailureVisible, [oldToken, oldCookie])
      assert(alive(hostAReady.pid), 'Host A died when the replacement Client failed')
      assert(readProcessStarttime(hostAReady.pid) === hostABefore.hostStarttime,
        'Host A starttime changed when the replacement Client failed')
      assertIdentityKept(safeIdentity((await hostStatus(hostA)).localHost), hostABefore,
        'Host A after the failed replacement Client')
      assert(!c1WorkHadRelease(workRootPath), 'Host A Turn was released by the failed replacement Client')
      assert(readFileSync(join(scopeDir, 'instance.json')).equals(registryBefore),
        'the failed replacement Client mutated the old registry')
      assert(readFileSync(join(scopeDir, 'launch.json')).equals(launchBefore),
        'the failed replacement Client mutated the old launch material')
      assertDeepEqual(sessionLogFiles(dshHome), sessionLogsBeforeChildFailure,
        'the failed replacement Client created a new Session log')
      const promptsAfterChildFailure = (hostSessionEvents(dshHome, sessionId) ?? [])
        .filter(event => event.type === 'user/message'
          && event.data?.source?.kind === 'user'
          && JSON.stringify(event.data?.content ?? []).includes('cross-build-hold'))
      assertEqual(promptsAfterChildFailure.length, 1, 'the failed replacement Client replayed the admitted prompt')
      await clientA2.dispose()
      fragment.reexecRefusals.childFailure = {
        oldClientPid: clientA2Pid,
        failedChildPid: childFailure.pid,
        childFailureError: childFailure.error,
        oldClientOwnersReleased: true,
        parentExitCode: parentExit.code,
        processExitCode: childFailureExit.code,
        parentAndChildExited: true,
        hostKept: true,
        hostStarttimeKept: true,
        noHostRestart: true,
        registryBytesUnchanged: true,
        launchBytesUnchanged: true,
        noNewSession: true,
        noReplay: true,
        noAutoRecovery: true,
        secretLeak: false,
      }

      // ── U02: new Client B speaks v1 to the live old Host A ─────────────────
      checkpoint('U02/cross-build-attach')

      // The new package has a different version, bundle and buildId but the same
      // local protocol and exact DSH runtime. It must authenticate the SAME Host
      // A, call the real official/private RPCs, and exit without touching Host
      // A, its Registry/Launch files or the admitted Turn.
      const clientB = new EntryProcess('client', newClientEntry, base)
      clients.push(clientB)
      const clientBAuth = await clientB.waitFor(
        record => record.m4a0 === 'host-authenticated',
        'new Client B authenticated Host A',
        180_000,
      )
      assertIdentityKept(clientBAuth.host, hostABefore, 'new Client B authenticated Host A')
      assert(clientBAuth.host.buildId === oldBuildId, 'new Client B authenticated a different Host build')
      const clientBReady = await clientB.waitFor(record => record.m4a0 === 'ready', 'new Client B ready', 240_000)
      assert(clientBReady.transport === 'connected', `new Client B transport was ${JSON.stringify(clientBReady.transport)}`)
      assert(clientBReady.host?.instanceId === hostABefore.instanceId, 'new Client B ready record names another Host')
      const crossBuildRpcRequestId = 'pr2-cross-build-rpc'
      clientB.send({ op: 'qualification-host-foundation', requestId: crossBuildRpcRequestId })
      const crossBuildRpc = await clientB.waitFor(
        record => record.m4b2hf === 'host-rpc-proof' && record.requestId === crossBuildRpcRequestId,
        'new Client B cross-build Host RPC proof',
        180_000,
      )
      assert(crossBuildRpc.hostPid === hostABefore.hostPid, 'cross-build RPC proof names another Host PID')
      assert(crossBuildRpc.hostInstanceId === hostABefore.instanceId, 'cross-build RPC proof names another Host instance')
      assert(crossBuildRpc.clientPid === clientBReady.pid, 'cross-build RPC proof names another Client PID')
      for (const field of ['officialSessionList', 'privateFileRpc', 'terminalSnapshot', 'cleaned']) {
        assert(crossBuildRpc[field] === true, `cross-build RPC proof ${field} is not true`)
      }
      assert(alive(hostAReady.pid), 'Host A died while the new Client was connected')
      assert(readProcessStarttime(hostAReady.pid) === hostABefore.hostStarttime,
        'Host A starttime changed while the new Client was connected')
      assertIdentityKept(safeIdentity((await hostStatus(hostA)).localHost), hostABefore, 'Host A after new Client B')
      const crossBuildLiveness = (await hostStatus(hostA)).liveness
      assert(crossBuildLiveness?.verdict === 'BLOCKED',
        `Host A liveness was ${JSON.stringify(crossBuildLiveness?.verdict)} during the admitted Turn`)
      assert(!c1WorkHadRelease(workRootPath), 'Host A Turn was released while the new Client was connected')
      assert(readFileSync(join(scopeDir, 'instance.json')).equals(registryBefore), 'new Client B mutated the old registry')
      assert(readFileSync(join(scopeDir, 'launch.json')).equals(launchBefore), 'new Client B mutated the old launch material')
      const clientBExit = await clientB.shutdown()
      assert(clientBExit.code === 0 && clientBExit.signal === null, `new Client B exit was ${JSON.stringify(clientBExit)}`)
      assert(!clientB.records.some(record => record.m4a0 === 'cleanup-failure'), 'new Client B reported a cleanup failure')
      assert(await seatIsFree(`\0dsh-pi-tui-c-${hostABefore.scopeId.slice(0, 40)}`), 'new Client B did not release the Client seat')
      assert(alive(hostAReady.pid), 'Host A died when the new Client exited')
      assertIdentityKept(safeIdentity((await hostStatus(hostA)).localHost), hostABefore, 'Host A after new Client B exit')
      assert(readFileSync(join(scopeDir, 'instance.json')).equals(registryBefore), 'new Client B exit mutated the old registry')
      assert(readFileSync(join(scopeDir, 'launch.json')).equals(launchBefore), 'new Client B exit mutated the old launch material')
      assertNoSecret('cross-build Client records', JSON.stringify(clientB.records), [oldToken, oldCookie])
      assertNoSecret('cross-build Client stderr', clientB.stderr, [oldToken, oldCookie])
      fragment.crossBuildClient = {
        clientPid: clientBReady.pid,
        hostPid: hostABefore.hostPid,
        hostStarttimeKept: true,
        hostInstanceIdKept: true,
        hostBuildIdKept: hostABefore.buildId === oldBuildId,
        clientBundleDifferent: newArtifact.manifest.version !== oldArtifact.manifest.version,
        clientBuildIdDifferent: newBuildId !== oldBuildId,
        protocol: 'dsh-pi-tui/local/1',
        dshVersion: targetDshVersion,
        transport: 'connected',
        rpcRequestId: crossBuildRpcRequestId,
        officialSessionList: true,
        privateFileRpc: true,
        terminalSnapshot: true,
        cleaned: true,
        registryBytesUnchanged: true,
        registrySha256: registryBeforeSha256,
        launchBytesUnchanged: true,
        launchSha256: launchBeforeSha256,
        hostAlive: true,
        clientSeatReleased: true,
        workStillRunning: true,
        livenessVerdict: crossBuildLiveness.verdict,
        secretLeak: false,
      }
      fragment.hostA = {
        pid: hostABefore.hostPid,
        starttime: hostABefore.hostStarttime,
        instanceId: hostABefore.instanceId,
        buildId: hostABefore.buildId,
        scopeId: hostABefore.scopeId,
      }

      // ── U04: the new build's REAL surface opens the running old Session ─────
      checkpoint('U04/cross-build-surface')
      // The qualification Client above proves the RPC path; this is the real PTY
      // surface. It must open the SAME Session whose Turn is currently held,
      // paint its admitted prompt, and exit without releasing the Turn or
      // changing Host A's identity/files.
      const crossBuildSurface = new SurfaceEntryProcess(newClientEntry, {
        ...base,
        workDir: workRoot,
        env: { ...base.env, SPLIT_PROCESS_CLIENT_SESSION: sessionId },
      })
      clients.push(crossBuildSurface)
      const crossBuildSurfaceReady = await crossBuildSurface.waitFor(
        record => record.m4a0 === 'ready',
        'cross-build surface ready',
        240_000,
      )
      assert(crossBuildSurfaceReady.transport === 'connected',
        `cross-build surface transport was ${JSON.stringify(crossBuildSurfaceReady.transport)}`)
      const crossBuildSurfaceStatus = await crossBuildSurface.waitFor(
        record => record.m4b2s === 'surface-status' && record.sessionOpen === true && record.openSessionId === sessionId,
        'cross-build surface opened the running old Session',
        180_000,
      )
      assert(crossBuildSurfaceStatus.openSessionId === sessionId, 'cross-build surface opened another Session')
      await crossBuildSurface.waitForScreen('cross-build-hold', 'cross-build surface painted the admitted prompt', 120_000)
      assert(alive(hostAReady.pid), 'Host A died while the cross-build surface was attached')
      assert(readProcessStarttime(hostAReady.pid) === hostABefore.hostStarttime,
        'Host A starttime changed while the cross-build surface was attached')
      assertIdentityKept(safeIdentity((await hostStatus(hostA)).localHost), hostABefore, 'Host A while the cross-build surface is attached')
      assert(!c1WorkHadRelease(workRootPath), 'Host A Turn was released by the cross-build surface attach')
      assert(readFileSync(join(scopeDir, 'instance.json')).equals(registryBefore), 'cross-build surface mutated the old registry')
      assert(readFileSync(join(scopeDir, 'launch.json')).equals(launchBefore), 'cross-build surface mutated the old launch material')
      const crossBuildSurfaceExit = await (async () => {
        crossBuildSurface.send('/exit\r')
        return await crossBuildSurface.waitForExit(60_000)
      })()
      assert(crossBuildSurfaceExit.code === 0 && crossBuildSurfaceExit.signal === null,
        `cross-build surface exit was ${JSON.stringify(crossBuildSurfaceExit)}`)
      await crossBuildSurface.dispose()
      assert(alive(hostAReady.pid), 'Host A died when the cross-build surface exited')
      assert(readProcessStarttime(hostAReady.pid) === hostABefore.hostStarttime,
        'Host A starttime changed after the cross-build surface exit')
      assertIdentityKept(safeIdentity((await hostStatus(hostA)).localHost), hostABefore, 'Host A after cross-build surface exit')
      assert(!c1WorkHadRelease(workRootPath), 'Host A Turn was released by the cross-build surface exit')
      assert(readFileSync(join(scopeDir, 'instance.json')).equals(registryBefore), 'cross-build surface exit mutated the old registry')
      assert(readFileSync(join(scopeDir, 'launch.json')).equals(launchBefore), 'cross-build surface exit mutated the old launch material')
      assertNoSecret('cross-build surface records', JSON.stringify(crossBuildSurface.records), [oldToken, oldCookie])
      assertNoSecret('cross-build surface stderr', crossBuildSurface.stderr, [oldToken, oldCookie])
      fragment.crossBuildSurface = {
        clientPid: crossBuildSurfaceReady.pid,
        sessionId,
        sessionOpen: true,
        openSessionIdKept: true,
        promptVisible: true,
        transport: 'connected',
        hostPidKept: true,
        hostStarttimeKept: true,
        hostInstanceIdKept: true,
        registryBytesUnchanged: true,
        registrySha256: registryBeforeSha256,
        launchBytesUnchanged: true,
        launchSha256: launchBeforeSha256,
        hostAlive: true,
        workStillRunning: true,
        secretLeak: false,
      }

      // ── The admitted work completes normally after both cross-build attaches ─
      // The barrier only controls the test's stream timing; releasing it proves
      // the old Host was never stopped or replaced by either new-Client attempt.
      writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
      const released = await waitForUpgradeC1WorkEvent(
        workRootPath,
        event => event.kind === 'long-turn-released' && event.sessionId === sessionId,
        'Host A Turn completes after the cross-build attaches',
      )
      assert(released.sessionId === sessionId, 'Host A Turn completion names another Session')
      await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'Host A turn/end after the cross-build attaches')
      const durableEvents = hostSessionEvents(dshHome, sessionId) ?? []
      assert(durableEvents.some(event => event.type === 'user/message' && JSON.stringify(event).includes('cross-build-hold')),
        'the durable Session lost the admitted prompt')
      fragment.work.completedAfterCrossBuild = true

      // ── U05: explicit owner-verified SIGTERM, one official shutdown ─────────
      checkpoint('U05/host-stop')
      // Production spawns the Host with stdin ignored. The qualification harness
      // keeps a JSONL control pipe open, so close it before the signal: an open
      // `process.stdin` would keep the Node event loop alive after the completed
      // owner cleanup and turn a real graceful exit into a false timeout.
      hostA.child.stdin.end()
      assert(readProcessStarttime(hostAReady.pid) === hostABefore.hostStarttime, 'the stop target PID starttime no longer matches Host A')
      process.kill(hostAReady.pid, 'SIGTERM')
      const stopRequested = await hostA.waitFor(record => record.m4a0 === 'stop-requested', 'Host A stop-requested', 60_000)
      assert(stopRequested.signal === 'SIGTERM', `Host A stop signal was ${JSON.stringify(stopRequested.signal)}`)
      const cleanup = await hostA.waitFor(record => record.m4a0 === 'cleanup' || record.m4a0 === 'cleanup-failure', 'Host A cleanup', 120_000)
      assert(cleanup.m4a0 === 'cleanup' && cleanup.status === 'completed', `Host A cleanup was ${JSON.stringify(cleanup)}`)
      const hostAExit = await hostA.waitForExit(120_000)
      assert(hostAExit.code === 0 && hostAExit.signal === null, `Host A explicit stop exit was ${JSON.stringify(hostAExit)}`)
      assert(hostA.records.filter(record => record.m4a0 === 'stop-requested').length === 1, 'Host A admitted more than one stop intent')
      assert(hostA.records.filter(record => record.m4a0 === 'cleanup').length === 1, 'Host A reported more than one cleanup')
      assert(!hostA.records.some(record => record.m4a0 === 'cleanup-failure'), 'Host A reported a cleanup failure')
      assert(!existsSync(join(scopeDir, 'instance.json')), 'Host A left its instance.json behind')
      assert(!existsSync(join(scopeDir, 'launch.json')), 'Host A left its launch.json behind')
      assert(scopeScratchDirs(scopeDir).length === 0, 'Host A left its owner scratch behind')
      assert(await seatIsFree(`\0dsh-pi-tui-h-${hostABefore.scopeId.slice(0, 40)}`), 'Host A did not release the kernel Host seat')
      assert(await waitGone(hostAReady.pid), 'Host A process did not exit')
      fragment.stop = {
        signal: 'SIGTERM',
        stopRequests: 1,
        cleanupCompleted: 1,
        cleanupFailures: 0,
        exitCode: hostAExit.code,
        instanceRemoved: true,
        launchRemoved: true,
        scratchRemoved: true,
        hostSeatReleased: true,
      }

      // ── U06: after the old Host is gone, install the new build and boot it ─
      checkpoint('U06/new-host-boot')
      installPlugin(dsh, newArtifact.path, harnessDir, env, false)
      // Replacing the bundle must not prune the Client peer from the same
      // profile owner.
      assertProfileClientPeers(profileDir, targetDshVersion, 'upgraded profile install')
      fragment.clientPeers.upgradedProfileOwnsPeers = true
      const installedNewPackage = realpathSync(profilePackage)
      assert(existsSync(join(installedNewPackage, 'dist', 'local-host.mjs')), 'the upgraded profile has no new local Host entry')
      const installedNewBuildId = productionBuildId(installedNewPackage, targetDshVersion)
      assert(installedNewBuildId === newBuildId, 'the upgraded profile buildId differs from the side-by-side new build')
      const clientB2 = new SurfaceEntryProcess(join(installedNewPackage, 'dist', 'local-client.mjs'), {
        ...base,
        workDir: workRoot,
        env: { ...base.env, SPLIT_PROCESS_CLIENT_SESSION: sessionId },
      })
      clients.push(clientB2)
      const clientB2Ready = await clientB2.waitFor(record => record.m4a0 === 'ready', 'second new-build Client ready', 240_000)
      const newAuth = await clientB2.waitFor(record => record.m4a0 === 'host-authenticated', 'second new-build Client authenticated Host', 60_000)
      const newHost = safeIdentity(newAuth.host)
      const newScopeDir = scopeDirOf(dshHome, newHost.scopeId)
      // The Client cold-started this Host, so no EntryProcess handle owns it.
      // Record its real kernel identity now: THIS case stops it on failure too.
      detachedHost = { pid: newHost.hostPid, starttime: newHost.hostStarttime, scopeDir: newScopeDir }
      assert(newHost.scopeId === hostABefore.scopeId, 'the new Host changed the canonical scope id')
      assert(newHost.instanceId !== hostABefore.instanceId, 'the new Host reused the old instance id')
      assert(newHost.hostPid !== hostABefore.hostPid, 'the new Host reused the old PID')
      assert(newHost.hostStarttime !== hostABefore.hostStarttime, 'the new Host reused the old starttime')
      assert(newHost.buildId === newBuildId, 'the new Host did not publish the new production buildId')
      assert(clientB2Ready.transport === 'connected', `second new-build Client transport was ${JSON.stringify(clientB2Ready.transport)}`)
      assert(clientB2Ready.host?.instanceId === newHost.instanceId, 'second new-build Client ready record names another Host')
      await clientB2.waitForScreen('cross-build-hold', 'second new-build Client durable Session readback', 120_000)
      const resumedStatus = await clientB2.waitFor(
        record => record.m4b2s === 'surface-status' && record.openSessionId === sessionId,
        'second new-build Client resumed the durable Session',
        120_000,
      )
      assert(resumedStatus.openSessionId === sessionId, 'second new-build Client did not resume the persisted Session id')
      const resumedDurable = hostSessionEvents(dshHome, sessionId) ?? []
      assert(resumedDurable.some(event => event.type === 'user/message' && JSON.stringify(event).includes('cross-build-hold')),
        'the durable Session history lost the admitted prompt after the new Host boot')
      assert(resumedDurable.some(event => event.type === 'turn/start'), 'the durable Session history lost the Turn start')
      assert(resumedDurable.some(event => event.type === 'turn/end'), 'the durable Session history lost the Turn end')

      // Old launch token and Cookie are invalid on the new Host.
      const newLaunch = readJson(join(newScopeDir, 'launch.json'))
      const newToken = new URL(newLaunch.connectUrl).searchParams.get('token')
      assert(typeof newToken === 'string' && newToken !== oldToken, 'the new Host reused the old launch token')
      const oldTokenOnNew = await fetchStatus(`${newHost.origin}/connect?token=${encodeURIComponent(oldToken)}&interactions=answer`)
      assert(oldTokenOnNew.status === 401 || oldTokenOnNew.status === 403 || oldTokenOnNew.status === 400,
        `the new Host accepted the old token with status ${String(oldTokenOnNew.status)}`)
      const oldCookieOnNew = await fetchStatus(`${newHost.origin}/api/pi-tui.local-host`, { headers: { cookie: oldCookie } })
      assert(oldCookieOnNew.status === 401 || oldCookieOnNew.status === 403,
        `the new Host accepted the old Cookie with status ${String(oldCookieOnNew.status)}`)
      fragment.newHost = {
        pid: newHost.hostPid,
        starttime: newHost.hostStarttime,
        instanceId: newHost.instanceId,
        buildId: newHost.buildId,
        scopeIdSame: true,
        authenticated: true,
        transport: 'connected',
        durableSessionReadback: true,
        oldTokenRejectedStatus: oldTokenOnNew.status,
        oldCookieRejectedStatus: oldCookieOnNew.status,
        oldInMemoryTurnNotContinued: true,
      }

      const clientB2Exit = await (async () => {
        clientB2.send('/exit\r')
        return await clientB2.waitForExit(60_000)
      })()
      assert(clientB2Exit.code === 0 && clientB2Exit.signal === null, `second new-build Client exit was ${JSON.stringify(clientB2Exit)}`)
      await clientB2.dispose()
      assert(alive(newHost.hostPid), 'the new Host died when its Client exited')
      // Stop the new Host through the same explicit owner-governed path. The
      // Host was spawned by the Client (not by this lane), so its records are in
      // the 0600 host.log and its starttime is rechecked before the signal.
      assert(readProcessStarttime(newHost.hostPid) === newHost.hostStarttime, 'the new Host stop target starttime no longer matches')
      process.kill(newHost.hostPid, 'SIGTERM')
      assert(await waitGone(newHost.hostPid, 120_000), 'the new Host process did not exit after SIGTERM')
      const newHostRecords = readHostLogRecords(newScopeDir, newHost.hostPid)
      assert(newHostRecords.filter(record => record.m4a0 === 'stop-requested').length === 1, 'the new Host did not admit exactly one stop intent')
      const newCleanup = newHostRecords.find(record => record.m4a0 === 'cleanup' || record.m4a0 === 'cleanup-failure')
      assert(newCleanup?.m4a0 === 'cleanup' && newCleanup.status === 'completed', `the new Host cleanup was ${JSON.stringify(newCleanup)}`)
      assert(!newHostRecords.some(record => record.m4a0 === 'cleanup-failure'), 'the new Host reported a cleanup failure')
      assert(!existsSync(join(newScopeDir, 'instance.json')), 'the new Host left its instance.json behind')
      assert(!existsSync(join(newScopeDir, 'launch.json')), 'the new Host left its launch.json behind')
      assert(await seatIsFree(`\0dsh-pi-tui-h-${newHost.scopeId.slice(0, 40)}`), 'the new Host did not release the kernel Host seat')

      for (const path of [oldArtifact.path, newArtifact.path]) {
        assert(sha256(path) === (path === oldArtifact.path ? oldArtifact.sha256 : newArtifact.sha256),
          `the packaged artifact changed during the lane: ${basename(path)}`)
      }
      // Historical Full evidence compatibility summary. This is measured by the
      // cross-build case only; selected U08/U09 runs never receive this block.
      fragment.compatibility = {
        protocol: 'dsh-pi-tui/local/1',
        dshVersion: targetDshVersion,
        oldBuildId,
        newBuildId,
        differentBundleVersions: oldArtifact.manifest.version !== newArtifact.manifest.version,
        differentBuildIds: oldBuildId !== newBuildId,
        sameProtocol: true,
        sameDshRuntime: true,
      }
    return fragment
  } catch (error) {
    const failureHandles = [...hosts, ...clients]
    if (detachedHost !== undefined) {
      failureHandles.push({
        role: 'host-u07',
        pid: detachedHost.pid,
        get exited() { return !alive(detachedHost.pid) },
        get records() { return readHostLogRecords(detachedHost.scopeDir, detachedHost.pid) },
      })
    }
    captureFailure(failureHandles)
    throw error
  } finally {
    for (const client of clients) {
      try { await client.dispose?.() } catch { /* best effort */ }
    }
    for (const host of hosts) {
      await stopHostForCleanup(host).catch(() => undefined)
      killProcessGroup(host)
    }
    // Second local ownership step: the Client-spawned Host was recorded with
    // its real PID/starttime; Runner /proc cleanup remains the last backstop.
    await stopRecordedHostForCleanup(detachedHost).catch(() => undefined)
  }
}
