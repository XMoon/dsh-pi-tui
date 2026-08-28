/**
 * Headless tests for the /footer command (plan §15.2/§15.8): sessionless
 * (usable before any session), opens the configurator, S on the Row
 * Selector saves through the runner's applyFooterSettings + the settings
 * document, Esc cancels.
 * @module @xmoon76/dsh-pi-tui/footer-command.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { TuiApp } from '../src/tui-app.ts'
import { registerTuiCommands, type TuiCommandRunner, type TuiSettingsLike } from '../src/commands.ts'
import { DEFAULT_FOOTER_LAYOUT } from '../src/footer/presets.ts'
import type { FooterLayoutV1 } from '../src/footer/types.ts'
import type { FooterCustomItemSettings } from '../src/footer/custom-items.ts'
import { serializeTuiSettingsMutation } from '../src/runtime/config-port.ts'
import { DirectConfigPort } from '../src/runtime/direct/config-direct.ts'
import { DirectCatalogPort } from '../src/runtime/direct/catalog-direct.ts'
import { DirectHostFilePort } from '../src/runtime/direct/host-file-direct.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

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
        focusMode: 'off',
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
    focusMode: 'off',
  }
  const pending: Array<{ next: ReturnType<TuiSettingsLike['get']>; resolve: () => void }> = []
  const settings: TuiSettingsLike = {
    get: () => ({ ...doc }),
    replace: (next) => new Promise<void>(resolve => pending.push({ next, resolve })),
  }
  const footerWrite = serializeTuiSettingsMutation(settings, () => settings.replace({ ...settings.get(), footerLayout: { source: 'footer' } }))
  const focusWrite = serializeTuiSettingsMutation(settings, () => settings.replace({ ...settings.get(), focusMode: 'on' }))
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
  assert.equal(pending.length, 2, 'focus must start only after footer settles')
  assert.deepEqual(pending[1]!.next.footerLayout, { source: 'footer' })
  assert.equal(pending[1]!.next.focusMode, 'on')
  doc = { ...pending[1]!.next }
  pending[1]!.resolve()
  await flush()
  assert.equal(pending.length, 3, 'fullscreen must start only after focus settles')
  assert.deepEqual(pending[2]!.next.footerLayout, { source: 'footer' })
  assert.equal(pending[2]!.next.focusMode, 'on')
  assert.equal(pending[2]!.next.fullscreen, 'off')
  doc = { ...pending[2]!.next }
  pending[2]!.resolve()
  await Promise.all([footerWrite, focusWrite, fullscreenWrite])
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
    focusMode: 'off',
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
  const second = serializeTuiSettingsMutation(settings, () => settings.replace({ ...settings.get(), focusMode: 'on' }))
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
  const commands = fakeCommands()
  ctx.provide('commands', commands.service as never)
  const customItems = [{ schemaVersion: 1 as const, id: 'user:environment', kind: 'text' as const, text: 'PROD', tone: 'warning' as const }]
  const futureCustomItem = { schemaVersion: 1, id: 'user:future', kind: 'command', command: 'echo future' }
  const persistedCustomItems = [...customItems, futureCustomItem]
  app.setFooterCustomItems(customItems)
  const settings = fakeSettings({ footer: 'default', footerCustomItems: persistedCustomItems })
  ctx.provide('settings', { describe: () => [{ ns: 'dsh-pi-tui', user: { footerCustomItems: persistedCustomItems } }] } as never)
  const applied: Array<{ footer: string; footerLayout?: unknown; footerCustomItems?: unknown }> = []
  const runner: TuiCommandRunner = {
    ctx,
    app,
    diag: { warn: () => {}, error: () => {}, info: () => {} } as never,
    get liveAgent() { return undefined },
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    tuiSettings: settings.value,
    agents: {} as never,
    sessionReader: { list: async () => [], search: async () => [], titles: async () => new Map(), measureContext: () => undefined, readExportData: async () => ({ kind: 'none' }) },
    sessionWriter: { followup: () => {}, steer: () => {}, dequeue: () => {}, cancel: () => {}, rename: () => true, refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }) },

    interaction: { registerQuestionProvider: () => true, onApprovalRequest: () => {}, setApprovalPolicy: () => true },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    hostFile: new DirectHostFilePort(() => undefined),
    commandRegistry: ctx.get('commands') as never,
    cwd: '/ws',
    sessionCwd: () => '/ws',
    imageStore: {} as never,
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    get sessionGeneration() { return 0 },
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
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
  registerTuiCommands(runner)
  const def = commands.defs.find(entry => entry.name === 'footer')
  assert.ok(def?.handler !== undefined, 'footer handler missing')
  const result = await (def.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: '' })
  assert.deepEqual(result, { kind: 'success' })
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Configure Footer'), `the configurator must open:\n${view}`)
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
  assert.ok(vt.getViewport().join('\n').includes('Configure Footer'), `the alias must open the configurator`)
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
  const commands = fakeCommands()
  ctx.provide('commands', commands.service as never)
  const known = { schemaVersion: 1 as const, id: 'user:environment', kind: 'text' as const, text: 'OLD', tone: 'warning' as const }
  const futureOne = { schemaVersion: 1, id: 'user:future-one', kind: 'command', command: 'one' }
  const futureTwo = { schemaVersion: 1, id: 'user:future-two', kind: 'command', command: 'two' }
  let userRaw: unknown[] = [known, futureOne]
  let currentDoc: ReturnType<TuiSettingsLike['get']> = {
    theme: 'auto',
    iconStyle: 'emoji',
    footer: 'default',
    fullscreen: 'on',
    busyEnter: 'queue',
    localShellSandbox: 'bypass',
    homeEndKeys: 'viewport',
    focusMode: 'off',
    footerCustomItems: userRaw,
  }
  const pendingWrites: Array<{ next: ReturnType<TuiSettingsLike['get']>; resolve: () => void }> = []
  const settings: TuiSettingsLike = {
    get: () => ({ ...currentDoc, footerCustomItems: userRaw }),
    replace: (next) => new Promise<void>(resolve => pendingWrites.push({ next, resolve })),
  }
  ctx.provide('settings', { describe: () => [{ ns: 'dsh-pi-tui', user: { footerCustomItems: userRaw } }] } as never)
  const saveCallbacks: Array<Parameters<TuiApp['openFooterConfigurator']>[0]['onSave']> = []
  app.openFooterConfigurator = ((options: Parameters<TuiApp['openFooterConfigurator']>[0]) => {
    saveCallbacks.push(options.onSave)
    return () => {}
  }) as TuiApp['openFooterConfigurator']
  let settingsChange: Parameters<TuiApp['openSettings']>[1] | undefined
  let settingsItems: Parameters<TuiApp['openSettings']>[0] | undefined
  app.openSettings = ((...args: Parameters<TuiApp['openSettings']>) => {
    settingsItems = args[0]
    settingsChange = args[1]
    return () => {}
  }) as TuiApp['openSettings']
  const applied: Array<{ footerLayout?: unknown; footerCustomItems?: unknown }> = []
  const runner: TuiCommandRunner = {
    ctx,
    app,
    diag: { warn: () => {}, error: () => {}, info: () => {} } as never,
    get liveAgent() { return undefined },
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    tuiSettings: settings,
    agents: {} as never,
    sessionReader: { list: async () => [], search: async () => [], titles: async () => new Map(), measureContext: () => undefined, readExportData: async () => ({ kind: 'none' }) },
    sessionWriter: { followup: () => {}, steer: () => {}, dequeue: () => {}, cancel: () => {}, rename: () => true, refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }) },
    interaction: { registerQuestionProvider: () => true, onApprovalRequest: () => {}, setApprovalPolicy: () => true },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    hostFile: new DirectHostFilePort(() => undefined),
    commandRegistry: ctx.get('commands') as never,
    cwd: '/ws',
    sessionCwd: () => '/ws',
    imageStore: {} as never,
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    get sessionGeneration() { return 0 },
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
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
    applyFooterSettings: (doc) => {
      if (doc !== undefined) applied.push({ footerLayout: doc.footerLayout, footerCustomItems: doc.footerCustomItems })
    },
  }
  registerTuiCommands(runner)
  const footer = commands.defs.find(entry => entry.name === 'footer')
  const settingsCommand = commands.defs.find(entry => entry.name === 'settings')
  assert.ok(footer?.handler !== undefined)
  assert.ok(settingsCommand?.handler !== undefined)
  await (footer.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: '' })
  await (footer.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: '' })
  await (settingsCommand.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: '' })
  assert.equal(saveCallbacks.length, 2)
  assert.ok(settingsChange !== undefined)

  const layoutOne: FooterLayoutV1 = { schemaVersion: 1, rows: [{ left: [{ id: 'model' }], right: [] }] }
  const layoutTwo: FooterLayoutV1 = { schemaVersion: 1, rows: [{ left: [{ id: 'view-scope' }], right: [] }] }
  saveCallbacks[0]!(layoutOne, [{ ...known, text: 'ONE' }])
  settingsChange!('footer', 'compact', () => {})
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
  const keyboardRow = settingsItems?.find(item => item.id === 'keyboard-shortcuts')
  const keyboardSubmenu = keyboardRow?.submenu
  assert.ok(keyboardRow !== undefined && keyboardSubmenu !== undefined, 'settings must expose the keyboard shortcuts submenu')
  const panel = keyboardSubmenu(keyboardRow.currentValue, () => {})
  const handleInput = panel.handleInput?.bind(panel)
  assert.ok(handleInput !== undefined, 'the keyboard shortcuts submenu must accept input')
  handleInput('app.todo.toggle')
  handleInput('\r')
  handleInput('r')
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
  const commands = fakeCommands()
  ctx.provide('commands', commands.service as never)
  const settings = fakeSettings({ footer: 'default' })
  const applied: Array<{ footer: string }> = []
  const runner: TuiCommandRunner = {
    ctx, app, diag: {} as never,
    get liveAgent() { return undefined },
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    tuiSettings: settings.value,
    agents: {} as never,
    sessionReader: { list: async () => [], search: async () => [], titles: async () => new Map(), measureContext: () => undefined, readExportData: async () => ({ kind: 'none' }) },
    sessionWriter: { followup: () => {}, steer: () => {}, dequeue: () => {}, cancel: () => {}, rename: () => true, refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }) },

    interaction: { registerQuestionProvider: () => true, onApprovalRequest: () => {}, setApprovalPolicy: () => true },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    hostFile: new DirectHostFilePort(() => undefined),
    commandRegistry: ctx.get('commands') as never,
    cwd: '/ws', sessionCwd: () => '/ws', imageStore: {} as never,
    copyToClipboard: async () => true, imageLimits: () => undefined, insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    get sessionGeneration() { return 0 },
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
      await steps.prepare?.()
      return { ok: true, next: await steps.create() }
    },
    currentPreset: () => undefined,
    get pendingPreset() { return undefined },
    set pendingPreset(_id: string | undefined) {},
    get effectivePresetId() { return undefined },
    refreshCatalog: async () => ({ kind: 'failed', error: 'not wired in tests' }),
    recomposeBlank: async () => ({ kind: 'switched', preset: 'standard' }),
    refreshStatus: () => {}, focusEnabled: () => false, setFocusMode: () => {}, updateWelcomeCard: () => {},
    openJobView: () => {}, openTasksBrowser: () => {}, openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withSessionWriter: async <T>(_sessionId: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {}, requestExit: () => {}, extensions: undefined, exit: () => {},
    applyFooterSettings: (doc) => { if (doc !== undefined) applied.push({ ...doc }) },
  }
  registerTuiCommands(runner)
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
  const commands = fakeCommands()
  ctx.provide('commands', commands.service as never)
  const persisted = {
    schemaVersion: 1,
    rows: [{ left: [{ id: 'model' }], right: [] }],
  }
  const settings = fakeSettings({ footer: 'custom', footerLayout: persisted })
  const runner: TuiCommandRunner = {
    ctx, app, diag: {} as never,
    get liveAgent() { return undefined },
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    tuiSettings: settings.value,
    agents: {} as never,
    sessionReader: { list: async () => [], search: async () => [], titles: async () => new Map(), measureContext: () => undefined, readExportData: async () => ({ kind: 'none' }) },
    sessionWriter: { followup: () => {}, steer: () => {}, dequeue: () => {}, cancel: () => {}, rename: () => true, refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }) },

    interaction: { registerQuestionProvider: () => true, onApprovalRequest: () => {}, setApprovalPolicy: () => true },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    hostFile: new DirectHostFilePort(() => undefined),
    commandRegistry: ctx.get('commands') as never,
    cwd: '/ws', sessionCwd: () => '/ws', imageStore: {} as never,
    copyToClipboard: async () => true, imageLimits: () => undefined, insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    get sessionGeneration() { return 0 },
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
      await steps.prepare?.()
      return { ok: true, next: await steps.create() }
    },
    currentPreset: () => undefined,
    get pendingPreset() { return undefined },
    set pendingPreset(_id: string | undefined) {},
    get effectivePresetId() { return undefined },
    refreshCatalog: async () => ({ kind: 'failed', error: 'not wired in tests' }),
    recomposeBlank: async () => ({ kind: 'switched', preset: 'standard' }),
    refreshStatus: () => {}, focusEnabled: () => false, setFocusMode: () => {}, updateWelcomeCard: () => {},
    openJobView: () => {}, openTasksBrowser: () => {}, openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withSessionWriter: async <T>(_sessionId: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {}, requestExit: () => {}, extensions: undefined, exit: () => {},
    applyFooterSettings: () => {},
  }
  registerTuiCommands(runner)
  const def = commands.defs.find(entry => entry.name === 'footer')
  await (def!.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: '' })
  await vt.waitForRender()
  // Enter the row: the configurator lists the persisted layout's single
  // item (model) — the default layout's items are not present.
  vt.sendInput('\r')
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Model'), `the persisted item must be listed:\n${view}`)
  assert.ok(!view.includes('Permission preset'), `the default-only items must not be listed:\n${view}`)
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
  app.setFooterPreset('compact')
  const commands = fakeCommands()
  ctx.provide('commands', commands.service as never)
  const settings = fakeSettings({ footer: 'compact' })
  ctx.provide('settings', { describe: () => [{ ns: 'dsh-pi-tui', user: {} }] } as never)
  const applied: Array<{ footer: string; footerLayout?: unknown }> = []
  const runner: TuiCommandRunner = {
    ctx, app, diag: {} as never,
    get liveAgent() { return undefined },
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    tuiSettings: settings.value,
    agents: {} as never,
    sessionReader: { list: async () => [], search: async () => [], titles: async () => new Map(), measureContext: () => undefined, readExportData: async () => ({ kind: 'none' }) },
    sessionWriter: { followup: () => {}, steer: () => {}, dequeue: () => {}, cancel: () => {}, rename: () => true, refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }) },
    interaction: { registerQuestionProvider: () => true, onApprovalRequest: () => {}, setApprovalPolicy: () => true },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    hostFile: new DirectHostFilePort(() => undefined),
    commandRegistry: ctx.get('commands') as never,
    cwd: '/ws', sessionCwd: () => '/ws', imageStore: {} as never,
    copyToClipboard: async () => true, imageLimits: () => undefined, insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    get sessionGeneration() { return 0 },
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
      await steps.prepare?.()
      return { ok: true, next: await steps.create() }
    },
    currentPreset: () => undefined,
    get pendingPreset() { return undefined },
    set pendingPreset(_id: string | undefined) {},
    get effectivePresetId() { return undefined },
    refreshCatalog: async () => ({ kind: 'failed', error: 'not wired in tests' }),
    recomposeBlank: async () => ({ kind: 'switched', preset: 'standard' }),
    refreshStatus: () => {}, focusEnabled: () => false, setFocusMode: () => {}, updateWelcomeCard: () => {},
    openJobView: () => {}, openTasksBrowser: () => {}, openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withSessionWriter: async <T>(_sessionId: string, task: () => T | Promise<T>) => task(),
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
  registerTuiCommands(runner)
  const def = commands.defs.find(entry => entry.name === 'footer')
  await (def!.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: '' })
  await vt.waitForRender()
  // The compact layout is ONE row: the selector must not list a second
  // row.
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('Row 1'), `the compact row must be listed:\n${view}`)
  assert.ok(!view.includes('Row 2'), `the compact layout must not start from the two-row default:\n${view}`)
  // Save UNCHANGED (S): the saved custom layout must stay ONE row.
  vt.sendInput('s')
  await vt.waitForRender()
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
  assert.equal(applied.length, 1, 'S must apply the layout')
  const saved = applied[0]!.footerLayout as { rows: unknown[] }
  assert.equal(saved.rows.length, 1, `an unchanged compact save must stay one row:\n${JSON.stringify(saved)}`)
  app.stop()
})

test('/footer Enter with a FAILED settings write keeps the old layout and notifies', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const commands = fakeCommands()
  ctx.provide('commands', commands.service as never)
  ctx.provide('settings', { describe: () => [{ ns: 'dsh-pi-tui', user: {} }] } as never)
  // A settings document whose replace REJECTS (the write fails).
  const doc = { footer: 'default' as string, footerLayout: undefined as unknown }
  const failingSettings: TuiSettingsLike = {
    get: () => ({ theme: 'auto', iconStyle: 'emoji', footer: doc.footer, footerLayout: doc.footerLayout, fullscreen: 'on', busyEnter: 'queue', localShellSandbox: 'bypass', homeEndKeys: 'viewport', focusMode: 'off' }),
    replace: () => { throw new Error('write failed') },
  }
  const applied: Array<{ footer: string }> = []
  const runner: TuiCommandRunner = {
    ctx, app, diag: {} as never,
    get liveAgent() { return undefined },
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    tuiSettings: failingSettings,
    agents: {} as never,
    sessionReader: { list: async () => [], search: async () => [], titles: async () => new Map(), measureContext: () => undefined, readExportData: async () => ({ kind: 'none' }) },
    sessionWriter: { followup: () => {}, steer: () => {}, dequeue: () => {}, cancel: () => {}, rename: () => true, refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }) },

    interaction: { registerQuestionProvider: () => true, onApprovalRequest: () => {}, setApprovalPolicy: () => true },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    hostFile: new DirectHostFilePort(() => undefined),
    commandRegistry: ctx.get('commands') as never,
    cwd: '/ws', sessionCwd: () => '/ws', imageStore: {} as never,
    copyToClipboard: async () => true, imageLimits: () => undefined, insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    get sessionGeneration() { return 0 },
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
      await steps.prepare?.()
      return { ok: true, next: await steps.create() }
    },
    currentPreset: () => undefined,
    get pendingPreset() { return undefined },
    set pendingPreset(_id: string | undefined) {},
    get effectivePresetId() { return undefined },
    refreshCatalog: async () => ({ kind: 'failed', error: 'not wired in tests' }),
    recomposeBlank: async () => ({ kind: 'switched', preset: 'standard' }),
    refreshStatus: () => {}, focusEnabled: () => false, setFocusMode: () => {}, updateWelcomeCard: () => {},
    openJobView: () => {}, openTasksBrowser: () => {}, openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withSessionWriter: async <T>(_sessionId: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {}, requestExit: () => {}, extensions: undefined, exit: () => {},
    applyFooterSettings: (d) => { if (d !== undefined) applied.push({ ...d }) },
  }
  registerTuiCommands(runner)
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
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const commands = fakeCommands()
  ctx.provide('commands', commands.service as never)
  ctx.provide('settings', { describe: () => [{ ns: 'dsh-pi-tui', user: {} }] } as never)
  const doc = { footer: 'default' as string, footerLayout: undefined as unknown }
  const failingSettings: TuiSettingsLike = {
    get: () => ({ theme: 'auto', iconStyle: 'emoji', footer: doc.footer, footerLayout: doc.footerLayout, fullscreen: 'on', busyEnter: 'queue', localShellSandbox: 'bypass', homeEndKeys: 'viewport', focusMode: 'off' }),
    replace: () => { throw new Error('write failed') },
  }
  const applied: Array<{ footer: string }> = []
  const runner: TuiCommandRunner = {
    ctx,
    app,
    diag: { warn: () => {}, error: () => {}, info: () => {} } as never,
    get liveAgent() { return undefined },
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    tuiSettings: failingSettings,
    agents: {} as never,
    sessionReader: { list: async () => [], search: async () => [], titles: async () => new Map(), measureContext: () => undefined, readExportData: async () => ({ kind: 'none' }) },
    sessionWriter: { followup: () => {}, steer: () => {}, dequeue: () => {}, cancel: () => {}, rename: () => true, refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }) },
    interaction: { registerQuestionProvider: () => true, onApprovalRequest: () => {}, setApprovalPolicy: () => true },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    hostFile: new DirectHostFilePort(() => undefined),
    commandRegistry: ctx.get('commands') as never,
    cwd: '/ws', sessionCwd: () => '/ws', imageStore: {} as never,
    copyToClipboard: async () => true, imageLimits: () => undefined, insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    get sessionGeneration() { return 0 },
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
      await steps.prepare?.()
      return { ok: true, next: await steps.create() }
    },
    currentPreset: () => undefined,
    get pendingPreset() { return undefined },
    set pendingPreset(_id: string | undefined) {},
    get effectivePresetId() { return undefined },
    refreshCatalog: async () => ({ kind: 'failed', error: 'not wired in tests' }),
    recomposeBlank: async () => ({ kind: 'switched', preset: 'standard' }),
    refreshStatus: () => {}, focusEnabled: () => false, setFocusMode: () => {}, updateWelcomeCard: () => {},
    openJobView: () => {}, openTasksBrowser: () => {}, openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withSessionWriter: async <T>(_sessionId: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {}, requestExit: () => {}, extensions: undefined, exit: () => {},
    applyFooterSettings: (d) => { if (d !== undefined) applied.push({ ...d }) },
  }
  registerTuiCommands(runner)
  const def = commands.defs.find(entry => entry.name === 'settings')
  assert.ok(def?.handler !== undefined, 'settings handler missing')
  // Open the REAL /settings picker (the registered handler builds the
  // rows and wires the persist-first footer branch into onChange).
  await (def.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: '' })
  await vt.waitForRender()
  // The FIRST row is the footer Status line (default): Enter cycles it to
  // compact → the handler runs the persist-first branch → the WRITE
  // throws → applyFooterSettings must NEVER run.
  vt.sendInput('\r')
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
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const commands = fakeCommands()
  ctx.provide('commands', commands.service as never)
  ctx.provide('settings', { describe: () => [{ ns: 'dsh-pi-tui', user: {} }] } as never)
  const settings = fakeSettings({ footer: 'default' })
  const applied: Array<{ footer: string }> = []
  const runner: TuiCommandRunner = {
    ctx, app, diag: {} as never,
    get liveAgent() { return undefined },
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    tuiSettings: settings.value,
    agents: {} as never,
    sessionReader: { list: async () => [], search: async () => [], titles: async () => new Map(), measureContext: () => undefined, readExportData: async () => ({ kind: 'none' }) },
    sessionWriter: { followup: () => {}, steer: () => {}, dequeue: () => {}, cancel: () => {}, rename: () => true, refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }) },
    interaction: { registerQuestionProvider: () => true, onApprovalRequest: () => {}, setApprovalPolicy: () => true },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    hostFile: new DirectHostFilePort(() => undefined),
    commandRegistry: ctx.get('commands') as never,
    cwd: '/ws', sessionCwd: () => '/ws', imageStore: {} as never,
    copyToClipboard: async () => true, imageLimits: () => undefined, insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    get sessionGeneration() { return 0 },
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
      await steps.prepare?.()
      return { ok: true, next: await steps.create() }
    },
    currentPreset: () => undefined,
    get pendingPreset() { return undefined },
    set pendingPreset(_id: string | undefined) {},
    get effectivePresetId() { return undefined },
    refreshCatalog: async () => ({ kind: 'failed', error: 'not wired in tests' }),
    recomposeBlank: async () => ({ kind: 'switched', preset: 'standard' }),
    refreshStatus: () => {}, focusEnabled: () => false, setFocusMode: () => {}, updateWelcomeCard: () => {},
    openJobView: () => {}, openTasksBrowser: () => {}, openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withSessionWriter: async <T>(_sessionId: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {}, requestExit: () => {}, extensions: undefined, exit: () => {},
    applyFooterSettings: (d) => { if (d !== undefined) applied.push({ ...d }) },
  }
  registerTuiCommands(runner)
  const def = commands.defs.find(entry => entry.name === 'settings')
  assert.ok(def?.handler !== undefined, 'settings handler missing')
  await (def.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: '' })
  await vt.waitForRender()
  // Walk to the footer row: SettingsList rows cycle their value on Enter
  // (firing onChange) and ↓ moves to the next row. The footer row is not
  // necessarily the first row (theme/expand/thinking precede it), so keep
  // stepping until the footer write actually persists — bounded, never a
  // fixed walk.
  let saved = false
  for (let step = 0; step < 12 && !saved; step += 1) {
    vt.sendInput('\r')
    await vt.waitForRender()
    const deadline = Date.now() + 250
    while (settings.doc.footerFallbackMode === undefined && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    saved = settings.doc.footerFallbackMode !== undefined
    if (!saved) {
      vt.sendInput('\x1b[B')
      await vt.waitForRender()
    }
  }
  assert.equal(settings.doc.footer, 'compact', 'the mode must persist')
  assert.equal(settings.doc.footerFallbackMode, 'compact', 'the fallback mode must persist alongside')
  app.stop()
})
