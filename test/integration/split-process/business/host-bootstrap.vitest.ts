/**
 * Split-process business qualification: real installed Host bootstrap,
 * admission, startup refusals, artifact recovery and stop windows.
 *
 * Every test creates ONE real Supervisor Scene, installs the immutable packed
 * candidate and drives the product's own installed entries. The Worker holds no
 * process handle and never signals a bare PID; the Supervisor owns every child
 * and its exact kernel identity.
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import { SupervisorClient } from '../../../support/split-supervisor-client.ts'

import {
  assertKernelBirthTerminal,
  assertPublishedHostMatchesKernel,
  assertClientHostMatchesPublished,
  exchangeCookie,
  readAuthenticatedIdentity,
  readScopeFiles,
} from '../../../support/split-process-authentication.ts'
import {
  createSplitProcessScene,
  type IdentityWitnessHandle,
  type QualificationClientHandle,
  type SplitProcessHostHandle,
  type SplitProcessScene,
} from '../../../support/split-process-fixture.ts'

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function ownerRows(ready: Record<string, any>, key: string): string[] {
  const rows = ready.ownerEntries?.[key]
  expect(Array.isArray(rows), `the ready status carries no owner entries for ${key}`).toBe(true)
  return rows as string[]
}

/** Assert the three Direct-only activation prerequisite rows stay disabled. */
function assertDirectOnlyRowsDisabled(ready: Record<string, any>): void {
  const states = new Map((ready.entries as Array<{ id: string; state: string }>)
    .map(entry => [entry.id, entry.state]))
  for (const row of ['pi-tui-direct-connection', 'pi-tui-direct-file-upload', 'pi-tui-direct-session-controller']) {
    expect(states.get(row), `the Direct-only prerequisite ${row} is not declared`).toBeDefined()
    expect(states.get(row), `the Direct-only prerequisite ${row} is active on the Host`).toBe('absent')
  }
}

/** The one authenticated identity chain of the current published Host. */
async function assertAuthenticatedCurrentHost(scene: SplitProcessScene, host: SplitProcessHostHandle): Promise<void> {
  const files = readScopeFiles(scene.installation.dshHome, scene.scope.scopeId)
  expect(files.registry.hostPid).toBe(host.ready.localHost.hostPid)
  expect(files.registry.instanceId).toBe(host.ready.localHost.instanceId)
  assertPublishedHostMatchesKernel(files.registry as never, 'the published registry')
  assertPublishedHostMatchesKernel(host.ready.localHost as never, 'the ready record')
  expect(files.registryMode).toBe(0o600)
  expect(files.launchMode).toBe(0o600)
  const cookie = await exchangeCookie(host.ready.localHost.origin, files.launch)
  const identity = await readAuthenticatedIdentity(host.ready.localHost.origin, cookie, 'the authenticated identity')
  expect(identity.status).toBe(200)
  assertClientHostMatchesPublished(identity.identity as never, files.registry as never, 'the authenticated identity')
}

test('admits the installed Host composition and refuses missing required owners', async () => {
  const scene = await createSplitProcessScene()
  let testError: unknown
  try {
    // 1. The pristine installed Host really composes and publishes current
    // facts; Ready is the product's own record, never a Supervisor synthesis.
    const host = await scene.startHost()
    const ready = host.ready
    expect(ready.processRole).toBe('host')
    expect(ready.phase).toBe('ready')
    expect(ready.fiberOwner).toBe('dsh-profile-root')
    expect(Number.isInteger(ready.rootFiberUid)).toBe(true)
    expect(ready.transport).toBe('listening')
    expect(ready.sessionOpen).toBe(false)
    expect(ready.profile).toBe('pi-tui')
    expect(ready.webServer?.host).toBe('127.0.0.1')
    expect(ready.webServer?.port).toBeGreaterThan(0)
    expect(ready.terminalProgressWatches).toBe(0)
    expect(ready.localHost.scopeId).toBe(scene.scope.scopeId)
    expect(ready.localHost.buildId).toBe(scene.scope.buildId)
    assertPublishedHostMatchesKernel(ready.localHost as never, 'the Host ready identity')

    const firstStatus = await scene.hostStatus(host)
    const secondStatus = await scene.hostStatus(host)
    expect(firstStatus.liveness.verdict).not.toBe('OBSERVED_QUIESCENT')
    expect(firstStatus.liveness.sourceStates.schedule).toBe('IDLE')
    expect(firstStatus.liveness.reasons).toContain('pending-interaction-unobservable')
    expect(firstStatus.liveness.reasons).toContain('inflight-write-unproven')
    expect(Number.isInteger(firstStatus.liveness.epoch)).toBe(true)
    expect(secondStatus.liveness.epoch).toBeGreaterThanOrEqual(firstStatus.liveness.epoch)

    // 2. The real owner graph: one active owner per required row, the official
    // Workspace registry/controller pair, live private services and the three
    // Direct-only activation prerequisites disabled.
    expect(ownerRows(ready, 'connection')).toEqual(['split-host-connection'])
    expect(ownerRows(ready, 'apiRemotes')).toEqual(['split-host-api-remotes'])
    expect(ownerRows(ready, 'typertGateway')).toEqual(['typert-gateway'])
    expect(ownerRows(ready, 'agents')).toHaveLength(1)
    expect(ownerRows(ready, 'sessions')).toHaveLength(1)
    expect(ownerRows(ready, 'jobController')).toHaveLength(1)
    expect(ownerRows(ready, 'fileUpload')).toEqual(['split-host-file-upload'])
    expect(ownerRows(ready, 'sessionStats')).toEqual(['split-host-session-stats'])
    expect(ownerRows(ready, 'turnOutline')).toEqual(['split-host-turn-outline'])
    expect(ownerRows(ready, 'sessionController')).toEqual(['split-host-session-controller'])
    expect(ownerRows(ready, 'settingsController')).toEqual(['split-host-settings-controller'])
    expect(ownerRows(ready, 'sessionLogExport')).toEqual(['split-host-session-log-download'])
    expect(ownerRows(ready, 'piTuiHostRuntime')).toEqual(['split-host-pi-tui-runtime'])
    expect(ownerRows(ready, 'workspaceRegistry')).toEqual(['workspace'])
    expect(ownerRows(ready, 'workspaceController')).toEqual(['workspace-controller'])
    expect(ownerRows(ready, 'performance')).toEqual(['pi-tui-performance-host'])
    expect(ownerRows(ready, 'visualTools')).toEqual(['pi-tui-visual-tools'])
    expect(ownerRows(ready, 'directoryPicker')).toHaveLength(1)
    expect(ownerRows(ready, 'cordisInspectProviders')).toHaveLength(1)
    for (const service of ['piTuiHostReady', 'piTuiFileReferences', 'piTuiTerminalProgress']) {
      expect(ready.services[service], `the private Host service ${service} is not live`).toBe(true)
    }
    expect(ready.forbiddenActive).toEqual([])
    assertDirectOnlyRowsDisabled(ready)

    // 3. Real authenticated identity, then the owner-governed stop.
    await assertAuthenticatedCurrentHost(scene, host)
    await scene.stopHost(host)

    // 4. Five independent declared startup refusals on the SAME pristine install.
    for (const mode of [
      'host-runtime-disabled',
      'tui-row-enabled',
      'connection-disabled',
      'session-controller-disabled',
      'workspace-controller-disabled',
    ] as const) {
      const [attempt] = await scene.startHostAttempts({ mode })
      expect(attempt, `the ${mode} attempt was not registered`).toBeDefined()
      expect(attempt.pid).toBeGreaterThan(0)
      expect(typeof attempt.birth).toBe('string')
      const failure = await scene.waitEntryRecord(attempt, { m4a0: 'failure' })
      expect(failure.processRole).toBe('host')
      const terminal = await scene.finishEntry(attempt)
      expect(terminal.exit).toEqual({ code: 1, signal: null })
      expect(terminal.outcome).toBe('startup-refusal')
      expect(terminal.error, 'the terminal leaked the raw failure text').toBeUndefined()
      expect(terminal.errorClass).toBe('declared-startup-refusal')
      expect(terminal.records.some(record => record.m4a0 === 'ready')).toBe(false)
      expect(terminal.records.some(record => record.m4a0 === 'failure' && record.phase === 'after-boot')).toBe(true)
      expect(existsSync(join(scene.scopeDir, 'instance.json')), `the ${mode} refusal left a registry`).toBe(false)
      expect(existsSync(join(scene.scopeDir, 'launch.json')), `the ${mode} refusal left a launch record`).toBe(false)
      await scene.assertEntrySeatsFree()
    }

    // 5. The failure history must not poison a later legal start on the same
    // installed profile; the recovered Host is authenticated and stopped.
    const recovered = await scene.startHost()
    await assertAuthenticatedCurrentHost(scene, recovered)
    await scene.stopHost(recovered)
    await scene.assertEntrySeatsFree()
  } catch (error) {
    testError = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (testError !== undefined) {
        throw new AggregateError([testError, asError(cleanupError)],
          'the Host bootstrap test failed and its Scene cleanup also failed')
      }
      throw new AggregateError([asError(cleanupError)],
        'the Host bootstrap test passed but its Scene cleanup failed')
    }
  }
})

test('does not admit a regular CLI as a Host solely from an inherited role', async () => {
  const scene = await createSplitProcessScene()
  let testError: unknown
  try {
    const before = new Set(await scene.sessionIds())
    const roleOnly = await scene.runBootstrapCli('inherited-host-role')
    expect(roleOnly.exit.code).not.toBe(0)
    expect(roleOnly.exit.code).not.toBe(null)
    expect(roleOnly.markers.requiredTuiSurfaceMissing).toBe(true)
    expect(roleOnly.profilePatchRestored).toBe(true)
    expect(existsSync(join(scene.scopeDir, 'instance.json'))).toBe(false)
    expect(await scene.sessionIds()).toEqual([...before])

    const help = await scene.runBootstrapCli('direct-help')
    expect(help.exit).toEqual({ code: 0, signal: null })
    expect(help.profilePatchRestored).toBe(true)
    expect(existsSync(join(scene.scopeDir, 'instance.json'))).toBe(false)
    expect(await scene.sessionIds()).toEqual([...before])
    await scene.assertEntrySeatsFree()
  } catch (error) {
    testError = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (testError !== undefined) {
        throw new AggregateError([testError, asError(cleanupError)],
          'the regular-CLI admission test failed and its Scene cleanup also failed')
      }
      throw new AggregateError([asError(cleanupError)],
        'the regular-CLI admission test passed but its Scene cleanup failed')
    }
  }
})

/** Bounded wait for one real published private file; no sleep-only proof. */
async function waitForPublishedFile(path: string, label: string, timeoutMs = 120_000): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (existsSync(path)) return
    if (Date.now() - started >= timeoutMs) throw new Error(`${label}: the real published file never appeared`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

function scopeScratchSet(dshHome: string, scopeId: string): string[] {
  const scopeDir = join(dshHome, 'run', 'dsh-pi-tui', scopeId)
  if (!existsSync(scopeDir)) return []
  return readdirSync(scopeDir).filter(name => name.startsWith('host-scratch-')).sort()
}

test('refuses a missing installed Host Runtime artifact and authenticates after restoring the same bytes', async () => {
  const scene = await createSplitProcessScene()
  let testError: unknown
  try {
    const fault = await scene.setInstallationFault('host-runtime-absent')
    expect(fault.fault).toBe('host-runtime-absent')
    expect(fault.target.endsWith('host-runtime.mjs')).toBe(true)
    expect(existsSync(fault.target)).toBe(false)
    expect(fault.barrierPath).toBeDefined()
    // The immutable candidate bytes are untouched by the scoped mutation.
    expect(readFileSync(scene.candidate.tarball).length).toBeGreaterThan(0)

    const [attempt] = await scene.startHostAttempts({ mode: 'host-runtime-absent' })
    const failure = await scene.waitEntryRecord(attempt, { m4a0: 'failure' })
    // The scoped install may not be restored while an affected attempt has no
    // validated terminal, even if its process already exited.
    await expect(scene.restoreInstallation()).rejects.toThrow(/Host attempt is not finished/u)
    const terminal = await scene.finishEntry(attempt)
    expect(terminal.exit).toEqual({ code: 1, signal: null })
    expect(terminal.outcome).toBe('startup-refusal')
    expect(terminal.stderrMarkers.loaderImportFailed).toBe(true)
    expect(terminal.stderrMarkers.moduleNotFound).toBe(true)
    const attemptRecords = await scene.entryRecords(attempt)
    expect(attemptRecords.some(record => record.m4a0 === 'ready')).toBe(false)
    expect(attemptRecords.some(record => record.m4a0 === 'failure' && record.phase === 'after-boot')).toBe(true)
    expect(existsSync(join(scene.scopeDir, 'instance.json'))).toBe(false)
    await scene.assertEntrySeatsFree()

    await scene.restoreInstallation()
    expect(existsSync(fault.target)).toBe(true)

    // The SAME Scene and the SAME installed bytes recover: a fresh Host really
    // composes, authenticates and releases the seat.
    const host = await scene.startHost()
    expect(host.ready.services.piTuiHostReady).toBe(true)
    expect(host.ready.services.piTuiFileReferences).toBe(true)
    expect(host.ready.services.piTuiTerminalProgress).toBe(true)
    expect(host.ready.ownerEntries.piTuiHostRuntime).toEqual(['split-host-pi-tui-runtime'])
    await assertAuthenticatedCurrentHost(scene, host)
    // Leave the active Host to dispose/FINALIZE: this is the direct positive
    // for the normal officialStopHost(activeHost) path and its seat/root proof.
  } catch (error) {
    testError = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (testError !== undefined) {
        throw new AggregateError([testError, asError(cleanupError)],
          'the Host artifact recovery test failed and its Scene cleanup also failed')
      }
      throw new AggregateError([asError(cleanupError)],
        'the Host artifact recovery test passed but its Scene cleanup failed')
    }
  }
})

test('reports Host boot and scratch cleanup failures without claiming readiness or clean shutdown', async () => {
  const scene = await createSplitProcessScene()
  let testError: unknown
  try {
    // (a) A real stale registry from a SIGKILLed authenticated Host, then a
    // missing installed bootstrap chunk on the SAME profile.
    const staleHost = await scene.startHost()
    await assertAuthenticatedCurrentHost(scene, staleHost)
    const registryPath = join(scene.scopeDir, 'instance.json')
    expect(existsSync(registryPath)).toBe(true)
    await scene.request('SIGNAL_ENTRY', { entryId: staleHost.entryId, signal: 'SIGKILL' }, 60_000)
    const staleTerminal = await scene.finishEntry(staleHost)
    expect(staleTerminal.exit).toEqual({ code: null, signal: 'SIGKILL' })
    expect(existsSync(registryPath)).toBe(true)

    const bootFault = await scene.setInstallationFault('host-bootstrap-absent')
    expect(bootFault.fault).toBe('host-bootstrap-absent')
    expect(existsSync(bootFault.target)).toBe(false)
    const [bootAttempt] = await scene.startHostAttempts({ mode: 'host-bootstrap-absent' })
    const bootFailure = await scene.waitEntryRecord(bootAttempt, { m4a0: 'failure' })
    expect(bootFailure.phase).toBe('after-boot')
    const bootTerminal = await scene.finishEntry(bootAttempt)
    expect(bootTerminal.exit).toEqual({ code: 1, signal: null })
    const bootRecords = await scene.entryRecords(bootAttempt)
    expect(bootRecords.some(record => record.m4a0 === 'ready')).toBe(false)
    expect(bootRecords.some(record => record.m4a0 === 'cleanup' && record.status === 'completed')).toBe(true)
    expect(bootRecords.some(record => record.m4a0 === 'cleanup-failure')).toBe(false)
    await scene.restoreInstallation()
    expect(existsSync(bootFault.target)).toBe(true)

    // (b) A real scratch-removal failure during the official shutdown.
    const scratchBefore = scopeScratchSet(scene.installation.dshHome, scene.scope.scopeId)
    const [scratchAttempt] = await scene.startHostAttempts({ mode: 'scratch-removal-failure' })
    await scene.waitEntryRecord(scratchAttempt, { m4a0: 'ready' })
    const scratchTerminal = await scene.finishEntry(scratchAttempt)
    expect(scratchTerminal.outcome).toBe('cleanup-failure')
    expect(scratchTerminal.step).toBe('scratch-remove')
    expect(scratchTerminal.exit).toEqual({ code: 1, signal: null })
    const scratchRecords = await scene.entryRecords(scratchAttempt)
    expect(scratchRecords.some(record => record.m4a0 === 'cleanup-failure' && record.step === 'scratch-remove')).toBe(true)
    expect(scratchRecords.some(record => record.m4a0 === 'cleanup' && record.status === 'completed')).toBe(false)
    // The fault leaves its own scratch for diagnosis; no OTHER scratch changed.
    for (const entry of scratchBefore) expect(existsSync(join(scene.scopeDir, entry))).toBe(true)
    await scene.assertEntrySeatsFree()

    // (c) The pre-profile Host failure through the real Client discovery path.
    const preProfileScratch = scopeScratchSet(scene.installation.dshHome, scene.scope.scopeId)
    const [preProfileClient] = await scene.startQualificationClients({ mode: 'discover-with-pre-profile-failure' })
    const preProfileFailure = await scene.waitEntryRecord(preProfileClient, { m4a0: 'failure' })
    expect(preProfileFailure.code).toBe('HOST_START_TIMEOUT')
    const preProfileTerminal = await scene.finishEntry(preProfileClient)
    expect(preProfileTerminal.exit).toEqual({ code: 1, signal: null })
    expect(scopeScratchSet(scene.installation.dshHome, scene.scope.scopeId)).toEqual(preProfileScratch)
    expect(existsSync(registryPath)).toBe(false)

    // The failure history does not poison a later legal start on this profile.
    const recovered = await scene.startHost()
    await assertAuthenticatedCurrentHost(scene, recovered)
    await scene.stopHost(recovered)
    await scene.assertEntrySeatsFree()
  } catch (error) {
    testError = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (testError !== undefined) {
        throw new AggregateError([testError, asError(cleanupError)],
          'the Host failure-classification test failed and its Scene cleanup also failed')
      }
      throw new AggregateError([asError(cleanupError)],
        'the Host failure-classification test passed but its Scene cleanup failed')
    }
  }
})

test('honors stop signals across Host publication and initial liveness observation', async () => {
  const scene = await createSplitProcessScene()
  let testError: unknown
  try {
    // (a) The publication window: the registry is committed, Ready is not.
    // Both stop signals exercise the same production await boundary with their
    // distinct terminal codes; one signal alone would lose half the contract.
    for (const stopSignal of ['SIGTERM', 'SIGINT'] as const) {
      const expectedCode = stopSignal === 'SIGINT' ? 130 : 0
      const publicationScratch = scopeScratchSet(scene.installation.dshHome, scene.scope.scopeId)
      const [publication] = await scene.startHostAttempts({ mode: 'stop-during-publication', signal: stopSignal })
      const registryPath = join(scene.scopeDir, 'instance.json')
      await waitForPublishedFile(registryPath, 'the publication-window registry')
      const published = JSON.parse(readFileSync(registryPath, 'utf8')) as Record<string, any>
      expect(published.hostPid).toBe(publication.pid)
      assertPublishedHostMatchesKernel(published as never, 'the publication-window registry')
      expect(existsSync(join(scene.scopeDir, 'launch.json'))).toBe(true)
      const beforeSignal = await scene.entryRecordFacts(publication)
      expect(beforeSignal.records.some(record => record.m4a0 === 'ready')).toBe(false)

      // A live, not-yet-accepted Host attempt is still a real consumer: the
      // installed-copy mutation admission must refuse it.
      const artifact = join(scene.installation.entries.host, '..', 'host-runtime.mjs')
      const artifactBefore = readFileSync(artifact)
      await expect(scene.setInstallationFault('host-runtime-absent'))
        .rejects.toThrow(/Host attempt must be terminal|Host attempt to be terminal|Host attempt/u)
      expect(readFileSync(artifact).equals(artifactBefore)).toBe(true)

      // A dangling symlink at a preallocated barrier path must not be followed
      // into creating an outside file.
      const outsideBarrierTarget = join(scene.tmpBase, `outside-barrier-${stopSignal}`)
      const stopBarrierPath = publication.barriers.stop
      symlinkSync(outsideBarrierTarget, stopBarrierPath)
      expect(() => scene.releaseBarrier(publication, 'stop')).toThrow(/already exists/u)
      expect(existsSync(outsideBarrierTarget), 'the barrier release followed a dangling symlink').toBe(false)
      rmSync(stopBarrierPath)

      const anotherSignal = stopSignal === 'SIGTERM' ? 'SIGINT' : 'SIGTERM'
      await expect(scene.request('SIGNAL_ENTRY', { entryId: publication.entryId, signal: anotherSignal }))
        .rejects.toThrow(/declared/u)

      await scene.signalEntry(publication, stopSignal)
      const requested = await scene.waitEntryRecord(publication, { m4a0: 'stop-requested' })
      expect(requested.signal).toBe(stopSignal)
      expect(requested.phase).toBe('publication')
      await scene.signalEntry(publication, stopSignal)
      const publicationRepeat = await scene.waitEntryRecord(publication, { m4a0: 'stop-repeat-ignored' })
      expect(publicationRepeat.phase).toBe('publication')

      scene.releaseBarrier(publication, 'publish')
      const cleanup = await scene.waitEntryRecord(publication, { m4a0: 'cleanup' })
      expect(cleanup.status).toBe('completed')
      await scene.signalEntry(publication, stopSignal)
      const shutdownRepeat = await scene.waitEntryRecord(publication, { m4a0: 'stop-repeat-ignored', phase: 'shutdown' })
      expect(shutdownRepeat.signal).toBe(stopSignal)
      scene.releaseBarrier(publication, 'stop')

      const publicationTerminal = await scene.finishEntry(publication)
      expect(publicationTerminal.outcome).toBe('signal-stop')
      expect(publicationTerminal.exit).toEqual({ code: expectedCode, signal: null })
      expect(publicationTerminal.stopRequested).toBe(1)
      expect(publicationTerminal.repeatIgnored).toBe(2)
      const publicationRecords = await scene.entryRecords(publication)
      expect(publicationRecords.some(record => record.m4a0 === 'ready')).toBe(false)
      expect(publicationRecords.some(record => record.m4a0 === 'failure')).toBe(false)
      expect(publicationRecords.filter(record => record.m4a0 === 'cleanup' && record.status === 'completed')).toHaveLength(1)
      expect(existsSync(registryPath)).toBe(false)
      expect(existsSync(join(scene.scopeDir, 'launch.json'))).toBe(false)
      expect(scopeScratchSet(scene.installation.dshHome, scene.scope.scopeId)).toEqual(publicationScratch)
      await scene.assertEntrySeatsFree()
    }

    // (b) The first-liveness window is a DIFFERENT production await boundary.
    // It carries the symmetric SIGTERM/SIGINT proof, not one representative.
    for (const stopSignal of ['SIGTERM', 'SIGINT'] as const) {
      const expectedCode = stopSignal === 'SIGINT' ? 130 : 0
      const livenessScratch = scopeScratchSet(scene.installation.dshHome, scene.scope.scopeId)
      const [liveness] = await scene.startHostAttempts({ mode: 'stop-during-initial-liveness', signal: stopSignal })
      const held = await scene.waitEntryRecord(liveness, { m4a0: 'qualification', op: 'liveness-barrier' })
      expect(held.pid).toBe(liveness.pid)
      await scene.signalEntry(liveness, stopSignal)
      const livenessRequested = await scene.waitEntryRecord(liveness, { m4a0: 'stop-requested' })
      expect(livenessRequested.signal).toBe(stopSignal)
      expect(livenessRequested.phase).toBe('running')
      scene.releaseBarrier(liveness, 'liveness')
      const livenessTerminal = await scene.finishEntry(liveness)
      expect(livenessTerminal.outcome).toBe('signal-stop')
      expect(livenessTerminal.exit).toEqual({ code: expectedCode, signal: null })
      const livenessRecords = await scene.entryRecords(liveness)
      expect(livenessRecords.some(record => record.m4a0 === 'ready')).toBe(false)
      expect(livenessRecords.some(record => record.m4a0 === 'failure')).toBe(false)
      expect(livenessRecords.filter(record => record.m4a0 === 'cleanup' && record.status === 'completed')).toHaveLength(1)
      expect(scopeScratchSet(scene.installation.dshHome, scene.scope.scopeId)).toEqual(livenessScratch)
      await scene.assertEntrySeatsFree()
    }

    // The stopped windows leave a reusable seat and scratch ownership.
    const recovered = await scene.startHost()
    await assertAuthenticatedCurrentHost(scene, recovered)
    await scene.stopHost(recovered)
    await scene.assertEntrySeatsFree()
  } catch (error) {
    testError = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (testError !== undefined) {
        throw new AggregateError([testError, asError(cleanupError)],
          'the Host stop-window test failed and its Scene cleanup also failed')
      }
      throw new AggregateError([asError(cleanupError)],
        'the Host stop-window test passed but its Scene cleanup failed')
    }
  }
})

test('removes its owned scratch on a forced exit before profile boot', async () => {
  const scene = await createSplitProcessScene()
  let testError: unknown
  try {
    const before = scopeScratchSet(scene.installation.dshHome, scene.scope.scopeId)
    const sessionsBefore = new Set(await scene.sessionIds())
    const [attempt] = await scene.startHostAttempts({ mode: 'early-exit' })
    const terminal = await scene.finishEntry(attempt)
    expect(terminal.outcome).toBe('early-exit')
    expect(terminal.exit).toEqual({ code: 1, signal: null })
    const records = await scene.entryRecords(attempt)
    // A POSIX Host writes its PATH bootstrap diagnostic before the forced exit;
    // it is not a boot, readiness or lifecycle-completion record. Accept zero or
    // exactly one such diagnostic for THIS attempt and keep the raw records.
    const bootEnvironmentRecords = records.filter(record => record.m4a0 === 'host-environment')
    expect(records).toEqual(bootEnvironmentRecords)
    expect(bootEnvironmentRecords.length).toBeLessThanOrEqual(1)
    for (const record of bootEnvironmentRecords) {
      expect(record).toMatchObject({
        m4a0: 'host-environment',
        processRole: 'host',
        pid: attempt.pid,
        mode: expect.any(String),
        addedPathCount: expect.any(Number),
        skippedInvalidCount: expect.any(Number),
        skippedInaccessibleCount: expect.any(Number),
      })
    }
    expect(existsSync(join(scene.scopeDir, 'instance.json'))).toBe(false)
    expect(scopeScratchSet(scene.installation.dshHome, scene.scope.scopeId)).toEqual(before)
    expect(await scene.sessionIds()).toEqual([...sessionsBefore])
    await scene.assertEntrySeatsFree()

    const recovered = await scene.startHost()
    await assertAuthenticatedCurrentHost(scene, recovered)
    await scene.stopHost(recovered)
    await scene.assertEntrySeatsFree()
  } catch (error) {
    testError = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (testError !== undefined) {
        throw new AggregateError([testError, asError(cleanupError)],
          'the forced early-exit test failed and its Scene cleanup also failed')
      }
      throw new AggregateError([asError(cleanupError)],
        'the forced early-exit test passed but its Scene cleanup failed')
    }
  }
})

test('refuses unqualified installed-entry operations before any child exists', async () => {
  const scene = await createSplitProcessScene()
  let testError: unknown
  try {
    const entriesBefore = readdirSync(scene.workDir).sort()
    const reject = async (type: string, payload: Record<string, unknown>, pattern: RegExp): Promise<void> => {
      await expect(scene.request(type, payload, 30_000)).rejects.toThrow(pattern)
    }
    await reject('SIGNAL_ENTRY', { entryId: 'unknown-entry', signal: 'SIGTERM' }, /unknown entryId/u)
    await reject('START_HOST_ATTEMPTS', { mode: 'not-a-mode' }, /INPUT_HOST_ATTEMPT_MODE/u)
    await reject('START_HOST_ATTEMPTS', { mode: 'seat-race', count: 17 }, /INPUT_HOST_ATTEMPT_COUNT/u)
    await reject('START_HOST_ATTEMPTS', { mode: 'host-runtime-disabled', extraEnv: {} }, /extraEnv/u)
    await reject('START_QUALIFICATION_CLIENTS', { mode: 'attach' }, /no accepted Host/u)
    await reject('RESTORE_INSTALLATION', {}, /no scoped installation mutation/u)

    // A synthetic credential marker in an IPC diagnostic is redacted at the
    // boundary; the real assertion is that it never reaches the Worker text.
    const marker = 'SYNTHETIC_MARKER_SECRET'
    const diagnostic = await scene.request('SIGNAL_ENTRY', {
      entryId: `token=${marker}`,
      signal: 'SIGTERM',
    }, 30_000).then(() => undefined, error => (error instanceof Error ? error : new Error(String(error))))
    expect(diagnostic?.message).toContain('[redacted]')
    expect(diagnostic?.message).not.toContain(marker)

    // No refused input created an entry; THIS Scene's actual owner ledgers
    // remain empty (sibling worker receipts are a different authority).
    expect(readdirSync(scene.workDir).sort()).toEqual(entriesBefore)
    const receipt = await scene.readSupervisorReceipt()
    expect(receipt.hosts ?? []).toEqual([])
    expect(receipt.qualificationClients ?? []).toEqual([])
    expect(receipt.qualificationHelpers ?? []).toEqual([])
  } catch (error) {
    testError = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (testError !== undefined) {
        throw new AggregateError([testError, asError(cleanupError)],
          'the admission test failed and its Scene cleanup also failed')
      }
      throw new AggregateError([asError(cleanupError)],
        'the admission test passed but its Scene cleanup failed')
    }
  }
})

test('compensates a failed finalization without leaking a live Client or witness', async () => {
  const scene = await createSplitProcessScene()
  let client: QualificationClientHandle | undefined
  let witness: IdentityWitnessHandle | undefined
  let finalizeRequested = false
  let primaryError: unknown
  try {
    const host = await scene.startHost()
    await scene.setInstallationFault('client-bootstrap-drift')
    ;[client] = await scene.startQualificationClients({ mode: 'client-bootstrap-drift' })
    await scene.waitEntryRecord(client!, { m4a0: 'ready' })
    witness = await scene.startIdentityWitness('live-non-host')

    // The real ordinary stop path must refuse BEFORE officialStopHost while
    // the drift Client is still attached, and the same Host must still be live
    // afterwards. This is the boundary dispose actually reaches on a failed
    // assertion.
    await expect(scene.request('STOP_HOST', { hostId: host.hostId }, 60_000))
      .rejects.toThrow(/qualification Client|live or un-finished/u)
    await assertAuthenticatedCurrentHost(scene, host)

    // The Host is still Ready, the drifted Client is connected, the witness is
    // live and the mutation is registered: FINALIZE must refuse and hand the
    // whole Scene to the joined compensation path.
    finalizeRequested = true
    const failure = await scene.request('FINALIZE', { clientsClosed: false }, 240_000)
      .then(() => undefined, error => asError(error))
    expect(failure, 'a finalization with live qualification state must fail').toBeDefined()
    const exit = await scene.waitSupervisorExit()
    expect(exit, 'a failed FINALIZE must exit 1 with no signal').toEqual({ code: 1, signal: null })

    const receipt = await scene.readSupervisorReceipt()
    expect(receipt.phase).toBe('NOT_QUIESCED')
    expect(receipt.compensation?.attempted, 'failed FINALIZE did not run compensation').toBe(true)
    expect(receipt.compensation?.completed, 'the joined compensation did not complete').toBe(true)
    expect(receipt.cleanup?.sceneRootRemoved, 'a failed finalization must preserve its evidence root').toBe(false)
    expect(receipt.cleanup?.hostSeatFree, 'the Host seat was not proven free').toBe(true)
    expect(receipt.cleanup?.qualificationSeatFree, 'the qualification seat was not proven free').toBe(true)
    expect(receipt.installationMutation, 'the installed-copy mutation was not restored').toBeUndefined()
    expect((receipt.hosts ?? []).every((entry: Record<string, any>) => entry.exited === true), 'a Host entry is still live').toBe(true)
    const clientFacts = (receipt.qualificationClients ?? []).find((entry: Record<string, any>) => entry.entryId === client!.entryId)
    const witnessFacts = (receipt.qualificationHelpers ?? []).find((entry: Record<string, any>) => entry.entryId === witness!.entryId)
    expect(clientFacts?.exited, 'the qualification Client was not reclaimed').toBe(true)
    expect(witnessFacts?.exited, 'the identity witness was not reclaimed').toBe(true)
    assertKernelBirthTerminal(client!.pid, client!.birth ?? undefined, 'the abandoned qualification Client')
    assertKernelBirthTerminal(witness!.pid, witness!.birth, 'the abandoned identity witness')
    expect(existsSync(scene.workDir), 'the failed-finalization evidence root was removed').toBe(true)
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    if (!finalizeRequested) {
      try {
        await scene.dispose()
      } catch (cleanupError) {
        if (primaryError !== undefined) {
          throw new AggregateError([asError(primaryError), asError(cleanupError)],
            'the failed-finalization setup failed and its Scene cleanup also failed')
        }
        throw cleanupError
      }
    }
  }
})

test('refuses installed-entry operations in a real non-process Scene before any child exists', async () => {
  const candidatePath = process.env.SPLIT_VITEST_CANDIDATE_TGZ
  const tmpBase = process.env.SPLIT_VITEST_TMP_BASE
  expect(candidatePath, 'SPLIT_VITEST_CANDIDATE_TGZ is required').toBeDefined()
  expect(tmpBase, 'SPLIT_VITEST_TMP_BASE is required').toBeDefined()
  const candidateSha256 = createHash('sha256').update(readFileSync(candidatePath!)).digest('hex')
  const pilotRunId = `pilot-admission-${String(Date.now())}-${String(process.pid)}`
  const pilot = new SupervisorClient({ runId: pilotRunId })
  let primaryError: unknown
  try {
    await pilot.request('BOOTSTRAP', {
      tarball: candidatePath,
      expectedSha256: candidateSha256,
      tmpBase,
      workerPid: process.pid,
      workerPpid: process.ppid,
    }, { timeoutMs: 600_000 })
    for (const [type, payload] of [
      ['START_HOST_ATTEMPTS', { mode: 'seat-race', count: 2 }],
      ['SET_INSTALLATION_FAULT', { fault: 'host-runtime-absent' }],
      ['SIGNAL_ENTRY', { entryId: 'unknown', signal: 'SIGTERM' }],
    ] as const) {
      await expect(pilot.request(type, payload, { timeoutMs: 30_000 }))
        .rejects.toThrow(/no process scene/u)
    }
    const receipt = JSON.parse(readFileSync(join(tmpBase!, 'split-resources', `${pilotRunId}.json`), 'utf8')) as Record<string, any>
    expect(receipt.kind).toBe('pilot')
    expect(receipt.hosts ?? []).toEqual([])
    expect(receipt.qualificationClients ?? []).toEqual([])
    expect(receipt.qualificationHelpers ?? []).toEqual([])
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    try {
      await pilot.close({ timeoutMs: 300_000, allowKill: false })
      const exit = await pilot.waitExit(60_000)
      expect(exit).toEqual({ code: 0, signal: null })
      const receipt = JSON.parse(readFileSync(join(tmpBase!, 'split-resources', `${pilotRunId}.json`), 'utf8')) as Record<string, any>
      expect(receipt.phase).toBe('ABORTED_CLEAN')
      expect(receipt.sceneRoot === undefined || !existsSync(receipt.sceneRoot),
        'the Pilot Scene root was not removed').toBe(true)
    } catch (closeError) {
      if (primaryError !== undefined) {
        throw new AggregateError([asError(primaryError), asError(closeError)],
          'the wrong-kind admission test failed and its Pilot cleanup also failed')
      }
      throw closeError
    }
  }
})
