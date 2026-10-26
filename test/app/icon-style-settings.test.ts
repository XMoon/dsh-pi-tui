/**
 * Icon-style `/settings` tests (plan §17 + §34.8): the row separates the live
 * runtime style from the persisted raw value, missing/invalid persisted values
 * normalize to emoji in the runtime, and an explicit Confirm applies to the app
 * IMMEDIATELY (no restart, no session reload) and persists a whole-document
 * replace that preserves every other field.
 *
 * Migrated in C2-R6 from the retired `Extensions → Configure extension
 * settings…` transition to the real `Appearance → Icon style` workspace row
 * (`docs/guides/testing.md` ownership: the Settings app composition).
 * @module @xmoon76/dsh-pi-tui/icon-style-settings.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { afterEach, test } from 'node:test'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { Context } from '@deepseek-ai/cordis'
import { registerTuiCommands, type TuiCommandRunner, type TuiSettingsLike } from '../../src/commands.ts'
import type { TuiSettingsDoc } from '../../src/runtime/config-port.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { sessionScopeFacts } from '../support/session-scope-facts.ts'
import { DirectCatalogPort } from '../../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../../src/runtime/direct/host-file-direct.ts'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'
import { confirmSettingsChoice, openSettingsRows, paintedSelectedRowCell, selectSettingsRow } from '../support/settings-workspace-navigation.ts'
import { SettingsRegistry } from '../../src/extension/internal/settings-registry.ts'
import { ThemeRegistry } from '../../src/extension/internal/theme-registry.ts'


/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test — the process slot (the vendored fork
 * keybindings are process-global) is released only by the FINAL dispose,
 * never by stop() (see src/tui/process-slot.ts). */
const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

/** A fake TuiSettingsLike recording every replace (the TUI settings
 * document surface; the writes array lets tests assert persistence). */
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

/** Register the TUI commands with a stubbed runner and return the real
 *  `/settings` command's invoke seam. */
function setupSettings(options: { iconStyle?: string } = {}) {
  const ctx = new Context()
  const vt = new VirtualTerminal(100, 24)
  // The production startup normalizes the persisted value; a legal persisted
  // style is what the running surface starts with (an absent/invalid one keeps
  // the shipped emoji default).
  const startupIconStyle = options.iconStyle === 'emoji' || options.iconStyle === 'symbols' || options.iconStyle === 'minimal'
    ? options.iconStyle
    : undefined
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
  }, startupIconStyle === undefined ? undefined : { iconStyle: startupIconStyle })
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
  // The fake document starts from the FULL default shape. When no
  // iconStyle is passed, the field is OMITTED entirely — the exact shape
  // of an old settings file written before the preference existed.
  const settings = fakeSettings({
    theme: 'auto',
    footer: 'full',
    fullscreen: 'on',
    busyEnter: 'queue',
    localShellSandbox: 'bypass',
    homeEndKeys: 'viewport',
    focusMode: 'off',
    wheelScrollLines: '1',
    ...(options.iconStyle === undefined ? {} : { iconStyle: options.iconStyle }),
  })
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
      turnOutline: () => undefined,
      sessionStatus: () => undefined,
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
    // The minimal REAL extension registries: this suite exercises the static
    // Icon style row, not extension contributions.
    extensions: { themes: new ThemeRegistry(), settings: new SettingsRegistry() } as never,
    exit: () => {},
  }
  registerTuiCommandsWithDirectSeams(runner)
  const def = defs.find(entry => entry.name === 'settings')
  assert.ok(def?.handler !== undefined, 'settings handler missing')
  const invoke = (): unknown => (def!.handler as (inv: { commandId: string; agent: never; rawInput: string; signal: AbortSignal }) => unknown)({
    commandId: CommandId('cmd-icon-test'),
    agent: undefined as never,
    rawInput: '',
    signal: new AbortController().signal,
  })
  const view = async (): Promise<string> => {
    await vt.waitForRender()
    return stripTerminalSequences(vt.getViewport().join('\n'))
  }
  return { vt, app, settings, invoke, view }
}

/** Open `Appearance → Icon style` on the real Settings workspace. */
async function openIconStyleRow(t: ReturnType<typeof setupSettings>): Promise<void> {
  await openSettingsRows(t.vt, () => t.invoke(), 'Appearance')
  await selectSettingsRow(t.vt, 'Icon style')
}

test('the Appearance Icon style row separates the runtime style from the persisted raw value', async () => {
  // Missing field (old settings file): runtime emoji, persisted `not set`.
  // Invalid persisted value: runtime emoji, the raw value stays a Detail fact.
  // A persisted minimal value: runtime minimal.
  for (const entry of [
    { stored: undefined, runtime: 'emoji', persisted: 'not set' },
    { stored: 'garbage', runtime: 'emoji', persisted: 'garbage' },
    { stored: 'minimal', runtime: 'minimal', persisted: 'minimal' },
  ] as const) {
    const t = setupSettings(entry.stored === undefined ? {} : { iconStyle: entry.stored })
    try {
      await openIconStyleRow(t)
      const rows = await t.view()
      const selected = paintedSelectedRowCell(t.vt)
      assert.ok(selected?.includes(entry.runtime), `the row states the runtime style (${entry.runtime}):\n${rows}`)
      assert.ok(!selected?.includes('garbage'), `the row never paints an invalid raw value:\n${rows}`)
      // The ROOT Tab enters the Detail (no choice): both facts are separate.
      t.vt.sendInput('\t')
      const detail = await t.view()
      assert.match(detail, new RegExp(`Value\\s+${entry.runtime}`, 'u'),
        `the primary fact is the runtime style:\n${detail}`)
      assert.match(detail, new RegExp(`Persisted\\s+${entry.persisted}`, 'u'),
        `the persisted document fact stays separate:\n${detail}`)
    } finally {
      if (!t.app.isDisposed()) t.app.dispose()
    }
  }
})

test('an explicit Confirm applies the style immediately and persists a merged document', async () => {
  const t = setupSettings({ iconStyle: 'emoji' })
  try {
    await openIconStyleRow(t)
    await confirmSettingsChoice(t.vt, 'symbols', () => t.settings.writes.length > 0)
    // The app runtime switched IMMEDIATELY (no restart, no reload).
    assert.equal(t.app.currentIconStyle(), 'symbols', 'the runtime applies before/with the persistence settlement')
    assert.equal(t.settings.writes.length, 1, 'one explicit Confirm dispatches exactly one write')
    const last = t.settings.writes[0]!
    assert.equal(last.iconStyle, 'symbols', `wrote: ${JSON.stringify(last)}`)
    // The whole-document replace preserves every other field untouched.
    assert.equal(last.theme, 'auto')
    assert.equal(last.footer, 'full')
    assert.equal(last.fullscreen, 'on')
    assert.equal(last.busyEnter, 'queue')
    // The SAME Settings lease keeps the row: the next explicit Confirm still
    // works and the runtime follows it (emoji -> symbols -> minimal).
    t.vt.sendInput('\u001b') // settled Detail -> Rows
    await t.view()
    await confirmSettingsChoice(t.vt, 'minimal', () => t.settings.writes.length > 1)
    assert.equal(t.app.currentIconStyle(), 'minimal', 'the same lease reaches every style')
    assert.equal(t.settings.writes.at(-1)?.iconStyle, 'minimal')
  } finally {
    if (!t.app.isDisposed()) t.app.dispose()
  }
})
