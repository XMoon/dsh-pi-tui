/**
 * FR1 `/model` command Team seam: the ONE gesture admission between the picker
 * and the exact captured Session scope. Proves the command (not the picker)
 * captures the owner, re-verifies it after every await/confirmation delay,
 * routes the write through the SAME `withWriter` Session barrier and derives
 * the OFF-confirmation condition only from the official projection fact.
 *
 * @module @xmoon76/dsh-pi-tui/model-team-command.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { TransitionInProgressError } from '../../src/app/session/operation-barrier.ts'
import { SessionScopeSupersededError } from '../../src/app/session/scope.ts'
import type { ModelPickerRequest, ModelPresentation } from '../../src/app/command/model-presentation.ts'
import type { TeamModeSnapshot, TeamModeWriteOutcome } from '../../src/runtime/team-mode-port.ts'
import { createModelCommands, type ModelCommandDeps } from '../../src/tui/commands/models.ts'
import type { ModelDirectoryDto } from '../../src/runtime/catalog-port.ts'

const DIRECTORY: ModelDirectoryDto = {
  default: { provider: 'p', model: 'm' },
  routableProviders: ['p'],
  groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }],
  failures: [],
}

interface FakeTeam {
  snapshot: TeamModeSnapshot
  outcome: TeamModeWriteOutcome
  readonly setCalls: Array<{ sessionId: string; enabled: boolean }>
}

function makeTeam(snapshot: TeamModeSnapshot, outcome: TeamModeWriteOutcome = { kind: 'committed' }): FakeTeam {
  return { snapshot, outcome, setCalls: [] }
}

function openCommand(options: {
  readonly team: FakeTeam
  readonly live?: boolean
  readonly sessionId?: string | undefined
  readonly writerThrows?: unknown
  readonly readAfterRun?: TeamModeSnapshot
}): Promise<ModelPickerRequest> {
  const signal = new AbortController().signal
  const sessionId = 'sessionId' in options ? options.sessionId : 's1'
  const scope = { sessionId } as never
  const liveScope = options.live === false ? undefined : ({ sessionId } as never)
  const team = options.team
  let current = true
  let reads = 0
  const teamMode = {
    read: () => {
      reads += 1
      if (options.readAfterRun !== undefined && reads > 1) return options.readAfterRun
      return team.snapshot
    },
    subscribe: () => () => {},
    setEnabled: async (calledSessionId: string, enabled: boolean) => {
      team.setCalls.push({ sessionId: calledSessionId, enabled })
      return team.outcome
    },
  }
  const runner = {
    signal,
    currentSessionId: sessionId as string | undefined,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    catalog: {
      models: {
        available: () => true,
        loadDirectory: async () => DIRECTORY,
        sessionSelection: () => undefined,
        saveDefaultSelection: async () => ({ kind: 'committed' }),
        selectSessionModel: async () => ({ ownership: 'current', outcome: { kind: 'committed', value: { provider: 'p', model: 'm' } } }),
      },
      presets: { available: () => false },
      skills: { available: () => false },
    },
    captureSessionScope: () => scope,
    captureLiveSessionScope: () => liveScope,
    isSessionScopeCurrent: () => current,
    withWriter: async (_scope: unknown, task: () => unknown) => {
      if (options.writerThrows !== undefined) throw options.writerThrows
      return await task()
    },
    teamMode,
    refreshStatus: () => {},
    updateWelcomeCard: () => {},
    reconcileDefaultIntent: () => {},
    setDefaultIntent: () => {},
    setModelSelectionPending: () => {},
    trackDefaultWrite: () => {},
    settleIntent: () => {},
    config: {},
  }
  let captured: ModelPickerRequest | undefined
  const presentation: ModelPresentation = {
    notify: () => {},
    open: (request) => {
      captured = request
      return {
        setLoading: () => {},
        setDirectory: () => {},
        setLoadError: () => {},
        isDisposed: () => false,
        close: () => {},
      }
    },
  }
  const deps = {
    runner,
    app: {} as never,
    modelPresentation: presentation,
    registerOne: () => {},
    recordCommandDraftDisposition: () => {},
    notifyOutcome: () => {},
  } as unknown as ModelCommandDeps
  const commands = createModelCommands(deps)
  // A "stale scope after admission" test flips `current` once begin() admitted.
  return commands.openModel('models').then(() => {
    assert.ok(captured !== undefined, 'the command opened the presentation')
    // Make a second call to `isSessionScopeCurrent` false after the first
    // admission when requested (the closure test needs this).
    const returned = captured!
    Object.defineProperty(returned, '__setStale', { value: () => { current = false }, enumerable: false })
    return returned
  })
}

test('the command admits a Team gesture against the exact captured scope', async () => {
  const team = makeTeam({ kind: 'ready', enabled: false, modelRequestHistory: 'none' })
  const request = await openCommand({ team })
  assert.ok(request.team !== undefined, 'the PiTui request carries the Team seam')
  const admission = request.team!.begin()
  assert.equal(admission.kind, 'admitted')
  if (admission.kind !== 'admitted') return
  assert.equal(admission.attempt.enabled, true, 'OFF → On')
  assert.equal(admission.attempt.confirmRequired, false, 'no recorded request needs no confirmation')
  assert.deepEqual(await admission.attempt.run(), { kind: 'committed' })
  assert.deepEqual(team.setCalls, [{ sessionId: 's1', enabled: true }], 'one Host write through the writer barrier')
})

test('a recorded model request makes the OFF gesture require the confirmation seat', async () => {
  const team = makeTeam({ kind: 'ready', enabled: true, modelRequestHistory: 'recorded' })
  const request = await openCommand({ team })
  const admission = request.team!.begin()
  assert.equal(admission.kind, 'admitted')
  if (admission.kind !== 'admitted') return
  assert.equal(admission.attempt.enabled, false, 'On → OFF')
  assert.equal(admission.attempt.confirmRequired, true)
  // The seat's run still writes once (the seat owns the user's Confirm).
  assert.deepEqual(await admission.attempt.run(), { kind: 'committed' })
  assert.deepEqual(team.setCalls, [{ sessionId: 's1', enabled: false }])
})

test('a stale or sessionless capture refuses without any Host write', async () => {
  const sessionless = makeTeam({ kind: 'ready', enabled: false, modelRequestHistory: 'none' })
  const sessionlessRequest = await openCommand({ team: sessionless, sessionId: undefined })
  assert.equal(sessionlessRequest.team!.read().kind, 'unavailable')
  assert.equal(sessionlessRequest.team!.begin().kind, 'refused')
  assert.equal(sessionless.setCalls.length, 0)
})

test('the write re-verifies the captured scope after the confirmation delay', async () => {
  const team = makeTeam({ kind: 'ready', enabled: true, modelRequestHistory: 'recorded' })
  const request = await openCommand({ team })
  const admission = request.team!.begin()
  assert.equal(admission.kind, 'admitted')
  if (admission.kind !== 'admitted') return
  // The scope moved while the confirmation seat was open.
  ;(request as unknown as { __setStale(): void }).__setStale()
  const outcome = await admission.attempt.run()
  assert.equal(outcome.kind, 'cancelled')
  assert.match(outcome.kind === 'cancelled' ? outcome.reason : '', /Session changed/u)
  assert.equal(team.setCalls.length, 0, 'a stale confirmation never dispatches')
})

test('writer refusals are cancellations and an already-saved fresh read is not written again', async () => {
  const transitioning = makeTeam({ kind: 'ready', enabled: false, modelRequestHistory: 'none' })
  const first = await openCommand({ team: transitioning, writerThrows: new TransitionInProgressError() })
  const refused = first.team!.begin()
  assert.equal(refused.kind, 'admitted')
  if (refused.kind === 'admitted') {
    const outcome = await refused.attempt.run()
    assert.equal(outcome.kind, 'cancelled')
  }

  const superseded = makeTeam({ kind: 'ready', enabled: false, modelRequestHistory: 'none' })
  const second = await openCommand({ team: superseded, writerThrows: new SessionScopeSupersededError() })
  const lost = second.team!.begin()
  assert.equal(lost.kind, 'admitted')
  if (lost.kind === 'admitted') {
    const outcome = await lost.attempt.run()
    assert.equal(outcome.kind, 'cancelled')
    assert.match(outcome.kind === 'cancelled' ? outcome.reason : '', /Session changed/u)
  }

  // The first read reports OFF; the fresh read before the write proves the
  // Host already carries the target, so no duplicate team/mode is appended.
  const already = makeTeam({ kind: 'ready', enabled: false, modelRequestHistory: 'none' })
  const third = await openCommand({
    team: already,
    readAfterRun: { kind: 'ready', enabled: true, modelRequestHistory: 'none' },
  })
  const done = third.team!.begin()
  assert.equal(done.kind, 'admitted')
  if (done.kind === 'admitted') assert.deepEqual(await done.attempt.run(), { kind: 'committed' })
  assert.equal(already.setCalls.length, 0)
})
