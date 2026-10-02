/**
 * Git attribution /settings integration tests (the prompt-migration plan
 * §11/§15/§17): the settings row renders the persisted mode, cycling it
 * updates the LIVE holder synchronously (the next prompt assembly follows),
 * persists `gitAttribution` through the whole-document transaction while
 * preserving unrelated fields, and a failed write keeps the runtime change
 * with a notification.
 * @module @xmoon76/dsh-pi-tui/git-attribution-settings.test
 */

import assert from 'node:assert/strict'
import { createClientCommandRegistry } from '../src/app/command/client-command-registry.ts'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { TuiSettingsDoc } from '../src/runtime/config-port.ts'
import { registerTuiCommands, type TuiCommandRunner, type TuiSettingsLike } from '../src/commands.ts'
import { createDiag } from '../src/diag.ts'
import { DraftImageStore } from '../src/image/draft-store.ts'
import { TuiApp } from '../src/tui-app.ts'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import { VirtualTerminal } from './virtual-terminal.ts'
import { sessionScopeFacts } from './session-scope-facts.ts'
import { DirectCatalogPort } from '../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../src/runtime/direct/host-file-direct.ts'
import {
  GIT_ATTRIBUTION_SECTION_NAME,
  installGitAttributionPrompt,
  parseGitAttributionMode,
  type GitAttributionState,
} from '../src/git-attribution.ts'
import type { SystemPromptLike } from '../src/focus.ts'

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

function setupSettings(options: { gitAttribution?: string; failWrite?: boolean } = {}) {
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
    ...(options.gitAttribution === undefined ? {} : { gitAttribution: options.gitAttribution }),
  })
  if (options.failWrite) settings.value.replace = () => { throw new Error('settings unavailable') }
  const gitAttributionState: GitAttributionState = { mode: parseGitAttributionMode(settings.value.get().gitAttribution) }
  const sections = new Map<string, Parameters<SystemPromptLike['section']>[0]>()
  const systemPrompt: SystemPromptLike = {
    section: section => { sections.set(section.name, section); return () => { sections.delete(section.name) } },
  }
  installGitAttributionPrompt(systemPrompt, gitAttributionState)
  const attributionPrompt = (): string => {
    const text = sections.get(GIT_ATTRIBUTION_SECTION_NAME)!.text
    return typeof text === 'function' ? text({}) : text
  }
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
    gitAttributionState,
    displayPreset: () => 'full',
    setDisplayPreset: () => ({ kind: 'applied' as const, preset: 'full' }),
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
  return { app, vt, settings, run, view, gitAttributionState, attributionPrompt }
}

test('the row renders the persisted mode; invalid values fall back to off', async () => {
  // The row sits at the list tail; search-navigate to it (the search box is
  // the focused element, exactly like the other settings-row tests).
  const viewWithRow = async (t: ReturnType<typeof setupSettings>): Promise<string> => {
    t.vt.sendInput('Git attribution')
    const text = await t.view()
    if (!text.includes('Git attribution')) throw new Error('Git attribution row never rendered')
    return text
  }
  const t = setupSettings({ gitAttribution: 'product-model' })
  await t.run()
  const view = await viewWithRow(t)
  assert.ok(view.split('\n').some(line => line.includes('Git attribution') && line.includes('product-model')),
    `persisted mode must render:\n${view}`)
  t.app.dispose()

  const t2 = setupSettings({ gitAttribution: 'garbage' })
  await t2.run()
  const view2 = await viewWithRow(t2)
  assert.ok(view2.split('\n').some(line => line.includes('Git attribution') && line.includes('off')),
    `invalid mode must fall back to off:\n${view2}`)
  assert.ok(!view2.includes('garbage'), 'the raw invalid value never renders')
  t2.app.dispose()
})

test('cycling the row updates the live holder, the prompt text, and persists the whole document', async () => {
  const t = setupSettings()
  await t.run()
  await t.view()
  assert.equal(t.gitAttributionState.mode, 'off')
  assert.equal(t.attributionPrompt(), '')

  // Search-navigate to the row and cycle: off -> product.
  t.vt.sendInput('Git attribution')
  t.vt.sendInput('\r')
  assert.equal(t.gitAttributionState.mode, 'product', 'the live holder switches synchronously')
  assert.ok(t.attributionPrompt().includes('Co-Authored-By: @xmoon76/dsh-pi-tui <dsh-pi-tui@xmoon.org>'),
    'the next prompt assembly carries the trailer guidance')

  await t.view()
  assert.equal(t.settings.writes.length, 1, 'exactly one whole-document write')
  const write = t.settings.writes[0]!
  assert.equal(write.gitAttribution, 'product')
  assert.equal(write.progressUpdates, 'milestones', 'unrelated fields are preserved')
  assert.equal(write.responseStyle, 'default')
  assert.deepEqual(write.keybindings, { 'app.transcript.toggle': ['ctrl+o'] })
  assert.deepEqual(write.customExtension, { enabled: true })
  assert.equal(write.displayPreset, undefined, 'displayPreset is never pinned by an unrelated write')
  t.app.dispose()
})

test('cycling twice reaches product-model and back toward off; persistence follows each step', async () => {
  const t = setupSettings({ gitAttribution: 'product' })
  await t.run()
  await t.view()
  t.vt.sendInput('Git attribution')
  t.vt.sendInput('\r') // product -> product-model
  assert.equal(t.gitAttributionState.mode, 'product-model')
  assert.ok(t.attributionPrompt().includes('Assisted-By: {{provider}}/{{model}}'))
  await t.view()
  t.vt.sendInput('\r') // product-model -> off (wraps)
  assert.equal(t.gitAttributionState.mode, 'off')
  assert.equal(t.attributionPrompt(), '')
  await t.view()
  assert.equal(t.settings.writes.length, 2)
  assert.equal(t.settings.writes[0]!.gitAttribution, 'product-model')
  assert.equal(t.settings.writes[1]!.gitAttribution, 'off')
  t.app.dispose()
})

test('a failed persistence write keeps the runtime change and notifies', async () => {
  const t = setupSettings({ failWrite: true })
  const notifications: string[] = []
  t.app.notify = message => { notifications.push(message) }
  await t.run()
  await t.view()
  t.vt.sendInput('Git attribution')
  t.vt.sendInput('\r')
  assert.equal(t.gitAttributionState.mode, 'product', 'the runtime change survives the failed write')
  assert.ok(t.attributionPrompt().includes('Co-Authored-By'))
  await t.view()
  assert.ok(notifications.some(message => message.includes('settings unavailable')),
    `the write failure surfaces:\n${notifications.join('; ')}`)
  t.app.dispose()
})
