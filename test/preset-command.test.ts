/**
 * Headless tests for the /preset command surface: the sessionless roster
 * (no session created before one exists), the one-Enter switch through the
 * SettingsList values mechanism, the blank-session recompose path, the
 * started-session refusal, and the English display copy.
 * @module @xmoon76/dsh-pi-tui/preset-command.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { registerTuiCommands, type TuiCommandRunner, type TuiSettingsLike } from '../src/commands.ts'
import { KeybindingEditorController } from '../src/keybinding-ui/controller.ts'
import { parseUserKeybindings } from '../src/keybindings/config.ts'
import type { CatalogRefreshOutcome, CatalogRefreshRequest } from '../src/skill-catalog-refresh.ts'
import type { SurfaceCommandSummary } from '../src/surface-catalog.ts'
import { SESSIONLESS_COMMANDS } from '../src/index.ts'
import { createDiag } from '../src/diag.ts'
import { customThemesDir, darkColors } from '../src/theme.ts'
import { TuiApp } from '../src/tui-app.ts'
import { DraftImageStore } from '../src/image/draft-store.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { sessionScopeFacts } from './session-scope-facts.ts'
import { DirectCatalogPort } from '../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../src/runtime/direct/host-file-direct.ts'


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

/** Poll an async predicate until true or the timeout elapses (the picker
 * listing runs behind a scheduler yield inside a detached task). */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3000, stepMs = 10): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`)
    await new Promise<void>(resolve => setTimeout(resolve, stepMs))
  }
}

// themeOptOut() skips terminal queries under NO_COLOR / FORCE_COLOR=0 /
// CI=true — clear all three so the render paths under test stay live.
process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''
process.env.CI = ''

/** A blank or started fake agent. */
function fakeAgent(sessionId: string, events: readonly { type: string }[] = []): Agent {
  // The alpha.4 Session shape: the log is served through the snapshot reads.
  return {
    session: {
      id: sessionId,
      header: { cwd: '/ws' },
      get seq() { return events.length },
      eventAt: (seq: number) => events[seq],
      snapshotEvents: () => events,
    },
    ctx: { on: () => () => {} },
    options: { provider: 'p', model: 'm' },
  } as unknown as Agent
}

/** The four shipped rows WITH Chinese metadata, exactly as the dsh install's
 * agent-presets package ships them in its official shipped root. */
/** The 0.1.7 shipped declarations publish no name/description of their
 * own (the official built-in classification); the TUI's fixed English copy
 * supplies the picker text. */
const SHIPPED_ROWS = [
  { id: 'standard' },
  { id: 'ptc' },
  { id: 'minimal' },
  { id: 'cordis' },
]

function presetService(
  rows: { id: string; name?: string; description?: string; trust?: string }[],
  defaultPresetId = 'standard',
  selectFailure?: unknown,
  /** Scripted Host lock state; true = locked, false/undefined = unlocked. The
   *  double never derives blankness from the fake transcript. */
  selectLocked?: boolean,
  /** Per-call official roster projection override (broken/odd-row tests). */
  rosterOverride?: () => Promise<unknown>,
  /** Explicit resolve override (subject-drift windows). */
  resolveOverride?: (id?: string) => Promise<{ readonly id: string; broken?: string }>,
  /** Runs inside the official Host select BEFORE it settles (transition drift). */
  selectHook?: () => void,
) {
  const resolved: string[] = []
  const selected: string[] = []
  return {
    resolved,
    selected,
    service: {
      defaultId: defaultPresetId,
      // The PUBLIC official roster projection (the @Remote('list') method).
      remoteExportList: async () => rosterOverride !== undefined
        ? await rosterOverride()
        : {
            presets: rows.map(row => ({
              id: row.id,
              isDefault: row.id === defaultPresetId,
              ...row.name === undefined ? {} : { name: row.name },
              ...row.description === undefined ? {} : { description: row.description },
            })),
          },
      resolve: async (id?: string) => {
        if (resolveOverride !== undefined) return resolveOverride(id)
        // Real-registry semantics: an omitted id resolves the deployment
        // default; an unknown id (explicit OR default) is refused.
        const wanted = id ?? defaultPresetId
        resolved.push(wanted)
        const row = rows.find(candidate => candidate.id === wanted)
        if (row === undefined) throw new Error(`agent-presets: preset "${wanted}" not found (available: standard)`)
        return { id: row.id, trust: row.trust ?? 'system', path: `/presets/${row.id}` }
      },
      // The official blank-session select: re-checks the session's turn
      // boundary and refuses a started one with agent-preset/locked.
      select: async (agent: unknown, id: string) => {
        selectHook?.()
        if (selectFailure !== undefined) throw selectFailure
        const row = rows.find(candidate => candidate.id === id)
        if (row === undefined) throw Object.assign(new Error(`agent-presets: preset "${id}" not found (available: standard)`), { code: 'agent-preset/not-found' })
        if (selectLocked === true) {
          throw Object.assign(new Error('session has already started; its agent preset is fixed'), { code: 'agent-preset/locked' })
        }
        void agent
        selected.push(id)
        return id
      },
      composedPreset: () => undefined,
    },
  }
}

/** A fake commands service recording the registered definitions. With
 * `registered` the effective list returns the recorded definitions too — the
 * real official service lists what the TUI registered (`/preset` included),
 * which the candidate-visibility tests must observe. `presetOverride` models a
 * scoped preset/plugin command that SHADOWS the TUI's `/preset` with its own
 * descriptor (same name, its OWN definitionId). */
function fakeCommands(
  registered = false,
  presetOverride?: { name: string; definitionId?: string; description?: string },
) {
  const defs: { name: string; definitionId?: string; description?: string; input?: { hint: string }; handler?: unknown }[] = []
  return {
    defs,
    service: {
      register: (def: { name: string; definitionId?: string; description?: string; input?: { hint: string }; handler?: unknown }): (() => void) => {
        defs.push(def)
        return () => {}
      },
      list: () => {
        const entries = registered
          ? defs.map(def => ({
              name: def.name,
              ...def.definitionId === undefined ? {} : { definitionId: def.definitionId },
              description: def.description ?? '',
              ...def.input === undefined ? {} : { input: def.input },
            }))
          : []
        const shadowed = presetOverride === undefined
          ? entries
          : entries.map(entry => entry.name === 'preset' ? { ...presetOverride } : entry)
        return [...shadowed, { name: 'builtin', description: 'a builtin', input: { hint: '' } }]
      },
      find: () => undefined,
      execute: async () => undefined,
    },
  }
}

/** A stub runner with a MUTABLE pending preset and a scripted Host blank read.
 * `refreshCatalog` records every request and resolves a scripted outcome
 * (a failed outcome by default, so a test that does not care about the
 * refresh still sees the preset change succeed). */
function stubRunner(options: {
  ctx: Context
  app: TuiApp
  agent: Agent | undefined
  /** A mutable live-Session holder (agent + generation) for stale tests. */
  state?: { agent: Agent | undefined; generation: number }
  sessionBlank?: boolean
  refreshCatalog?: (request: CatalogRefreshRequest) => Promise<CatalogRefreshOutcome>
  ensureCalls?: string[]
  tuiSettings?: TuiSettingsLike
  applyFooterSettings?: () => void
  extensions?: TuiCommandRunner['extensions']
  agents?: TuiCommandRunner['agents']
  sessionReader?: Partial<TuiCommandRunner['sessionReader']>
  effectivePresetId?: string
  recordExtensionError?: (ref: { slot: string; id: string; owner: string }, error: unknown) => void
  clearExtensionError?: (ref: { slot: string; id: string; owner: string }) => void
  /** Defaults to a pass-through capture (the test themes use id === name). */
  captureExtensionHealthRef?: (slot: string, id: string) => { slot: string; id: string; owner: string } | undefined
}): { runner: TuiCommandRunner; pending: { value: string | undefined }; refreshes: CatalogRefreshRequest[] } {
  const pending = { value: undefined as string | undefined }
  const refreshes: CatalogRefreshRequest[] = []
  const runner: TuiCommandRunner = {
    ctx: options.ctx,
    app: options.app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    ...sessionScopeFacts(
      () => options.state !== undefined ? options.state.agent : options.agent,
      () => options.state?.generation ?? 0,
    ),
    // /help and the collision baseline read the FAKE registry through the
    // scoped-command facade, exactly like the production provider.
    listScopedCommands: () => (options.ctx.get('commands') as unknown as { list(): readonly SurfaceCommandSummary[] }).list(),
    get currentSessionId() { return (options.state !== undefined ? options.state.agent : options.agent)?.session.id },
    ensureSession: async () => { options.ensureCalls?.push('ensureSession') },
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    defaultSelection: () => undefined,
    defaultIntent: undefined,
    setDefaultIntent: () => {},
    defaultIntentRecord: undefined,
    settleIntent: () => {},
    awaitPendingDefaultWrite: async () => {},
    trackDefaultWrite: () => {},
    get defaultIntentOutcome() { return undefined },
    setModelSelectionPending: () => {},
    reconcileDefaultIntent: () => {},
    sessionBlank: () => options.sessionBlank,
    tuiSettings: options.tuiSettings,
    applyFooterSettings: () => {},
    agents: options.agents ?? {
      create: async () => ({}) as never,
      open: async () => ({}) as never,
    },
    sessionReader: {
      list: async () => [],
      search: async () => ({ items: [], hasMore: false }),
      projectionBatch: async () => new Map(), blank: () => undefined, measureContext: () => undefined,
       ...options.sessionReader,
    },
    catalog: new DirectCatalogPort(options.ctx as never, (sessionId) => {
      const live = options.state !== undefined ? options.state.agent : options.agent
      return live?.session.id === sessionId ? live : undefined
    }),
    config: new DirectConfigPort(options.ctx as never, undefined, () => undefined),
    commandRegistry: options.ctx.get('commands') as import('../src/commands.ts').CommandRegistryLike | undefined,
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
    get pendingPreset() { return pending.value },
    set pendingPreset(id: string | undefined) { pending.value = id },
    get effectivePresetId() { return pending.value ?? options.effectivePresetId },
    refreshCatalog: async (request) => {
      refreshes.push(request)
      return options.refreshCatalog?.(request) ?? { kind: 'failed', error: 'not wired in tests' }
    },
    refreshSessionCatalog: async (_scope, source) => {
      const agent = options.state !== undefined ? options.state.agent : options.agent
      const request: CatalogRefreshRequest = {
        source,
        target: { kind: 'agent', key: options.state?.generation ?? 0 },
        agent,
      }
      refreshes.push(request)
      return options.refreshCatalog?.(request) ?? { kind: 'failed', error: 'not wired in tests' }
    },
    refreshStandingCatalog: async (presetId, source) => {
      const request: CatalogRefreshRequest = { source, target: { kind: 'preset', presetId } }
      refreshes.push(request)
      return options.refreshCatalog?.(request) ?? { kind: 'failed', error: 'not wired in tests' }
    },
    refreshStatus: () => {},
    progressUpdatesState: { mode: 'milestones' }, responseStyleState: { style: 'default' },
    focusEnabled: () => false,
    setFocusMode: () => {},
    setNotificationMode: () => {},
    setNotificationMethod: () => {},
    updateWelcomeCard: () => {},
    openJobView: () => {},
    openTasksBrowser: () => {}, openPluginManager: () => {}, createPluginManagerSubmenu: () => ({ render: () => [], invalidate: () => {} }),
    openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withSessionWriter: async <T>(_sessionId: string, task: () => T | Promise<T>) => task(),
    withWriter: async <T>(_scope: unknown, task: () => T | Promise<T>) => task(),
    withPromptAdmission: async <T>(_agent: unknown, _line: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {},
    requestExit: () => {},
    extensions: options.extensions,
    captureExtensionHealthRef: options.captureExtensionHealthRef
      ?? ((slot, id) => {
        // Real-service semantics: only a REGISTERED plugin theme resolves
        // (a custom-file name must not produce a health ref).
        if (slot === 'theme') {
          const themes = options.extensions?.themes as { paletteForSelectable?: (value: string) => unknown } | undefined
          if (themes?.paletteForSelectable?.(id) === undefined) return undefined
          // Real-service semantics: the ref carries the CONTRIBUTION id
          // (the value `plugin:<owner>/<id>` maps to `<id>`).
          return { slot, id: id.startsWith('plugin:') ? id.slice(id.lastIndexOf('/') + 1) : id, owner: 'test-owner' }
        }
        return { slot, id, owner: 'test-owner' }
      }),
    recordExtensionError: options.recordExtensionError,
    clearExtensionError: options.clearExtensionError,
    exit: () => {},
  }
  return { runner, pending, refreshes }
}

function invoke(rawInput: string): CommandInvocation {
  return {
    commandId: CommandId('cmd-test-1'),
    agent: undefined as unknown as Agent,
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  }
}

/** Register the TUI commands and return the /preset surface under test. */
function setup(options: {
  rows?: { id: string; name?: string; description?: string; trust?: string }[]
  agent?: Agent
  state?: { agent: Agent | undefined; generation: number }
  sessionBlank?: boolean
  selectFailure?: unknown
  selectLocked?: boolean
  /** Per-call official roster override (see presetService). */
  roster?: () => Promise<unknown>
  /** Explicit resolve override (see presetService). */
  resolve?: (id?: string) => Promise<{ readonly id: string; broken?: string }>
  /** Runs inside the official Host select before it settles (see presetService). */
  selectHook?: () => void
  refreshCatalog?: (request: CatalogRefreshRequest) => Promise<CatalogRefreshOutcome>
  settings?: { get(ns: string): unknown; mutate(ns: string, patch: unknown[]): Promise<unknown> }
  tuiSettings?: TuiSettingsLike
  extensions?: TuiCommandRunner['extensions']
  defaultPresetId?: string
  agents?: TuiCommandRunner['agents']
  sessionReader?: Partial<TuiCommandRunner['sessionReader']>
  effectivePresetId?: string
  recordExtensionError?: (ref: { slot: string; id: string; owner: string }, error: unknown) => void
  clearExtensionError?: (ref: { slot: string; id: string; owner: string }) => void
  captureExtensionHealthRef?: (slot: string, id: string) => { slot: string; id: string; owner: string } | undefined
  /** Make the fake commands service list what was registered (the real
   * service's behavior; required to observe `/preset` in the candidates). */
  commandsListRegistered?: boolean
  /** A scoped same-name `/preset` descriptor that shadows the TUI's own
   * (its OWN definitionId — never the TUI identity). */
  commandsPresetOverride?: { name: string; definitionId?: string; description?: string }
  /** Omit the `agentPresets` service (a rosterless deployment). */
  noPresets?: boolean
  width?: number
  /** Viewport height; a taller screen keeps the whole `/help` list on one page. */
  height?: number
}) {
  const ctx = new Context()
  const vt = new VirtualTerminal(options.width ?? 100, options.height ?? 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const commands = fakeCommands(options.commandsListRegistered === true, options.commandsPresetOverride)
  ctx.provide('commands', commands.service as never)
  if (options.settings === undefined) ctx.provide('settings', { describe: () => [{ ns: 'tui-app', user: {} }] } as never)
  const presets = presetService(options.rows ?? SHIPPED_ROWS, options.defaultPresetId, options.selectFailure, options.selectLocked, options.roster, options.resolve, options.selectHook)
  if (options.noPresets !== true) ctx.provide('agentPresets', presets.service as never)
  if (options.settings !== undefined) ctx.provide('settings', options.settings as never)
  const ensureCalls: string[] = []
  const { runner, pending, refreshes } = stubRunner({
    ctx,
    app,
    agent: options.agent,
    state: options.state,
    sessionBlank: options.sessionBlank,
    refreshCatalog: options.refreshCatalog,
    ensureCalls,
    tuiSettings: options.tuiSettings,
    applyFooterSettings: () => {},
    extensions: options.extensions,
    agents: options.agents,
    sessionReader: options.sessionReader,
    effectivePresetId: options.effectivePresetId,
    captureExtensionHealthRef: options.captureExtensionHealthRef
      ?? ((slot, id) => {
        // Real-service semantics: only a REGISTERED plugin theme resolves
        // (a custom-file name must not produce a health ref).
        if (slot === 'theme') {
          const themes = options.extensions?.themes as { paletteForSelectable?: (value: string) => unknown } | undefined
          if (themes?.paletteForSelectable?.(id) === undefined) return undefined
          // Real-service semantics: the ref carries the CONTRIBUTION id
          // (the value `plugin:<owner>/<id>` maps to `<id>`).
          return { slot, id: id.startsWith('plugin:') ? id.slice(id.lastIndexOf('/') + 1) : id, owner: 'test-owner' }
        }
        return { slot, id, owner: 'test-owner' }
      }),
    recordExtensionError: options.recordExtensionError,
    clearExtensionError: options.clearExtensionError,
  })
  const surface = registerTuiCommands(runner)
  const def = commands.defs.find(entry => entry.name === 'preset')
  assert.ok(def?.handler !== undefined, 'preset handler missing')
  const run = async (rawInput: string): Promise<unknown> =>
    (def!.handler as (inv: CommandInvocation) => unknown)(invoke(rawInput))
  const runCommand = async (name: string, rawInput = ''): Promise<unknown> => {
    const found = commands.defs.find(entry => entry.name === name)
    assert.ok(found?.handler !== undefined, `${name} handler missing`)
    return (found!.handler as (inv: CommandInvocation) => unknown)(invoke(rawInput))
  }
  const view = async (): Promise<string> => {
    await vt.waitForRender()
    return vt.getViewport().join('\n')
  }
  return { vt, app, run, runCommand, view, pending, presets, ensureCalls, refreshes, surface }
}

test('/preset is in the sessionless dispatch gate', () => {
  // The gate is exactly where /preset used to create a session before the
  // user could switch (dispatchViaSession -> ensureSession). It must keep
  // /preset out of that path.
  assert.ok(SESSIONLESS_COMMANDS.has('preset'), 'SESSIONLESS_COMMANDS must keep /preset sessionless')
})

test('/keybindings opens sessionless without creating a session', async () => {
  const tuiSettings: TuiSettingsLike = {
    get: () => ({
      theme: 'auto',
      footer: 'full',
      fullscreen: 'off',
      busyEnter: 'queue',
      localShellSandbox: 'bypass',
      homeEndKeys: 'viewport',
    wheelScrollLines: '1',
      iconStyle: 'emoji',
      notificationMode: 'unfocused',
      notificationMethod: 'auto',
      keybindings: undefined,
    }),
    replace: async () => {},
  }
  const t = setup({ tuiSettings })
  try {
    const result = await t.runCommand('keybindings')
    assert.deepEqual(result, { kind: 'success' })
    assert.deepEqual(t.ensureCalls, [], '/keybindings must not create a session')
    const view = await t.view()
    assert.match(view, /Keyboard shortcuts/)
  } finally {
    t.app.stop()
  }
})

test('/preset with no session opens the English roster and creates nothing', async () => {
  const t = setup({})
  const result = await t.run('')
  assert.deepEqual(result, { kind: 'success' })
  assert.deepEqual(t.ensureCalls, [], '/preset must not create a session')
  const view = await t.view()
  assert.ok(view.includes('Standard mode (standard)'), `roster row missing:\n${view}`)
  assert.ok(view.includes('PTC mode (ptc)'), `roster row missing:\n${view}`)
  assert.ok(view.includes('Minimal mode (minimal)'), `roster row missing:\n${view}`)
  assert.ok(view.includes('Creator mode (cordis)'), `roster row missing:\n${view}`)
  assert.ok(!view.includes('标准模式'), `Chinese preset name leaked:\n${view}`)
  assert.ok(!view.includes('PTC 模式'), `Chinese preset name leaked:\n${view}`)
  // The selected row's full description renders below the list (web parity);
  // the wrap may split the trailing annotations across lines.
  assert.ok(view.includes('Full coding agent with file editing'), `description missing:\n${view}`)
  assert.ok(view.includes('· system'), `annotations missing:\n${view}`)
  assert.ok(view.includes('default'), `annotations missing:\n${view}`)
  t.app.stop()
})

test('/preset <id> with no session sets the pending preset, creating nothing', async () => {
  const t = setup({})
  const result = await t.run('minimal')
  assert.deepEqual(result, { kind: 'success', text: 'new sessions will start on preset minimal' })
  assert.equal(t.pending.value, 'minimal')
  assert.deepEqual(t.ensureCalls, [], '/preset must not create a session')
  t.app.stop()
})

test('/preset <id> with no session rejects an unknown id', async () => {
  const t = setup({})
  const result = await t.run('nope') as { kind: string; text: string }
  assert.equal(result.kind, 'error')
  assert.match(result.text, /not found/)
  assert.equal(t.pending.value, undefined)
  assert.deepEqual(t.ensureCalls, [])
  t.app.stop()
})

test('/preset default refuses a declared-but-broken preset without writing', async () => {
  const writes: unknown[] = []
  const t = setup({
    rows: [{ id: 'broken-one', description: 'visible but unusable' }],
    roster: async () => ({
      presets: [{ id: 'broken-one', broken: 'preset failed to mount: missing plugin', isDefault: false }],
    }),
    resolve: async () => ({ id: 'broken-one', broken: 'preset failed to mount: missing plugin' }),
    refreshCatalog: async () => standingOutcome(['glab']),
    settings: {
      get: () => undefined,
      mutate: async (_ns, patch) => { writes.push(patch); return undefined },
    },
  })
  const result = await t.run('default broken-one') as { kind: string; text: string }
  assert.equal(result.kind, 'error')
  assert.match(result.text, /preset failed to mount/u, 'the broken diagnostic surfaces')
  assert.deepEqual(writes, [], 'a broken preset is never persisted as the default')
  assert.deepEqual(t.refreshes, [])
  t.app.stop()
})

test('/preset <broken> sessionless never stages the broken preset', async () => {
  const t = setup({
    rows: [{ id: 'broken-one' }],
    roster: async () => ({
      presets: [{ id: 'broken-one', broken: 'preset failed to mount: missing plugin', isDefault: false }],
    }),
    resolve: async () => ({ id: 'broken-one', broken: 'preset failed to mount: missing plugin' }),
  })
  const result = await t.run('broken-one') as { kind: string; text: string }
  assert.equal(result.kind, 'error')
  assert.match(result.text, /preset failed to mount/u)
  assert.equal(t.pending.value, undefined, 'a broken preset is never staged as the pending preset')
  t.app.stop()
})

test('/preset reports an unknown id verbatim — no legacy alias hint', async () => {
  const t = setup({})
  const result = await t.run('code') as { kind: string; text: string }
  assert.equal(result.kind, 'error')
  assert.match(result.text, /preset "code" not found/)
  assert.doesNotMatch(result.text, /use preset "ptc"/, 'the retired code→ptc alias must not surface as a hint')
  assert.equal(t.pending.value, undefined)
  t.app.stop()
})

test('/preset code selects a legal custom code roster entry', async () => {
  const t = setup({ rows: [...SHIPPED_ROWS, { id: 'code', name: 'Custom code', trust: 'user' }] })
  const result = await t.run('code')
  assert.deepEqual(result, { kind: 'success', text: 'new sessions will start on preset code' })
  assert.equal(t.pending.value, 'code')
  t.app.stop()
})

test('/new refuses a registry default no declaration supplies — no guessed replacement', async () => {
  const created: { agentPreset?: string }[] = []
  const t = setup({
    defaultPresetId: 'code',
    agents: {
      create: async options => {
        created.push({ agentPreset: options.agentPreset })
        return {} as never
      },
      open: async () => ({}) as never,
    },
  })
  const result = await t.runCommand('new') as { kind: string; text?: string }
  assert.equal(result.kind, 'error', 'an invalid deployment default must surface, never silently become ptc')
  assert.match(result.text ?? '', /preset "code" not found/u)
  assert.deepEqual(t.presets.resolved, ['code'], 'exactly one registry resolution — no fallback probe')
  assert.deepEqual(created, [], 'no session is created on a refused default')
  t.app.stop()
})

test('/sessions opens input-first and shows projection-pending rows before enrichment settles', async () => {
  let resolveBatch!: (value: Map<string, { title?: string; preset?: string }>) => void
  const batch = new Promise<Map<string, { title?: string; preset?: string }>>(resolve => { resolveBatch = resolve })
  const t = setup({
    sessionReader: {
      list: async () => [{ id: 'session-cold', updatedAt: 10, createdAt: 10, cwd: '/ws', live: false }],
      projectionBatch: async () => batch,
    },
  })
  const result = await t.runCommand('sessions')
  assert.deepEqual(result, { kind: 'success' })
  // The overlay owns the input immediately (loading frame); the listing is
  // behind a scheduler yield, so poll until the row lands — still without
  // the pending preset.
  const initial = await t.view()
  assert.ok(initial.includes('Loading sessions…') || initial.includes('cold'),
    `the first frame must be interactive (loading row or listed row):\n${initial}`)
  await waitFor(async () => (await t.view()).includes('cold'))
  const pending = await t.view()
  assert.ok(!pending.includes('preset:standard'), 'a pending projection must not show an effective preset')
  resolveBatch(new Map([['session-cold', { preset: 'standard' }]]))
  await waitFor(async () => (await t.view()).includes('preset:standard'))
  t.app.stop()
})

test('/new honors the launch-time effective preset', async () => {
  const created: { agentPreset?: string }[] = []
  const t = setup({
    effectivePresetId: 'minimal',
    agents: {
      create: async options => {
        created.push({ agentPreset: options.agentPreset })
        return {} as never
      },
      open: async () => ({}) as never,
    },
  })
  const result = await t.runCommand('new') as { kind: string; text?: string }
  assert.deepEqual(result, { kind: 'success', text: 'started a fresh session' })
  assert.deepEqual(t.presets.resolved, ['minimal'])
  assert.deepEqual(created, [{ agentPreset: 'minimal' }])
  t.app.stop()
})

test('/preset picker with no session sets the pending preset on one Enter', async () => {
  const t = setup({})
  await t.run('')
  await t.view()
  t.vt.sendInput('\r')
  await t.view()
  assert.equal(t.pending.value, 'standard')
  const view = t.vt.getViewport().join('\n')
  assert.ok(view.includes('new sessions will start on preset standard'), `notify missing:\n${view}`)
  assert.ok(!view.includes('Standard mode (standard)'), `roster still open:\n${view}`)
  t.app.stop()
})

test('/preset picker switches a blank session with one Enter', async () => {
  const t = setup({ agent: fakeAgent('s1', []) })
  await t.run('')
  await t.view()
  t.vt.sendInput('\r')
  await t.view()
  assert.deepEqual(t.presets.selected, ['standard'], 'Enter must confirm the switch (values mechanism)')
  assert.equal(t.pending.value, undefined)
  const view = t.vt.getViewport().join('\n')
  assert.ok(view.includes('session preset switched to standard'), `notify missing:\n${view}`)
  assert.ok(!view.includes('Standard mode (standard)'), `roster still open:\n${view}`)
  t.app.stop()
})

test('/preset <id> switches a blank session', async () => {
  const t = setup({ agent: fakeAgent('s1', []) })
  const result = await t.run('minimal')
  assert.deepEqual(result, { kind: 'success', text: 'session preset switched to minimal' })
  assert.deepEqual(t.presets.selected, ['minimal'])
  t.app.stop()
})

test('/preset with a started session refuses without offering a roster', async () => {
  const t = setup({ agent: fakeAgent('s1', [{ type: 'turn/start' }]), sessionBlank: false })
  const result = await t.run('') as { kind: string; text: string }
  assert.equal(result.kind, 'error')
  assert.match(result.text, /only available in a new session/)
  const view = await t.view()
  assert.ok(!view.includes('Standard mode (standard)'), `roster offered for a started session:\n${view}`)
  assert.ok(view.includes('only available in a new session'), `notify missing:\n${view}`)
  assert.deepEqual(t.presets.selected, [])
  t.app.stop()
})

test('/preset on a blank session opens the roster (Host blank authority, not the transcript)', async () => {
  const t = setup({ agent: fakeAgent('s1', []), sessionBlank: true })
  const result = await t.run('') as { kind: string }
  assert.equal(result.kind, 'success')
  const view = await t.view()
  assert.ok(view.includes('Standard mode (standard)'), `a blank session must offer the roster:\n${view}`)
  t.app.stop()
})

test('/preset <id> with a started session refuses with the locked text', async () => {
  // The Host outcome is scripted explicitly (agent-preset/locked); the double
  // must NOT re-implement the Host blank state machine (§0.11).
  const t = setup({ agent: fakeAgent('s1', [{ type: 'turn/start' }]), sessionBlank: false, selectLocked: true })
  const result = await t.run('minimal') as { kind: string; text: string }
  assert.equal(result.kind, 'error')
  assert.match(result.text, /has already started; its agent preset is fixed/)
  assert.deepEqual(t.presets.selected, [], 'the Host refusal is the final race check')
  t.app.stop()
})

/** A skills-only applied outcome shaped like the coordinator's standing
 * install (the shape /preset and /reload report). */
function standingOutcome(skills: string[], notice?: string): CatalogRefreshOutcome {
  return {
    kind: 'applied',
    snapshot: Object.freeze({
      commands: Object.freeze([]),
      scopedCommands: Object.freeze([]),
      skills: Object.freeze(skills.map(name => Object.freeze({ name, description: name }))),
      issues: Object.freeze([]),
    }),
    ...notice === undefined ? {} : { notice },
  }
}

test('/preset <id> with no session requests a STANDING refresh of the new preset, creating nothing', async () => {
  const t = setup({ refreshCatalog: async () => standingOutcome(['glab']) })
  const result = await t.run('ptc')
  assert.equal(t.pending.value, 'ptc')
  assert.equal(t.refreshes.length, 1, 'the preset choice must request one standing refresh')
  assert.equal(t.refreshes[0]?.source, 'preset')
  assert.deepEqual(t.refreshes[0]?.target, { kind: 'preset', presetId: 'ptc' })
  assert.deepEqual(t.ensureCalls, [], '/preset must not create a session')
  t.app.stop()
})

test('/preset <id> with no session surfaces the standing degradation notice', async () => {
  const t = setup({
    refreshCatalog: async () => standingOutcome(['global-skill'], 'skill catalog unavailable for preset "ptc": preset exploded'),
  })
  const result = await t.run('ptc') as { kind: string; text: string }
  assert.equal(result.kind, 'success')
  assert.equal(result.text, 'new sessions will start on preset ptc')
  assert.equal(t.pending.value, 'ptc')
  await t.view()
  const view = t.vt.getViewport().join('\n')
  assert.ok(view.includes('preset exploded'), `degradation notice missing:\n${view}`)
  t.app.stop()
})

test('/preset default <id> with no override requests a standing refresh of the new default', async () => {
  const mutated: { ns: string; patch: unknown[] }[] = []
  const t = setup({
    refreshCatalog: async () => standingOutcome(['glab']),
    settings: {
      get: () => undefined,
      mutate: async (ns, patch) => { mutated.push({ ns, patch }); return undefined },
    },
  })
  const result = await t.run('default ptc') as { kind: string; text: string }
  assert.equal(result.kind, 'success')
  assert.equal(result.text, 'default preset set: ptc')
  assert.equal(mutated.length, 1)
  assert.equal(t.refreshes.length, 1, 'an unmasked default change must refresh the standing catalog')
  assert.deepEqual(t.refreshes[0]?.target, { kind: 'preset', presetId: 'ptc' })
  t.app.stop()
})

test('/preset default reports an unknown id verbatim — no legacy alias hint', async () => {
  const writes: unknown[] = []
  const t = setup({
    refreshCatalog: async () => standingOutcome(['glab']),
    settings: {
      get: () => undefined,
      mutate: async (_ns, patch) => { writes.push(patch); return undefined },
    },
  })
  const result = await t.run('default code') as { kind: string; text: string }
  assert.equal(result.kind, 'error')
  assert.match(result.text, /preset "code" not found/u)
  assert.doesNotMatch(result.text, /use preset "ptc"/u, 'the retired code→ptc alias must not surface as a hint')
  assert.deepEqual(writes, [], 'an unknown code id must never be persisted')
  assert.deepEqual(t.refreshes, [])
  t.app.stop()
})

test('/preset default code writes a legal custom roster entry', async () => {
  const writes: unknown[] = []
  const t = setup({
    rows: [...SHIPPED_ROWS, { id: 'code', name: 'Custom code', trust: 'user' }],
    refreshCatalog: async () => standingOutcome(['glab']),
    settings: {
      get: () => undefined,
      mutate: async (_ns, patch) => { writes.push(patch); return undefined },
    },
  })
  const result = await t.run('default code') as { kind: string; text: string }
  assert.deepEqual(result, { kind: 'success', text: 'default preset set: code' })
  assert.deepEqual(writes, [[{ op: 'set', path: ['selectedDefault'], value: 'code' }]])
  assert.deepEqual(t.refreshes[0]?.target, { kind: 'preset', presetId: 'code' })
  t.app.stop()
})

test('/preset default <id> masked by a pending preset does NOT refresh', async () => {
  const t = setup({
    refreshCatalog: async () => standingOutcome(['glab']),
    settings: {
      get: () => undefined,
      mutate: async () => undefined,
    },
  })
  t.pending.value = 'minimal'
  const result = await t.run('default ptc') as { kind: string; text: string }
  assert.equal(result.kind, 'success')
  assert.equal(t.refreshes.length, 0, 'the pending override masks the new default — no refresh')
  t.app.stop()
})

test('/preset default <id> validates then persists without reading a chooser-policy roster', async () => {
  // rc.2 retires the `modeSelectionEnabled` chooser policy: the default write
  // is no longer gated by (or even reads) the roster. A roster read here would
  // throw, so the mutation proves it never consults one.
  const writes: unknown[] = []
  let rosterReads = 0
  const t = setup({
    roster: async () => { rosterReads += 1; throw new Error('roster must not be read by /preset default') },
    refreshCatalog: async () => standingOutcome(['glab']),
    settings: {
      get: () => undefined,
      mutate: async (_ns, patch) => { writes.push(patch); return undefined },
    },
  })
  const result = await t.run('default ptc') as { kind: string; text?: string }
  assert.deepEqual(result, { kind: 'success', text: 'default preset set: ptc' })
  assert.equal(rosterReads, 0, 'the retired policy roster read must be gone')
  assert.deepEqual(t.presets.resolved, ['ptc'], 'the id is validated through the official registry')
  assert.deepEqual(writes, [[{ op: 'set', path: ['selectedDefault'], value: 'ptc' }]])
  assert.equal(t.refreshes.length, 1, 'the standing catalog follows the new default')
  // Read-only queries stay available.
  assert.equal((await t.run('status') as { kind: string }).kind, 'success')
  assert.equal((await t.run('default') as { kind: string }).kind, 'success')
  t.app.stop()
})

test('/reload with no session refreshes the STANDING catalog and reports the skill count', async () => {
  const t = setup({ refreshCatalog: async () => standingOutcome(['glab', 'find-skills']) })
  const result = await t.runCommand('reload') as { kind: string; text: string }
  assert.ok(result.kind === 'success')
  await t.view()
  const view = t.vt.getViewport().join('\n')
  assert.ok(view.includes('reloaded'), `reload notify missing:\n${view}`)
  assert.ok(view.includes('2 human skills'), `skill count missing:\n${view}`)
  assert.equal(t.refreshes.length, 1)
  assert.equal(t.refreshes[0]?.source, 'reload')
  assert.deepEqual(t.refreshes[0]?.target, { kind: 'preset', presetId: undefined },
    'the effective preset id (none pending) resolves to the deployment default')
  t.app.stop()
})

function reloadSettings(theme: string, onGet?: (count: number) => void): TuiSettingsLike {
  let reads = 0
  let currentTheme = theme
  return {
    get: () => {
      reads += 1
      onGet?.(reads)
      return { theme: currentTheme, iconStyle: 'emoji', footer: 'full', fullscreen: 'off', busyEnter: 'queue', localShellSandbox: 'bypass', homeEndKeys: 'viewport', wheelScrollLines: '1', notificationMode: 'unfocused', notificationMethod: 'auto' }
    },
    replace: doc => { currentTheme = doc.theme as string },
  }
}

function themeExtensions(paletteForSelectable: (value: string) => typeof darkColors | undefined): NonNullable<TuiCommandRunner['extensions']> {
  return { themes: { paletteForSelectable } } as unknown as NonNullable<TuiCommandRunner['extensions']>
}

test('/reload theme autodetect rechecks the latest persisted choice before applying', async () => {
  let settingsReads = 0
  const t = setup({
    tuiSettings: reloadSettings('auto', count => { settingsReads = count }),
  })
  let resolveBackground!: (value: { red: number; green: number; blue: number } | undefined) => void
  const pending = new Promise<{ red: number; green: number; blue: number } | undefined>(resolve => { resolveBackground = resolve })
  t.app.autoDetectTheme = async (options) => {
    assert.equal(options?.shouldApply?.(), true)
    // Simulate the settings panel changing the choice while OSC 11 is in flight.
    t.app.applyTheme('light')
    assert.equal(options?.shouldApply?.(), false)
    await pending
  }
  const result = await t.runCommand('reload') as { kind: string }
  assert.equal(result.kind, 'success')
  assert.ok(settingsReads >= 2, 'the late guard must read settings again')
  resolveBackground(undefined)
  t.app.stop()
})

test('/reload custom file theme applies without touching plugin health', async () => {
  const name = `reload-custom-${randomUUID()}`
  const file = join(customThemesDir(), `${name}.json`)
  mkdirSync(customThemesDir(), { recursive: true })
  writeFileSync(file, JSON.stringify({ name, colors: { primary: '#123456' } }))
  const cleared: string[] = []
  const recorded: string[] = []
  try {
    const t = setup({
      tuiSettings: reloadSettings(`custom:${name}`),
      extensions: themeExtensions(() => undefined),
      clearExtensionError: (ref) => cleared.push(ref.id),
      recordExtensionError: (ref) => recorded.push(ref.id),
    })
    const result = await t.runCommand('reload') as { kind: string }
    assert.equal(result.kind, 'success')
    assert.deepEqual(cleared, [], 'custom-file success must not clear plugin health')
    assert.deepEqual(recorded, [], 'custom-file success must not record plugin health')
    t.app.stop()
  } finally {
    rmSync(file, { force: true })
  }
})

test('/reload custom file theme failure does not record plugin health', async () => {
  const name = `reload-custom-failing-${randomUUID()}`
  const file = join(customThemesDir(), `${name}.json`)
  mkdirSync(customThemesDir(), { recursive: true })
  writeFileSync(file, JSON.stringify({ name, colors: { primary: '#123456' } }))
  const recorded: string[] = []
  try {
    const t = setup({
      tuiSettings: reloadSettings(`custom:${name}`),
      extensions: themeExtensions(() => undefined),
      recordExtensionError: (ref) => recorded.push(ref.id),
    })
    t.app.applyPalette = () => { throw new Error('custom palette failed') }
    const result = await t.runCommand('reload') as { kind: string }
    assert.equal(result.kind, 'success')
    assert.deepEqual(recorded, [], 'custom-file failure must not create plugin health')
    t.app.stop()
  } finally {
    rmSync(file, { force: true })
  }
})

test('/reload plugin theme failure records and later success clears its health', async () => {
  const id = `reload-plugin-${randomUUID()}`
  // The persisted value is the SOURCE-QUALIFIED identity
  // `plugin:<owner>/<id>` (the review's P2); the health ref carries the
  // CONTRIBUTION id (the part after the last slash).
  const sourceQualified = `plugin:test-owner/${id}`
  const recorded: string[] = []
  const cleared: string[] = []
  const t = setup({
    tuiSettings: reloadSettings(sourceQualified),
    extensions: themeExtensions(value => value === sourceQualified ? darkColors : undefined),
    recordExtensionError: (ref) => recorded.push(ref.id),
    clearExtensionError: (ref) => cleared.push(ref.id),
  })
  t.app.applyPalette = () => { throw new Error('plugin palette failed') }
  await t.runCommand('reload')
  assert.deepEqual(recorded, [id], 'plugin palette failure must record its contribution')
  t.app.applyPalette = () => {}
  await t.runCommand('reload')
  assert.deepEqual(cleared, [id], 'a later plugin palette success must clear its contribution')
  t.app.stop()
})

test('/reload unknown theme does not create plugin health', async () => {
  const name = `reload-missing-${randomUUID()}`
  const recorded: string[] = []
  const t = setup({
    tuiSettings: reloadSettings(`custom:${name}`),
    extensions: themeExtensions(() => undefined),
    recordExtensionError: (ref) => recorded.push(ref.id),
  })
  const result = await t.runCommand('reload') as { kind: string }
  assert.equal(result.kind, 'success')
  assert.deepEqual(recorded, [], 'unknown host theme must not create plugin health')
  t.app.stop()
})

test('/reload with a pending preset reports the standing degradation notice', async () => {
  const t = setup({
    refreshCatalog: async () => standingOutcome([], 'skill catalog unavailable for preset "ptc": preset exploded'),
  })
  t.pending.value = 'ptc'
  await t.runCommand('reload')
  await t.view()
  const view = t.vt.getViewport().join('\n')
  assert.ok(view.includes('0 human skills'), `skill count missing:\n${view}`)
  assert.ok(view.includes('preset exploded'), `degradation notice missing:\n${view}`)
  assert.deepEqual(t.refreshes[0]?.target, { kind: 'preset', presetId: 'ptc' })
  t.app.stop()
})

test('/reload with a live agent refreshes the AGENT target, never the standing path', async () => {
  const t = setup({
    agent: fakeAgent('s1', []),
    refreshCatalog: async () => ({
      kind: 'applied',
      snapshot: Object.freeze({
        commands: Object.freeze([Object.freeze({ name: 'builtin', description: 'b' })]),
        scopedCommands: Object.freeze([]),
        skills: Object.freeze([]),
        issues: Object.freeze([]),
      }),
    }),
  })
  await t.runCommand('reload')
  assert.equal(t.refreshes.length, 1)
  assert.equal(t.refreshes[0]?.target.kind, 'agent', 'a live session must refresh the agent target')
  t.app.stop()
})

test('/keybindings reload re-reads the settings document LAZILY (the explicit reload seam, no watch)', async () => {
  // Server/client migration boundary (review finding): the keybinding
  // reload is EXPLICIT — /keybindings reload calls `settings.get()` at
  // reload time and rebuilds the keymap. There is deliberately NO settings
  // `watch` callback: the TuiSettingsConfig port is get/replace only, and
  // a callback could not cross the process boundary in the future Remote
  // adapter. This test proves the command reads the CURRENT document at
  // reload time (a stale cached parse would miss a later settings edit).
  let settingsDoc = {
    theme: 'auto', footer: 'full', fullscreen: 'off', busyEnter: 'queue',
    localShellSandbox: 'bypass', homeEndKeys: 'viewport', wheelScrollLines: '1',
    iconStyle: 'emoji', notificationMode: 'unfocused', notificationMethod: 'auto',
    keybindings: { 'app.input.steer': 'ctrl+x' },
  }
  let reads = 0
  const tuiSettings: TuiSettingsLike = {
    // get/replace ONLY — no watch on the port (the structural type
    // enforces it: a watch method would not exist on TuiSettingsLike).
    get: () => { reads += 1; return settingsDoc },
    replace: async () => {},
  }
  const t = setup({ tuiSettings })
  // The runner applies the startup configuration ONCE at mount (this
  // command-surface harness mounts only the command layer, so apply the
  // same parse the runner's applyUserKeybindings performs).
  t.app.keybindingsManager().setUserConfiguration(parseUserKeybindings(tuiSettings.get().keybindings))
  const readsAfterSetup = reads
  // A later settings edit (the user changes the keybindings in the YAML);
  // the keymap must NOT change until /keybindings reload.
  settingsDoc = { ...settingsDoc, keybindings: { 'app.input.steer': 'ctrl+y' } }
  // The app's effective table still shows the startup keys (no watch).
  const before = t.app.keybindingsManager().keysFor('app.input.steer')
  assert.deepEqual(before, ['ctrl+x'], 'no watch: the keymap must keep the startup configuration until a reload')
  const result = await t.runCommand('keybindings', 'reload')
  assert.equal((result as { kind: string }).kind, 'success', 'the reload must succeed')
  assert.ok(reads > readsAfterSetup, 'the reload must re-read the settings document')
  const after = t.app.keybindingsManager().keysFor('app.input.steer')
  assert.deepEqual(after, ['ctrl+y'], 'the reload must apply the CURRENT settings document')
  t.app.stop()
})

test('/keybindings reload queues behind an editor write and applies the latest document', async () => {
  let settingsDoc: TuiSettingsLike['get'] extends () => infer T ? T : never = {
    theme: 'auto',
    footer: 'full',
    fullscreen: 'off',
    busyEnter: 'queue',
    localShellSandbox: 'bypass',
    homeEndKeys: 'viewport',
    wheelScrollLines: '1',
    iconStyle: 'emoji',
    notificationMode: 'unfocused',
    notificationMethod: 'auto',
    keybindings: { 'app.input.steer': 'ctrl+x' },
  }
  let writes = 0
  let firstWriteStarted!: () => void
  const firstStarted = new Promise<void>(resolve => { firstWriteStarted = resolve })
  let releaseFirst!: () => void
  const release = new Promise<void>(resolve => { releaseFirst = resolve })
  const tuiSettings: TuiSettingsLike = {
    get: () => settingsDoc,
    replace: async next => {
      writes += 1
      if (writes === 1) {
        firstWriteStarted()
        await release
      }
      settingsDoc = next
    },
  }
  const t = setup({ tuiSettings })
  const manager = t.app.keybindingsManager()
  manager.setUserConfiguration(parseUserKeybindings(settingsDoc.keybindings))
  const controller = new KeybindingEditorController({ settings: tuiSettings, manager })
  try {
    const editorWrite = controller.mutate({
      kind: 'add',
      action: 'app.todo.toggle',
      binding: { kind: 'direct', key: 'ctrl+y' },
    })
    await firstStarted
    let reloadSettled = false
    const reload = t.runCommand('keybindings', 'reload').then(result => {
      reloadSettled = true
      return result
    })
    await Promise.resolve()
    assert.equal(reloadSettled, false, 'reload must wait for the in-flight whole-document write')
    releaseFirst()
    const [editorResult, reloadResult] = await Promise.all([editorWrite, reload])
    assert.equal(editorResult.kind, 'applied')
    assert.equal((reloadResult as { kind: string }).kind, 'success')
    assert.equal(writes, 1)
    assert.deepEqual(settingsDoc.keybindings, {
      'app.input.steer': 'ctrl+x',
      'app.todo.toggle': ['ctrl+t', 'ctrl+y'],
    })
    assert.deepEqual(manager.keysFor('app.todo.toggle'), ['ctrl+t', 'ctrl+y'])
  } finally {
    releaseFirst()
    t.app.stop()
    manager.dispose()
  }
})

test('/keybindings reset queues behind an editor write and keeps the final reset authoritative', async () => {
  let settingsDoc: TuiSettingsLike['get'] extends () => infer T ? T : never = {
    theme: 'auto',
    footer: 'full',
    fullscreen: 'off',
    busyEnter: 'queue',
    localShellSandbox: 'bypass',
    homeEndKeys: 'viewport',
    wheelScrollLines: '1',
    iconStyle: 'emoji',
    notificationMode: 'unfocused',
    notificationMethod: 'auto',
    keybindings: undefined,
  }
  let writes = 0
  let firstWriteStarted!: () => void
  const firstStarted = new Promise<void>(resolve => { firstWriteStarted = resolve })
  let releaseFirst!: () => void
  const release = new Promise<void>(resolve => { releaseFirst = resolve })
  const tuiSettings: TuiSettingsLike = {
    get: () => settingsDoc,
    replace: async next => {
      writes += 1
      if (writes === 1) {
        firstWriteStarted()
        await release
      }
      settingsDoc = next
    },
  }
  const t = setup({ tuiSettings })
  const manager = t.app.keybindingsManager()
  manager.setUserConfiguration(parseUserKeybindings(settingsDoc.keybindings))
  const controller = new KeybindingEditorController({ settings: tuiSettings, manager })
  try {
    const editorWrite = controller.mutate({
      kind: 'add',
      action: 'app.todo.toggle',
      binding: { kind: 'direct', key: 'ctrl+y' },
    })
    await firstStarted
    const reset = t.runCommand('keybindings', 'reset')
    releaseFirst()
    const [editorResult, resetResult] = await Promise.all([editorWrite, reset])
    assert.equal(editorResult.kind, 'applied')
    assert.equal((resetResult as { kind: string }).kind, 'success')
    assert.equal('keybindings' in settingsDoc, false)
    assert.deepEqual(manager.keysFor('app.todo.toggle'), ['ctrl+t'])
    assert.equal(writes, 2)
  } finally {
    releaseFirst()
    t.app.stop()
    manager.dispose()
  }
})

test('/keybindings reset awaits the settings write, applies the cleared config, and reports its real outcome', async () => {
  // Review finding: the reset must not report success before the async
  // persistence write resolves — a failed write is an error result.
  // Review round 28: with the automatic settings watch removed (the reload
  // seam is explicit), a reset that only persisted would leave the RUNNING
  // keymap with the old overrides — the reset must also REBUILD from the
  // now-keybindings-less document.
  let replaced = 0
  const failing: TuiSettingsLike = {
    get: () => ({ theme: 'auto', footer: 'full', fullscreen: 'off', busyEnter: 'queue', localShellSandbox: 'bypass', homeEndKeys: 'viewport', wheelScrollLines: '1', iconStyle: 'emoji', notificationMode: 'unfocused', notificationMethod: 'auto', keybindings: { 'app.input.steer': 'ctrl+x' } }),
    replace: async () => { replaced += 1; throw new Error('write refused') },
  }
  let t = setup({ tuiSettings: failing })
  t.app.keybindingsManager().setUserConfiguration(parseUserKeybindings(failing.get().keybindings))
  const failed = await t.runCommand('keybindings', 'reset')
  assert.equal((failed as { kind: string }).kind, 'error', 'a failed write must report an error result')
  assert.ok((failed as { text: string }).text.includes('failed'), `error text missing: ${JSON.stringify(failed)}`)
  assert.equal(replaced, 1, 'the write must be attempted')
  assert.deepEqual(t.app.keybindingsManager().keysFor('app.input.steer'), ['ctrl+x'], 'a failed reset must keep the running keymap')
  t.app.dispose()

  let okReplaced = 0
  // Round 35: the success fixture is the reviewer's regression shape — the
  // storage may NOT be re-read after a successful write (a post-write read
  // could fail: disk reset + runtime "reset failed" fork). `get()` throws
  // on ANY read after the FIRST, so a post-write second read would fail
  // the test; the reset must project the cleared state locally from the
  // doc it already holds (`keybindings` deleted above) — write + local
  // projection, never GET → PUT → GET (the future Remote adapter
  // contract too). The counter is armed right before the command so the
  // harness's own setup reads do not trip it.
  let okReads = 0
  const ok: TuiSettingsLike = {
    get: () => {
      okReads += 1
      if (okReads > 1) throw new Error('no second read allowed')
      return { theme: 'auto', footer: 'full', fullscreen: 'off', busyEnter: 'queue', localShellSandbox: 'bypass', homeEndKeys: 'viewport', wheelScrollLines: '1', iconStyle: 'emoji', notificationMode: 'unfocused', notificationMethod: 'auto', keybindings: { 'app.input.steer': 'ctrl+x' } }
    },
    replace: async () => { okReplaced += 1 },
  }
  t = setup({ tuiSettings: ok })
  t.app.keybindingsManager().setUserConfiguration(parseUserKeybindings(ok.get().keybindings))
  assert.deepEqual(t.app.keybindingsManager().keysFor('app.input.steer'), ['ctrl+x'], 'the pre-reset keymap must carry the override')
  okReads = 0
  const succeeded = await t.runCommand('keybindings', 'reset')
  assert.equal((succeeded as { kind: string }).kind, 'success', 'a resolved write must report success')
  assert.equal(okReplaced, 1)
  assert.equal(okReads, 1, 'the reset must read the settings document exactly ONCE (no post-write read)')
  assert.deepEqual(t.app.keybindingsManager().keysFor('app.input.steer'), ['ctrl+s'], 'the reset must REBUILD the running keymap from the cleared document (defaults)')
  t.app.dispose()

  // Round 30: a throwing FIRST read must not escape the handler either —
  // the reset reports an error and the running keymap stays untouched.
  let readsFailing = 0
  const throwingRead: TuiSettingsLike = {
    get: () => { readsFailing += 1; throw new Error('settings read exploded') },
    replace: async () => {},
  }
  t = setup({ tuiSettings: throwingRead })
  t.app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.input.steer': 'ctrl+x' }))
  const readFailed = await t.runCommand('keybindings', 'reset')
  assert.equal((readFailed as { kind: string }).kind, 'error', 'a throwing first read must report an error result')
  assert.ok((readFailed as { text: string }).text.includes('failed'), `error text missing: ${JSON.stringify(readFailed)}`)
  assert.equal(readsFailing, 1, 'the initial read must be attempted once')
  assert.deepEqual(t.app.keybindingsManager().keysFor('app.input.steer'), ['ctrl+x'], 'a failed reset must keep the running keymap')
  t.app.stop()
})

test('/settings keeps the keyboard-shortcuts fallback when the settings read throws', async () => {
  let reads = 0
  const tuiSettings: TuiSettingsLike = {
    get: () => {
      reads += 1
      throw new Error('settings read exploded')
    },
    replace: async () => {},
  }
  const t = setup({ tuiSettings })
  const result = await t.runCommand('settings')
  assert.equal((result as { kind: string }).kind, 'success')
  t.vt.sendInput('keyboard')
  const view = await t.view()
  assert.match(view, /Keyboard shortcuts/)
  assert.match(view, /Unavailable/)
  assert.equal(reads, 1, 'the settings command should make one guarded initial read')
  t.app.stop()
})

test('/keybindings reload is fail-soft: a throwing settings read keeps the last-known-good keymap', async () => {
  // Review round 28: reload is now the ONLY reload seam, so its fail-soft
  // contract must match the startup application — a transient `get()`
  // failure must not throw out of the handler; the keymap keeps its
  // last-known-good configuration and the command reports an error.
  let failing = false
  const tuiSettings: TuiSettingsLike = {
    get: () => {
      if (failing) throw new Error('settings read exploded')
      return { theme: 'auto', footer: 'full', fullscreen: 'off', busyEnter: 'queue', localShellSandbox: 'bypass', homeEndKeys: 'viewport', wheelScrollLines: '1', iconStyle: 'emoji', notificationMode: 'unfocused', notificationMethod: 'auto', keybindings: { 'app.input.steer': 'ctrl+x' } }
    },
    replace: async () => {},
  }
  const t = setup({ tuiSettings })
  t.app.keybindingsManager().setUserConfiguration(parseUserKeybindings(tuiSettings.get().keybindings))
  assert.deepEqual(t.app.keybindingsManager().keysFor('app.input.steer'), ['ctrl+x'], 'startup configuration')
  failing = true
  const result = await t.runCommand('keybindings', 'reload')
  assert.equal((result as { kind: string }).kind, 'error', 'a throwing settings read must report an error result')
  assert.ok((result as { text: string }).text.includes('failed'), `error text missing: ${JSON.stringify(result)}`)
  assert.deepEqual(t.app.keybindingsManager().keysFor('app.input.steer'), ['ctrl+x'], 'the keymap must keep the last-known-good configuration')
  t.app.stop()
})

test('/keybindings reload refuses an absent settings service (no false "reloaded" success)', async () => {
  // Review round 35 P3: without the settings backend, reload must NOT
  // misrepresent "reading the defaults" as a success — it mirrors
  // /keybindings reset's explicit refusal, so a degraded / Remote
  // backend cannot claim a successful defaults read.
  const t = setup({ tuiSettings: undefined })
  const result = await t.runCommand('keybindings', 'reload')
  assert.equal((result as { kind: string }).kind, 'error', 'an absent settings service must report an error result')
  assert.ok((result as { text: string }).text.includes('unavailable'), `error text missing: ${JSON.stringify(result)}`)
  t.app.stop()
})

test('/preset <id> surfaces an indeterminate switch without retrying', async () => {
  const t = setup({ agent: fakeAgent('s1', []), selectFailure: new Error('append exploded after recompose') })
  const result = await t.run('minimal') as { kind: string; text: string }
  assert.equal(result.kind, 'error')
  assert.match(result.text, /append exploded after recompose/)
  assert.match(result.text, /do not retry/)
  assert.deepEqual(t.presets.selected, [], 'an ambiguous switch is never retried')
  t.app.stop()
})

test('/preset commits a Host-blank selection even when the transcript has a turn', async () => {
  // The fake Host select is authoritative (selectLocked: false) while the fake
  // transcript still has a turn/start: the command must open the roster AND
  // commit the switch, proving it never folds the transcript itself.
  const t = setup({ agent: fakeAgent('s1', [{ type: 'turn/start' }]), sessionBlank: true, selectLocked: false })
  const opened = await t.run('') as { kind: string }
  assert.equal(opened.kind, 'success')
  const view = await t.view()
  assert.ok(view.includes('Standard mode (standard)'), 'the Host turn-boundary authority wins over the transcript')
  t.vt.sendInput('\r') // pick the first roster row
  await t.view()
  assert.deepEqual(t.presets.selected, ['standard'],
    'the Host blank selection commits despite the transcript turn')
  t.app.stop()
})

test('/preset supersedes (never error-notifies) a switch whose Session was replaced during the catalog refresh', async () => {
  const state = { agent: fakeAgent('s1', []), generation: 1 }
  const t = setup({
    state,
    sessionBlank: true,
    selectLocked: false,
    refreshCatalog: async () => {
      // A transition lands while the refresh is in flight.
      state.generation = 2
      state.agent = fakeAgent('s2', [])
      return { kind: 'failed', error: 'superseded by a switch' }
    },
  })
  const result = await t.run('minimal') as { kind: string; text?: string }
  // v2 §0.2.1/§0.3.3: the committed switch lost local ownership — the surface
  // moved, so superseded is SILENT (no notice, no success text).
  assert.equal(result.kind, 'success')
  assert.equal(result.text, undefined)
  assert.deepEqual(t.presets.selected, ['minimal'],
    'the Host switch itself committed before the surface moved')
  t.app.stop()
})

test('/preset refuses an EMPTY transcript when the Host turn boundary says started', async () => {
  const t = setup({ agent: fakeAgent('s1', []), sessionBlank: false })
  const result = await t.run('') as { kind: string; text: string }
  assert.equal(result.kind, 'error')
  assert.match(result.text, /only available in a new session/)
  const view = await t.view()
  assert.ok(!view.includes('Standard mode (standard)'), 'no roster is offered for a Host-started Session')
  t.app.stop()
})

test('a newer preset pick supersedes an older pick on the same Session generation', async () => {
  const state = { agent: fakeAgent('s1', []), generation: 1 }
  let secondStarted = false
  const holder: { run?: (rawInput: string) => Promise<unknown> } = {}
  const t = setup({
    state,
    sessionBlank: true,
    selectLocked: false,
    refreshCatalog: async () => {
      if (!secondStarted) {
        secondStarted = true
        // A newer pick starts while the older refresh is in flight.
        await holder.run!('minimal')
      }
      return { kind: 'superseded', error: 'a newer refresh started' }
    },
  })
  holder.run = t.run
  const first = await t.run('standard') as { kind: string; text?: string }
  assert.equal(first.kind, 'success')
  assert.equal(first.text, undefined, 'a superseded pick is silent (no success text)')
  t.app.stop()
})

test('a newer sessionless preset pick supersedes an older one', async () => {
  let secondStarted = false
  const holder: { run?: (rawInput: string) => Promise<unknown> } = {}
  const t = setup({
    refreshCatalog: async () => {
      if (!secondStarted) {
        secondStarted = true
        // A newer sessionless pick starts while the older refresh is in flight.
        await holder.run!('minimal')
      }
      return { kind: 'applied', snapshot: {} as never }
    },
  })
  holder.run = t.run
  const first = await t.run('standard') as { kind: string; text?: string }
  assert.equal(first.kind, 'success')
  assert.equal(first.text, undefined, 'a superseded sessionless pick is silent')
  assert.equal(t.pending.value, 'minimal', 'the newest sessionless pick is the effective pending preset')
  t.app.stop()
})

test('an older /preset superseded during its registry resolve is silent', async () => {
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const t = setup({
    resolve: async (id?: string) => {
      calls += 1
      if (calls === 1) await gate
      return { id: id ?? 'standard' }
    },
  })
  const first = t.run('minimal') as Promise<{ kind: string; text?: string }>
  await new Promise(resolve => setImmediate(resolve))
  const second = t.run('standard') as Promise<{ kind: string; text?: string }>
  const newer = await second
  release()
  const older = await first
  // The older op lost ownership while its resolve was in flight: it must be
  // UI-silent and must not stage its preset (§0.2.5/§0.3.3).
  assert.equal(older.kind, 'success')
  assert.equal(older.text, undefined, 'a superseded op must not emit a stale notice')
  assert.equal(newer.kind, 'success')
  assert.equal(t.pending.value, 'standard', 'only the newest op stages its preset')
  t.app.stop()
})

test('a superseded picker roster read keeps the picker silent while the typed verb never reads the roster', async () => {
  const { SupersededReadError } = await import('../src/runtime/read-error.ts')
  let rosterReads = 0
  const t = setup({ roster: async () => { rosterReads += 1; throw new SupersededReadError('connection changed') } })
  // rc.2: the typed verb resolves through the official registry, never the
  // chooser roster, so a superseded roster cannot affect it.
  const verbResult = await t.run('minimal') as { kind: string; text?: string }
  assert.deepEqual(verbResult, { kind: 'success', text: 'new sessions will start on preset minimal' })
  assert.equal(rosterReads, 0, 'the typed verb path must not read the policy roster')
  // The picker does read the roster; a superseded read must stay silent.
  const pickerResult = await t.run('') as { kind: string; text?: string }
  assert.equal(pickerResult.kind, 'success')
  const view = await t.view()
  assert.ok(!view.includes('connection changed'), `no stale roster notice:\n${view}`)
  t.app.stop()
})

test('an older /preset whose Session generation moved during its resolve is silent', async () => {
  const state = { agent: undefined as ReturnType<typeof fakeAgent> | undefined, generation: 1 }
  const t = setup({
    state,
    resolve: async (id?: string) => {
      // A /new/switch lands while the registry resolve is in flight, and a new
      // blank Agent appears: the old sessionless operation must NOT apply to it.
      state.generation = 2
      state.agent = fakeAgent('s2', [])
      return { id: id ?? 'standard' }
    },
  })
  const result = await t.run('minimal') as { kind: string; text?: string }
  assert.equal(result.kind, 'success')
  assert.equal(result.text, undefined, 'a generation-moved op is silent')
  assert.deepEqual(t.presets.selected, [], 'the stale op must not apply its preset to the new Session')
  assert.equal(t.pending.value, undefined, 'no sessionless intent is staged onto the moved surface')
  t.app.stop()
})

test('a /preset picker opened on S1 cannot switch S2 after a session switch (subject fence)', async () => {
  const state = { agent: fakeAgent('s1', []), generation: 1 }
  const t = setup({ state, sessionBlank: true })
  await t.run('') // open the picker on S1
  await t.vt.waitForRender()
  // Prove the overlay actually opened (not a vacuous early return).
  assert.match(t.vt.getViewport().join('\n'), /standard/i, 'the preset picker must open before the switch')
  // A Session switch lands AFTER the overlay opened.
  state.agent = fakeAgent('s2', [])
  state.generation = 2
  t.vt.sendInput('\r') // submit the STALE overlay
  await t.vt.waitForRender()
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(t.presets.selected, [], 'a stale preset picker must not switch the new Session')
  t.app.stop()
})

test('a sessionless /preset picker cannot switch a Session that appeared in the same generation', async () => {
  const state = { agent: undefined as ReturnType<typeof fakeAgent> | undefined, generation: 1 }
  const t = setup({ state })
  await t.run('') // sessionless picker (owner sessionId === undefined)
  await t.vt.waitForRender()
  assert.match(t.vt.getViewport().join('\n'), /standard/i, 'the sessionless preset picker must open before the create')
  // A first create publishes a live Agent BEFORE the generation bump.
  state.agent = fakeAgent('s1', [])
  t.vt.sendInput('\r') // submit the stale sessionless overlay
  await t.vt.waitForRender()
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(t.presets.selected, [], 'a stale sessionless picker must not switch the new live Session')
  t.app.stop()
})

test('typed /preset whose subject drifts during resolve() is superseded', async () => {
  const state = { agent: undefined as ReturnType<typeof fakeAgent> | undefined, generation: 1 }
  const t = setup({
    state,
    resolve: async (id?: string) => {
      state.agent = fakeAgent('s2', [])
      return { id: id ?? 'standard', trust: 'system', path: `/presets/${id ?? 'standard'}` }
    },
  })
  const result = await t.run('minimal') as { kind: string; text?: string }
  assert.equal(result.kind, 'success')
  assert.equal(result.text, undefined)
  assert.deepEqual(t.presets.selected, [], 'a subject that drifts during resolve must not stage or switch')
  assert.equal(t.pending.value, undefined)
  t.app.stop()
})

test('a /preset whose subject moves during the Host switch stays silent (transition-await fence)', async () => {
  const state = { agent: fakeAgent('s1', []), generation: 1 }
  const t = setup({
    state,
    selectLocked: true,
    selectHook: () => {
      // The subject moves to another Session in the SAME generation while the
      // official Host switch is in flight; the switch then refuses (locked).
      state.agent = fakeAgent('s2', [])
    },
  })
  const result = await t.run('minimal') as { kind: string; text?: string }
  assert.equal(result.kind, 'success', 'a drifted subject must not surface the stale lock rejection')
  assert.equal(result.text, undefined, 'a drifted subject is silent')
  assert.deepEqual(t.presets.selected, [], 'the Host refusal never committed')
  assert.ok(!t.vt.getViewport().join('\n').includes('locked'), 'no stale lock notice is rendered')
  t.app.stop()
})

test('a /preset picker whose Session identity drifts during the roster read never opens', async () => {
  const state = { agent: fakeAgent('s1', []) as ReturnType<typeof fakeAgent> | undefined, generation: 1 }
  const t = setup({
    state,
    sessionBlank: true,
    roster: async () => {
      // The subject moves to another Session in the SAME generation while the
      // roster read is in flight.
      state.agent = fakeAgent('s2', [])
      return {
        presets: SHIPPED_ROWS.map(row => ({ id: row.id, isDefault: row.id === 'standard' })),
      }
    },
  })
  await t.run('')
  await t.vt.waitForRender()
  assert.ok(!t.vt.getViewport().join('\n').includes('standard'),
    'the stale picker must never open on the newly appeared Session')
  t.app.stop()
})

// ── preset-selection presentation (rc.2 roster shape) ──
//
// rc.2 retired the `modeSelectionEnabled` chooser policy: `/preset` is a
// normal TUI command, advertised whenever the command catalog is healthy and
// refused only by the official registry at execution time. These regressions
// pin that the presentation no longer depends on a deployment policy flag.

const EMPTY_SURFACE_SNAPSHOT = Object.freeze({
  commands: Object.freeze([]),
  scopedCommands: Object.freeze([]),
  skills: Object.freeze([]),
  issues: Object.freeze([]),
}) as never

test('/preset stays advertised when the command catalog is healthy (no chooser policy)', async () => {
  const t = setup({ commandsListRegistered: true, height: 80 })
  t.surface.installSnapshot(EMPTY_SURFACE_SNAPSHOT)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(t.app.commandCompletionsForTest().some(command => command.name === 'preset'),
    '/preset must be a normal candidate without any roster policy')
  await t.runCommand('help')
  await t.vt.waitForRender()
  t.vt.sendInput('preset')
  await t.vt.waitForRender()
  const view = await t.view()
  assert.ok(view.includes('Show or switch the session agent preset'), '/help lists /preset')
  t.app.stop()
})

test('a rosterless deployment keeps /preset visible and refuses at execution', async () => {
  const t = setup({ commandsListRegistered: true, noPresets: true })
  t.surface.installSnapshot(EMPTY_SURFACE_SNAPSHOT)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(t.app.commandCompletionsForTest().some(command => command.name === 'preset'),
    'an unavailable roster must not hide the command')
  const result = await t.run('minimal') as { kind: string; text?: string }
  assert.equal(result.kind, 'error')
  assert.match(result.text ?? '', /agent presets unavailable/)
  t.app.stop()
})

test('a sessionless /preset stages the next preset without reading a policy roster', async () => {
  let rosterReads = 0
  const t = setup({ roster: async () => { rosterReads += 1; throw new Error('no policy roster read') } })
  const result = await t.run('minimal') as { kind: string; text?: string }
  assert.deepEqual(result, { kind: 'success', text: 'new sessions will start on preset minimal' })
  assert.equal(t.pending.value, 'minimal')
  assert.equal(rosterReads, 0, 'the sessionless selection must not read a chooser-policy roster')
  t.app.stop()
})
