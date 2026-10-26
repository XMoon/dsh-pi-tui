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
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { TuiSettingsDoc } from '../../src/runtime/config-port.ts'
import { registerTuiCommands, type TuiCommandRunner, type TuiSettingsLike } from '../../src/commands.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { sessionScopeFacts } from '../support/session-scope-facts.ts'
import { DirectCatalogPort } from '../../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../../src/runtime/direct/host-file-direct.ts'
import {
  GIT_ATTRIBUTION_SECTION_NAME,
  parseGitAttributionMode,
  type GitAttributionState,
} from '../../src/domain/communication/git-attribution.ts'
import { installGitAttributionPrompt, type SystemPromptLike } from '../../src/app/direct/system-prompt.ts'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'
import { confirmSettingsChoice, openSettingsRows, paintedSelectedRowCell, selectSettingsRow } from '../support/settings-workspace-navigation.ts'
import { SettingsRegistry } from '../../src/extension/internal/settings-registry.ts'
import { ThemeRegistry } from '../../src/extension/internal/theme-registry.ts'

/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test (the process slot is released by the FINAL
 * dispose, never by stop()). */
const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
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
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    // The REAL owned-task entry a Settings write runs through.
    runOwned: (_label, task, runOptions) => {
      void Promise.resolve()
        .then(() => task())
        .then(
          result => runOptions.onResult?.(result),
          error => runOptions.onError?.(error),
        )
    },
  })
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
    deliveredFilesSnapshot: () => undefined,
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
    commandRegistry: ctx.get('commands') as import('../../src/commands.ts').CommandRegistryLike | undefined,
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
    // The minimal REAL extension registries: these cases exercise the static
    // Git attribution row, not extension contributions.
    extensions: { themes: new ThemeRegistry(), settings: new SettingsRegistry() } as never,
    exit: () => {},
  }
  registerTuiCommandsWithDirectSeams(runner)
  const def = defs.find(entry => entry.name === 'settings')
  assert.ok(def?.handler !== undefined, 'settings handler missing')
  const invoke = (): unknown => (def!.handler as (inv: { commandId: string; agent: never; rawInput: string; signal: AbortSignal }) => unknown)({
    commandId: 'x' as never,
    agent: undefined as never,
    rawInput: '',
    signal: new AbortController().signal,
  })
  const view = async (): Promise<string> => {
    await vt.waitForRender()
    return stripTerminalSequences(vt.getViewport().join('\n'))
  }
  return { app, vt, settings, invoke, view, gitAttributionState, attributionPrompt }
}

test('the Conversation Git attribution row separates the live mode from an invalid persisted value', async () => {
  const t = setupSettings({ gitAttribution: 'garbage' })
  try {
    await openSettingsRows(t.vt, () => t.invoke(), 'Conversation')
    await selectSettingsRow(t.vt, 'Git attribution')
    const rows = await t.view()
    const row = paintedSelectedRowCell(t.vt) ?? ''
    assert.ok(row.includes('off'), `an invalid persisted value normalizes the live mode to off:\n${rows}`)
    assert.ok(!row.includes('garbage'), `the row never paints the invalid raw value:\n${rows}`)
    t.vt.sendInput('\t') // the ROOT Tab enters the Detail (no choice)
    const detail = await t.view()
    assert.match(detail, /Value\s+off/u, `the primary fact is the live mode:\n${detail}`)
    assert.match(detail, /Persisted\s+garbage/u, `the persisted raw value is its own fact:\n${detail}`)
  } finally {
    if (!t.app.isDisposed()) t.app.dispose()
  }
})

test('explicit Confirms walk every Git attribution candidate through state, prompt and document', async () => {
  const t = setupSettings({ gitAttribution: 'off' })
  try {
    await openSettingsRows(t.vt, () => t.invoke(), 'Conversation')
    await selectSettingsRow(t.vt, 'Git attribution')
    for (const candidate of ['product', 'product-model'] as const) {
      await confirmSettingsChoice(t.vt, candidate, () => t.settings.writes.some(write => write.gitAttribution === candidate))
      assert.equal(t.gitAttributionState.mode, candidate, `the LIVE prompt state moved to ${candidate}`)
      assert.match(t.attributionPrompt(), /Co-Authored-By: @xmoon76\/dsh-pi-tui/u,
        `the registered prompt section reads the same state (${candidate})`)
      assert.equal(t.settings.writes.at(-1)?.gitAttribution, candidate, 'the document stores the raw candidate')
      if (candidate === 'product-model') {
        assert.match(t.attributionPrompt(), /Assisted-By: \{\{provider\}\}\/\{\{model\}\}/u)
        assert.equal(t.settings.writes.at(-1)?.theme, 'auto', 'the whole-document replace preserves other fields')
        assert.deepEqual(t.settings.writes.at(-1)?.customExtension, { enabled: true }, 'unknown fields ride verbatim')
      }
      await t.view()
      t.vt.sendInput('\u001b') // settled Detail -> the SAME lease's Rows
      await t.view()
    }
  } finally {
    if (!t.app.isDisposed()) t.app.dispose()
  }
})

test('a failed persistence write keeps the live Git attribution change and never claims Verified', async () => {
  const t = setupSettings({ gitAttribution: 'off', failWrite: true })
  try {
    await openSettingsRows(t.vt, () => t.invoke(), 'Conversation')
    await selectSettingsRow(t.vt, 'Git attribution')
    await confirmSettingsChoice(t.vt, 'product', async () => (await t.view()).includes('Not saved'))
    assert.equal(t.gitAttributionState.mode, 'product', 'the runtime change survives the refused write')
    assert.match(t.attributionPrompt(), /Co-Authored-By: @xmoon76\/dsh-pi-tui/u,
      'the registered prompt section keeps the applied mode')
    const detail = await t.view()
    assert.match(detail, /Not saved/u, `the refusal is reported:\n${detail}`)
    assert.doesNotMatch(detail, /Status\s+Verified/u, 'a refused write is never Verified')
  } finally {
    if (!t.app.isDisposed()) t.app.dispose()
  }
})
