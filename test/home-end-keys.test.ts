/**
 * Issue #9 tests: the Home/End navigation preset (input vs viewport) and
 * its fullscreen behavior. The preset only remaps the alt screen's
 * top/bottom viewport bindings — the editor's own Home/End/Ctrl+Home/
 * Ctrl+End bindings are untouched (plan §4.3).
 * @module @xmoon76/dsh-pi-tui/home-end-keys.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from '@xmoon76/pi-tui'
import { applyHomeEndKeyMode, homeEndKeysModeOf } from '../src/home-end-keys.ts'
import { registerTuiCommands, type TuiCommandRunner, type TuiSettingsLike } from '../src/commands.ts'
import { createDiag } from '../src/diag.ts'
import { DraftImageStore } from '../src/image/draft-store.ts'
import { TranscriptFolder } from '../src/transcript.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { DirectCatalogPort } from '../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../src/runtime/direct/host-file-direct.ts'

/** The keybindings manager is a process-global singleton: every test
 * starts from a pristine manager so presets never leak across tests. */
function resetKeybindings(): void {
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS))
}

/** Whether the viewport contains the EXACT rendered line — `includes('line 1')`
 * would also match `line 10`..`line 19`, and the first transcript line
 * carries the bullet prefix (`🐋  line 1`), so the match is a trimmed
 * endsWith. */
function viewportHasLine(vt: VirtualTerminal, text: string): boolean {
  return vt.getViewport().some(line => line.trim().endsWith(text))
}

// ── the preset itself ────────────────────────────────────────────────────

test('applyHomeEndKeyMode viewport: top=home, bottom=end', () => {
  resetKeybindings()
  applyHomeEndKeyMode('viewport')
  const resolved = getKeybindings().getResolvedBindings()
  assert.equal(resolved['tui.altScreen.top'], 'home')
  assert.equal(resolved['tui.altScreen.bottom'], 'end')
})

test('applyHomeEndKeyMode input: top=ctrl+home, bottom=ctrl+end', () => {
  resetKeybindings()
  applyHomeEndKeyMode('input')
  const resolved = getKeybindings().getResolvedBindings()
  assert.equal(resolved['tui.altScreen.top'], 'ctrl+home')
  assert.equal(resolved['tui.altScreen.bottom'], 'ctrl+end')
})

test('applyHomeEndKeyMode keeps every other user binding', () => {
  resetKeybindings()
  getKeybindings().setUserBindings({ 'tui.altScreen.search': 'ctrl+f' })
  applyHomeEndKeyMode('input')
  const user = getKeybindings().getUserBindings()
  assert.equal(user['tui.altScreen.search'], 'ctrl+f', 'unrelated user bindings must survive')
  assert.equal(user['tui.altScreen.top'], 'ctrl+home')
  assert.equal(user['tui.altScreen.bottom'], 'ctrl+end')
})

test('homeEndKeysModeOf falls back to input for invalid values', () => {
  assert.equal(homeEndKeysModeOf('input'), 'input')
  assert.equal(homeEndKeysModeOf('viewport'), 'viewport')
  assert.equal(homeEndKeysModeOf(undefined), 'input')
  assert.equal(homeEndKeysModeOf(''), 'input')
  assert.equal(homeEndKeysModeOf('pi'), 'input')
})

// ── fullscreen behavior ─────────────────────────────────────────────────

test('fullscreen Ctrl+End remains a Host semantic action in both presets', async () => {
  for (const mode of ['viewport', 'input'] as const) {
    resetKeybindings()
    applyHomeEndKeyMode(mode)
    const vt = new VirtualTerminal(80, 24)
    let jumps = 0
    const app = new TuiApp(vt, {
      onSubmit: () => {},
      onExit: () => {},
      onTranscriptJumpLatest: () => {
        jumps += 1
        return true
      },
    })
    app.start()
    app.setTranscript([], undefined, { mode: 'history', endTurn: 1, firstTurn: 1, lastTurn: 1 })
    app.setFullscreen(true)
    await vt.waitForRender()
    vt.sendInput('\x1b[1;5F') // Ctrl+End
    await vt.waitForRender()
    assert.equal(jumps, 1, `Ctrl+End must dispatch to the Host in ${mode} mode`)
    app.stop()
  }
  resetKeybindings()
})

function startFullscreenApp(): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const folder = new TranscriptFolder()
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
  folder.apply([
    { type: 'assistant/message', seq: 0, time: 1_700_000_000_000, data: { turn: 0, step: 0, message: { id: MessageId('m1'), role: 'assistant', content: [{ type: 'text', text: lines.join('\n') }] } } } as SessionEvent,
  ])
  app.setTranscript(folder.messages())
  app.setFullscreen(true)
  return { vt, app }
}

test('registered older-boundary callback preserves history follow state', async () => {
  const vt = new VirtualTerminal(80, 24)
  const transcript = (lines: number) => [{
    kind: 'assistant' as const,
    turn: 0,
    text: Array.from({ length: lines }, (_, index) => `line ${index + 1}`).join('\n'),
  }]
  let app!: TuiApp
  let loadCount = 0
  const loadOlder = () => {
    loadCount += 1
    app.setTranscript(transcript(120), undefined, { mode: 'history', endTurn: 0, firstTurn: 0, lastTurn: 0 })
    app.scrollToBottom({ disableFollow: true })
    return true
  }
  app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {}, onTranscriptMoveOlder: loadOlder })
  app.start()
  app.setTranscript(transcript(80))
  app.setFullscreen(true)
  await vt.waitForRender()

  app.scrollToTop({ disableFollow: true })
  await vt.waitForRender()
  vt.sendInput('\x1b[57421u') // PageUp at the top invokes the registered older-boundary callback.
  await vt.waitForRender()
  assert.equal(loadCount, 1)
  const history = app.fullscreenScrollForTest()
  assert.ok(history !== undefined)
  assert.equal(history.isFollowingEnd, false, 'history positioning must suppress follow-end')
  const before = history.scrollTop

  app.setTranscript(transcript(160), undefined, { mode: 'history', endTurn: 0, firstTurn: 0, lastTurn: 0 })
  await vt.waitForRender()
  const after = app.fullscreenScrollForTest()
  assert.ok(after !== undefined)
  assert.equal(after.scrollTop, before, 'new history content must preserve the current viewport')
  assert.ok(after.scrollTop < after.maxScrollTop, 'new history content must not jump back to its end')
  app.stop()
})

test('history window paging preserves the overlap row across uneven heights', async () => {
  const vt = new VirtualTerminal(80, 24)
  const longMarkdown = ['turn-82', ...Array.from({ length: 80 }, (_, index) => `markdown row ${index + 1}`)].join('\n')
  const allMessages = Array.from({ length: 101 }, (_, turn) => ({
    kind: 'assistant' as const,
    turn,
    text: turn === 82 ? longMarkdown : `turn-${turn}`,
  }))
  const windowAt = (first: number, last: number) => allMessages.slice(first, last + 1)
  let app!: TuiApp
  const moveOlder = (): boolean => {
    const anchor = app.captureTranscriptViewportAnchor()
    app.setTranscript(windowAt(71, 90))
    return anchor !== undefined && app.restoreTranscriptViewportAnchor(anchor, 'top')
  }
  const moveNewer = (): boolean => {
    const anchor = app.captureTranscriptViewportAnchor()
    app.setTranscript(windowAt(81, 100))
    return anchor !== undefined && app.restoreTranscriptViewportAnchor(anchor, 'bottom')
  }
  app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onTranscriptMoveOlder: moveOlder,
    onTranscriptMoveNewer: moveNewer,
  })
  app.start()
  try {
    app.setTranscript(windowAt(81, 100))
    app.setFullscreen(true)
    await vt.waitForRender()
    app.scrollToTop({ disableFollow: true })
    await vt.waitForRender()
    assert.ok(viewportHasLine(vt, 'turn-81'), 'the initial top edge must show turn 81')

    assert.equal(moveOlder(), true, 'older paging must restore a captured anchor')
    await vt.waitForRender()
    const older = app.fullscreenScrollForTest()
    assert.ok(older !== undefined)
    assert.ok(older.scrollTop < older.maxScrollTop, 'older paging must not jump to the new window bottom')
    assert.ok(viewportHasLine(vt, 'turn-81'), 'older paging must keep the old top overlap row visible')
    assert.ok(!viewportHasLine(vt, 'turn-90'), 'the long turn 82 must not let bottom anchoring hide the old top')

    app.scrollToBottom({ disableFollow: true })
    await vt.waitForRender()
    assert.ok(viewportHasLine(vt, 'turn-90'), 'the older window bottom must show its bottom overlap row')
    assert.equal(moveNewer(), true, 'newer paging must restore a captured anchor')
    await vt.waitForRender()
    const newer = app.fullscreenScrollForTest()
    assert.ok(newer !== undefined)
    assert.ok(newer.scrollTop > 0, 'newer paging must not jump to the new window top')
    assert.ok(newer.scrollTop < newer.maxScrollTop, 'newer paging must preserve the overlap instead of following the end')
    assert.ok(viewportHasLine(vt, 'turn-90'), 'newer paging must keep the old bottom overlap row visible')
    assert.ok(!viewportHasLine(vt, 'turn-100'), 'newer paging must not skip past the preserved bottom overlap')
  } finally {
    app.stop()
  }
})

test('viewport mode: Home scrolls to the top, End to the bottom', async () => {
  resetKeybindings()
  applyHomeEndKeyMode('viewport')
  const { vt, app } = startFullscreenApp()
  await vt.waitForRender()
  // Default follow-end: the tail is visible, the head is not.
  assert.ok(viewportHasLine(vt, 'line 30'), 'the tail must be visible by default')
  assert.ok(!viewportHasLine(vt, 'line 1'), 'the head must be scrolled away by default')
  vt.sendInput('\x1bOH') // Home
  await vt.waitForRender()
  assert.ok(viewportHasLine(vt, 'line 1'), `Home must scroll the viewport to the top:\n${vt.getViewport().join('\n')}`)
  assert.ok(!viewportHasLine(vt, 'line 30'), 'the top view must not show the tail')
  vt.sendInput('\x1bOF') // End
  await vt.waitForRender()
  assert.ok(viewportHasLine(vt, 'line 30'), `End must scroll the viewport to the bottom:\n${vt.getViewport().join('\n')}`)
  assert.ok(!viewportHasLine(vt, 'line 1'), 'the bottom view must not show the head')
  app.stop()
})

test('input mode: Home/End stay in the editor; Ctrl+Home/End scroll the viewport', async () => {
  resetKeybindings()
  applyHomeEndKeyMode('input')
  const { vt, app } = startFullscreenApp()
  await vt.waitForRender()
  assert.ok(viewportHasLine(vt, 'line 30'), 'the tail must be visible by default')
  vt.sendInput('\x1bOH') // Home — must NOT scroll the viewport
  await vt.waitForRender()
  assert.ok(!viewportHasLine(vt, 'line 1'), `Home must not scroll the viewport in input mode:\n${vt.getViewport().join('\n')}`)
  assert.ok(viewportHasLine(vt, 'line 30'), 'the tail stays visible')
  vt.sendInput('\x1b[7^') // Ctrl+Home — scrolls to the top
  await vt.waitForRender()
  assert.ok(viewportHasLine(vt, 'line 1'), `Ctrl+Home must scroll the viewport to the top:\n${vt.getViewport().join('\n')}`)
  vt.sendInput('\x1b[8^') // Ctrl+End — scrolls to the bottom
  await vt.waitForRender()
  assert.ok(viewportHasLine(vt, 'line 30'), `Ctrl+End must scroll the viewport to the bottom:\n${vt.getViewport().join('\n')}`)
  app.stop()
})

test('a non-scrollable transcript lets Home/End reach the editor in both modes', async () => {
  for (const mode of ['input', 'viewport'] as const) {
    resetKeybindings()
    applyHomeEndKeyMode(mode)
    const vt = new VirtualTerminal(80, 24)
    const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
    app.start()
    const folder = new TranscriptFolder()
    folder.apply([
      { type: 'assistant/message', seq: 0, time: 1_700_000_000_000, data: { turn: 0, step: 0, message: { id: MessageId('m1'), role: 'assistant', content: [{ type: 'text', text: 'short' }] } } } as SessionEvent,
    ])
    app.setTranscript(folder.messages())
    app.setFullscreen(true)
    await vt.waitForRender()
    vt.sendInput('hello world')
    await vt.waitForRender()
    const before = vt.getCursorPosition()
    vt.sendInput('\x1bOH') // Home — the viewport cannot scroll, so the editor gets it
    await vt.waitForRender()
    const after = vt.getCursorPosition()
    assert.ok(after.x < before.x,
      `[${mode}] Home must move the editor cursor to the line start when the transcript cannot scroll (${JSON.stringify(before)} → ${JSON.stringify(after)})`)
    app.stop()
  }
})

test('regular mode: Home/End keep their editor behavior under both presets', async () => {
  for (const mode of ['input', 'viewport'] as const) {
    resetKeybindings()
    applyHomeEndKeyMode(mode)
    const vt = new VirtualTerminal(80, 24)
    const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
    app.start()
    await vt.waitForRender()
    vt.sendInput('hello world')
    await vt.waitForRender()
    const before = vt.getCursorPosition()
    vt.sendInput('\x1bOH') // Home
    await vt.waitForRender()
    const after = vt.getCursorPosition()
    assert.ok(after.x < before.x,
      `[${mode}] Home must move the editor cursor to the line start in regular mode (${JSON.stringify(before)} → ${JSON.stringify(after)})`)
    vt.sendInput('\x1bOF') // End
    await vt.waitForRender()
    const atEnd = vt.getCursorPosition()
    assert.ok(atEnd.x > after.x,
      `[${mode}] End must move the editor cursor to the line end in regular mode (${JSON.stringify(after)} → ${JSON.stringify(atEnd)})`)
    // Ctrl+Home / Ctrl+End keep their editor bindings in regular mode
    // under BOTH presets (the preset only remaps the alt screen).
    vt.sendInput('\x1b[7^') // Ctrl+Home
    await vt.waitForRender()
    const ctrlHome = vt.getCursorPosition()
    assert.ok(ctrlHome.x <= atEnd.x,
      `[${mode}] Ctrl+Home must move the editor cursor to the line start in regular mode (${JSON.stringify(atEnd)} → ${JSON.stringify(ctrlHome)})`)
    vt.sendInput('\x1b[8^') // Ctrl+End
    await vt.waitForRender()
    const ctrlEnd = vt.getCursorPosition()
    assert.ok(ctrlEnd.x >= ctrlHome.x,
      `[${mode}] Ctrl+End must move the editor cursor to the line end in regular mode (${JSON.stringify(ctrlHome)} → ${JSON.stringify(ctrlEnd)})`)
    app.stop()
  }
})

test('regular mode Ctrl+End declines the semantic latest action', async () => {
  resetKeybindings()
  let jumps = 0
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onTranscriptJumpLatest: () => {
      jumps += 1
      return true
    },
  })
  app.start()
  await vt.waitForRender()
  vt.sendInput('\x1b[1;5F')
  await vt.waitForRender()
  assert.equal(jumps, 0, 'regular Ctrl+End must not invoke the transcript latest action')
  app.stop()
})

// ── the /settings row ────────────────────────────────────────────────────

/** A fake tuiSettings document recording every replace write. */
function fakeTuiSettings(homeEndKeys: string): { value: TuiSettingsLike; writes: Array<Record<string, unknown>> } {
  const doc: Record<string, unknown> = {
    theme: 'auto', footer: 'full', fullscreen: 'on', busyEnter: 'queue', localShellSandbox: 'bypass', homeEndKeys,
  }
  const writes: Array<Record<string, unknown>> = []
  return {
    writes,
    value: {
      get: () => ({ ...doc }) as unknown as TuiSettingsLike['get'] extends () => infer R ? R : never,
      replace: (next) => {
        writes.push({ ...next })
        Object.assign(doc, next)
        return undefined as unknown
      },
    },
  }
}

/** Register the TUI commands with a stubbed runner and return /settings. */
function setupSettings(options: { homeEndKeys?: string } = {}) {
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
  const settings = fakeTuiSettings(options.homeEndKeys ?? 'input')
  const runner: TuiCommandRunner = {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    get liveAgent() { return undefined },
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    tuiSettings: settings.value,
    applyFooterSettings: () => {},
    agents: {} as never,
    sessionReader: {
      list: async () => [],
      search: async () => [],
      titles: async () => new Map(),
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
    focusEnabled: () => false,
    setFocusMode: () => {},
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
      commandId: CommandId('cmd-test-1'),
      agent: undefined as never,
      rawInput: '',
      signal: new AbortController().signal,
    })
  }
  const view = async (): Promise<string> => {
    await vt.waitForRender()
    return vt.getViewport().join('\n')
  }
  return { vt, app, run, view, settings }
}

test('/settings shows the Home/End keys row; an invalid persisted value falls back to input', async () => {
  resetKeybindings()
  const t = setupSettings({ homeEndKeys: 'garbage' })
  await t.run()
  await t.view()
  // Rows without a session: theme, icon-style, expand, thinking, footer,
  // busy-enter, local-shell-sandbox, home-end-keys, fullscreen,
  // separator, cwd — the home-end-keys row is the 8th, below the panel's
  // visible fold.
  for (let i = 0; i < 7; i += 1) t.vt.sendInput('\x1b[B')
  const view = await t.view()
  const row = view.split('\n').find(line => line.includes('Home/End keys')) ?? ''
  assert.ok(row !== '', `row missing:\n${view}`)
  // The row line carries only the label and the current value (the
  // description is a separate line), so the value can be matched on the
  // row itself.
  assert.ok(row.includes('input'), `an invalid persisted value must fall back to input:\n${view}`)
  assert.ok(!row.includes('viewport'), `an invalid persisted value must not fall back to viewport:\n${view}`)
  assert.ok(!view.includes('garbage'), `the raw invalid value must never render:\n${view}`)
  t.app.stop()
})

test('the Home/End keys row toggle applies the preset immediately and persists', async () => {
  resetKeybindings()
  const t = setupSettings({ homeEndKeys: 'viewport' })
  await t.run()
  await t.view()
  // Rows without a session: theme, icon-style, expand, thinking, footer,
  // busy-enter, local-shell-sandbox, home-end-keys, fullscreen, separator,
  // cwd — the home-end-keys row is the 8th.
  for (let i = 0; i < 7; i += 1) t.vt.sendInput('\x1b[B')
  t.vt.sendInput('\r') // toggle viewport -> input
  await t.view()
  const resolved = getKeybindings().getResolvedBindings()
  assert.equal(resolved['tui.altScreen.top'], 'ctrl+home', 'the preset must apply immediately')
  assert.equal(resolved['tui.altScreen.bottom'], 'ctrl+end')
  assert.ok(t.settings.writes.length >= 1, 'the toggle must persist a write')
  const last = t.settings.writes[t.settings.writes.length - 1]
  assert.equal(last?.homeEndKeys, 'input', `wrote: ${JSON.stringify(last)}`)
  t.app.stop()
})
