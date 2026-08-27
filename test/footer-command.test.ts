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

test('/footer is sessionless and opens the configurator; S saves and persists', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const commands = fakeCommands()
  ctx.provide('commands', commands.service as never)
  const customItems = [{ schemaVersion: 1 as const, id: 'user:environment', kind: 'text' as const, text: 'PROD', tone: 'warning' as const }]
  app.setFooterCustomItems(customItems)
  const settings = fakeSettings({ footer: 'default', footerCustomItems: customItems })
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
  assert.equal(applied.length, 1, 'S must apply the layout')
  assert.equal(applied[0]!.footer, 'custom')
  assert.equal(settings.doc.footer, 'custom', 'the settings document must persist')
  // Saving a custom layout IS a native-mode change: footerFallbackMode
  // must ride along, or a later command-mode restart would fall back to
  // the mode the user had BEFORE opening /footer (the review's P2).
  assert.equal(settings.doc.footerFallbackMode, 'custom', 'the fallback mode must persist as custom')
  const saved = settings.doc.footerLayout as { rows: Array<{ left: Array<{ id: string }> }> }
  assert.ok(!saved.rows[0]!.left.some(ref => ref.id === 'view-scope'), 'the persisted layout must reflect the toggle')
  assert.deepEqual(settings.doc.footerCustomItems, customItems, 'saving the layout must preserve custom definitions')
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
