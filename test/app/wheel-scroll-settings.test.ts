/**
 * Mouse-wheel step preference tests: the pure parsing helper
 * (wheelScrollLinesOf), the /settings row (values, fallback, whole-doc
 * persistence), and the TuiApp wiring (the preference reaches the
 * TuiAltScreen constructor — one wheel event scrolls the configured
 * number of lines; a change while fullscreen is active applies on the
 * NEXT re-entry, v1 semantics).
 * @module @xmoon76/dsh-pi-tui/wheel-scroll-settings.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { afterEach, test } from 'node:test'
import { ToolCallId, MessageId } from '@deepseek-ai/dsh-llm'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder } from '../../src/transcript.ts'
import { registerTuiCommands, type TuiCommandRunner, type TuiSettingsLike } from '../../src/commands.ts'
import type { TuiSettingsDoc } from '../../src/runtime/config-port.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { sessionScopeFacts } from '../support/session-scope-facts.ts'
import { DirectCatalogPort } from '../../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../../src/runtime/direct/host-file-direct.ts'
import { WHEEL_SCROLL_LINE_VALUES, wheelScrollLinesOf } from '../../src/domain/display/wheel-scroll.ts'
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

// ── the pure parsing helper ──────────────────────────────────────────────

test('wheelScrollLinesOf: missing and invalid values fall back to 1', () => {
  assert.equal(wheelScrollLinesOf(undefined), 1)
  assert.equal(wheelScrollLinesOf(''), 1)
  assert.equal(wheelScrollLinesOf('0'), 1)
  assert.equal(wheelScrollLinesOf('4'), 1)
  assert.equal(wheelScrollLinesOf('9'), 1)
  assert.equal(wheelScrollLinesOf('garbage'), 1)
  assert.equal(wheelScrollLinesOf('ON'), 1)
})

test('wheelScrollLinesOf: the accepted values pass through', () => {
  assert.equal(wheelScrollLinesOf('1'), 1)
  assert.equal(wheelScrollLinesOf('2'), 2)
  assert.equal(wheelScrollLinesOf('3'), 3)
  assert.equal(wheelScrollLinesOf('5'), 5)
  assert.equal(wheelScrollLinesOf('8'), 8)
})

test('WHEEL_SCROLL_LINE_VALUES lists exactly the accepted steps in display order', () => {
  assert.deepEqual([...WHEEL_SCROLL_LINE_VALUES], ['1', '2', '3', '5', '8'])
})

// ── the /settings row ───────────────────────────────────────────────────

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

/** Register the TUI commands with a stubbed runner and return /settings. */
function setupSettings(options: { wheelScrollLines?: string } = {}) {
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
  // The fake document starts from the FULL default shape. When no
  // wheelScrollLines is passed, the field is OMITTED entirely — the exact
  // shape of an old settings file written before the preference existed.
  const settings = fakeSettings({
    theme: 'auto',
    footer: 'full',
    fullscreen: 'on',
    busyEnter: 'queue',
    localShellSandbox: 'bypass',
    homeEndKeys: 'viewport',
    focusMode: 'off',
    ...(options.wheelScrollLines === undefined ? {} : { wheelScrollLines: options.wheelScrollLines }),
  })
  const runner: TuiCommandRunner = {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
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
    get defaultIntentOutcome() { return undefined },
    setModelSelectionPending: () => {},
    reconcileDefaultIntent: () => {},
    sessionBlank: () => undefined,
    refreshStatus: () => {},
    applyFooterSettings: () => {},
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
    withWriter: async <T>(_scope: unknown, task: () => T | Promise<T>) => task(),
    withPromptAdmission: async <T>(_agent: unknown, _line: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {},
    requestExit: () => {},
    // The minimal REAL extension registries: these cases exercise the static
    // Mouse wheel lines row, not extension contributions.
    extensions: { themes: new ThemeRegistry(), settings: new SettingsRegistry() } as never,
    exit: () => {},
  }
  registerTuiCommandsWithDirectSeams(runner)
  // The production surface runtime applies the persisted NEXT-mount step at
  // startup (`settings-runtime.ts`), so the live fact is not a blank default.
  app.setWheelScrollLines(wheelScrollLinesOf(options.wheelScrollLines))
  const def = defs.find(entry => entry.name === 'settings')
  assert.ok(def?.handler !== undefined, 'settings handler missing')
  const invoke = (): unknown => (def!.handler as (inv: { commandId: string; agent: never; rawInput: string; signal: AbortSignal }) => unknown)({
    commandId: CommandId('cmd-wheel-test'),
    agent: undefined as never,
    rawInput: '',
    signal: new AbortController().signal,
  })
  const view = async (): Promise<string> => {
    await vt.waitForRender()
    return stripTerminalSequences(vt.getViewport().join('\n'))
  }
  return { vt, app, settings, invoke, view }
}

test('the Input & Terminal Mouse wheel row separates the NEXT-mount step from the persisted raw value', async () => {
  for (const entry of [
    { stored: undefined, runtime: '1', persisted: 'not set', note: 'missing' },
    { stored: 'garbage', runtime: '1', persisted: 'garbage', note: 'invalid' },
    { stored: '8', runtime: '8', persisted: '8', note: 'persisted 8' },
  ] as const) {
    const t = setupSettings(entry.stored === undefined ? {} : { wheelScrollLines: entry.stored })
    try {
      await openSettingsRows(t.vt, () => t.invoke(), 'Input & Terminal')
      await selectSettingsRow(t.vt, 'Mouse wheel lines')
      const rows = await t.view()
      const row = paintedSelectedRowCell(t.vt) ?? ''
      assert.ok(row.includes(`${entry.runtime} (next fullscreen`),
        `the ${entry.note} row states the NEXT-mount step:\n${rows}`)
      assert.ok(!row.includes('garbage'), `the row never paints an invalid raw value:\n${rows}`)
      t.vt.sendInput('\t')
      const detail = await t.view()
      assert.match(detail, new RegExp(`Value\\s+${entry.runtime} \\(next fullscreen entry\\)`, 'u'),
        `the live fact is the next-mount step (${entry.note}):\n${detail}`)
      assert.match(detail, new RegExp(`Persisted\\s+${entry.persisted}`, 'u'),
        `the persisted raw fact stays separate (${entry.note}):\n${detail}`)
    } finally {
      if (!t.app.isDisposed()) t.app.dispose()
    }
  }
})

test('an explicit Mouse wheel Confirm updates the NEXT mount and merges the document', async () => {
  const t = setupSettings({ wheelScrollLines: '1' })
  try {
    await openSettingsRows(t.vt, () => t.invoke(), 'Input & Terminal')
    await selectSettingsRow(t.vt, 'Mouse wheel lines')
    await confirmSettingsChoice(t.vt, '2', () => t.settings.writes.length > 0)
    assert.equal(t.app.currentWheelScrollLines(), 2, 'the NEXT fullscreen mount step changed')
    assert.equal(t.settings.writes.length, 1, 'one explicit Confirm dispatches exactly one write')
    const written = t.settings.writes[0]!
    assert.equal(written.wheelScrollLines, '2')
    assert.equal(written.theme, 'auto', 'the whole-document replace preserves the other fields')
    assert.equal(written.footer, 'full')
    assert.equal(written.fullscreen, 'on')
    assert.equal(written.focusMode, 'off')
  } finally {
    if (!t.app.isDisposed()) t.app.dispose()
  }
})

// ── the TuiApp wiring (the preference reaches the alt screen) ────────────

const T0 = Date.now() - 60_000

function eventAt(type: string, data: Record<string, unknown>, time: number, seq: number): SessionEvent {
  return { type, seq, time, data } as SessionEvent
}

function completedTurn(turn: number, baseSeq: number, startTime: number): SessionEvent[] {
  return [
    eventAt('turn/start', { turn }, startTime, baseSeq),
    eventAt('user/message', {
      id: MessageId(`u${turn}`), role: 'user',
      content: [{ type: 'text', text: `prompt ${turn}` }],
      source: { kind: 'user' },
    }, startTime + 1, baseSeq + 1),
    eventAt('assistant/message', {
      turn, step: 1,
      message: { id: MessageId(`a${turn}`), role: 'assistant', content: [{ type: 'text', text: `answer ${turn}` }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, startTime + 2, baseSeq + 2),
    eventAt('turn/end', { turn, reason: { kind: 'completed' } }, startTime + 3, baseSeq + 3),
  ]
}

function longTranscript(): TranscriptFolder {
  const folder = new TranscriptFolder()
  for (let turn = 0; turn < 25; turn += 1) {
    folder.apply(completedTurn(turn, turn * 10, T0 + turn * 1000))
  }
  return folder
}

test('the default wheel step is 1: one wheel event scrolls one line', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  app.setTranscript(longTranscript().messages(), longTranscript().turnActivities())
  app.setFullscreen(true)
  await vt.waitForRender()
  const bottom = app.fullscreenScrollForTest()
  assert.ok(bottom !== undefined && bottom.maxScrollTop > 0, 'precondition: scrollable transcript')
  vt.sendInput('\x1b[<64;50;10M') // wheel up over the transcript pane
  await vt.waitForRender()
  const after = app.fullscreenScrollForTest()
  assert.equal(after?.scrollTop, bottom.maxScrollTop - 1, 'default wheel step is exactly 1 line')
  app.setFullscreen(false)
  app.stop()
})

test('setWheelScrollLines reaches the NEXT alt-screen mount (one wheel event scrolls N lines)', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  app.setTranscript(longTranscript().messages(), longTranscript().turnActivities())
  app.setWheelScrollLines(3)
  app.setFullscreen(true)
  await vt.waitForRender()
  const bottom = app.fullscreenScrollForTest()
  assert.ok(bottom !== undefined && bottom.maxScrollTop > 0, 'precondition: scrollable transcript')
  vt.sendInput('\x1b[<64;50;10M')
  await vt.waitForRender()
  const after = app.fullscreenScrollForTest()
  assert.equal(after?.scrollTop, bottom.maxScrollTop - 3, 'one wheel event with step 3 scrolls 3 lines')
  app.setFullscreen(false)
  app.stop()
})

test('a change while fullscreen is ACTIVE applies on the next re-entry (v1 semantics)', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  app.setTranscript(longTranscript().messages(), longTranscript().turnActivities())
  app.setFullscreen(true)
  await vt.waitForRender()
  // Change the preference while the alt screen is live: the CURRENT
  // instance keeps its constructor-time step (1)…
  app.setWheelScrollLines(8)
  const bottom = app.fullscreenScrollForTest()
  vt.sendInput('\x1b[<64;50;10M')
  await vt.waitForRender()
  const after = app.fullscreenScrollForTest()
  assert.equal(after?.scrollTop, bottom!.maxScrollTop - 1,
    'the live alt screen keeps its constructor-time step (no immediate effect)')
  // …and the NEXT fullscreen mount uses the new step.
  app.setFullscreen(false)
  app.setFullscreen(true)
  await vt.waitForRender()
  const bottom2 = app.fullscreenScrollForTest()
  vt.sendInput('\x1b[<64;50;10M')
  await vt.waitForRender()
  const after2 = app.fullscreenScrollForTest()
  assert.equal(after2?.scrollTop, bottom2!.maxScrollTop - 8, 'the re-entered alt screen uses the new step')
  app.setFullscreen(false)
  app.stop()
})

test('setWheelScrollLines normalizes defensively', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  app.setTranscript(longTranscript().messages(), longTranscript().turnActivities())
  app.setWheelScrollLines(0)
  app.setWheelScrollLines(-5)
  app.setWheelScrollLines(2.9)
  app.setFullscreen(true)
  await vt.waitForRender()
  const bottom = app.fullscreenScrollForTest()
  vt.sendInput('\x1b[<64;50;10M')
  await vt.waitForRender()
  const after = app.fullscreenScrollForTest()
  assert.equal(after?.scrollTop, bottom!.maxScrollTop - 2, '0/-5 clamp to 1, 2.9 floors to 2')
  app.setFullscreen(false)
  app.stop()
})
