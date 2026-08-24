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

test('applyHomeEndKeyMode viewport: top=home, bottom=end (default behavior)', () => {
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

test('homeEndKeysModeOf falls back to viewport for invalid values', () => {
  assert.equal(homeEndKeysModeOf('input'), 'input')
  assert.equal(homeEndKeysModeOf('viewport'), 'viewport')
  assert.equal(homeEndKeysModeOf(undefined), 'viewport')
  assert.equal(homeEndKeysModeOf(''), 'viewport')
  assert.equal(homeEndKeysModeOf('pi'), 'viewport')
})

// ── fullscreen behavior ─────────────────────────────────────────────────

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

test('viewport mode (default): Home scrolls to the top, End to the bottom', async () => {
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
      get: () => ({ ...doc }) as TuiSettingsLike['get'] extends () => infer R ? R : never,
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
  const settings = fakeTuiSettings(options.homeEndKeys ?? 'viewport')
  const runner: TuiCommandRunner = {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    get liveAgent() { return undefined },
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    tuiSettings: settings.value,
    agents: {} as never,
    sessions: { flush: async () => {} },
    sessionReader: {
      list: async () => [],
      search: async () => [],
      titles: async () => new Map(),
    },
    host: {
      settings: () => ctx.get('settings'),
      llm: () => ctx.get('llm'),
      credentials: () => ctx.get('credentials'),
      authorization: () => ctx.get('authorization'),
      defaultModel: () => ctx.get('agentDefaultModel'),
      presets: () => ctx.get('agentPresets'),
      tools: () => ctx.get('tools'),
      permission: () => ctx.get('permissionPresets'),
      tokenMeter: () => ctx.get('tokenMeter'),
      commands: () => ctx.get('commands'),
      persistence: () => ctx.get('sessionPersistence'),
    },
    interaction: {
      registerQuestionProvider: () => true,
      onApprovalRequest: () => {},
      setApprovalPolicy: () => true,
    },
    sessionWriter: {
      followup: () => {},
      steer: async () => 'ok' as const,
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
    compose: async () => ({ setup: () => {} }),
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

test('/settings shows the Home/End keys row; an invalid persisted value falls back to viewport', async () => {
  resetKeybindings()
  const t = setupSettings({ homeEndKeys: 'garbage' })
  await t.run()
  await t.view()
  // Rows without a session: theme, expand, thinking, footer, busy-enter,
  // local-shell-sandbox, home-end-keys, fullscreen, separator, cwd — the
  // home-end-keys row is the 7th, below the panel's visible fold.
  for (let i = 0; i < 6; i += 1) t.vt.sendInput('\x1b[B')
  const view = await t.view()
  assert.ok(view.includes('Home/End keys'), `row missing:\n${view}`)
  assert.ok(view.includes('viewport'), `an invalid persisted value must fall back to viewport:\n${view}`)
  assert.ok(!view.includes('garbage'), `the raw invalid value must never render:\n${view}`)
  t.app.stop()
})

test('the Home/End keys row toggle applies the preset immediately and persists', async () => {
  resetKeybindings()
  const t = setupSettings({ homeEndKeys: 'viewport' })
  await t.run()
  await t.view()
  // Rows without a session: theme, expand, thinking, footer, busy-enter,
  // local-shell-sandbox, home-end-keys, fullscreen, separator, cwd — the
  // home-end-keys row is the 7th.
  for (let i = 0; i < 6; i += 1) t.vt.sendInput('\x1b[B')
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
