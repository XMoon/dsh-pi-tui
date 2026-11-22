import assert from 'node:assert/strict'

import { test } from 'vitest'

import { createUpgradeScene, type UpgradeScene } from '../../support/split-upgrade-fixture.ts'
import {
  RELOAD_NOTICE,
  assertHostArtifactsKept,
  assertNoHandoffRequested,
  beginParallelAudit,
  c1WorkHadRelease,
  hostArtifacts,
  hostSessionEvents,
  recordIndex,
  userPromptCount,
  waitForAcceptedHandoff,
  waitForC1Event,
  waitForClientClosed,
  waitForHostSessionEventAfter,
  waitForPaintedText,
  waitForPidGone,
  waitForReloadNotice,
  waitForReplacement,
  waitForSurfaceSession,
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
          throw new AggregateError([primary, cleanupError], 'reload-target-source failed and its Scene cleanup also failed')
        }
        throw cleanupError
      }
    }
  }
  if (primary !== undefined) throw primary
}

test('one Client PID resolves the manual command from the Profile and the qualification SIGUSR2 from the side target', async () => {
  let audit: ParallelAudit | undefined
  try {
    await runScene(async scene => {
      const oldProfile = await scene.installOldProfile()
      const sideNew = await scene.installNewSideBySide()
      assert.notEqual(sideNew.buildId, oldProfile.buildId, 'the old Profile and the side-new build share one buildId')

      const host = await scene.startHost({ source: 'profile', scenario: 'long-turn' })
      assert.equal(host.buildId, oldProfile.buildId, 'the Host did not run the old Profile build')
      const artifactsBefore = await hostArtifacts(scene, host)
      const hostIdentity = artifactsBefore.identity

      const holdPrompt = 'u1-reload-source-hold'
      const client = await scene.startClient({
        source: 'profile',
        label: 'reload-source',
        reexecTargetPackageRoot: sideNew.packageRoot,
      })
      const oldPid = (await client.businessPid())!
      assert.ok(Number.isInteger(oldPid), 'the source-isolation Client has no real business PID')
      await client.submit(holdPrompt)
      await waitForPaintedText(client, holdPrompt, 'the source-isolation Client painted its admitted prompt')
      const sessionId = (await waitForSurfaceSession(client, 'the source-isolation Client opened the Session')).openSessionId
      await waitForC1Event(host.workRoot,
        event => event.kind === 'long-turn-held' && event.sessionId === sessionId,
        'the source-isolation Turn was held')
      assert.equal(c1WorkHadRelease(host.workRoot), false, 'the held Turn was released before the manual refusal')
      audit = await beginParallelAudit(scene, host, client, sessionId, 'reload-target-source')

      // The manual command must resolve the Profile, even though this Client
      // carries the qualification override. The Profile is the running build,
      // so the truthful result is already-current.
      let boundary = recordIndex(client)
      let baselineFrame = await client.text()
      await client.submit('/reload-client')
      await waitForReloadNotice(client, RELOAD_NOTICE.alreadyCurrent, 'manual Profile refusal', boundary, { baselineFrame })
      assertNoHandoffRequested(client, boundary, 'manual Profile refusal')
      assert.equal(await client.isAlive(), true, 'the manual refusal killed the source-isolation Client')
      await assertHostArtifactsKept(scene, host, artifactsBefore, 'manual Profile refusal')
      assert.equal(c1WorkHadRelease(host.workRoot), false, 'the manual refusal released the held Turn')

      // The qualification signal must use the side-new override on this SAME
      // live business PID, not the Profile target the manual command used.
      boundary = recordIndex(client)
      const signalPid = await scene.signalClientForQualification(client)
      assert.equal(signalPid, oldPid, 'the qualification signal target is not the current business PID')
      const requested = await waitForAcceptedHandoff(client, oldPid, 'qualification reexec', boundary)
      assert.equal(requested.source, 'qualification', 'the SIGUSR2 request did not name the qualification source')
      assert.equal(requested.targetBuildId, sideNew.buildId, 'the qualification request did not use the side-new target')
      assert.equal(requested.targetBundleVersion, sideNew.version, 'the qualification request resolved another bundle version')
      assert.equal(requested.sessionId, sessionId, 'the qualification request captured another Session')

      const closed = await waitForClientClosed(client, oldPid, 'the qualification Client released its old resources')
      assert.deepEqual(closed.owners, ZERO_OWNERS, 'the qualification Client did not release every owned Client resource')
      assert.equal(closed.surfaceMounted, false, 'the qualification Client still reported its old surface mounted')

      const replacement = await waitForReplacement(client, oldPid, 'qualification replacement')
      assert.notEqual(replacement.pid, oldPid, 'the qualification replacement reused the old business PID')
      assert.equal(replacement.hostAuthenticated.host?.instanceId, hostIdentity.instanceId,
        'the qualification replacement authenticated another Host instance')
      assert.equal(replacement.restored.sessionId, sessionId, 'the qualification replacement restored another Session')
      assert.equal(replacement.restored.surfaceMounted, true, 'the qualification replacement did not mount its surface')
      assert.equal(replacement.restored.transport, 'connected', 'the qualification replacement transport is not connected')
      assert.equal(replacement.restored.clientBuildId, sideNew.buildId,
        'the qualification replacement did not run the side-new build')
      await waitForPaintedText(client, holdPrompt, 'the qualification replacement painted the original prompt')
      await assertHostArtifactsKept(scene, host, artifactsBefore, 'qualification handoff')
      assert.equal(c1WorkHadRelease(host.workRoot), false, 'the qualification handoff released the held Turn')
      assert.equal(userPromptCount(scene, sessionId, holdPrompt), 1, 'the admitted prompt was duplicated')

      await client.close()
      await waitForPidGone(oldPid, 'the qualification old parent')
      await waitForPidGone(replacement.pid, 'the qualification replacement')
      await scene.refreshClientBusinessPids(client)
      await assertHostArtifactsKept(scene, host, artifactsBefore, 'qualification Client exit')
      assert.equal(userPromptCount(scene, sessionId, holdPrompt), 1, 'the original prompt was lost on Session readback')

      const releaseBoundary = hostSessionEvents(scene, sessionId)?.length ?? 0
      await scene.releaseHeldTurn(host)
      await waitForC1Event(host.workRoot,
        event => event.kind === 'long-turn-released' && event.sessionId === sessionId,
        'the source-isolation Turn completed')
      await waitForHostSessionEventAfter(scene, sessionId, releaseBoundary,
        event => event.type === 'turn/end', 'the source-isolation Host settled the Turn')
      await scene.stopHost(host)
      await scene.finish()
    })
  } finally {
    if (audit !== undefined) audit.complete()
  }
})
