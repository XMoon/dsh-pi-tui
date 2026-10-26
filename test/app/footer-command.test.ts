/**
 * Headless tests for the /footer command (plan §15.2/§15.8): sessionless
 * (usable before any session), opens the configurator, S on the Row
 * Selector saves through the runner's applyFooterSettings + the settings
 * document, Esc cancels.
 * @module @xmoon76/dsh-pi-tui/footer-command.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { afterEach, test } from 'node:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { Context } from '@deepseek-ai/cordis'
import { TuiApp } from '../../src/tui-app.ts'
import { registerTuiCommands, type TuiCommandRunner, type TuiSettingsLike } from '../../src/commands.ts'
import { DEFAULT_FOOTER_LAYOUT } from '../../src/domain/footer/presets.ts'
import type { FooterLayoutV1 } from '../../src/tui/footer/presentation-types.ts'
import type { FooterCustomItemSettings } from '../../src/domain/footer/custom-items.ts'
import { FooterDynamicItemRuntime } from '../../src/tui/footer/dynamic-item-runtime.ts'
import { activeFooterItemIds, executableCommandItemIds } from '../../src/domain/footer/custom-items.ts'
import { serializeTuiSettingsMutation } from '../../src/runtime/config-port.ts'
import { DirectConfigPort } from '../../src/runtime/direct/config-direct.ts'
import { DirectCatalogPort } from '../../src/runtime/direct/catalog-direct.ts'
import { DirectHostFilePort } from '../../src/runtime/direct/host-file-direct.ts'
import { emptyStatusSnapshot } from '../../src/domain/status/types.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { sessionScopeFacts } from '../support/session-scope-facts.ts'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'
import { selectSettingsCategory } from '../support/settings-rail.ts'


/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test — the process slot (the vendored fork
 * keybindings are process-global) is released only by the FINAL dispose,
 * never by stop() (see src/tui/process-slot.ts). */
const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

/** Capture the ONE Footer-page `onSave` the `/footer` deeplink builds through
 *  `TuiApp.openSettingsWorkspace` → `createFooterConfiguratorPage` →
 *  `createFooterConfiguratorPanel`, without mounting a second screen. */
function captureFooterSaves(app: TuiApp): {
  readonly saves: Array<Parameters<TuiApp['createFooterConfiguratorPanel']>[0]['onSave']>
  /** The LAST `/footer` deeplink's full workspace intents (same-lease page,
   *  serialized row writer and keybinding page factory). */
  readonly workspace: () => Parameters<TuiApp['openSettingsWorkspace']>[1] | undefined
} {
  const saves: Array<Parameters<TuiApp['createFooterConfiguratorPanel']>[0]['onSave']> = []
  let lastOptions: Parameters<TuiApp['openSettingsWorkspace']>[1] | undefined
  app.createFooterConfiguratorPanel = ((options: Parameters<TuiApp['createFooterConfiguratorPanel']>[0]) => {
    saves.push(options.onSave)
    return {
      title: 'Footer layout',
      focused: false,
      handleInput: () => {},
      setMaxRows: () => {},
      dispose: () => {},
      isDisposed: () => false,
      render: () => [''],
    } as unknown as ReturnType<TuiApp['createFooterConfiguratorPanel']>
  }) as TuiApp['createFooterConfiguratorPanel']
  app.openSettingsWorkspace = ((_source: Parameters<TuiApp['openSettingsWorkspace']>[0], options: Parameters<TuiApp['openSettingsWorkspace']>[1]) => {
    lastOptions = options
    // ONLY the footer deeplink mounts the page; `/settings` merely exposes the
    // workspace intents (row writer + keyboard page).
    if (options.initialSpecialist === 'footer-configurator') {
      options.createFooterConfiguratorPage?.(() => {}, () => {})
    }
    return {
      close: () => {},
      refreshRow: () => {},
      whenInitialSpecialistSettled: async () => ({ ok: true as const }),
    }
  }) as TuiApp['openSettingsWorkspace']
  return {
    saves,
    workspace: () => lastOptions,
  }
}

/** A ready-backend view over one real ConfigPort (the port's other semantics are
 *  unchanged): the Footer-mode row only offers candidates on a current backend. */
function readyConfig(port: TuiCommandRunner['config']): TuiCommandRunner['config'] {
  return new Proxy(port, {
    get: (target, property) => property === 'configReadiness'
      ? () => 'ready' as const
      : Reflect.get(target, property, target),
  })
}

/** Bounded wall-clock spin (setImmediate turns, never a fixed setTimeout):
 * the repo's headless-test discipline for "wait a bounded window, then
 * assert the absence that must hold after it". */
async function spin(ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
}

/** A REAL FooterDynamicItemRuntime for the no-exec save-boundary tests.
 * The stub applyFooterSettings mirrors the real applyFooterSettings' PR D
 * sync (trusted definitions + active layout ids), so the tests prove the
 * SAVE BOUNDARY end to end: the runtime can only ever see definitions a
 * successful save committed — never a draft, never a failed save. */
function wireRuntimeApply(app: TuiApp): FooterDynamicItemRuntime {
  return new FooterDynamicItemRuntime({
    snapshot: () => emptyStatusSnapshot(),
    width: () => 100,
    height: () => 30,
    signal: new AbortController().signal,
    onValue: (id, value) => app.setFooterCommandItemValue(id, value),
  })
}

/** The PR D part of the real applyFooterSettings: sync the runtime with
 * the trusted (saved) command definitions + the EXECUTABLE ids (trusted ∩
 * authorized ∩ rendered). A /footer save's validated layout is both the
 * authorization and the rendered layout; without one nothing is
 * executable in these tests (no USER-layer layout is wired). */
function syncRuntimeApply(
  runtime: FooterDynamicItemRuntime,
  app: TuiApp,
  savedCustomItems: readonly FooterCustomItemSettings[] | undefined,
  savedLayout: FooterLayoutV1 | undefined,
): void {
  const trusted = (savedCustomItems ?? []).filter((item): item is import('../../src/domain/footer/custom-items.ts').FooterCustomCommandItemSettings => item.kind === 'command')
  const authorized = savedLayout === undefined ? new Set<string>() : activeFooterItemIds(savedLayout)
  const executable = executableCommandItemIds(trusted, authorized, app.getEffectiveFooterLayout())
  runtime.sync(trusted, executable)
}

/** A fake commands service capturing registrations. */
function fakeCommands(): { defs: Array<{ name: string; handler?: unknown }>; service: unknown } {
  const defs: Array<{ name: string; handler?: unknown }> = []
  return {
    defs,
    service: {
      register: (def: { name: string; handler?: unknown }): (() => void) => {
        defs.push(def)
        return () => {}
      },
      list: () => [],
      find: () => undefined,
      execute: async () => undefined,
    },
  }
}

/** A fake settings document. */
function fakeSettings(initial: { footer: string; footerLayout?: unknown; footerFallbackMode?: string; footerCustomItems?: unknown }): {
  value: TuiSettingsLike
  doc: { footer: string; footerLayout?: unknown; footerFallbackMode?: string; footerCustomItems?: unknown }
} {
  const doc = { ...initial }
  return {
    doc,
    value: {
      get: () => ({
        theme: 'auto',
        iconStyle: 'emoji',
        footer: doc.footer,
        footerLayout: doc.footerLayout,
        footerFallbackMode: doc.footerFallbackMode,
        footerCustomItems: doc.footerCustomItems as never,
        fullscreen: 'on',
        busyEnter: 'queue',
        localShellSandbox: 'bypass',
        homeEndKeys: 'viewport',
        wheelScrollLines: '1',
        notificationMode: 'unfocused', terminalProgress: 'on', notificationMethod: 'auto',
      }),
      replace: (next: { footer: string; footerLayout?: unknown; footerFallbackMode?: string; footerCustomItems?: unknown }) => {
        doc.footer = next.footer
        doc.footerLayout = next.footerLayout
        doc.footerFallbackMode = next.footerFallbackMode
        doc.footerCustomItems = next.footerCustomItems
        return undefined
      },
    },
  }
}

test('footer, focus, and fullscreen writes share one FIFO at the live commit point', async () => {
  let doc: ReturnType<TuiSettingsLike['get']> = {
    theme: 'auto',
    iconStyle: 'emoji',
    footer: 'custom',
    footerLayout: { source: 'old' },
    footerCustomItems: [],
    fullscreen: 'on',
    busyEnter: 'queue',
    localShellSandbox: 'bypass',
    homeEndKeys: 'viewport',
    wheelScrollLines: '1',
    notificationMode: 'unfocused', terminalProgress: 'on', notificationMethod: 'auto',
  }
  const pending: Array<{ next: ReturnType<TuiSettingsLike['get']>; resolve: () => void }> = []
  const settings: TuiSettingsLike = {
    get: () => ({ ...doc }),
    replace: (next) => new Promise<void>(resolve => pending.push({ next, resolve })),
  }
  const footerWrite = serializeTuiSettingsMutation(settings, () => settings.replace({ ...settings.get(), footerLayout: { source: 'footer' } }))
  const displayWrite = serializeTuiSettingsMutation(settings, () => settings.replace({ ...settings.get(), displayPreset: 'focus' }))
  const fullscreenWrite = serializeTuiSettingsMutation(settings, () => settings.replace({ ...settings.get(), fullscreen: 'off' }))
  const flush = async (): Promise<void> => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  }

  await flush()
  assert.equal(pending.length, 1, 'the focus and fullscreen writes must wait behind footer')
  assert.deepEqual(pending[0]!.next.footerLayout, { source: 'footer' })
  doc = { ...pending[0]!.next }
  pending[0]!.resolve()
  await flush()
  assert.equal(pending.length, 2, 'the display write must start only after footer settles')
  assert.deepEqual(pending[1]!.next.footerLayout, { source: 'footer' })
  assert.equal(pending[1]!.next.displayPreset, 'focus')
  doc = { ...pending[1]!.next }
  pending[1]!.resolve()
  await flush()
  assert.equal(pending.length, 3, 'fullscreen must start only after the display write settles')
  assert.deepEqual(pending[2]!.next.footerLayout, { source: 'footer' })
  assert.equal(pending[2]!.next.displayPreset, 'focus')
  assert.equal(pending[2]!.next.fullscreen, 'off')
  doc = { ...pending[2]!.next }
  pending[2]!.resolve()
  await Promise.all([footerWrite, displayWrite, fullscreenWrite])
})

test('a failed whole-document settings write does not block later queued writes', async () => {
  const doc: ReturnType<TuiSettingsLike['get']> = {
    theme: 'auto',
    iconStyle: 'emoji',
    footer: 'default',
    fullscreen: 'on',
    busyEnter: 'queue',
    localShellSandbox: 'bypass',
    homeEndKeys: 'viewport',
    wheelScrollLines: '1',
    notificationMode: 'unfocused', terminalProgress: 'on', notificationMethod: 'auto',
  }
  let calls = 0
  let rejectFirst: (error: Error) => void = () => {}
  let resolveSecond: () => void = () => {}
  const settings: TuiSettingsLike = {
    get: () => ({ ...doc }),
    replace: () => {
      calls += 1
      if (calls === 1) return new Promise<void>((_resolve, reject) => { rejectFirst = reject })
      return new Promise<void>(resolve => { resolveSecond = resolve })
    },
  }
  const first = serializeTuiSettingsMutation(settings, () => settings.replace({ ...settings.get(), footer: 'custom' }))
  const second = serializeTuiSettingsMutation(settings, () => settings.replace({ ...settings.get(), displayPreset: 'focus' }))
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
  assert.equal(calls, 1)
  const firstOutcome = assert.rejects(first, /settings failure/)
  rejectFirst(new Error('settings failure'))
  await firstOutcome
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
  assert.equal(calls, 2, 'the queue must advance after a rejection')
  resolveSecond()
  await second
})

test('/footer is sessionless and opens the configurator; S saves and persists', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const commands = fakeCommands()
  ctx.provide('commands', commands.service as never)
  const customItems = [{ schemaVersion: 1 as const, id: 'user:environment', kind: 'text' as const, text: 'PROD', tone: 'warning' as const }]
  const futureCustomItem = { schemaVersion: 1, id: 'user:future', kind: 'future-kind', command: 'echo future' }
  // A KNOWN kind carrying a future field is forward-compatible raw data
  // too: an unrelated save must never normalize it away (PR D review).
  const futureFieldCommand = { schemaVersion: 1, id: 'user:future-command', kind: 'command', command: 'echo future', futureField: { version: 2 } }
  const persistedCustomItems = [...customItems, futureCustomItem, futureFieldCommand]
  app.setFooterCustomItems(customItems)
  const settings = fakeSettings({ footer: 'default', footerCustomItems: persistedCustomItems })
  ctx.provide('settings', { describe: () => [{ ns: 'tui-app', user: { footerCustomItems: persistedCustomItems } }] } as never)
  const applied: Array<{ footer: string; footerLayout?: unknown; footerCustomItems?: unknown }> = []
  const runner: TuiCommandRunner = {
    ctx,
    app,
    diag: { warn: () => {}, error: () => {}, info: () => {} } as never,
    get defaultIntentOutcome() { return undefined },
    ...sessionScopeFacts(() => undefined, () => 0),
    hostShellCompletion: true,
    transcriptExportAvailable: true,
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
    sessionReader: { list: async () => [], search: async () => ({ items: [], hasMore: false }), projectionBatch: async () => new Map(), blank: () => undefined, measureContext: () => undefined,
      turnOutline: () => undefined,
      sessionStatus: () => undefined },
    sessionWriter: { prompt: async () => ({ kind: 'committed' as const, value: undefined }), updateQueue: async () => ({ kind: 'committed' as const, value: undefined }), cancel: async () => ({ kind: 'committed' as const, value: undefined }), rename: async (_sessionId: string, title: string) => ({ kind: 'committed' as const, value: { title } }), refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }) },

    interaction: { questions: { subscribe: () => undefined,  onRequest: () => true, snapshot: () => undefined, claimTimedWait: async () => undefined, answerContinued: async () => 'not-continued' as const }, onApprovalRequest: () => {}, setApprovalPolicy: () => true },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    hostFile: new DirectHostFilePort(() => undefined),
    commandRegistry: ctx.get('commands') as never,
    clientCommands: createClientCommandRegistry(parseCommand),
    cwd: '/ws',
    sessionCwd: () => '/ws',
    imageStore: {} as never,
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
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
    extensions: undefined,
    exit: () => {},
    applyFooterSettings: (doc) => {
      if (doc === undefined) return
      applied.push({ ...doc })
      // Mirror the runner's apply: custom → set the layout on the app.
      if (doc.footer === 'custom') {
        app.setFooterPreset('full')
        app.setFooterLayout(doc.footerLayout as never)
      }
    },
  }
  registerTuiCommandsWithDirectSeams(runner)
  const def = commands.defs.find(entry => entry.name === 'footer')
  assert.ok(def?.handler !== undefined, 'footer handler missing')
  const result = await (def.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: '' })
  assert.deepEqual(result, { kind: 'success' })
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Select row to edit'), `the Footer page must open:\n${view}`)
  // Enter the row, toggle the first item out, walk back to the selector,
  // and save (S — the Row Selector is the save point).
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput(' ')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('s')
  await vt.waitForRender()
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
  assert.equal(applied.length, 1, 'S must apply the layout')
  assert.equal(applied[0]!.footer, 'custom')
  assert.equal(settings.doc.footer, 'custom', 'the settings document must persist')
  // Saving a custom layout IS a native-mode change: footerFallbackMode
  // must ride along, or a later command-mode restart would fall back to
  // the mode the user had BEFORE opening /footer (the review's P2).
  assert.equal(settings.doc.footerFallbackMode, 'custom', 'the fallback mode must persist as custom')
  const saved = settings.doc.footerLayout as { rows: Array<{ left: Array<{ id: string }> }> }
  assert.ok(!saved.rows[0]!.left.some(ref => ref.id === 'view-scope'), 'the persisted layout must reflect the toggle')
  assert.deepEqual(settings.doc.footerCustomItems, persistedCustomItems, 'saving the layout must preserve known and future custom definitions')
  assert.deepEqual(applied[0]!.footerCustomItems, customItems, 'apply must carry custom definitions alongside the layout')
  assert.equal(app.getFooterMode(), 'custom', 'the app must apply the custom layout')
  // Saving closed the PAGE but the SAME Settings workspace still owns the
  // screen (the user returns to the Appearance row). Leave it before opening
  // the alias, exactly like a user would.
  vt.sendInput('\x1b') // rows -> categories
  await vt.waitForRender()
  vt.sendInput('\x1b') // categories -> close
  await vt.waitForRender()

  // The approved `/statusline` alias (other-agent muscle memory) registers
  // the SAME handler and opens the SAME configurator — `/status` keeps
  // priority matching, this pairing is explicit (see the registration
  // comment in commands.ts).
  const alias = commands.defs.find(entry => entry.name === 'statusline')
  assert.ok(alias?.handler !== undefined, 'the statusline alias must be registered')
  assert.equal(alias!.handler, def.handler, 'the alias must share the footer handler')
  const aliasResult = await (alias!.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: '' })
  assert.deepEqual(aliasResult, { kind: 'success' })
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('Select row to edit'), `the alias must open the Footer page`)
  // Esc closes the alias-opened panel without writing (applied stays 1).
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(applied.length, 1, 'Esc on the alias-opened panel must not write')
  app.stop()
})

test('/footer serializes overlapping saves and re-reads future USER definitions', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const commands = fakeCommands()
  ctx.provide('commands', commands.service as never)
  const known = { schemaVersion: 1 as const, id: 'user:environment', kind: 'text' as const, text: 'OLD', tone: 'warning' as const }
  const futureOne = { schemaVersion: 1, id: 'user:future-one', kind: 'future-kind', command: 'one' }
  const futureTwo = { schemaVersion: 1, id: 'user:future-two', kind: 'future-kind', command: 'two' }
  let userRaw: unknown[] = [known, futureOne]
  let currentDoc: ReturnType<TuiSettingsLike['get']> = {
    theme: 'auto',
    iconStyle: 'emoji',
    footer: 'default',
    fullscreen: 'on',
    busyEnter: 'queue',
    localShellSandbox: 'bypass',
    homeEndKeys: 'viewport',
    wheelScrollLines: '1',
    notificationMode: 'unfocused', terminalProgress: 'on', notificationMethod: 'auto',
    footerCustomItems: userRaw,
  }
  const pendingWrites: Array<{ next: ReturnType<TuiSettingsLike['get']>; resolve: () => void }> = []
  const settings: TuiSettingsLike = {
    get: () => ({ ...currentDoc, footerCustomItems: userRaw }),
    replace: (next) => new Promise<void>(resolve => pendingWrites.push({ next, resolve })),
  }
  ctx.provide('settings', { describe: () => [{ ns: 'tui-app', user: { footerCustomItems: userRaw } }] } as never)
  const capturedFooter = captureFooterSaves(app)
  const saveCallbacks = capturedFooter.saves
  const applied: Array<{ footerLayout?: unknown; footerCustomItems?: unknown }> = []
  const displayWrites: ('full' | 'focus' | 'compact')[] = []
  const persistedDisplayDocs: Record<string, unknown>[] = []
  let displayPreset: 'full' | 'focus' | 'compact' = 'full'
  const runner: TuiCommandRunner = {
    ctx,
    app,
    displayPreset: () => displayPreset,
    setDisplayPreset: (preset) => {
      if (displayPreset === preset) return { kind: 'unchanged', preset }
      displayPreset = preset
      displayWrites.push(preset)
      persistedDisplayDocs.push({ ...settings.get(), displayPreset: preset })
      return { kind: 'applied', preset }
    },
    diag: { warn: () => {}, error: () => {}, info: () => {} } as never,
    get defaultIntentOutcome() { return undefined },
    ...sessionScopeFacts(() => undefined, () => 0),
    hostShellCompletion: true,
    transcriptExportAvailable: true,
    currentSessionId: undefined,
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    defaultSelection: () => undefined,
    defaultIntent: undefined,
    setDefaultIntent: () => {},
    defaultIntentRecord: undefined,
    settleIntent: () => {},
    tuiSettings: settings,
    agents: {} as never,
    sessionReader: { list: async () => [], search: async () => ({ items: [], hasMore: false }), projectionBatch: async () => new Map(), blank: () => undefined, measureContext: () => undefined,
      turnOutline: () => undefined,
      sessionStatus: () => undefined },
    sessionWriter: { prompt: async () => ({ kind: 'committed' as const, value: undefined }), updateQueue: async () => ({ kind: 'committed' as const, value: undefined }), cancel: async () => ({ kind: 'committed' as const, value: undefined }), rename: async (_sessionId: string, title: string) => ({ kind: 'committed' as const, value: { title } }), refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }) },
    interaction: { questions: { subscribe: () => undefined,  onRequest: () => true, snapshot: () => undefined, claimTimedWait: async () => undefined, answerContinued: async () => 'not-continued' as const }, onApprovalRequest: () => {}, setApprovalPolicy: () => true },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    hostFile: new DirectHostFilePort(() => undefined),
    commandRegistry: ctx.get('commands') as never,
    clientCommands: createClientCommandRegistry(parseCommand),
    cwd: '/ws',
    sessionCwd: () => '/ws',
    imageStore: {} as never,
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
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
    extensions: undefined,
    exit: () => {},
    applyFooterSettings: (doc) => {
      if (doc !== undefined) applied.push({ footerLayout: doc.footerLayout, footerCustomItems: doc.footerCustomItems })
    },
  }
  registerTuiCommandsWithDirectSeams(runner)
  const footer = commands.defs.find(entry => entry.name === 'footer')
  const settingsCommand = commands.defs.find(entry => entry.name === 'settings')
  assert.ok(footer?.handler !== undefined)
  assert.ok(settingsCommand?.handler !== undefined)
  await (footer.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: '' })
  await (footer.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: '' })
  await (settingsCommand.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: '' })
  assert.equal(saveCallbacks.length, 2, 'each /footer deeplink builds ONE page save callback')
  const workspace = capturedFooter.workspace()
  assert.ok(workspace?.onCommit !== undefined, 'the /settings open exposes the ONE row writer')

  const layoutOne: FooterLayoutV1 = { schemaVersion: 1, rows: [{ left: [{ id: 'model' }], right: [] }] }
  const layoutTwo: FooterLayoutV1 = { schemaVersion: 1, rows: [{ left: [{ id: 'view-scope' }], right: [] }] }
  saveCallbacks[0]!(layoutOne, [{ ...known, text: 'ONE' }])
  // The workspace's Footer-mode row writer enters the SAME queue behind the
  // first page save (fire-and-forget like the UI's owned commit).
  void workspace!.onCommit!({ field: 'footer-mode', value: 'compact' })
  saveCallbacks[1]!(layoutTwo, [{ ...known, text: 'TWO' }])
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
  assert.equal(pendingWrites.length, 1, 'the settings and second footer saves must wait for the first write')
  assert.deepEqual(pendingWrites[0]!.next.footerCustomItems, [{ ...known, text: 'ONE' }, futureOne])

  const first = pendingWrites[0]!
  currentDoc = { ...first.next, footerCustomItems: first.next.footerCustomItems }
  userRaw = [...(first.next.footerCustomItems as unknown[]), futureTwo]
  currentDoc = { ...currentDoc, footerCustomItems: userRaw }
  first.resolve()
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
  assert.equal(pendingWrites.length, 2, 'the queued settings footer save must start after the first settles')
  assert.equal(pendingWrites[1]!.next.footer, 'compact')
  assert.deepEqual(pendingWrites[1]!.next.footerCustomItems, [{ ...known, text: 'ONE' }, futureOne, futureTwo])

  const modeWrite = pendingWrites[1]!
  currentDoc = { ...modeWrite.next, footerCustomItems: modeWrite.next.footerCustomItems }
  userRaw = [...(modeWrite.next.footerCustomItems as unknown[])]
  modeWrite.resolve()
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
  assert.equal(pendingWrites.length, 3, 'the second configurator save must wait for the settings footer write')
  assert.deepEqual(pendingWrites[2]!.next.footerCustomItems, [{ ...known, text: 'TWO' }, futureOne, futureTwo])

  const second = pendingWrites[2]!
  currentDoc = { ...second.next, footerCustomItems: second.next.footerCustomItems }
  userRaw = [...(second.next.footerCustomItems as unknown[])]
  second.resolve()
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
  assert.equal(applied.length, 3)
  assert.deepEqual(applied[1]!.footerLayout, layoutOne)
  assert.equal((applied[2]!.footerLayout as FooterLayoutV1).rows[0]!.left[0]!.id, 'view-scope')
  assert.deepEqual(app.getFooterCustomItems(), [{ ...known, text: 'TWO' }])

  // The keybinding editor is another whole-document writer introduced by
  // main. Its merged settings read must not promote a project definition into
  // USER when the user changes only a shortcut. The real command wiring uses
  // DirectConfigPort.rawForPersistence() through the projector hook.
  const projectOnly = { schemaVersion: 1, id: 'user:project-only', kind: 'text', text: 'PROJECT', tone: 'warning' }
  currentDoc = { ...currentDoc, footerCustomItems: [projectOnly] }
  const panel = workspace!.createKeybindingsPage?.(() => {}, () => {})
  assert.ok(panel !== undefined, 'the /settings open exposes the same-lease keyboard page')
  panel.handleInput('app.todo.toggle')
  panel.handleInput('\r')
  panel.handleInput('r')
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
  assert.equal(pendingWrites.length, 4, `the keybinding mutation must reach the settings writer\n${panel.render(100).join('\n')}`)
  const keybindingWrite = pendingWrites[3]!
  assert.deepEqual(keybindingWrite.next.footerCustomItems, userRaw, 'keybinding writes must use exact USER raw footer definitions')
  assert.equal(
    (keybindingWrite.next.footerCustomItems as Array<{ id: string }>).some(item => item.id === projectOnly.id),
    false,
    'the merged project definition must not be written to USER settings',
  )
  assert.deepEqual(keybindingWrite.next.keybindings, {}, 'the keybinding editor must still persist its own mutation')
  currentDoc = { ...keybindingWrite.next, footerCustomItems: userRaw }
  keybindingWrite.resolve()
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
  panel.dispose?.()
  app.stop()
})

test('/footer Esc cancels without writing', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const commands = fakeCommands()
  ctx.provide('commands', commands.service as never)
  const settings = fakeSettings({ footer: 'default' })
  const applied: Array<{ footer: string }> = []
  const runner: TuiCommandRunner = {
    ctx, app, diag: {} as never,
    get defaultIntentOutcome() { return undefined },
    ...sessionScopeFacts(() => undefined, () => 0),
    hostShellCompletion: true,
    transcriptExportAvailable: true,
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
    sessionReader: { list: async () => [], search: async () => ({ items: [], hasMore: false }), projectionBatch: async () => new Map(), blank: () => undefined, measureContext: () => undefined,
      turnOutline: () => undefined,
      sessionStatus: () => undefined },
    sessionWriter: { prompt: async () => ({ kind: 'committed' as const, value: undefined }), updateQueue: async () => ({ kind: 'committed' as const, value: undefined }), cancel: async () => ({ kind: 'committed' as const, value: undefined }), rename: async (_sessionId: string, title: string) => ({ kind: 'committed' as const, value: { title } }), refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }) },

    interaction: { questions: { subscribe: () => undefined,  onRequest: () => true, snapshot: () => undefined, claimTimedWait: async () => undefined, answerContinued: async () => 'not-continued' as const }, onApprovalRequest: () => {}, setApprovalPolicy: () => true },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    hostFile: new DirectHostFilePort(() => undefined),
    commandRegistry: ctx.get('commands') as never,
    clientCommands: createClientCommandRegistry(parseCommand),
    cwd: '/ws', sessionCwd: () => '/ws', imageStore: {} as never,
    copyToClipboard: async () => true, imageLimits: () => undefined, insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
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
    refreshStatus: () => {}, progressUpdatesState: { mode: 'milestones' }, responseStyleState: { style: 'default' }, gitAttributionState: { mode: 'off' }, focusEnabled: () => false, setFocusMode: () => {}, setNotificationMode: () => {}, currentNotificationMode: () => 'unfocused', currentNotificationMethod: () => 'auto', setTerminalProgressMode: () => {}, setNotificationMethod: () => {}, updateWelcomeCard: () => {},
    openJobView: () => {}, openTasksBrowser: () => {}, createPluginManagerPage: () => undefined, openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withWriter: async <T>(_scope: unknown, task: () => T | Promise<T>) => task(),
    withPromptAdmission: async <T>(_agent: unknown, _line: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {}, requestExit: () => {}, extensions: undefined, exit: () => {},
    applyFooterSettings: (doc) => { if (doc !== undefined) applied.push({ ...doc }) },
  }
  registerTuiCommandsWithDirectSeams(runner)
  const def = commands.defs.find(entry => entry.name === 'footer')
  await (def!.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: '' })
  await vt.waitForRender()
  // Enter the row and edit (the pool items must NOT appear on the row
  // page — Available is picker-only now), then walk back and cancel.
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput(' ')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(applied.length, 0, 'Esc must not apply')
  assert.equal(settings.doc.footer, 'default', 'the settings document must be untouched')
  assert.equal(app.getFooterMode(), 'default')
  app.stop()
})

test('/footer starts from the persisted custom layout when active', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const commands = fakeCommands()
  ctx.provide('commands', commands.service as never)
  const persisted = {
    schemaVersion: 1,
    rows: [{ left: [{ id: 'model' }], right: [] }],
  }
  const settings = fakeSettings({ footer: 'custom', footerLayout: persisted })
  const runner: TuiCommandRunner = {
    ctx, app, diag: {} as never,
    get defaultIntentOutcome() { return undefined },
    ...sessionScopeFacts(() => undefined, () => 0),
    hostShellCompletion: true,
    transcriptExportAvailable: true,
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
    sessionReader: { list: async () => [], search: async () => ({ items: [], hasMore: false }), projectionBatch: async () => new Map(), blank: () => undefined, measureContext: () => undefined,
      turnOutline: () => undefined,
      sessionStatus: () => undefined },
    sessionWriter: { prompt: async () => ({ kind: 'committed' as const, value: undefined }), updateQueue: async () => ({ kind: 'committed' as const, value: undefined }), cancel: async () => ({ kind: 'committed' as const, value: undefined }), rename: async (_sessionId: string, title: string) => ({ kind: 'committed' as const, value: { title } }), refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }) },

    interaction: { questions: { subscribe: () => undefined,  onRequest: () => true, snapshot: () => undefined, claimTimedWait: async () => undefined, answerContinued: async () => 'not-continued' as const }, onApprovalRequest: () => {}, setApprovalPolicy: () => true },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    hostFile: new DirectHostFilePort(() => undefined),
    commandRegistry: ctx.get('commands') as never,
    clientCommands: createClientCommandRegistry(parseCommand),
    cwd: '/ws', sessionCwd: () => '/ws', imageStore: {} as never,
    copyToClipboard: async () => true, imageLimits: () => undefined, insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
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
    refreshStatus: () => {}, progressUpdatesState: { mode: 'milestones' }, responseStyleState: { style: 'default' }, gitAttributionState: { mode: 'off' }, focusEnabled: () => false, setFocusMode: () => {}, setNotificationMode: () => {}, currentNotificationMode: () => 'unfocused', currentNotificationMethod: () => 'auto', setTerminalProgressMode: () => {}, setNotificationMethod: () => {}, updateWelcomeCard: () => {},
    openJobView: () => {}, openTasksBrowser: () => {}, createPluginManagerPage: () => undefined, openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withWriter: async <T>(_scope: unknown, task: () => T | Promise<T>) => task(),
    withPromptAdmission: async <T>(_agent: unknown, _line: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {}, requestExit: () => {}, extensions: undefined, exit: () => {},
    applyFooterSettings: () => {},
  }
  registerTuiCommandsWithDirectSeams(runner)
  const def = commands.defs.find(entry => entry.name === 'footer')
  await (def!.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: '' })
  await vt.waitForRender()
  // The selector lists the persisted layout's single row/item — the default
  // layout's items are not present.
  const view = vt.getViewport().join('\n')
  assert.match(view, /Row 1\s+1 item/u, `the persisted ONE-item layout must be listed:\n${view}`)
  assert.doesNotMatch(view, /Row 2/u, `the persisted layout has no second row:\n${view}`)
  app.stop()
})

test('/footer starts from the EFFECTIVE COMPACT layout (a compact user pressing Enter unchanged keeps one row)', async () => {
  // The review's P2: the old `getFooterLayout() ?? DEFAULT` fallback lost
  // the compact mode — opening /footer in compact mode and pressing Enter
  // unchanged saved the full TWO-ROW default as the custom layout. The
  // configurator must start from the CURRENT effective layout (the
  // compact preset here) so an unchanged save preserves the look.
  const ctx = new Context()
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  app.setFooterPreset('compact')
  const commands = fakeCommands()
  ctx.provide('commands', commands.service as never)
  const settings = fakeSettings({ footer: 'compact' })
  ctx.provide('settings', { describe: () => [{ ns: 'tui-app', user: {} }] } as never)
  const applied: Array<{ footer: string; footerLayout?: unknown }> = []
  const runner: TuiCommandRunner = {
    ctx, app, diag: {} as never,
    get defaultIntentOutcome() { return undefined },
    ...sessionScopeFacts(() => undefined, () => 0),
    hostShellCompletion: true,
    transcriptExportAvailable: true,
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
    sessionReader: { list: async () => [], search: async () => ({ items: [], hasMore: false }), projectionBatch: async () => new Map(), blank: () => undefined, measureContext: () => undefined,
      turnOutline: () => undefined,
      sessionStatus: () => undefined },
    sessionWriter: { prompt: async () => ({ kind: 'committed' as const, value: undefined }), updateQueue: async () => ({ kind: 'committed' as const, value: undefined }), cancel: async () => ({ kind: 'committed' as const, value: undefined }), rename: async (_sessionId: string, title: string) => ({ kind: 'committed' as const, value: { title } }), refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }) },
    interaction: { questions: { subscribe: () => undefined,  onRequest: () => true, snapshot: () => undefined, claimTimedWait: async () => undefined, answerContinued: async () => 'not-continued' as const }, onApprovalRequest: () => {}, setApprovalPolicy: () => true },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    hostFile: new DirectHostFilePort(() => undefined),
    commandRegistry: ctx.get('commands') as never,
    clientCommands: createClientCommandRegistry(parseCommand),
    cwd: '/ws', sessionCwd: () => '/ws', imageStore: {} as never,
    copyToClipboard: async () => true, imageLimits: () => undefined, insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
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
    refreshStatus: () => {}, progressUpdatesState: { mode: 'milestones' }, responseStyleState: { style: 'default' }, gitAttributionState: { mode: 'off' }, focusEnabled: () => false, setFocusMode: () => {}, setNotificationMode: () => {}, currentNotificationMode: () => 'unfocused', currentNotificationMethod: () => 'auto', setTerminalProgressMode: () => {}, setNotificationMethod: () => {}, updateWelcomeCard: () => {},
    openJobView: () => {}, openTasksBrowser: () => {}, createPluginManagerPage: () => undefined, openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withWriter: async <T>(_scope: unknown, task: () => T | Promise<T>) => task(),
    withPromptAdmission: async <T>(_agent: unknown, _line: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {}, requestExit: () => {}, extensions: undefined, exit: () => {},
    applyFooterSettings: (doc) => {
      if (doc === undefined) return
      applied.push({ ...doc })
      if (doc.footer === 'custom') {
        app.setFooterPreset('full')
        app.setFooterLayout(doc.footerLayout as never)
      }
    },
  }
  registerTuiCommandsWithDirectSeams(runner)
  const def = commands.defs.find(entry => entry.name === 'footer')
  await (def!.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: '' })
  await vt.waitForRender()
  // The compact layout is ONE row: the selector must not list a second
  // row.
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('Row 1'), `the compact row must be listed:\n${view}`)
  assert.ok(!view.includes('Row 2'), `the compact layout must not start from the two-row default:\n${view}`)
  // PR E §12/§18: S on an UNCHANGED (clean) draft closes WITHOUT writing
  // — an idle save must not flip the compact mode to custom.
  vt.sendInput('s')
  await vt.waitForRender()
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
  assert.equal(applied.length, 0, 'a clean S must not persist')
  assert.ok(!vt.getViewport().join('\n').includes('Select row to edit'), 'the clean save closes')
  assert.equal(app.getFooterMode(), 'compact', 'the compact mode stays untouched')
  // The clean save closed the PAGE; the SAME Settings lease remains. Leave it
  // (rows -> categories -> close) before the next typed deeplink.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()

  // The seeding guarantee still holds where it matters: a DIRTY compact
  // draft saves as ONE row (the draft started from the EFFECTIVE compact
  // layout, never the two-row default).
  await (def!.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: '' })
  await vt.waitForRender()
  vt.sendInput('\r') // → Edit Row 1
  await vt.waitForRender()
  vt.sendInput('a') // → Add picker
  await vt.waitForRender()
  vt.sendInput('\r') // add the first available item (makes the draft dirty)
  await vt.waitForRender()
  vt.sendInput('\x1b') // → selector
  await vt.waitForRender()
  vt.sendInput('s')
  await vt.waitForRender()
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
  assert.equal(applied.length, 1, 'a dirty compact save persists')
  const saved = applied[0]!.footerLayout as { rows: unknown[] }
  assert.equal(saved.rows.length, 1, `a dirty compact save must stay one row:\n${JSON.stringify(saved)}`)
  app.stop()
})

test('/footer Enter with a FAILED settings write keeps the old layout and notifies', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const commands = fakeCommands()
  ctx.provide('commands', commands.service as never)
  ctx.provide('settings', { describe: () => [{ ns: 'tui-app', user: {} }] } as never)
  // A settings document whose replace REJECTS (the write fails).
  const doc = { footer: 'default' as string, footerLayout: undefined as unknown }
  const failingSettings: TuiSettingsLike = {
    get: () => ({ theme: 'auto', iconStyle: 'emoji', footer: doc.footer, footerLayout: doc.footerLayout, fullscreen: 'on', busyEnter: 'queue', localShellSandbox: 'bypass', homeEndKeys: 'viewport', wheelScrollLines: '1', notificationMode: 'unfocused', terminalProgress: 'on', notificationMethod: 'auto' }),
    replace: () => { throw new Error('write failed') },
  }
  const applied: Array<{ footer: string }> = []
  const runner: TuiCommandRunner = {
    ctx, app, diag: {} as never,
    get defaultIntentOutcome() { return undefined },
    ...sessionScopeFacts(() => undefined, () => 0),
    hostShellCompletion: true,
    transcriptExportAvailable: true,
    currentSessionId: undefined,
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    defaultSelection: () => undefined,
    defaultIntent: undefined,
    setDefaultIntent: () => {},
    defaultIntentRecord: undefined,
    settleIntent: () => {},
    tuiSettings: failingSettings,
    agents: {} as never,
    sessionReader: { list: async () => [], search: async () => ({ items: [], hasMore: false }), projectionBatch: async () => new Map(), blank: () => undefined, measureContext: () => undefined,
      turnOutline: () => undefined,
      sessionStatus: () => undefined },
    sessionWriter: { prompt: async () => ({ kind: 'committed' as const, value: undefined }), updateQueue: async () => ({ kind: 'committed' as const, value: undefined }), cancel: async () => ({ kind: 'committed' as const, value: undefined }), rename: async (_sessionId: string, title: string) => ({ kind: 'committed' as const, value: { title } }), refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }) },

    interaction: { questions: { subscribe: () => undefined,  onRequest: () => true, snapshot: () => undefined, claimTimedWait: async () => undefined, answerContinued: async () => 'not-continued' as const }, onApprovalRequest: () => {}, setApprovalPolicy: () => true },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    hostFile: new DirectHostFilePort(() => undefined),
    commandRegistry: ctx.get('commands') as never,
    clientCommands: createClientCommandRegistry(parseCommand),
    cwd: '/ws', sessionCwd: () => '/ws', imageStore: {} as never,
    copyToClipboard: async () => true, imageLimits: () => undefined, insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
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
    refreshStatus: () => {}, progressUpdatesState: { mode: 'milestones' }, responseStyleState: { style: 'default' }, gitAttributionState: { mode: 'off' }, focusEnabled: () => false, setFocusMode: () => {}, setNotificationMode: () => {}, currentNotificationMode: () => 'unfocused', currentNotificationMethod: () => 'auto', setTerminalProgressMode: () => {}, setNotificationMethod: () => {}, updateWelcomeCard: () => {},
    openJobView: () => {}, openTasksBrowser: () => {}, createPluginManagerPage: () => undefined, openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withWriter: async <T>(_scope: unknown, task: () => T | Promise<T>) => task(),
    withPromptAdmission: async <T>(_agent: unknown, _line: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {}, requestExit: () => {}, extensions: undefined, exit: () => {},
    applyFooterSettings: (d) => { if (d !== undefined) applied.push({ ...d }) },
  }
  registerTuiCommandsWithDirectSeams(runner)
  const def = commands.defs.find(entry => entry.name === 'footer')
  await (def!.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: '' })
  await vt.waitForRender()
  // Edit the draft, walk back to the selector, then save with S — the
  // write fails: the memory commit must NOT happen (the old layout
  // stays) — the apply is deferred until the write succeeds.
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput(' ')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('s')
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
  // The write fails: the memory commit must NOT happen (the old layout
  // stays) — the apply is deferred until the write succeeds. Spin the
  // event loop a BOUNDED number of turns (never a wall-clock sleep — the
  // repo's headless-test discipline) so the rejected write and its catch
  // chain settle, then assert no apply ever landed.
  for (let spin = 0; spin < 50; spin += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(applied.length, 0, 'a failed write must not apply the layout')
  assert.equal(app.getFooterMode(), 'default', 'the old layout must stay active')
  app.stop()
})

test('/settings footer change is PERSIST-FIRST: a failed write keeps the old layout', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    // The row writer is dispatched through the app's owned-task entry.
    runOwned: ((_label: string, task: () => unknown, options: {
      onResult?: (value: unknown) => void
      onError?: (error: unknown) => void
    }) => {
      Promise.resolve().then(task).then(
        value => options.onResult?.(value),
        error => options.onError?.(error),
      )
    }) as never,
  })
  app.start()
  startedApps.add(app)
  const commands = fakeCommands()
  ctx.provide('commands', commands.service as never)
  ctx.provide('settings', { describe: () => [{ ns: 'tui-app', user: {} }] } as never)
  const doc = { footer: 'default' as string, footerLayout: undefined as unknown }
  const failingSettings: TuiSettingsLike = {
    get: () => ({ theme: 'auto', iconStyle: 'emoji', footer: doc.footer, footerLayout: doc.footerLayout, fullscreen: 'on', busyEnter: 'queue', localShellSandbox: 'bypass', homeEndKeys: 'viewport', wheelScrollLines: '1', notificationMode: 'unfocused', terminalProgress: 'on', notificationMethod: 'auto' }),
    replace: () => { throw new Error('write failed') },
  }
  const applied: Array<{ footer: string }> = []
  const runner: TuiCommandRunner = {
    ctx,
    app,
    diag: { warn: () => {}, error: () => {}, info: () => {} } as never,
    get defaultIntentOutcome() { return undefined },
    ...sessionScopeFacts(() => undefined, () => 0),
    hostShellCompletion: true,
    transcriptExportAvailable: true,
    currentSessionId: undefined,
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    defaultSelection: () => undefined,
    defaultIntent: undefined,
    setDefaultIntent: () => {},
    defaultIntentRecord: undefined,
    settleIntent: () => {},
    tuiSettings: failingSettings,
    agents: {} as never,
    sessionReader: { list: async () => [], search: async () => ({ items: [], hasMore: false }), projectionBatch: async () => new Map(), blank: () => undefined, measureContext: () => undefined,
      turnOutline: () => undefined,
      sessionStatus: () => undefined },
    sessionWriter: { prompt: async () => ({ kind: 'committed' as const, value: undefined }), updateQueue: async () => ({ kind: 'committed' as const, value: undefined }), cancel: async () => ({ kind: 'committed' as const, value: undefined }), rename: async (_sessionId: string, title: string) => ({ kind: 'committed' as const, value: { title } }), refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }) },
    interaction: { questions: { subscribe: () => undefined,  onRequest: () => true, snapshot: () => undefined, claimTimedWait: async () => undefined, answerContinued: async () => 'not-continued' as const }, onApprovalRequest: () => {}, setApprovalPolicy: () => true },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: readyConfig(new DirectConfigPort(ctx as never, undefined, () => undefined)),
    hostFile: new DirectHostFilePort(() => undefined),
    commandRegistry: ctx.get('commands') as never,
    clientCommands: createClientCommandRegistry(parseCommand),
    cwd: '/ws', sessionCwd: () => '/ws', imageStore: {} as never,
    copyToClipboard: async () => true, imageLimits: () => undefined, insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
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
    refreshStatus: () => {}, progressUpdatesState: { mode: 'milestones' }, responseStyleState: { style: 'default' }, gitAttributionState: { mode: 'off' }, focusEnabled: () => false, setFocusMode: () => {}, setNotificationMode: () => {}, currentNotificationMode: () => 'unfocused', currentNotificationMethod: () => 'auto', setTerminalProgressMode: () => {}, setNotificationMethod: () => {}, updateWelcomeCard: () => {},
    openJobView: () => {}, openTasksBrowser: () => {}, createPluginManagerPage: () => undefined, openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withWriter: async <T>(_scope: unknown, task: () => T | Promise<T>) => task(),
    withPromptAdmission: async <T>(_agent: unknown, _line: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {}, requestExit: () => {}, extensions: undefined, exit: () => {},
    applyFooterSettings: (d) => { if (d !== undefined) applied.push({ ...d }) },
  }
  registerTuiCommandsWithDirectSeams(runner)
  const def = commands.defs.find(entry => entry.name === 'settings')
  assert.ok(def?.handler !== undefined, 'settings handler missing')
  // Open the REAL /settings picker (the registered handler builds the
  // rows and wires the persist-first footer branch into onChange).
  await (def.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: '' })
  await vt.waitForRender()
  // Walk the REAL Settings workspace to `Appearance → Status line mode`, open
  // its inline choice, choose compact and Confirm. The persist-first writer
  // throws, so applyFooterSettings must NEVER run.
  await selectSettingsCategory(vt, 'Appearance')
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('\x1b[B') // Icon style -> Status line mode
  await vt.waitForRender()
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  assert.match(vt.getViewport().join('\n'), /> Status line mode/u, 'the Footer mode row is selected')
  vt.sendInput('\r') // rows -> Detail choice
  await vt.waitForRender()
  vt.sendInput('\x1b[B') // default -> compact
  await vt.waitForRender()
  vt.sendInput('\r') // explicit Confirm
  const deadline = Date.now() + 400
  while (applied.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(applied.length, 0, 'a failed settings write must not apply the footer layout')
  assert.equal(app.getFooterMode(), 'default', 'the old layout must stay active')
  app.stop()
})

test('/settings footer change PERSISTS footerFallbackMode (the command-mode restart fallback source)', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    // The row writer is dispatched through the app's owned-task entry.
    runOwned: ((_label: string, task: () => unknown, options: {
      onResult?: (value: unknown) => void
      onError?: (error: unknown) => void
    }) => {
      Promise.resolve().then(task).then(
        value => options.onResult?.(value),
        error => options.onError?.(error),
      )
    }) as never,
  })
  app.start()
  startedApps.add(app)
  const commands = fakeCommands()
  ctx.provide('commands', commands.service as never)
  ctx.provide('settings', { describe: () => [{ ns: 'tui-app', user: {} }] } as never)
  const settings = fakeSettings({ footer: 'default' })
  const applied: Array<{ footer: string }> = []
  const runner: TuiCommandRunner = {
    ctx, app, diag: {} as never,
    get defaultIntentOutcome() { return undefined },
    ...sessionScopeFacts(() => undefined, () => 0),
    hostShellCompletion: true,
    transcriptExportAvailable: true,
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
    sessionReader: { list: async () => [], search: async () => ({ items: [], hasMore: false }), projectionBatch: async () => new Map(), blank: () => undefined, measureContext: () => undefined,
      turnOutline: () => undefined,
      sessionStatus: () => undefined },
    sessionWriter: { prompt: async () => ({ kind: 'committed' as const, value: undefined }), updateQueue: async () => ({ kind: 'committed' as const, value: undefined }), cancel: async () => ({ kind: 'committed' as const, value: undefined }), rename: async (_sessionId: string, title: string) => ({ kind: 'committed' as const, value: { title } }), refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }) },
    interaction: { questions: { subscribe: () => undefined,  onRequest: () => true, snapshot: () => undefined, claimTimedWait: async () => undefined, answerContinued: async () => 'not-continued' as const }, onApprovalRequest: () => {}, setApprovalPolicy: () => true },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: readyConfig(new DirectConfigPort(ctx as never, undefined, () => undefined)),
    hostFile: new DirectHostFilePort(() => undefined),
    commandRegistry: ctx.get('commands') as never,
    clientCommands: createClientCommandRegistry(parseCommand),
    cwd: '/ws', sessionCwd: () => '/ws', imageStore: {} as never,
    copyToClipboard: async () => true, imageLimits: () => undefined, insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
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
    refreshStatus: () => {}, progressUpdatesState: { mode: 'milestones' }, responseStyleState: { style: 'default' }, gitAttributionState: { mode: 'off' }, focusEnabled: () => false, setFocusMode: () => {}, setNotificationMode: () => {}, currentNotificationMode: () => 'unfocused', currentNotificationMethod: () => 'auto', setTerminalProgressMode: () => {}, setNotificationMethod: () => {}, updateWelcomeCard: () => {},
    openJobView: () => {}, openTasksBrowser: () => {}, createPluginManagerPage: () => undefined, openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withWriter: async <T>(_scope: unknown, task: () => T | Promise<T>) => task(),
    withPromptAdmission: async <T>(_agent: unknown, _line: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {}, requestExit: () => {}, extensions: undefined, exit: () => {},
    applyFooterSettings: (d) => { if (d !== undefined) applied.push({ ...d }) },
  }
  registerTuiCommandsWithDirectSeams(runner)
  const def = commands.defs.find(entry => entry.name === 'settings')
  assert.ok(def?.handler !== undefined, 'settings handler missing')
  await (def.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: '' })
  await vt.waitForRender()
  // The SAME Settings row the Footer page lives beside: select compact and
  // Confirm; the persisted fallback is what a future `command` mode falls back to.
  await selectSettingsCategory(vt, 'Appearance')
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  assert.match(vt.getViewport().join('\n'), /> Status line mode/u, `the Footer mode row must be selected:\n${vt.getViewport().join('\n')}`)
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.match(vt.getViewport().join('\n'), /Choose value/u, `the inline choice must be painted:\n${vt.getViewport().join('\n')}`)
  vt.sendInput('\x1b[B') // default -> compact
  await vt.waitForRender()
  assert.match(vt.getViewport().join('\n'), /Enter confirm/u, `the explicit Confirm must be painted:\n${vt.getViewport().join('\n')}`)
  vt.sendInput('\r')
  const deadline = Date.now() + 500
  while (settings.doc.footerFallbackMode === undefined && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(settings.doc.footer, 'compact', 'the mode must persist')
  assert.equal(settings.doc.footerFallbackMode, 'compact', 'the fallback mode must persist alongside')
  app.stop()
})

test('/footer save failures notify exactly once (validation and write failures)', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const commands = fakeCommands()
  ctx.provide('commands', commands.service as never)
  const notifications: Array<string> = []
  ;(app as unknown as { notify: (message: string, level?: string) => void }).notify = (message) => {
    notifications.push(message)
  }
  const capturedFooter = captureFooterSaves(app)
  const saveCallbacks = capturedFooter.saves
  const known = { schemaVersion: 1 as const, id: 'user:environment', kind: 'text' as const, text: 'OLD', tone: 'warning' as const }
  let rejectReplace: ((reason?: unknown) => void) | undefined
  const settings: TuiSettingsLike = {
    get: () => ({
      theme: 'auto', iconStyle: 'emoji', footer: 'default', fullscreen: 'on',
      busyEnter: 'queue', localShellSandbox: 'bypass', homeEndKeys: 'viewport',
      wheelScrollLines: '1', notificationMode: 'unfocused', terminalProgress: 'on', notificationMethod: 'auto', footerCustomItems: [known],
    }),
    replace: () => new Promise<void>((_resolve, reject) => { rejectReplace = reject }),
  }
  ctx.provide('settings', { describe: () => [{ ns: 'tui-app', user: { footerCustomItems: [known] } }] } as never)
  const applied: Array<{ footerLayout?: unknown }> = []
  const runner: TuiCommandRunner = {
    ctx,
    app,
    diag: { warn: () => {}, error: () => {}, info: () => {} } as never,
    get defaultIntentOutcome() { return undefined },
    ...sessionScopeFacts(() => undefined, () => 0),
    hostShellCompletion: true,
    transcriptExportAvailable: true,
    currentSessionId: undefined,
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    defaultSelection: () => undefined,
    defaultIntent: undefined,
    setDefaultIntent: () => {},
    defaultIntentRecord: undefined,
    settleIntent: () => {},
    tuiSettings: settings,
    agents: {} as never,
    sessionReader: { list: async () => [], search: async () => ({ items: [], hasMore: false }), projectionBatch: async () => new Map(), blank: () => undefined, measureContext: () => undefined,
      turnOutline: () => undefined,
      sessionStatus: () => undefined },
    sessionWriter: { prompt: async () => ({ kind: 'committed' as const, value: undefined }), updateQueue: async () => ({ kind: 'committed' as const, value: undefined }), cancel: async () => ({ kind: 'committed' as const, value: undefined }), rename: async (_sessionId: string, title: string) => ({ kind: 'committed' as const, value: { title } }), refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }) },
    interaction: { questions: { subscribe: () => undefined,  onRequest: () => true, snapshot: () => undefined, claimTimedWait: async () => undefined, answerContinued: async () => 'not-continued' as const }, onApprovalRequest: () => {}, setApprovalPolicy: () => true },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    hostFile: new DirectHostFilePort(() => undefined),
    commandRegistry: ctx.get('commands') as never,
    clientCommands: createClientCommandRegistry(parseCommand),
    cwd: '/ws',
    sessionCwd: () => '/ws',
    imageStore: {} as never,
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
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
    extensions: undefined,
    exit: () => {},
    applyFooterSettings: (doc) => {
      if (doc !== undefined) applied.push({ footerLayout: doc.footerLayout })
    },
  }
  registerTuiCommandsWithDirectSeams(runner)
  const footer = commands.defs.find(entry => entry.name === 'footer')
  assert.ok(footer?.handler !== undefined)
  await (footer.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: '' })
  assert.equal(saveCallbacks.length, 1)

  // Scenario A — an INVALID draft (3 rows exceed the v1 cap) rejects and
  // notifies EXACTLY once; the write path is never reached.
  notifications.length = 0
  const invalid = { schemaVersion: 1, rows: [{ left: [{ id: 'model' }], right: [] }, { left: [], right: [] }, { left: [], right: [] }] }
  await assert.rejects(Promise.resolve().then(() => saveCallbacks[0]!(invalid as FooterLayoutV1, [])))
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
  assert.equal(notifications.length, 1, `validation notifies once:\n${notifications.join('\n')}`)
  assert.match(notifications[0]!, /footer layout invalid/)
  assert.equal(applied.length, 0, 'an invalid draft never applies')

  // Scenario B — a VALID draft whose settings write REJECTS notifies
  // exactly once (the catch), never twice, and never a success message.
  notifications.length = 0
  const valid: FooterLayoutV1 = { schemaVersion: 1, rows: [{ left: [{ id: 'model' }], right: [] }] }
  const pending = Promise.resolve().then(() => saveCallbacks[0]!(valid, [{ ...known, text: 'NEW' }]))
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
  assert.ok(rejectReplace !== undefined, 'the write was reached')
  rejectReplace!(new Error('disk on fire'))
  await assert.rejects(() => pending)
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
  assert.equal(notifications.length, 1, `a failed write notifies once:\n${notifications.join('\n')}`)
  assert.match(notifications[0]!, /footer layout save failed/)
  assert.equal(applied.length, 0, 'a failed write never applies the memory commit')
  app.stop()
})

test('an unsaved custom command draft NEVER executes (preview, resize, Keep Editing, Discard)', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('pi-tui-noexec-')
  const marker = join(dir, 'pwn')
  const ctx = new Context()
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  // The REAL runtime, wired exactly like the production applyFooterSettings
  // syncs it: it can only ever see definitions a successful save commits.
  const runtime = wireRuntimeApply(app)
  try {
    const commands = fakeCommands()
    ctx.provide('commands', commands.service as never)
    const settings = fakeSettings({ footer: 'default' })
    ctx.provide('settings', { describe: () => [{ ns: 'tui-app', user: {} }] } as never)
    const applied: Array<{ footer: string }> = []
    const runner: TuiCommandRunner = {
      ctx, app, diag: {} as never,
      get defaultIntentOutcome() { return undefined },
      ...sessionScopeFacts(() => undefined, () => 0),
      hostShellCompletion: true,
      transcriptExportAvailable: true,
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
      sessionReader: { list: async () => [], search: async () => ({ items: [], hasMore: false }), projectionBatch: async () => new Map(), blank: () => undefined, measureContext: () => undefined,
      turnOutline: () => undefined,
      sessionStatus: () => undefined },
      sessionWriter: { prompt: async () => ({ kind: 'committed' as const, value: undefined }), updateQueue: async () => ({ kind: 'committed' as const, value: undefined }), cancel: async () => ({ kind: 'committed' as const, value: undefined }), rename: async (_sessionId: string, title: string) => ({ kind: 'committed' as const, value: { title } }), refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }) },
      interaction: { questions: { subscribe: () => undefined,  onRequest: () => true, snapshot: () => undefined, claimTimedWait: async () => undefined, answerContinued: async () => 'not-continued' as const }, onApprovalRequest: () => {}, setApprovalPolicy: () => true },
      catalog: new DirectCatalogPort(ctx as never, () => undefined),
      config: new DirectConfigPort(ctx as never, undefined, () => undefined),
      hostFile: new DirectHostFilePort(() => undefined),
      commandRegistry: ctx.get('commands') as never,
      clientCommands: createClientCommandRegistry(parseCommand),
      cwd: '/ws', sessionCwd: () => '/ws', imageStore: {} as never,
      copyToClipboard: async () => true, imageLimits: () => undefined, insertIntoEditor: () => {},
      prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
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
      refreshStatus: () => {}, progressUpdatesState: { mode: 'milestones' }, responseStyleState: { style: 'default' }, gitAttributionState: { mode: 'off' }, focusEnabled: () => false, setFocusMode: () => {}, setNotificationMode: () => {}, currentNotificationMode: () => 'unfocused', currentNotificationMethod: () => 'auto', setTerminalProgressMode: () => {}, setNotificationMethod: () => {}, updateWelcomeCard: () => {},
      openJobView: () => {}, openTasksBrowser: () => {}, createPluginManagerPage: () => undefined, openRewindPicker: () => {},
      sessionTransitionPending: () => false,
      withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
      withWriter: async <T>(_scope: unknown, task: () => T | Promise<T>) => task(),
      withPromptAdmission: async <T>(_agent: unknown, _line: string, task: () => T | Promise<T>) => task(),
      enterView: async () => {}, requestExit: () => {}, extensions: undefined, exit: () => {},
      applyFooterSettings: (d, savedCustomItems) => {
        if (d === undefined) return
        applied.push({ ...d })
        if (d.footer === 'custom') {
          app.setFooterPreset('full')
          app.setFooterLayout(d.footerLayout as never)
        }
        syncRuntimeApply(runtime, app, savedCustomItems, d.footer === 'custom' ? d.footerLayout as FooterLayoutV1 : undefined)
      },
    }
    registerTuiCommandsWithDirectSeams(runner)
    const def = commands.defs.find(entry => entry.name === 'footer')
    await (def!.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: '' })
    await vt.waitForRender()
    // Create the command draft on the SAME mounted page model: the creation UI
    // itself is covered by the configurator suite, while THIS case owns the
    // no-execution boundary (preview, resize, dirty-exit).
    const page = (app as unknown as {
      workspaceLease?: { panel: { specialistPage?: { model: Record<string, unknown> } } }
    }).workspaceLease?.panel.specialistPage
    assert.ok(page !== undefined, 'the /footer page is mounted in the Settings lease')
    const model = page.model as {
      activate(): void
      startAdd(): void
      text(value: string): void
      moveDown(): void
    }
    model.activate() // rows -> row
    model.startAdd()
    model.text('no-match')
    model.moveDown() // 0 matches: Create Custom Text -> Create Custom Command
    model.activate() // create-name
    model.text('Pwn')
    model.activate() // create-command
    model.text(`touch ${marker}`)
    model.activate() // create-refresh
    model.activate() // create-timeout
    model.activate() // create-tone
    model.activate() // create with Auto -> row (dirty)
    app.requestRender()
    await vt.waitForRender()
    // The draft preview renders through the placeholder path — no spawn.
    assert.match(vt.getViewport().join('\n'), /\[command\]/, 'the draft preview must show the placeholder')
    // Resize the terminal (a repaint) — still no spawn.
    vt.resize(80, 24)
    await vt.waitForRender()
    assert.match(vt.getViewport().join('\n'), /\[command\]/, 'the resized draft preview keeps the placeholder')
    // Esc Keep Editing: row -> selector -> exit guard -> Keep Editing.
    vt.sendInput('\x1b') // row -> selector
    await vt.waitForRender()
    vt.sendInput('\x1b') // dirty -> exit-confirm
    await vt.waitForRender()
    vt.sendInput('\x1b[B') // Save & Exit -> Discard & Exit
    await vt.waitForRender()
    vt.sendInput('\x1b[B') // Discard & Exit -> Keep Editing
    await vt.waitForRender()
    vt.sendInput('\r') // back to the selector
    await vt.waitForRender()
    // Esc Discard: selector -> exit guard -> Discard & Exit closes the page.
    vt.sendInput('\x1b')
    await vt.waitForRender()
    vt.sendInput('\x1b[B') // Save & Exit -> Discard & Exit
    await vt.waitForRender()
    vt.sendInput('\r')
    await vt.waitForRender()
    // The marker must never exist: no preview, no repaint, no guard
    // interaction may execute the draft command.
    await spin(300)
    assert.equal(existsSync(marker), false, 'an unsaved draft command must never execute')
    assert.equal(applied.length, 0, 'no save may have happened')
  } finally {
    runtime.dispose()
    app.stop()
  }
})

test('a FAILED save never executes the new command (draft preserved, marker absent)', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('pi-tui-noexec-fail-')
  const marker = join(dir, 'pwn')
  const ctx = new Context()
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  // The REAL runtime: a failed save must never reach it.
  const runtime = wireRuntimeApply(app)
  try {
    const commands = fakeCommands()
    ctx.provide('commands', commands.service as never)
    ctx.provide('settings', { describe: () => [{ ns: 'tui-app', user: {} }] } as never)
    const doc = { footer: 'default' as string, footerLayout: undefined as unknown, footerCustomItems: undefined as unknown }
    const failingSettings: TuiSettingsLike = {
      get: () => ({ theme: 'auto', iconStyle: 'emoji', footer: doc.footer, footerLayout: doc.footerLayout, footerCustomItems: doc.footerCustomItems as never, fullscreen: 'on', busyEnter: 'queue', localShellSandbox: 'bypass', homeEndKeys: 'viewport', wheelScrollLines: '1', notificationMode: 'unfocused', terminalProgress: 'on', notificationMethod: 'auto' }),
      replace: () => { throw new Error('write failed') },
    }
    const applied: Array<{ footer: string }> = []
    const runner: TuiCommandRunner = {
      ctx, app, diag: {} as never,
      get defaultIntentOutcome() { return undefined },
      ...sessionScopeFacts(() => undefined, () => 0),
      hostShellCompletion: true,
      transcriptExportAvailable: true,
      currentSessionId: undefined,
      ensureSession: async () => {},
      get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    defaultSelection: () => undefined,
    defaultIntent: undefined,
    setDefaultIntent: () => {},
    defaultIntentRecord: undefined,
    settleIntent: () => {},
      tuiSettings: failingSettings,
      agents: {} as never,
      sessionReader: { list: async () => [], search: async () => ({ items: [], hasMore: false }), projectionBatch: async () => new Map(), blank: () => undefined, measureContext: () => undefined,
      turnOutline: () => undefined,
      sessionStatus: () => undefined },
      sessionWriter: { prompt: async () => ({ kind: 'committed' as const, value: undefined }), updateQueue: async () => ({ kind: 'committed' as const, value: undefined }), cancel: async () => ({ kind: 'committed' as const, value: undefined }), rename: async (_sessionId: string, title: string) => ({ kind: 'committed' as const, value: { title } }), refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }) },
      interaction: { questions: { subscribe: () => undefined,  onRequest: () => true, snapshot: () => undefined, claimTimedWait: async () => undefined, answerContinued: async () => 'not-continued' as const }, onApprovalRequest: () => {}, setApprovalPolicy: () => true },
      catalog: new DirectCatalogPort(ctx as never, () => undefined),
      config: new DirectConfigPort(ctx as never, undefined, () => undefined),
      hostFile: new DirectHostFilePort(() => undefined),
      commandRegistry: ctx.get('commands') as never,
      clientCommands: createClientCommandRegistry(parseCommand),
      cwd: '/ws', sessionCwd: () => '/ws', imageStore: {} as never,
      copyToClipboard: async () => true, imageLimits: () => undefined, insertIntoEditor: () => {},
      prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
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
      refreshStatus: () => {}, progressUpdatesState: { mode: 'milestones' }, responseStyleState: { style: 'default' }, gitAttributionState: { mode: 'off' }, focusEnabled: () => false, setFocusMode: () => {}, setNotificationMode: () => {}, currentNotificationMode: () => 'unfocused', currentNotificationMethod: () => 'auto', setTerminalProgressMode: () => {}, setNotificationMethod: () => {}, updateWelcomeCard: () => {},
      openJobView: () => {}, openTasksBrowser: () => {}, createPluginManagerPage: () => undefined, openRewindPicker: () => {},
      sessionTransitionPending: () => false,
      withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
      withWriter: async <T>(_scope: unknown, task: () => T | Promise<T>) => task(),
      withPromptAdmission: async <T>(_agent: unknown, _line: string, task: () => T | Promise<T>) => task(),
      enterView: async () => {}, requestExit: () => {}, extensions: undefined, exit: () => {},
      applyFooterSettings: (d, savedCustomItems) => {
        if (d === undefined) return
        applied.push({ ...d })
        if (d.footer === 'custom') {
          app.setFooterPreset('full')
          app.setFooterLayout(d.footerLayout as never)
        }
        syncRuntimeApply(runtime, app, savedCustomItems, d.footer === 'custom' ? d.footerLayout as FooterLayoutV1 : undefined)
      },
    }
    registerTuiCommandsWithDirectSeams(runner)
    const def = commands.defs.find(entry => entry.name === 'footer')
    await (def!.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: '' })
    await vt.waitForRender()
    vt.sendInput('\r') // row
    vt.sendInput('a') // add
    vt.sendInput('no-match')
    vt.sendInput('\x1b[B') // Create Custom Command
    vt.sendInput('\r') // create-name
    vt.sendInput('Pwn')
    vt.sendInput('\r') // create-command
    vt.sendInput(`touch ${marker}`)
    vt.sendInput('\r') // create-refresh
    vt.sendInput('\r') // create-timeout
    vt.sendInput('\r') // create-tone
    vt.sendInput('\r') // create with Auto
    await vt.waitForRender()
    vt.sendInput('\x1b') // row -> selector
    await vt.waitForRender()
    vt.sendInput('s') // save — the write FAILS
    for (let spin = 0; spin < 50; spin += 1) await new Promise(resolve => setImmediate(resolve))
    await vt.waitForRender()
    // The configurator stays open with the draft intact; the marker must
    // never exist — a failed save must never arm the new command.
    assert.ok(vt.getViewport().join('\n').includes('Unsaved'), 'the dirty Footer page must stay open after a failed save')
    assert.equal(applied.length, 0, 'a failed write must not apply')
    await spin(300)
    assert.equal(existsSync(marker), false, 'a failed save must never execute the new command')
  } finally {
    runtime.dispose()
    app.stop()
  }
})

test('a SUCCESSFUL save is the ONLY event that arms the runtime (marker appears only after save)', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('pi-tui-noexec-ok-')
  const marker = join(dir, 'pwn')
  const ctx = new Context()
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  // The REAL runtime, synced exactly like the production
  // applyFooterSettings: only a successful save's validated definitions
  // can reach it.
  const runtime = wireRuntimeApply(app)
  try {
    const commands = fakeCommands()
    ctx.provide('commands', commands.service as never)
    const settings = fakeSettings({ footer: 'default' })
    ctx.provide('settings', { describe: () => [{ ns: 'tui-app', user: {} }] } as never)
    const applied: Array<{ footer: string; footerCustomItems?: unknown }> = []
    const runner: TuiCommandRunner = {
      ctx, app, diag: {} as never,
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
      sessionReader: { list: async () => [], search: async () => ({ items: [], hasMore: false }), projectionBatch: async () => new Map(), blank: () => undefined, measureContext: () => undefined,
      turnOutline: () => undefined,
      sessionStatus: () => undefined },
      sessionWriter: { prompt: async () => ({ kind: 'committed' as const, value: undefined }), updateQueue: async () => ({ kind: 'committed' as const, value: undefined }), cancel: async () => ({ kind: 'committed' as const, value: undefined }), rename: async (_sessionId: string, title: string) => ({ kind: 'committed' as const, value: { title } }), refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }) },
      interaction: { questions: { subscribe: () => undefined,  onRequest: () => true, snapshot: () => undefined, claimTimedWait: async () => undefined, answerContinued: async () => 'not-continued' as const }, onApprovalRequest: () => {}, setApprovalPolicy: () => true },
      catalog: new DirectCatalogPort(ctx as never, () => undefined),
      config: new DirectConfigPort(ctx as never, undefined, () => undefined),
      hostFile: new DirectHostFilePort(() => undefined),
      hostShellCompletion: true,
      transcriptExportAvailable: true,
      commandRegistry: ctx.get('commands') as never,
      clientCommands: createClientCommandRegistry(parseCommand),
      cwd: '/ws', sessionCwd: () => '/ws', imageStore: {} as never,
      copyToClipboard: async () => true, imageLimits: () => undefined, insertIntoEditor: () => {},
      prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
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
      refreshStatus: () => {}, progressUpdatesState: { mode: 'milestones' }, responseStyleState: { style: 'default' }, gitAttributionState: { mode: 'off' }, focusEnabled: () => false, setFocusMode: () => {}, setNotificationMode: () => {}, currentNotificationMode: () => 'unfocused', currentNotificationMethod: () => 'auto', setTerminalProgressMode: () => {}, setNotificationMethod: () => {}, updateWelcomeCard: () => {},
      openJobView: () => {}, openTasksBrowser: () => {}, createPluginManagerPage: () => undefined, openRewindPicker: () => {},
      sessionTransitionPending: () => false,
      withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
      withWriter: async <T>(_scope: unknown, task: () => T | Promise<T>) => task(),
      withPromptAdmission: async <T>(_agent: unknown, _line: string, task: () => T | Promise<T>) => task(),
      enterView: async () => {}, requestExit: () => {}, extensions: undefined, exit: () => {},
      applyFooterSettings: (d, savedCustomItems) => {
        if (d === undefined) return
        applied.push({ ...d })
        if (d.footer === 'custom') {
          app.setFooterPreset('full')
          app.setFooterLayout(d.footerLayout as never)
        }
        syncRuntimeApply(runtime, app, savedCustomItems, d.footer === 'custom' ? d.footerLayout as FooterLayoutV1 : undefined)
      },
    }
    registerTuiCommandsWithDirectSeams(runner)
    const def = commands.defs.find(entry => entry.name === 'footer')
    await (def!.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: '' })
    await vt.waitForRender()
    vt.sendInput('\r') // row
    vt.sendInput('a') // add
    vt.sendInput('no-match')
    vt.sendInput('\x1b[B') // Create Custom Command
    vt.sendInput('\r') // create-name
    vt.sendInput('Clock')
    vt.sendInput('\r') // create-command
    vt.sendInput(`touch ${marker}`)
    vt.sendInput('\r') // create-refresh
    vt.sendInput('\r') // create-timeout
    vt.sendInput('\r') // create-tone
    vt.sendInput('\r') // create with Auto
    await vt.waitForRender()
    // The draft exists and previews, but the marker must NOT exist yet.
    await spin(300)
    assert.equal(existsSync(marker), false, 'the draft must not execute before the save')
    vt.sendInput('\x1b') // row -> selector
    await vt.waitForRender()
    vt.sendInput('s') // save
    await vt.waitForRender()
    for (let index = 0; index < 20; index += 1) await Promise.resolve()
    assert.equal(applied.length, 1, 'the save must apply')
    const saved = settings.doc.footerCustomItems as Array<{ id: string; kind: string; command: string }>
    assert.ok(saved.some(item => item.id === 'user:Clock' && item.kind === 'command' && item.command === `touch ${marker}`),
      'the settings document must persist the command definition')
    assert.ok(app.getFooterCustomItems().some(item => item.id === 'user:Clock' && item.kind === 'command'),
      'the app catalog must commit the command definition after a successful save')
    // ONLY now may the command run: the runtime armed the saved definition.
    const deadline = Date.now() + 8000
    while (!existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
    assert.equal(existsSync(marker), true, 'the command may execute ONLY after a successful save')
  } finally {
    runtime.dispose()
    app.stop()
  }
})
