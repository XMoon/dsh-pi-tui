/**
 * `client-reload.target-source-isolation`: the manual command and the
 * qualification signal share ONE live Client process but resolve DIFFERENT
 * target sources.
 *
 * The profile is the running old build; the side-by-side new build exists only
 * as the qualification override. The real PTY `/reload-client` command must
 * resolve the profile and refuse as already-current, while a real SIGUSR2 in
 * the same business PID must use the override and restore the same Host and
 * Session through a new OS PID running the new build.
 *
 * @module smoke/split-upgrade/reload-source-isolation
 */

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { installPlugin, isolatedEnvironment } from '../../lib/dsh-smoke-harness.mjs'
import { hostSessionEvents, waitForHostSessionEvent } from '../../lib/split-smoke-sessions.mjs'
import { writeC1WorkFixture } from '../../lib/split-smoke-fixtures.mjs'
import {
  EXPECTED_PACKAGE_NAME,
  assert,
  assertEqual,
  assertIdentityKept,
  assertNotEqual,
  assertProfileClientPeers,
  alive,
  c1WorkHadRelease,
  hostStatus,
  installSideBuild,
  killProcessGroup,
  productionBuildId,
  readJson,
  readProcessStarttime,
  safeIdentity,
  scopeDirOf,
  stopHostForCleanup,
  waitForAcceptedHandoff,
  waitForReloadNotice,
  waitForUpgradeC1WorkEvent,
  waitGone,
} from '../../lib/split-upgrade-support.mjs'

/**
 * Run the U09 source-isolation scene with its own local Host/Client ownership
 * boundary. `failpoint` fires after this case's first real Host is Ready.
 */
export async function runReloadSourceIsolation(context) {
  const hosts = []
  const clients = []
  // Every context field MUST reach the round function: the extracted round
  // creates real `EntryProcess`/`SurfaceEntryProcess` instances, so a narrower
  // ad-hoc scope would turn them into free variables at run time.
  const scope = { ...context, hosts, clients }
  try {
    const userCommandReloadSourceIsolation = await runReloadSourceIsolationRound(scope)
    return { userCommandReloadSourceIsolation }
  } catch (error) {
    context.captureFailure([...hosts, ...clients])
    throw error
  } finally {
    for (const client of clients) {
      try { await client.dispose?.() } catch { /* best effort */ }
    }
    for (const host of hosts) {
      await stopHostForCleanup(host).catch(() => undefined)
      killProcessGroup(host)
    }
  }
}

async function runReloadSourceIsolationRound(context) {
  const {
    EntryProcess, SurfaceEntryProcess,
    dsh, harnessDir, anchor, targetDshVersion, oldArtifact, newArtifact, workRoot,
    checkpoint, failpoint, registerIsolatedHome, hosts, clients,
  } = context
  const roundRoot = join(workRoot, 'u09')
  const home = join(roundRoot, 'home')
  const dshHome = join(roundRoot, 'dsh-home')
  const envWork = join(roundRoot, 'env')
  const fixtureDir = join(roundRoot, 'fixture')
  const c1WorkRoot = join(roundRoot, 'c1-work')
  const scratch = join(roundRoot, 'scratch')
  registerIsolatedHome(dshHome)
  for (const directory of [home, dshHome, envWork, fixtureDir, c1WorkRoot, scratch]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  writeFileSync(join(envWork, 'npmrc'), 'registry=https://registry.npmjs.org\n', 'utf8')
  const env = isolatedEnvironment(envWork, home, dshHome, join(roundRoot, 'evidence.json'))

  // Profile = the OLD installed build (the running build). The side-by-side
  // NEW build is the qualification-only override target.
  const profileDir = join(dshHome, 'profiles', 'pi-tui')
  installPlugin(dsh, `@deepseek-ai/dsh-client-store@${targetDshVersion}`, harnessDir, env, false)
  installPlugin(dsh, 'zustand@4.5.7', harnessDir, env, false)
  installPlugin(dsh, 'immer@10.2.0', harnessDir, env, false)
  installPlugin(dsh, oldArtifact.path, harnessDir, env, false)
  assertProfileClientPeers(profileDir, targetDshVersion, 'U09 old profile install')
  const profilePackage = realpathSync(join(profileDir, 'node_modules', EXPECTED_PACKAGE_NAME))
  const profileBuildId = productionBuildId(profilePackage, targetDshVersion)
  const sideNewPackage = installSideBuild(join(dshHome, 'profiles', 'u09-side-new'), newArtifact.path, env, targetDshVersion)
  const sideNewBuildId = productionBuildId(sideNewPackage, targetDshVersion)
  assertNotEqual(sideNewBuildId, profileBuildId, 'U09 the side-by-side target equals the running profile build')

  const work = writeC1WorkFixture(profileDir, fixtureDir)
  const releaseBarrier = join(roundRoot, 'long-turn.release')
  const base = { cwd: profileDir, env: { ...env }, anchor, profile: 'pi-tui', scratch }
  const hostBase = {
    ...base,
    env: {
      ...base.env,
      SPLIT_PROCESS_EXTRA_PATCH: work.patchPath,
      C1_SCENARIO: 'long-turn',
      C1_HOLD_LONG_TURN: releaseBarrier,
      C1_WORK_ROOT: c1WorkRoot,
    },
  }
  const host = new EntryProcess('host-u09', join(profilePackage, 'dist', 'local-host.mjs'), hostBase)
  hosts.push(host)
  const hostReady = await host.waitFor(record => record.m4a0 === 'ready', 'U09 Host ready', 240_000)
  const hostIdentity = safeIdentity(hostReady.localHost)
  failpoint('client-reload.target-source-isolation.after-host-spawn')
  assertEqual(hostIdentity.buildId, profileBuildId, 'U09 Host did not publish the profile buildId')
  const scopeDir = scopeDirOf(dshHome, hostIdentity.scopeId)
  const registryBefore = readFileSync(join(scopeDir, 'instance.json'))
  const launchBefore = readFileSync(join(scopeDir, 'launch.json'))

  // The ONE qualification process: BOTH the SIGUSR2 probe and the manual
  // command are reachable here.
  const client = new SurfaceEntryProcess(join(profilePackage, 'dist', 'local-client.mjs'), {
    ...base,
    workDir: roundRoot,
    env: {
      ...base.env,
      SPLIT_PROCESS_CLIENT_REEXEC_PROBE: '1',
      SPLIT_PROCESS_CLIENT_REEXEC_TARGET_PACKAGE_ROOT: sideNewPackage,
    },
  })
  clients.push(client)
  await client.waitFor(record => record.m4a0 === 'ready', 'U09 Client ready', 240_000)
  const clientPid = client.records.find(record => record.m4a0 === 'ready')?.pid
  assert(Number.isInteger(clientPid), 'U09 Client ready record has no business PID')
  const holdPrompt = 'u09-source-isolation-hold'
  client.send(`${holdPrompt}\r`)
  await client.waitForScreen(holdPrompt, 'U09 Client painted the admitted prompt', 120_000)
  const sessionStatus = await client.waitFor(
    record => record.m4b2s === 'surface-status' && record.sessionOpen === true && typeof record.openSessionId === 'string',
    'U09 Client open Session',
    120_000,
  )
  const sessionId = sessionStatus.openSessionId
  await waitForUpgradeC1WorkEvent(c1WorkRoot, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'U09 Host Turn held')

  checkpoint('U09/manual-already-current')
  // The MANUAL command runs in the qualification environment and must still
  // resolve the PROFILE: the profile IS the running build, so this is the
  // already-current refusal. The qualification override would have been a
  // different (valid) build — a MANUAL stop here would prove the leak.
  const manualReloadFrom = client.records.length
  client.send('/reload-client\r')
  await waitForReloadNotice(client, 'Client reload skipped: this Client already runs the installed build.',
    'U09 manual already-current notice', manualReloadFrom)
  assertEqual(client.records.filter(record => record.m4r === 'handoff-requested').length, 0,
    'U09 the manual command used the qualification target override')
  assert(alive(clientPid), 'U09 the manual already-current refusal killed the Client')
  assertIdentityKept(safeIdentity((await hostStatus(host)).localHost), hostIdentity, 'U09 Host after the manual refusal')
  assert(!c1WorkHadRelease(c1WorkRoot), 'U09 the manual refusal released the admitted Turn')
  assert(readFileSync(join(scopeDir, 'instance.json')).equals(registryBefore),
    'U09 the manual refusal mutated the registry')
  assert(readFileSync(join(scopeDir, 'launch.json')).equals(launchBefore),
    'U09 the manual refusal mutated the launch material')

  checkpoint('U09/qualification-reexec')
  // In the SAME process, the qualification entry may use the override. This
  // proves both entries coexist on ONE latch and only the target resolution
  // differs.
  const qualificationFrom = client.records.length
  client.signalBusiness('SIGUSR2')
  const qualificationRequested = await waitForAcceptedHandoff(
    client, clientPid, 'U09 qualification accepted the reexec request', qualificationFrom,
  )
  assertEqual(qualificationRequested.source, 'qualification',
    'the qualification request did not name its source')
  assertEqual(qualificationRequested.targetBuildId, sideNewBuildId,
    'the qualification request did not use the side-by-side override')
  assertEqual(qualificationRequested.targetBundleVersion, newArtifact.manifest.version,
    'the qualification request resolved another target bundle version')
  const clientClosed = await client.waitFor(
    record => record.m4b2s === 'client-closed' && record.pid === clientPid,
    'U09 the qualification Client released every owned Client resource',
    120_000,
  )
  assertEqual(clientClosed.surfaceMounted, false, 'U09 the qualification Client still reported a mounted surface')
  const replacementStarted = await client.waitFor(
    record => record.m4a0 === 'client-started' && record.pid !== clientPid,
    'U09 the qualification replacement started as a new OS process',
    120_000,
  )
  const replacementPid = replacementStarted.pid
  assert(Number.isInteger(replacementPid) && replacementPid !== clientPid, 'U09 the replacement has no new OS PID')
  const replacementAuth = await client.waitFor(
    record => record.m4a0 === 'host-authenticated' && record.pid === replacementPid,
    'U09 the replacement authenticated the SAME Host',
    180_000,
  )
  assertIdentityKept(replacementAuth.host, hostIdentity, 'U09 replacement authenticated Host')
  const replacementRestored = await client.waitFor(
    record => record.m4r === 'handoff-restored' && record.pid === replacementPid,
    'U09 the replacement restored the original Session',
    180_000,
  )
  assertEqual(replacementRestored.clientBuildId, sideNewBuildId,
    'U09 the qualification replacement did not run the override build')
  assertEqual(replacementRestored.sessionId, sessionId)
  assertEqual(replacementRestored.surfaceMounted, true)
  await client.waitForScreen(holdPrompt, 'U09 the replacement painted the admitted prompt', 120_000)
  assertIdentityKept(safeIdentity((await hostStatus(host)).localHost), hostIdentity, 'U09 Host after the qualification handoff')
  assert(!c1WorkHadRelease(c1WorkRoot), 'U09 the qualification handoff released the admitted Turn')
  assert(readFileSync(join(scopeDir, 'instance.json')).equals(registryBefore),
    'U09 the qualification handoff mutated the registry')
  assert(readFileSync(join(scopeDir, 'launch.json')).equals(launchBefore),
    'U09 the qualification handoff mutated the launch material')

  const replacementExit = await (async () => {
    client.send('/exit\r')
    return await client.waitForExit(120_000)
  })()
  assertEqual(replacementExit.code, 0, `U09 replacement exit was ${JSON.stringify(replacementExit)}`)
  assert(await waitGone(replacementPid), 'U09 the replacement process did not exit')
  assert(await waitGone(clientPid), 'U09 the old qualification parent did not exit')

  // Complete the held turn and stop the Host through its own owner path.
  writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
  await waitForUpgradeC1WorkEvent(c1WorkRoot, event => event.kind === 'long-turn-released' && event.sessionId === sessionId, 'U09 Host Turn completes')
  await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'U09 Host turn/end')
  host.child.stdin.end()
  assert(readProcessStarttime(hostIdentity.hostPid) === hostIdentity.hostStarttime,
    'U09 the Host stop target starttime no longer matches')
  process.kill(hostIdentity.hostPid, 'SIGTERM')
  await host.waitFor(record => record.m4a0 === 'stop-requested', 'U09 Host stop-requested', 60_000)
  const hostCleanup = await host.waitFor(
    record => record.m4a0 === 'cleanup' || record.m4a0 === 'cleanup-failure',
    'U09 Host cleanup',
    120_000,
  )
  assertEqual(hostCleanup.m4a0, 'cleanup', `U09 Host cleanup was ${JSON.stringify(hostCleanup)}`)
  const hostExit = await host.waitForExit(120_000)
  assertEqual(hostExit.code, 0, `U09 Host stop exit was ${JSON.stringify(hostExit)}`)

  return {
    sameProcessBothEntries: true,
    manualResolvedProfileOnly: true,
    manualRefusedAsAlreadyCurrent: true,
    manualKeptOldSurface: true,
    manualNeverReachedProcessStop: true,
    qualificationUsedOverride: true,
    qualificationSourceTelemetry: true,
    qualificationTargetBuildId: sideNewBuildId,
    profileBuildId,
    qualificationNewPid: true,
    qualificationRestoredSameHostSession: true,
    hostIdentityKept: true,
    registryBytesUnchanged: true,
    launchBytesUnchanged: true,
    turnHeldAcrossBothRequests: true,
    replacementExitCode: replacementExit.code,
    hostStopExitCode: hostExit.code,
  }
}
