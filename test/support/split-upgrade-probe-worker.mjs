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

import { statSync } from 'node:fs'

import { createUpgradeScene } from './split-upgrade-fixture.ts'

const SCENARIOS = new Set([
  'upgrade-sequential-hosts',
  'upgrade-live-profile-refusal',
  'upgrade-worker-kill:old-host-ready',
  'upgrade-worker-kill:between-host-generations',
  'upgrade-worker-kill:new-host-spawned-before-ack',
  'upgrade-worker-kill:side-build-install',
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

async function closeClientAndVerify(scene, client) {
  const pid = await client.businessPid()
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`${client.label}: no real business PID in the official record`)
  const records = client.readRecords()
  if (!records.some(record => record.m4a0 === 'client-started')) {
    throw new Error(`${client.label}: the official record sink has no client-started event`)
  }
  const mode = statSync(client.recordFile).mode & 0o777
  if (mode !== 0o600) throw new Error(`${client.label}: the official record file mode is ${mode.toString(8)}, expected 600`)
  await client.close()
  const after = await client.terminal.state().catch(() => undefined)
  if (after !== undefined && after.exited === null) throw new Error(`${client.label}: terminal is still alive after close`)
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

async function main() {
  const scenario = requireScenario()
  const scene = await createUpgradeScene()
  try {
    switch (scenario) {
      case 'upgrade-sequential-hosts':
        await runSequentialHosts(scene)
        return
      case 'upgrade-live-profile-refusal':
        await runLiveProfileRefusal(scene)
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
        await scene.installNewSideBySide()
        await scene.report('worker-kill-point', { point: 'side-build-install', workerPid: process.pid })
        await holdForExternalKill('side-build-install')
        return
      }
      default:
        throw new Error(`unhandled scenario ${scenario}`)
    }
  } finally {
    // A killed worker never reaches this; a normal path finalizes explicitly.
    // This fallback only keeps an unexpected non-kill failure from leaking.
    if (scenario.startsWith('upgrade-worker-kill:')) {
      await scene.dispose().catch(error => {
        console.error(`UPGRADE_PROBE_WORKER_DISPOSE_FAILED ${scenario}: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  }
}

main().catch(error => {
  console.error(`UPGRADE_PROBE_WORKER_FAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
