/**
 * U2 PR-B: the ONE old→new packed cross-build Upgrade Scene.
 *
 * One real business `test()` keeps the eight independent failure classes of the
 * historical `upgrade.cross-build-compatibility` case: a live old Host and
 * durable Session across a replacement-only reexec, a pre-authentication
 * wrong-instance refusal, a replacement-child bootstrap failure, the new build's
 * official/private RPC proof, the new build's real PTY surface, an
 * owner-governed old-Host stop with a post-stop profile upgrade, a cold new Host
 * generation with durable readback, and old-credential rejection on the new
 * Host.
 *
 * The Scene (created by `createUpgradeScene`) and its Supervisor own every
 * profile install, Host generation and one-shot qualification Client. This
 * worker owns only the real tui-test Clients. No launch URL, token, Cookie,
 * official record dump or private path ever enters an assertion message.
 *
 * @module test/integration/split-upgrade/cross-build-compatibility.vitest
 */

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { test } from 'vitest'

import { createUpgradeScene, type UpgradeScene } from '../../support/split-upgrade-fixture.ts'
import {
  assertHostArtifactsKept,
  assertReexecRecordOrder,
  c1WorkHadRelease,
  hostArtifacts,
  hostSessionEvents,
  recordIndex,
  sessionLogFiles,
  turnEndCount,
  userPromptCount,
  waitForAcceptedHandoff,
  waitForC1Event,
  waitForClientClosed,
  waitForHostSessionEventAfter,
  waitForPaintedText,
  waitForPidGone,
  waitForReplacement,
  waitForSurfaceConnected,
  waitForSurfaceSession,
} from './reload-observation.ts'

interface SplitUpgradeSupportModule {
  installedPayloadHash(packageRoot: string): string
  productionBuildId(packageRoot: string, dshVersion: string): string
}

const TEST_DIR = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = realpathSync(join(TEST_DIR, '..', '..', '..'))
// U1 owns this dynamic-import pattern: this file declares only the two function
// shapes it reads and never copies the payload-hash/build-identity algorithm.
const support = (await import(
  pathToFileURL(join(REPO_ROOT, 'scripts', 'lib', 'split-upgrade-support.mjs')).href
)) as SplitUpgradeSupportModule

const ZERO_OWNERS = { typert: 0, connection: 0, remote: 0, fileUpload: 0, sessions: 0, jobs: 0 }
const HOLD_PROMPT = 'u2-cross-hold'
const COMPLETED_ANSWER = 'long-turn answer 1'
const HOST_HANDOFF_FAILURE = 'Client handoff failed'

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw error
  }
}

function processGroupAlive(pgid: number | undefined): boolean {
  if (pgid === undefined || !Number.isInteger(pgid) || pgid <= 0) return false
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw error
  }
}

function requirePgid(pgid: number | undefined, label: string): number {
  assert.ok(Number.isInteger(pgid) && (pgid as number) > 0, `${label}: the Host has no real process group id`)
  return pgid as number
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function assertEntryInside(packageRoot: string, entry: string, label: string): void {
  const rel = relative(packageRoot, entry)
  assert.ok(rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`),
    `${label}: the Client entry is not inside the installed package`)
}

function assertNoSecret(label: string, haystack: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    assert.ok(!haystack.includes(secret), `${label}: a Host launch secret reached public output`)
  }
}

function assertHostIdentity(identity: Record<string, any>, dshVersion: string): void {
  assert.ok(typeof identity.scopeId === 'string' && identity.scopeId !== '', 'the Host identity has no scope id')
  assert.ok(typeof identity.instanceId === 'string' && identity.instanceId !== '', 'the Host identity has no instance id')
  assert.ok(Number.isInteger(identity.hostPid) && identity.hostPid > 0, 'the Host identity has no real PID')
  assert.equal(identity.dshVersion, dshVersion, 'the Host does not run the pinned DSH runtime')
  assert.ok(typeof identity.protocol === 'string' && identity.protocol !== '', 'the Host identity has no local protocol')
  if (process.platform === 'darwin') {
    assert.equal(identity.schema, 2, 'the Darwin Host identity is not kernel-versioned')
    assert.ok(identity.hostKernelIdentity !== null && typeof identity.hostKernelIdentity === 'object',
      'the Darwin Host identity carries no kernel process identity')
    assert.equal(Number(identity.hostKernelIdentity.pid), identity.hostPid,
      'the Darwin kernel identity names another PID')
  } else {
    assert.ok(identity.hostStarttime !== undefined && identity.hostStarttime !== null,
      'the Linux Host identity carries no starttime')
  }
}

function startIdentityToken(identity: Record<string, any>): string {
  const kernel = identity.hostKernelIdentity
  return kernel !== undefined && kernel !== null
    ? `${String(kernel.bootUUID)}:${String(kernel.processUUID)}:${String(kernel.uniqueId)}`
    : String(identity.hostStarttime)
}

function parseLaunchConnect(launchBytes: Buffer): { origin: string; token: string; connectUrl: URL } {
  const launch = JSON.parse(launchBytes.toString('utf8')) as Record<string, unknown>
  const rawConnectUrl = launch.connectUrl
  if (typeof rawConnectUrl !== 'string' || rawConnectUrl === '') {
    throw new Error('the Host launch material carries no connect URL')
  }
  const connectUrl = new URL(rawConnectUrl)
  const token = connectUrl.searchParams.get('token')
  if (token === null || token === '') throw new Error('the Host launch material carries no connect token')
  return { origin: connectUrl.origin, token, connectUrl }
}

async function requestLocal(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; setCookie: string[] }> {
  // A variable (not a fresh literal) keeps the plan's `cache: 'no-store'`
  // without depending on the local `RequestInit` typings exposing it.
  const requestInit = { redirect: 'manual' as const, cache: 'no-store' as const, ...init }
  const response = await fetch(url, requestInit)
  const status = response.status
  const cookieHeader = response.headers.get('set-cookie')
  const getSetCookie = (response.headers as { getSetCookie?: () => string[] }).getSetCookie
  const setCookie = typeof getSetCookie === 'function'
    ? getSetCookie.call(response.headers)
    : cookieHeader === null ? [] : [cookieHeader]
  await response.text()
  return { status, setCookie }
}

async function runScene(run: (scene: UpgradeScene) => Promise<void>): Promise<void> {
  let scene: UpgradeScene | undefined
  let primary: unknown
  try {
    scene = await createUpgradeScene()
    await run(scene)
  } catch (error) {
    primary = error
  } finally {
    if (scene !== undefined) {
      try {
        await scene.dispose()
      } catch (cleanupError) {
        if (primary !== undefined) {
          throw new AggregateError([primary, cleanupError], 'cross-build-compatibility failed and its Scene cleanup also failed')
        }
        throw cleanupError
      }
    }
  }
  if (primary !== undefined) throw primary
}

test('different packaged Client builds preserve one live Host and durable Session through reexec, refusals and a cold Host generation', async () => {
  await runScene(async scene => {
    // ── S1: old Host A, one admitted old Client and one held durable Turn ─────
    assert.equal(sha256File(scene.pair.old.path), scene.pair.old.sha256,
      'the frozen old tarball changed before the Scene started')
    assert.equal(sha256File(scene.pair.new.path), scene.pair.new.sha256,
      'the frozen new tarball changed before the Scene started')

    const oldProfile = await scene.installOldProfile()
    assert.equal(oldProfile.version, scene.pair.old.version,
      'the old Profile version does not match the frozen pair')
    assert.equal(support.installedPayloadHash(oldProfile.packageRoot), oldProfile.payloadHash,
      'the old Profile payload differs from the Supervisor install facts')
    assert.equal(support.productionBuildId(oldProfile.packageRoot, scene.pair.targetDshVersion), oldProfile.buildId,
      'the old Profile build identity differs from the Supervisor install facts')

    const hostA = await scene.startHost({ source: 'profile', scenario: 'long-turn' })
    assert.equal(hostA.generation, 1, 'the old Host is not generation 1')
    assert.equal(hostA.buildId, oldProfile.buildId, 'the old Host does not run the old Profile build')
    const beforeA = await hostArtifacts(scene, hostA)
    const identityA = beforeA.identity
    assertHostIdentity(identityA, scene.pair.targetDshVersion)
    assert.equal(identityA.hostPid, hostA.ready.pid, 'the Host identity does not name the started process')
    assert.equal(identityA.buildId, oldProfile.buildId, 'the Host identity does not name the old build')
    assert.equal(identityA.bundleVersion, oldProfile.version, 'the Host identity does not name the old bundle')
    const hostAPgid = requirePgid(hostA.pgid, 'Host A')
    assert.ok(pidAlive(identityA.hostPid) && processGroupAlive(hostAPgid), 'Host A is not alive as a real OS group')

    const clientA = await scene.startClient({
      source: 'profile',
      label: 'cross-old-a',
      plannedSideNewReexecTarget: true,
    })
    const aPid = (await clientA.businessPid())!
    assert.ok(Number.isInteger(aPid) && aPid > 0, 'the old Client has no real business PID')
    await clientA.submit(HOLD_PROMPT)
    await waitForPaintedText(clientA, HOLD_PROMPT, 'the old Client painted its admitted prompt')
    const sessionId = (await waitForSurfaceSession(clientA, 'the old Client opened the Session')).openSessionId
    const held = await waitForC1Event(
      hostA.workRoot,
      event => event.kind === 'long-turn-held' && event.sessionId === sessionId,
      'the old Host held the Turn',
    )
    assert.equal(held.agentStatus, 'running', 'the held Host Turn is not running')
    assert.equal(userPromptCount(scene, sessionId, HOLD_PROMPT), 1, 'the admitted prompt was duplicated')
    assert.equal(turnEndCount(scene, sessionId), 0, 'the held Turn settled before the cross-build install')
    assert.equal(c1WorkHadRelease(hostA.workRoot), false, 'the held Turn was released before the cross-build install')
    const sessionLogsAtStart = sessionLogFiles(scene)
    assert.ok(sessionLogsAtStart.length > 0, 'the held Session has no durable Session log')

    // ── S2: the new packed build arrives while Host A keeps working ───────────
    const sideNew = await scene.installNewSideBySide()
    assert.equal(sideNew.version, scene.pair.new.version, 'the side-new install does not carry the new version')
    assert.notEqual(sideNew.buildId, oldProfile.buildId, 'the two packaged builds produced the same build identity')
    assert.ok(realpathSync(join(scene.workRoot, 'side-new', 'node_modules', '@xmoon76', 'dsh-pi-tui'))
      === sideNew.packageRoot, 'the side-new install does not resolve to the Supervisor-owned package root')
    assert.ok(realpathSync(join(scene.installation.profileDir, 'node_modules', '@xmoon76', 'dsh-pi-tui'))
      === oldProfile.packageRoot, 'the side-by-side install replaced the running old Profile payload')
    assert.ok(realpathSync(scene.installation.entries.client) === oldProfile.entries.client,
      'the active Profile still resolves another Client entry')
    assert.equal(support.installedPayloadHash(oldProfile.packageRoot), oldProfile.payloadHash,
      'the side-by-side install changed the old Profile payload bytes')
    assert.equal(support.productionBuildId(oldProfile.packageRoot, scene.pair.targetDshVersion), oldProfile.buildId,
      'the side-by-side install changed the old Profile build identity')
    assertEntryInside(sideNew.packageRoot, sideNew.entries.client, 'side-new')
    await assertHostArtifactsKept(scene, hostA, beforeA, 'side-by-side new install')
    assert.ok(pidAlive(identityA.hostPid), 'Host A died on the side-by-side install')
    assert.ok(processGroupAlive(hostAPgid), 'Host A process group disappeared on the side-by-side install')
    assert.equal(turnEndCount(scene, sessionId), 0, 'the side-by-side install released the held Turn')
    assert.equal(userPromptCount(scene, sessionId, HOLD_PROMPT), 1, 'the side-by-side install replayed the prompt')

    // ── S3: the old Host credential is a real positive control ────────────────
    const oldLaunch = parseLaunchConnect(beforeA.launchBytes)
    const oldConnectUrl = new URL(oldLaunch.connectUrl.href)
    oldConnectUrl.searchParams.set('interactions', 'answer')
    const oldConnect = await requestLocal(oldConnectUrl.href)
    assert.equal(oldConnect.status, 302, 'the old Host did not accept its own launch token')
    assert.ok(oldConnect.setCookie.length > 0, 'the old Host returned no Cookie for its launch token')
    const oldCookie = oldConnect.setCookie[0]!.split(';')[0]!
    if (!oldCookie.includes('=')) throw new Error('the old Host returned an unusable Cookie')
    const oldCookieIdentity = await requestLocal(`${oldLaunch.origin}/api/pi-tui.local-host`, {
      headers: { cookie: oldCookie },
    })
    assert.equal(oldCookieIdentity.status, 200, 'the old Host did not accept its own minted Cookie')

    // ── S4: one live old Client reexecutes onto the SAME Host A and Session ───
    const sessionLogsBeforeReexec = sessionLogFiles(scene)
    const boundary = recordIndex(clientA)
    const signalPid = await scene.signalClientForQualification(clientA)
    assert.equal(signalPid, aPid, 'the qualification signal did not address the live old Client PID')
    const requested = await waitForAcceptedHandoff(clientA, aPid, 'qualification reexec', boundary)
    assert.equal(requested.source, 'qualification', 'the SIGUSR2 request did not name the qualification source')
    assert.equal(requested.targetBuildId, sideNew.buildId, 'the qualification request resolved another target build')
    assert.equal(requested.targetBundleVersion, sideNew.version, 'the qualification request resolved another bundle version')
    assert.equal(requested.sessionId, sessionId, 'the qualification request captured another Session')
    assert.equal(requested.expectedHostInstanceId, identityA.instanceId, 'the qualification request captured another Host')

    const closed = await waitForClientClosed(clientA, aPid, 'the old Client released its resources')
    assert.deepEqual(closed.owners, ZERO_OWNERS, 'the old Client did not release every owned resource')
    assert.equal(closed.sessionOpen, false, 'the old Client still reported its old Session open')
    assert.equal(closed.surfaceMounted, false, 'the old Client still reported its old surface mounted')

    const replacement = await waitForReplacement(clientA, aPid, 'qualification replacement')
    assert.equal(assertReexecRecordOrder(clientA, aPid, boundary, 'qualification ordered reexec'), replacement.pid,
      'the ordered record ledger names another replacement PID')
    assert.notEqual(replacement.pid, aPid, 'the replacement reused the old business PID')
    assert.equal(replacement.hostAuthenticated.host?.instanceId, identityA.instanceId,
      'the replacement authenticated another Host instance')
    assert.equal(replacement.hostAuthenticated.host?.buildId, oldProfile.buildId,
      'the replacement authenticated another Host build')
    assert.equal(replacement.restored.sessionId, sessionId, 'the replacement restored another Session')
    assert.equal(replacement.restored.sessionOpen, true, 'the replacement did not open the original Session')
    assert.equal(replacement.restored.sessionHistoryOpen, true, 'the replacement did not restore the Session history')
    assert.equal(replacement.restored.surfaceMounted, true, 'the replacement did not mount its surface')
    assert.equal(replacement.restored.transport, 'connected', 'the replacement transport is not connected')
    assert.equal(replacement.restored.clientBuildId, sideNew.buildId, 'the replacement did not run the new build')
    assert.equal(replacement.ready.openSessionId, sessionId, 'the replacement ready record names another Session')
    await waitForPaintedText(clientA, HOLD_PROMPT, 'the replacement painted the original prompt')
    assert.ok(pidAlive(replacement.pid), 'the replacement Client is not a live OS process')
    assert.ok(pidAlive(aPid), 'the old Client parent exited before its replacement finished')
    await assertHostArtifactsKept(scene, hostA, beforeA, 'reexec handoff')
    assert.equal(c1WorkHadRelease(hostA.workRoot), false, 'the reexec handoff released the held Turn')
    assert.deepEqual(sessionLogFiles(scene), sessionLogsBeforeReexec, 'the reexec handoff created another Session log')
    assert.equal(userPromptCount(scene, sessionId, HOLD_PROMPT), 1, 'the reexec handoff replayed the admitted prompt')
    assertNoSecret('reexec records', JSON.stringify(clientA.readRecords()), [oldLaunch.token, oldCookie])
    assertNoSecret('reexec frame', await clientA.text(true), [oldLaunch.token, oldCookie])

    // ── S5: the one real terminal exits the parent and the replacement ───────
    const replacementPid = replacement.pid
    await clientA.close()
    assert.equal(clientA.closed, true, 'the reexec Client did not close its native PTY session')
    await waitForPidGone(aPid, 'the old Client parent')
    await waitForPidGone(replacementPid, 'the replacement Client')
    await scene.refreshClientBusinessPids(clientA)
    await assertHostArtifactsKept(scene, hostA, beforeA, 'reexec Client exit')
    assert.equal(c1WorkHadRelease(hostA.workRoot), false, 'the reexec Client exit released the held Turn')
    assert.equal(turnEndCount(scene, sessionId), 0, 'the reexec Client exit settled the held Turn')

    // ── S6: a wrong expected Host instance is refused before authentication ──
    const wrongInstanceId = randomUUID()
    assert.notEqual(wrongInstanceId, identityA.instanceId,
      'the random wrong-instance expectation equals the live Host instance')
    const wrong = await scene.startClient({
      source: 'side-new',
      label: 'cross-wrong-host',
      sessionId,
      expectedHostInstanceId: wrongInstanceId,
      startupExpectation: 'expected-failure',
    })
    const wrongPid = (await wrong.businessPid())!
    assert.ok(Number.isInteger(wrongPid) && wrongPid > 0, 'the wrong-instance Client has no real business PID')
    assert.deepEqual(await wrong.waitForExit(), { code: 1, signal: null },
      'the wrong-instance Client did not fail as a real nonzero shell exit')
    const wrongRecords = wrong.readRecords()
    const wrongFailure = wrongRecords.find(record => record.m4a0 === 'failure' && record.pid === wrongPid)
    assert.ok(wrongFailure !== undefined, 'the wrong-instance Client reported no official failure record')
    assert.equal(wrongFailure.code, 'HOST_IDENTITY_MISMATCH',
      'the wrong-instance Client failed with another official failure code')
    assert.ok(!wrongRecords.some(record => record.pid === wrongPid
      && (record.m4a0 === 'ready' || record.m4a0 === 'host-authenticated')),
    'the wrong-instance Client published ready or authenticated the live Host')
    const wrongFrame = await wrong.text(true)
    const wrongFailureLines = wrongFrame.split('\n').filter(line => line.includes(HOST_HANDOFF_FAILURE))
    assert.equal(wrongFailureLines.length, 1,
      'the wrong-instance refusal did not paint exactly one handoff failure line')
    const wrongCompact = wrongFrame.replace(/\s+/gu, '')
    assert.ok(wrongCompact.includes('Clienthandofffailed:thelivelocalHostisnottheexpectedinstance.'),
      'the wrong-instance refusal did not name the product Host-identity reason')
    assert.ok(wrongCompact.includes('TheHostwasnotstoppedorreplaced.'),
      'the wrong-instance refusal did not state that the Host was kept')
    assert.ok(wrongCompact.includes('StartacompatibleClientmanuallytocontinue.'),
      'the wrong-instance refusal did not carry the product recovery line')
    assertNoSecret('wrong-instance frame', wrongFrame, [oldLaunch.token, oldCookie])
    for (const privateValue of [beforeA.scopeDir, sideNew.packageRoot, scene.workRoot, String(identityA.hostPid)]) {
      assert.ok(!wrongCompact.includes(privateValue.replace(/\s+/gu, '')),
        'the wrong-instance refusal leaked a private path or the Host PID')
    }
    await wrong.closeExpectedFailure(1)
    await waitForPidGone(wrongPid, 'the wrong-instance Client')
    await assertHostArtifactsKept(scene, hostA, beforeA, 'wrong-instance refusal')
    assert.equal(c1WorkHadRelease(hostA.workRoot), false, 'the wrong-instance refusal released the held Turn')
    assert.deepEqual(sessionLogFiles(scene), sessionLogsAtStart, 'the wrong-instance refusal created another Session log')
    assert.equal(userPromptCount(scene, sessionId, HOLD_PROMPT), 1, 'the wrong-instance refusal replayed the prompt')

    // ── S7: the replacement child fails after a REAL reexec of the old PID ───
    const fault = await scene.startClient({
      source: 'profile',
      label: 'cross-old-fault',
      sessionId,
      reexecTargetPackageRoot: sideNew.packageRoot,
      reexecChildFailure: 'client-bootstrap',
    })
    const faultPid = (await fault.businessPid())!
    assert.ok(Number.isInteger(faultPid) && faultPid > 0, 'the child-fault Client has no real business PID')
    const faultSurface = await waitForSurfaceSession(fault, 'the child-fault Client opened the running Session')
    assert.equal(faultSurface.openSessionId, sessionId, 'the child-fault Client opened another Session')
    const faultBoundary = recordIndex(fault)
    const faultSignalPid = await scene.signalClientForQualification(fault)
    assert.equal(faultSignalPid, faultPid, 'the child fault was requested from another Client PID')
    assert.deepEqual(await fault.waitForExit(), { code: 1, signal: null },
      'the failed replacement did not end the real terminal with exit code 1')
    const faultRecords = fault.readRecords()
    const faultRequested = faultRecords.slice(faultBoundary)
      .find(record => record.m4r === 'handoff-requested' && record.pid === faultPid)
    assert.ok(faultRequested !== undefined, 'the child-fault Client did not accept its own reexec request')
    assert.equal(faultRequested.sessionId, sessionId, 'the child-fault request captured another Session')
    assert.equal(faultRequested.targetBuildId, sideNew.buildId, 'the child-fault request resolved another target build')
    const faultClosed = faultRecords.find(record => record.m4b2s === 'client-closed' && record.pid === faultPid)
    assert.ok(faultClosed !== undefined, 'the child-fault Client never released its owners')
    assert.deepEqual(faultClosed.owners, ZERO_OWNERS, 'the child-fault Client did not release every owned resource')
    assert.equal(faultClosed.sessionOpen, false, 'the child-fault Client still reported its old Session open')
    assert.equal(faultClosed.surfaceMounted, false, 'the child-fault Client still reported its old surface mounted')
    const childFailure = faultRecords.find(record => record.m4a0 === 'failure' && record.pid !== faultPid)
    assert.ok(childFailure !== undefined, 'the failed replacement published no official failure record')
    assert.match(String(childFailure.error), /qualification forced client bootstrap failure/u,
      'the replacement child failed for another reason than the injected bootstrap fault')
    assert.ok(!faultRecords.some(record => record.m4a0 === 'ready' && record.pid !== faultPid),
      'a failed replacement Client published ready')
    const parentExit = faultRecords.find(record => record.m4r === 'handoff-parent-exit' && record.pid === faultPid)
    assert.ok(parentExit !== undefined, 'the old parent never reported the replacement exit')
    assert.equal(parentExit.code, 1, 'the old parent reported another replacement exit code')
    assert.equal(parentExit.signal, null, 'the old parent reported a signal instead of exit code 1')
    await waitForPidGone(faultPid, 'the child-fault old parent')
    await waitForPidGone(childFailure.pid, 'the failed replacement child')
    const faultFrame = await fault.text(true)
    const faultFailureLines = faultFrame.split('\n').filter(line => line.includes(HOST_HANDOFF_FAILURE))
    assert.equal(faultFailureLines.length, 1, 'the failed replacement did not paint exactly one handoff failure line')
    assert.ok(faultFrame.replace(/\s+/gu, '').includes(
      'Clienthandofffailed:qualificationforcedclientbootstrapfailure.'),
    'the failed replacement did not paint the product bootstrap-failure reason')
    assertNoSecret('child-failure frame', faultFrame, [oldLaunch.token, oldCookie])
    await fault.closeExpectedFailure(1)
    await assertHostArtifactsKept(scene, hostA, beforeA, 'replacement child failure')
    assert.equal(c1WorkHadRelease(hostA.workRoot), false, 'the failed replacement released the held Turn')
    assert.deepEqual(sessionLogFiles(scene), sessionLogsAtStart, 'the failed replacement created another Session log')
    assert.equal(userPromptCount(scene, sessionId, HOLD_PROMPT), 1, 'the failed replacement replayed the prompt')

    // ── S8: the new build proves the official/private RPC path to old Host A ──
    const rpc = await scene.probeSideNewClientHostFoundation(hostA)
    assert.ok(Number.isInteger(rpc.clientPid) && rpc.clientPid > 0,
      'the qualification proof names no real one-shot Client PID')
    assert.equal(rpc.hostPid, identityA.hostPid, 'the qualification proof names another Host PID')
    assert.equal(rpc.hostInstanceId, identityA.instanceId, 'the qualification proof names another Host instance')
    assert.equal(rpc.officialSessionList, true, 'the qualification proof has no official Session list')
    assert.equal(rpc.privateFileRpc, true, 'the qualification proof has no private file RPC')
    assert.equal(rpc.terminalSnapshot, true, 'the qualification proof has no terminal snapshot')
    assert.equal(rpc.cleaned, true, 'the qualification proof did not clean its Client resources')
    assert.equal(rpc.exitCode, 0, 'the qualification Client did not exit normally')
    await waitForPidGone(rpc.clientPid, 'the one-shot qualification Client')
    const hostAStatus = await scene.hostStatus(hostA)
    assert.equal(hostAStatus.liveness?.verdict, 'BLOCKED', 'Host A is not blocked by the admitted Turn')
    await assertHostArtifactsKept(scene, hostA, beforeA, 'qualification RPC proof')
    assert.deepEqual(sessionLogFiles(scene), sessionLogsAtStart, 'the qualification proof created another Session log')
    assert.equal(c1WorkHadRelease(hostA.workRoot), false, 'the qualification proof released the held Turn')
    assert.equal(userPromptCount(scene, sessionId, HOLD_PROMPT), 1, 'the qualification proof replayed the prompt')

    // ── S9: the new build's REAL surface opens the running old Session ───────
    const newSurface = await scene.startClient({
      source: 'side-new',
      label: 'cross-new-surface',
      sessionId,
    })
    const newSurfacePid = (await newSurface.businessPid())!
    assert.ok(Number.isInteger(newSurfacePid) && newSurfacePid > 0, 'the new surface has no real business PID')
    const newSurfaceRecords = newSurface.readRecords()
    const newSurfaceAuth = newSurfaceRecords
      .find(record => record.m4a0 === 'host-authenticated' && record.pid === newSurfacePid)
    assert.ok(newSurfaceAuth !== undefined, 'the new surface authenticated no Host')
    assert.equal(newSurfaceAuth.host?.instanceId, identityA.instanceId, 'the new surface authenticated another Host')
    assert.equal(newSurfaceAuth.host?.buildId, oldProfile.buildId, 'the new surface authenticated another Host build')
    const newSurfaceReady = newSurfaceRecords.find(record => record.m4a0 === 'ready' && record.pid === newSurfacePid)
    assert.ok(newSurfaceReady !== undefined, 'the new surface published no official ready record')
    assert.equal(newSurfaceReady.host?.instanceId, identityA.instanceId, 'the new surface ready record names another Host')
    const connected = await waitForSurfaceConnected(newSurface, 'the new surface connected to the old Host')
    assert.equal(connected.openSessionId, sessionId, 'the new surface opened another Session')
    assert.equal(connected.transport, 'connected', 'the new surface transport is not connected')
    assert.equal(connected.surfaceMounted, true, 'the new surface did not mount')
    await waitForPaintedText(newSurface, HOLD_PROMPT, 'the new surface painted the original prompt')
    assert.equal(userPromptCount(scene, sessionId, HOLD_PROMPT), 1, 'the new surface replayed the prompt')
    assert.equal(turnEndCount(scene, sessionId), 0, 'the new surface released the held Turn')
    const newSurfaceFrame = await newSurface.text(true)
    assertNoSecret('new-surface records', JSON.stringify(newSurfaceRecords), [oldLaunch.token, oldCookie])
    assertNoSecret('new-surface frame', newSurfaceFrame, [oldLaunch.token, oldCookie])
    await newSurface.close()
    await waitForPidGone(newSurfacePid, 'the new surface')
    await scene.refreshClientBusinessPids(newSurface)
    await assertHostArtifactsKept(scene, hostA, beforeA, 'new-surface attach and exit')
    assert.equal(c1WorkHadRelease(hostA.workRoot), false, 'the new-surface exit released the held Turn')
    assert.deepEqual(sessionLogFiles(scene), sessionLogsAtStart, 'the new surface created another Session log')

    // ── S10: settle the Turn, refuse the pre-stop upgrade, then stop Host A ──
    const releaseBoundary = hostSessionEvents(scene, sessionId)?.length ?? 0
    await scene.releaseHeldTurn(hostA)
    await waitForC1Event(
      hostA.workRoot,
      event => event.kind === 'long-turn-released' && event.sessionId === sessionId,
      'Host A released the long Turn',
    )
    await waitForHostSessionEventAfter(scene, sessionId, releaseBoundary,
      event => event.type === 'turn/end', 'Host A settled the held Turn')
    const durableA = hostSessionEvents(scene, sessionId) ?? []
    assert.equal(durableA.filter(event => event.type === 'user/message'
      && event.data?.source?.kind === 'user'
      && JSON.stringify(event.data?.content ?? []).includes(HOLD_PROMPT)).length, 1,
    'the settled Session does not carry the human prompt exactly once')
    assert.ok(durableA.some(event => event.type === 'turn/start'), 'the durable Session lost the Turn start')
    assert.ok(durableA.some(event => event.type === 'turn/end'), 'the durable Session lost the Turn end')
    assert.equal(turnEndCount(scene, sessionId), 1, 'the held Turn settled more than once')
    await assert.rejects(scene.activateNewProfileAfterOldStopped(),
      /UPGRADE_ACTIVATE_NEW_PROFILE_AFTER_STOP: a Host is still active/u,
      'the Supervisor allowed a profile activation while Host A was still live')
    assert.equal(support.installedPayloadHash(oldProfile.packageRoot), oldProfile.payloadHash,
      'the refused pre-stop activation changed the old Profile payload')
    assert.equal(support.productionBuildId(oldProfile.packageRoot, scene.pair.targetDshVersion), oldProfile.buildId,
      'the refused pre-stop activation changed the old Profile build identity')
    assert.ok(realpathSync(join(scene.installation.profileDir, 'node_modules', '@xmoon76', 'dsh-pi-tui'))
      === oldProfile.packageRoot, 'the refused pre-stop activation replaced the old Profile package')
    await assertHostArtifactsKept(scene, hostA, beforeA, 'pre-stop profile activation refusal')
    assert.ok([clientA, wrong, fault, newSurface].every(client => client.closed === true),
      'a Scene Client is still open before the old Host stop')

    const stopA = await scene.stopHost(hostA)
    assert.deepEqual(stopA, { code: 0, signal: null, generation: 1 },
      'the old Host did not stop through the official owner-governed path')
    assert.equal(pidAlive(identityA.hostPid), false, 'the old Host PID is still alive after the official stop')
    assert.equal(processGroupAlive(hostAPgid), false, 'the old Host process group is still visible after the official stop')
    assert.equal(existsSync(join(beforeA.scopeDir, 'instance.json')), false,
      'the old Host left its instance registry behind')
    assert.equal(existsSync(join(beforeA.scopeDir, 'launch.json')), false,
      'the old Host left its launch material behind')
    assert.equal(c1WorkHadRelease(hostA.workRoot), true, 'the old Host stopped before its Turn settled')

    // ── S11: a cold NEW Host generation reads the Session and rejects old keys ─
    const newProfile = await scene.activateNewProfileAfterOldStopped()
    assert.equal(newProfile.version, sideNew.version, 'the activated Profile does not carry the new version')
    assert.equal(newProfile.buildId, sideNew.buildId, 'the activated Profile does not carry the new build identity')
    // `installedPayloadHash` also hashes pnpm install-layout metadata inside the
    // package root (for example `node_modules/.bin/*`), so two real installs of
    // the SAME tarball are not byte-tree-identical. `productionBuildId` is the
    // product's authoritative cross-install build identity (every dist file plus
    // the manifest name/version and the exact DSH pin); recompute it from the
    // activated profile's own disk content instead of trusting the cached fact.
    assert.equal(support.productionBuildId(newProfile.packageRoot, scene.pair.targetDshVersion), sideNew.buildId,
      'the activated Profile disk content does not fingerprint as the installed side-new build')
    assert.ok(realpathSync(join(scene.installation.profileDir, 'node_modules', '@xmoon76', 'dsh-pi-tui'))
      === newProfile.packageRoot, 'the activated Profile does not resolve the new package')
    assert.ok(realpathSync(scene.installation.entries.client) === newProfile.entries.client,
      'the active Profile still resolves another Client entry after activation')
    assertEntryInside(newProfile.packageRoot, newProfile.entries.client, 'activated profile')

    const hostB = await scene.startHost({ source: 'profile', scenario: 'long-turn' })
    assert.equal(hostB.generation, 2, 'the cold new Host is not generation 2')
    assert.equal(hostB.buildId, sideNew.buildId, 'the cold new Host does not run the new build')
    const afterB = await hostArtifacts(scene, hostB)
    const identityB = afterB.identity
    assertHostIdentity(identityB, scene.pair.targetDshVersion)
    assert.equal(identityB.scopeId, identityA.scopeId, 'the cold new Host changed the canonical scope id')
    assert.notEqual(identityB.instanceId, identityA.instanceId, 'the cold new Host reused the old instance id')
    assert.notEqual(identityB.hostPid, identityA.hostPid, 'the cold new Host reused the old PID')
    assert.notEqual(startIdentityToken(identityB), startIdentityToken(identityA),
      'the cold new Host reused the old kernel start identity')
    assert.equal(identityB.buildId, sideNew.buildId, 'the cold new Host identity does not name the new build')
    assert.equal(identityB.protocol, identityA.protocol, 'the cold new Host changed the local protocol')
    const hostBPgid = requirePgid(hostB.pgid, 'Host B')

    const cold = await scene.startClient({ source: 'profile', label: 'cross-cold-new', sessionId })
    const coldPid = (await cold.businessPid())!
    assert.ok(Number.isInteger(coldPid) && coldPid > 0, 'the cold new Client has no real business PID')
    const coldRecords = cold.readRecords()
    const coldAuth = coldRecords.find(record => record.m4a0 === 'host-authenticated' && record.pid === coldPid)
    assert.ok(coldAuth !== undefined, 'the cold new Client authenticated no Host')
    assert.equal(coldAuth.host?.instanceId, identityB.instanceId, 'the cold new Client authenticated the old Host')
    assert.equal(coldAuth.host?.buildId, sideNew.buildId, 'the cold new Client authenticated another Host build')
    const coldReady = coldRecords.find(record => record.m4a0 === 'ready' && record.pid === coldPid)
    assert.ok(coldReady !== undefined, 'the cold new Client published no official ready record')
    assert.equal(coldReady.host?.instanceId, identityB.instanceId, 'the cold new Client ready record names another Host')
    const coldConnected = await waitForSurfaceConnected(cold, 'the cold new Client connected to the new Host')
    assert.equal(coldConnected.openSessionId, sessionId, 'the cold new Client opened another Session')
    await waitForPaintedText(cold, HOLD_PROMPT, 'the cold new Client painted the durable prompt')
    await waitForPaintedText(cold, COMPLETED_ANSWER, 'the cold new Client painted the completed Turn')
    const durableB = hostSessionEvents(scene, sessionId) ?? []
    assert.equal(durableB.filter(event => event.type === 'user/message'
      && event.data?.source?.kind === 'user'
      && JSON.stringify(event.data?.content ?? []).includes(HOLD_PROMPT)).length, 1,
    'the cold new Host readback duplicated the human prompt')
    assert.ok(durableB.some(event => event.type === 'turn/start'), 'the cold new Host lost the Turn start')
    assert.ok(durableB.some(event => event.type === 'turn/end'), 'the cold new Host lost the Turn end')

    const newLaunch = parseLaunchConnect(afterB.launchBytes)
    assert.notEqual(newLaunch.token, oldLaunch.token, 'the cold new Host reused the old launch token')
    const oldTokenOnNew = await requestLocal(
      `${newLaunch.origin}/connect?token=${encodeURIComponent(oldLaunch.token)}&interactions=answer`,
    )
    assert.ok([400, 401, 403].includes(oldTokenOnNew.status),
      `the cold new Host accepted the old token with status ${String(oldTokenOnNew.status)}`)
    const oldCookieOnNew = await requestLocal(`${newLaunch.origin}/api/pi-tui.local-host`, {
      headers: { cookie: oldCookie },
    })
    assert.ok([401, 403].includes(oldCookieOnNew.status),
      `the cold new Host accepted the old Cookie with status ${String(oldCookieOnNew.status)}`)
    const coldFrame = await cold.text(true)
    assertNoSecret('cold-new records', JSON.stringify(coldRecords), [oldLaunch.token, oldCookie])
    assertNoSecret('cold-new frame', coldFrame, [oldLaunch.token, oldCookie])
    assert.equal(turnEndCount(scene, sessionId), 1, 'the cold new Host settled the Turn more than once')

    await cold.close()
    await waitForPidGone(coldPid, 'the cold new Client')
    await scene.refreshClientBusinessPids(cold)
    await assertHostArtifactsKept(scene, hostB, afterB, 'cold new Client exit')
    assert.ok(pidAlive(identityB.hostPid), 'Host B died when the cold Client exited')
    const stopB = await scene.stopHost(hostB)
    assert.deepEqual(stopB, { code: 0, signal: null, generation: 2 },
      'the cold new Host did not stop through the official owner-governed path')
    assert.equal(pidAlive(identityB.hostPid), false, 'the cold new Host PID is still alive after the official stop')
    assert.equal(processGroupAlive(hostBPgid), false, 'the cold new Host process group is still visible after the official stop')
    assert.equal(existsSync(join(afterB.scopeDir, 'instance.json')), false,
      'the cold new Host left its instance registry behind')
    assert.equal(existsSync(join(afterB.scopeDir, 'launch.json')), false,
      'the cold new Host left its launch material behind')

    // ── S12: true quiescence and frozen-input identity ──────────────────────
    for (const [label, client] of [
      ['old Client', clientA],
      ['wrong-instance Client', wrong],
      ['child-fault Client', fault],
      ['new surface', newSurface],
      ['cold new Client', cold],
    ] as const) {
      assert.equal(client.closed, true, `the ${label} did not close its native PTY session`)
    }
    for (const [label, pid] of [
      ['old Client parent', aPid],
      ['replacement Client', replacementPid],
      ['wrong-instance Client', wrongPid],
      ['child-fault parent', faultPid],
      ['failed replacement child', childFailure.pid],
      ['new surface', newSurfacePid],
      ['cold new Client', coldPid],
      ['qualification proof Client', rpc.clientPid],
    ] as const) {
      await waitForPidGone(pid, `U2 ${label}`)
    }
    assert.equal(processGroupAlive(hostAPgid), false, 'the old Host process group is still visible at finish')
    assert.equal(processGroupAlive(hostBPgid), false, 'the cold new Host process group is still visible at finish')
    await scene.refreshClientBusinessPids()
    await scene.finish()
    assert.equal(sha256File(scene.pair.old.path), scene.pair.old.sha256,
      'the frozen old tarball changed during the Scene')
    assert.equal(sha256File(scene.pair.new.path), scene.pair.new.sha256,
      'the frozen new tarball changed during the Scene')
  })
})
