/**
 * Split-process business qualification: real installed Host bootstrap,
 * admission, startup refusals, artifact recovery and stop windows.
 *
 * Every test creates ONE real Supervisor Scene, installs the immutable packed
 * candidate and drives the product's own installed entries. The Worker holds no
 * process handle and never signals a bare PID; the Supervisor owns every child
 * and its exact kernel identity.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import {
  assertPublishedHostMatchesKernel,
  assertClientHostMatchesPublished,
  exchangeCookie,
  readAuthenticatedIdentity,
  readScopeFiles,
} from '../../../support/split-process-authentication.ts'
import {
  createSplitProcessScene,
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
    const refusalModes = [
      ['host-runtime-disabled', /expected exactly one active piTuiHostRuntime owner row, found 0/u],
      ['tui-row-enabled', /forbidden TUI\/Client-UI rows are (?:active|not disabled): tui-app/u],
      ['connection-disabled', /connection owner row, found 0/u],
      ['session-controller-disabled', /sessionController owner row, found 0/u],
      ['workspace-controller-disabled', /expected exactly one active workspaceController owner row, found 0/u],
    ] as const
    for (const [mode, expectedError] of refusalModes) {
      const [attempt] = await scene.startHostAttempts({ mode })
      expect(attempt, `the ${mode} attempt was not registered`).toBeDefined()
      expect(attempt.pid).toBeGreaterThan(0)
      expect(typeof attempt.birth).toBe('string')
      const failure = await scene.waitEntryRecord(attempt, { m4a0: 'failure' })
      expect(failure.processRole).toBe('host')
      expect(String(failure.error)).toMatch(expectedError)
      const terminal = await scene.finishEntry(attempt)
      expect(terminal.exit).toEqual({ code: 1, signal: null })
      expect(terminal.outcome).toBe('startup-refusal')
      const facts = await scene.entryRecordFacts(attempt)
      expect(facts.records.some(record => record.m4a0 === 'ready')).toBe(false)
      expect(facts.records.some(record => record.m4a0 === 'failure' && record.phase === 'after-boot')).toBe(true)
      expect(facts.redactedKeys).not.toContain('token')
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
    expect(String(failure.error)).toMatch(/expected exactly one active piTuiHostRuntime owner row, found 0/u)
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
    await scene.stopHost(host)
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
    await scene.signalHost(staleHost, 'SIGKILL')
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
    const publicationScratch = scopeScratchSet(scene.installation.dshHome, scene.scope.scopeId)
    const [publication] = await scene.startHostAttempts({ mode: 'stop-during-publication', signal: 'SIGTERM' })
    const registryPath = join(scene.scopeDir, 'instance.json')
    await waitForPublishedFile(registryPath, 'the publication-window registry')
    const published = JSON.parse(readFileSync(registryPath, 'utf8')) as Record<string, any>
    expect(published.hostPid).toBe(publication.pid)
    assertPublishedHostMatchesKernel(published as never, 'the publication-window registry')
    expect(existsSync(join(scene.scopeDir, 'launch.json'))).toBe(true)
    const beforeSignal = await scene.entryRecordFacts(publication)
    expect(beforeSignal.records.some(record => record.m4a0 === 'ready')).toBe(false)

    await scene.signalEntry(publication, 'SIGTERM')
    const requested = await scene.waitEntryRecord(publication, { m4a0: 'stop-requested' })
    expect(requested.signal).toBe('SIGTERM')
    expect(requested.phase).toBe('publication')
    await scene.signalEntry(publication, 'SIGTERM')
    const publicationRepeat = await scene.waitEntryRecord(publication, { m4a0: 'stop-repeat-ignored' })
    expect(publicationRepeat.phase).toBe('publication')

    scene.releaseBarrier(publication, 'publish')
    const cleanup = await scene.waitEntryRecord(publication, { m4a0: 'cleanup' })
    expect(cleanup.status).toBe('completed')
    await scene.signalEntry(publication, 'SIGTERM')
    const shutdownRepeat = await scene.waitEntryRecord(publication, { m4a0: 'stop-repeat-ignored', phase: 'shutdown' })
    expect(shutdownRepeat.signal).toBe('SIGTERM')
    scene.releaseBarrier(publication, 'stop')

    const publicationTerminal = await scene.finishEntry(publication)
    expect(publicationTerminal.outcome).toBe('signal-stop')
    expect(publicationTerminal.exit).toEqual({ code: 0, signal: null })
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

    // (b) The first-liveness window is a DIFFERENT production await boundary.
    const livenessScratch = scopeScratchSet(scene.installation.dshHome, scene.scope.scopeId)
    const [liveness] = await scene.startHostAttempts({ mode: 'stop-during-initial-liveness', signal: 'SIGINT' })
    const held = await scene.waitEntryRecord(liveness, { m4a0: 'qualification', op: 'liveness-barrier' })
    expect(held.pid).toBe(liveness.pid)
    await scene.signalEntry(liveness, 'SIGINT')
    const livenessRequested = await scene.waitEntryRecord(liveness, { m4a0: 'stop-requested' })
    expect(livenessRequested.signal).toBe('SIGINT')
    expect(livenessRequested.phase).toBe('running')
    scene.releaseBarrier(liveness, 'liveness')
    const livenessTerminal = await scene.finishEntry(liveness)
    expect(livenessTerminal.outcome).toBe('signal-stop')
    expect(livenessTerminal.exit).toEqual({ code: 130, signal: null })
    const livenessRecords = await scene.entryRecords(liveness)
    expect(livenessRecords.some(record => record.m4a0 === 'ready')).toBe(false)
    expect(livenessRecords.some(record => record.m4a0 === 'failure')).toBe(false)
    expect(livenessRecords.filter(record => record.m4a0 === 'cleanup' && record.status === 'completed')).toHaveLength(1)
    expect(scopeScratchSet(scene.installation.dshHome, scene.scope.scopeId)).toEqual(livenessScratch)
    await scene.assertEntrySeatsFree()

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
    expect(records).toEqual([])
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
    const rootEntriesBefore = readdirSync(scene.workDir).sort()
    const reject = async (type: string, payload: Record<string, unknown>, pattern: RegExp): Promise<void> => {
      await expect(scene.request(type, payload, 30_000)).rejects.toThrow(pattern)
    }
    await reject('ENTRY_RECORDS', { entryId: 'unknown-entry' }, /unknown entryId/u)
    await reject('START_HOST_ATTEMPTS', { mode: 'not-a-mode' }, /INPUT_HOST_ATTEMPT_MODE/u)
    await reject('START_HOST_ATTEMPTS', { mode: 'host-runtime-disabled', count: 2 }, /INPUT_HOST_ATTEMPT_COUNT/u)
    await reject('START_HOST_ATTEMPTS', { mode: 'stop-during-publication' }, /INPUT_HOST_ATTEMPT_SIGNAL/u)
    await reject('START_HOST_ATTEMPTS', { mode: 'host-runtime-disabled', unexpected: 1 }, /rejects the field "unexpected"/u)
    await reject('START_HOST_ATTEMPTS', { mode: 'host-runtime-disabled', scratchTarget: join(scene.workDir, 'outside') },
      /does not accept a scratchTarget/u)
    await reject('START_HOST_ATTEMPTS', { mode: 'seat-conflict', scratchTarget: join(scene.scopeDir, '..', 'outside') },
      /no accepted Host/u)
    await reject('START_QUALIFICATION_CLIENTS', { mode: 'attach' }, /no accepted Host/u)
    await reject('START_QUALIFICATION_CLIENTS', { mode: 'not-a-mode' }, /INPUT_QUALIFICATION_CLIENT_MODE/u)
    await reject('START_QUALIFICATION_CLIENTS', { mode: 'discovery-refusal', refusal: 'not-a-refusal' },
      /INPUT_DISCOVERY_REFUSAL/u)
    await reject('SET_INSTALLATION_FAULT', { fault: 'not-a-fault' }, /INPUT_INSTALLATION_FAULT/u)
    await reject('RUN_BOOTSTRAP_CLI', { mode: 'not-a-mode' }, /INPUT_BOOTSTRAP_CLI_MODE/u)
    await reject('START_IDENTITY_WITNESS', { kind: 'not-a-witness' }, /INPUT_IDENTITY_WITNESS/u)
    await reject('SIGNAL_ENTRY', { entryId: 'unknown-entry', signal: 'SIGTERM' }, /unknown entryId/u)
    await reject('SIGNAL_ENTRY', { entryId: 'unknown-entry', signal: 'SIGUSR1' }, /unknown entryId/u)
    await reject('FINISH_ENTRY', { entryId: 'unknown-entry' }, /unknown entryId/u)
    await reject('RECLAIM_DISCOVERED_HOST', { entryId: 'unknown-entry' }, /unknown entryId/u)
    await reject('WAIT_ENTRY_RECORD', { entryId: 'unknown-entry', match: { m4a0: 'ready' } }, /unknown entryId/u)
    await reject('START_HOST_ATTEMPTS', { mode: 'seat-race', count: 17 }, /INPUT_HOST_ATTEMPT_COUNT/u)

    // No reservation, directory or child was created by any refused input.
    expect(readdirSync(scene.workDir).sort()).toEqual(rootEntriesBefore)
    expect(existsSync(join(scene.workDir, 'host-attempts'))).toBe(false)
    expect(existsSync(join(scene.workDir, 'qualification-clients'))).toBe(false)
    expect(existsSync(join(scene.workDir, 'identity-witnesses'))).toBe(false)
    expect(existsSync(join(scene.scopeDir, 'instance.json'))).toBe(false)

    // The refused inputs do not poison a later legal Scene.
    const host = await scene.startHost()
    await assertAuthenticatedCurrentHost(scene, host)
    await scene.stopHost(host)
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
          'the entry-admission test failed and its Scene cleanup also failed')
      }
      throw new AggregateError([asError(cleanupError)],
        'the entry-admission test passed but its Scene cleanup failed')
    }
  }
})
