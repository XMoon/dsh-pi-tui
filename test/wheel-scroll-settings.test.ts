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
import test from 'node:test'
import { ToolCallId, MessageId } from '@deepseek-ai/dsh-llm'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder } from '../src/transcript.ts'
import { registerTuiCommands, type TuiCommandRunner, type TuiSettingsLike } from '../src/commands.ts'
import type { TuiSettingsDoc } from '../src/runtime/config-port.ts'
import { createDiag } from '../src/diag.ts'
import { DraftImageStore } from '../src/image/draft-store.ts'
import { TuiApp } from '../src/tui-app.ts'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import { VirtualTerminal } from './virtual-terminal.ts'
import { DirectCatalogPort } from '../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../src/runtime/direct/host-file-direct.ts'
import { WHEEL_SCROLL_LINE_VALUES, wheelScrollLinesOf } from '../src/wheel-scroll.ts'

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
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
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
  ctx.provide('settings', { describe: () => [{ ns: 'dsh-pi-tui', user: {} }] } as never)
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
    get liveAgent() { return undefined },
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
      search: async () => [],
      projectionBatch: async () => new Map(),
      measureContext: () => undefined,
      readExportData: async () => ({ kind: 'none' }),
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
      followup: () => {},
      steer: () => {},
      dequeue: () => {},
      cancel: () => {},
      rename: () => true,
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
    get sessionGeneration() { return 0 },
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { target?: { id: string; header?: { cwd?: string } }; prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
      await steps.prepare?.()
      return { ok: true, next: await steps.create() }
    },
    currentPreset: () => undefined,
    get pendingPreset() { return undefined },
    set pendingPreset(_id: string | undefined) {},
    get effectivePresetId() { return undefined },
    refreshCatalog: async () => ({ kind: 'failed', error: 'not wired in tests' }),
    recomposeBlank: async () => ({ kind: 'switched', preset: 'standard' }),
    refreshStatus: () => {},
    applyFooterSettings: () => {},
    focusEnabled: () => false,
    setFocusMode: () => {},
    setNotificationMode: () => {},
    setNotificationMethod: () => {},
    updateWelcomeCard: () => {},
    openJobView: () => {},
    openTasksBrowser: () => {},
    openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withSessionWriter: async <T>(_sessionId: string, task: () => T | Promise<T>) => task(),
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
      commandId: CommandId('cmd-wheel-test'),
      agent: undefined as never,
      rawInput: '',
      signal: new AbortController().signal,
    })
  }
  const view = async (): Promise<string> => {
    await vt.waitForRender()
    return vt.getViewport().join('\n')
  }
  return { vt, app, settings, run, view }
}

test('/settings lists the Mouse wheel lines row; missing and invalid persisted values fall back to 1', async () => {
  // Missing field (old settings file): the row reads 1.
  const t = setupSettings({})
  await t.run()
  await t.view()
  for (let i = 0; i < 12; i += 1) t.vt.sendInput('\x1b[B')
  const view = await t.view()
  assert.ok(view.includes('Mouse wheel lines'), `row missing:\n${view}`)
  const row = stripTerminalSequences(view).split('\n').find(line => line.includes('Mouse wheel lines'))
  assert.ok(row !== undefined && row.includes('1'),
    `missing persisted value must fall back to 1 (row: ${row}):\n${view}`)
  t.app.stop()

  // An invalid persisted value never renders outside the values list.
  const t2 = setupSettings({ wheelScrollLines: 'garbage' })
  await t2.run()
  await t2.view()
  for (let i = 0; i < 10; i += 1) t2.vt.sendInput('\x1b[B')
  const view2 = await t2.view()
  assert.ok(stripTerminalSequences(view2).split('\n').some(line => line.includes('Mouse wheel lines') && line.includes('1')),
    `invalid persisted value must fall back to 1:\n${view2}`)
  assert.ok(!view2.includes('garbage'), `the raw invalid value must never render:\n${view2}`)
  t2.app.stop()

  // A persisted 8 renders as 8.
  const t3 = setupSettings({ wheelScrollLines: '8' })
  await t3.run()
  await t3.view()
  for (let i = 0; i < 10; i += 1) t3.vt.sendInput('\x1b[B')
  const view3 = await t3.view()
  assert.ok(stripTerminalSequences(view3).split('\n').some(line => line.includes('Mouse wheel lines') && line.includes('8')),
    `persisted 8 must render on the row:\n${view3}`)
  t3.app.stop()
})

test('the Mouse wheel lines row toggle persists without dropping other fields', async () => {
  const t = setupSettings({ wheelScrollLines: '1' })
  await t.run()
  await t.view()
  for (let i = 0; i < 12; i += 1) t.vt.sendInput('\x1b[B') // move to the wheel row
  await t.view()
  t.vt.sendInput('\r') // toggle 1 -> 2
  await t.view()
  assert.ok(t.settings.writes.length >= 1, 'the toggle must persist a write')
  const last = t.settings.writes[t.settings.writes.length - 1]
  assert.equal(last?.wheelScrollLines, '2', `wrote: ${JSON.stringify(last)}`)
  // A replace is wholesale: every other field rides along untouched.
  assert.equal(last?.theme, 'auto')
  assert.equal(last?.footer, 'full')
  assert.equal(last?.fullscreen, 'on')
  assert.equal(last?.focusMode, 'off')
  t.app.stop()
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
