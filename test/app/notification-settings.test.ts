/**
 * Notification and communication-policy /settings integration tests: live
 * policy changes, defaults, and whole-document persistence through the shared
 * runner fixture. Pure — no dsh tree needed.
 * @module @xmoon76/dsh-pi-tui/notification-settings.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { TuiSettingsDoc } from '../../src/runtime/config-port.ts'
import { registerTuiCommands, type TuiCommandRunner, type TuiSettingsLike } from '../../src/commands.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { sessionScopeFacts } from '../support/session-scope-facts.ts'
import { DirectCatalogPort } from '../../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../../src/runtime/direct/host-file-direct.ts'
import { parseNotificationMethod, parseNotificationMode } from '../../src/domain/notification/settings.ts'
import { parseProgressUpdates, parseResponseStyle, type ProgressUpdatesState, type ResponseStyleState } from '../../src/domain/communication/policy.ts'
import { installProgressUpdatesPrompt, installResponseStylePrompt, installFocusPrompt, type SystemPromptLike } from '../../src/app/direct/system-prompt.ts'
import type { DisplayState } from '../../src/domain/display/preset.ts'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'
import { confirmSettingsChoice, openSettingsRows, paintedSelectedRowCell, selectSettingsRow } from '../support/settings-workspace-navigation.ts'
import { SettingsRegistry } from '../../src/extension/internal/settings-registry.ts'
import { ThemeRegistry } from '../../src/extension/internal/theme-registry.ts'

/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test — the process slot (the vendored fork
 * keybindings are process-global) is released only by the FINAL dispose,
 * never by stop() (see src/tui/process-slot.ts). */
const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})


/** A fake TuiSettingsLike recording every replace. */
function fakeSettings(doc: Record<string, unknown>) {
  const writes: Array<Record<string, unknown>> = []
  return {
    writes,
    value: {
      get: () => ({ ...doc }) as unknown as TuiSettingsLike['get'] extends () => infer R ? R : never,
      replace: (next: TuiSettingsDoc) => {
        writes.push({ ...next })
        Object.assign(doc, next)
        return undefined as unknown
      },
    },
  }
}

/** Register the TUI commands with a stubbed runner and return /settings
 * plus the recorded runtime notification setter calls. */
function setupSettings(options: { notificationMode?: string; notificationMethod?: string; progressUpdates?: string; responseStyle?: string; failWrite?: boolean } = {}) {
  const ctx = new Context()
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    // The REAL owned-task entry a Settings write runs through.
    runOwned: (_label, task, runOptions) => {
      void Promise.resolve()
        .then(() => task())
        .then(
          result => runOptions.onResult?.(result),
          error => runOptions.onError?.(error),
        )
    },
  })
  app.start()
  startedApps.add(app)
  const defs: { name: string; handler?: unknown }[] = []
  ctx.provide('commands', {
    register: (def: { name: string; handler?: unknown }): (() => void) => {
      defs.push(def)
      return () => {}
    },
    list: () => [],
    find: () => undefined,
    execute: async () => undefined,
  } as never)
  ctx.provide('settings', { describe: () => [{ ns: 'tui-app', user: {} }] } as never)
  const settings = fakeSettings({
    theme: 'auto',
    footer: 'full',
    fullscreen: 'on',
    busyEnter: 'queue',
    localShellSandbox: 'bypass',
    homeEndKeys: 'viewport',
    focusMode: 'off',
    displayPreset: 'full',
    progressUpdates: options.progressUpdates,
    responseStyle: options.responseStyle,
    keybindings: { 'app.transcript.toggle': ['ctrl+o'] },
    customExtension: { enabled: true },
    ...(options.notificationMode === undefined ? {} : { notificationMode: options.notificationMode }),
    ...(options.notificationMethod === undefined ? {} : { notificationMethod: options.notificationMethod }),
  })
  if (options.failWrite) settings.value.replace = () => { throw new Error('settings unavailable') }
  const progressUpdatesState: ProgressUpdatesState = { mode: parseProgressUpdates(settings.value.get().progressUpdates) }
  const responseStyleState: ResponseStyleState = { style: parseResponseStyle(settings.value.get().responseStyle) }
  const displayState: DisplayState = { preset: 'full' }
  const sections = new Map<string, Parameters<SystemPromptLike['section']>[0]>()
  const systemPrompt: SystemPromptLike = {
    section: section => { sections.set(section.name, section); return () => { sections.delete(section.name) } },
  }
  installProgressUpdatesPrompt(systemPrompt, displayState, progressUpdatesState)
  installResponseStylePrompt(systemPrompt, responseStyleState)
  installFocusPrompt(systemPrompt, displayState)
  const prompt = (name = 'tui:progress-updates'): string => {
    const text = sections.get(name)!.text
    return typeof text === 'function' ? text({}) : text
  }
  const appliedModes: string[] = []
  const appliedMethods: string[] = []
  // The ONE completion controller's live facts: a setter really changes what
  // the foreground read reports (the fixture never claims a call it did not get).
  let liveMode = parseNotificationMode(settings.value.get().notificationMode)
  let liveMethod = parseNotificationMethod(settings.value.get().notificationMethod)
  const runner: TuiCommandRunner = {
    deliveredFilesSnapshot: () => undefined,
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    get defaultIntentOutcome() { return undefined },
    ...sessionScopeFacts(() => undefined, () => 0),
    currentSessionId: undefined,
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    defaultSelection: () => undefined,
    defaultIntent: undefined,
    setDefaultIntent: () => {},
    defaultIntentRecord: undefined,
    settleIntent: () => {},
    tuiSettings: settings.value,
    agents: {} as never,
    sessionReader: {
      list: async () => [],
      search: async () => ({ items: [], hasMore: false }),
      projectionBatch: async () => new Map(), blank: () => undefined, measureContext: () => undefined,
      turnOutline: () => undefined,
      sessionStatus: () => undefined,
    },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    commandRegistry: ctx.get('commands') as import('../../src/commands.ts').CommandRegistryLike | undefined,
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
    },
    sessionWriter: {
      prompt: async () => ({ kind: 'committed' as const, value: undefined }),
      updateQueue: async () => ({ kind: 'committed' as const, value: undefined }),
      cancel: async () => ({ kind: 'committed' as const, value: undefined }),
      rename: async (_sessionId: string, title: string) => ({ kind: 'committed' as const, value: { title } }),
      refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }),
    },
    cwd: '/ws',
    sessionCwd: () => '/ws',
    imageStore: new DraftImageStore(),
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { target?: { id: string; header?: { cwd?: string } }; prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
      await steps.prepare?.()
      return { ok: true, next: await steps.create() }
    },
    currentPreset: () => undefined,
    get pendingPreset() { return undefined },
    set pendingPreset(_id: string | undefined) {},
    get effectivePresetId() { return undefined },
    awaitPendingDefaultWrite: async () => {},
    trackDefaultWrite: () => {},
    setModelSelectionPending: () => {},
    reconcileDefaultIntent: () => {},
    sessionBlank: () => undefined,
    refreshStatus: () => {},
    applyFooterSettings: () => {},
    progressUpdatesState,
    responseStyleState,
    gitAttributionState: { mode: 'off' },
    displayPreset: () => displayState.preset,
    setDisplayPreset: preset => { displayState.preset = preset; return { kind: 'applied', preset } },
    focusEnabled: () => displayState.preset === 'focus',
    setFocusMode: () => {},
    setNotificationMode: (mode) => { appliedModes.push(mode); liveMode = parseNotificationMode(mode) },
    currentNotificationMode: () => liveMode,
    currentNotificationMethod: () => liveMethod,
    setTerminalProgressMode: () => {}, setNotificationMethod: (method) => { appliedMethods.push(method); liveMethod = parseNotificationMethod(method) },
    updateWelcomeCard: () => {},
    openJobView: () => {},
    openTasksBrowser: () => {}, createPluginManagerPage: () => undefined,
    openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withWriter: async <T>(_scope: unknown, task: () => T | Promise<T>) => task(),
    withPromptAdmission: async <T>(_agent: unknown, _line: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {},
    requestExit: () => {},
    // The minimal REAL extension registries: these cases exercise the static
    // notification rows, not extension contributions.
    extensions: { themes: new ThemeRegistry(), settings: new SettingsRegistry() } as never,
    exit: () => {},
  }
  registerTuiCommandsWithDirectSeams(runner)
  const def = defs.find(entry => entry.name === 'settings')
  assert.ok(def?.handler !== undefined, 'settings handler missing')
  const invoke = (): unknown => (def!.handler as (inv: { commandId: string; agent: never; rawInput: string; signal: AbortSignal }) => unknown)({
    commandId: 'x' as never,
    agent: undefined as never,
    rawInput: '',
    signal: new AbortController().signal,
  })
  const view = async (): Promise<string> => {
    await vt.waitForRender()
    return stripTerminalSequences(vt.getViewport().join('\n'))
  }
  return { vt, app, settings, runner, appliedModes, appliedMethods, invoke, view, prompt, sections }
}

test('the two Input & Terminal notification rows keep live facts and the persisted raw value apart', async () => {
  // Missing fields (old document): the live defaults are Unfocused / Auto and
  // the persisted facts say `not set`.
  for (const entry of [
    { mode: undefined, method: undefined, persistedMode: 'not set', persistedMethod: 'not set' },
    { mode: 'garbage', method: 'garbage', persistedMode: 'garbage', persistedMethod: 'garbage' },
  ] as const) {
    const t = setupSettings(entry.mode === undefined ? {} : { notificationMode: entry.mode, notificationMethod: entry.method })
    try {
      await openSettingsRows(t.vt, () => t.invoke(), 'Input & Terminal')
      await selectSettingsRow(t.vt, 'Notifications')
      t.vt.sendInput('\t')
      let detail = await t.view()
      assert.match(detail, /Value\s+unfocused/u, `the live mode is the default:\n${detail}`)
      assert.match(detail, new RegExp(`Persisted\\s+${entry.persistedMode}`, 'u'),
        `the persisted mode fact stays separate:\n${detail}`)
      // The next row in the SAME Rows level.
      t.vt.sendInput('\u001b[Z') // Detail -> Rows
      t.vt.sendInput('\u001b[B') // Notification method
      t.vt.sendInput('\t')
      detail = await t.view()
      assert.match(detail, /Value\s+auto/u, `the live method is the default:\n${detail}`)
      assert.match(detail, new RegExp(`Persisted\\s+${entry.persistedMethod}`, 'u'),
        `the persisted method fact stays separate:\n${detail}`)
    } finally {
      if (!t.app.isDisposed()) t.app.dispose()
    }
  }
})

test('explicit Confirms move both notification axes through the ONE controller and merge the document', async () => {
  const t = setupSettings({ notificationMode: 'unfocused', notificationMethod: 'auto', progressUpdates: 'milestones' })
  try {
    await openSettingsRows(t.vt, () => t.invoke(), 'Input & Terminal')
    await selectSettingsRow(t.vt, 'Notifications')
    await confirmSettingsChoice(t.vt, 'always', () => t.settings.writes.length > 0)
    assert.deepEqual(t.appliedModes, ['always'], 'the ONE completion controller received the mode exactly once')
    assert.equal(t.settings.writes[0]?.notificationMode, 'always')
    assert.equal(t.settings.writes[0]?.notificationMethod, 'auto', 'the mode write leaves the method axis unchanged')
    assert.equal(t.settings.writes[0]?.progressUpdates, 'milestones', 'the narration cadence rides along untouched')
    assert.deepEqual(t.settings.writes[0]?.customExtension, { enabled: true }, 'unknown document fields ride verbatim')
    assert.equal(t.settings.writes[0]?.displayPreset, 'full', 'the Display preset is untouched')

    t.vt.sendInput('\u001b') // settled Detail -> Rows
    await t.view()
    await selectSettingsRow(t.vt, 'Notification method')
    await confirmSettingsChoice(t.vt, 'osc9', () => t.settings.writes.length > 1)
    assert.deepEqual(t.appliedMethods, ['osc9'], 'the SAME controller received the method exactly once')
    assert.equal(t.settings.writes.at(-1)?.notificationMethod, 'osc9')
    assert.equal(t.settings.writes.at(-1)?.notificationMode, 'always', 'the method write keeps the mode')
    assert.equal(t.settings.writes.at(-1)?.progressUpdates, 'milestones')

    // Reopening the workspace reads the SAME live controller facts.
    t.vt.sendInput('\u001b') // Detail -> Rows
    t.vt.sendInput('\u001b') // Rows -> Categories
    t.vt.sendInput('\u001b') // Categories -> close
    await t.view()
    await openSettingsRows(t.vt, () => t.invoke(), 'Input & Terminal')
    await selectSettingsRow(t.vt, 'Notifications')
    const rows = await t.view()
    const modeRow = paintedSelectedRowCell(t.vt) ?? ''
    assert.ok(modeRow.includes('always'), `the reopened row reads the live mode:\n${rows}`)
  } finally {
    if (!t.app.isDisposed()) t.app.dispose()
  }
})

test('a failed notification persistence keeps the applied mode and never claims Verified', async () => {
  const t = setupSettings({ notificationMode: 'unfocused', notificationMethod: 'auto', failWrite: true })
  try {
    await openSettingsRows(t.vt, () => t.invoke(), 'Input & Terminal')
    await selectSettingsRow(t.vt, 'Notifications')
    await confirmSettingsChoice(t.vt, 'always', async () => (await t.view()).includes('Not saved'))
    assert.deepEqual(t.appliedModes, ['always'], 'the apply-first controller received the mode before persistence')
    const detail = await t.view()
    assert.match(detail, /Not saved/u, `the refused write is reported:\n${detail}`)
    assert.doesNotMatch(detail, /Status\s+Verified/u, 'it is never Verified')
    assert.equal(t.settings.writes.length, 0, 'the refused persistence wrote nothing')
  } finally {
    if (!t.app.isDisposed()) t.app.dispose()
  }
})

test('the parsers are the single authority (defaults unfocused/auto)', () => {
  assert.equal(parseNotificationMode(undefined), 'unfocused')
  assert.equal(parseNotificationMode('always'), 'always')
  assert.equal(parseNotificationMode('garbage'), 'unfocused')
  assert.equal(parseNotificationMethod(undefined), 'auto')
  assert.equal(parseNotificationMethod('osc9'), 'osc9')
  assert.equal(parseNotificationMethod('beep'), 'auto')
})
