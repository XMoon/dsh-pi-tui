#!/usr/bin/env node
/**
 * External OS-probe worker for the Upgrade U0 foundation.
 *
 * This is a narrow process entry, not a second test runner: it executes the
 * ONE `UpgradeScene` from `split-upgrade-fixture.ts` so the existing
 * `split-supervisor-signal-probe.mjs` can trigger real external SIGKILLs and
 * audit every Host generation / Client / Supervisor identity from the
 * Supervisor receipt. It registers no cases and makes no business Upgrade
 * assertions.
 *
 * Usage: node --import tsx/esm test/support/split-upgrade-probe-worker.mjs --scenario <name>
 */

import { existsSync, statSync } from 'node:fs'

import { createUpgradeScene } from './split-upgrade-fixture.ts'
import {
  recordIndex,
  waitForAcceptedHandoff,
  waitForC1Event,
  waitForClientClosed,
  waitForPaintedText,
  waitForReplacement,
  waitForSurfaceSession,
} from '../integration/split-upgrade/reload-observation.ts'

const SCENARIOS = new Set([
  'upgrade-sequential-hosts',
  'upgrade-live-profile-refusal',
  'upgrade-worker-kill:old-host-ready',
  'upgrade-worker-kill:between-host-generations',
  'upgrade-worker-kill:new-host-spawned-before-ack',
  'upgrade-worker-kill:side-build-install',
  'upgrade-worker-kill:bootstrap-install',
  'upgrade-worker-kill:reload-child-active',
  'upgrade-worker-kill:reload-child-started-before-report',
  'upgrade-worker-kill:qualification-client-active',
  'upgrade-sibling-live',
  'upgrade-live-host-exit',
  'upgrade-qualification-host-death',
])

function arg(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function requireScenario() {
  const scenario = arg('--scenario')
  if (typeof scenario !== 'string' || !SCENARIOS.has(scenario)) {
    throw new Error(`unknown --scenario ${JSON.stringify(scenario)}`)
  }
  return scenario
}

async function holdForExternalKill(label) {
  console.log(`UPGRADE_PROBE_WORKER_READY ${label} pid=${String(process.pid)} ppid=${String(process.ppid)}`)
  await new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label}: external kill did not arrive`)), 300_000)
  })
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function closeClientAndVerify(scene, client) {
  const businessPids = client.businessPids()
  if (businessPids.length === 0) throw new Error(`${client.label}: no real business PID in the official record`)
  const records = client.readRecords()
  if (!records.some(record => record.m4a0 === 'client-started')) {
    throw new Error(`${client.label}: the official record sink has no client-started event`)
  }
  const mode = statSync(client.recordFile).mode & 0o777
  if (mode !== 0o600) throw new Error(`${client.label}: the official record file mode is ${mode.toString(8)}, expected 600`)
  await client.close()
  const after = await client.terminal.state().catch(() => undefined)
  if (after !== undefined && after.exited === null) throw new Error(`${client.label}: terminal is still alive after close`)
  for (const pid of businessPids) {
    if (pidAlive(pid)) throw new Error(`${client.label}: business Client PID ${String(pid)} survived close`)
  }
}

async function runSequentialHosts(scene) {
  const oldProfile = await scene.installOldProfile()
  const oldHost = await scene.startHost({ source: 'profile', scenario: 'long-turn' })
  if (!Number.isInteger(oldHost.ready?.pid)) throw new Error('the old Host has no real ready PID')
  const oldClient = await scene.startClient({ source: 'profile', label: 'old-profile-client' })
  await oldClient.waitForRecord(record => record.m4a0 === 'ready', 'old Client ready record', 120_000)
  await closeClientAndVerify(scene, oldClient)
  const oldExit = await scene.stopHost(oldHost)
  if (oldExit.code !== 0 || oldExit.signal !== null) throw new Error(`old Host stop was ${JSON.stringify(oldExit)}`)

  const newProfile = await scene.activateNewProfileAfterOldStopped()
  if (newProfile.version === oldProfile.version) throw new Error('the activated profile did not change version')
  if (newProfile.payloadHash === oldProfile.payloadHash) throw new Error('the activated profile payload did not change')
  const newHost = await scene.startHost({ source: 'profile', scenario: 'long-turn' })
  if (!Number.isInteger(newHost.ready?.pid)) throw new Error('the new Host has no real ready PID')
  if (newHost.hostId === oldHost.hostId) throw new Error('the second generation reused the first Host id')
  if (newHost.buildId === oldHost.buildId) throw new Error('the two generations published the same buildId')
  const newClient = await scene.startClient({ source: 'profile', label: 'new-profile-client' })
  await newClient.waitForRecord(record => record.m4a0 === 'ready', 'new Client ready record', 120_000)
  await closeClientAndVerify(scene, newClient)
  const newExit = await scene.stopHost(newHost)
  if (newExit.code !== 0 || newExit.signal !== null) throw new Error(`new Host stop was ${JSON.stringify(newExit)}`)
  await scene.finish()
  console.log(`UPGRADE_PROBE_WORKER_FACTS ${JSON.stringify({
    scenario: 'upgrade-sequential-hosts',
    oldHostId: oldHost.hostId,
    oldHostPid: oldHost.ready.pid,
    oldBuildId: oldHost.buildId,
    newHostId: newHost.hostId,
    newHostPid: newHost.ready.pid,
    newBuildId: newHost.buildId,
    oldVersion: oldProfile.version,
    newVersion: newProfile.version,
  })}`)
}

async function runLiveProfileRefusal(scene) {
  await scene.installOldProfile()
  const oldHost = await scene.startHost({ source: 'profile', scenario: 'long-turn' })
  const before = await scene.installOldProfile()
  await scene.activateNewProfileAfterOldStopped().then(
    () => { throw new Error('activateNewProfileAfterOldStopped accepted a live old Profile Host') },
    error => {
      if (!String(error?.message ?? error).includes('still active')) throw error
    },
  )
  const after = await scene.installOldProfile()
  if (after.payloadHash !== before.payloadHash || after.version !== before.version) {
    throw new Error('a refused live-profile activation changed the installed profile')
  }
  await scene.stopHost(oldHost)

  const sideOld = await scene.installOldSideBySide()
  await scene.installNewSideBySide()
  const sideOldHost = await scene.startHost({ source: 'side-old', scenario: 'long-turn' })
  const newForReload = await scene.installNewProfileForReload()
  if (newForReload.version !== scene.pair.new.version) throw new Error('the for-reload install carries the wrong version')
  await scene.stopHost(sideOldHost)
  await scene.finish()
  console.log(`UPGRADE_PROBE_WORKER_FACTS ${JSON.stringify({
    scenario: 'upgrade-live-profile-refusal',
    sideOldBuildId: sideOld.buildId,
    reloadProfileVersion: newForReload.version,
  })}`)
}

async function runReloadChildActive(scene, point = 'reload-child-active') {
  const beforeReport = point === 'reload-child-started-before-report'
  await scene.installOldProfile()
  await scene.installOldSideBySide()
  await scene.installNewSideBySide()
  const host = await scene.startHost({ source: 'side-old', scenario: 'long-turn' })
  const client = await scene.startClient({ source: 'side-old', label: 'reload-child-active-client' })
  const oldPid = await client.businessPid()
  if (!Number.isInteger(oldPid)) throw new Error('reload-child-active: the initial Client has no real business PID')
  const holdPrompt = 'u1-kill-reload-hold'
  await client.submit(holdPrompt)
  await waitForPaintedText(client, holdPrompt, 'reload-child-active: painted the admitted prompt')
  const sessionId = (await waitForSurfaceSession(client, 'reload-child-active: opened the Session')).openSessionId
  await waitForC1Event(host.workRoot,
    event => event.kind === 'long-turn-held' && event.sessionId === sessionId,
    'reload-child-active: the Turn was held')
  const newProfile = await scene.installNewProfileForReload()
  const boundary = recordIndex(client)
  await client.submit('/reload-client')
  await waitForAcceptedHandoff(client, oldPid, `${point}: production reload`, boundary)
  if (beforeReport) {
    const started = await client.waitForRecord(
      record => record.m4a0 === 'client-started' && record.pid !== oldPid,
      `${point}: replacement client-started before PID REPORT`,
      180_000,
    )
    const replacementPid = started.pid
    if (!Number.isInteger(replacementPid) || replacementPid === oldPid || !pidAlive(replacementPid)) {
      throw new Error(`${point}: the replacement has no live non-parent business PID`)
    }
    await scene.report('worker-kill-point', {
      point,
      workerPid: process.pid,
      oldPid,
      replacementPid,
      businessPids: client.businessPids(),
      sessionId,
      newBuildId: newProfile.buildId,
      hostPid: host.ready?.pid,
      hostPgid: host.pgid,
    })
    await holdForExternalKill(point)
    return
  }
  await waitForClientClosed(client, oldPid, 'reload-child-active: old Client closed')
  const replacement = await waitForReplacement(client, oldPid, 'reload-child-active')
  if (replacement.pid === oldPid) throw new Error('reload-child-active: the replacement reused the old PID')
  await scene.refreshClientBusinessPids(client)
  const businessPids = client.businessPids()
  if (!businessPids.includes(oldPid) || !businessPids.includes(replacement.pid)) {
    throw new Error(`reload-child-active: the official record ledger is missing a parent/child PID: ${JSON.stringify(businessPids)}`)
  }
  await scene.report('worker-kill-point', {
    point: 'reload-child-active',
    workerPid: process.pid,
    oldPid,
    replacementPid: replacement.pid,
    businessPids,
    sessionId,
    newBuildId: newProfile.buildId,
    hostPid: host.ready?.pid,
    hostPgid: host.pgid,
  })
  await holdForExternalKill('reload-child-active')
}

/**
 * The one-shot qualification Client is live inside the Supervisor when the
 * external probe kills this Worker. The Supervisor owns its process group and
 * must reclaim it together with the Host generation and the Scene root.
 */
async function runQualificationClientActive(scene) {
  await scene.installOldProfile()
  await scene.installNewSideBySide()
  const host = await scene.startHost({ source: 'profile', scenario: 'long-turn' })
  await scene.report('worker-kill-point', {
    point: 'qualification-client-active',
    workerPid: process.pid,
    hostPid: host.ready?.pid,
    hostPgid: host.pgid,
  })
  // The Supervisor registers the qualification Client synchronously and holds
  // the kill barrier before sending the RPC op.
  await scene.probeSideNewClientHostFoundation(host)
  throw new Error('qualification-client-active: the qualification proof completed before the external SIGKILL')
}

async function runSiblingLive(scene) {  const stopFile = process.env.SPLIT_UPGRADE_PROBE_SIBLING_STOP_FILE
  if (typeof stopFile !== 'string' || stopFile === '') {
    throw new Error('upgrade-sibling-live: SPLIT_UPGRADE_PROBE_SIBLING_STOP_FILE must be set')
  }
  await scene.installOldProfile()
  const host = await scene.startHost({ source: 'profile', scenario: 'long-turn' })
  const client = await scene.startClient({ source: 'profile', label: 'sibling-live-client' })
  const holdPrompt = 'u1-sibling-live-hold'
  await client.submit(holdPrompt)
  await waitForPaintedText(client, holdPrompt, 'upgrade-sibling-live: painted the admitted prompt')
  const sessionId = (await waitForSurfaceSession(client, 'upgrade-sibling-live: opened the Session')).openSessionId
  await waitForC1Event(host.workRoot,
    event => event.kind === 'long-turn-held' && event.sessionId === sessionId,
    'upgrade-sibling-live: the Turn was held')
  await scene.report('sibling-live', {
    hostPid: host.ready?.pid,
    hostPgid: host.pgid,
    clientPid: await client.businessPid(),
    sessionId,
    sceneRoot: scene.workRoot,
  })
  const started = Date.now()
  while (!existsSync(stopFile)) {
    if (Date.now() - started > 300_000) throw new Error('upgrade-sibling-live: stop file never appeared')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  await scene.releaseHeldTurn(host)
  await waitForC1Event(host.workRoot,
    event => event.kind === 'long-turn-released' && event.sessionId === sessionId,
    'upgrade-sibling-live: the Turn completed')
  await client.close()
  await scene.stopHost(host)
  await scene.finish()
  console.log(`UPGRADE_PROBE_WORKER_FACTS ${JSON.stringify({
    scenario: 'upgrade-sibling-live',
    hostPid: host.ready?.pid,
    clientPid: await client.businessPid(),
    sessionId,
  })}`)
}

async function main() {
  const scenario = requireScenario()
  let scene
  try {
    scene = await createUpgradeScene()
    switch (scenario) {
      case 'upgrade-sequential-hosts':
        await runSequentialHosts(scene)
        return
      case 'upgrade-live-profile-refusal':
        await runLiveProfileRefusal(scene)
        return
      case 'upgrade-sibling-live':
        await runSiblingLive(scene)
        return
      case 'upgrade-worker-kill:reload-child-active':
        await runReloadChildActive(scene)
        return
      case 'upgrade-worker-kill:reload-child-started-before-report':
        await runReloadChildActive(scene, 'reload-child-started-before-report')
        return
      case 'upgrade-worker-kill:qualification-client-active':
        await runQualificationClientActive(scene)
        return
      case 'upgrade-worker-kill:old-host-ready': {
        await scene.installOldProfile()
        await scene.startHost({ source: 'profile', scenario: 'long-turn' })
        await scene.report('worker-kill-point', { point: 'old-host-ready', workerPid: process.pid })
        await holdForExternalKill('old-host-ready')
        return
      }
      case 'upgrade-worker-kill:between-host-generations': {
        await scene.installOldProfile()
        const host = await scene.startHost({ source: 'profile', scenario: 'long-turn' })
        await scene.stopHost(host)
        await scene.report('worker-kill-point', { point: 'between-host-generations', workerPid: process.pid })
        await holdForExternalKill('between-host-generations')
        return
      }
      case 'upgrade-worker-kill:new-host-spawned-before-ack': {
        await scene.installOldProfile()
        const host = await scene.startHost({ source: 'profile', scenario: 'long-turn' })
        await scene.stopHost(host)
        await scene.activateNewProfileAfterOldStopped()
        await scene.startHost({ source: 'profile', scenario: 'long-turn' })
        throw new Error('new-host-spawned-before-ack: the Supervisor unexpectedly acknowledged the second Host')
      }
      case 'upgrade-worker-kill:side-build-install': {
        await scene.installOldProfile()
        // The external probe watches the Supervisor's CURRENT install.inProgress
        // state and SIGKILLs this worker while pnpm is still installing. A
        // completed install is a truthful probe failure: there is no post-hoc
        // kill point.
        await scene.installNewSideBySide()
        throw new Error('side-build-install: the install completed before the external SIGKILL')
      }
      case 'upgrade-qualification-host-death': {
        // The Supervisor injects an abrupt old-Host crash AFTER its status
        // proof and BEFORE the qualification Client's ensureLocalHost(). The
        // real production discovery fallback then starts a detached Host; the
        // operation must refuse and the Supervisor must reclaim that Host
        // before any terminal quiescence claim.
        await scene.installOldProfile()
        await scene.installNewSideBySide()
        const host = await scene.startHost({ source: 'profile', scenario: 'long-turn' })
        let refusal
        try {
          await scene.probeSideNewClientHostFoundation(host)
        } catch (error) {
          refusal = error instanceof Error ? error.message : String(error)
        }
        if (refusal === undefined) throw new Error('qualification-host-death: the proof unexpectedly succeeded')
        console.log(`UPGRADE_PROBE_WORKER_FACTS ${JSON.stringify({
          scenario: 'upgrade-qualification-host-death',
          refused: true,
          hostPid: host.ready?.pid,
          injectedDeath: true,
        })}`)
        return
      }
      case 'upgrade-live-host-exit': {
        await scene.installOldProfile()
        await scene.installOldSideBySide()
        await scene.installNewSideBySide()
        const host = await scene.startHost({ source: 'side-old', scenario: 'long-turn' })
        await scene.installNewProfileForReload().then(
          () => { throw new Error('live-host-exit: the Host disappearance was not detected') },
          error => {
            const message = String(error?.message ?? error)
            if (!message.includes('Host exited during the profile update')) throw error
            console.log(`UPGRADE_PROBE_WORKER_FACTS ${JSON.stringify({
              scenario: 'upgrade-live-host-exit',
              detected: 'Host exited during the profile update',
              hostPid: host.ready?.pid,
            })}`)
          },
        )
        return
      }
      default:
        throw new Error(`unhandled scenario ${scenario}`)
    }
  } finally {
    // A killed worker never reaches this. Every normal or thrown path must
    // dispose its Supervisor and any native Client; never swallow that failure.
    if (scene !== undefined) {
      try {
        await scene.dispose()
      } catch (error) {
        console.error(`UPGRADE_PROBE_WORKER_DISPOSE_FAILED ${scenario}: ${error instanceof Error ? error.message : String(error)}`)
        process.exitCode = 1
      }
    }
  }
}

main().catch(error => {
  console.error(`UPGRADE_PROBE_WORKER_FAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
