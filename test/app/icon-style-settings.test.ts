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
import { unavailableAcpAccess, unavailableWebAccess, unavailableMcpServers } from '../support/web-access-fake.ts'
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
import { stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { sessionScopeFacts } from '../support/session-scope-facts.ts'
import { DirectCatalogPort } from '../../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../../src/runtime/direct/host-file-direct.ts'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'
import { confirmSettingsChoice, openSettingsRows, paintedSelectedRowCell, selectSettingsRow } from '../support/settings-workspace-navigation.ts'
import { SettingsRegistry } from '../../src/extension/internal/settings-registry.ts'
import { ThemeRegistry } from '../../src/extension/internal/theme-registry.ts'
import { unconfiguredPolicyObservation, unconfiguredSessionPolicyPort } from '../support/session-policy-fake.ts'


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
  ctx.provide('settings', { describe: () => [{ ns: 'pi-tui-preferences', user: {} }] } as never)
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
    webAccess: unavailableWebAccess(),
    acpAccess: unavailableAcpAccess(),
    mcpServers: unavailableMcpServers(),
    beginClientWrite: () => () => {},
    deliveredFilesSnapshot: () => undefined,
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    get defaultIntentOutcome() { return undefined },
    ...sessionScopeFacts(() => undefined, () => 0),
    sessionPolicy: unconfiguredSessionPolicyPort(),
    sessionMarkdown: { read: async () => ({ kind: 'unavailable' }) },
    policy: unconfiguredPolicyObservation(),
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
    hostShellCompletion: { pathAuthority: 'client', pathLiteralDialect: 'bash', complete: async () => ({ kind: 'ok', candidates: [] }) },
    interaction: {
      questions: {
        onRequest: () => true,
        subscribe: () => undefined,
        snapshot: () => undefined,
        claimTimedWait: async () => undefined,
        answerContinued: async () => 'not-continued' as const,
      },
      onApprovalRequest: () => {},
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
    openTasksBrowser: () => {}, openScheduleWorkspace: () => ({ kind: 'success' } as const), createPluginManagerPage: () => undefined,
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

// ── The 200-column pointer-only scalar journey ──────────────────────────────

const viewRows = (vt: VirtualTerminal): string[] => vt.getViewport().map(stripTerminalSequences)
const barLine = (vt: VirtualTerminal): string => viewRows(vt).at(-1)!

/** One native SGR left-button gesture on 0-based terminal cells. */
function pressCell(vt: VirtualTerminal, row: number, column: number): void {
  vt.sendInput(`\x1b[<0;${column + 1};${row + 1}M`)
}
function releaseCell(vt: VirtualTerminal, row: number, column: number): void {
  vt.sendInput(`\x1b[<0;${column + 1};${row + 1}m`)
}
async function clickSettingsCell(vt: VirtualTerminal, row: number, column: number): Promise<void> {
  pressCell(vt, row, column)
  releaseCell(vt, row, column)
  await vt.waitForRender()
}

/** The cell column of a painted needle on one row (ASCII fixture text). */
const columnOn = (line: string, needle: string): number => {
  const index = line.indexOf(needle)
  assert.ok(index >= 0, `the painted row must contain ${JSON.stringify(needle)}: ${JSON.stringify(line)}`)
  return visibleWidth(line.slice(0, index))
}

/** The painted row of one unique Rows/candidate line. */
function rowOf(vt: VirtualTerminal, needle: string): number {
  const row = viewRows(vt).findIndex(line => line.includes(needle))
  assert.ok(row >= 0, `the frame must contain ${JSON.stringify(needle)}:\n${viewRows(vt).join('\n')}`)
  return row
}

/** Open the Appearance → Icon style choice with the pointer only. */
async function openIconStyleChoiceByPointer(vt: VirtualTerminal): Promise<void> {
  // Rail: click the WIDENED Appearance row cell x=25 (old content origin).
  const appearanceRow = viewRows(vt).findIndex(line => line.slice(0, 30).trimEnd() === '  Appearance' || line.slice(0, 30).trimEnd() === '> Appearance')
  assert.ok(appearanceRow >= 0, `the rail must paint Appearance:\n${viewRows(vt).join('\n')}`)
  await clickSettingsCell(vt, appearanceRow, 25)
  assert.match(viewRows(vt)[0]!, /Settings · Categories/u, 'the rail click keeps the keyboard on the rail')
  // Rows: click the real Icon style row inside its widened pane.
  const iconRow = rowOf(vt, 'Icon style')
  const iconColumn = columnOn(viewRows(vt)[iconRow]!, 'Icon style')
  assert.ok(iconColumn >= 32 && iconColumn < 102, `Icon style paints inside the widened Rows pane: ${iconColumn}`)
  await clickSettingsCell(vt, iconRow, iconColumn + 1)
  assert.match(viewRows(vt)[0]!, /Settings · Appearance · Rows/u, 'the Rows click selects and focuses its level')
  // Rows forward: the painted Enter choose hint opens the same one-step choice.
  const barRow = viewRows(vt).length - 1
  const choose = columnOn(barLine(vt), 'Enter choose')
  await clickSettingsCell(vt, barRow, choose + 2)
  assert.match(viewRows(vt).join('\n'), /Choose value/u, 'the painted forward hint opens the native choice')
}

/** Click one painted Detail button by its visible word. */
async function clickDetailButton(vt: VirtualTerminal, word: string): Promise<void> {
  const rows = viewRows(vt)
  const row = rows.findIndex(line => line.includes(word))
  assert.ok(row >= 0, `the Detail must paint ${JSON.stringify(word)}:\n${rows.join('\n')}`)
  const column = columnOn(rows[row]!, word)
  await clickSettingsCell(vt, row, column + 1)
}

test('the 200-column scalar journey runs pointer-only from the rail to a settled write and back', async () => {
  const t = setupSettings({ iconStyle: 'emoji' })
  try {
    t.vt.resize(120, 40)
    await t.vt.waitForRender()
    t.invoke()
    await t.vt.waitForRender()
    t.vt.resize(200, 40)
    await t.vt.waitForRender()
    // The widened rail and content boundaries from the real painted header.
    const headerRow = rowOf(t.vt, 'Categories (10)')
    assert.equal(columnOn(viewRows(t.vt)[headerRow]!, '[Categories (10)]'), 0, 'the rail starts at x=0')
    assert.equal(columnOn(viewRows(t.vt)[headerRow]!, 'About'), 32, 'the content column starts at x=32')

    await openIconStyleChoiceByPointer(t.vt)
    // Candidate: click the symbol option row, then the pinned Confirm.
    const candidateRow = viewRows(t.vt).findIndex(line => /^(?:> | {2})symbols/u.test(line.slice(104)))
    assert.ok(candidateRow >= 0, `the symbol candidate paints inside the real Detail pane:\n${viewRows(t.vt).join('\n')}`)
    const symbolColumn = viewRows(t.vt)[candidateRow]!.indexOf('symbols')
    assert.ok(symbolColumn >= 104, `the candidate paints inside the real Detail pane: ${symbolColumn}`)
    await clickSettingsCell(t.vt, candidateRow, symbolColumn + 1)
    assert.match(viewRows(t.vt)[candidateRow]!.slice(104), /^> symbols/u, 'the pointer selects the symbol candidate')
    await clickDetailButton(t.vt, 'Confirm')
    for (let round = 0; round < 40 && t.settings.writes.length === 0; round += 1) await t.view()
    assert.equal(t.settings.writes.length, 1, 'ONE pointer Confirm dispatches exactly one write')
    assert.equal(t.app.currentIconStyle(), 'symbols', 'the runtime applies the pointer-chosen style')
    assert.equal(t.settings.writes[0]?.iconStyle, 'symbols')
    const last = t.settings.writes[0]!
    assert.equal(last.theme, 'auto')
    assert.equal(last.footer, 'full')
    assert.equal(last.fullscreen, 'on')
    assert.equal(last.busyEnter, 'queue')
    // The settled result frame keeps the SAME row and names the verified state.
    const settled = await t.view()
    assert.match(settled, /Verified/u, 'the authoritative readback paints its verified state')
    assert.match(settled, /> Icon style/u, 'the settled frame keeps the selected row')

    // The old 120 Detail origin (x=68..101) is now inside the Rows pane: a fresh
    // click there selects a Rows row and never reaches a Detail action.
    const rowsFrame = viewRows(t.vt)
    const statusRow = rowsFrame.findIndex(line => line.includes('Status line mode'))
    assert.ok(statusRow >= 0)
    const statusColumn = columnOn(rowsFrame[statusRow]!, 'Status line mode')
    assert.ok(statusColumn < 104)
    await clickSettingsCell(t.vt, statusRow, 80)
    assert.match(viewRows(t.vt)[0]!, /Settings · Appearance · Rows/u, 'the old Detail-origin click selects the Rows level')
    assert.match(viewRows(t.vt).join('\n'), /> Status line mode/u, 'the click selected the Rows row it painted')
    assert.equal(t.settings.writes.length, 1, 'the overlapping-origin click writes nothing')
    // The new 2-cell gutters (30/31 and 102/103) own no gesture.
    for (const x of [30, 31, 102, 103] as const) {
      await clickSettingsCell(t.vt, statusRow, x)
    }
    assert.match(viewRows(t.vt)[0]!, /Settings · Appearance · Rows/u, 'a gutter click never takes a new owner')
    assert.match(viewRows(t.vt).join('\n'), /> Status line mode/u, 'a gutter click never moves the Rows selection')
    assert.equal(t.settings.writes.length, 1, 'a gutter click never writes')

    // Pointer-only return: Rows Back/Esc -> the rail, then Close exits.
    const rowsBarRow = viewRows(t.vt).length - 1
    const back = columnOn(barLine(t.vt), 'Back [Esc]')
    await clickSettingsCell(t.vt, rowsBarRow, back + 2)
    await t.vt.waitForRender()
    assert.match(viewRows(t.vt)[0]!, /Settings · Categories/u, 'the painted Back returns to the rail')
    const railBarRow = viewRows(t.vt).length - 1
    const close = columnOn(barLine(t.vt), 'Close [Esc]')
    await clickSettingsCell(t.vt, railBarRow, close + 2)
    assert.doesNotMatch(t.vt.getViewport().join('\n'), /Settings ·/u, 'the painted Close exits the ONE Settings lease')

    // ── Cancel path: open the choice again, hold a candidate press across a
    // resize, then cancel with a fresh pointer gesture and zero writes.
    t.vt.resize(200, 40)
    await t.vt.waitForRender()
    t.invoke()
    await t.vt.waitForRender()
    await openIconStyleChoiceByPointer(t.vt)
    // The reopened choice starts on the persisted current option (`symbols`).
    // Press a DIFFERENT, actually painted noncurrent option so an accidentally
    // admitted release would move the selected candidate and be observable.
    const detailColumn = (): number => {
      const header = viewRows(t.vt).find(line => line.includes('Details'))
      assert.ok(header !== undefined, 'the choice frame paints the Details pane')
      const label = header.indexOf('Details')
      return header[label - 1] === '[' ? label - 1 : label
    }
    const choiceRow = (label: string): number => {
      const start = detailColumn()
      return viewRows(t.vt).findIndex(line => new RegExp(`^(?:> | {2})${label}(?: |$)`).test(line.slice(start)))
    }
    const candidateSelected = (label: string): boolean => {
      const start = detailColumn()
      return viewRows(t.vt).some(line => new RegExp(`^> ${label}(?: |$)`).test(line.slice(start)))
    }
    const cancelSymbolRow = choiceRow('symbols')
    const cancelMinimalRow = choiceRow('minimal')
    assert.ok(cancelSymbolRow >= 0, `the current symbol candidate paints:\n${viewRows(t.vt).join('\n')}`)
    assert.ok(cancelMinimalRow >= 0, `the noncurrent minimal candidate paints:\n${viewRows(t.vt).join('\n')}`)
    assert.equal(candidateSelected('symbols'), true, 'the reopened choice starts on the persisted symbol candidate')
    assert.equal(candidateSelected('minimal'), false, 'the different candidate is not selected at press time')
    const minimalColumn = viewRows(t.vt)[cancelMinimalRow]!.indexOf('minimal')
    pressCell(t.vt, cancelMinimalRow, minimalColumn + 1)
    t.vt.resize(160, 40)
    releaseCell(t.vt, cancelMinimalRow, minimalColumn + 1)
    await t.vt.waitForRender()
    assert.equal(t.settings.writes.length, 1, 'the straddling candidate release never writes')
    assert.match(viewRows(t.vt).join('\n'), /Choose value/u, 'the refused release leaves the choice open')
    assert.equal(candidateSelected('symbols'), true, 'the straddling release did not move the selected candidate')
    assert.equal(candidateSelected('minimal'), false, 'the different candidate stayed unselected')
    // A second release with NO fresh press is inert even after the repaint.
    const repaintedMinimal = choiceRow('minimal')
    assert.ok(repaintedMinimal >= 0)
    releaseCell(t.vt, repaintedMinimal, viewRows(t.vt)[repaintedMinimal]!.indexOf('minimal') + 1)
    await t.vt.waitForRender()
    assert.equal(t.settings.writes.length, 1, 'a release without a fresh press never writes')
    assert.equal(candidateSelected('symbols'), true, 'the unpaired release kept the original candidate')
    // A FRESH gesture on a different cell of the same painted option row can
    // select the intended candidate before Cancel, still with no write.
    const freshMinimalRow = choiceRow('minimal')
    await clickSettingsCell(t.vt, freshMinimalRow, detailColumn() + 50)
    assert.equal(candidateSelected('minimal'), true, 'the fresh pointer selects the intended candidate')
    assert.equal(candidateSelected('symbols'), false, 'the previous candidate is no longer selected')
    assert.equal(t.settings.writes.length, 1, 'selecting a candidate never writes')
    // The fresh pointer gesture on the painted Cancel abandons the choice.
    await clickDetailButton(t.vt, 'Cancel')
    await t.vt.waitForRender()
    assert.equal(t.settings.writes.length, 1, 'Cancel writes nothing')
    assert.doesNotMatch(viewRows(t.vt).join('\n'), /Choose value/u, 'Cancel leaves the choice')
  } finally {
    if (!t.app.isDisposed()) t.app.dispose()
  }
})
