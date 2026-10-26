/**
 * Terminal-progress /settings integration tests (plan §12.3/§12.13/§14.4): the
 * single parser authority, the row's default/invalid fallbacks, the immediate
 * runtime setter, and whole-document persistence through the shared runner
 * fixture. Pure — no dsh tree needed.
 * @module @xmoon76/dsh-pi-tui/terminal-progress-settings.test
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
import {
  DEFAULT_TERMINAL_PROGRESS_MODE,
  emitsOsc7501,
  emitsOsc94,
  parseTerminalProgressMode,
  type TerminalProgressMode,
} from '../../src/domain/terminal-progress/settings.ts'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'
import { confirmSettingsChoice, openSettingsRows, paintedSelectedRowCell, selectSettingsRow } from '../support/settings-workspace-navigation.ts'
import { SettingsRegistry } from '../../src/extension/internal/settings-registry.ts'
import { ThemeRegistry } from '../../src/extension/internal/theme-registry.ts'

/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test (the process slot is released by the FINAL
 * dispose, never by stop()). */
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

/** Register the TUI commands with a stubbed runner and return /settings plus
 * the recorded runtime terminal-progress setter calls. */
function setupSettings(options: { terminalProgress?: string; failWrite?: boolean } = {}) {
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
  }, { terminalProgressMode: parseTerminalProgressMode(options.terminalProgress) })
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
    progressUpdates: 'milestones',
    responseStyle: 'default',
    keybindings: { 'app.transcript.toggle': ['ctrl+o'] },
    customExtension: { enabled: true },
    ...(options.terminalProgress === undefined ? {} : { terminalProgress: options.terminalProgress }),
  })
  if (options.failWrite) settings.value.replace = () => { throw new Error('settings unavailable') }
  const appliedModes: string[] = []
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
      turnOutline: () => undefined, sessionStatus: () => undefined,
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
    progressUpdatesState: { mode: 'milestones' },
    responseStyleState: { style: 'default' },
    gitAttributionState: { mode: 'off' },
    displayPreset: () => 'full',
    setDisplayPreset: () => ({ kind: 'applied' as const, preset: 'full' }),
    focusEnabled: () => false,
    setFocusMode: () => {},
    setNotificationMode: () => {}, currentNotificationMode: () => 'unfocused', currentNotificationMethod: () => 'auto',
    setNotificationMethod: () => {},
    setTerminalProgressMode: (mode) => {
      appliedModes.push(mode)
      // The production SurfaceRuntime seam really applies the parsed mode to
      // the mounted surface.
      app.setTerminalProgressMode(parseTerminalProgressMode(mode))
    },
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
    // Terminal progress row, not extension contributions.
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
  return { vt, app, settings, invoke, view, appliedModes }
}

test('the parser is the single authority and fails safe to the dual-protocol default', () => {
  assert.equal(DEFAULT_TERMINAL_PROGRESS_MODE, '9;4+7501')
  assert.equal(parseTerminalProgressMode(undefined), '9;4+7501')
  assert.equal(parseTerminalProgressMode('9;4+7501'), '9;4+7501')
  assert.equal(parseTerminalProgressMode('9;4'), '9;4')
  assert.equal(parseTerminalProgressMode('7501'), '7501')
  assert.equal(parseTerminalProgressMode('off'), 'off')
  // The retired `on` value stays readable for older USER profiles and resolves
  // to the dual-protocol default; it is never offered as a UI value.
  assert.equal(parseTerminalProgressMode('on'), '9;4+7501')
  assert.equal(parseTerminalProgressMode('garbage'), '9;4+7501')
})

test('the two protocol predicates have a fixed truth table', () => {
  const expected: Record<TerminalProgressMode, { osc94: boolean; osc7501: boolean }> = {
    'off': { osc94: false, osc7501: false },
    '9;4': { osc94: true, osc7501: false },
    '7501': { osc94: false, osc7501: true },
    '9;4+7501': { osc94: true, osc7501: true },
  }
  for (const mode of Object.keys(expected) as TerminalProgressMode[]) {
    assert.equal(emitsOsc94(mode), expected[mode].osc94, `${mode} OSC 9;4`)
    assert.equal(emitsOsc7501(mode), expected[mode].osc7501, `${mode} OSC 7501`)
  }
})

test('the Input & Terminal Terminal progress row normalizes absent, invalid and retired persisted values', async () => {
  // Absent / invalid / the RETIRED `on` value: the live fact is the
  // dual-protocol default; only a legal raw value must survive as the
  // persisted fact, and `on` is READ-COMPAT ONLY (never a candidate/written).
  for (const entry of [
    { stored: undefined, persisted: 'not set', note: 'absent' },
    { stored: 'garbage', persisted: 'garbage', note: 'invalid' },
    { stored: 'on', persisted: 'on', note: 'retired on' },
  ] as const) {
    const t = setupSettings(entry.stored === undefined ? {} : { terminalProgress: entry.stored })
    try {
      await openSettingsRows(t.vt, () => t.invoke(), 'Input & Terminal')
      await selectSettingsRow(t.vt, 'Terminal progress')
      const rows = await t.view()
      const row = paintedSelectedRowCell(t.vt) ?? ''
      assert.ok(row.includes('9;4+7501'), `the ${entry.note} value renders the dual-protocol default:\n${rows}`)
      t.vt.sendInput('\t')
      const detail = await t.view()
      assert.match(detail, /Value\s+9;4\+7501/u, `the live fact is the normalized mode (${entry.note}):\n${detail}`)
      assert.match(detail, new RegExp(`Persisted\\s+${entry.persisted.replace(/\+/gu, '\\+')}`, 'u'),
        `the persisted raw fact stays separate (${entry.note}):\n${detail}`)
      if (entry.stored === 'on') {
        assert.doesNotMatch(detail, /> on\s+(?:\[current\]|unavailable)?/u,
          'the retired `on` value is never offered as a candidate nor marked current')
        assert.doesNotMatch(detail, /Current value is not in selectable choices/u,
          'the normalized runtime still owns a registered candidate')
      }
    } finally {
      if (!t.app.isDisposed()) t.app.dispose()
    }
  }
})

test('explicit Confirms walk the four Terminal progress modes and persist each one', async () => {
  const t = setupSettings({ terminalProgress: '9;4+7501' })
  try {
    await openSettingsRows(t.vt, () => t.invoke(), 'Input & Terminal')
    await selectSettingsRow(t.vt, 'Terminal progress')
    for (const mode of ['9;4', '7501', 'off'] as const) {
      await confirmSettingsChoice(t.vt, mode, () => t.settings.writes.some(write => write.terminalProgress === mode))
      assert.deepEqual(t.appliedModes.at(-1), mode, `the mounted surface received ${mode}`)
      assert.equal(t.app.currentTerminalProgressMode(), mode, `the app really applies ${mode}`)
      assert.equal(t.settings.writes.at(-1)?.terminalProgress, mode)
      assert.equal(t.settings.writes.at(-1)?.progressUpdates, 'milestones', 'the narration cadence is untouched')
      await t.view()
      t.vt.sendInput('\u001b') // settled Detail -> Rows
      await t.view()
    }
    // Reopening the workspace reads the SAME mounted mode, never an old cache.
    t.vt.sendInput('\u001b') // Rows -> Categories
    t.vt.sendInput('\u001b') // Categories -> close
    await t.view()
    await openSettingsRows(t.vt, () => t.invoke(), 'Input & Terminal')
    await selectSettingsRow(t.vt, 'Terminal progress')
    const rows = await t.view()
    const row = paintedSelectedRowCell(t.vt) ?? ''
    assert.ok(row.includes('off'), `the reopened row reads the mounted mode:\n${rows}`)
  } finally {
    if (!t.app.isDisposed()) t.app.dispose()
  }
})

test('a failed Terminal progress persistence keeps the mounted mode and reports Not saved', async () => {
  const t = setupSettings({ terminalProgress: '9;4+7501', failWrite: true })
  try {
    await openSettingsRows(t.vt, () => t.invoke(), 'Input & Terminal')
    await selectSettingsRow(t.vt, 'Terminal progress')
    await confirmSettingsChoice(t.vt, 'off', async () => (await t.view()).includes('Not saved'))
    assert.deepEqual(t.appliedModes, ['off'], 'the mounted surface received the mode before persistence')
    assert.equal(t.app.currentTerminalProgressMode(), 'off', 'the runtime change survives the refused write')
    const detail = await t.view()
    assert.match(detail, /Not saved/u, `the real refusal is on screen:\n${detail}`)
    assert.match(detail, /Value\s+off/u, 'the applied runtime fact is kept apart from persistence')
    assert.doesNotMatch(detail, /Status\s+Verified/u, 'a refused write is never Verified')
  } finally {
    if (!t.app.isDisposed()) t.app.dispose()
  }
})
