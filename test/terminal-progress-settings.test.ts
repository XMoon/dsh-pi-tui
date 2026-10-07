/**
 * Terminal-progress /settings integration tests (plan §12.3/§12.13/§14.4): the
 * single parser authority, the row's default/invalid fallbacks, the immediate
 * runtime setter, and whole-document persistence through the shared runner
 * fixture. Pure — no dsh tree needed.
 * @module @xmoon76/dsh-pi-tui/terminal-progress-settings.test
 */

import assert from 'node:assert/strict'
import { createClientCommandRegistry } from '../src/app/command/client-command-registry.ts'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { TuiSettingsDoc } from '../src/runtime/config-port.ts'
import { registerTuiCommands, type TuiCommandRunner, type TuiSettingsLike } from '../src/commands.ts'
import { createDiag } from '../src/diag.ts'
import { DraftImageStore } from '../src/client/media/image/draft-store.ts'
import { TuiApp } from '../src/tui-app.ts'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import { VirtualTerminal } from './virtual-terminal.ts'
import { sessionScopeFacts } from './session-scope-facts.ts'
import { DirectCatalogPort } from '../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../src/runtime/direct/host-file-direct.ts'
import {
  DEFAULT_TERMINAL_PROGRESS_MODE,
  parseTerminalProgressMode,
} from '../src/domain/terminal-progress/settings.ts'

/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test (the process slot is released by the FINAL
 * dispose, never by stop()). */
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

/** Register the TUI commands with a stubbed runner and return /settings plus
 * the recorded runtime terminal-progress setter calls. */
function setupSettings(options: { terminalProgress?: string; failWrite?: boolean } = {}) {
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
  ctx.provide('settings', { describe: () => [{ ns: 'tui-app', user: {} }] } as never)
  const settings = fakeSettings({
    theme: 'auto',
    footer: 'full',
    fullscreen: 'on',
    busyEnter: 'queue',
    localShellSandbox: 'bypass',
    homeEndKeys: 'viewport',
    focusMode: 'off',
    progressUpdates: 'milestones',
    responseStyle: 'default',
    keybindings: { 'app.transcript.toggle': ['ctrl+o'] },
    customExtension: { enabled: true },
    ...(options.terminalProgress === undefined ? {} : { terminalProgress: options.terminalProgress }),
  })
  if (options.failWrite) settings.value.replace = () => { throw new Error('settings unavailable') }
  const appliedModes: string[] = []
  const runner: TuiCommandRunner = {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
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
    sessionReader: {
      list: async () => [],
      search: async () => ({ items: [], hasMore: false }),
      projectionBatch: async () => new Map(), blank: () => undefined, measureContext: () => undefined,
      turnOutline: () => undefined, sessionStatus: () => undefined,
    },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    commandRegistry: ctx.get('commands') as import('../src/commands.ts').CommandRegistryLike | undefined,
    clientCommands: createClientCommandRegistry(parseCommand),
    hostFile: new DirectHostFilePort(() => undefined),
    hostShellCompletion: true,
    transcriptExportAvailable: true,
    interaction: {
      questions: {
        onRequest: () => true,
        subscribe: () => undefined,
        snapshot: () => undefined,
        claimTimedWait: async () => undefined,
        answerContinued: async () => 'not-continued' as const,
      },
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
    get pendingPreset() { return undefined },
    set pendingPreset(_id: string | undefined) {},
    get effectivePresetId() { return undefined },
    awaitPendingDefaultWrite: async () => {},
    trackDefaultWrite: () => {},
    setModelSelectionPending: () => {},
    reconcileDefaultIntent: () => {},
    sessionBlank: () => undefined,
    refreshStatus: () => {},
    applyFooterSettings: () => {},
    progressUpdatesState: { mode: 'milestones' },
    responseStyleState: { style: 'default' },
    gitAttributionState: { mode: 'off' },
    displayPreset: () => 'full',
    setDisplayPreset: () => ({ kind: 'applied' as const, preset: 'full' }),
    focusEnabled: () => false,
    setFocusMode: () => {},
    setNotificationMode: () => {},
    setNotificationMethod: () => {},
    setTerminalProgressMode: (mode) => { appliedModes.push(mode) },
    updateWelcomeCard: () => {},
    openJobView: () => {},
    openTasksBrowser: () => {}, openPluginManager: () => {}, createPluginManagerSubmenu: () => ({ render: () => [], invalidate: () => {} }),
    openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withWriter: async <T>(_scope: unknown, task: () => T | Promise<T>) => task(),
    withPromptAdmission: async <T>(_agent: unknown, _line: string, task: () => T | Promise<T>) => task(),
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
    await vt.flush()
  }
  const view = async (): Promise<string> => {
    await vt.waitForRender()
    return stripTerminalSequences(vt.getViewport().join('\n'))
  }
  /** Search-navigate to the row so the test does not depend on row index. */
  const viewRow = async (): Promise<string> => {
    vt.sendInput('Terminal progress')
    const text = await view()
    if (!text.includes('Terminal progress')) throw new Error('Terminal progress row never rendered')
    return text
  }
  return { vt, app, settings, run, view, viewRow, appliedModes }
}

test('the parser is the single authority and fails safe to on', () => {
  assert.equal(DEFAULT_TERMINAL_PROGRESS_MODE, 'on')
  assert.equal(parseTerminalProgressMode(undefined), 'on')
  assert.equal(parseTerminalProgressMode('on'), 'on')
  assert.equal(parseTerminalProgressMode('off'), 'off')
  assert.equal(parseTerminalProgressMode('garbage'), 'on')
})

test('the row renders on when the persisted value is absent', async () => {
  const t = setupSettings()
  await t.run()
  const view = await t.viewRow()
  const row = view.split('\n').find(line => /Terminal progress\s+on\b/.test(line))
  assert.ok(row !== undefined, `absent value must render on:\n${view}`)
  t.app.dispose()
})

test('the row renders on for an invalid persisted value and never the raw string', async () => {
  const t = setupSettings({ terminalProgress: 'garbage' })
  await t.run()
  const view = await t.viewRow()
  const row = view.split('\n').find(line => /Terminal progress\s+on\b/.test(line))
  assert.ok(row !== undefined, `invalid value must fall back to on:\n${view}`)
  assert.ok(!view.includes('garbage'), 'the raw invalid value never renders')
  t.app.dispose()
})

test('cycling the row applies the runtime setter immediately and persists the whole document', async () => {
  const t = setupSettings({ terminalProgress: 'on' })
  await t.run()
  await t.viewRow()
  t.vt.sendInput('\r') // cycle: on -> off
  assert.deepEqual(t.appliedModes, ['off'], 'the runtime setter receives the chosen mode synchronously')
  await t.view()
  assert.equal(t.settings.writes.length, 1, 'exactly one whole-document write')
  const write = t.settings.writes[0]!
  assert.equal(write.terminalProgress, 'off', `wrote: ${JSON.stringify(write)}`)
  assert.equal(write.theme, 'auto', 'unrelated fields are preserved')
  assert.equal(write.progressUpdates, 'milestones', 'the narration cadence is never conflated with this gate')
  assert.deepEqual(write.keybindings, { 'app.transcript.toggle': ['ctrl+o'] })
  assert.deepEqual(write.customExtension, { enabled: true })
  t.app.dispose()
})

test('reopening /settings shows the persisted value', async () => {
  const t = setupSettings({ terminalProgress: 'on' })
  await t.run()
  await t.viewRow()
  t.vt.sendInput('\r') // on -> off
  await t.view()
  t.vt.sendInput('\x1b') // Esc closes without writing
  await t.view()
  await t.run()
  const view = await t.viewRow()
  const row = view.split('\n').find(line => /Terminal progress\s+off\b/.test(line))
  assert.ok(row !== undefined, `reopened row must show the persisted off:\n${view}`)
  t.app.dispose()
})

test('a failed persistence write keeps the runtime change and notifies', async () => {
  const t = setupSettings({ failWrite: true })
  const notifications: string[] = []
  t.app.notify = message => { notifications.push(message) }
  await t.run()
  await t.viewRow()
  t.vt.sendInput('\r')
  assert.deepEqual(t.appliedModes, ['off'], 'the runtime change survives the failed write')
  await t.view()
  assert.ok(notifications.some(message => message.includes('settings unavailable')),
    `the write failure surfaces:\n${notifications.join('; ')}`)
  t.app.dispose()
})
