/**
 * C2-R5 L6: the Footer layout and Keyboard shortcuts pages are SAME-LEASE
 * Settings children, reached both by their Settings rows and by the bare
 * `/footer` / `/statusline` / `/keybindings` deeplinks.
 *
 * Every case drives the REAL `/settings` command coordinator, the real `TuiApp`
 * fullscreen Settings lease, the real `SettingsWorkspacePanel`, the real Footer
 * model/composer/save transaction and the real `KeybindingEditorController`.
 * The only substitutions are the external Host boundaries a headless
 * composition cannot own: the settings service (the real Direct adapter over a
 * Host stand-in, or a throwing document) and the unavailable Host config
 * sections. Assertions read the terminal the user really sees and the authority
 * the write really reached.
 * @module @xmoon76/dsh-pi-tui/settings-specialized-editors.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import type { TuiCommandRunner } from '../../src/commands.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { TuiApp } from '../../src/tui-app.ts'
import type { TuiSettingsLike } from '../../src/commands.ts'
import { createDirectSettingsFixture, type DirectSettingsFixture } from '../support/direct-settings-fixture.ts'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'
import { DEFAULT_FOOTER_LAYOUT } from '../../src/domain/footer/presets.ts'
import { sessionScopeFacts } from '../support/session-scope-facts.ts'
import { settingsDirectPageConfig } from '../support/settings-direct-page-stubs.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try {
      app.dispose()
    } catch {
      try { app.stop() } catch {}
    }
  }
})

interface Def {
  readonly name: string
  readonly handler?: (invocation: { rawInput: string }) => unknown
}

interface Harness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly fixture: DirectSettingsFixture | undefined
  readonly invoke: (name: string, rawInput?: string) => Promise<unknown>
  readonly view: () => string
}

function makeCommands(): { defs: Def[]; service: unknown } {
  const defs: Def[] = []
  return {
    defs,
    service: {
      register: (definition: Def) => { defs.push(definition); return () => {} },
      list: () => [],
      find: () => undefined,
      execute: async () => undefined,
    },
  }
}

/** The live raw footer custom-item projection the Footer writers consume. */
function rawFooterItems(fixture: DirectSettingsFixture | undefined): { kind: 'detached'; value: unknown[] } {
  const value = fixture?.document().footerCustomItems
  return { kind: 'detached', value: Array.isArray(value) ? value : [] }
}

function makeRunner(
  app: TuiApp,
  ctx: Context,
  commands: unknown,
  settings: TuiSettingsLike,
  fixture: DirectSettingsFixture | undefined,
  rawUnavailable = false,
): TuiCommandRunner {
  const base: Record<string, unknown> = {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    ...sessionScopeFacts(() => undefined, () => 0),
    currentSessionId: undefined,
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    get defaultIntentOutcome() { return undefined },
    defaultSelection: () => undefined,
    defaultIntent: undefined,
    setDefaultIntent: () => {},
    defaultIntentRecord: undefined,
    settleIntent: () => {},
    tuiSettings: settings,
    agents: {} as never,
    sessionReader: {
      list: async () => [], search: async () => ({ items: [], hasMore: false }),
      projectionBatch: async () => new Map(), blank: () => undefined, measureContext: () => undefined,
      turnOutline: () => undefined, sessionStatus: () => undefined,
    },
    sessionWriter: {
      prompt: async () => ({ kind: 'committed' as const, value: undefined }),
      updateQueue: async () => ({ kind: 'committed' as const, value: undefined }),
      cancel: async () => ({ kind: 'committed' as const, value: undefined }),
      rename: async (_sessionId: string, title: string) => ({ kind: 'committed' as const, value: { title } }),
      refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }),
    },
    interaction: {
      questions: {
        subscribe: () => undefined, onRequest: () => true, snapshot: () => undefined,
        claimTimedWait: async () => undefined, answerContinued: async () => 'not-continued' as const,
      },
      onApprovalRequest: () => {}, setApprovalPolicy: () => true,
    },
    catalog: { models: { available: () => false } } as never,
    config: settingsDirectPageConfig({
      configReadiness: () => 'ready' as const,
      footerCustomItems: { rawForPersistence: () => rawUnavailable ? { kind: 'unavailable' as const } : rawFooterItems(fixture) },
      permissions: { presetNames: () => [], defaultPreset: () => undefined, approvalOverrideOf: () => undefined },
      subagentModelSelection: { available: () => false },
      web: { available: () => false },
      credentials: { available: () => false },
    }) as never,
    commandRegistry: ctx.get('commands') as never,
    clientCommands: createClientCommandRegistry(parseCommand),
    cwd: '/ws', sessionCwd: () => '/ws', imageStore: {} as never,
    copyToClipboard: async () => true, imageLimits: () => undefined, insertIntoEditor: () => {},
    prepareDraftMessage: async (text: string) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
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
    progressUpdatesState: { mode: 'milestones' },
    responseStyleState: { style: 'default' },
    gitAttributionState: { mode: 'off' },
    focusEnabled: () => false, setFocusMode: () => {},
    setNotificationMode: () => {}, currentNotificationMode: () => 'unfocused',
    currentNotificationMethod: () => 'auto', setNotificationMethod: () => {},
    setTerminalProgressMode: () => {}, updateWelcomeCard: () => {},
    openJobView: () => {}, openTasksBrowser: () => {}, createPluginManagerPage: () => undefined,
    openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withWriter: async <T>(_scope: unknown, task: () => T | Promise<T>) => task(),
    withPromptAdmission: async <T>(_agent: unknown, _line: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {}, requestExit: () => {}, extensions: undefined, exit: () => {},
    applyFooterSettings: (doc: { footer?: string; footerLayout?: unknown; footerCustomItems?: unknown } | undefined) => {
      if (doc === undefined) return
      if (doc.footer === 'custom') {
        app.setFooterPreset('full')
        app.setFooterLayout(doc.footerLayout as never)
        app.setFooterCustomItems(doc.footerCustomItems as never)
      } else if (doc.footer === 'compact') {
        app.setFooterPreset('compact')
        app.setFooterLayout(undefined)
      } else if (doc.footer === 'default') {
        app.setFooterPreset('full')
        app.setFooterLayout(undefined)
      }
    },
    backendKind: 'direct' as const,
    hostShellCompletion: true,
    transcriptExportAvailable: true,
    forceContextMeasurementResult: () => ({ value: undefined, observation: 'unavailable' as const }),
    subscribeSessionScopeInvalidation: () => () => {},
    listScopedCommands: () => [],
    recordExtensionError: () => {}, clearExtensionError: () => {},
  }
  void commands
  return new Proxy(base, {
    get: (target, property) => property in target ? target[property as string] : () => undefined,
  }) as unknown as TuiCommandRunner
}

function setup(options: {
  readonly columns?: number
  readonly rows?: number
  readonly settings?: TuiSettingsLike
  readonly fixture?: DirectSettingsFixture
  readonly rawUnavailable?: boolean
}): Harness {
  const ctx = new Context()
  const vt = new VirtualTerminal(options.columns ?? 120, options.rows ?? 40)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    runOwned: ((_label: string, task: () => unknown, owned: {
      onResult?: (value: unknown) => void
      onError?: (error: unknown) => void
    }) => {
      Promise.resolve().then(task).then(
        value => owned.onResult?.(value),
        error => owned.onError?.(error),
      )
    }) as never,
  })
  app.start()
  startedApps.add(app)
  const commands = makeCommands()
  ctx.provide('commands', commands.service as never)
  ctx.provide('settings', {
    describe: () => [{
      ns: 'tui-app',
      value: options.fixture?.document() ?? { footer: 'default' },
      user: {},
      revision: options.fixture?.revision() ?? 1,
    }],
    mutate: async () => {},
  } as never)
  const fixture = options.fixture ?? createDirectSettingsFixture({ footer: 'default' })
  const settings = options.settings ?? fixture.settings
  registerTuiCommandsWithDirectSeams(makeRunner(app, ctx, commands.service, settings, fixture, options.rawUnavailable === true))
  return {
    vt,
    app,
    fixture: options.fixture ?? fixture,
    invoke: async (name, rawInput = '') => {
      const definition = commands.defs.find(candidate => candidate.name === name)
      assert.ok(definition?.handler !== undefined, `${name} must be registered`)
      return (definition.handler as (invocation: { rawInput: string }) => unknown)({ rawInput })
    },
    view: () => vt.getViewport().map(stripTerminalSequences).join('\n'),
  }
}

/** Wait for a bounded number of real frames (never a fixed sleep). */
async function frames(vt: VirtualTerminal, count = 1): Promise<void> {
  for (let frame = 0; frame < count; frame += 1) await vt.waitForRender()
}

async function press(vt: VirtualTerminal, data: string): Promise<void> {
  vt.sendInput(data)
  await vt.waitForRender()
}

/** Flush the owned mutation promise chain (no fixed wall-clock sleep). */
async function flushOwnedTurns(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve()
  await new Promise<void>(resolve => setImmediate(resolve))
}

function lastLine(h: Harness): string {
  const view = h.vt.getViewport().map(stripTerminalSequences)
  return view[view.length - 1] ?? ''
}

/** The physical Settings frame: ONE header, ONE bar, no second fullscreen. */
function assertOneSettingsChrome(h: Harness): void {
  const view = h.view()
  assert.match(view, /Settings · /u, 'the Settings header owns the frame')
  assert.ok(!view.includes('╭') && !view.includes('╰'), 'no second overlay frame may be mounted')
  assert.equal(view.split('\n').filter(line => line.startsWith('Settings · ')).length, 1,
    'exactly ONE Settings header is painted')
}

test('R5-L6-01 /footer deeplinks into the same lease, edits and saves through the one Footer transaction', async () => {
  const h = setup({ fixture: createDirectSettingsFixture({ footer: 'default', footerCustomItems: [] }) })
  const result = await h.invoke('footer')
  assert.deepEqual(result, { kind: 'success' })
  await frames(h.vt)
  assertOneSettingsChrome(h)
  const lease = (h.app as unknown as { workspaceLease?: object }).workspaceLease
  assert.ok(lease !== undefined, 'the command really leased the ONE Settings screen')
  assert.match(h.view(), /Settings · Appearance · Configure footer layout…/u, 'the Footer page is the Appearance child')
  assert.match(h.view(), /Footer layout · Select row/u, 'the shared pane header names the page')
  assert.match(h.view(), /Select row to edit/u, 'the row selector is painted')
  assert.match(lastLine(h), /Esc Close/u, 'the ONE Action Bar is the physical last row')

  // Enter the row, remove the first item, walk back and save explicitly.
  await press(h.vt, '\r')
  await press(h.vt, ' ')
  await press(h.vt, '\x1b')
  assert.match(h.view(), /Unsaved/u, 'the draft is dirty before Save')
  await press(h.vt, 's')
  await frames(h.vt, 4)
  const doc = h.fixture!.document()
  assert.equal(doc.footer, 'custom', 'S persists the custom mode')
  assert.equal(doc.footerFallbackMode, 'custom', 'the restart fallback rides along')
  assert.ok(!(doc.footerLayout as { rows: Array<{ left: Array<{ id: string }> }> }).rows[0]!.left.some(ref => ref.id === 'view-scope'),
    'the persisted layout reflects the removed item')
  assert.equal(h.app.getFooterMode(), 'custom', 'the runtime applies the persisted layout')
  assert.match(h.view(), /Settings · Appearance · Rows/u,
    'the SAME lease returns to the Appearance Rows after the page completes')
  assert.match(h.view(), /Configure footer layout…\s+custom · 2 rows/u,
    'the source row re-reads the authoritative custom layout')
  assert.equal((h.app as unknown as { workspaceLease?: object }).workspaceLease, lease,
    'the page open/save/close cycle never replaced the Settings lease')
  assert.doesNotMatch(h.view(), /Select row to edit/u, 'the page is gone; no overlay was stacked')
  h.app.stop()
})

test('R5-L6-01a browsing and Esc write nothing; a compact Confirm persists both modes and applies the live footer', async () => {
  const fixture = createDirectSettingsFixture({ footer: 'default' })
  const h = setup({ fixture })
  await h.invoke('settings')
  await frames(h.vt)
  for (let step = 0; step < 4; step += 1) await press(h.vt, '\x1b[B')
  await press(h.vt, '\r')
  await press(h.vt, '\x1b[B')
  await press(h.vt, '\x1b[B')
  const callsBefore = fixture.calls.length
  await press(h.vt, '\r') // open the choice
  assert.match(h.view(), /Choose value/u)
  await press(h.vt, '\x1b') // back without a write
  assert.equal(fixture.calls.length, callsBefore, 'browsing the choice never writes')
  await press(h.vt, '\r') // choice again
  await press(h.vt, '\x1b[B') // default -> compact
  await press(h.vt, '\r') // explicit Confirm
  await flushOwnedTurns()
  await frames(h.vt, 2)
  const doc = fixture.document()
  assert.equal(doc.footer, 'compact', 'compact is persisted')
  assert.equal(doc.footerFallbackMode, 'compact', 'the restart fallback is persisted alongside')
  assert.equal(h.app.getFooterMode(), 'compact', 'the live footer really adopts compact')
  assert.match(h.view(), /Status\s+Verified/u, 'the fresh document read verifies the commit')
  h.app.stop()
})

test('R5-L6-01d an unreadable USER footer layer refuses the mode write with zero calls', async () => {
  const fixture = createDirectSettingsFixture({ footer: 'default' })
  const h = setup({ fixture, rawUnavailable: true })
  await h.invoke('settings')
  await frames(h.vt)
  for (let step = 0; step < 4; step += 1) await press(h.vt, '\x1b[B')
  await press(h.vt, '\r')
  await press(h.vt, '\x1b[B')
  await press(h.vt, '\x1b[B')
  await press(h.vt, '\r') // choice
  await press(h.vt, '\x1b[B') // compact
  await press(h.vt, '\r') // Confirm
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.equal(fixture.calls.length, 0, 'the USER raw inability refuses BEFORE settings.replace')
  assert.equal(fixture.document().footer, 'default', 'the stored mode is unchanged')
  assert.match(h.view(), /Not saved/u, 'the refusal is stated, never presented as saved')
  h.app.stop()
})

test('R5-L6-01b the Footer mode writer seeds a custom layout and persists the restart fallback first', async () => {
  const fixture = createDirectSettingsFixture({ footer: 'default', footerLayout: undefined })
  const h = setup({ fixture })
  await h.invoke('settings')
  await frames(h.vt)
  for (let step = 0; step < 4; step += 1) await press(h.vt, '\x1b[B') // About -> Appearance
  await press(h.vt, '\r') // rows
  await press(h.vt, '\x1b[B') // Icon style
  await press(h.vt, '\x1b[B') // Status line mode
  await press(h.vt, '\r') // the inline choice
  await press(h.vt, '\x1b[B') // default -> compact
  await press(h.vt, '\x1b[B') // compact -> custom
  await press(h.vt, '\r') // explicit Confirm
  await flushOwnedTurns()
  await frames(h.vt, 2)
  const doc = fixture.document()
  assert.equal(doc.footer, 'custom', 'custom is persisted')
  assert.equal(doc.footerFallbackMode, 'custom', 'the fallback is persisted alongside')
  assert.deepEqual(doc.footerLayout, DEFAULT_FOOTER_LAYOUT,
    'a custom mode with no valid layout seeds the editable default layout')
  assert.equal(h.app.getFooterMode(), 'custom', 'the live footer adopts the persisted mode')
  assert.match(h.view(), /Status\s+Verified/u, 'the fresh document read verifies the commit')
  h.app.stop()
})

/** Walk `/settings` to one professional editor through the REAL Rows list —
 *  the user route that puts the root's focus on `detail` (a bare deeplink lands
 *  on `rows` already, so it cannot witness the close-to-Rows fix). */
async function openEditorFromRows(
  h: Harness,
  target: 'footer' | 'keybindings',
): Promise<void> {
  await h.invoke('settings')
  await frames(h.vt)
  const categoryStep = target === 'footer' ? 4 : 6
  for (let step = 0; step < categoryStep; step += 1) await press(h.vt, '\x1b[B')
  await press(h.vt, '\r') // the rail's Enter enters the Rows level
  assert.match(h.view(), target === 'footer'
    ? /Settings · Appearance · Rows/u
    : /Settings · Input & Terminal · Rows/u, `the Rows level owns the keyboard:\n${h.view()}`)
  const rowStep = target === 'footer' ? 3 : 6
  for (let step = 0; step < rowStep; step += 1) await press(h.vt, '\x1b[B')
  await press(h.vt, '\r') // Enter on the row mounts the page in this lease
  assert.match(h.view(), target === 'footer'
    ? /Settings · Appearance · Configure footer layout…/u
    : /Settings · Input & Terminal · Keyboard shortcuts…/u, `the editor page is mounted:\n${h.view()}`)
}

for (const target of ['footer', 'keybindings'] as const) {
  for (const back of ['\x1b', '\x1b[D'] as const) {
    const label = back === '\x1b' ? 'Esc' : '←'
    const rows = target === 'footer' ? 'Settings · Appearance · Rows' : 'Settings · Input & Terminal · Rows'
    test(`R5-L6-02h ${label} closing the ${target} page opened from its Rows lands on Rows, then the rail`, async () => {
      const h = setup({ fixture: createDirectSettingsFixture({ footer: 'default', footerCustomItems: [] }) })
      await openEditorFromRows(h, target)
      const lease = (h.app as unknown as { workspaceLease?: object }).workspaceLease
      assert.ok(lease !== undefined)
      // ONE back key: the page closes AND the keyboard is on the Rows list the
      // user came from — never on an intermediary Detail summary.
      await press(h.vt, back)
      assert.match(h.view(), new RegExp(rows, 'u'),
        `one ${label} must land on the row list: \n${h.view()}`)
      assert.doesNotMatch(h.view(), /\[Details\]/u, 'no Detail pane takes the keyboard on the way back')
      assert.equal((h.app as unknown as { workspaceLease?: object }).workspaceLease, lease,
        'the whole round trip never replaced the Settings lease')
      // The NEXT back key reaches the category rail: the level really changed.
      await press(h.vt, back)
      assert.match(h.view(), /Settings · Categories/u,
        `the next ${label} must reach the rail, not repeat the row level:\n${h.view()}`)
      assert.equal((h.app as unknown as { workspaceLease?: object }).workspaceLease, lease)
      h.app.dispose()
      startedApps.delete(h.app)
    })
  }
}

test('R5-L6-02a ← is the back verb on the query-less Footer root page', async () => {
  const footerFixture = createDirectSettingsFixture({ footer: 'default', footerCustomItems: [] })
  const footer = setup({ fixture: footerFixture })
  await footer.invoke('footer')
  await frames(footer.vt)
  const footerLease = (footer.app as unknown as { workspaceLease?: object }).workspaceLease
  assert.ok(footerLease !== undefined)
  assert.match(lastLine(footer), /\u2190 Back/u, 'the Footer root bar advertises the accepted back verb')
  await press(footer.vt, '\x1b[D')
  assert.match(footer.view(), /Settings · Appearance · Rows/u, 'left returns to the Appearance setting list')
  assert.equal((footer.app as unknown as { workspaceLease?: object }).workspaceLease, footerLease,
    'the same Settings lease stays mounted')
  assert.equal(footerFixture.calls.length, 0, 'a clean back writes nothing')
  footer.app.dispose()
  startedApps.delete(footer.app)
})

test('R5-L6-02f a dirty Footer turns the root-page ← into the in-page guard', async () => {
  const fixture = createDirectSettingsFixture({ footer: 'default', footerCustomItems: [] })
  const h = setup({ fixture })
  await h.invoke('footer')
  await frames(h.vt)
  await press(h.vt, '\r')
  await press(h.vt, ' ')
  await press(h.vt, '\x1b')
  assert.match(h.view(), /Unsaved/u)
  const callsBefore = fixture.calls.length
  await press(h.vt, '\x1b[D')
  assert.match(h.view(), /Save changes before exiting\?/u, 'a dirty ← opens the Save/Discard/Keep guard')
  assert.equal(fixture.calls.length, callsBefore, 'opening the guard writes nothing')
  await press(h.vt, '\x1b')
  assert.match(h.view(), /Footer layout · Select row/u, 'Esc on the guard is Keep Editing')
  assert.equal(fixture.document().footer, 'default')
  h.app.dispose()
  startedApps.delete(h.app)
})

test('R5-L6-02e ← is the back verb on the query-less Keyboard root list', async () => {
  const keyboard = setup({ fixture: createDirectSettingsFixture({ footer: 'default' }) })
  await keyboard.invoke('keybindings')
  await frames(keyboard.vt)
  const keyboardLease = (keyboard.app as unknown as { workspaceLease?: object }).workspaceLease
  assert.ok(keyboardLease !== undefined)
  assert.match(lastLine(keyboard), /\u2190 Back/u, 'the query-less Keyboard root bar advertises the back verb')
  await press(keyboard.vt, '\x1b[D')
  assert.match(keyboard.view(), /Settings · Input & Terminal · Rows/u, 'left returns to the Input & Terminal list')
  assert.equal((keyboard.app as unknown as { workspaceLease?: object }).workspaceLease, keyboardLease,
    'the same Settings lease stays mounted')
  keyboard.app.dispose()
  startedApps.delete(keyboard.app)
})

test('R5-L6-02d ← with a non-empty keybinding query edits the search and never leaves the page', async () => {
  const h = setup({ fixture: createDirectSettingsFixture({ footer: 'default' }) })
  await h.invoke('keybindings')
  await frames(h.vt)
  const lease = (h.app as unknown as { workspaceLease?: object }).workspaceLease
  await press(h.vt, 'submit')
  assert.match(h.view(), /Search: submit/u)
  await press(h.vt, '\x1b[D')
  assert.match(h.view(), /Search: submit/u, 'the query text is unchanged')
  assert.match(h.view(), /Keyboard shortcuts…/u, 'the page never left')
  assert.doesNotMatch(lastLine(h), /\u2190 Back/u, 'a non-empty query never advertises the back verb')
  assert.equal((h.app as unknown as { workspaceLease?: object }).workspaceLease, lease)
  h.app.stop()
})

test('R5-L6-02 a dirty Footer Esc opens the in-page guard; Keep writes nothing and stays, Discard closes without a write', async () => {
  const h = setup({ fixture: createDirectSettingsFixture({ footer: 'default', footerCustomItems: [] }) })
  await h.invoke('footer')
  await frames(h.vt)
  await press(h.vt, '\r')
  await press(h.vt, ' ')
  await press(h.vt, '\x1b') // row -> selector (dirty)
  await press(h.vt, '\x1b') // selector -> in-page guard
  assert.match(h.view(), /Save changes before exiting\?/u, 'the guard is a page state, not a second overlay')
  assert.match(h.view(), /Save & Exit/u)
  assert.match(h.view(), /Discard & Exit/u)
  assert.match(h.view(), /Keep Editing/u)
  const before = h.fixture!.document()
  const beforeRevision = h.fixture!.revision()
  await press(h.vt, '\x1b[B')
  await press(h.vt, '\x1b[B')
  await press(h.vt, '\r') // Keep Editing
  assert.match(h.view(), /Select row to edit/u, 'Keep returns to the selector with the draft intact')
  assert.equal(h.fixture!.revision(), beforeRevision, 'Keep performs no write')
  assert.deepEqual(h.fixture!.document(), before, 'the document is untouched by Keep')
  await press(h.vt, '\x1b') // dirty -> guard
  await press(h.vt, '\x1b[B') // Save & Exit -> Discard & Exit
  await press(h.vt, '\r')
  await frames(h.vt)
  assert.match(h.view(), /Settings · Appearance/u, 'Discard returns to the same lease')
  assert.doesNotMatch(h.view(), /Select row to edit/u, 'the page is gone')
  assert.deepEqual(h.fixture!.document(), before, 'Discard writes nothing')
  h.app.stop()
})

test('R5-L6-02b a category rail press cannot bypass a dirty Footer guard', async () => {
  const fixture = createDirectSettingsFixture({ footer: 'default', footerCustomItems: [] })
  const h = setup({ columns: 120, rows: 40, fixture })
  await h.invoke('footer')
  await frames(h.vt)
  // Make the page dirty at the selector.
  await press(h.vt, '\r')
  await press(h.vt, ' ')
  await press(h.vt, '\x1b')
  assert.match(h.view(), /Unsaved/u)
  const callsBefore = fixture.calls.length
  // A wide Settings rail click on `Conversation` (the 6th category; bodyTop 3
  // + index 5 = the 9th terminal row, 1-based). The page owns that region, but
  // the real root pointer path must never turn it into a category change.
  h.vt.sendInput('\x1b[<0;3;9M')
  await frames(h.vt)
  h.vt.sendInput('\x1b[<0;3;9m')
  await frames(h.vt)
  assert.match(h.view(), /Footer layout|Select row to edit/u, 'the dirty Footer page still owns the screen')
  assert.doesNotMatch(h.view(), /Settings · Conversation/u, 'the rail press did not switch category')
  assert.equal(fixture.calls.length, callsBefore, 'the rail press wrote nothing')
  h.app.stop()
})

test('R5-L6-02g a forced Settings workspace close still surfaces a failed Footer write', async () => {
  const fixture = createDirectSettingsFixture({ footer: 'default', footerCustomItems: [] })
  let releaseReplace!: () => void
  let signalStarted!: () => void
  const writeStarted = new Promise<void>(resolve => { signalStarted = resolve })
  const settings: TuiSettingsLike = {
    get: () => fixture.settings.get(),
    replace: () => {
      signalStarted()
      return new Promise<void>((_resolve, reject) => {
        releaseReplace = () => { reject(new Error('the session went away')) }
      })
    },
  }
  const h = setup({ settings, fixture })
  const notices: Array<{ message: string; level: string | undefined }> = []
  ;(h.app as unknown as { notify: (message: string, level?: string) => void }).notify = (message, level) => { notices.push({ message, level }) }
  await h.invoke('footer')
  await frames(h.vt)
  await press(h.vt, '\r')
  await press(h.vt, ' ')
  await press(h.vt, '\x1b')
  await press(h.vt, 's')
  await writeStarted
  const lease = (h.app as unknown as { workspaceLease?: { close(): void } }).workspaceLease
  assert.ok(lease !== undefined)
  lease.close()
  releaseReplace()
  await flushOwnedTurns()
  await flushOwnedTurns()
  assert.equal(fixture.document().footer, 'default', 'the failed write stored nothing')
  assert.ok(notices.some(notice => notice.level === 'error' && /footer layout save failed/u.test(notice.message)),
    `the still-running app states the failure even though the page is gone: ${JSON.stringify(notices)}`)
  assert.ok(!notices.some(notice => notice.message === 'footer layout saved'),
    'a failed write is never reported as saved')
  h.app.dispose()
  startedApps.delete(h.app)
})

test('R5-L6-02c a forced Settings workspace close keeps the committed Footer write but never revives the page', async () => {
  const fixture = createDirectSettingsFixture({ footer: 'default', footerCustomItems: [] })
  let releaseReplace!: () => void
  let signalStarted!: () => void
  const writeStarted = new Promise<void>(resolve => { signalStarted = resolve })
  const settings: TuiSettingsLike = {
    get: () => fixture.settings.get(),
    replace: doc => {
      signalStarted()
      return new Promise<void>(resolve => {
        releaseReplace = () => { fixture.settings.replace(doc); resolve() }
      })
    },
  }
  const h = setup({ settings, fixture })
  const notices: string[] = []
  ;(h.app as unknown as { notify: (message: string, level?: string) => void }).notify = message => { notices.push(message) }
  await h.invoke('footer')
  await frames(h.vt)
  await press(h.vt, '\r')
  await press(h.vt, ' ')
  await press(h.vt, '\x1b')
  await press(h.vt, 's')
  await writeStarted
  const lease = (h.app as unknown as {
    workspaceLease?: { close(): void; panel: { disposed: boolean } }
  }).workspaceLease
  assert.ok(lease !== undefined)
  // Force the WORKSPACE down (the app stays alive) while the page's save is
  // held. The released write really commits to the settings document and the
  // command layer owns the runtime follow-through, but the disposed page/lease
  // itself must never notify or remount.
  lease.close()
  assert.equal(h.app.isDisposed(), false, 'only the Settings workspace was forced down')
  releaseReplace()
  await flushOwnedTurns()
  await flushOwnedTurns()
  assert.equal((h.app as unknown as { workspaceLease?: unknown }).workspaceLease, undefined,
    'the forced teardown leaves no workspace lease to remount')
  assert.equal(lease.panel.disposed, true, 'the Footer page itself was disposed')
  assert.equal(fixture.document().footer, 'custom', 'the held write still reached the document authority')
  assert.equal(h.app.getFooterMode(), 'custom',
    'the commit owner applies the runtime even though the page that started it is gone')
  assert.deepEqual(notices, [], 'the disposed page never claims or notifies a late save')
  h.app.dispose()
  startedApps.delete(h.app)
})

test('R5-L6-03 bare /keybindings deeplinks into the same lease; recording writes the USER document and applies the live keymap', async () => {
  const h = setup({ fixture: createDirectSettingsFixture({ footer: 'default' }) })
  const result = await h.invoke('keybindings')
  assert.deepEqual(result, { kind: 'success' })
  await frames(h.vt)
  assertOneSettingsChrome(h)
  assert.match(h.view(), /Settings · Input & Terminal · Keyboard shortcuts…/u)
  assert.match(h.view(), /Search: type to filter/u)
  assert.match(lastLine(h), /Esc close/u)

  await press(h.vt, 'submit')
  await press(h.vt, '\r') // action detail
  assert.match(h.view(), /Action ID: app\.input\.submit/u, 'the selected action detail is open')
  await press(h.vt, '\r') // record the selected default binding
  assert.match(h.view(), /Record shortcut/u, 'the recorder is a page sub-view')
  h.vt.sendInput('\x18') // Ctrl+X
  await flushOwnedTurns()
  await frames(h.vt, 2)
  const doc = h.fixture!.document()
  assert.ok(doc.keybindings !== undefined, `the recorder mutation must write the USER document:\n${h.view()}`)
  assert.equal((doc.keybindings as Record<string, unknown>)['app.input.submit'], 'ctrl+x', 'the recorder writes the USER binding')
  assert.deepEqual(h.app.keybindingsManager().keysFor('app.input.submit'), ['ctrl+x'],
    'the recorded binding is live in the running keymap')
  const lease = (h.app as unknown as { workspaceLease?: object }).workspaceLease

  // Esc gradient: action detail -> list (query kept) -> query cleared -> the
  // source row. Not one of those steps may close the Settings lease.
  await press(h.vt, '\x1b') // action detail -> list
  assert.match(h.view(), /Search: submit/u, 'the list keeps the query after the detail closes')
  await press(h.vt, '\x1b') // query -> cleared
  assert.match(h.view(), /Search: type to filter/u, 'the first root Esc clears the query only')
  await press(h.vt, '\x1b') // list root -> source row
  await frames(h.vt)
  assert.match(h.view(), /Settings · Input & Terminal · Rows/u, 'the next Esc returns to the source Rows')
  assert.doesNotMatch(h.view(), /Search:|Keymap:/u, 'the page body is gone')
  assert.equal((h.app as unknown as { workspaceLease?: object }).workspaceLease, lease,
    'the whole Esc ladder never replaced the Settings lease')
  h.app.stop()
})

test('R5-L6-03a a pending keybinding write owns the detail page until its result is painted', async () => {
  const fixture = createDirectSettingsFixture({ footer: 'default' })
  let releaseReplace!: () => void
  let signalStarted!: () => void
  const writeStarted = new Promise<void>(resolve => { signalStarted = resolve })
  const base = fixture.settings
  const settings: TuiSettingsLike = {
    get: () => base.get(),
    replace: doc => {
      signalStarted()
      return new Promise<void>(resolve => {
        releaseReplace = () => { base.replace(doc); resolve() }
      })
    },
  }
  const h = setup({ settings, fixture })
  await h.invoke('keybindings')
  await frames(h.vt)
  await press(h.vt, 'submit')
  await press(h.vt, '\r') // action detail
  assert.match(h.view(), /Action ID: app\.input\.submit/u)
  h.vt.sendInput('r') // reset the action's shortcuts → an in-flight write
  await writeStarted
  await frames(h.vt, 2)
  assert.match(h.view(), /Action ID: app\.input\.submit/u, 'the detail page still owns the screen')
  assert.match(lastLine(h), /Saving…|one write at a time/u, 'the bar states the frozen write')
  await press(h.vt, '\x1b')
  assert.match(h.view(), /Action ID: app\.input\.submit/u, 'Esc cannot leave while the write is pending')
  assert.match(lastLine(h), /Saving…|one write at a time/u)
  await press(h.vt, '\x1b')
  assert.match(h.view(), /Settings · Input & Terminal · Keyboard shortcuts…/u, 'the lease is unchanged')
  releaseReplace()
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.match(h.view(), /Action ID: app\.input\.submit/u)
  await press(h.vt, '\x1b')
  assert.match(h.view(), /Search: submit/u, 'Esc leaves only after the settlement painted')
  h.app.dispose()
  startedApps.delete(h.app)
})

test('R5-L6-04 low viewports keep ONE physical Action Bar and never paint an oversized page', async () => {
  for (const [columns, rows] of [[44, 8], [44, 20], [80, 24]] as const) {
    const h = setup({ columns, rows, fixture: createDirectSettingsFixture({ footer: 'default' }) })
    await h.invoke('footer')
    await frames(h.vt)
    assertOneSettingsChrome(h)
    assert.match(lastLine(h), /Esc (?:Close|Back)/u, `the bar is the last row at ${columns}x${rows}`)
    assert.match(h.view(), /Select row to edit|Row 1/u, `the selector body is painted at ${columns}x${rows}`)
    const footerRoot = (h.app as unknown as {
      workspaceLease?: { panel: { render(width: number): string[] } }
    }).workspaceLease?.panel
    assert.ok(footerRoot !== undefined)
    const footerLines = footerRoot.render(columns)
    assert.ok(footerLines.length <= rows, `the Footer frame never exceeds ${rows} rows at ${columns}x${rows}`)
    assert.ok(footerLines.every(line => visibleWidth(line) <= columns),
      `no Footer frame line exceeds ${columns} cells at ${rows} rows`)
    await press(h.vt, '\x1b') // page -> detail
    await press(h.vt, '\x1b') // detail -> rows
    await press(h.vt, '\x1b') // rows -> categories
    await press(h.vt, '\x1b') // categories -> close
    h.app.dispose()
    startedApps.delete(h.app)

    const k = setup({ columns, rows, fixture: createDirectSettingsFixture({ footer: 'default' }) })
    await k.invoke('keybindings')
    await frames(k.vt)
    assertOneSettingsChrome(k)
    assert.match(lastLine(k), /Esc (?:close|clear)/u, `the keyboard bar is the last row at ${columns}x${rows}`)
    assert.match(k.view(), /Search:/u, `the keyboard search/body is painted at ${columns}x${rows}`)
    const keyboardRoot = (k.app as unknown as {
      workspaceLease?: { panel: { render(width: number): string[] } }
    }).workspaceLease?.panel
    assert.ok(keyboardRoot !== undefined)
    const keyboardLines = keyboardRoot.render(columns)
    assert.ok(keyboardLines.length <= rows, `the Keyboard frame never exceeds ${rows} rows at ${columns}x${rows}`)
    assert.ok(keyboardLines.every(line => visibleWidth(line) <= columns),
      `no Keyboard frame line exceeds ${columns} cells at ${rows} rows`)
    k.app.dispose()
    startedApps.delete(k.app)
  }
})

test('R5-L6-04d a bar-only Keybinding grant cannot act on hidden controls', async () => {
  // The Settings root can grant a specialist as little as the ONE Action Bar
  // (its own low-terminal floor). Find whether the real root reaches that
  // grant; if it does, a key that would act on an unpainted control must be
  // refused, and if it does not, the root's guard is what we assert instead.
  let sawBarOnly = false
  for (const rows of [3, 4, 5, 6, 8]) {
    const h = setup({ columns: 44, rows, fixture: createDirectSettingsFixture({ footer: 'default' }) })
    await h.invoke('keybindings')
    await frames(h.vt)
    const page = (h.app as unknown as {
      workspaceLease?: { panel: { specialistPage?: { render(w: number): string[] } } }
    }).workspaceLease?.panel.specialistPage
    if (page !== undefined && page.render(40).length === 1) {
      sawBarOnly = true
      const bar = stripTerminalSequences(page.render(40)[0]!)
      assert.doesNotMatch(bar, /type search/u,
        `a one-row grant must not advertise the search it refuses at ${rows} rows: ${bar}`)
      assert.match(bar, /← Back/u, `the admitted root back verb stays advertised at ${rows} rows: ${bar}`)
      await press(h.vt, 'submit')
      await press(h.vt, '\r')
      assert.doesNotMatch(h.view(), /Search: submit|Record shortcut/u,
        `a bar-only grant must not act on hidden controls at ${rows} rows`)
      // `←` on that same root state is the back verb: it returns the Settings
      // row instead of being swallowed with the other hidden keys. Re-prove the
      // grant is still bar-only at the moment the key is delivered.
      assert.equal(page.render(40).length, 1, `the grant is still bar-only at ${rows} rows`)
      await press(h.vt, '\x1b[D')
      assert.match(h.view(), /Settings · Input & Terminal · Rows/u,
        `the root back verb must work from a bar-only frame at ${rows} rows:\n${h.view()}`)
      h.app.dispose()
      startedApps.delete(h.app)
      break
    }
    h.app.dispose()
    startedApps.delete(h.app)
  }
  // The reviewer's claim holds: a low terminal really reaches this grant, so
  // the guards above are the only thing standing between a key and a control
  // the user cannot see.
  assert.equal(sawBarOnly, true, 'the real root really can grant a bar-only Keybinding frame')
})

test('R5-L6-03b a settled-but-unpainted keybinding result survives non-Esc keys and the root lock', async () => {
  const fixture = createDirectSettingsFixture({ footer: 'default' })
  const base = fixture.settings
  let releaseReplace!: () => void
  let signalStarted!: () => void
  const writeStarted = new Promise<void>(resolve => { signalStarted = resolve })
  const settings: TuiSettingsLike = {
    get: () => base.get(),
    replace: () => {
      signalStarted()
      return new Promise<void>((_resolve, reject) => {
        releaseReplace = () => { reject(new Error('the authority refused the reset')) }
      })
    },
  }
  const h = setup({ settings, fixture })
  await h.invoke('keybindings')
  await frames(h.vt)
  await press(h.vt, 'submit')
  await press(h.vt, '\r') // detail
  h.vt.sendInput('r') // reset → held write
  await writeStarted
  await frames(h.vt, 2)
  // Settle while the settlement frame is still only queued.
  releaseReplace()
  await flushOwnedTurns()
  // A non-Esc key before that frame must not mask the unread failure.
  h.vt.sendInput('\x1b[B')
  await frames(h.vt, 2)
  assert.match(h.view(), /the authority refused the reset/u,
    `the failure really reached the screen:\n${h.view()}`)
  await press(h.vt, '\x1b')
  assert.match(h.view(), /Search: submit/u, 'Esc returns to the list only after the result painted')
  h.app.dispose()
  startedApps.delete(h.app)
})

test('R5-L6-04b a press whose frame moves under a resize cannot activate the repainted row', async () => {
  const h = setup({ columns: 100, rows: 30, fixture: createDirectSettingsFixture({ footer: 'default' }) })
  await h.invoke('footer')
  await frames(h.vt)
  const rows = h.vt.getViewport().map(stripTerminalSequences)
  const row2 = rows.findIndex(line => line.includes('Row 2'))
  assert.ok(row2 >= 0, `Row 2 must be painted:\n${rows.join('\n')}`)
  h.vt.sendInput(`\x1b[<0;3;${row2 + 1}M`) // press on the painted Row 2
  await frames(h.vt)
  h.vt.resize(100, 20)
  await frames(h.vt)
  h.vt.sendInput(`\x1b[<0;3;${row2 + 1}m`) // release on the SAME cell after the grant moved
  await frames(h.vt)
  assert.match(h.view(), /Select row to edit/u, 'the selector remains the painted page')
  assert.doesNotMatch(h.view(), /A Add/u, 'the release never opened a row from the previous frame')
  h.app.stop()
})

test('R5-L6-04c a stored command-mode footer is reported as manual and never offered as a candidate', async () => {
  const h = setup({ fixture: createDirectSettingsFixture({ footer: 'command', footerCommand: { schemaVersion: 1, command: 'echo hi' } }) })
  await h.invoke('settings')
  await frames(h.vt)
  // Appearance -> Status line mode.
  for (let step = 0; step < 4; step += 1) await press(h.vt, '\x1b[B')
  await press(h.vt, '\r')
  await press(h.vt, '\x1b[B')
  await press(h.vt, '\x1b[B')
  assert.match(h.view(), /> Status line mode\s+command \(manual\)/u,
    'the stored command mode is reported truthfully')
  await press(h.vt, '\r') // open the inline choice
  assert.match(h.view(), /Choose value/u, 'the native candidates are offered')
  for (const candidate of ['default', 'compact', 'custom']) {
    assert.match(h.view(), new RegExp(`>?\\s*${candidate}\\b`, 'u'), `${candidate} is a candidate`)
  }
  assert.doesNotMatch(h.view(), /^>\s*command\b/mu, 'command is not a candidate')
  h.app.stop()
})

test('R5-L6-07 a page factory failure after the lease is a real command error, never a silent row', async () => {
  // The preflight read succeeds; the page factory's later read fails (a real
  // race). The command must close the just-leased Settings screen and return an
  // error — not leave an empty row or a second overlay behind.
  const footerFixture = createDirectSettingsFixture({ footer: 'default' })
  let footerReads = 0
  const flakyFooter: TuiSettingsLike = {
    get: () => {
      footerReads += 1
      if (footerReads >= 3) throw new Error('settings vanished before the page opened')
      return footerFixture.settings.get()
    },
    replace: (doc) => footerFixture.settings.replace(doc),
  }
  const footer = setup({ settings: flakyFooter, fixture: footerFixture })
  const footerResult = await footer.invoke('footer') as { kind: string; text?: string }
  assert.equal(footerResult.kind, 'error', 'the factory refusal is a real command error')
  assert.match(footerResult.text ?? '', /could not open the footer layout editor: .*could not be created/u)
  await frames(footer.vt)
  assert.doesNotMatch(footer.view(), /Settings · /u, 'no Settings screen survives the failed deeplink')
  footer.app.dispose()
  startedApps.delete(footer.app)

  const keyboardFixture = createDirectSettingsFixture({ footer: 'default' })
  let keyboardReads = 0
  const flakyKeyboard: TuiSettingsLike = {
    get: () => {
      keyboardReads += 1
      if (keyboardReads >= 3) throw new Error('settings vanished before the page opened')
      return keyboardFixture.settings.get()
    },
    replace: (doc) => keyboardFixture.settings.replace(doc),
  }
  const keyboard = setup({ settings: flakyKeyboard, fixture: keyboardFixture })
  const keyboardResult = await keyboard.invoke('keybindings') as { kind: string; text?: string }
  assert.equal(keyboardResult.kind, 'error', 'the keyboard page factory refusal is a real command error')
  assert.match(keyboardResult.text ?? '', /could not open keyboard shortcuts: .*could not be created/u)
  await frames(keyboard.vt)
  assert.doesNotMatch(keyboard.view(), /Settings · /u, 'no Settings screen survives the failed keybinding deeplink')
  keyboard.app.dispose()
  startedApps.delete(keyboard.app)
})

test('R5-L6-05 a failed Footer write keeps the dirty page and never applies the runtime layout', async () => {
  const fixture = createDirectSettingsFixture({ footer: 'default', footerCustomItems: [] })
  const failing: TuiSettingsLike = {
    get: () => fixture.settings.get(),
    replace: () => { throw new Error('disk is on fire') },
  }
  const h = setup({ settings: failing, fixture })
  await h.invoke('footer')
  await frames(h.vt)
  await press(h.vt, '\r')
  await press(h.vt, ' ')
  await press(h.vt, '\x1b')
  const before = h.app.getFooterMode()
  await press(h.vt, 's')
  await frames(h.vt, 4)
  assert.match(h.view(), /Unsaved/u, 'the page stays dirty after a failed save')
  assert.match(h.view(), /footer layout save failed/u, 'the failure is explicitly stated')
  assert.equal(h.app.getFooterMode(), before, 'the runtime never applies a failed persistence')
  h.app.stop()
})

test('R5-L6-06 a throwing settings document is a real command error, never a fake page or overlay', async () => {
  const h = setup({
    settings: {
      get: () => { throw new Error('settings read exploded') },
      replace: async () => {},
    },
  })
  await frames(h.vt)
  const before = h.view()
  const footer = await h.invoke('footer') as { kind: string; text?: string }
  assert.equal(footer.kind, 'error')
  assert.match(footer.text ?? '', /could not open the footer layout editor/u)
  const keybindings = await h.invoke('keybindings') as { kind: string; text?: string }
  assert.equal(keybindings.kind, 'error')
  assert.match(keybindings.text ?? '', /could not open keyboard shortcuts/u)
  await frames(h.vt)
  assert.equal(h.view(), before, 'no Settings screen was leased and no overlay was mounted')
  h.app.stop()
})
