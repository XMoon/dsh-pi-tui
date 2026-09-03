/**
 * Completion-notification /settings panel tests (plan §8): the two rows
 * (Notifications Mode / Notification method) render with their defaults,
 * cycling a row persists the whole document without dropping other
 * fields AND applies the runtime setters, and invalid persisted values
 * fall back to the defaults. Pure — no dsh tree needed.
 * @module @xmoon76/dsh-pi-tui/notification-settings.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { TuiSettingsDoc } from '../src/runtime/config-port.ts'
import { registerTuiCommands, type TuiCommandRunner, type TuiSettingsLike } from '../src/commands.ts'
import { createDiag } from '../src/diag.ts'
import { DraftImageStore } from '../src/image/draft-store.ts'
import { TuiApp } from '../src/tui-app.ts'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import { VirtualTerminal } from './virtual-terminal.ts'
import { DirectCatalogPort } from '../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../src/runtime/direct/host-file-direct.ts'
import { parseNotificationMethod, parseNotificationMode } from '../src/notification/settings.ts'

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

/** Register the TUI commands with a stubbed runner and return /settings
 * plus the recorded runtime notification setter calls. */
function setupSettings(options: { notificationMode?: string; notificationMethod?: string } = {}) {
  const ctx = new Context()
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
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
  ctx.provide('settings', { describe: () => [{ ns: 'dsh-pi-tui', user: {} }] } as never)
  const settings = fakeSettings({
    theme: 'auto',
    footer: 'full',
    fullscreen: 'on',
    busyEnter: 'queue',
    localShellSandbox: 'bypass',
    homeEndKeys: 'viewport',
    focusMode: 'off',
    ...(options.notificationMode === undefined ? {} : { notificationMode: options.notificationMode }),
    ...(options.notificationMethod === undefined ? {} : { notificationMethod: options.notificationMethod }),
  })
  const appliedModes: string[] = []
  const appliedMethods: string[] = []
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
    setNotificationMode: (mode) => { appliedModes.push(mode) },
    setNotificationMethod: (method) => { appliedMethods.push(method) },
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
      commandId: 'x' as never,
      agent: undefined as never,
      rawInput: '',
      signal: new AbortController().signal,
    })
  }
  const view = async (): Promise<string> => {
    await vt.waitForRender()
    return vt.getViewport().join('\n')
  }
  return { vt, app, settings, runner, appliedModes, appliedMethods, run, view }
}

test('the notification rows render with the defaults (Unfocused / Auto)', async () => {
  const t = setupSettings({})
  await t.run()
  await t.view()
  for (let i = 0; i < 12; i += 1) t.vt.sendInput('\x1b[B')
  const view = stripTerminalSequences(await t.view())
  const modeRow = view.split('\n').find(line => line.includes('Notifications'))
  const methodRow = view.split('\n').find(line => line.includes('Notification method'))
  // The panel shows the RAW persisted values (the codebase-wide settings
  // convention — wheel rows show literal step numbers, sandbox rows show
  // 'bypass'); the DESCRIPTION carries the user-facing explanation.
  assert.ok(modeRow !== undefined && modeRow.includes('unfocused'),
    `default mode row must show unfocused (row: ${modeRow}):\n${view}`)
  assert.ok(methodRow !== undefined && methodRow.includes('auto'),
    `default method row must show auto (row: ${methodRow}):\n${view}`)
  t.app.stop()
})

test('persisted values render on the rows; invalid values fall back to the defaults', async () => {
  // Persisted values render verbatim.
  const t = setupSettings({ notificationMode: 'always', notificationMethod: 'osc777' })
  await t.run()
  await t.view()
  for (let i = 0; i < 12; i += 1) t.vt.sendInput('\x1b[B')
  const view = stripTerminalSequences(await t.view())
  assert.ok(view.split('\n').some(line => line.includes('Notifications') && line.includes('always')),
    `persisted mode must render:\n${view}`)
  assert.ok(view.split('\n').some(line => line.includes('Notification method') && line.includes('osc777')),
    `persisted method must render:\n${view}`)
  t.app.dispose()
  // Invalid persisted values fall back to the defaults (never render raw).
  const t2 = setupSettings({ notificationMode: 'garbage', notificationMethod: 'beep' })
  await t2.run()
  await t2.view()
  for (let i = 0; i < 12; i += 1) t2.vt.sendInput('\x1b[B')
  const view2 = stripTerminalSequences(await t2.view())
  assert.ok(view2.split('\n').some(line => line.includes('Notifications') && line.includes('unfocused')),
    `invalid mode must fall back to unfocused:\n${view2}`)
  assert.ok(view2.split('\n').some(line => line.includes('Notification method') && line.includes('auto')),
    `invalid method must fall back to auto:\n${view2}`)
  assert.ok(!view2.includes('garbage') && !view2.includes('beep'),
    `the raw invalid values must never render:\n${view2}`)
  t2.app.stop()
})

test('cycling the mode row applies the runtime setter and persists the whole document', async () => {
  const t = setupSettings({ notificationMode: 'unfocused' })
  await t.run()
  await t.view()
  for (let i = 0; i < 9; i += 1) t.vt.sendInput('\x1b[B') // move to the mode row
  await t.view()
  t.vt.sendInput('\r') // cycle mode: unfocused -> always
  await t.view()
  assert.deepEqual(t.appliedModes, ['always'], 'the runtime setter must receive the chosen mode')
  assert.ok(t.settings.writes.length >= 1, 'the toggle must persist a write')
  const last = t.settings.writes[t.settings.writes.length - 1]
  assert.equal(last?.notificationMode, 'always', `wrote: ${JSON.stringify(last)}`)
  // A replace is wholesale: every other field rides along untouched.
  assert.equal(last?.theme, 'auto')
  assert.equal(last?.footer, 'full')
  assert.equal(last?.focusMode, 'off')
  t.app.stop()
})

test('cycling the method row applies the runtime setter and persists', async () => {
  const t = setupSettings({ notificationMode: 'unfocused', notificationMethod: 'auto' })
  await t.run()
  await t.view()
  for (let i = 0; i < 10; i += 1) t.vt.sendInput('\x1b[B') // move to the method row
  await t.view()
  t.vt.sendInput('\r') // cycle method: auto -> osc9
  await t.view()
  assert.deepEqual(t.appliedMethods, ['osc9'], 'the runtime setter must receive the chosen method')
  assert.ok(t.settings.writes.length >= 1, 'the toggle must persist a write')
  const last = t.settings.writes[t.settings.writes.length - 1]
  assert.equal(last?.notificationMethod, 'osc9', `wrote: ${JSON.stringify(last)}`)
  // The mode field rides along untouched.
  assert.equal(last?.notificationMode, 'unfocused')
  t.app.stop()
})

test('the parsers are the single authority (defaults unfocused/auto)', () => {
  assert.equal(parseNotificationMode(undefined), 'unfocused')
  assert.equal(parseNotificationMode('always'), 'always')
  assert.equal(parseNotificationMode('garbage'), 'unfocused')
  assert.equal(parseNotificationMethod(undefined), 'auto')
  assert.equal(parseNotificationMethod('osc9'), 'osc9')
  assert.equal(parseNotificationMethod('beep'), 'auto')
})
