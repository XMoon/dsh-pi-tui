/**
 * Headless tests for the /footer command (plan §15.2/§15.8): sessionless
 * (usable before any session), opens the configurator, Enter saves through
 * the runner's applyFooterSettings + the settings document, Esc cancels.
 * @module @xmoon76/dsh-pi-tui/footer-command.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { TuiApp } from '../src/tui-app.ts'
import { registerTuiCommands, type TuiCommandRunner, type TuiSettingsLike } from '../src/commands.ts'
import { DEFAULT_FOOTER_LAYOUT } from '../src/footer/presets.ts'
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
function fakeSettings(initial: { footer: string; footerLayout?: unknown }): {
  value: TuiSettingsLike
  doc: { footer: string; footerLayout?: unknown }
} {
  const doc = { ...initial }
  return {
    doc,
    value: {
      get: () => ({
        theme: 'auto',
        footer: doc.footer,
        footerLayout: doc.footerLayout,
        fullscreen: 'on',
        busyEnter: 'queue',
        localShellSandbox: 'bypass',
        homeEndKeys: 'viewport',
        focusMode: 'off',
      }),
      replace: (next: { footer: string; footerLayout?: unknown }) => {
        doc.footer = next.footer
        doc.footerLayout = next.footerLayout
        return undefined
      },
    },
  }
}

test('/footer is sessionless and opens the configurator; Enter saves and persists', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const commands = fakeCommands()
  ctx.provide('commands', commands.service as never)
  const settings = fakeSettings({ footer: 'default' })
  const applied: Array<{ footer: string; footerLayout?: unknown }> = []
  const runner: TuiCommandRunner = {
    ctx,
    app,
    diag: { warn: () => {}, error: () => {}, info: () => {} } as never,
    get liveAgent() { return undefined },
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    tuiSettings: settings.value,
    agents: {} as never,
    sessionReader: { list: async () => [], search: async () => [], titles: async () => new Map() },
    sessionWriter: { followup: () => {}, steer: () => {}, dequeue: () => {}, cancel: () => {}, rename: () => true, refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }) },
    host: { settings: () => undefined, llm: () => undefined, credentials: () => undefined, authorization: () => undefined, defaultModel: () => undefined, presets: () => undefined, tools: () => undefined, permission: () => undefined, tokenMeter: () => undefined, commands: () => ctx.get('commands'), persistence: () => undefined },
    interaction: { registerQuestionProvider: () => true, onApprovalRequest: () => {}, setApprovalPolicy: () => true },
    sessions: { flush: async () => {} },
    cwd: '/ws',
    sessionCwd: () => '/ws',
    imageStore: {} as never,
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    get sessionGeneration() { return 0 },
    compose: async () => ({ setup: () => {} }),
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
  // Toggle the first item out and save.
  vt.sendInput(' ')
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(applied.length, 1, 'Enter must apply the layout')
  assert.equal(applied[0]!.footer, 'custom')
  assert.equal(settings.doc.footer, 'custom', 'the settings document must persist')
  const saved = settings.doc.footerLayout as { rows: Array<{ left: Array<{ id: string }> }> }
  assert.ok(!saved.rows[0]!.left.some(ref => ref.id === 'view-scope'), 'the persisted layout must reflect the toggle')
  assert.equal(app.getFooterMode(), 'custom', 'the app must apply the custom layout')
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
    sessionReader: { list: async () => [], search: async () => [], titles: async () => new Map() },
    sessionWriter: { followup: () => {}, steer: () => {}, dequeue: () => {}, cancel: () => {}, rename: () => true, refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }) },
    host: { settings: () => undefined, llm: () => undefined, credentials: () => undefined, authorization: () => undefined, defaultModel: () => undefined, presets: () => undefined, tools: () => undefined, permission: () => undefined, tokenMeter: () => undefined, commands: () => ctx.get('commands'), persistence: () => undefined },
    interaction: { registerQuestionProvider: () => true, onApprovalRequest: () => {}, setApprovalPolicy: () => true },
    sessions: { flush: async () => {} },
    cwd: '/ws', sessionCwd: () => '/ws', imageStore: {} as never,
    copyToClipboard: async () => true, imageLimits: () => undefined, insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    get sessionGeneration() { return 0 },
    compose: async () => ({ setup: () => {} }),
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
    sessionReader: { list: async () => [], search: async () => [], titles: async () => new Map() },
    sessionWriter: { followup: () => {}, steer: () => {}, dequeue: () => {}, cancel: () => {}, rename: () => true, refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }) },
    host: { settings: () => undefined, llm: () => undefined, credentials: () => undefined, authorization: () => undefined, defaultModel: () => undefined, presets: () => undefined, tools: () => undefined, permission: () => undefined, tokenMeter: () => undefined, commands: () => ctx.get('commands'), persistence: () => undefined },
    interaction: { registerQuestionProvider: () => true, onApprovalRequest: () => {}, setApprovalPolicy: () => true }, sessions: { flush: async () => {} },
    cwd: '/ws', sessionCwd: () => '/ws', imageStore: {} as never,
    copyToClipboard: async () => true, imageLimits: () => undefined, insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    get sessionGeneration() { return 0 },
    compose: async () => ({ setup: () => {} }),
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
  const view = vt.getViewport().join('\n')
  // The configurator lists the persisted layout's single item (model) —
  // the default layout's items are not present.
  assert.ok(view.includes('[x] Model'), `the persisted item must be listed:\n${view}`)
  assert.ok(!view.includes('[x] Permission preset'), `the default-only items must not be listed:\n${view}`)
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
    get: () => ({ theme: 'auto', footer: doc.footer, footerLayout: doc.footerLayout, fullscreen: 'on', busyEnter: 'queue', localShellSandbox: 'bypass', homeEndKeys: 'viewport', focusMode: 'off' }),
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
    sessionReader: { list: async () => [], search: async () => [], titles: async () => new Map() },
    sessionWriter: { followup: () => {}, steer: () => {}, dequeue: () => {}, cancel: () => {}, rename: () => true, refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }) },
    host: { settings: () => undefined, llm: () => undefined, credentials: () => undefined, authorization: () => undefined, defaultModel: () => undefined, presets: () => undefined, tools: () => undefined, permission: () => undefined, tokenMeter: () => undefined, commands: () => ctx.get('commands'), persistence: () => undefined },
    interaction: { registerQuestionProvider: () => true, onApprovalRequest: () => {}, setApprovalPolicy: () => true }, sessions: { flush: async () => {} },
    cwd: '/ws', sessionCwd: () => '/ws', imageStore: {} as never,
    copyToClipboard: async () => true, imageLimits: () => undefined, insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    get sessionGeneration() { return 0 },
    compose: async () => ({ setup: () => {} }),
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
  vt.sendInput(' ')
  vt.sendInput('\r')
  // The write fails: the memory commit must NOT happen (the old layout
  // stays) — the apply is deferred until the write succeeds. Poll a
  // bounded window for any (wrong) apply, then assert none happened.
  const deadline = Date.now() + 300
  while (applied.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(applied.length, 0, 'a failed write must not apply the layout')
  assert.equal(app.getFooterMode(), 'default', 'the old layout must stay active')
  app.stop()
})
