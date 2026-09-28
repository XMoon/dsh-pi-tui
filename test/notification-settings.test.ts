/**
 * Notification and communication-policy /settings integration tests: live
 * policy changes, defaults, and whole-document persistence through the shared
 * runner fixture. Pure — no dsh tree needed.
 * @module @xmoon76/dsh-pi-tui/notification-settings.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { TuiSettingsDoc } from '../src/runtime/config-port.ts'
import { registerTuiCommands, type TuiCommandRunner, type TuiSettingsLike } from '../src/commands.ts'
import { createDiag } from '../src/diag.ts'
import { DraftImageStore } from '../src/image/draft-store.ts'
import { TuiApp } from '../src/tui-app.ts'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import { VirtualTerminal } from './virtual-terminal.ts'
import { sessionScopeFacts } from './session-scope-facts.ts'
import { DirectCatalogPort } from '../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../src/runtime/direct/host-file-direct.ts'
import { parseNotificationMethod, parseNotificationMode } from '../src/notification/settings.ts'
import { installProgressUpdatesPrompt, installResponseStylePrompt, parseProgressUpdates, parseResponseStyle, type ProgressUpdatesState, type ResponseStyleState } from '../src/communication-policy.ts'
import { installFocusPrompt, type SystemPromptLike } from '../src/focus.ts'
import type { DisplayState } from '../src/display-preset.ts'

/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test — the process slot (the vendored fork
 * keybindings are process-global) is released only by the FINAL dispose,
 * never by stop() (see src/process-tui-slot.ts). */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
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
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
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
  installFocusPrompt({ get: () => systemPrompt } as never, displayState)
  const prompt = (name = 'tui:progress-updates'): string => {
    const text = sections.get(name)!.text
    return typeof text === 'function' ? text({}) : text
  }
  const appliedModes: string[] = []
  const appliedMethods: string[] = []
  const runner: TuiCommandRunner = {
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
    },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    commandRegistry: ctx.get('commands') as import('../src/commands.ts').CommandRegistryLike | undefined,
    hostFile: new DirectHostFilePort(() => undefined),
    interaction: {
      registerQuestionProvider: () => true,
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
    displayPreset: () => displayState.preset,
    setDisplayPreset: preset => { displayState.preset = preset; return { kind: 'applied', preset } },
    focusEnabled: () => displayState.preset === 'focus',
    setFocusMode: () => {},
    setNotificationMode: (mode) => { appliedModes.push(mode) },
    setNotificationMethod: (method) => { appliedMethods.push(method) },
    updateWelcomeCard: () => {},
    openJobView: () => {},
    openTasksBrowser: () => {}, openPluginManager: () => {}, createPluginManagerSubmenu: () => ({ render: () => [], invalidate: () => {} }),
    openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withWriter: async <T>(_scope: unknown, task: () => T | Promise<T>) => task(),
    withPromptAdmission: async <T>(_agent: unknown, _line: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {},
    requestExit: () => {},
    extensions: undefined,
    exit: () => {},
  }
  registerTuiCommands(runner)
  const def = defs.find(entry => entry.name === 'settings')
  assert.ok(def?.handler !== undefined, 'settings handler missing')
  const run = async (): Promise<void> => {
    await (def!.handler as (inv: { commandId: string; agent: never; rawInput: string; signal: AbortSignal }) => unknown)({
      commandId: 'x' as never,
      agent: undefined as never,
      rawInput: '',
      signal: new AbortController().signal,
    })
  }
  const view = async (): Promise<string> => {
    await vt.waitForRender()
    return vt.getViewport().join('\n')
  }
  return { vt, app, settings, runner, appliedModes, appliedMethods, run, view, prompt, sections }
}

test('the notification rows render with the defaults (Unfocused / Auto)', async () => {
  const t = setupSettings({})
  await t.run()
  await t.view()
  for (let i = 0; i < 12; i += 1) t.vt.sendInput('\x1b[B')
  const view = stripTerminalSequences(await t.view())
  const modeRow = view.split('\n').find(line => line.includes('Notifications'))
  const methodRow = view.split('\n').find(line => line.includes('Notification method'))
  // The panel shows the RAW persisted values (the codebase-wide settings
  // convention — wheel rows show literal step numbers, sandbox rows show
  // 'bypass'); the DESCRIPTION carries the user-facing explanation.
  assert.ok(modeRow !== undefined && modeRow.includes('unfocused'),
    `default mode row must show unfocused (row: ${modeRow}):\n${view}`)
  assert.ok(methodRow !== undefined && methodRow.includes('auto'),
    `default method row must show auto (row: ${methodRow}):\n${view}`)
  t.app.stop()
})

test('persisted values render on the rows; invalid values fall back to the defaults', async () => {
  // Persisted values render verbatim.
  const t = setupSettings({ notificationMode: 'always', notificationMethod: 'osc777' })
  await t.run()
  await t.view()
  for (let i = 0; i < 12; i += 1) t.vt.sendInput('\x1b[B')
  const view = stripTerminalSequences(await t.view())
  assert.ok(view.split('\n').some(line => line.includes('Notifications') && line.includes('always')),
    `persisted mode must render:\n${view}`)
  assert.ok(view.split('\n').some(line => line.includes('Notification method') && line.includes('osc777')),
    `persisted method must render:\n${view}`)
  t.app.dispose()
  // Invalid persisted values fall back to the defaults (never render raw).
  const t2 = setupSettings({ notificationMode: 'garbage', notificationMethod: 'beep' })
  await t2.run()
  await t2.view()
  for (let i = 0; i < 12; i += 1) t2.vt.sendInput('\x1b[B')
  const view2 = stripTerminalSequences(await t2.view())
  assert.ok(view2.split('\n').some(line => line.includes('Notifications') && line.includes('unfocused')),
    `invalid mode must fall back to unfocused:\n${view2}`)
  assert.ok(view2.split('\n').some(line => line.includes('Notification method') && line.includes('auto')),
    `invalid method must fall back to auto:\n${view2}`)
  assert.ok(!view2.includes('garbage') && !view2.includes('beep'),
    `the raw invalid values must never render:\n${view2}`)
  t2.app.stop()
})

test('cycling the mode row applies the runtime setter and persists the whole document', async () => {
  const t = setupSettings({ notificationMode: 'unfocused' })
  await t.run()
  await t.view()
  for (let i = 0; i < 11; i += 1) t.vt.sendInput('\x1b[B') // move to the mode row
  await t.view()
  t.vt.sendInput('\r') // cycle mode: unfocused -> always
  await t.view()
  assert.deepEqual(t.appliedModes, ['always'], 'the runtime setter must receive the chosen mode')
  assert.ok(t.settings.writes.length >= 1, 'the toggle must persist a write')
  const last = t.settings.writes[t.settings.writes.length - 1]
  assert.equal(last?.notificationMode, 'always', `wrote: ${JSON.stringify(last)}`)
  // A replace is wholesale: every other field rides along untouched.
  assert.equal(last?.theme, 'auto')
  assert.equal(last?.footer, 'full')
  assert.equal(last?.focusMode, 'off')
  t.app.stop()
})

test('cycling the method row applies the runtime setter and persists', async () => {
  const t = setupSettings({ notificationMode: 'unfocused', notificationMethod: 'auto' })
  await t.run()
  await t.view()
  for (let i = 0; i < 12; i += 1) t.vt.sendInput('\x1b[B') // move to the method row
  await t.view()
  t.vt.sendInput('\r') // cycle method: auto -> osc9
  await t.view()
  assert.deepEqual(t.appliedMethods, ['osc9'], 'the runtime setter must receive the chosen method')
  assert.ok(t.settings.writes.length >= 1, 'the toggle must persist a write')
  const last = t.settings.writes[t.settings.writes.length - 1]
  assert.equal(last?.notificationMethod, 'osc9', `wrote: ${JSON.stringify(last)}`)
  // The mode field rides along untouched.
  assert.equal(last?.notificationMode, 'unfocused')
  t.app.stop()
})

test('both communication rows cycle live, preserve Display and raw fields, and survive reopening', async () => {
  const t = setupSettings({ progressUpdates: 'off', responseStyle: 'concise' })
  await t.run()
  await t.view()
  for (let i = 0; i < 9; i += 1) t.vt.sendInput('\x1b[B')
  const initial = stripTerminalSequences(await t.view())
  assert.match(initial, /Progress updates\s+off/)
  assert.match(initial, /Response style\s+concise/)
  // Cycle the progress row: off -> milestones -> frequent.
  t.vt.sendInput('\r')
  await t.view()
  assert.equal(t.runner.progressUpdatesState.mode, 'milestones')
  assert.match(t.prompt(), /# Progress updates: Milestones/)
  t.vt.sendInput('\r')
  await t.view()
  assert.equal(t.runner.progressUpdatesState.mode, 'frequent')
  assert.equal(t.runner.responseStyleState.style, 'concise', 'progress changes never touch the response axis')
  assert.equal(t.runner.displayPreset!(), 'full')
  assert.equal(t.settings.value.get().progressUpdates, 'frequent')
  assert.equal(t.settings.value.get().responseStyle, 'concise')
  assert.equal(t.sections.size, 3, 'switching never re-registers prompt sections')
  assert.match(t.prompt(), /# Progress updates: Frequent/)
  assert.match(t.prompt('tui:response-style'), /# Response style: Concise/)
  // Cycle the response row (one below): concise -> explanatory -> default.
  t.vt.sendInput('\x1b[B')
  t.vt.sendInput('\r')
  await t.view()
  assert.equal(t.runner.responseStyleState.style, 'explanatory')
  assert.equal(t.runner.progressUpdatesState.mode, 'frequent', 'response changes never touch the progress axis')
  assert.match(t.prompt('tui:response-style'), /# Response style: Explanatory/)
  t.vt.sendInput('\r')
  await t.view()
  assert.equal(t.runner.responseStyleState.style, 'default')
  assert.equal(t.prompt('tui:response-style'), '')
  const last = t.settings.writes.at(-1)!
  assert.equal(last.progressUpdates, 'frequent')
  assert.equal(last.responseStyle, 'default')
  assert.equal(last.displayPreset, 'full')
  assert.deepEqual(last.keybindings, { 'app.transcript.toggle': ['ctrl+o'] })
  assert.deepEqual(last.customExtension, { enabled: true })
  t.vt.sendInput('\x1b')
  await t.view()
  await t.run()
  await t.view()
  for (let i = 0; i < 9; i += 1) t.vt.sendInput('\x1b[B')
  const reopened = stripTerminalSequences(await t.view())
  assert.match(reopened, /Progress updates\s+frequent/)
  assert.match(reopened, /Response style\s+default/)
})

test('communication changes apply before a failed persistence write and Display switches preserve them', async () => {
  const t = setupSettings({ progressUpdates: 'milestones', failWrite: true })
  const notifications: string[] = []
  t.app.notify = message => { notifications.push(message) }
  await t.run()
  await t.view()
  for (let i = 0; i < 9; i += 1) t.vt.sendInput('\x1b[B')
  t.vt.sendInput('\r')
  assert.equal(t.runner.progressUpdatesState.mode, 'frequent', 'runtime changes synchronously')
  assert.match(t.prompt(), /# Progress updates: Frequent/)
  await t.view()
  assert.ok(notifications.some(message => message.includes('settings unavailable')))
  assert.notEqual(t.settings.value.get().progressUpdates, 'frequent')
  // Display is the preceding row: full -> compact -> focus.
  t.vt.sendInput('\x1b[A')
  t.vt.sendInput('\r')
  t.vt.sendInput('\r')
  await t.view()
  assert.equal(t.runner.displayPreset!(), 'focus')
  assert.equal(t.runner.progressUpdatesState.mode, 'frequent', 'entering Focus never mutates the saved cadence')
  assert.equal(t.prompt(), '', 'Focus suppresses the effective progress section')
  assert.match(t.prompt('tui:focus-mode'), /# Focus mode/)
})

test('the parsers are the single authority (defaults unfocused/auto)', () => {
  assert.equal(parseNotificationMode(undefined), 'unfocused')
  assert.equal(parseNotificationMode('always'), 'always')
  assert.equal(parseNotificationMode('garbage'), 'unfocused')
  assert.equal(parseNotificationMethod(undefined), 'auto')
  assert.equal(parseNotificationMethod('osc9'), 'osc9')
  assert.equal(parseNotificationMethod('beep'), 'auto')
})
