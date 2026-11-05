/**
 * M4 PR4 RFL-006 regression — the skill picker selection is an accepted
 * semantic write that runs AFTER the `/skill` handler returned. The command
 * coordinator's `loadSkill` is the shared adoption point for the picker, the
 * typed `/skill <name>` gesture and every dynamic wrapper; the fix registers
 * the ONE controller-owned accepted-write lifetime at its synchronous entry
 * and releases it in `finally` at the REAL writer settlement.
 *
 * This drives the real surface:
 * - the REAL `registerTuiCommands` coordinator (real `/skill` + `/reload-client`
 *   definitions in the real ClientCommandRegistry),
 * - the REAL Skill Picker selection callback (`app.openSettings` captured),
 * - the REAL `loadSkill` preparation/Writer admission, held open,
 * - the REAL `SubmissionController` lifetime (the SAME `beginClientWrite`
 *   seam the composition root injects) and the REAL gate factory.
 *
 * It asserts the intermediate state (editor empty, lifetime open, reload
 * refused, no process request) and the final state (exactly one dispatch,
 * lifetime released, reload accepted), plus every terminal path
 * (stale, superseded, prepare error, prompt error, cancellation).
 *
 * @module @xmoon76/dsh-pi-tui/client-reload-skill-picker.test
 */

import assert from 'node:assert/strict'
import { unavailableWebAccess } from '../support/web-access-fake.ts'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { createClientReloadCommandRequest } from '../../src/app/command/client-reload.ts'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'
import { sessionScopeFacts } from '../support/session-scope-facts.ts'
import { createClientReloadLifetimeOwner } from '../support/client-reload-lifetime-owner.ts'
import { CLIENT_RELOAD_REFUSAL_NOTICES } from '../../src/tui/commands/utility.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { DirectCatalogPort } from '../../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../../src/runtime/direct/host-file-direct.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { DraftFileStore } from '../../src/client/media/attachment/file-draft.ts'
import { SessionScopeSupersededError } from '../../src/app/session/scope.ts'
import type { TuiCommandRunner } from '../../src/commands.ts'
import type { HumanSkillCatalog } from '../../src/domain/catalog/skill.ts'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => { disposeStartedApps() })

type Mode = 'held' | 'stale' | 'superseded' | 'prepare-error' | 'prompt-error' | 'abort'

interface Harness {
  readonly controller: ReturnType<typeof createClientReloadLifetimeOwner>['controller']
  readonly app: TuiApp
  readonly runner: TuiCommandRunner
  readonly reloadHandler: (invocation: { commandId: string; rawInput: string; signal: AbortSignal }) => unknown
  readonly skillHandler: (invocation: { commandId: string; rawInput: string; signal: AbortSignal }) => unknown
  readonly picker: () => ((id: string) => void) | undefined
  readonly prompts: Array<{ readonly line: string; readonly mode: string }>
  readonly requests: number
  releasePrepare(): void
  rejectPrepare(error: unknown): void
  abort(): void
  disposeApp(): void
  drain(): Promise<void>
  reload(): Promise<{ readonly kind: string; readonly text?: string }>
}

function setup(mode: Mode): Harness {
  const owner = createClientReloadLifetimeOwner()
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const ctx = new Context()
  const images = new DraftImageStore()
  const files = new DraftFileStore()
  const prompts: Array<{ line: string; mode: string }> = []
  let requests = 0
  let capturedPicker: ((id: string) => void) | undefined
  let resolvePrepare!: () => void
  let rejectPrepareGate!: (error: unknown) => void
  const prepareGate = new Promise<void>((resolve, reject) => {
    resolvePrepare = resolve
    rejectPrepareGate = reject
  })
  let prepareStarted!: () => void
  const prepareEntered = new Promise<void>(resolve => { prepareStarted = resolve })
  const abortController = new AbortController()
  let promptGate: Promise<void> = Promise.resolve()
  let stale = mode === 'stale'
  const agent = {
    status: 'idle',
    session: { id: 'session-a', header: { cwd: '/ws' }, seq: 0, eventAt: () => undefined, snapshotEvents: () => [] },
    options: {},
  } as never
  const skillSource = {
    resolveSkill: async () => ({ kind: 'found' as const, skill: { name: 'demo', description: 'Demo', content: 'body' } }),
    hostLoadsSkillBody: () => true,
    listHumanSkills: async (): Promise<HumanSkillCatalog> => ({
      skills: [{ name: 'demo', description: 'Demo' } as never],
      complete: true,
    }),
  }

  // The real app SettingsList is the picker presentation; capture its
  // selection callback (the production selection seam) without painting.
  app.openSettings = ((_items: unknown, onChange: (id: string) => void) => {
    capturedPicker = onChange
  }) as unknown as typeof app.openSettings

  const runner: TuiCommandRunner = {

    webAccess: unavailableWebAccess(),
    deliveredFilesSnapshot: () => undefined,
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    ...sessionScopeFacts(() => agent, () => 1, skillSource as never),
    backendKind: 'remote',
    currentSessionId: 'session-a',
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    defaultSelection: () => undefined,
    defaultIntent: undefined,
    setDefaultIntent: () => {},
    defaultIntentRecord: undefined,
    settleIntent: () => {},
    tuiSettings: undefined,
    applyFooterSettings: () => {},
    agents: {} as never,
    sessionReader: {
      list: async () => [],
      search: async () => ({ items: [], hasMore: false }),
      projectionBatch: async () => new Map(), blank: () => undefined, measureContext: () => undefined,
      turnOutline: () => undefined,
      sessionStatus: () => undefined,
    } as never,
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    commandRegistry: undefined,
    clientCommands: createClientCommandRegistry(parseCommand),
    hostFile: new DirectHostFilePort(() => undefined),
    hostShellCompletion: true,
    transcriptExportAvailable: true,
    interaction: {
      questions: {
        onRequest: () => true,
        subscribe: () => undefined,
        snapshot: () => undefined,
        claimTimedWait: async () => undefined,
        answerContinued: async () => 'not-continued' as const,
      },
      onApprovalRequest: () => {},
      setApprovalPolicy: () => true,
    } as never,
    sessionWriter: {
      prompt: async (sessionId: string, message: unknown, writeMode: string) => {
        prompts.push({ line: typeof message === 'string' ? message : JSON.stringify(message), mode: writeMode })
        if (mode === 'prompt-error') throw new Error('prompt failed')
        await promptGate
        if (abortController.signal.aborted) throw new Error('aborted')
        return { kind: 'committed' as const, value: undefined }
      },
      updateQueue: async () => ({ kind: 'committed' as const, value: undefined }),
      cancel: async () => ({ kind: 'committed' as const, value: undefined }),
      rename: async (_sessionId: string, title: string) => ({ kind: 'committed' as const, value: { title } }),
      refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }),
    } as never,
    cwd: '/ws',
    sessionCwd: () => '/ws',
    fileStore: files,
    imageStore: images,
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: (text: string) => app.insertIntoEditor(text),
    prepareDraftMessage: async (text: string) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    prepareTransportMessage: async (line: string) => {
      prepareStarted()
      await prepareGate
      if (mode === 'prepare-error') throw new Error('prepare failed')
      return line as never
    },
    signal: abortController.signal,
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { target?: { id: string; header?: { cwd?: string } }; prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
      await steps.prepare?.()
      return { ok: true, next: await steps.create() }
    },
    currentPreset: () => undefined,
    pendingPreset: undefined,
    effectivePresetId: undefined,
    awaitPendingDefaultWrite: async () => {},
    trackDefaultWrite: () => {},
    get defaultIntentOutcome() { return undefined },
    setModelSelectionPending: () => {},
    reconcileDefaultIntent: () => {},
    sessionBlank: () => undefined,
    refreshStatus: () => {},
    progressUpdatesState: { mode: 'milestones' }, responseStyleState: { style: 'default' }, gitAttributionState: { mode: 'off' },
    focusEnabled: () => false,
    setFocusMode: () => {},
    setNotificationMode: () => {}, currentNotificationMode: () => 'unfocused', currentNotificationMethod: () => 'auto',
    setTerminalProgressMode: () => {}, setNotificationMethod: () => {},
    updateWelcomeCard: () => {},
    openJobView: () => {},
    openTasksBrowser: () => {}, createPluginManagerPage: () => undefined,
    openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withWriter: async <T>(_scope: unknown, task: () => T | Promise<T>) => {
      if (mode === 'superseded') throw new SessionScopeSupersededError()
      return task()
    },
    withPromptAdmission: async <T>(_agent: unknown, _line: string, task: () => T | Promise<T>): Promise<T> => {
      if (stale) return { kind: 'stale' } as T
      return task()
    },
    enterView: async () => {},
    requestExit: () => {},
    extensions: undefined,
    exit: () => {},
    beginClientWrite: () => owner.controller.beginClientWrite(),
    requestClientReload: createClientReloadCommandRequest({
      facts: {
        capable: () => true,
        ready: () => true,
        draftText: () => app.getDraft(),
        stagedImageCount: () => images.values().length,
        stagedFileCount: () => files.values().length,
        hasUnsettledUserWrite: () => owner.controller.hasUnsettledClientWrite(),
        hasUnsettledInteraction: () => false,
        hasUnsettledTransition: () => false,
      },
      request: () => {
        requests += 1
        return { kind: 'accepted' }
      },
    }),
  }
  registerTuiCommandsWithDirectSeams(runner)
  const skill = runner.clientCommands.get('skill')
  const reloadCommand = runner.clientCommands.get('reload-client')
  assert.ok(skill !== undefined, '/skill registered')
  assert.ok(reloadCommand !== undefined, '/reload-client registered')
  type Invocation = { commandId: string; rawInput: string; signal: AbortSignal }
  return {
    controller: owner.controller,
    app,
    runner,
    skillHandler: (invocation) => (skill.handler as unknown as (i: Invocation) => unknown)(invocation),
    reloadHandler: (invocation) => (reloadCommand.handler as unknown as (i: Invocation) => unknown)(invocation),
    picker: () => capturedPicker,
    prompts,
    get requests() { return requests },
    releasePrepare: () => { resolvePrepare() },
    rejectPrepare: (error) => { rejectPrepareGate(error) },
    abort: () => { abortController.abort() },
    disposeApp: () => {
      startedApps.delete(app)
      if (!app.isDisposed()) app.dispose()
    },
    drain: async () => {
      for (let index = 0; index < 300; index += 1) await Promise.resolve()
      await new Promise(resolve => setImmediate(resolve))
      for (let index = 0; index < 300; index += 1) await Promise.resolve()
    },
    reload: async () => {
      const result = await (reloadCommand.handler as unknown as (i: Invocation) => { kind: string; text?: string })({ commandId: 'cmd-reload', rawInput: '', signal: abortController.signal })
      return result
    },
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for the accepted-write lifetime')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('the skill picker selection holds the reload gate through LoadSkill preparation and releases at writer settlement', async () => {
  const harness = setup('held')
  const opened = await harness.skillHandler({ commandId: 'cmd-skill', rawInput: '', signal: harness.runner.signal })
  assert.deepEqual(opened, { kind: 'success' })
  const picker = harness.picker()
  assert.ok(picker !== undefined, 'the real /skill picker selection callback is captured')
  assert.equal(harness.app.getDraft(), '', 'editor empty before the selection')
  assert.equal(harness.controller.hasUnsettledClientWrite(), false, 'opening the picker is not an accepted write')

  picker('demo')
  await waitFor(() => harness.controller.hasUnsettledClientWrite())
  assert.equal(harness.prompts.length, 0, 'the writer is not reached before the held preparation')

  const refused = await harness.reload()
  assert.equal(refused.kind, 'error')
  assert.equal(refused.text, CLIENT_RELOAD_REFUSAL_NOTICES.submission)
  assert.equal(harness.requests, 0, 'the process request is never reached while the lifetime is open')

  harness.releasePrepare()
  await waitFor(() => harness.prompts.length === 1)
  await waitFor(() => !harness.controller.hasUnsettledClientWrite())
  assert.deepEqual(harness.prompts, [{ line: '/demo', mode: 'queue' }])

  const accepted = await harness.reload()
  assert.equal(accepted.kind, 'success')
  assert.equal(harness.requests, 1, 'the settled command allows the reload')
  assert.equal(harness.controller.hasUnsettledClientWrite(), false, 'the /reload-client control command does not count itself')
})

test('every skill terminal path releases the accepted-write lifetime', async () => {
  for (const mode of ['stale', 'superseded', 'prepare-error', 'prompt-error', 'abort'] as const) {
    const harness = setup(mode)
    const opened = await harness.skillHandler({ commandId: `cmd-skill-${mode}`, rawInput: '', signal: harness.runner.signal })
    assert.deepEqual(opened, { kind: 'success' }, `${mode}: picker opened`)
    const picker = harness.picker()
    assert.ok(picker !== undefined)
    if (mode === 'abort') harness.abort()
    picker('demo')
    if (mode === 'prepare-error') {
      harness.rejectPrepare(new Error('prepare failed'))
    } else {
      harness.releasePrepare()
    }
    await harness.drain()
    await waitFor(() => !harness.controller.hasUnsettledClientWrite())
    const accepted = await harness.reload()
    assert.equal(accepted.kind, 'success', `${mode}: no leaked lifetime`)
    assert.equal(harness.controller.hasUnsettledClientWrite(), false, `${mode}: released exactly once`)
    harness.disposeApp()
  }
})
