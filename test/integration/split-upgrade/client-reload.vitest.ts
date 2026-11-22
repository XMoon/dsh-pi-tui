import assert from 'node:assert/strict'
import { join } from 'node:path'

import { test } from 'vitest'

import { createUpgradeScene, type UpgradeScene } from '../../support/split-upgrade-fixture.ts'
import {
  RELOAD_NOTICE,
  assertHostArtifactsKept,
  assertNoHandoffRequested,
  assertPeerSurfaceKept,
  beginParallelAudit,
  c1WorkHadRelease,
  hostArtifacts,
  hostSessionEvents,
  latestSurfaceStatus,
  recordIndex,
  sessionLogFiles,
  turnEndCount,
  userPromptCount,
  waitForAcceptedHandoff,
  waitForC1Event,
  waitForClientClosed,
  waitForClearedComposer,
  waitForHostSessionEventAfter,
  waitForPaintedText,
  waitForPidGone,
  waitForReloadNotice,
  waitForReplacement,
  waitForSurfaceSession,
  writeMinimalPng,
  type ParallelAudit,
} from './reload-observation.ts'

const ZERO_OWNERS = { typert: 0, connection: 0, remote: 0, fileUpload: 0, sessions: 0, jobs: 0 }

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
          throw new AggregateError([primary, cleanupError], 'client-reload failed and its Scene cleanup also failed')
        }
        throw cleanupError
      }
    }
  }
  if (primary !== undefined) throw primary
}

test('the production /reload-client command keeps the peer Session and held Turn while replacing only the requested Client', async () => {
  let audit: ParallelAudit | undefined
  try {
    await runScene(async current => {
      const oldProfile = await current.installOldProfile()
      const oldSide = await current.installOldSideBySide()
      assert.equal(oldProfile.version, current.pair.old.version, 'the active profile does not carry the old version')
      assert.notEqual(oldSide.buildId, '', 'the side-old build has no production buildId')

      const host = await current.startHost({ source: 'side-old', scenario: 'long-turn' })
      assert.equal(host.buildId, oldSide.buildId, 'the old Host did not run the side-old build')
      const artifactsBefore = await hostArtifacts(current, host)
      const hostIdentity = artifactsBefore.identity

      const holdPrompt = 'u1-reload-client-hold'
      const clientA = await current.startClient({ source: 'side-old', label: 'reload-a' })
      const aPid = (await clientA.businessPid())!
      assert.ok(Number.isInteger(aPid), 'Client A has no real business PID')
      await clientA.submit(holdPrompt)
      await waitForPaintedText(clientA, holdPrompt, 'Client A painted its admitted prompt')
      const sessionId = (await waitForSurfaceSession(clientA, 'Client A opened the Session')).openSessionId

      const held = await waitForC1Event(
        host.workRoot,
        event => event.kind === 'long-turn-held' && event.sessionId === sessionId,
        'Client A held the long Turn',
      )
      assert.equal(held.agentStatus, 'running', 'the held Host Turn is not running')
      assert.equal(turnEndCount(current, sessionId), 0, 'the held Turn settled before the reload')
      audit = await beginParallelAudit(current, host, clientA, sessionId, 'client-reload')

      // The manually requested build is already the running build.
      let boundary = recordIndex(clientA)
      let baselineFrame = await clientA.text()
      await clientA.submit('/reload-client')
      await waitForReloadNotice(clientA, RELOAD_NOTICE.alreadyCurrent, 'Client A already-current refusal', boundary, { baselineFrame })
      assertNoHandoffRequested(clientA, boundary, 'Client A already-current refusal')
      assert.equal(await clientA.isAlive(), true, 'the already-current refusal killed Client A')
      await assertHostArtifactsKept(current, host, artifactsBefore, 'already-current refusal')
      assert.equal(c1WorkHadRelease(host.workRoot), false, 'the already-current refusal released the held Turn')

      // A staged, unreferenced image must block the same command without a stop.
      const imagePath = join(current.workRoot, 'u1-staged-reload.png')
      writeMinimalPng(imagePath)
      await clientA.submit(`/image ${imagePath}`)
      await waitForPaintedText(clientA, 'attached [image', 'Client A staged the image')
      await clientA.terminal.write('\x7f'.repeat(200))
      await waitForClearedComposer(clientA, '[image #', 'Client A cleared the composer placeholder')
      boundary = recordIndex(clientA)
      baselineFrame = await clientA.text()
      await clientA.submit('/reload-client')
      await waitForReloadNotice(clientA, RELOAD_NOTICE.attachments, 'Client A attachment refusal', boundary, { baselineFrame })
      assertNoHandoffRequested(clientA, boundary, 'Client A attachment refusal')
      assert.equal(await clientA.isAlive(), true, 'the attachment refusal killed Client A')
      await assertHostArtifactsKept(current, host, artifactsBefore, 'attachment refusal')
      assert.equal(c1WorkHadRelease(host.workRoot), false, 'the attachment refusal released the held Turn')

      // End the Client that owned the staged image, then attach two fresh
      // old-build Clients to the SAME Host Session.
      await clientA.close()
      await waitForPidGone(aPid, 'Client A closed')
      assert.equal(turnEndCount(current, sessionId), 0, 'the held Turn settled while Client A closed')

      const clientA2 = await current.startClient({ source: 'side-old', label: 'reload-a2', sessionId })
      const clientB = await current.startClient({ source: 'side-old', label: 'reload-b', sessionId })
      await waitForPaintedText(clientA2, holdPrompt, 'Client A2 painted the original prompt')
      await waitForPaintedText(clientB, holdPrompt, 'Client B painted the original prompt')
      const a2Pid = (await clientA2.businessPid())!
      const bPid = (await clientB.businessPid())!
      assert.notEqual(a2Pid, bPid, 'the two old-build Clients reused one business PID')
      const peerBoundary = latestSurfaceStatus(clientB)
      assert.ok(peerBoundary !== undefined, 'Client B published no surface-status boundary')
      const peerIndex = recordIndex(clientB)
      const sessionLogsBeforeReload = sessionLogFiles(current)

      // The live old Host survives the official profile upgrade; the side-old
      // payload remains the running old build.
      const newProfile = await current.installNewProfileForReload()
      assert.equal(newProfile.version, current.pair.new.version, 'the for-reload profile has the wrong version')
      assert.notEqual(newProfile.buildId, oldSide.buildId, 'the for-reload profile did not change the buildId')
      assert.equal(await clientA2.isAlive(), true, 'Client A2 died during the profile upgrade')
      assert.equal(await clientB.isAlive(), true, 'Client B died during the profile upgrade')
      await assertHostArtifactsKept(current, host, artifactsBefore, 'profile upgrade')

      boundary = recordIndex(clientA2)
      await clientA2.submit('/reload-client')
      const requested = await waitForAcceptedHandoff(clientA2, a2Pid, 'Client A2 production reload', boundary)
      assert.equal(requested.source, 'manual', 'the production command did not name the manual source')
      assert.equal(requested.targetBuildId, newProfile.buildId, 'the production command resolved another target build')
      assert.equal(requested.targetBundleVersion, newProfile.version, 'the production command resolved another bundle version')
      assert.equal(requested.sessionId, sessionId, 'the production command captured another Session')
      assert.equal(requested.expectedHostInstanceId, hostIdentity.instanceId, 'the production command captured another Host')

      const closed = await waitForClientClosed(clientA2, a2Pid, 'Client A2 released its old resources')
      assert.deepEqual(closed.owners, ZERO_OWNERS, 'Client A2 did not release every owned Client resource')
      assert.equal(closed.sessionOpen, false, 'Client A2 still reported its old Session open')
      assert.equal(closed.surfaceMounted, false, 'Client A2 still reported its old surface mounted')

      const replacement = await waitForReplacement(clientA2, a2Pid, 'Client A2 replacement')
      assert.notEqual(replacement.pid, a2Pid, 'the replacement reused the old business PID')
      assert.equal(replacement.hostAuthenticated.host?.instanceId, hostIdentity.instanceId,
        'the replacement authenticated another Host instance')
      assert.equal(replacement.restored.sessionId, sessionId, 'the replacement restored another Session')
      assert.equal(replacement.restored.sessionOpen, true, 'the replacement did not open the original Session')
      assert.equal(replacement.restored.sessionHistoryOpen, true, 'the replacement did not restore the Session history')
      assert.equal(replacement.restored.surfaceMounted, true, 'the replacement did not mount its surface')
      assert.equal(replacement.restored.transport, 'connected', 'the replacement transport is not connected')
      assert.equal(replacement.restored.clientBuildId, newProfile.buildId, 'the replacement did not run the new build')
      assert.equal(replacement.ready.openSessionId, sessionId, 'the replacement ready record carries another Session')
      await waitForPaintedText(clientA2, holdPrompt, 'the replacement painted the original prompt')

      assertPeerSurfaceKept(clientB, peerIndex, peerBoundary, hostIdentity, 'Client B across the replacement')
      await assertHostArtifactsKept(current, host, artifactsBefore, 'replacement handoff')
      assert.equal(c1WorkHadRelease(host.workRoot), false, 'the replacement handoff released the held Turn')
      assert.deepEqual(sessionLogFiles(current), sessionLogsBeforeReload, 'the replacement created a new Session log')
      assert.equal(turnEndCount(current, sessionId), 0, 'the replacement observed a turn/end before the barrier release')
      assert.equal(userPromptCount(current, sessionId, holdPrompt), 1, 'the admitted prompt was duplicated')

      await clientA2.close()
      await waitForPidGone(a2Pid, 'Client A2 old parent')
      await waitForPidGone(replacement.pid, 'Client A2 replacement')
      await current.refreshClientBusinessPids(clientA2)
      assert.equal(await clientB.isAlive(), true, 'Client B died when Client A2 exited')
      assertPeerSurfaceKept(clientB, peerIndex, peerBoundary, hostIdentity, 'Client B across the A2 exit')
      await assertHostArtifactsKept(current, host, artifactsBefore, 'Client A2 exit')

      const releaseBoundary = hostSessionEvents(current, sessionId)?.length ?? 0
      await current.releaseHeldTurn(host)
      await waitForC1Event(host.workRoot,
        event => event.kind === 'long-turn-released' && event.sessionId === sessionId,
        'the Host released the long Turn')
      await waitForHostSessionEventAfter(current, sessionId, releaseBoundary,
        event => event.type === 'turn/end', 'the Host settled the held Turn')
      await waitForPaintedText(clientB, 'long-turn answer 1', 'Client B read the original Turn settlement')

      const writeBoundary = hostSessionEvents(current, sessionId)?.length ?? 0
      await clientB.submit('u1-reload-b-after')
      await waitForHostSessionEventAfter(current, sessionId, writeBoundary,
        event => event.type === 'user/message' && JSON.stringify(event.data?.content ?? []).includes('u1-reload-b-after'),
        'Client B committed its own prompt')
      await waitForHostSessionEventAfter(current, sessionId, writeBoundary,
        event => event.type === 'turn/end', 'Client B settled its own Turn')
      assert.equal(userPromptCount(current, sessionId, 'u1-reload-b-after'), 1,
        'Client B committed its own prompt more than once')
      assert.equal(await clientB.isAlive(), true, 'Client B died after its own write')
      assert.equal((await clientB.businessPid()), bPid, 'Client B changed its business PID')

      await clientB.close()
      await waitForPidGone(bPid, 'Client B closed')
      await current.refreshClientBusinessPids(clientB)
      await current.stopHost(host)
      await current.finish()
    })
  } finally {
    if (audit !== undefined) audit.complete()
  }
})

test('the destructive target-invalid refusal keeps the live old Host, Session and held Turn', async () => {
  await runScene(async scene => {
    await scene.installOldProfile()
    const oldSide = await scene.installOldSideBySide()
    const host = await scene.startHost({ source: 'side-old', scenario: 'long-turn' })
    const artifactsBefore = await hostArtifacts(scene, host)

    const holdPrompt = 'u1-target-invalid-hold'
    const client = await scene.startClient({ source: 'side-old', label: 'target-invalid-client' })
    const clientPid = (await client.businessPid())!
    assert.ok(Number.isInteger(clientPid), 'the target-invalid Client has no real business PID')
    await client.submit(holdPrompt)
    await waitForPaintedText(client, holdPrompt, 'the target-invalid Client painted its admitted prompt')
    const sessionId = (await waitForSurfaceSession(client, 'the target-invalid Client opened the Session')).openSessionId
    await waitForC1Event(host.workRoot,
      event => event.kind === 'long-turn-held' && event.sessionId === sessionId,
      'the target-invalid Turn was held')

    await scene.removeProfilePackageForReloadRefusal(host)
    await assertHostArtifactsKept(scene, host, artifactsBefore, 'official profile removal')
    const boundary = recordIndex(client)
    const baselineFrame = await client.text()
    await client.submit('/reload-client')
    await waitForReloadNotice(client, RELOAD_NOTICE.targetInvalid, 'target-invalid refusal', boundary, { baselineFrame })
    assertNoHandoffRequested(client, boundary, 'target-invalid refusal')
    assert.equal(await client.isAlive(), true, 'the target-invalid refusal killed the live Client')
    assert.equal((await client.businessPid()), clientPid, 'the target-invalid refusal changed the Client PID')
    await assertHostArtifactsKept(scene, host, artifactsBefore, 'target-invalid refusal')
    assert.equal(c1WorkHadRelease(host.workRoot), false, 'the target-invalid refusal released the held Turn')
    assert.notEqual(oldSide.buildId, '', 'the side-old build has no buildId')

    const releaseBoundary = hostSessionEvents(scene, sessionId)?.length ?? 0
    await scene.releaseHeldTurn(host)
    await waitForC1Event(host.workRoot,
      event => event.kind === 'long-turn-released' && event.sessionId === sessionId,
      'the target-invalid Turn completed')
    await waitForHostSessionEventAfter(scene, sessionId, releaseBoundary,
      event => event.type === 'turn/end', 'the target-invalid Host settled the Turn')
    await client.close()
    await waitForPidGone(clientPid, 'the target-invalid Client closed')
    await scene.refreshClientBusinessPids(client)
    await scene.stopHost(host)
    await scene.finish()
  })
})
