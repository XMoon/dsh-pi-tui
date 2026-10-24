/**
 * Phase 3B / B2-A — the fullscreen Settings workspace (implementation plan v1
 * §9 A-01…A-15, §10 visual evidence).
 *
 * Every case drives the REAL composition: the registered `/settings` command,
 * the real `TuiApp` screen lease, a `VirtualTerminal` and the real read
 * projection over the ConfigPort / DisplayState seams. The only substitutions
 * are the external Host-ish seams a unit composition cannot own (the settings
 * document, the display preset and the theme registry), exactly like the
 * existing `/settings` command-entry suites.
 *
 * The layout/state assertions read what the terminal PHYSICALLY painted
 * (row order, cell columns, truecolor attributes, SGR press/release identity),
 * never a pure `render()` return.
 *
 * @module @xmoon76/dsh-pi-tui/settings-workspace-visual.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { registerTuiCommands, type TuiCommandRunner } from '../../src/commands.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { TuiApp, type OwnedRunner, type TuiAppEvents } from '../../src/tui-app.ts'
import { color, currentPalette, setTheme } from '../../src/tui/theme/runtime.ts'
import { darkColors } from '../../src/domain/display/theme.ts'
import { ThemeRegistry } from '../../src/extension/internal/theme-registry.ts'
import { createDirectSettingsFixture } from '../support/direct-settings-fixture.ts'
import { waitForFrame } from '../support/frame-wait.ts'
import { themePickerRows } from '../../src/app/surface/theme-selection.ts'
import type { CredentialProviderOption, TuiSettingsDoc, VisualToolsState } from '../../src/runtime/config-port.ts'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import type {
  EmbeddedPluginPage,
  PluginContentViewport,
  PluginWorkspaceView,
} from '../../src/tui/plugin-manager/workspace.ts'
import {
  assertBarIsLastRow,
  assertBodyFloor,
  assertNoHalfSegmentInBar,
  assertOneActiveDevice,
  type PaintedFrame,
} from '../support/design-language-frames.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
  // `setTheme` mutates the process-wide palette: leave the dark default behind
  // so a later case never inherits this one's live theme switch.
  setTheme('dark')
})

const DEFAULT_DOC: TuiSettingsDoc = {
  theme: 'auto',
  iconStyle: 'symbols',
  footer: 'default',
  fullscreen: 'off',
  busyEnter: 'queue',
  localShellSandbox: 'off',
  homeEndKeys: 'default',
  notificationMode: 'unfocused',
  notificationMethod: 'auto',
  terminalProgress: '9;4+7501',
  wheelScrollLines: '1',
}

interface HarnessOptions {
  columns?: number
  rows?: number
  /** The settings document; `undefined` with `settingsService: false` means the
   *  port has no settings service at all. */
  doc?: Partial<TuiSettingsDoc>
  settingsService?: boolean
  readiness?: 'ready' | 'stale' | 'unavailable'
  throwOnGet?: boolean
  displayPreset?: string
  themes?: ThemeRegistry
  /** The live clipboard strategy; a promise lets a case hold the settlement. */
  copySelection?: (text: string) => Promise<boolean>
  /** Real provider options the Models page reads. Supplying them enables the
   *  direct page (an unavailable Host paints no provider catalog). */
  providerOptions?: readonly CredentialProviderOption[]
  /**
   * The real persistence behavior of the document. The default is the Direct
   * Host round-trip (the effective document really becomes the replacement);
   * a case can throw the real conflict/failure or silently ignore the write to
   * model an authority that did not accept it.
   */
  applyReplace?: (next: TuiSettingsDoc) => unknown
  /** Hold every owned task until `releaseOwned()` runs it: a settlement really
   *  held across a teardown, like the clipboard's held strategy. */
  holdOwned?: boolean
  /**
   * The REAL settings port to drive instead of the hand-rolled document object:
   * an L6 case passes `createDirectSettingsFixture().settings` so the whole
   * UI -> adapter -> SettingsForms -> authoritative re-read chain is production.
   */
  tuiSettings?: { get(): TuiSettingsDoc; replace(doc: TuiSettingsDoc): unknown }
  /**
   * Build a minimal Plugin page when the Settings Plugins entry activates it
   * (S4-D2 / D2-0): lets a visual case prove that a frame with no painted
   * affordance can never dispatch the entry.
   */
  pluginPage?: boolean
  /** The profile-wide Visual tools state the ConfigPort reads. The default is
   *  the shipped state: enabled from the schema default, both tools registered. */
  visualTools?: VisualToolsState
  /** The visual-tools section is absent/unreadable (`read()` answers undefined). */
  visualToolsUnavailable?: boolean
  /** Make `setEnabled` reject with this reason (a refused Host write). */
  visualToolsWriteFailure?: string
  /** After a successful switch write, keep this `applied` fact: a Host registry
   *  that could not adopt the change (e.g. a same-name conflict). */
  visualToolsAppliedAfterWrite?: boolean
  /** An external writer commits this enabled value (and bumps the revision)
   *  just before the next switch write: the decision is then stale. */
  visualToolsExternalChange?: boolean
}

/** The embedded Plugin Manager page the composition factory hands the Settings
 *  root. It applies the SAME frozen local rule as the production page (one
 *  semantic bar as the local LAST line; the List|Details pair only when the
 *  grant allows it, the local width is >= 76 and six real body rows survive)
 *  and paints a deterministic body inside the granted viewport, so a visual
 *  case can prove the shared chrome, the exact column split and the physical
 *  last-row hand-off without a second TuiApp. */
class FakeEmbeddedPluginPage implements EmbeddedPluginPage {
  readonly viewports: PluginContentViewport[] = []
  disposed = false
  focused = false
  /** Bumps on every fake-local state change (see gestureRevision()). */
  private viewRevision = 0
  private view: PluginWorkspaceView = 'list'
  private readonly yieldNavigation: () => void
  constructor(yieldNavigation: () => void) {
    this.yieldNavigation = yieldNavigation
  }
  setViewport(viewport: PluginContentViewport): void {
    this.viewports.push({ ...viewport })
  }
  currentView(): PluginWorkspaceView {
    return this.view
  }
  canYieldFocusToNavigation(): boolean {
    return this.view === 'list'
  }
  pendingMutation(): boolean {
    return false
  }
  gestureRevision(): number {
    return this.viewRevision
  }

  semanticGeneration(): number {
    return this.viewRevision
  }
  grantAwaitingPaint(): boolean {
    return false
  }

  liveIdentity(): string {
    return `${this.viewRevision}:${this.view}`
  }
  cancelPointer(): void {}
  private layout(): { readonly dual: boolean; readonly leftWidth: number; readonly rightWidth: number; readonly body: number } {
    const viewport = this.viewports[this.viewports.length - 1] ?? { width: 1, rows: 1, allowDual: false }
    const body = Math.max(0, viewport.rows - 1)
    const dual = viewport.allowDual && viewport.width >= 76 && body >= 6
    const leftWidth = dual ? Math.min(42, Math.max(30, Math.floor((viewport.width - 2) * 0.42))) : viewport.width
    return { dual, leftWidth, rightWidth: dual ? viewport.width - leftWidth - 2 : viewport.width, body }
  }
  contentLayout(): { readonly dual: boolean; readonly leftWidth: number; readonly rightWidth: number } {
    const { dual, leftWidth, rightWidth } = this.layout()
    return { dual, leftWidth, rightWidth }
  }
  render(width: number): string[] {
    const viewport = this.viewports[this.viewports.length - 1] ?? { width: Math.max(1, width), rows: 1, allowDual: false }
    const { dual, leftWidth, rightWidth, body } = this.layout()
    const lines: string[] = []
    for (let index = 0; index < body; index += 1) {
      if (dual) {
        const left = index === 0 ? 'PLUGIN PAGE LIST'.padEnd(leftWidth) : ' '.repeat(leftWidth)
        const right = index === 0 ? 'PLUGIN DETAIL'.padEnd(rightWidth) : ' '.repeat(rightWidth)
        lines.push(`${left}  ${right}`)
      } else {
        lines.push((index === 0 ? 'PLUGIN PAGE' : '').padEnd(Math.max(1, width)))
      }
    }
    lines.push(color.textMuted('PLUGIN BAR'.padEnd(Math.max(1, viewport.width))))
    return lines
  }
  invalidate(): void {}
  handleInput(data: string): void {
    if (data === '\u001b' && this.canYieldFocusToNavigation()) this.yieldNavigation()
  }
  handleMouse(): undefined { return undefined }
  onCellPress(): void {}
  onCellClick(): void {}
  dispose(): void { this.disposed = true }
}

interface Harness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly copied: string[]
  /** The live settings document the projection reads. */
  readonly doc: TuiSettingsDoc
  readonly invoke: (name?: string, rawInput?: string) => unknown
  /** Open the workspace and walk the category rail to one category. */
  readonly open: (category?: string) => Promise<void>
  /** Walk the category rail to one category (the workspace is already open). */
  readonly walkToCategory: (category: string) => Promise<void>
  /** Open the workspace at its real entry: the About home. */
  readonly openHome: () => Promise<void>
  readonly rowsPlain: () => string[]
  readonly view: () => string
  /** How many times the projection read the live document. */
  readonly reads: () => number
  /** How many settings WRITES were attempted (browsing never writes). */
  readonly replacements: () => number
  /** Every document a write really dispatched, in order. */
  readonly replaced: () => readonly TuiSettingsDoc[]
  /** Every runner capability the commands called, in order. */
  readonly calls: () => readonly string[]
  /** Every `diag.warn` the commands recorded (the write-owner failure trail). */
  readonly warnings: () => readonly { readonly message: string; readonly fields?: Record<string, unknown> }[]
  /** Every `visualTools.setEnabled` value the UI dispatched, in order. */
  readonly visualWrites: () => readonly boolean[]
  /** The current fake Host state the ConfigPort reads. */
  readonly visualState: () => VisualToolsState | undefined
  /** Every byte the app wrote to the terminal (the raw write sink). */
  readonly writes: () => readonly string[]
  /** Run every owned task the harness is holding (`holdOwned`). */
  readonly releaseOwned: () => void
  /** How many times the Settings Plugins entry built its page. */
  readonly pluginPages: () => number
  /** The page instances the composition factory handed the root. */
  readonly pluginPageInstances: () => readonly FakeEmbeddedPluginPage[]
  /** Host/provider/account reads in the fake seams (the hidden-action witness). */
  readonly hostReads: () => number
  readonly dispose: () => void
}

/** The painted category order of the Settings rail (the harness walks it). */
const CATEGORY_ORDER = ['About', 'Models', 'Account', 'Appearance', 'Display', 'Tools', 'Plugins', 'Other settings']

/** Whether the painted frame shows the Settings category rail. A narrow
 *  terminal paints the single-column category list OR the About content, so
 *  the rail's own labels are the witness. */
const railVisible = (vt: VirtualTerminal): boolean =>
  vt.getViewport().map(stripTerminalSequences)
    .some(line => /^(?:> | {2})(?:About|Models|Account|Appearance|Display|Tools|Plugins|Other settings)(?: {2,}|\s*$)/u.test(line))

function setup(options: HarnessOptions = {}): Harness {
  const columns = options.columns ?? 120
  const rows = options.rows ?? 40
  const vt = new VirtualTerminal(columns, rows)
  const copied: string[] = []
  const writes: string[] = []
  const replaced: TuiSettingsDoc[] = []
  const calls: string[] = []
  const warnings: { message: string; fields?: Record<string, unknown> }[] = []
  const held: Array<() => void> = []
  let reads = 0
  let hostReads = 0
  let replacements = 0
  let pluginPages = 0
  const pluginPageInstances: FakeEmbeddedPluginPage[] = []
  const visualWrites: boolean[] = []
  let externalVisualChange = options.visualToolsExternalChange
  let visualState: VisualToolsState | undefined = options.visualToolsUnavailable === true
    ? undefined
    : options.visualTools ?? { enabled: true, revision: 1, userOverridden: false, applied: true }
  const doc: TuiSettingsDoc = { ...DEFAULT_DOC, ...options.doc }
  // A real owned runner: the copy intent must travel the production `runOwned`
  // ownership path instead of a stubbed promise.
  const owned: OwnedRunner = (_label, task, runOptions) => {
    const run = (): void => {
      void Promise.resolve()
        .then(() => task())
        .then(
          result => runOptions.onResult?.(result),
          error => runOptions.onError?.(error),
        )
    }
    if (options.holdOwned === true) held.push(run)
    else run()
  }
  const events: TuiAppEvents = { onSubmit: () => {}, onExit: () => {}, runOwned: owned }
  const originalWrite = vt.write.bind(vt)
  vt.write = (data: string): void => { writes.push(data); originalWrite(data) }
  const app = new TuiApp(vt, events, {
    copySelection: options.copySelection ?? (async (text: string) => { copied.push(text); return true }),
  })
  app.start()
  if (options.displayPreset !== undefined && options.displayPreset !== app.displayPreset()) {
    app.setDisplayPreset(options.displayPreset as Parameters<typeof app.setDisplayPreset>[0])
  }
  startedApps.add(app)
  const defs: { name: string; handler?: unknown }[] = []
  const commands = {
    register: (definition: { name: string; handler?: unknown }) => { defs.push(definition); return () => {} },
    list: () => [],
    find: () => undefined,
    execute: async () => undefined,
  }
  const ctx = new Context()
  ctx.provide('commands', commands as never)
  ctx.provide('skills', { list: async () => [], get: async () => undefined, find: () => undefined, execute: async () => undefined } as never)
  const base: Record<string, unknown> = {
    ctx,
    app,
    diag: (() => {
      const diag = createDiag({ filePath: undefined, stderrLevel: 'off' })
      return { ...diag, warn: (message: string, fields?: Record<string, unknown>) => { warnings.push({ message, ...fields === undefined ? {} : { fields } }); diag.warn(message, fields) } }
    })(),
    cwd: '/ws',
    sessionCwd: () => '/ws',
    progressUpdatesState: { mode: 'milestones' },
    responseStyleState: { style: 'default' },
    gitAttributionState: { mode: 'off' },
    signal: new AbortController().signal,
    commandRegistry: commands,
    clientCommands: createClientCommandRegistry(parseCommand),
    recordExtensionError: () => {},
    clearExtensionError: () => {},
    captureExtensionHealthRef: () => () => {},
    // A sessionless surface: the completion install and the legacy session rows
    // must see no live scope.
    currentSessionId: undefined,
    captureLiveSessionScope: () => undefined,
    // C3 About seams (this suite's stub composes no StatusRuntime): the
    // sessionless capture answers `unavailable` and no listener ever fires.
    isSessionScopeCurrent: () => false,
    currentSessionStats: async () => undefined,
    sessionReader: { measureContext: () => undefined, sessionStatus: () => undefined },
    forceContextMeasurementResult: () => ({ value: undefined, observation: 'unavailable' as const }),
    backendKind: 'direct' as const,
    subscribeSessionScopeInvalidation: () => () => {},
    listScopedCommands: () => [],
    displayPreset: () => app.displayPreset(),
    focusEnabled: () => app.displayPreset() === 'focus',
    // The production `/display` owner would dispatch its OWN detached write;
    // recording the call proves the B2-B writer never routes through it (a
    // double write would be invisible in the replacement count alone).
    setDisplayPreset: (preset: string) => {
      calls.push(`setDisplayPreset:${preset}`)
      return { kind: 'unchanged', preset }
    },
    // The direct Models/Account pages copy through the runner's clipboard seam;
    // record it on the same sink the About copy intents use.
    copyToClipboard: async (text: string) => {
      copied.push(text)
      return true
    },
    refreshStatus: () => { calls.push('refreshStatus') },
    tuiSettings: options.settingsService === false
      ? undefined
      : options.tuiSettings ?? {
          get: () => {
            reads += 1
            if (options.throwOnGet === true) throw new Error('settings read exploded')
            return doc
          },
          replace: (next: TuiSettingsDoc) => {
            replacements += 1
            replaced.push(next)
            if (options.applyReplace === undefined) Object.assign(doc, next)
            else return options.applyReplace(next)
          },
        },
    extensions: options.themes === undefined ? undefined : { themes: options.themes },
    createPluginManagerPage: (onYieldNavigation: () => void) => {
      if (options.pluginPage !== true) return undefined
      pluginPages += 1
      const page = new FakeEmbeddedPluginPage(onYieldNavigation)
      pluginPageInstances.push(page)
      return page
    },
    config: {
      configReadiness: () => options.readiness ?? 'ready',
      visualTools: {
        read: () => visualState,
        setEnabled: async (enabled: boolean, revision: number) => {
          visualWrites.push(enabled)
          if (externalVisualChange !== undefined && visualState !== undefined) {
            visualState = {
              ...visualState,
              enabled: externalVisualChange,
              userOverridden: true,
              applied: externalVisualChange,
              revision: visualState.revision + 1,
            }
            externalVisualChange = undefined
          }
          if (options.visualToolsWriteFailure !== undefined) throw new Error(options.visualToolsWriteFailure)
          if (visualState !== undefined && visualState.revision !== revision) {
            throw new Error(`settings namespace "pi-tui-visual-tools" changed since it was read (expected revision ${revision}, now ${visualState.revision})`)
          }
          if (visualState !== undefined) {
            visualState = {
              ...visualState,
              enabled,
              userOverridden: true,
              applied: options.visualToolsAppliedAfterWrite ?? enabled,
              revision: visualState.revision + 1,
            }
          }
        },
      },
      footerCustomItems: { rawForPersistence: () => ({ kind: 'available', value: undefined }) },
      permissions: { presetNames: () => [], defaultPreset: () => undefined, approvalOverrideOf: () => undefined, approvalOverrideAvailable: () => false },
      subagentModelSelection: { available: () => false },
      // The Web provider section is Host-only (S2/PR-B): this stub composes no
      // Host settings plane, so the section reports unavailable and offers no write.
      web: { available: () => false },
      // The credential STORE is not mounted either: the Web section's key row
      // reports unavailable instead of claiming "not configured".
      credentials: { available: () => options.providerOptions !== undefined, recordsSupported: () => false },
      // The Models/Account direct pages are REAL pages: the category rail
      // mounts the selected one (Phase 3C / C2-A), so these Host seams must
      // answer the calls a page makes while it is on screen. They report an
      // empty, unavailable Host — no provider, no record, no account.
      providers: {
        available: () => options.providerOptions !== undefined,
        listCredentialOptions: () => {
          hostReads += 1
          return options.providerOptions ?? []
        },
        readCatalog: () => {
          hostReads += 1
          return { options: options.providerOptions ?? [], profiles: [] }
        },
        readProfile: (route: string) => {
          hostReads += 1
          return { route, configured: false, displayName: route, models: [] }
        },
        configGuide: () => ({ profilePatchPath: '/home/u/.dsh/profiles/pi-tui/cordis.patch.yml' }),
        writeProfile: async () => {},
        writeKeylessProfile: async () => ({ kind: 'written' as const }),
      },
      authorization: {
        available: () => false,
        listTargets: () => [],
        begin: async () => ({ kind: 'unavailable' as const }),
        onEvent: () => () => {},
        respond: async () => {},
        cancel: async () => {},
      },
      account: {
        available: () => false,
        getState: async () => {
          hostReads += 1
          throw new Error('account unavailable')
        },
        getProfile: async () => null,
        getBalance: async () => null,
        watch: async function* () {},
        getCallbackOrigin: () => undefined,
        startSignIn: async () => { throw new Error('account unavailable') },
        cancelSignIn: async () => { throw new Error('account unavailable') },
        signOut: async () => { throw new Error('account unavailable') },
        hasRunningAccountTasks: () => false,
      },
    },
    catalog: { models: { available: () => false } },
  }
  const runner = new Proxy(base, {
    get: (target, property) => property in target ? target[property as string] : () => undefined,
  }) as unknown as TuiCommandRunner
  registerTuiCommandsWithDirectSeams(runner)
  const invoke = (name = 'settings', rawInput = ''): unknown => {
    const definition = defs.find(candidate => candidate.name === name)
    assert.ok(definition?.handler !== undefined, `/${name} must be registered`)
    return (definition.handler as (invocation: { rawInput: string }) => unknown)({ rawInput })
  }
  /** Open the workspace at its REAL entry: the About home. */
  const openHome = async (): Promise<void> => {
    invoke('settings')
    await vt.waitForRender()
  }
  /**
   * Open the workspace and move the category rail to one category. The
   * workspace's own entry is the About home (Phase 3C / C2-A), so a case that
   * exercises the LEGACY configuration categories has to walk the rail — the
   * same keys a user presses.
   */
  const open = async (category: string = 'Appearance'): Promise<void> => {
    await openHome()
    await walkToCategory(category)
  }
  /**
   * Walk the category rail to one category. The rail is the ONLY selection
   * owner, so the helper presses the rail's own keys.
   */
  const walkToCategory = async (category: string): Promise<void> => {
    const target = CATEGORY_ORDER.indexOf(category)
    assert.ok(target >= 0, `the harness must know the category ${JSON.stringify(category)}`)
    if (!railVisible(vt)) {
      // A narrow terminal opens on the About CONTENT: Esc returns to the rail.
      vt.sendInput('\u001b')
      await vt.waitForRender()
    }
    for (let index = 0; index < target; index += 1) {
      vt.sendInput('\u001b[B')
      await vt.waitForRender()
    }
  }
  const rowsPlain = (): string[] => vt.getViewport().map(stripTerminalSequences)
  const view = (): string => rowsPlain().join('\n')
  const dispose = (): void => {
    startedApps.delete(app)
    if (!app.isDisposed()) app.dispose()
  }
  return {
    vt,
    app,
    copied,
    doc,
    invoke,
    open,
    openHome,
    walkToCategory,
    rowsPlain,
    view,
    reads: () => reads,
    replacements: () => replacements,
    replaced: () => replaced,
    calls: () => calls,
    warnings: () => warnings,
    visualWrites: () => visualWrites,
    visualState: () => visualState,
    writes: () => writes,
    pluginPages: () => pluginPages,
    pluginPageInstances: () => pluginPageInstances,
    hostReads: () => hostReads,
    releaseOwned: () => {
      const list = held.splice(0)
      for (const run of list) run()
    },
    dispose,
  }
}

const rowOf = (h: Harness, needle: string): number => {
  const row = h.rowsPlain().findIndex(line => line.includes(needle))
  assert.ok(row >= 0, `the painted frame must contain ${JSON.stringify(needle)}:\n${h.view()}`)
  return row
}

/** The terminal-CELL column of the first painted occurrence of `needle`. */
const cellIndexOf = (h: Harness, row: number, needle: string): number => {
  const plain = h.rowsPlain()[row]
  assert.ok(plain !== undefined, `row ${row} must be painted:\n${h.view()}`)
  const index = plain.indexOf(needle)
  assert.ok(index >= 0, `row ${row} must contain ${JSON.stringify(needle)}: ${JSON.stringify(plain)}`)
  return visibleWidth(plain.slice(0, index))
}

/**
 * The painted ROWS-column cells of one frame line, located from the pane header
 * so the assertion follows the real geometry of the current level (medium L0
 * paints the list in its second column, medium L1/L2 and wide in their own).
 */
const rowsPaneText = (h: Harness, row: number): string => {
  const plain = h.rowsPlain()
  const header = plain.find(candidate => candidate.includes('Rows ('))
  assert.ok(header !== undefined, `the rows pane header must be painted:\n${h.view()}`)
  const start = header.indexOf('Rows (')
  const detailAt = header.indexOf('Details', start)
  const end = detailAt < 0 ? plain[row]!.length : detailAt - 2
  return plain[row]!.slice(start, end)
}

/** One native SGR left-button gesture (1-based terminal cells). */
const press = (h: Harness, row: number, col: number): void => { h.vt.sendInput(`\x1b[<0;${col + 1};${row + 1}M`) }
const release = (h: Harness, row: number, col: number): void => { h.vt.sendInput(`\x1b[<0;${col + 1};${row + 1}m`) }
const wheel = (h: Harness, row: number, col: number, down = true): void => {
  h.vt.sendInput(`\x1b[<${down ? 65 : 64};${col + 1};${row + 1}M`)
}

async function settle(h: Harness, rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
  await h.vt.waitForRender()
}

const key = async (h: Harness, data: string): Promise<void> => {
  h.vt.sendInput(data)
  await h.vt.waitForRender()
}

const pluginThemes = (): ThemeRegistry => {
  const themes = new ThemeRegistry()
  themes.register({ id: 'solarized', name: 'Solarized', palette: { text: '#123456' } as never }, 'acme-owner', 'acme')
  return themes
}

const hexToRgb = (hex: string): number =>
  (parseInt(hex.slice(1, 3), 16) << 16) | (parseInt(hex.slice(3, 5), 16) << 8) | parseInt(hex.slice(5, 7), 16)

const assertRowWidths = (h: Harness, columns: number): void => {
  for (const [index, line] of h.vt.getViewport().entries()) {
    assert.ok(visibleWidth(line) <= columns, `row ${index} must fit ${columns} cells: ${JSON.stringify(stripTerminalSequences(line))}`)
  }
}

// ── A-01: the dedicated fullscreen workspace ───────────────────────────────

test('A-01 /settings enters a dedicated fullscreen workspace: Settings chrome owns the frame, no editor row behind it', async () => {
  const h = setup({ columns: 100, rows: 40 })
  await h.vt.waitForRender()
  assert.match(h.view(), /❯/, 'the regular editor seat is painted before opening')
  await h.open()
  const rows = h.rowsPlain()
  assert.ok(rows[0]?.startsWith('Settings'), `the Settings header owns row 0:\n${h.view()}`)
  assert.match(rows[0]!, /Settings · Categories/, 'every width opens on the L0 categories level')
  assert.ok(!h.view().includes('❯'), `no editor/transcript row may render behind the workspace:\n${h.view()}`)
  assert.match(rows.at(-1) ?? '', /Right open · Enter open · Tab panes · Esc close/, 'the Settings Action Bar is pinned to the physical last row')
  assert.match(h.view(), /Rows \(2\)/, 'the row list column is part of the workspace body')
  h.dispose()
})

// ── A-02 / A-03: the wide and medium projections ──────────────────────────

test('A-02 200x60 and 160x40 paint the three-column projection with the real value/source facts', async () => {
  for (const [columns, rows] of [[200, 60], [160, 40]] as const) {
    const h = setup({ columns, rows, doc: { theme: 'plugin:acme/solarized' }, themes: pluginThemes() })
    await h.open()
    const paneRow = rowOf(h, 'Categories (8)')
    const paneLine = h.rowsPlain()[paneRow]!
    assert.match(paneLine, /Rows \(2\)/, 'the middle column is the current category rows')
    assert.match(paneLine, /Details/, 'the third column is the detail pane')
    assert.match(h.view(), /Solarized/, 'the friendly theme label is in the detail')
    assert.match(h.view(), /plugin:acme\/solarized/, 'the raw source-qualified identity is the copy source')
    assertRowWidths(h, columns)
    h.dispose()
  }
})

test('A-03 100x40 and 76x24 project the medium composition per level and switch category with ↑↓', async () => {
  for (const [columns, rows] of [[100, 40], [76, 24]] as const) {
  const h = setup({ columns, rows, doc: { theme: 'plugin:acme/solarized' }, themes: pluginThemes() })
  await h.open()
  // L0 paints categories + rows only; the retired header arrows never paint.
  assert.match(h.rowsPlain()[rowOf(h, 'Categories (8)')]!, /\[Categories \(8\)\]/, 'L0 owns the categories level')
  assert.ok(h.rowsPlain().some(line => line.includes('Rows (2)')), `the rows column exists:\n${h.view()}`)
  assert.ok(!h.view().includes('Details'), 'L0 does not paint the Detail column')
  assert.ok(!h.view().includes('←'), 'no medium header category arrows')
  // The categories level moves with ↑↓.
  await key(h, '\x1b[B')
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Display')), `Down selects the next category:\n${h.view()}`)
  await key(h, '\x1b[A')
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Appearance')))
  // Enter advances to L1: rows + detail, no categories column.
  await key(h, '\r')
  assert.match(h.rowsPlain()[rowOf(h, 'Details')]!, /Details/, 'L1 paints the Detail column')
  assert.ok(!h.view().includes('Categories (8)'), 'L1 hides the categories column')
  // Right enters L2's inline choice directly from L1 on the same projection.
  await key(h, '\x1b[C')
  assert.match(h.view(), /Choose value/, 'the one-step detail entry opens the inline choice')
  const detailHeader = h.rowsPlain()[rowOf(h, 'Details')]!
  assert.match(detailHeader, /\[Details\]/, 'the focused Detail title remains visible while choosing')
  const choiceHeading = rowOf(h, 'Choose value')
  assert.ok(h.rowsPlain().slice(choiceHeading + 1).some(line => />\s+\S+/.test(line)), 'the selected candidate identity remains visible')
  assert.match(h.view(), /Enter confirm/, 'confirmation is explicit and advertised')
  h.dispose()
  }
})

test('A-03b the wide inline choice keeps the focused pane title as its phase changes', async () => {
  const h = setup({ columns: 200, rows: 50, doc: { theme: 'dark' } })
  await h.open()
  await key(h, '\r') // Categories -> Rows
  const before = h.rowsPlain()[rowOf(h, 'Rows (2)')]!
  assert.match(before, /\[Rows \(2\)\]/, 'the Rows pane owns focus before editing')
  await key(h, '\x1b[C') // Rows -> inline choice
  const after = h.rowsPlain()[rowOf(h, 'Details')]!
  assert.match(after, /\[Details\]/, 'the Detail pane remains visibly focused while choosing')
  assert.ok(h.view().includes('Choose value'), `the choice remains visible:\n${h.view()}`)
  assert.ok(h.view().includes('> dark'), `the current candidate remains visible:\n${h.view()}`)
  h.dispose()
})

test('A-03c a short inline choice exposes only Esc when the pane title consumes the body budget', async () => {
  for (const rows of [3, 4] as const) {
    const h = setup({ columns: 200, rows, doc: { theme: 'dark' } })
    await h.open()
    await key(h, '\r') // Categories -> Rows
    await key(h, '\x1b[C') // Rows -> inline choice
    const hasFocusedDetails = h.rowsPlain().some(line => line.includes('[Details]'))
    assert.equal(hasFocusedDetails, rows === 4,
      `the pane title requires a remaining candidate row at 200x${rows}:\n${h.view()}`)
    assert.ok(h.view().includes('> dark'), `the selected candidate remains painted at 200x${rows}:\n${h.view()}`)
    assert.ok(!h.view().includes('Enter confirm'), `confirmation is withheld without enough body rows at 200x${rows}:\n${h.view()}`)
    const actionBar = h.rowsPlain().at(-1) ?? ''
    assert.match(actionBar, /^Esc back/, `only the safe back action is advertised at 200x${rows}`)
    for (const hiddenHint of ['Up/Down', 'PgUp/PgDn', 'Enter confirm', 'c copy']) {
      assert.ok(!actionBar.includes(hiddenHint), `${hiddenHint} is not advertised at 200x${rows}: ${actionBar}`)
    }

    const beforeHiddenActions = h.view()
    for (const [name, data] of [
      ['Up', '\x1b[A'],
      ['Down', '\x1b[B'],
      ['PageUp', '\x1b[5~'],
      ['PageDown', '\x1b[6~'],
      ['Home', '\x1b[H'],
      ['End', '\x1b[F'],
    ] as const) {
      await key(h, data)
      assert.equal(h.view(), beforeHiddenActions, `${name} is inert when only Esc is advertised at 200x${rows}`)
      assert.equal(h.replacements(), 0, `${name} never writes at 200x${rows}`)
    }

    await key(h, rows === 3 ? '\x1b' : '\x1b[D') // Esc / Left still cancels the choice.
    h.vt.resize(200, 24)
    await h.vt.waitForRender()
    assert.match(h.rowsPlain()[0]!, /· Rows/, `the safe back action remains live at 200x${rows}`)
    assert.equal(h.replacements(), 0, `cancelling at 200x${rows} never writes`)
    assert.equal(h.doc.theme, 'dark')
    h.dispose()
  }
})

test('A-03d a resize before repaint revokes the previous choice-navigation grant', async () => {
  const h = setup({ columns: 200, rows: 24, doc: { theme: 'dark' } })
  await h.open()
  await key(h, '\r') // Categories -> Rows
  await key(h, '\x1b[C') // Rows -> inline choice
  assert.ok(h.rowsPlain().at(-1)?.includes('Up/Down choose'), `the tall frame advertises navigation:\n${h.view()}`)

  // The terminal geometry changes immediately; deliver input before waiting for
  // the resize repaint so a grant from the previous frame cannot leak through.
  h.vt.resize(200, 3)
  h.vt.sendInput('\x1b[B') // Down is no longer advertised at the live height.
  await h.vt.waitForRender()
  assert.match(h.rowsPlain().at(-1) ?? '', /^Esc back/)
  h.vt.resize(200, 24)
  await h.vt.waitForRender()
  assert.ok(h.view().includes('> dark'), `the stale Down did not change the candidate:\n${h.view()}`)
  assert.equal(h.replacements(), 0)
  assert.equal(h.doc.theme, 'dark')
  h.dispose()
})

// ── A-04: the narrow drill-down ───────────────────────────────────────────

test('A-04 72x24 drills categories → rows → detail with one Esc per level and a final close', async () => {
  const h = setup({ columns: 72, rows: 24, doc: { theme: 'plugin:acme/solarized' }, themes: pluginThemes() })
  await h.open()
  assert.match(h.rowsPlain()[0]!, /Settings · Categories/)
  await key(h, '\r')
  assert.match(h.rowsPlain()[0]!, /Settings · Appearance · Rows/)
  await key(h, '\r')
  assert.match(h.rowsPlain()[0]!, /Settings · Appearance · Configured theme/)
  assert.match(h.view(), /plugin:acme\/solarized/, 'the detail shows the exact source value')
  await key(h, '\x1b')
  assert.match(h.rowsPlain()[0]!, /· Rows/, 'Esc returns to the rows level')
  await key(h, '\x1b')
  assert.match(h.rowsPlain()[0]!, /Categories/, 'Esc returns to the categories level')
  await key(h, '\x1b')
  assert.ok(h.view().includes('❯'), `Esc at the root closes to the editor:\n${h.view()}`)
  h.dispose()
})

test('A-04b 44x8 shows the old value, current candidate identity and explicit confirm', async () => {
  const longTheme = 'file:a-very-long-custom-theme-name-that-must-wrap-across-cells'
  const h = setup({ columns: 44, rows: 8, doc: { theme: longTheme } })
  await h.open()
  assert.match(h.rowsPlain().at(-1) ?? '', /Enter open · Esc close/, 'the Action Bar is the physical last row')
  await key(h, '\r') // categories -> rows (Appearance)
  await key(h, '\r') // L1 -> inline choice
  assert.match(h.rowsPlain()[0]!, /Appearance · Configure/)
  assert.ok(h.view().includes('Value'), `the persisted old value remains in the granted facts region:\n${h.view()}`)
  const visibleIdentity = h.rowsPlain().map(line => line.trim()).join('')
  assert.ok(visibleIdentity.includes(longTheme), `the complete selected source-qualified identity is painted:\n${h.view()}`)
  assert.match(h.view(), /^.*> \S+/mu, 'the candidate head is visible before confirmation')
  assert.match(h.rowsPlain().at(-1) ?? '', /Enter confirm/, 'Enter is explicitly advertised for the visible candidate')
  assertRowWidths(h, 44)
  assert.equal(h.replacements(), 0, 'opening a candidate never commits')
  await key(h, '\x1b')
  assert.equal(h.replacements(), 0, 'Esc cancels the short-screen choice')
  h.dispose()
})

// ── A-05: the extreme-height allocation ───────────────────────────────────

test('A-05 every height keeps the pinned bar last, grants a real body from 3 rows, and Esc always escapes', async () => {
  for (const rows of [1, 2, 3, 4, 5, 8, 10, 24]) {
    const h = setup({ columns: 72, rows })
    await h.open()
    const painted = h.rowsPlain()
    assert.equal(painted.length, rows, `the frame must paint exactly ${rows} rows`)
    assert.match(painted.at(-1) ?? '', /Esc close/, `the Action Bar is pinned at rows=${rows}`)
    if (rows >= 3) {
      assert.ok(painted.some(line => line.includes('Appearance')), `at least one real body row at rows=${rows}:\n${h.view()}`)
    }
    await key(h, '\x1b')
    assert.ok(h.view().includes('❯') || !h.view().includes('Settings'), `Esc must escape at rows=${rows}:\n${h.view()}`)
    h.dispose()
  }
})

// ── A-06: resize only re-projects ─────────────────────────────────────────

test('A-06 200 → 72 → 44 → 200 preserves the category, the row, the level and the focus', async () => {
  const h = setup({ columns: 200, rows: 40, doc: { theme: 'plugin:acme/solarized', iconStyle: 'symbols' }, themes: pluginThemes() })
  await h.open()
  await key(h, '\x1b[B') // Appearance -> Display on the categories level
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Display')))
  await key(h, '\r') // L0 -> L1
  assert.match(h.rowsPlain()[0]!, /Settings · Display · Rows/)
  await key(h, '\r') // L1 -> L2 (detail)
  assert.match(h.rowsPlain()[0]!, /Settings · Display · Transcript display/)
  h.vt.resize(72, 24)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /Settings · Display · Transcript d/, 'the level, category and row survive the narrow resize')
  h.vt.resize(44, 24)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /Transcript d/, 'the selected row survives the resize')
  h.vt.resize(200, 40)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /Settings · Display · Transcript display/, 'the wide projection returns on the same detail context')
  assert.match(h.view(), /Transcript display/, 'the narrow detail level upgrades to the same row')
  assertRowWidths(h, 200)
  h.dispose()
})

// ── A-07: hostile external text ───────────────────────────────────────────

test('A-07 hostile OSC/CSI/CJK theme text is sanitized before paint, wrapped to the pane, and copied verbatim', async () => {
  const hostile = `evil\x1b[31mred\x07payload-${'汉'.repeat(60)}`
  const h = setup({ columns: 100, rows: 24, doc: { theme: hostile } })
  await h.open()
  await key(h, '\r') // L0 -> L1 exposes the real Details pane
  const plain = h.view()
  assert.ok(!plain.includes('\x1b'), 'no raw escape sequence may reach the terminal text')
  assert.ok(!plain.includes('[31m'), 'the CSI sequence must be stripped whole, never left as visible payload')
  assertRowWidths(h, 100)
  // RAW terminal-write safety: the terminal's own write sink is the witness (a
  // parsed viewport would already have interpreted the sequences). The whole
  // hostile value must never be emitted, nor its raw CSI/BEL/C1 bytes.
  const emitted = h.writes().join('')
  assert.ok(!emitted.includes(hostile), 'the raw hostile value must never reach the terminal')
  assert.ok(!emitted.includes('\x1b[31m'), 'the injected CSI must never reach the terminal')
  assert.ok(!emitted.includes('\x07payload'), 'the injected BEL must never reach the terminal')
  assert.ok(!emitted.includes('\u009b'), 'the injected C1 byte must never reach the terminal')
  const copyRow = rowOf(h, 'Copy value [C]')
  const copyCol = cellIndexOf(h, copyRow, 'Copy value [C]')
  press(h, copyRow, copyCol)
  release(h, copyRow, copyCol)
  await settle(h)
  assert.deepEqual(h.copied, [`file:${hostile}`], 'the copy payload is the EXACT normalized source value, byte for byte')
  h.dispose()
})

// ── A-08: read provenance and currentness ─────────────────────────────────

test('A-08 the ready snapshot distinguishes the raw theme identity, the runtime preset and its persisted last-read', async () => {
  const h = setup({
    columns: 200,
    rows: 40,
    doc: { theme: 'plugin:acme/solarized', displayPreset: 'compact' },
    displayPreset: 'full',
    themes: pluginThemes(),
  })
  await h.open()
  assert.match(h.view(), /plugin:acme\/solarized/, 'the raw source-qualified theme id is shown')
  assert.match(h.view(), /Solarized/, 'the friendly label is shown beside it')
  assert.match(h.view(), /TUI settings document/, 'the configured scope is stated')
  assert.match(h.view(), /Config Ready/, 'the metadata states the live readiness')
  // Display: the runtime value is the current one; the persisted preference is a
  // separate last-read fact and never overwrites it. Wide paints the Detail at
  // every level, but the walk still goes through the same Enter ladder.
  await key(h, '\x1b[B') // Appearance -> Display (its first row is Transcript display)
  await key(h, '\r') // L0 -> L1
  await key(h, '\r') // L1 -> inline choice
  assert.match(h.view(), /Persisted\s+compact/, 'the persisted fact is separately named')
  assert.match(h.view(), /Client runtime · optional TUI preference persistence/, 'the scope fact remains distinct from the runtime value')
  h.dispose()
})

test('A-08b stale and unavailable backends keep the last-known document but never claim it current', async () => {
  for (const readiness of ['stale', 'unavailable'] as const) {
    const h = setup({ columns: 100, rows: 40, doc: { theme: 'dark' }, readiness })
    await h.open()
    assert.match(h.view(), new RegExp(`Config ${readiness === 'stale' ? 'Stale' : 'Unavailable'}`), 'the metadata names the readiness')
    await key(h, '\r') // L0 -> L1: the Detail of the selected row becomes visible
    assert.match(h.view(), /Last-known value/)
    assert.ok(!h.view().includes('Ready · on-open snapshot'), 'a stale doc is never presented as ready')
    h.dispose()
  }
})

test('A-08c a missing document and a throwing read are distinct explicit states, never fabricated defaults', async () => {
  const missing = setup({ columns: 100, rows: 40, settingsService: false })
  await missing.open()
  assert.match(missing.view(), /Unavailable — no authoritative config document/)
  assert.ok(!/Value\s+auto/.test(missing.view()), 'the built-in fallback must never appear as the current value')
  missing.dispose()

  const throwing = setup({ columns: 100, rows: 40, throwOnGet: true })
  await throwing.open()
  assert.match(throwing.view(), /Config Ready/, 'the backend itself is reachable')
  await key(throwing, '\r') // L0 -> L1: the selected row's Detail carries the read error
  assert.match(throwing.view(), /Read error/, 'the throwing read is surfaced as a read error')
  assert.match(throwing.view(), /settings read exploded/, 'the real error text is reachable in the detail')
  throwing.dispose()
})

// ── A-09: the painted mouse identity ──────────────────────────────────────

test('A-09 SGR press/release hits the same painted row; a repaint between press and release is refused', async () => {
  const h = setup({ columns: 100, rows: 40, doc: { iconStyle: 'minimal' } })
  await h.open()
  const iconRow = rowOf(h, 'Icon style')
  assert.ok(!h.view().includes('> Icon style'), 'Icon style starts unselected')
  const col = cellIndexOf(h, iconRow, 'Icon style')
  press(h, iconRow, col)
  release(h, iconRow, col)
  await h.vt.waitForRender()
  // The click selects the clicked item and takes the rows level; only a
  // keyboard advance (Right/Enter) or Detail-pane action enters L2.
  assert.ok(h.rowsPlain()[iconRow]!.startsWith('> Icon style'), 'the same-cell click selects the painted row')
  assert.match(h.view(), /minimal/, 'the detail follows the newly selected row')
  assert.ok(!h.view().includes('Settings · Appearance · Icon style'), 'the click did not enter the Detail level')

  // Press on Configured theme, repaint (resize), then release on the old cell:
  // the target identity no longer matches, so the click must be refused.
  const themeRow = rowOf(h, 'Configured theme')
  const themeCol = cellIndexOf(h, themeRow, 'Configured theme')
  press(h, themeRow, themeCol)
  h.vt.resize(72, 24)
  await h.vt.waitForRender()
  release(h, themeRow, themeCol)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /· Rows/, 'the narrow projection replaced the medium row list')
  assert.ok(h.rowsPlain()[rowOf(h, 'Icon style')]!.startsWith('>'), 'the stale release activated nothing')
  assert.match(h.rowsPlain()[rowOf(h, 'Configured theme')]!, /^\s+Configured theme/, 'the stale release did not re-select the pressed row')
  h.dispose()
})

test('A-09b the wheel scrolls only the visible pane under the pointer, and blank chrome is inert', async () => {
  const h = setup({ columns: 100, rows: 10, doc: { theme: 'dark' } })
  await h.open()
  const l0 = h.view()
  // At L0 the Detail is NOT painted, so a wheel in its would-be columns only
  // reaches the rows pane and cannot move a hidden viewport.
  const themeRow = rowOf(h, 'Configured theme')
  wheel(h, themeRow, 96, true)
  await h.vt.waitForRender()
  assert.equal(h.view(), l0, 'L0 has no Detail pane to scroll')
  await key(h, '\r') // L0 -> L1: rows + detail
  const before = h.view()
  // Wheel over the row pane must not scroll the detail pane.
  wheel(h, themeRow, cellIndexOf(h, themeRow, 'Configured theme'), false)
  await h.vt.waitForRender()
  assert.equal(h.view(), before, 'a row-pane wheel leaves the detail viewport untouched')
  // Wheel over the detail pane scrolls it.
  wheel(h, themeRow, 96, true)
  await h.vt.waitForRender()
  assert.notEqual(h.view(), before, 'a detail-pane wheel moves the detail viewport')
  // A blank rule row is inert.
  const ruleRow = h.rowsPlain().findIndex((line, index) => index > 0 && /^─+$/.test(line))
  const stable = h.view()
  press(h, ruleRow, 4)
  release(h, ruleRow, 4)
  await h.vt.waitForRender()
  assert.equal(h.view(), stable, 'a click on non-interactive chrome changes nothing')
  h.dispose()
})

// ── A-10: exact copy and scoped feedback ──────────────────────────────────

test('A-10 Copy sends the exact source value and its settlement is visible inside the workspace', async () => {
  const h = setup({ columns: 100, rows: 24, doc: { theme: 'plugin:acme/solarized' }, themes: pluginThemes() })
  await h.open()
  await key(h, '\r') // L0 -> L1; the Details copy button is visible in medium
  const row = rowOf(h, 'Copy value [C]')
  const col = cellIndexOf(h, row, 'Copy value [C]')
  press(h, row, col)
  release(h, row, col)
  await settle(h)
  assert.deepEqual(h.copied, ['plugin:acme/solarized'], 'the copy payload is the raw identity, never the friendly label')
  assert.ok(h.rowsPlain().some(line => line.includes('Copy sent')), `the notice is painted inside the workspace:\n${h.view()}`)
  h.dispose()
})

test('A-10d the narrow inline choice advertises and runs exact keyboard Copy', async () => {
  for (const [columns, rows, copyKey, copyVisible] of [[72, 24, 'c', true], [44, 20, 'C', true], [30, 24, 'c', false]] as const) {
    const h = setup({ columns, rows, doc: { theme: 'plugin:acme/solarized' }, themes: pluginThemes() })
    await h.open()
    await key(h, '\x1b[C') // Categories -> Rows
    await key(h, '\x1b[C') // Rows -> inline choice
    assert.ok(h.view().includes('Choose value'), `the keyboard path reaches choosing at ${columns}x${rows}:\n${h.view()}`)
    const copyHintVisible = h.rowsPlain().at(-1)!.includes('c copy')
    assert.equal(copyHintVisible, copyVisible, `Copy hint visibility follows Action Bar width at ${columns}x${rows}:\n${h.view()}`)
    await key(h, copyKey)
    await settle(h)
    assert.deepEqual(h.copied, copyVisible ? ['plugin:acme/solarized'] : [], `Copy follows the visible hint at ${columns}x${rows}`)
    if (copyVisible) assert.ok(h.view().includes('Choose value'), `Copy leaves the candidate choice open at ${columns}x${rows}`)
    assert.equal(h.replacements(), 0, 'Copy never commits a candidate')
    h.dispose()
  }
})

test('A-10e inline Copy accepts Kitty and modifyOtherKeys printable events', async () => {
  const encodedCopyKeys = ['\x1b[99u', '\x1b[99:67:99;2u', '\x1b[27;2;67~'] as const
  for (const encodedKey of encodedCopyKeys) {
    const h = setup({ columns: 72, rows: 24, doc: { theme: 'dark' } })
    await h.open()
    await key(h, '\x1b[C') // Categories -> Rows
    await key(h, '\x1b[C') // Rows -> inline choice
    assert.ok(h.view().includes('Choose value'), `the inline choice is open:\n${h.view()}`)
    assert.ok(h.view().includes('c copy'), `inline Copy remains advertised:\n${h.view()}`)
    await key(h, encodedKey)
    await settle(h)
    assert.deepEqual(h.copied, ['dark'], 'inline semantic Copy copies the original configured identity')
    assert.match(h.view(), /dark\s+\[current\]/, 'inline Copy leaves the candidate selection open')
    assert.equal(h.replacements(), 0, 'inline Copy never commits a candidate')
    h.dispose()
  }
})

test('A-10f settled Detail Copy accepts Kitty and modifyOtherKeys printable events', async () => {
  const encodedCopyKeys = ['\x1b[99u', '\x1b[99:67:99;2u', '\x1b[27;2;67~'] as const
  for (const encodedKey of encodedCopyKeys) {
    const h = setup({ columns: 72, rows: 24, doc: { theme: 'dark' } })
    await openSelectedRow(h, 'theme')
    await key(h, '\r') // Rows -> inline choice
    await key(h, '\x1b[B') // dark -> light
    await key(h, '\r') // Confirm into settled Detail
    await settle(h)
    assert.equal(h.replacements(), 1, 'the source fixture reaches settled Detail')
    assert.equal(h.doc.theme, 'light')
    assert.ok(h.view().includes('c copy value'), `ordinary Detail Copy remains advertised:\n${h.view()}`)
    await key(h, encodedKey)
    await settle(h)
    assert.deepEqual(h.copied, ['light'], 'semantic Detail Copy copies the raw configured identity')
    assert.equal(h.replacements(), 1, 'Detail Copy never adds a settings write')
    h.dispose()
  }
})

test('B-15e mouse Confirm requires the painted Enter hint at the minimum Action Bar width', async () => {
  for (const [columns, canConfirm] of [[18, false], [19, true], [23, true]] as const) {
    const h = setup({ columns, rows: 24, doc: { theme: 'dark' }, themes: pluginThemes() })
    await openSelectedRow(h, 'theme')
    await key(h, '\r') // Detail -> choosing
    const actionBar = h.rowsPlain().at(-1) ?? ''
    if (!actionBar.includes('Up/Down')) {
      const beforeHiddenDown = h.view()
      await key(h, '\x1b[B')
      assert.equal(h.view(), beforeHiddenDown, `Down is inert without a painted navigation hint at ${columns} columns`)
    }
    const lightRow = rowOf(h, 'light')
    const lightColumn = cellIndexOf(h, lightRow, 'light')
    press(h, lightRow, lightColumn)
    release(h, lightRow, lightColumn)
    await settle(h)
    assert.ok(h.view().includes('> light'), `the visible candidate click selects Light at ${columns} columns:\n${h.view()}`)
    assert.equal(h.replacements(), 0, 'clicking the candidate remains a preview')
    assert.equal(h.view().includes('Enter confirm'), canConfirm, `Enter hint follows the whole-segment width at ${columns} columns:\n${h.view()}`)
    assert.equal(h.view().includes('Confirm'), canConfirm, `Confirm is painted only while its required hint fits at ${columns} columns:\n${h.view()}`)
    const buttonRow = rowOf(h, 'Cancel')
    const buttonColumn = canConfirm ? cellIndexOf(h, buttonRow, 'Confirm') : 0
    press(h, buttonRow, buttonColumn)
    release(h, buttonRow, buttonColumn)
    await settle(h)
    assert.equal(h.replacements(), canConfirm ? 1 : 0, `mouse confirmation obeys the painted Enter hint at ${columns} columns`)
    assert.equal(h.doc.theme, canConfirm ? 'light' : 'dark', `the setting commits only when the Enter hint is painted at ${columns} columns`)
    h.dispose()
  }
})

test('A-10b a copy settled after the workspace closed never notifies the restored surface', async () => {
  let settleCopy: ((ok: boolean) => void) | undefined
  const h = setup({
    columns: 100,
    rows: 24,
    doc: { theme: 'dark' },
    copySelection: async (text: string) => {
      h.copied.push(text)
      return new Promise<boolean>(resolve => { settleCopy = resolve })
    },
  })
  await h.open()
  await key(h, '\r') // L0 -> L1
  const copyRow = rowOf(h, 'Copy value [C]')
  const copyCol = cellIndexOf(h, copyRow, 'Copy value [C]')
  press(h, copyRow, copyCol)
  release(h, copyRow, copyCol)
  await settle(h)
  await key(h, '\x1b') // Detail -> rows after the painted copy takes column focus
  await key(h, '\x1b') // rows -> categories
  await key(h, '\x1b') // close the workspace before the clipboard settles
  assert.ok(h.view().includes('❯'), 'the editor is restored')
  settleCopy?.(true)
  await settle(h)
  assert.equal(h.app.notifyTextForTest(), '', 'a stale copy must not notify the new surface')
  h.dispose()
})

// ── A-11: the legacy compatibility bridge ─────────────────────────────────

test('A-11 Other settings opens the existing complete editor after retiring the workspace, and Esc returns', async () => {
  const h = setup({ columns: 100, rows: 40, doc: { theme: 'dark' } })
  await h.open()
  await key(h, '\x1b[B') // Appearance -> Display
  await key(h, '\x1b[B') // Display -> Tools
  await key(h, '\x1b[B') // Tools -> Plugins
  await key(h, '\x1b[B') // Plugins -> Other settings
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Other settings')), `the other category is selected:\n${h.view()}`)
  await key(h, '\r') // L0 -> L1 (the Other settings rows level)
  assert.match(h.rowsPlain()[0]!, /Settings · Other settings · Rows/)
  await key(h, '\r') // Enter on the explicit open-legacy row hands off
  const legacy = h.view()
  assert.match(legacy, /Type to search/, `the legacy SettingsList is the physical owner:\n${legacy}`)
  assert.ok(!legacy.includes('Settings ·'), 'the workspace is gone, not stacked underneath')
  await key(h, '\x1b')
  assert.ok(h.view().includes('❯'), 'closing the legacy editor returns to the conversation')
  h.dispose()
})

// ── A-12: the return surface ──────────────────────────────────────────────

test('A-12 Esc restores the SAME return surface: the editor draft, the regular footer and the fullscreen mode', async () => {
  const h = setup({ columns: 100, rows: 40 })
  await h.vt.waitForRender()
  for (const ch of 'draft text') await key(h, ch)
  assert.ok(h.view().includes('draft text'), 'the draft is in the editor before opening')
  await h.open()
  assert.ok(!h.view().includes('draft text'), 'the workspace hides the editor')
  await key(h, '\x1b')
  assert.ok(h.view().includes('draft text'), 'the same editor draft survives the round trip')

  // Fullscreen round trip: the user's display mode is never touched.
  h.app.setFullscreen(true)
  await h.vt.waitForRender()
  assert.notEqual(h.app.fullscreenScrollForTest(), undefined, 'the transcript alt screen is the owner')
  await h.open()
  await key(h, '\x1b')
  assert.notEqual(h.app.fullscreenScrollForTest(), undefined, 'the fullscreen preference is untouched')
  assert.ok(h.view().includes('draft text'), 'the fullscreen transcript returns with its draft')
  h.dispose()
})

// ── A-15: live theme tokens ───────────────────────────────────────────────

test('A-15 the workspace chrome paints the live palette tokens (dark → light)', async () => {
  const h = setup({ columns: 100, rows: 40 })
  await h.open()
  const darkWordmark = h.vt.getCellFgRgb(0, 0)
  assert.equal(darkWordmark, hexToRgb(currentPalette.textStrong), 'the Settings wordmark uses the live textStrong token')
  const ruleRow = h.rowsPlain().findIndex(line => /^─+$/.test(line))
  assert.equal(h.vt.getCellFgRgb(ruleRow, 2), hexToRgb(currentPalette.border), 'the visual rule uses the border token')
  // The active device and the cursor share `primary`; the identity word above
  // does NOT (it is weight-only). This is the exact split the vocabulary fixes:
  // ordinary focus is never the amber `borderFocus` (which equals `warning`).
  const paneHeadRow = rowOf(h, '[Categories (8)]')
  const paneHeadCol = cellIndexOf(h, paneHeadRow, '[Categories (8)]')
  assert.equal(h.vt.getCellFgRgb(paneHeadRow, paneHeadCol), hexToRgb(currentPalette.primary),
    'the focused pane label wears the bracketed bold primary active device')
  const cursorRow = rowOf(h, '> Appearance')
  assert.equal(h.vt.getCellFgRgb(cursorRow, 0), hexToRgb(currentPalette.primary),
    'the cursor glyph carries primary while the row text carries the row emphasis')
  const summaryRow = rowOf(h, 'symbols')
  assert.equal(h.vt.getCellFgRgb(summaryRow, cellIndexOf(h, summaryRow, 'symbols')), hexToRgb(currentPalette.textDim),
    'an UNSELECTED row summary column is textDim, one step below the row label')
  const selectedSummaryRow = rowOf(h, 'auto')
  assert.equal(h.vt.getCellFgRgb(selectedSummaryRow, cellIndexOf(h, selectedSummaryRow, 'auto')), hexToRgb(currentPalette.textStrong),
    'the SELECTED row paints its summary as part of the one emphasised run')
  setTheme('light')
  h.app.requestRender(true)
  await h.vt.waitForRender()
  assert.equal(h.vt.getCellFgRgb(0, 0), hexToRgb(currentPalette.textStrong), 'the wordmark follows the light palette')
  assert.notEqual(hexToRgb(currentPalette.textStrong), darkWordmark, 'the two palettes really differ')
  h.dispose()
})

// ── F1: the painted mouse path really navigates and copies ────────────────

test('narrow item clicks select and focus, never drill past the level', async () => {
  const h = setup({ columns: 72, rows: 24, doc: { theme: 'plugin:acme/solarized' }, themes: pluginThemes() })
  await h.open()
  assert.match(h.rowsPlain()[0]!, /Settings · Categories/)
  const displayRow = rowOf(h, 'Display')
  const displayCol = cellIndexOf(h, displayRow, 'Display')
  press(h, displayRow, displayCol)
  release(h, displayRow, displayCol)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /Settings · Categories/, 'a category click stays on the categories level')
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Display')), 'the clicked category is selected')
  assert.ok(!h.view().includes('· Rows'), 'the click never drilled into the rows level')
  // Enter/Right is the only keyboard level advance; a row click stays at L1.
  await key(h, '\r')
  assert.match(h.rowsPlain()[0]!, /Settings · Display · Rows/)
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Transcript display')))
  const rowIndex = rowOf(h, 'Transcript display')
  const rowCol = cellIndexOf(h, rowIndex, 'Transcript display')
  press(h, rowIndex, rowCol)
  release(h, rowIndex, rowCol)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /Settings · Display · Rows/, 'a row click stays on the rows level')
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Transcript display')))
  await key(h, '\r')
  assert.match(h.rowsPlain()[0]!, /Settings · Display · Transcript display/, 'Enter enters the detail')
  h.dispose()
})

test('the painted Copy button copies while the row list owns the keyboard focus', async () => {
  const h = setup({ columns: 100, rows: 40, doc: { theme: 'plugin:acme/solarized' }, themes: pluginThemes() })
  await h.open()
  assert.ok(!/c copy value/.test(h.rowsPlain().at(-1) ?? ''), 'c is never advertised outside the Detail level')
  await key(h, '\r') // L0 -> L1: the rows keep the keyboard while the Detail is visible
  assert.match(h.rowsPlain()[rowOf(h, 'Rows (2)')]!, /\[Rows \(2\)\]/, 'the rows level owns the keyboard')
  const buttonRow = rowOf(h, 'Copy value [C]')
  const buttonCol = cellIndexOf(h, buttonRow, 'Copy value [C]')
  press(h, buttonRow, buttonCol)
  release(h, buttonRow, buttonCol)
  await settle(h)
  assert.deepEqual(h.copied, ['plugin:acme/solarized'], 'the painted mouse button copies without the Detail focus owner')
  assert.match(h.rowsPlain()[rowOf(h, 'Details')]!, /\[Details\]/, 'the clicked column becomes the keyboard owner')
  h.dispose()
})

test('a click anywhere in a visible column takes that column focus', async () => {
  const h = setup({ columns: 100, rows: 40, doc: { theme: 'dark' } })
  await h.open()
  assert.match(h.rowsPlain()[rowOf(h, 'Categories (8)')]!, /\[Categories \(8\)\]/, 'the categories level owns focus at open')
  // Clicking a row selects it and takes the rows level's focus (and therefore
  // the rows + detail composition).
  const iconRow = rowOf(h, 'Icon style')
  const iconCol = cellIndexOf(h, iconRow, 'Icon style')
  press(h, iconRow, iconCol)
  release(h, iconRow, iconCol)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[rowOf(h, 'Rows (2)')]!, /\[Rows \(2\)\]/, 'a row click takes the rows level focus')
  const detailRow = rowOf(h, 'Value')
  press(h, detailRow, 96) // inside the Detail pane, away from the Copy button
  release(h, detailRow, 96)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[rowOf(h, 'Details')]!, /\[Details\]/, 'clicking the Detail column focuses it')
  h.dispose()
})

// ── F2: the row grant and the actual paint/admission agree ────────────────

test('100x3 paints real content in its only body row, not pane headers', async () => {
  const h = setup({ columns: 100, rows: 3, doc: { theme: 'dark' } })
  await h.open()
  const painted = h.rowsPlain()
  assert.equal(painted.length, 3)
  assert.ok(painted.some(line => line.includes('Configured theme')), `the only body row is real content:\n${h.view()}`)
  assert.ok(!painted.some(line => line.includes('Categories (8)')), 'the pane header yields to the content row')
  h.dispose()
})

test('below the body floor Enter/Tab/arrows/C/R are inert; only Esc escapes', async () => {
  const h = setup({ columns: 72, rows: 2, doc: { theme: 'dark' } })
  await h.open()
  const before = h.view()
  const readsBefore = h.reads()
  for (const data of ['\r', '\t', '\x1b[B', '\x1b[C', 'c', 'r']) await key(h, data)
  assert.equal(h.view(), before, 'no hidden action may change the frame below the body floor')
  assert.deepEqual(h.copied, [], 'C never copies below the body floor')
  assert.equal(h.reads(), readsBefore, 'R never re-reads below the body floor')
  await key(h, '\x1b')
  assert.ok(!h.view().includes('Settings'), 'Esc still escapes at two rows')
  h.dispose()
})

test('72x3 paints no hidden Copy or Confirm action', async () => {
  const h = setup({ columns: 72, rows: 3, doc: { theme: 'dark' } })
  await h.open()
  await key(h, '\r') // categories -> rows
  await key(h, '\r') // L1 -> inline choice
  assert.ok(!h.view().includes('Copy value [C]'), `the hidden Copy action is not painted at 72x3:\n${h.view()}`)
  assert.ok(!h.view().includes('Confirm'), `the Confirm button is not granted below a two-row detail body:\n${h.view()}`)
  await key(h, 'c')
  assert.deepEqual(h.copied, [], 'a hidden copy action cannot execute')
  await key(h, '\r')
  assert.equal(h.replacements(), 0, 'a one-row choice has no hidden commit affordance')
  h.dispose()
})

// ── F3: a gesture spanning a data change is refused ───────────────────────

test('a release after Refresh is refused instead of copying the newer value', async () => {
  const h = setup({ columns: 72, rows: 24, doc: { iconStyle: 'minimal' } })
  await h.open()
  await key(h, '\r') // L0 -> L1
  await key(h, '\x1b[B') // Configured theme -> read-only Icon style
  await key(h, '\r') // read-only detail
  const buttonRow = rowOf(h, 'Copy value [C]')
  const buttonCol = cellIndexOf(h, buttonRow, 'Copy value [C]')
  press(h, buttonRow, buttonCol)
  h.doc.iconStyle = 'symbols'
  await key(h, 'r') // refresh: the row value changes and the state version bumps
  assert.match(h.view(), /symbols/, 'R really re-read the new value')
  release(h, buttonRow, buttonCol)
  await settle(h)
  assert.deepEqual(h.copied, [], 'the stale press must not copy the refreshed value')
  // Positive control: the same gesture without an intervening change copies.
  // A DIFFERENT cell inside the same painted button keeps it a single click.
  const settledRow = rowOf(h, 'Copy value [C]')
  const settledCol = cellIndexOf(h, settledRow, 'Copy value [C]') + 5
  press(h, settledRow, settledCol)
  release(h, settledRow, settledCol)
  await settle(h)
  assert.deepEqual(h.copied, ['symbols'], 'an unchanged gesture still copies')
  h.dispose()
})

// ── F4: the wheel owns its own viewport ───────────────────────────────────

test('the wheel scrolls the pane under the pointer without pulling the selection back', async () => {
  const h = setup({ columns: 72, rows: 4, doc: { theme: 'dark' } })
  await h.open()
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Appearance')))
  assert.ok(!h.view().includes('Other settings'), 'the third category starts out of view')
  wheel(h, rowOf(h, 'Appearance'), 4, true)
  wheel(h, rowOf(h, 'Appearance'), 4, true)
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('> Appearance'), 'the selection left the viewport instead of forcing a rebase')
  assert.ok(h.view().includes('Plugins') || h.view().includes('Display') || h.view().includes('Other settings'), `the wheel scrolled the list:\n${h.view()}`)
  await key(h, '\x1b[B')
  await key(h, '\x1b[B')
  await key(h, '\x1b[B')
  await key(h, '\x1b[B')
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Other settings')), 'a selection change still rebases to the selected row')
  h.dispose()
})

// ── F5: unknown persistence is never presented as "not set" ───────────────

test('an unreadable document never fabricates a "not set" persisted preference', async () => {
  const missing = setup({ columns: 100, rows: 40, settingsService: false })
  await missing.open()
  await key(missing, '\x1b[B') // Appearance -> Display
  await key(missing, '\r') // L0 -> L1
  await key(missing, '\r') // L1 -> L2 (the Transcript display row's detail)
  const missingView = missing.view().replace(/\s+/g, ' ')
  assert.match(missingView, /Persisted\s+unknown/, 'absence is an unknown persistence state')
  assert.ok(!missingView.includes('Persisted preference: not set'), 'absence is never "read and not configured"')
  missing.dispose()

  const throwing = setup({ columns: 100, rows: 40, throwOnGet: true })
  await throwing.open()
  await key(throwing, '\x1b[B')
  await key(throwing, '\r')
  await key(throwing, '\r')
  const throwingView = throwing.view().replace(/\s+/g, ' ')
  assert.match(throwingView, /Persisted\s+unknown/, 'a failed read remains explicitly unknown')
  for (let page = 0; page < 3; page += 1) await key(throwing, '\x1b[6~')
  assert.match(throwing.view().replace(/\s+/g, ' '), /settings read exploded/, 'PgDn reaches the complete read error fact')
  throwing.dispose()
})

// ── F6: raw values are escaped, never silently folded ─────────────────────

test('a raw source value with a line break renders a visible escape distinct from a space', async () => {
  const h = setup({ columns: 72, rows: 24, doc: { theme: 'file:a\nb' } })
  await h.open()
  await key(h, '\r')
  await key(h, '\r')
  assert.ok(h.view().includes('file:a\\nb'), `the newline renders as a visible escape:\n${h.view()}`)
  assert.ok(!h.view().includes('file:a b'), 'it must not be indistinguishable from an ordinary space')
  h.dispose()
})

// ── F9 extras: the remaining matrix controls ──────────────────────────────

test('A-02b the wide geometry is exact and a 300-char value never squeezes the Action Bar', async () => {
  const long = `file:${'x'.repeat(300)}`
  const h = setup({ columns: 200, rows: 60, doc: { theme: long } })
  await h.open()
  const paneRow = rowOf(h, 'Categories (8)')
  assert.equal(cellIndexOf(h, paneRow, '[Categories (8)]'), 0, 'the categories level starts at cell 0 and owns focus at L0')
  assert.equal(cellIndexOf(h, paneRow, 'Rows (2)'), 22 + 2, 'the row column starts after the 22-cell column and a 2-cell gap')
  assert.equal(cellIndexOf(h, paneRow, 'Details'), 22 + 2 + 42 + 2, 'the detail column starts after the 42-cell row column and a 2-cell gap')
  for (const [index, line] of h.vt.getViewport().entries()) {
    assert.ok(visibleWidth(line) <= 200, `row ${index} must fit the terminal`)
  }
  assert.match(h.rowsPlain().at(-1) ?? '', /Right open · Enter open · Tab panes · Esc close/, 'the Action Bar stays the last physical row')
  await key(h, '\r') // L0 -> L1 (the row list owns the keyboard)
  await key(h, '\r') // L1 -> inline choice
  assert.ok(h.view().includes('Full value'), 'the complete long value starts in the facts region')
  await key(h, '\x1b[6~') // PageDown scrolls the facts, not the candidate
  assert.match(h.view().replace(/\s+/g, ''), /x{100}/, 'the long value remains readable while the facts scroll')
  h.dispose()
})

test('A-10c the copy failure paths report inside the workspace instead of a false success', async () => {
  for (const failing of [async () => false, async () => { throw new Error('clipboard refused') }]) {
    const h = setup({ columns: 140, rows: 24, doc: { theme: 'dark' }, copySelection: failing })
    await h.open()
    await key(h, '\r') // L0 -> L1 exposes the Details copy action
    const row = rowOf(h, 'Copy value [C]')
    const col = cellIndexOf(h, row, 'Copy value [C]')
    press(h, row, col)
    release(h, row, col)
    await settle(h)
    assert.ok(h.rowsPlain().some(line => line.includes('Copy failed')), `the failure notice is visible:\n${h.view()}`)
    assert.ok(!h.view().includes('Copy sent'), 'a failure is never reported as success')
    h.dispose()
  }
})

test('A-15b a custom palette repaints the workspace tokens', async () => {
  const h = setup({ columns: 100, rows: 40 })
  await h.open()
  const dark = h.vt.getCellFgRgb(0, 0)
  setTheme('custom', { ...currentPalette, textStrong: '#010203' })
  h.app.requestRender(true)
  await h.vt.waitForRender()
  assert.equal(h.vt.getCellFgRgb(0, 0), 0x010203, 'the wordmark follows the custom palette')
  assert.notEqual(h.vt.getCellFgRgb(0, 0), dark)
  h.dispose()
})

test('A-06b a non-first row and its REAL detail scroll survive a resize', async () => {
  // A long RAW icon-style value makes the SELECTED row's Detail overflow the
  // short viewport, so the scroll below is observable and meaningful.
  const h = setup({ columns: 100, rows: 10, doc: { iconStyle: `symbols-${'z'.repeat(240)}` } })
  await h.open()
  await key(h, '\r') // L0 -> L1 (rows own the keyboard)
  await key(h, '\x1b[B') // Configured theme -> Icon style (non-first)
  await key(h, '\r') // L1 -> L2 (detail)
  const beforeScroll = h.view()
  await key(h, '\x1b[B')
  await key(h, '\x1b[B')
  const afterScroll = h.view()
  assert.notEqual(afterScroll, beforeScroll, 'the Detail really scrolled on the selected row')
  h.vt.resize(200, 40)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /Settings · Appearance · Icon style/, 'the category and row survive')
  assert.ok(h.view().includes('> Icon style'), 'the non-first row id survives the resize')
  assert.ok(h.view().includes('Icon style'), 'the detail context survives')
  h.dispose()
})

test('A-15c an unhandled printable key is inert inside the workspace', async () => {
  const h = setup({ columns: 100, rows: 40, doc: { theme: 'dark' } })
  await h.open()
  const before = h.view()
  for (const data of ['q', 'x', 'z']) await key(h, data)
  assert.equal(h.view(), before, 'a printable key never changes the workspace or leaks to a hidden editor')
  h.dispose()
})

// ── F1 residual: a real item click takes its column focus ─────────────────

test('a real category/row item click takes that level and selects the item', async () => {
  const wide = setup({ columns: 200, rows: 24, doc: { theme: 'dark' } })
  await wide.open()
  assert.match(wide.rowsPlain()[rowOf(wide, 'Categories (8)')]!, /\[Categories \(8\)\]/, 'the categories level owns focus at open')
  const displayRow = rowOf(wide, 'Display')
  press(wide, displayRow, 2)
  release(wide, displayRow, 2)
  await wide.vt.waitForRender()
  assert.match(wide.rowsPlain()[rowOf(wide, 'Categories (8)')]!, /\[Categories \(8\)\]/, 'the clicked category keeps the categories level')
  assert.ok(wide.rowsPlain().some(line => line.startsWith('> Display')), 'and selects the clicked category')
  await key(wide, '\x1b[B')
  assert.ok(wide.rowsPlain().some(line => line.startsWith('> Tools')), 'Down now moves the CATEGORY, not the row')
  wide.dispose()

  const medium = setup({ columns: 100, rows: 24, doc: { theme: 'dark' } })
  await medium.open()
  const iconRow = rowOf(medium, 'Icon style')
  const iconCol = cellIndexOf(medium, iconRow, 'Icon style')
  press(medium, iconRow, iconCol)
  release(medium, iconRow, iconCol)
  await medium.vt.waitForRender()
  assert.match(medium.rowsPlain()[rowOf(medium, 'Rows (2)')]!, /\[Rows \(2\)\]/, 'a row click takes the rows level')
  assert.ok(medium.view().includes('> Icon style'), 'and selects that row')
  medium.dispose()
})

// ── F2 residual: the bar never advertises a floor-disabled key ────────────

test('below the body floor the Action Bar advertises only the Esc semantics', async () => {
  for (const [columns, rows] of [[72, 2], [44, 2], [100, 2]] as const) {
    const h = setup({ columns, rows })
    // Two rows grant no body, so the rail is not painted at all; the workspace's
    // home entry is the only reachable first frame.
    await h.openHome()
    const bar = h.rowsPlain().at(-1)!
    // The bar is the ONLY thing on the last row: it states the Esc semantics
    // alone and starts at X=0 in every projection. A narrow terminal opens on
    // the About CONTENT (Esc back to the rail); 76+ opens on the rail (Esc
    // close).
    const back = columns < 76 ? 'Esc back' : 'Esc close'
    assert.ok(bar.includes(back), `the bar keeps its ${back} semantics at ${columns}x${rows}: ${bar}`)
    for (const forbidden of ['Up/Down', 'Left', 'Right', 'Enter', 'Tab', 'r refresh', 'c copy', 'PgDn', 'PgUp']) {
      assert.ok(!bar.includes(forbidden), `${columns}x${rows} must not advertise the inert ${forbidden}: ${bar}`)
    }
    h.dispose()
  }
})

// ── F3 residual: a resize boundary refuses even an unchanged target ───────

test('a resize that keeps the target geometry still refuses the straddling press', async () => {
  const h = setup({ columns: 100, rows: 24, doc: { theme: 'dark' } })
  await h.open()
  // Positive control first: an unchanged gesture selects the pressed row.
  const iconRow = rowOf(h, 'Icon style')
  const iconCol = cellIndexOf(h, iconRow, 'Icon style')
  press(h, iconRow, iconCol)
  release(h, iconRow, iconCol)
  await h.vt.waitForRender()
  assert.ok(h.view().includes('> Icon style'), 'the row gesture works before the resize')
  // Press another row, resize without moving it, release on the same cell.
  const themeRow = rowOf(h, 'Configured theme')
  const themeCol = cellIndexOf(h, themeRow, 'Configured theme')
  press(h, themeRow, themeCol)
  h.vt.resize(104, 24)
  await h.vt.waitForRender()
  assert.equal(cellIndexOf(h, themeRow, 'Configured theme'), themeCol, 'the target cell really did not move')
  release(h, themeRow, themeCol)
  await h.vt.waitForRender()
  assert.ok(h.view().includes('> Icon style'), 'a resize between press and release refuses the stale gesture')
  assert.ok(!h.view().includes('> Configured theme'), 'the stale release did not re-select the pressed row')
  h.dispose()
})

// ── F6 residual: the visual escape is unambiguous ─────────────────────────

test('a real newline and a literal backslash-n render differently', async () => {
  const valueLine = (h: Harness): string => h.rowsPlain().find(line => line.includes('Source')) ?? ''
  const h = setup({ columns: 72, rows: 24, doc: { theme: 'file:a\nb' } })
  await h.open()
  await key(h, '\r')
  await key(h, '\r')
  const realValue = valueLine(h)
  assert.ok(realValue.includes('file:a\\nb'), `a real newline renders as backslash-n: ${JSON.stringify(realValue)}`)
  // The SAME app re-reads a literal backslash-n: the projection must keep the
  // two raw identities distinguishable.
  h.doc.theme = 'file:a\\nb'
  await key(h, '\x1b') // cancel the open choice back to L1
  await key(h, 'r')
  await key(h, '\r') // re-read and re-enter the inline choice
  const literalValue = valueLine(h)
  assert.ok(literalValue.includes('file:a\\\\nb'), `a literal backslash renders doubled: ${JSON.stringify(literalValue)}`)
  assert.notEqual(literalValue, realValue, 'the two raw identities render differently')
  h.dispose()
})

// ── F10: a shrinking viewport reveals the selection ───────────────────────

test('a viewport shrink reveals the selected row instead of hiding it', async () => {
  const medium = setup({ columns: 100, rows: 24, doc: { theme: 'dark' } })
  await medium.open()
  await key(medium, '\r') // L0 -> L1
  await key(medium, '\x1b[B') // theme -> icon-style
  assert.ok(medium.view().includes('> Icon style'))
  medium.vt.resize(100, 3)
  await medium.vt.waitForRender()
  assert.ok(medium.view().includes('> Icon style'), `the selected row is revealed after the shrink:\n${medium.view()}`)
  medium.dispose()

  const narrow = setup({ columns: 72, rows: 24, doc: { theme: 'dark' } })
  await narrow.open()
  await key(narrow, '\r') // categories -> rows
  await key(narrow, '\x1b[B') // theme -> icon-style
  narrow.vt.resize(72, 3)
  await narrow.vt.waitForRender()
  assert.ok(narrow.view().includes('> Icon style'), `the narrow rows page reveals the selected row:\n${narrow.view()}`)
  narrow.dispose()
})

// ── F1 sibling: the retired Tab cycle and header arrows ───────────────────

test('Left/Right select levels while Tab/Shift+Tab only re-focus the panes', async () => {
  for (const columns of [200, 100, 72] as const) {
    const h = setup({ columns, rows: 24, doc: { theme: 'dark' } })
    await h.open()
    assert.match(h.rowsPlain()[0]!, /Settings · Categories/, `the category level opens at ${columns}`)
    assert.ok(!h.view().includes('←'), 'the header paints no category arrows')
    if (columns < 76) {
      const l0 = h.view()
      for (const data of ['\t', '\x1b[Z']) await key(h, data)
      assert.equal(h.view(), l0, 'Tab/Shift+Tab are inert on the narrow L0')
    } else {
      // Forward Tab focuses Rows; Shift+Tab from the rail wraps to the Detail
      // pane. Neither jump opens the writable choice.
      await key(h, '\t')
      assert.match(h.rowsPlain()[0]!, /· Rows/, `Tab focuses Rows at ${columns}`)
      await key(h, '\t')
      assert.match(h.rowsPlain()[0]!, /Configured theme/, `Tab focuses Detail at ${columns}`)
      assert.ok(!h.view().includes('Choose value'), 'focusing Detail never opens a choice')
      await key(h, '\t')
      assert.match(h.rowsPlain()[0]!, /Settings · Categories/, 'Tab wraps back to the rail')
      await key(h, '\x1b[Z')
      assert.match(h.rowsPlain()[0]!, /Configured theme/, 'Shift+Tab wraps to Detail')
      assert.ok(!h.view().includes('Choose value'), 'the reverse jump never opens a choice')
      await key(h, '\x1b[Z')
      assert.match(h.rowsPlain()[0]!, /· Rows/, 'Shift+Tab returns to Rows')
      await key(h, '\x1b[Z')
      assert.match(h.rowsPlain()[0]!, /Settings · Categories/, 'Shift+Tab returns to the rail')
    }

    await key(h, '\x1b[C') // Right: L0 -> L1
    assert.match(h.rowsPlain()[0]!, /· Rows/, `Right enters the row level at ${columns}`)
    if (columns < 76) {
      const l1 = h.view()
      for (const data of ['\t', '\x1b[Z']) await key(h, data)
      assert.equal(h.view(), l1, 'Tab/Shift+Tab are inert on the narrow L1')
    } else {
      await key(h, '\t')
      assert.match(h.rowsPlain()[0]!, /Configured theme/, 'Tab re-focuses the Detail pane on L1')
      assert.ok(!h.view().includes('Choose value'), 'Tab never opens the L1 choice')
      await key(h, '\x1b[Z') // Detail -> Rows
      assert.match(h.rowsPlain()[0]!, /· Rows/, 'Shift+Tab returns to the Rows pane')
    }

    await key(h, '\x1b[C') // Right: L1 -> inline L2 choice
    assert.match(h.view(), /Choose value/, `Right enters the one-step inline choice at ${columns}`)
    assert.ok(h.view().includes('> dark'), 'the selected option is visibly identified')
    await key(h, '\x1b[F') // End -> last candidate
    assert.ok(h.view().includes('> light'), 'End selects the last candidate without writing')
    await key(h, '\x1b[H') // Home -> first candidate
    assert.ok(h.view().includes('> auto'), 'Home selects the first candidate without writing')
    await key(h, '\x1b[B') // Down -> dark
    assert.ok(h.view().includes('> dark'))
    await key(h, '\x1b[D') // Left cancels L2 -> L1
    assert.ok(!h.view().includes('Choose value'), 'Left cancels rather than leaving a hidden chooser')
    assert.match(h.rowsPlain()[0]!, /· Rows/)
    for (const cancel of ['\x7f', '\x1b'] as const) {
      await key(h, '\x1b[C')
      assert.ok(h.view().includes('Choose value'))
      await key(h, cancel)
      assert.ok(!h.view().includes('Choose value'), 'Backspace/Esc cancel straight to L1')
      assert.match(h.rowsPlain()[0]!, /· Rows/)
    }
    await key(h, '\x1b[D') // Left: L1 -> L0
    assert.match(h.rowsPlain()[0]!, /Settings · Categories/)
    await key(h, '\x1b[D') // Left at L0 is inert
    assert.match(h.rowsPlain()[0]!, /Settings · Categories/)
    assert.equal(h.replacements(), 0, 'navigation never commits the selected value')
    h.dispose()
  }
})

// ── External UI review (PR #295) P2s ───────────────────────────────────────

test('A-02c the list summary survives a long value and stays exact for a short one', async () => {
  const long = `file:${'w'.repeat(120)}`
  // The rows pane is located from its painted pane header, so the assertion
  // follows the real medium geometry (L0 paints the list in its second column).
  const medium = setup({ columns: 100, rows: 40, doc: { theme: long } })
  await medium.open()
  const longRow = rowsPaneText(medium, rowOf(medium, 'Configured theme'))
  assert.ok(longRow.includes('> Configured theme'), `the name stays identifiable: ${JSON.stringify(longRow)}`)
  // The list SUMMARY is the friendly display name (the raw `file:` identity is
  // the Detail/copy fact), so its prefix here is the file name itself.
  assert.ok(longRow.includes('wwww'), `the real summary prefix is painted: ${JSON.stringify(longRow)}`)
  assert.ok(longRow.trimEnd().endsWith('…'), `the truncated summary ends in the list-pane ellipsis: ${JSON.stringify(longRow)}`)
  // Short-value control: the exact value is painted, with no ellipsis at all.
  medium.doc.theme = 'dark'
  await key(medium, 'r')
  const shortRow = rowsPaneText(medium, rowOf(medium, 'Configured theme'))
  assert.ok(shortRow.trimEnd().endsWith('dark'), `the exact short value is visible: ${JSON.stringify(shortRow)}`)
  assert.ok(!shortRow.includes('…'), `a fitting value is never truncated: ${JSON.stringify(shortRow)}`)
  medium.dispose()

  const narrow = setup({ columns: 44, rows: 24, doc: { iconStyle: 'symbols', theme: long } })
  await narrow.open()
  await key(narrow, '\r') // categories -> rows
  const iconRow = narrow.rowsPlain()[rowOf(narrow, 'Icon style')]!
  assert.ok(iconRow.trimEnd().endsWith('symbols'), `the exact short value is visible at 44 cells: ${JSON.stringify(iconRow)}`)
  assert.ok(!iconRow.includes('…'), `a fitting value is never truncated: ${JSON.stringify(iconRow)}`)
  const themeRow = narrow.rowsPlain()[rowOf(narrow, 'Configured theme')]!
  assert.ok(themeRow.includes('Configured theme') && themeRow.includes('wwww'),
    `the long value keeps its prefix: ${JSON.stringify(themeRow)}`)
  assert.ok(themeRow.trimEnd().endsWith('…'), `the long value truncates to the pane edge: ${JSON.stringify(themeRow)}`)
  narrow.dispose()
})

test('A-05b the decorative rules yield before readable content on short screens', async () => {
  // 5 rows without a notice: header + THREE real body rows + bar, no rule row.
  const short = setup({ columns: 72, rows: 5, doc: { theme: 'dark' } })
  await short.open()
  const painted = short.rowsPlain()
  assert.equal(painted.length, 5)
  assert.match(painted.at(-1)!, /Right open · Enter open · Esc close/)
  assert.equal(painted.filter(line => /^─+$/.test(line)).length, 0, 'the decorative rules yield at 5 rows')
  for (const label of ['Models', 'Account', 'Appearance']) {
    assert.ok(painted.some(line => line.includes(label)), `the body keeps the real ${label} row:\n${short.view()}`)
  }
  short.dispose()

  // 6 and 8 rows with a LIVE notice: the notice's body floor is honoured first.
  const live = setup({ columns: 100, rows: 24, doc: { theme: 'dark' } })
  await live.open()
  await key(live, '\r') // L0 -> L1 exposes the real Detail button in medium
  const copyRow = rowOf(live, 'Copy value [C]')
  const copyCol = cellIndexOf(live, copyRow, 'Copy value [C]')
  press(live, copyRow, copyCol)
  release(live, copyRow, copyCol)
  await settle(live)
  assert.ok(live.rowsPlain().some(line => line.includes('Copy sent')), 'the notice is live before the shrink')
  for (const rows of [6, 8]) {
    live.vt.resize(100, rows)
    await live.vt.waitForRender()
    const frame = live.rowsPlain()
    assert.equal(frame.length, rows)
    assert.match(frame.at(-1)!, /Left back/)
    assert.ok(frame.some(line => line.includes('Copy sent')), `the notice is still granted and painted at ${rows} rows:\n${live.view()}`)
    assert.equal(frame.filter(line => /^─+$/.test(line)).length, 0, `the decorative rules yield at ${rows} rows:\n${live.view()}`)
    if (rows === 8) {
      assert.ok(frame.some(line => line.includes('Config Ready')), 'the freshness/scope metadata is granted at 8 rows')
    }
    if (rows === 6) {
      const detailHeader = frame.findIndex(line => line.includes('[Details]'))
      assert.ok(detailHeader >= 0, 'the multi-column pane identity survives the live notice')
      assert.ok(frame[detailHeader + 1]?.includes('Configured theme'), `the selected Detail row remains in the body:\n${live.view()}`)
    }
  }
  live.dispose()
})

// ── External UI review round 2 (PR #295): the narrow drill-down contract ───

test('narrow Left/Right enter exactly one level and never skip directly from Categories to detail', async () => {
  const h = setup({ columns: 72, rows: 24, doc: { theme: 'dark' } })
  await h.open()
  assert.match(h.rowsPlain()[0]!, /Settings · Categories/)
  const before = h.view()
  for (const data of ['\t', '\x1b[Z']) await key(h, data)
  assert.equal(h.view(), before, 'Tab/Shift+Tab are inert on the narrow categories page')
  assert.ok(!h.view().includes('Value'), 'the Detail is never reached directly from Categories')
  await key(h, '\x1b[C') // Right: Categories -> Rows only
  assert.match(h.rowsPlain()[0]!, /Settings · Appearance · Rows/)
  assert.ok(!h.view().includes('Choose value'), 'Right never skips directly from L0 to the choice')
  await key(h, '\x1b[C') // Right: Rows -> inline choice
  assert.match(h.rowsPlain()[0]!, /Settings · Appearance · Configured theme/)
  assert.match(h.view(), /Choose value/)
  await key(h, '\x1b[D') // Left: choice -> Rows
  assert.ok(!h.view().includes('Choose value'))
  assert.match(h.rowsPlain()[0]!, /· Rows/, 'Left cancels to the row level')
  await key(h, '\x1b[D') // Left: Rows -> Categories
  assert.match(h.rowsPlain()[0]!, /Categories/)
  h.dispose()

  const medium = setup({ columns: 100, rows: 24, doc: { theme: 'dark' } })
  await medium.open()
  assert.ok(!medium.view().includes('←'), 'the medium header paints no category arrows')
  await key(medium, '\t')
  assert.match(medium.rowsPlain()[0]!, /· Rows/, 'Tab focuses the Rows pane in medium')
  await key(medium, '\x1b[Z')
  assert.match(medium.rowsPlain()[0]!, /Settings · Categories/, 'Shift+Tab returns to the rail')
  await key(medium, '\x1b[C')
  assert.match(medium.rowsPlain()[0]!, /· Rows/, 'Right enters L1 without changing the category')
  medium.dispose()
})

test('/ UX-10 pre-paint keys resolve the level, never the projection: the same walk at 72, 100 and 160', async () => {
  for (const [columns, rows] of [[72, 24], [100, 40], [160, 40]] as const) {
    const h = setup({ columns, rows, doc: { theme: 'dark' } })
    // Deliberately do NOT await a paint: the first keys arrive before the initial
    // frame, exactly when the level — not the layout — must be the state.
    h.invoke('settings')
    h.vt.sendInput('\x1b[C') // Right: the rail hands the keyboard to the About content
    h.vt.sendInput('\x1b[D') // Left: the content yields it back, NEVER a full close
    await h.vt.waitForRender()
    assert.ok(h.view().includes('Settings'), `the pre-paint Esc must not close the workspace at ${columns}:\n${h.view()}`)
    assert.match(h.rowsPlain()[0]!, /Settings · Categories/, 'the pre-paint Left returns to the categories level')
    // The legacy levels live behind a configuration category: walk the rail
    // to Appearance, then the deeper walk behaves identically.
    await h.walkToCategory('Appearance')
    await key(h, '\r')
    await key(h, '\r')
    await key(h, '\x1b')
    assert.match(h.rowsPlain()[0]!, /Settings · Appearance · Rows/, `the post-paint Esc returns exactly one level at ${columns}`)
    h.dispose()
  }

  // Three keys BEFORE the first paint: Right -> Right -> Left must land on the
  // rail (neither close nor skip a level), exactly like the painted walk.
  for (const [columns, rows] of [[72, 24], [100, 40], [160, 40]] as const) {
    const h = setup({ columns, rows, doc: { theme: 'dark' } })
    h.invoke('settings')
    h.vt.sendInput('\x1b[C') // Right: the rail hands the keyboard to the About content
    h.vt.sendInput('\x1b[C') // Right: the About content owns it; a Right is inert there
    h.vt.sendInput('\x1b[D') // Left: the content yields it back, NEVER a full close
    await h.vt.waitForRender()
    assert.ok(h.view().includes('Settings'), `the pre-paint deep walk never closes at ${columns}:\n${h.view()}`)
    assert.match(h.rowsPlain()[0]!, /Settings · Categories/, `the pre-paint deep walk lands on the rail at ${columns}`)
    // The rest of the walk closes exactly once from the outermost level.
    await key(h, '\x1b')
    assert.ok(h.view().includes('❯'), `the walk closes from L0 at ${columns}`)
    h.dispose()
  }
})

// ── UX-01…UX-11: the unified three-level navigation contract ──────────────
//
// The cases below are the plan's Step-D matrix (UX-01…UX-11) in one place; the
// A-*/F* cases above carry the older evidence levels for the same component.
// UX-12 (Job lease / Question / Approval / Save / session switch / legacy
// handoff lifecycle) stays in `test/app/surface-lifecycle-closure.test.ts`.

test('every width opens at L0, ↑↓ changes the category and Enter enters the rows level', async () => {
  for (const [columns, rows] of [[200, 40], [100, 40], [72, 24], [44, 8]] as const) {
    const h = setup({ columns, rows, doc: { theme: 'dark' } })
    await h.open()
    assert.match(h.rowsPlain()[0]!, /Settings · Categories/, `L0 at ${columns} columns`)
    assert.ok(!h.view().includes('· Rows'), `no level is pre-entered at ${columns}`)
    await key(h, '\x1b[B')
    assert.ok(h.rowsPlain().some(line => line.startsWith('> Display')), `↓ selects Display at ${columns}:\n${h.view()}`)
    await key(h, '\r')
    assert.match(h.rowsPlain()[0]!, /Settings · Display · Rows/, `Enter enters the Display rows at ${columns}`)
    h.dispose()
  }
})

test('Esc walks one level back at every width; only L0 closes', async () => {
  for (const [columns, rows] of [[200, 40], [100, 40], [72, 24]] as const) {
    const h = setup({ columns, rows, doc: { theme: 'dark' } })
    await h.open()
    await key(h, '\r') // L1
    assert.match(h.rowsPlain()[0]!, /· Rows/)
    await key(h, '\x1b')
    assert.match(h.rowsPlain()[0]!, /Settings · Categories/, `Esc from L1 returns to L0 at ${columns}, never closes`)
    await key(h, '\r')
    await key(h, '\r') // L2
    assert.match(h.rowsPlain()[0]!, /Configured theme/)
    await key(h, '\x1b')
    assert.match(h.rowsPlain()[0]!, /· Rows/, `Esc from L2 returns to L1 at ${columns}`)
    await key(h, '\x1b')
    assert.match(h.rowsPlain()[0]!, /Settings · Categories/)
    await key(h, '\x1b')
    assert.ok(h.view().includes('❯'), `Esc at L0 closes the workspace at ${columns}:\n${h.view()}`)
    h.dispose()
  }
})

test('the medium projection is a pure function of focus: L0 categories+rows, L1/L2 rows+detail', async () => {
  for (const columns of [76, 107]) {
    const h = setup({ columns, rows: 40, doc: { theme: 'plugin:acme/solarized' }, themes: pluginThemes() })
    await h.open()
    assert.ok(h.rowsPlain().some(line => line.includes('Categories (8)')), `L0 categories at ${columns}:\n${h.view()}`)
    assert.ok(!h.view().includes('Details'), 'L0 paints no Detail pane')
    assert.ok(!h.view().includes('Copy value [C]'), 'L0 publishes no Detail button')
    await key(h, '\r')
    assert.ok(h.rowsPlain().some(line => line.includes('Details')), 'L1 paints rows+detail')
    assert.ok(!h.view().includes('Categories (8)'), 'L1 drops the categories column')
    await key(h, '\r')
    assert.ok(h.view().includes('Choose value'), 'L2 enters an inline choice without a second browse Enter')
    assert.ok(h.view().includes('Solarized'), 'the selected source identity remains visible')
    assert.ok(!h.view().includes('Categories (8)'), 'L2 keeps the rows+detail projection')
    await key(h, '\x1b')
    assert.match(h.rowsPlain()[0]!, /· Rows/, 'Esc cancels L2 directly back to L1')
    await key(h, '\x1b')
    assert.ok(h.rowsPlain().some(line => line.includes('Categories (8)')), 'Esc from L1 returns to categories+rows')
    assert.ok(!h.view().includes('Details'), 'and hides the detail again')
    h.dispose()
  }
})

test('the narrow projection keeps the inline choice across resize and preserves Detail copy', async () => {
  const h = setup({ columns: 72, rows: 24, doc: { theme: 'dark' } })
  await h.open()
  assert.match(h.rowsPlain()[0]!, /Settings · Categories/)
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Appearance')))
  assert.ok(!h.view().includes('Configured theme'), 'L0 shows only the categories')
  await key(h, '\r')
  assert.match(h.rowsPlain()[0]!, /· Rows/)
  assert.ok(!h.view().includes('Display'), 'L1 shows only the current category rows')
  await key(h, '\r')
  assert.match(h.rowsPlain()[0]!, /Configured theme/)
  assert.ok(h.view().includes('Choose value'), 'a writable L1 row enters the inline choice')
  h.vt.resize(100, 24)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /Configured theme/, 'the medium resize keeps the choice level')
  assert.ok(h.view().includes('Choose value'))
  h.vt.resize(44, 8)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /Appearance · Conf/, 'the 44-column projection keeps the choice level')
  assert.ok(h.view().includes('Value'), 'the persisted old value stays reachable')

  // Cancel back to L1; medium exposes the same Details copy action without a
  // hidden focus cycle or an extra confirmation step.
  await key(h, '\x1b')
  h.vt.resize(100, 24)
  await h.vt.waitForRender()
  const copyRow = rowOf(h, 'Copy value [C]')
  const copyCol = cellIndexOf(h, copyRow, 'Copy value [C]')
  press(h, copyRow, copyCol)
  release(h, copyRow, copyCol)
  await settle(h)
  assert.deepEqual(h.copied, ['dark'], 'the copy still sends the exact source value')
  h.dispose()
})

test('a resize keeps focus/category/row and invalidates the previous painted Confirm hit map', async () => {
  const h = setup({ columns: 200, rows: 40, doc: { theme: 'dark' } })
  await h.open()
  await key(h, '\x1b[B') // Display
  await key(h, '\r') // L1
  await key(h, '\r') // L2 choice
  const buttonRow = rowOf(h, 'Confirm')
  const buttonCol = cellIndexOf(h, buttonRow, 'Confirm')
  press(h, buttonRow, buttonCol)
  h.vt.resize(100, 40)
  await h.vt.waitForRender()
  release(h, buttonRow, buttonCol)
  await settle(h)
  assert.equal(h.replacements(), 0, 'a press recorded against the wide geometry is refused after resize')
  assert.equal(h.doc.theme, 'dark', 'the stale Confirm did not write any preference')
  assert.match(h.rowsPlain()[0]!, /Settings · Display/, 'the category and level survive the resize')
  h.dispose()
})

test('a resize that has NOT repainted yet still refuses the straddling Confirm press', async () => {
  const h = setup({ columns: 72, rows: 24, doc: { theme: 'dark' } })
  await h.open()
  await key(h, '\r') // L0 -> L1 (narrow)
  await key(h, '\r') // L1 -> inline choice
  const buttonRow = rowOf(h, 'Confirm')
  const buttonCol = cellIndexOf(h, buttonRow, 'Confirm')
  press(h, buttonRow, buttonCol)
  // The LIVE terminal is already 96 columns (medium, two panes) but NO repaint
  // has run yet: the resize is a gesture boundary by itself.
  h.vt.resize(96, 24)
  release(h, buttonRow, buttonCol)
  await settle(h)
  assert.equal(h.replacements(), 0, 'a release after a resize without a repaint must be refused')
  assert.match(h.rowsPlain()[0]!, /Settings · Appearance · Configured theme/, 'the choice level survives the resize')
  h.dispose()
})

test('a one-row choice cannot confirm invisibly and the first Enter only reveals its identity', async () => {
  const h = setup({ columns: 100, rows: 24, doc: { theme: 'dark' } })
  await h.open()
  await key(h, '\r') // L0 -> L1
  await key(h, '\x1b[C') // Right -> inline choice

  h.vt.resize(100, 3)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain().at(-1) ?? '', /^Esc back/, 'one granted choice row advertises only its safe back action')
  assert.ok(!h.rowsPlain().at(-1)!.includes('Enter confirm'))
  assert.ok(h.view().includes('> dark'), 'the one candidate row is still identity-bearing')
  await key(h, '\r')
  assert.equal(h.replacements(), 0, 'Enter without a painted confirm hint never writes')
  assert.equal(h.doc.theme, 'dark')

  h.vt.resize(100, 2)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain().at(-1) ?? '', /^Esc back/, 'with zero body rows only Esc remains')
  await key(h, '\r')
  assert.equal(h.replacements(), 0, 'the below-floor Enter stays inert')
  h.dispose()
})

test('clicking another category or row cancels an inline choice atomically', async () => {
  const h = setup({ columns: 200, rows: 24, doc: { theme: 'dark' } })
  await h.open()
  await key(h, '\r') // L0 -> L1
  await key(h, '\r') // L1 -> inline choice
  assert.ok(h.view().includes('Choose value'))

  const displayRow = rowOf(h, 'Display')
  const displayCol = cellIndexOf(h, displayRow, 'Display')
  press(h, displayRow, displayCol)
  release(h, displayRow, displayCol)
  await settle(h)
  assert.ok(!h.view().includes('Choose value'), 'a category click retires the old chooser')
  assert.ok(!h.view().includes('Confirm'), 'the old candidate confirm is no longer painted')
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Display')), 'the clicked category is selected')
  assert.equal(h.replacements(), 0)

  await key(h, '\x1b[C') // L0 -> L1
  await key(h, '\x1b[C') // L1 -> Display preset choice
  assert.ok(h.view().includes('Choose value'))
  const thinkingRow = rowOf(h, 'Thinking detail')
  const thinkingCol = cellIndexOf(h, thinkingRow, 'Thinking detail')
  press(h, thinkingRow, thinkingCol)
  release(h, thinkingRow, thinkingCol)
  await settle(h)
  assert.ok(!h.view().includes('Choose value'), 'a row click cancels the chooser before changing selection')
  assert.ok(!h.view().includes('Confirm'))
  assert.match(h.rowsPlain()[0]!, /Settings · Display · Rows/)
  assert.ok(h.view().includes('> Thinking detail'), 'the clicked row is selected at L1')
  assert.equal(h.replacements(), 0, 'neither navigation click commits a candidate')
  h.dispose()
})

test('a Detail-pane or Change click enters the same one-step inline choice', async () => {
  const h = setup({ columns: 100, rows: 40, doc: { theme: 'dark' } })
  await h.open()
  await key(h, '\r') // L0 -> L1; the medium Details pane is visible
  const valueRow = rowOf(h, 'Value')
  const valueCol = cellIndexOf(h, valueRow, 'Value')
  press(h, valueRow, valueCol)
  release(h, valueRow, valueCol)
  await settle(h)
  assert.ok(h.view().includes('Choose value'), 'ordinary Detail content enters L2 choosing in one click')
  assert.equal(h.replacements(), 0)

  await key(h, '\x1b') // back to L1
  const changeRow = rowOf(h, 'Change…')
  const changeCol = cellIndexOf(h, changeRow, 'Change…')
  press(h, changeRow, changeCol)
  release(h, changeRow, changeCol)
  await settle(h)
  assert.ok(h.view().includes('Choose value'), 'the painted Change button follows the same transition')
  assert.equal(h.replacements(), 0, 'neither entry path writes before explicit confirmation')
  h.dispose()
})

test('changing category refreshes the row selection and the detail; browsing never writes config', async () => {
  const h = setup({ columns: 100, rows: 40, doc: { theme: 'plugin:acme/solarized' }, themes: pluginThemes() })
  await h.open()
  assert.ok(h.view().includes('Configured theme'), 'the appearance rows are the L0 list')
  await key(h, '\x1b[B') // Appearance -> Display
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Display')))
  await key(h, '\r') // L1
  assert.ok(h.view().includes('Transcript display'), 'the Display rows replace the appearance rows')
  await key(h, '\x1b[B') // display-preset -> thinking
  await key(h, '\r') // L2
  assert.match(h.rowsPlain()[0]!, /Thinking detail/, 'the detail follows the new stable row id')
  await key(h, '\x1b') // L1
  await key(h, '\x1b') // L0
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Display')), 'the selected category id survives')
  assert.equal(h.replacements(), 0, 'navigation never writes the configuration')
  h.dispose()
})

test('the arrow hierarchy never leaks keys into the hidden editor', async () => {
  const h = setup({ columns: 100, rows: 40, doc: { theme: 'dark' } })
  await h.vt.waitForRender()
  for (const ch of 'draft') await key(h, ch)
  await h.open()
  await key(h, '\t') // categories -> rows
  assert.match(h.rowsPlain()[0]!, /· Rows/)
  await key(h, '\x1b[Z') // rows -> categories
  assert.match(h.rowsPlain()[0]!, /Settings · Categories/)
  await key(h, '\x1b[C') // Right: L0 -> L1
  assert.match(h.rowsPlain()[0]!, /· Rows/)
  await key(h, '\x1b[D') // Left: L1 -> L0
  assert.match(h.rowsPlain()[0]!, /Settings · Categories/)
  assert.ok(!h.view().includes('draft'), 'no navigation key leaks into the hidden editor')
  assert.deepEqual(h.copied, [], 'no key leaks into a clipboard action')
  await key(h, '\x1b')
  assert.ok(h.view().includes('draft'), 'the editor draft is untouched after the round trip')
  h.dispose()
})

test('only visible panes publish hits: the hidden Detail band neither copies nor focuses', async () => {
  const h = setup({ columns: 100, rows: 40, doc: { theme: 'plugin:acme/solarized' }, themes: pluginThemes() })
  await h.open()
  assert.ok(!h.view().includes('Copy value [C]'), 'L0 paints no Detail button')
  const row = rowOf(h, 'Configured theme')
  press(h, row, 96)
  release(h, row, 96)
  await settle(h)
  assert.deepEqual(h.copied, [], 'a click in the would-be Detail band copies nothing')
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Configured theme')), 'it acted on the visible rows pane instead')
  h.dispose()
})

test('C copies only in a read-only Detail; R refreshes in place; browsing never writes', async () => {
  const h = setup({ columns: 100, rows: 40, doc: { theme: 'plugin:acme/solarized', iconStyle: 'symbols' }, themes: pluginThemes() })
  await h.open()
  await key(h, 'c')
  await settle(h)
  assert.deepEqual(h.copied, [], 'C is inert on the categories level')
  await key(h, '\r') // L1
  await key(h, 'c')
  await settle(h)
  assert.deepEqual(h.copied, [], 'C is inert on the rows level')
  const readsBefore = h.reads()
  await key(h, 'r')
  assert.ok(h.reads() > readsBefore, 'R re-reads the same authority')
  assert.match(h.rowsPlain()[0]!, /· Rows/, 'R keeps the current level')
  await key(h, '\x1b[B') // Configured theme -> read-only Icon style
  await key(h, '\r') // L2 read-only Detail
  await key(h, 'c')
  await settle(h)
  assert.deepEqual(h.copied, ['symbols'], 'C in the read-only Detail copies the exact source value')
  assert.equal(h.replacements(), 0, 'no navigation or refresh ever writes the config document')
  h.dispose()
})

test('a long CJK value wraps inside the narrow read-only Detail and copies byte-exact', async () => {
  const value = `file:${'汉'.repeat(40)}`
  const h = setup({ columns: 44, rows: 8, doc: { iconStyle: value } })
  await h.open()
  await key(h, '\r') // L0 -> L1
  await key(h, '\x1b[B') // Configured theme -> Icon style
  await key(h, '\r') // read-only L2 Detail
  for (const [index, line] of h.vt.getViewport().entries()) {
    assert.ok(visibleWidth(line) <= 44, `row ${index} must stay inside the pane width`)
  }
  await key(h, '\x1b[B') // scroll the wrapped detail
  await key(h, 'c')
  await settle(h)
  assert.deepEqual(h.copied, [value], 'the copy is the exact source value, never the wrapped display')
  h.dispose()
})

// ── UX-12: the frozen responsive projection table ─────────────────────────

test('the projection table is frozen: below 76 columns one pane, 76..107 two, 108 and up three', async () => {
  for (const [columns, panes] of [[75, 1], [76, 2], [107, 2], [108, 3]] as const) {
    const h = setup({ columns, rows: 24, doc: { theme: 'dark' } })
    await h.open()
    await key(h, '\r') // L0 -> L1: the rows pane always, plus the detail when the width grants it
    const painted = h.rowsPlain()
    assert.equal(painted.some(line => line.includes('Categories (8)')), panes === 3, `the categories pane at ${columns} columns:\n${h.view()}`)
    assert.equal(painted.some(line => line.includes('Details')), panes >= 2, `the detail pane at ${columns} columns:\n${h.view()}`)
    assertRowWidths(h, columns)
    h.dispose()
  }
})

// ── B2-B: the Theme / Display write channel ────────────────────────────────
//
// Every case drives the REAL composition end to end: the registered `/settings`
// command builds the read projection and owns the commit semantics, the real
// `TuiApp` screen lease routes the keys and clicks, and the terminal's painted
// cells are what the assertions read. The settings document and the theme
// registry are the external seams; the write really travels the command's
// serialized whole-document path and its authoritative re-read.

/** Select one row at L1; writable rows enter the inline choice with one Enter or Right. */
async function openSelectedRow(h: Harness, row: 'theme' | 'display-preset'): Promise<void> {
  await h.open()
  if (row === 'display-preset') await key(h, '\x1b[B') // Appearance -> Display
  await key(h, '\r') // L0 -> L1
}

test('B-01 the Theme Detail separates the runtime palette from the persisted preference and starts read-only', async () => {
  const h = setup({ columns: 140, rows: 40, doc: { theme: 'plugin:acme/solarized' }, themes: pluginThemes() })
  await openSelectedRow(h, 'theme')
  assert.match(h.rowsPlain()[0]!, /Settings · Appearance · Rows/)
  assert.match(h.view(), /Configured theme/, 'the Detail pane keeps the selected row identity visible')
  assert.match(h.view(), /plugin:acme\/solarized/, 'the persisted source-qualified identity is stated')
  assert.match(h.view(), /Runtime\s+\S/, 'the live runtime palette has its own named fact')
  assert.match(h.view(), /Solarized/)
  assert.match(h.view(), /Change…/, 'the writable row paints its explicit edit verb')
  assert.equal(h.replacements(), 0, 'merely reading the Detail writes nothing')
  h.dispose()
})

test('B-02 Enter opens the L2 choice; moving the candidate writes nothing; only the explicit Confirm commits and verifies', async () => {
  const h = setup({ columns: 140, rows: 40, doc: { theme: 'dark' }, themes: pluginThemes() })
  await openSelectedRow(h, 'theme')
  await key(h, '\r') // L1 -> inline choice
  assert.match(h.view(), /Choose value/)
  const current = h.view().split('\n').find(line => line.includes('[current]')) ?? h.view()
  assert.match(current, /> dark\s+\[current\]/, 'the candidate list marks the persisted value, never a display label')
  // The chip keeps its OWN ink even on the selected candidate row (it must not
  // take the row's selected ink) — the vendored `SettingsListTheme.value` slot
  // paints `selected ? primary : textDim`, which is exactly what this avoids.
  const chipRow = rowOf(h, '[current]')
  assert.equal(h.vt.getCellFgRgb(chipRow, cellIndexOf(h, chipRow, '[current]')), hexToRgb(currentPalette.textMuted),
    'the [current] state chip is textMuted on the SELECTED row too')
  assert.equal(h.replacements(), 0, 'opening the choice writes nothing')

  // A candidate click only moves the highlight.
  const lightRow = rowOf(h, 'light')
  const lightCol = cellIndexOf(h, lightRow, 'light')
  press(h, lightRow, lightCol)
  release(h, lightRow, lightCol)
  await settle(h)
  assert.equal(h.replacements(), 0, 'choosing a candidate is a preview, never a write')
  assert.match(h.view(), /Confirm/, 'the choice publishes its explicit confirm')
  assert.ok(h.view().includes('> light'), 'the clicked candidate owns the highlight')
  assert.equal(h.doc.theme, 'dark', 'the document is untouched while choosing')

  // Esc cancels with zero writes (W-08).
  await key(h, '\x1b')
  assert.match(h.rowsPlain()[0]!, /Settings · Appearance · Rows/, 'Esc cancels to L1 while retaining the visible Detail facts')
  assert.ok(!h.view().includes('Choose value'))
  assert.equal(h.replacements(), 0, 'a cancelled choice writes nothing')
  // Detail values are DERIVED presentation text and must be painted (the old
  // pane left every value in the terminal's default foreground, silently
  // ignoring the palette): the primary value takes `text`, secondary facts one
  // step weaker.
  const detailValueRow = rowOf(h, 'Value')
  assert.equal(h.vt.getCellFgRgb(detailValueRow, cellIndexOf(h, detailValueRow, 'Value') + 12), hexToRgb(currentPalette.text),
    'the primary detail value is painted `text`')
  const detailSourceRow = rowOf(h, 'Freshness')
  assert.equal(h.vt.getCellFgRgb(detailSourceRow, cellIndexOf(h, detailSourceRow, 'Freshness') + 12), hexToRgb(currentPalette.textDim),
    'a secondary detail value is painted one step weaker')

  // Reopen and confirm: exactly ONE document write, verified by the re-read.
  await key(h, '\r')
  await key(h, '\x1b[B') // dark -> light (the builtins are always the first three candidates)
  const confirmRow = rowOf(h, 'Confirm')
  const confirmCol = cellIndexOf(h, confirmRow, 'Confirm')
  press(h, confirmRow, confirmCol)
  release(h, confirmRow, confirmCol)
  await settle(h)
  assert.equal(h.replacements(), 1, 'exactly one document write per confirmed commit')
  assert.equal(h.doc.theme, 'light')
  assert.equal(h.app.currentTheme(), 'light', 'the runtime palette really changed')
  assert.match(h.view(), /Verified · the authoritative read agrees/)
  const verifiedRow = rowOf(h, 'Verified')
  assert.equal(h.vt.getCellFgRgb(verifiedRow, cellIndexOf(h, verifiedRow, 'Verified')), hexToRgb(currentPalette.success),
    'the verified status WORD carries the success token')
  assert.equal(h.vt.getCellFgRgb(verifiedRow, cellIndexOf(h, verifiedRow, 'the authoritative read agrees')), hexToRgb(currentPalette.textDim),
    'the status EXPLANATION stays textDim — only the word takes the semantic token')
  assert.ok(!h.view().includes('Confirm'), 'the choice is retired after the settlement')
  h.dispose()
})

test('B-03 a confirmed Theme commit whose write is refused reports the real failure and never claims Verified', async () => {
  const h = setup({
    columns: 200,
    rows: 40,
    doc: { theme: 'dark' },
    themes: pluginThemes(),
    applyReplace: () => { throw new Error('settings namespace "tui-app" changed since it was read') },
  })
  await openSelectedRow(h, 'theme')
  await key(h, '\r')
  const row = rowOf(h, 'light')
  const col = cellIndexOf(h, row, 'light')
  press(h, row, col)
  release(h, row, col)
  await settle(h)
  const confirmRow = rowOf(h, 'Confirm')
  const confirmCol = cellIndexOf(h, confirmRow, 'Confirm')
  press(h, confirmRow, confirmCol)
  release(h, confirmRow, confirmCol)
  await settle(h)

  assert.equal(h.replacements(), 1)
  assert.equal(h.doc.theme, 'dark', 'the stored preference really did not change')
  assert.match(h.view(), /Not saved · settings namespace "tui-app" changed since it was read/, 'the real reason is on screen')
  // The headline fix: a REFUSED write no longer paints the same ink as a
  // verified one. The status WORD takes `error`; the explanation stays dim.
  const refusedRow = rowOf(h, 'Not saved')
  assert.equal(h.vt.getCellFgRgb(refusedRow, cellIndexOf(h, refusedRow, 'Not saved')), hexToRgb(currentPalette.error),
    'the refused status WORD carries the error token')
  assert.equal(h.vt.getCellFgRgb(refusedRow, cellIndexOf(h, refusedRow, 'changed since it was read')), hexToRgb(currentPalette.textDim),
    'the refusal explanation stays textDim')
  assert.ok(!h.view().includes('Verified'), 'a refused write is never verified')
  // The apply-first runtime fact is reported as such — never rolled back silently.
  assert.match(h.view(), /Runtime\s+light/)
  assert.match(h.view(), /Retry save/, 'the failed row offers the explicit retry')
  h.dispose()
})

test('B-04 Retry save re-dispatches the failed value once the write can succeed', async () => {
  let refuse = true
  const h = setup({
    columns: 200,
    rows: 40,
    doc: { theme: 'dark' },
    themes: pluginThemes(),
    applyReplace: (next) => {
      if (refuse) throw new Error('temporarily unavailable')
      Object.assign(h.doc, next)
    },
  })
  await openSelectedRow(h, 'theme')
  await key(h, '\r')
  const row = rowOf(h, 'light')
  const col = cellIndexOf(h, row, 'light')
  press(h, row, col)
  release(h, row, col)
  await settle(h)
  const confirmRow = rowOf(h, 'Confirm')
  press(h, confirmRow, cellIndexOf(h, confirmRow, 'Confirm'))
  release(h, confirmRow, cellIndexOf(h, confirmRow, 'Confirm'))
  await settle(h)
  assert.match(h.view(), /Not saved · temporarily unavailable/)

  refuse = false
  const retryRow = rowOf(h, 'Retry save')
  press(h, retryRow, cellIndexOf(h, retryRow, 'Retry save'))
  release(h, retryRow, cellIndexOf(h, retryRow, 'Retry save'))
  await settle(h)
  assert.equal(h.doc.theme, 'light')
  assert.match(h.view(), /Verified · the authoritative read agrees/)
  assert.ok(!h.view().includes('Retry save'), 'a verified row offers no retry')
  h.dispose()
})

test('B-05 the Display preset applies through the shared runtime owner, persists exactly once and verifies', async () => {
  const h = setup({ columns: 140, rows: 40, doc: { displayPreset: 'compact', theme: 'dark' }, displayPreset: 'full' })
  await openSelectedRow(h, 'display-preset')
  assert.match(h.view(), /Value\s+full/, 'the row value IS the live runtime preset')
  assert.match(h.view(), /Persisted\s+compact/, 'and the stored preference is named separately')
  await key(h, '\r')
  assert.match(h.view(), /Choose value/)
  const row = rowOf(h, 'focus')
  const col = cellIndexOf(h, row, 'focus')
  press(h, row, col)
  release(h, row, col)
  await settle(h)
  assert.equal(h.replacements(), 0)
  const confirmRow = rowOf(h, 'Confirm')
  press(h, confirmRow, cellIndexOf(h, confirmRow, 'Confirm'))
  release(h, confirmRow, cellIndexOf(h, confirmRow, 'Confirm'))
  await settle(h)

  assert.equal(h.app.displayPreset(), 'focus', 'the runtime preset changed')
  assert.equal(h.doc.displayPreset, 'focus', 'the persisted preference changed')
  assert.equal(h.replacements(), 1, 'the B2-B writer stores the preset exactly once')
  assert.deepEqual(h.calls().filter(call => call.startsWith('setDisplayPreset')), [], 'the runner setter (a SECOND detached write) is never used')
  assert.ok(h.calls().includes('refreshStatus'), 'the footer status is refreshed for the live transition')
  assert.match(h.view(), /Verified · the authoritative read agrees/)
  h.dispose()
})

test('B-05b the profile-wide Visual tools switch confirms through its Host port, verifies and restores', async () => {
  const h = setup({ columns: 200, rows: 40 })
  await h.open('Tools')
  assert.match(h.view(), /Visual tools/, 'the Tools category carries the built-in switch row')
  assert.match(h.view(), /On \[default\]/, 'the schema default is marked as not user-overridden')
  await key(h, '\r') // L0 -> L1
  assert.match(h.rowsPlain()[0]!, /Settings · Tools · Rows/)
  await key(h, '\r') // writable L1 -> L2 inline choice
  assert.match(h.view(), /Choose value/)
  assert.match(h.view(), /> On/, 'the current candidate carries the highlight')
  await key(h, '\x1b[B') // On -> Off
  assert.match(h.view(), /> Off/)
  assert.equal(h.visualWrites().length, 0, 'choosing a candidate never writes')

  await key(h, '\r')
  await settle(h)
  assert.deepEqual(h.visualWrites(), [false], 'the Host port receives exactly one Off write')
  assert.equal(h.visualState()?.enabled, false, 'the Host-facing state really changed')
  assert.match(h.view(), /Status\s+Verified/)
  // A SUCCESSFUL Off is "disabled", never "not applied": the runtime line
  // interprets the live registration fact against the desired configuration.
  assert.match(h.view(), /Runtime\s+Both tools disabled/)
  assert.doesNotMatch(h.view(), /not applied/iu, 'a verified Off is not described as unapplied')

  // Restore On through the SAME row and port.
  await key(h, '\r')
  await key(h, '\x1b[A') // Off -> On
  await key(h, '\r')
  await settle(h)
  assert.deepEqual(h.visualWrites(), [false, true])
  assert.equal(h.visualState()?.enabled, true)
  assert.match(h.view(), /Status\s+Verified/)
  assert.match(h.view(), /Runtime\s+Both tools registered/)
  assert.doesNotMatch(h.view(), /not applied/iu)
  h.dispose()
})

test('B-05c an unavailable Visual tools section stays visible and offers neither choice nor write', async () => {
  const h = setup({ columns: 200, rows: 40, visualToolsUnavailable: true })
  await h.open('Tools')
  assert.match(h.view(), /Visual tools/, 'the category still names its built-in row')
  assert.match(h.view(), /Unavailable/, 'the unreadable section is explicit, never the default')
  await key(h, '\r') // L0 -> L1
  assert.match(h.view(), /No candidate is available for this setting right now/)
  assert.ok(!h.view().includes('Change…'), 'an unreadable section paints no edit verb')
  await key(h, '\r') // entering the Detail must not start a choice
  assert.ok(!h.view().includes('Choose value'), 'no confirm affordance can be reached')
  assert.deepEqual(h.visualWrites(), [], 'no Host write was dispatched')
  h.dispose()
})

test('B-05d a stale backend keeps the last-known Visual tools value but refuses the write', async () => {
  const h = setup({
    columns: 200,
    rows: 40,
    readiness: 'stale',
    visualTools: { enabled: false, revision: 1, userOverridden: true, applied: false },
  })
  await h.open('Tools')
  assert.match(h.view(), /Off/, 'the last-known value stays readable')
  assert.match(h.view(), /Runtime\s+Both tools disabled/, 'a disabled last-known pair is described as disabled')
  assert.match(h.view(), /Last-known value · reconnecting/)
  await key(h, '\r')
  await key(h, '\r')
  assert.ok(!h.view().includes('Choose value'))
  assert.deepEqual(h.visualWrites(), [], 'a non-ready backend never dispatches the switch')
  h.dispose()
})

test('B-05e a switch the Host registry did not adopt is reported as unverified, never Verified', async () => {
  const h = setup({
    columns: 200,
    rows: 40,
    visualTools: { enabled: false, revision: 1, userOverridden: true, applied: false },
    visualToolsAppliedAfterWrite: false,
  })
  await h.open('Tools')
  await key(h, '\r')
  await key(h, '\r')
  await key(h, '\x1b[A') // Off -> On
  await key(h, '\r')
  await settle(h)
  assert.deepEqual(h.visualWrites(), [true])
  assert.match(h.view(), /Commit accepted · verification unavailable/)
  assert.match(h.view(), /Runtime\s+Not applied — registration failed/u, 'a configured On that did not register is named as a failure')
  assert.match(h.view(), /did not adopt/u, 'the real registry fact is stated')
  assert.ok(!h.view().includes('Verified'), 'a persisted value the runtime did not adopt is never Verified')
  h.dispose()
})

test('B-05e2 a verified Off whose registrations remain is named as a runtime mismatch', async () => {
  const h = setup({
    columns: 200,
    rows: 40,
    visualToolsAppliedAfterWrite: true,
  })
  await h.open('Tools')
  await key(h, '\r')
  await key(h, '\r')
  await key(h, '\x1b[B') // On -> Off
  await key(h, '\r')
  await settle(h)
  assert.deepEqual(h.visualWrites(), [false])
  assert.match(h.view(), /Status\s+Commit accepted · verification unavailable/)
  assert.match(h.view(), /Runtime\s+Not applied — tools remain registered/u)
  assert.doesNotMatch(h.view(), /Status\s+Verified/u)
  h.dispose()
})

test('B-05f a refused Visual tools write is reported as Not saved and never Verified', async () => {
  const h = setup({
    columns: 200,
    rows: 40,
    visualTools: { enabled: false, revision: 1, userOverridden: true, applied: false },
    visualToolsWriteFailure: 'settings namespace "pi-tui-visual-tools" changed since it was read',
  })
  await h.open('Tools')
  await key(h, '\r')
  await key(h, '\r')
  await key(h, '\x1b[A') // Off -> On
  await key(h, '\r')
  await settle(h)
  assert.deepEqual(h.visualWrites(), [true])
  assert.match(h.view(), /Not saved · settings namespace "pi-tui-visual-tools" changed since it was read/)
  assert.ok(!h.view().includes('Verified'))
  h.dispose()
})

test('B-05g an external edit before Confirm is a conflict, never a silent overwrite', async () => {
  const h = setup({ columns: 200, rows: 40, visualToolsExternalChange: false })
  await h.open('Tools')
  await key(h, '\r')
  await key(h, '\r')
  await key(h, '\x1b[B') // On -> Off
  await key(h, '\r')
  await settle(h)
  assert.deepEqual(h.visualWrites(), [false], 'the confirm reached the Host once')
  assert.match(h.view(), /Outcome unknown/, 'the stale decision is not attributed as a save or a refusal')
  assert.ok(!h.view().includes('Verified'), 'a stale decision is never Verified')
  assert.equal(h.visualState()?.enabled, false, 'the external edit stays authoritative')
  h.dispose()
})

test('B-06 a stale backend never writes and says why; the Display runtime fact still applies locally', async () => {
  const theme = setup({ columns: 200, rows: 40, doc: { theme: 'dark' }, readiness: 'stale', themes: pluginThemes() })
  await openSelectedRow(theme, 'theme')
  await key(theme, '\r')
  const themeRow = rowOf(theme, 'light')
  press(theme, themeRow, cellIndexOf(theme, themeRow, 'light'))
  release(theme, themeRow, cellIndexOf(theme, themeRow, 'light'))
  await settle(theme)
  const themeConfirm = rowOf(theme, 'Confirm')
  press(theme, themeConfirm, cellIndexOf(theme, themeConfirm, 'Confirm'))
  release(theme, themeConfirm, cellIndexOf(theme, themeConfirm, 'Confirm'))
  await settle(theme)
  assert.equal(theme.replacements(), 0, 'a non-ready backend never dispatches a Host write')
  assert.match(theme.view(), /Not saved · the configuration is stale; the theme was not changed/)
  assert.ok(!theme.view().includes('Verified'))
  theme.dispose()

  const display = setup({ columns: 200, rows: 40, doc: { displayPreset: 'compact' }, displayPreset: 'full', readiness: 'stale' })
  await openSelectedRow(display, 'display-preset')
  await key(display, '\r')
  const displayRow = rowOf(display, 'focus')
  press(display, displayRow, cellIndexOf(display, displayRow, 'focus'))
  release(display, displayRow, cellIndexOf(display, displayRow, 'focus'))
  await settle(display)
  const displayConfirm = rowOf(display, 'Confirm')
  press(display, displayConfirm, cellIndexOf(display, displayConfirm, 'Confirm'))
  release(display, displayConfirm, cellIndexOf(display, displayConfirm, 'Confirm'))
  await settle(display)
  assert.equal(display.app.displayPreset(), 'focus', 'the Client-local runtime fact still applies')
  assert.equal(display.replacements(), 0, 'and the stale preference is not written')
  assert.match(display.view(), /Not saved · the display preset is applied locally, but the configuration is stale/)
  display.dispose()
})

test('B-07 a stored theme whose source is gone is listed as unavailable and can never be confirmed', async () => {
  const h = setup({ columns: 140, rows: 40, doc: { theme: 'plugin:gone/removed' } })
  await openSelectedRow(h, 'theme')
  assert.match(h.view(), /plugin:gone\/removed/, 'the broken persisted identity is still readable')
  await key(h, '\r')
  assert.match(h.view(), /unavailable/, 'the gone source is marked unavailable')
  const row = rowOf(h, 'Confirm')
  press(h, row, cellIndexOf(h, row, 'Confirm'))
  release(h, row, cellIndexOf(h, row, 'Confirm'))
  await settle(h)
  assert.equal(h.replacements(), 0, 'an unavailable source is never written')
  assert.match(h.view(), /Not saved · the selected source is no longer available/)
  h.dispose()
})

test('B-08 the read-only rows keep their copy verb and gain no edit channel', async () => {
  const h = setup({ columns: 200, rows: 40, doc: { theme: 'dark', iconStyle: 'minimal' } })
  await openSelectedRow(h, 'theme')
  await key(h, '\x1b[B') // Configured theme -> Icon style
  await key(h, '\r') // read-only Detail
  assert.match(h.view(), /Icon style/)
  assert.match(h.view(), /Copy value \[C\]/)
  assert.ok(!h.view().includes('Change…'), 'a read-only row paints no edit verb')
  assert.match(h.view(), /read-only here/)
  const before = h.replacements()
  await key(h, '\r')
  assert.ok(!h.view().includes('Choose Icon style'), 'Enter on a read-only row opens no choice')
  assert.equal(h.replacements(), before, 'and writes nothing')
  await key(h, 'c')
  await settle(h)
  assert.deepEqual(h.copied, ['minimal'], 'the copy verb still carries the exact source value')
  assert.equal(h.replacements(), before)
  h.dispose()
})

test('B-09 a settlement held across the teardown never reaches a closed or replacement workspace', async () => {
  const h = setup({ columns: 200, rows: 40, doc: { theme: 'dark' }, themes: pluginThemes(), holdOwned: true })
  await openSelectedRow(h, 'theme')
  await key(h, '\r')
  const row = rowOf(h, 'light')
  press(h, row, cellIndexOf(h, row, 'light'))
  release(h, row, cellIndexOf(h, row, 'light'))
  await settle(h)
  const confirmRow = rowOf(h, 'Confirm')
  press(h, confirmRow, cellIndexOf(h, confirmRow, 'Confirm'))
  release(h, confirmRow, cellIndexOf(h, confirmRow, 'Confirm'))
  await settle(h)
  assert.match(h.view(), /Saving…/, 'the pending phase is stated while the write is in flight')
  assert.equal(h.replacements(), 0, 'the held write has not run yet')

  // Leave the workspace while the write is in flight, THEN let it settle.
  await key(h, '\x1b')
  await key(h, '\x1b')
  await key(h, '\x1b')
  assert.ok(!h.view().includes('Settings ·'), 'Esc at L0 closed the workspace')
  h.releaseOwned()
  await settle(h)
  // The already-dispatched write still completes under its owner (a closed
  // workspace must not cancel a real Host commit), but its settlement is dropped:
  // a NEWLY opened workspace never inherits the previous instance's outcome.
  assert.equal(h.doc.theme, 'light', 'the dispatched write really landed')
  assert.ok(!h.app.isDisposed())
  await h.open()
  assert.match(h.view(), /Settings · Categories/)
  assert.ok(!h.view().includes('Verified'), 'a new instance never inherits the previous settlement')
  assert.ok(!h.view().includes('Not saved'))
  h.dispose()
})

test('B-10 the 44x8 choice stays reachable, identity-fenced across a resize, and only the painted confirm writes', async () => {
  const h = setup({ columns: 44, rows: 8, doc: { theme: 'dark' } })
  await h.open()
  await key(h, '\r')
  await key(h, '\r')
  for (const [index, line] of h.vt.getViewport().entries()) {
    assert.ok(visibleWidth(line) <= 44, `row ${index} must stay inside the pane width`)
  }
  assert.match(h.view(), /Choose value/, 'the second Enter opens the choice directly on the narrowest projection')
  assert.match(h.view(), /Confirm/)
  // A press against the 44-column geometry, a resize before the release: the
  // gesture is refused (the resize is a boundary of its own).
  const confirmRow = rowOf(h, 'Confirm')
  const confirmCol = cellIndexOf(h, confirmRow, 'Confirm')
  press(h, confirmRow, confirmCol)
  h.vt.resize(100, 24)
  await h.vt.waitForRender()
  release(h, confirmRow, confirmCol)
  await settle(h)
  assert.equal(h.replacements(), 0, 'a straddling press never confirms')
  assert.match(h.view(), /Choose value/, 'the choice survives the resize with its candidate')
  h.dispose()
})

test('B-11 a write the authority readably disagrees with is Not saved, never Verified and never "verification unavailable"', async () => {
  // The document call RESOLVES (the Host accepted the request) but the stored
  // value never becomes the requested one — the one shape where "the write
  // returned" must not be reported as saved.
  const h = setup({
    columns: 200,
    rows: 40,
    doc: { theme: 'dark' },
    themes: pluginThemes(),
    applyReplace: () => {},
  })
  await openSelectedRow(h, 'theme')
  await key(h, '\r')
  const row = rowOf(h, 'light')
  press(h, row, cellIndexOf(h, row, 'light'))
  release(h, row, cellIndexOf(h, row, 'light'))
  await settle(h)
  const confirmRow = rowOf(h, 'Confirm')
  press(h, confirmRow, cellIndexOf(h, confirmRow, 'Confirm'))
  release(h, confirmRow, cellIndexOf(h, confirmRow, 'Confirm'))
  await settle(h)

  assert.equal(h.replacements(), 1)
  assert.equal(h.doc.theme, 'dark', 'the document really still holds the old value')
  // The write RETURNED SUCCESS and the authority READABLY disagrees: the value is not
  // stored, so it is a failure — "verification unavailable" would claim the readback
  // could not be performed, which is false here.
  assert.match(h.view(), /Not saved · the write reported success, but the authoritative document reads dark/)
  assert.ok(!h.view().includes('Verified'), 'an unconfirmed value is never Verified')
  assert.match(h.view(), /Retry save/, 'and the row offers the explicit retry')
  h.dispose()
})

test('B-12 the writable rows reach the choice and confirm at every responsive breakpoint', async () => {
  for (const [columns, rows] of [[200, 40], [120, 40], [109, 40], [108, 40], [107, 40], [76, 40], [75, 24], [60, 24]] as const) {
    const h = setup({ columns, rows, doc: { theme: 'dark' } })
    await openSelectedRow(h, 'theme')
    assert.match(h.view(), /Change…|Right choose|Enter choose/, `the writable row offers a visible edit entry at ${columns}x${rows}:\n${h.view()}`)
    await key(h, '\r')
    assert.match(h.view(), /Choose value/, `the choice names its field at ${columns}x${rows}:\n${h.view()}`)
    assert.match(h.view(), /Confirm/, `the explicit confirm is painted at ${columns}x${rows}:\n${h.view()}`)
    assertRowWidths(h, columns)
    // The keyboard path confirms the same way the painted button does.
    await key(h, '\x1b[B') // dark -> light
    await key(h, '\r')
    await settle(h)
    assert.equal(h.replacements(), 1, `exactly one write at ${columns}x${rows}`)
    assert.equal(h.doc.theme, 'light', `the confirmed value really landed at ${columns}x${rows}`)
    // The status wraps at narrow widths: assert the field state, not one line.
    assert.match(h.view(), /Status\s+Verified/)
    h.dispose()
  }
})

// ── B2-B round 2: the qualified paths and the reviewer's P2 regressions ────

test('B-13 the REAL Direct adapter drives the workspace write end to end (UI → path ops → authoritative re-read → Verified)', async () => {
  const fixture = createDirectSettingsFixture({ theme: 'dark', iconStyle: 'symbols' })
  const h = setup({ columns: 140, rows: 40, tuiSettings: fixture.settings })
  await openSelectedRow(h, 'theme')
  await key(h, '\r')
  const row = rowOf(h, 'light')
  press(h, row, cellIndexOf(h, row, 'light'))
  release(h, row, cellIndexOf(h, row, 'light'))
  await settle(h)
  const confirm = rowOf(h, 'Confirm')
  press(h, confirm, cellIndexOf(h, confirm, 'Confirm'))
  release(h, confirm, cellIndexOf(h, confirm, 'Confirm'))
  await settle(h)

  assert.equal(fixture.calls.length, 1, 'exactly one real SettingsForms mutation')
  // ONE path-scoped op: the changed field only — nothing inherited is pinned into
  // the profile (the W-11 whole-document preservation property, through the real
  // adapter rather than a hand-rolled replace).
  assert.deepEqual(fixture.calls[0]!.ops, [{ op: 'set', path: ['theme'], value: 'light' }])
  assert.equal(fixture.calls[0]!.ns, 'tui-app')
  assert.equal(fixture.calls[0]!.revision, 7, 'the fence is the revision the diff was reconciled against')
  assert.equal(fixture.document().theme, 'light', 'the committed document carries the new value')
  assert.equal(fixture.document().iconStyle, 'symbols', 'and every other field is untouched')
  assert.match(h.view(), /Verified · the authoritative read agrees/)
  assert.equal(h.app.currentTheme(), 'light', 'the runtime palette changed with it')
  h.dispose()
})

test('B-14 the Persisted fact distinguishes a readable document without a value from an unreadable one', async () => {
  // A readable document with no stored preset: `not set`, never "unreadable".
  const readable = setup({ columns: 200, rows: 40, doc: { theme: 'dark' }, displayPreset: 'full' })
  await openSelectedRow(readable, 'display-preset')
  assert.match(readable.view(), /Persisted\s+not set/, `the readable document states the absence: ${readable.view()}`)
  readable.dispose()

  // No document at all: an explicit unknown, and no write verb is offered as a save.
  const missing = setup({ columns: 200, rows: 40, settingsService: false })
  await openSelectedRow(missing, 'display-preset')
  assert.match(missing.view(), /Persisted\s+unknown — the TUI settings document could not be read/)
  missing.dispose()
})

test('B-15 a long CJK candidate wraps while retaining its source-qualified raw identity', async () => {
  const label = `汉${'字'.repeat(30)}`
  const themes = new ThemeRegistry()
  themes.register({ id: 'long-cjk', name: label, palette: darkColors }, 'acme-owner', 'acme')
  const value = themePickerRows(themes).find(row => row.displayName === label)?.value
  assert.ok(value !== undefined, 'the plugin theme is selectable')
  // 24 rows so the settled Status line stays inside the granted viewport after the
  // wrapped Value/Source block; the width is what this case is about.
  const h = setup({ columns: 44, rows: 24, doc: { theme: 'dark' }, themes })
  await openSelectedRow(h, 'theme')
  await key(h, '\r')
  assert.match(h.view(), /Choose value/)
  for (const [index, line] of h.vt.getViewport().entries()) {
    assert.ok(visibleWidth(line) <= 44, `row ${index} must stay inside the pane width`)
  }
  // The whole label is readable: the wrapped candidate block carries it, and every
  // one of its rows is a real hit target (never a truncated label with a hidden tail).
  const rows = h.rowsPlain()
  const start = rows.findIndex(line => line.includes('汉字'))
  assert.ok(start > 1, `the candidate must be painted: ${h.view()}`)
  const painted = rows.slice(start)
    .filter(line => line.includes('汉字') || line.trimStart().startsWith('字'))
    .map(line => line.trim())
    .join('')
  assert.ok(painted.includes(label), `the whole label must be readable: ${h.view()}`)
  press(h, start + 1, 4)
  release(h, start + 1, 4)
  await settle(h)
  assert.ok(h.view().includes(value), 'the source-qualified raw identity is visible before the explicit confirm')
  assert.equal(h.replacements(), 0, 'selecting a candidate through its wrapped tail writes nothing')
  const confirm = rowOf(h, 'Confirm')
  press(h, confirm, cellIndexOf(h, confirm, 'Confirm'))
  release(h, confirm, cellIndexOf(h, confirm, 'Confirm'))
  await settle(h)
  assert.equal(h.doc.theme, value, 'the confirmed value is the untouched source-qualified identity')
  assert.match(h.view(), /Status\s+Verified/)
  h.dispose()
})

test('B-15b the source-qualified candidate identity stays visible before 44x8 keyboard confirm', async () => {
  const themes = new ThemeRegistry()
  themes.register({ id: 'solarized', name: 'Solarized', palette: darkColors }, 'acme-owner', 'acme')
  const value = 'plugin:acme/solarized'
  const h = setup({ columns: 44, rows: 8, doc: { theme: 'dark' }, themes })
  await openSelectedRow(h, 'theme')
  await key(h, '\r')
  await key(h, '\x1b[B') // dark -> light
  await key(h, '\x1b[B') // light -> the source-qualified plugin theme
  assert.ok(h.view().includes(value), `the exact candidate identity is painted before confirm:\n${h.view()}`)
  assert.match(h.view(), /Enter confirm/, 'the visible identity and keyboard confirm hint coexist')
  assert.match(h.view(), /Confirm\s+Cancel/, 'the explicit Detail confirm action is painted')
  await key(h, '\r')
  await settle(h)
  assert.equal(h.replacements(), 1, 'one explicit Enter dispatches exactly one write')
  assert.equal(h.doc.theme, value, 'the exact source-qualified identity is committed')
  h.dispose()
})

test('B-15c identity-aware 44x8 allocation shows a full long raw identity with confirm', async () => {
  const id = 'x'.repeat(80)
  const themes = new ThemeRegistry()
  themes.register({ id, name: 'Long custom theme', palette: darkColors }, 'acme-owner', 'acme')
  const value = themePickerRows(themes).find(row => row.displayName === 'Long custom theme')?.value
  assert.ok(value !== undefined, 'the long plugin theme is selectable')
  const h = setup({ columns: 44, rows: 8, doc: { theme: 'dark' }, themes })
  await openSelectedRow(h, 'theme')
  await key(h, '\r')
  await key(h, '\x1b[B') // dark -> light
  await key(h, '\x1b[B') // light -> the long source-qualified identity
  const shortText = h.rowsPlain().map(line => line.trim()).join('')
  const initialView = h.view()
  assert.ok(shortText.includes(value), `the complete raw identity fits at 44x8:\n${initialView}`)
  assert.ok(initialView.includes('Value'), `the persisted old value remains visible:\n${initialView}`)
  assert.match(initialView, /Enter confirm/, 'the complete identity and keyboard confirm hint coexist')
  assert.match(initialView, /Confirm\s+Cancel/, 'the explicit Detail confirm action is painted')
  assert.ok(!(h.rowsPlain().at(-1) ?? '').includes('PgUp/PgDn'),
    'the width-constrained Action Bar omits the facts-page hint at 44x8')
  assert.equal(h.replacements(), 0, 'reading the long candidate does not write before confirmation')
  await key(h, '\x1b[6~') // PageDown is a facts-region capability even when its hint is elided.
  const afterPageDown = h.view()
  assert.notEqual(afterPageDown, initialView, `PageDown scrolls hidden facts at 44x8:\n${afterPageDown}`)
  assert.ok(afterPageDown.includes('Scope'), `PageDown reveals the next fact row at 44x8:\n${afterPageDown}`)
  assert.ok(afterPageDown.replace(/\s+/g, '').includes(value),
    'facts paging leaves the complete selected identity visible')
  assert.equal(h.replacements(), 0, 'reading facts never confirms the candidate')
  await key(h, '\x1b[5~') // PageUp returns to the original facts without changing the candidate.
  assert.equal(h.view(), initialView, 'PageUp restores the first facts page while the hint remains omitted')
  await key(h, '\r')
  await settle(h)
  assert.equal(h.replacements(), 1, 'one explicit Enter dispatches exactly one write')
  assert.equal(h.doc.theme, value, 'the confirmed source-qualified identity is exact')
  h.dispose()
})

test('B-15d identity beyond the adaptive 44x8 budget remains non-confirmable', async () => {
  const id = 'x'.repeat(200)
  const themes = new ThemeRegistry()
  themes.register({ id, name: 'Oversized custom theme', palette: darkColors }, 'acme-owner', 'acme')
  const value = themePickerRows(themes).find(row => row.displayName === 'Oversized custom theme')?.value
  assert.ok(value !== undefined, 'the oversized plugin theme is selectable')
  const h = setup({ columns: 44, rows: 8, doc: { theme: 'dark' }, themes })
  await openSelectedRow(h, 'theme')
  await key(h, '\r')
  await key(h, '\x1b[B') // dark -> light
  await key(h, '\x1b[B') // light -> the oversized source-qualified identity
  const shortText = h.rowsPlain().map(line => line.trim()).join('')
  assert.ok(!shortText.includes(value), `the identity exceeds the bounded 44x8 candidate area:\n${h.view()}`)
  assert.ok(!h.view().includes('Enter confirm'), `confirmation stays hidden while identity rows are missing:\n${h.view()}`)
  assert.ok(!h.view().includes('Confirm'), `no painted Confirm button is granted for a partial identity:\n${h.view()}`)
  await key(h, '\r')
  await settle(h)
  assert.equal(h.replacements(), 0, 'an identity beyond the short-screen capacity cannot be committed')
  assert.equal(h.doc.theme, 'dark')
  h.dispose()
})

test('B-16 the wheel really scrolls the candidate list independently of its selection', async () => {
  const themes = longNamedThemes(5)
  const h = setup({ columns: 44, rows: 8, doc: { theme: 'dark' }, themes })
  await openSelectedRow(h, 'theme')
  await key(h, '\r')
  assert.match(h.view(), /> dark/, 'the current candidate is revealed first')
  // Two candidate rows are granted at 44x8: the longer list lets the wheel move
  // the unchanged selection's identity out of view without touching the facts.
  wheel(h, 4, 10, true)
  await h.vt.waitForRender()
  wheel(h, 4, 10, true)
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('> dark'), `the wheel scrolled the highlighted candidate out of the viewport: ${h.view()}`)
  assert.match(h.view(), /light/, 'and another candidate is visible')
  // Candidate navigation still changes identity and reveals the selected head.
  await key(h, '\x1b[B')
  assert.match(h.view(), /> light/)
  h.dispose()
})

test('B-16b wheel scrolling the facts leaves candidate identity and offset alone', async () => {
  const themes = longNamedThemes(10)
  const value = `file:${'x'.repeat(120)}`
  const h = setup({ columns: 108, rows: 24, doc: { theme: value }, themes })
  await openSelectedRow(h, 'theme')
  await key(h, '\x1b[C') // Right -> inline choice
  await key(h, '\x1b[H') // Home -> first candidate, visible
  assert.ok(h.view().includes('> auto'))

  const valueRow = rowOf(h, 'Value')
  wheel(h, valueRow, cellIndexOf(h, valueRow, 'Value'), true)
  await h.vt.waitForRender()
  assert.ok(h.view().includes('> auto'), 'a fact-region wheel never changes the candidate selection')
  const runtimeLine = h.rowsPlain().find(line => line.includes('Runtime'))
  assert.ok(runtimeLine, `the scrolled facts include Runtime:\n${h.view()}`)

  const autoRow = rowOf(h, '> auto')
  wheel(h, autoRow, cellIndexOf(h, autoRow, '> auto'), true)
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('> auto'), 'an option-region wheel moves only the candidate viewport')
  assert.equal(h.rowsPlain().find(line => line.includes('Runtime')), runtimeLine,
    'scrolling the candidates leaves the fact viewport exactly where it was')
  h.dispose()
})

test('B-17 choosing auto drops the plugin-theme record, so a later HMR unload cannot force dark over it', async () => {
  const themes = pluginThemes()
  const h = setup({ columns: 140, rows: 40, doc: { theme: 'plugin:acme/solarized' }, themes })
  // The plugin palette is the LIVE one when the user opens the workspace.
  h.app.applyPluginPalette('plugin:acme/solarized', darkColors)
  assert.equal(h.app.activePluginTheme(), 'plugin:acme/solarized', 'the plugin theme is recorded as applied')
  await openSelectedRow(h, 'theme')
  await key(h, '\r')
  const autoRow = rowOf(h, 'auto')
  press(h, autoRow, cellIndexOf(h, autoRow, 'auto'))
  release(h, autoRow, cellIndexOf(h, autoRow, 'auto'))
  await settle(h)
  const confirm = rowOf(h, 'Confirm')
  press(h, confirm, cellIndexOf(h, confirm, 'Confirm'))
  release(h, confirm, cellIndexOf(h, confirm, 'Confirm'))
  await settle(h)
  assert.equal(h.doc.theme, 'auto')
  assert.match(h.view(), /Verified · the authoritative read agrees/)
  // The unload hook only falls back while the unloaded value is STILL the recorded
  // active theme; a stale record would force dark and stop the terminal tracking.
  assert.equal(h.app.activePluginTheme(), undefined, 'the left plugin theme is no longer the active fallback owner')
  h.dispose()
})

test('B-18 a late OSC answer never overrides a newer choice, while it still applies to an unchallenged auto', async () => {
  const saved = {
    NO_COLOR: process.env.NO_COLOR,
    FORCE_COLOR: process.env.FORCE_COLOR,
    CI: process.env.CI,
    COLORFGBG: process.env.COLORFGBG,
  }
  process.env.NO_COLOR = ''
  process.env.FORCE_COLOR = ''
  process.env.CI = ''
  delete process.env.COLORFGBG
  const lightReply = '\x1b]11;rgb:ffff/ffff/ffff\x1b\\'
  // Enter is the same confirm the painted [Confirm] publishes; a second click on
  // the same cell would be the terminal's double-click word selection instead.
  const confirmChoice = async (h: Harness): Promise<void> => {
    assert.match(h.view(), /Confirm/, 'the choice publishes its confirm')
    await key(h, '\r')
    await settle(h)
  }
  try {
    // POSITIVE CONTROL: an unchallenged `auto` accepts the terminal's answer.
    const auto = setup({ columns: 140, rows: 40, doc: { theme: 'dark' } })
    await openSelectedRow(auto, 'theme')
    await key(auto, '\r')
    await key(auto, '\x1b[A') // dark -> auto
    await confirmChoice(auto)
    assert.equal(auto.doc.theme, 'auto')
    auto.vt.sendInput(lightReply)
    await settle(auto)
    assert.equal(auto.app.currentTheme(), 'light', 'the answer of a still-current auto applies')
    assert.match(auto.view(), /Runtime\s+light/, 'and the Detail follows the applied runtime fact')
    auto.dispose()

    // REGRESSION (F2): a newer explicit choice wins even while its persistence is
    // still in flight — the guard is the synchronous intent, never the document.
    let writes = 0
    const raced = setup({
      columns: 140,
      rows: 40,
      doc: { theme: 'dark' },
      applyReplace: (next) => {
        writes += 1
        if (writes === 1) {
          Object.assign(raced.doc, next)
          return undefined
        }
        // The explicit write is still IN FLIGHT: the port promise settles only once
        // the document really changed.
        return new Promise<void>(resolve => {
          setTimeout(() => {
            Object.assign(raced.doc, next)
            resolve()
          }, 300)
        })
      },
    })
    await openSelectedRow(raced, 'theme')
    await key(raced, '\r')
    await key(raced, '\x1b[A') // dark -> auto
    await confirmChoice(raced)
    assert.equal(raced.doc.theme, 'auto', 'the auto preference committed')
    await key(raced, '\r') // reopen the choice (still on auto)
    await key(raced, '\x1b[B') // auto -> dark
    await confirmChoice(raced)
    assert.equal(raced.app.currentTheme(), 'dark', 'the explicit choice applied runtime-first')
    assert.equal(raced.doc.theme, 'auto', 'while its persistence is still in flight')
    raced.vt.sendInput(lightReply)
    await settle(raced)
    assert.equal(raced.app.currentTheme(), 'dark', 'the late answer of the replaced auto must not colour the surface')
    await new Promise(resolve => setTimeout(resolve, 360))
    await settle(raced)
    assert.equal(raced.doc.theme, 'dark', 'and the explicit choice really landed')
    assert.match(raced.view(), /Verified · the authoritative read agrees/)
    raced.dispose()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('B-19 a dispatched write that fails after the workspace closed still leaves a diagnostic', async () => {
  const h = setup({
    columns: 140,
    rows: 40,
    doc: { theme: 'dark' },
    themes: pluginThemes(),
    holdOwned: true,
    applyReplace: () => { throw new Error('settings namespace "tui-app" changed since it was read') },
  })
  await openSelectedRow(h, 'theme')
  await key(h, '\r')
  const row = rowOf(h, 'light')
  press(h, row, cellIndexOf(h, row, 'light'))
  release(h, row, cellIndexOf(h, row, 'light'))
  await settle(h)
  const confirm = rowOf(h, 'Confirm')
  press(h, confirm, cellIndexOf(h, confirm, 'Confirm'))
  release(h, confirm, cellIndexOf(h, confirm, 'Confirm'))
  await settle(h)
  assert.match(h.view(), /Saving…/, 'the write is held in flight')
  assert.deepEqual(h.warnings(), [], 'nothing is reported before it settles')

  // Leave the workspace, THEN let the write fail.
  await key(h, '\x1b')
  await key(h, '\x1b')
  await key(h, '\x1b')
  assert.ok(!h.view().includes('Settings ·'), 'the workspace is closed')
  h.releaseOwned()
  await settle(h)

  const warnings = h.warnings()
  assert.equal(warnings.length, 1, `the real failure must stay diagnosable: ${JSON.stringify(warnings)}`)
  assert.equal(warnings[0]!.message, 'settings write')
  assert.equal(warnings[0]!.fields?.field, 'theme')
  assert.equal(warnings[0]!.fields?.outcome, 'not-saved')
  assert.match(String(warnings[0]!.fields?.reason), /changed since it was read/)
  assert.ok(!h.view().includes('Not saved'), 'and it never repaints the surface the user left')
  h.dispose()
})

test('B-20 a FAILED candidate never steals the intent of a pending auto query', async () => {
  const saved = {
    NO_COLOR: process.env.NO_COLOR,
    FORCE_COLOR: process.env.FORCE_COLOR,
    CI: process.env.CI,
    COLORFGBG: process.env.COLORFGBG,
  }
  process.env.NO_COLOR = ''
  process.env.FORCE_COLOR = ''
  process.env.CI = ''
  delete process.env.COLORFGBG
  const lightReply = '\x1b]11;rgb:ffff/ffff/ffff\x1b\\'
  try {
    const themes = new ThemeRegistry()
    // A live contribution whose palette cannot be applied: the registry does not
    // runtime-validate a palette, so the apply really throws.
    themes.register({ id: 'broken', name: 'Broken', palette: { text: 42 } as never }, 'acme-owner', 'acme')
    const brokenValue = themePickerRows(themes).find(row => row.displayName === 'Broken')?.value
    assert.ok(brokenValue !== undefined)
    const h = setup({ columns: 140, rows: 40, doc: { theme: 'dark' }, themes })
    await openSelectedRow(h, 'theme')
    // Choose `auto` first: its query is now pending and owns the guard.
    await key(h, '\r')
    await key(h, '\x1b[A') // dark -> auto
    await key(h, '\r')
    await settle(h)
    assert.equal(h.doc.theme, 'auto', 'the auto preference committed and its query is in flight')

    // Now confirm the BROKEN palette: the apply fails, the Host is never written...
    await key(h, '\r')
    const broken = rowOf(h, 'Broken')
    press(h, broken, cellIndexOf(h, broken, 'Broken'))
    release(h, broken, cellIndexOf(h, broken, 'Broken'))
    await settle(h)
    const confirm = rowOf(h, 'Confirm')
    press(h, confirm, cellIndexOf(h, confirm, 'Confirm'))
    release(h, confirm, cellIndexOf(h, confirm, 'Confirm'))
    await settle(h)
    assert.match(h.view(), /Not saved · the palette could not be applied/)
    assert.equal(h.doc.theme, 'auto', 'and the stored preference is untouched')
    assert.equal(h.app.currentTheme(), 'dark', 'the runtime kept the previous palette')
    // The unload fallback fires only while the unloaded value is STILL the recorded
    // active theme (extension-runtime.ts's own condition): a palette that was never
    // applied must not become that owner, or its later unload would force dark and
    // stop the terminal tracking over the stored `auto`.
    const wouldForceDarkFallback = (selectable: string): boolean => h.app.activePluginTheme() === selectable
    assert.equal(wouldForceDarkFallback(brokenValue), false,
      'a never-applied palette must not become the unload-fallback owner')

    // ...so the pending auto query still owns the surface and its answer applies.
    h.vt.sendInput(lightReply)
    await settle(h)
    assert.equal(h.app.currentTheme(), 'light', 'the failed candidate must not have cancelled the auto intent')
    h.dispose()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('B-21 a candidate taller than the list viewport reveals its HEAD, never a marker-less tail', async () => {
  const label = `汉${'字'.repeat(30)}`
  const themes = new ThemeRegistry()
  themes.register({ id: 'tall-cjk', name: label, palette: darkColors }, 'acme-owner', 'acme')
  const value = themePickerRows(themes).find(row => row.displayName === label)?.value
  assert.ok(value !== undefined)
  // 44x8 grants ONE candidate row: the friendly label is taller than the viewport.
  const h = setup({ columns: 44, rows: 8, doc: { theme: 'dark' }, themes })
  await openSelectedRow(h, 'theme')
  await key(h, '\r')
  await key(h, '\x1b[B') // dark -> light
  await key(h, '\x1b[B') // light -> the tall candidate
  const frame = h.rowsPlain().join('\n')
  assert.match(frame, /> plugin:acme\/tall-cjk/, `the highlighted candidate must show its source-qualified identity before the friendly label tail:\n${frame}`)
  for (const [index, line] of h.vt.getViewport().entries()) {
    assert.ok(visibleWidth(line) <= 44, `row ${index} must stay inside the pane width`)
  }
  // The identity really is the tall candidate, and it can be confirmed knowingly.
  await key(h, '\r')
  await settle(h)
  assert.equal(h.doc.theme, value, 'the tall candidate really committed')
  assert.ok(!h.view().includes('Retry save'), 'and the commit is not reported as failed')
  // The granted 44x8 viewport cannot carry the Status line: widen it and read it.
  h.vt.resize(60, 24)
  await h.vt.waitForRender()
  assert.match(h.view(), /Status\s+Verified/)
  h.dispose()
})

test('B-22 a PENDING theme commit already shows the runtime fact it applied', async () => {
  const themes = pluginThemes()
  // A COMPLETE palette so the applied plugin theme is renderable, like a real one.
  themes.register({ id: 'full-palette', name: 'FullPalette', palette: darkColors }, 'acme-owner', 'acme')
  const h = setup({
    columns: 140,
    rows: 40,
    doc: { theme: 'dark' },
    themes,
    // The runtime apply happens before the first await; only the write is slow.
    applyReplace: (next) => new Promise<void>(resolve => {
      setTimeout(() => { Object.assign(h.doc, next); resolve() }, 250)
    }),
  })
  await openSelectedRow(h, 'theme')
  await key(h, '\r')
  const row = rowOf(h, 'FullPalette')
  press(h, row, cellIndexOf(h, row, 'FullPalette'))
  release(h, row, cellIndexOf(h, row, 'FullPalette'))
  await settle(h)
  const confirm = rowOf(h, 'Confirm')
  press(h, confirm, cellIndexOf(h, confirm, 'Confirm'))
  release(h, confirm, cellIndexOf(h, confirm, 'Confirm'))
  await settle(h)

  assert.match(h.view(), /Status\s+Saving…/, 'the write is still in flight')
  assert.equal(h.app.currentTheme(), 'custom', 'and the plugin palette is already live')
  assert.match(
    h.view(),
    /Runtime\s+FullPalette/,
    `the pending Detail must already show the applied runtime fact:\n${h.view()}`,
  )
  assert.match(h.view(), /Value\s+dark/, 'while the persisted value is still the previous one')

  await new Promise(resolve => setTimeout(resolve, 320))
  await settle(h)
  assert.match(h.view(), /Status\s+Verified/)
  // The theme row's primary value IS the persisted fact: `Value` + `Source`.
  assert.match(h.view(), /Value\s+FullPalette/)
  assert.match(h.view(), /Source\s+plugin:acme\/full-palette/)
  h.dispose()
})

test('B-23 a PENDING display commit already shows the runtime preset', async () => {
  const h = setup({
    columns: 140,
    rows: 40,
    doc: { displayPreset: 'full', theme: 'dark' },
    displayPreset: 'full',
    applyReplace: (next) => new Promise<void>(resolve => {
      setTimeout(() => { Object.assign(h.doc, next); resolve() }, 250)
    }),
  })
  await openSelectedRow(h, 'display-preset')
  await key(h, '\r')
  const row = rowOf(h, 'compact')
  press(h, row, cellIndexOf(h, row, 'compact'))
  release(h, row, cellIndexOf(h, row, 'compact'))
  await settle(h)
  const confirm = rowOf(h, 'Confirm')
  press(h, confirm, cellIndexOf(h, confirm, 'Confirm'))
  release(h, confirm, cellIndexOf(h, confirm, 'Confirm'))
  await settle(h)

  assert.match(h.view(), /Status\s+Saving…/, 'the write is still in flight')
  assert.equal(h.app.displayPreset(), 'compact', 'and the runtime preset already changed')
  assert.match(h.view(), /Value\s+compact/, `the pending row value IS the live runtime preset:\n${h.view()}`)
  assert.match(h.view(), /Persisted\s+full/, 'while the stored preference is still the previous one')

  await new Promise(resolve => setTimeout(resolve, 320))
  await settle(h)
  assert.match(h.view(), /Status\s+Verified/)
  assert.equal(h.doc.displayPreset, 'compact')
  h.dispose()
})

test('B-24 a refused write whose value an external writer already set is neither accepted nor refused', async () => {
  const h = setup({
    columns: 200,
    rows: 40,
    doc: { theme: 'dark' },
    themes: pluginThemes(),
    applyReplace: (next) => {
      // An external writer reached the SAME value before this request was refused; the
      // backend then rejects our write. The authority therefore matches the requested
      // value without this commit having been accepted.
      h.doc.theme = next.theme
      throw new Error('settings namespace "tui-app" changed since it was read')
    },
  })
  await openSelectedRow(h, 'theme')
  await key(h, '\r')
  const row = rowOf(h, 'light')
  press(h, row, cellIndexOf(h, row, 'light'))
  release(h, row, cellIndexOf(h, row, 'light'))
  await settle(h)
  const confirm = rowOf(h, 'Confirm')
  press(h, confirm, cellIndexOf(h, confirm, 'Confirm'))
  release(h, confirm, cellIndexOf(h, confirm, 'Confirm'))
  await settle(h)

  const frame = h.view().replace(/\s+/gu, ' ')
  assert.equal(h.doc.theme, 'light', 'the authority really carries the requested value')
  assert.match(frame, /Outcome unknown/, `the attribution is stated as unknown:\n${h.view()}`)
  assert.doesNotMatch(frame, /Commit accepted/, 'this request was never accepted')
  assert.doesNotMatch(frame, /Not saved · (settings|the)/, 'and it is not presented as a refusal either')
  assert.match(frame, /already reads light/, 'the reachable fact (the authority matches) is reported')
  assert.ok(h.view().includes('Retry save'), 'a retry stays available')
  h.dispose()
})

test('B-25 a contribution unloading under an open choice re-anchors the highlight on the chosen candidate', async () => {
  const themes = new ThemeRegistry()
  themes.register({ id: 'aaa', name: 'Alpha', palette: darkColors }, 'acme-owner', 'acme')
  themes.register({ id: 'zzz', name: 'Zeta', palette: darkColors }, 'acme-owner', 'acme')
  const h = setup({ columns: 140, rows: 40, doc: { theme: 'dark' }, themes })
  await openSelectedRow(h, 'theme')
  await key(h, '\r')
  const zetaRow = rowOf(h, 'Zeta')
  press(h, zetaRow, cellIndexOf(h, zetaRow, 'Zeta'))
  release(h, zetaRow, cellIndexOf(h, zetaRow, 'Zeta'))
  await settle(h)
  assert.ok(h.view().includes('> plugin:acme/zzz (Zeta)'), 'the source-qualified Zeta identity is highlighted')

  // Alpha (which precedes Zeta in the list) unloads: every later candidate re-numbers,
  // and the runtime owner refreshes the open workspace's facts.
  themes.dispose('aaa')
  h.app.clearActivePluginTheme()
  await settle(h)

  const frame = h.view()
  assert.ok(frame.includes('> plugin:acme/zzz (Zeta)'), `the highlight still names the chosen source-qualified candidate:\n${frame}`)
  assert.ok(!frame.includes('Alpha'), 'and the unloaded candidate is gone from the list')
  const confirm = rowOf(h, 'Confirm')
  press(h, confirm, cellIndexOf(h, confirm, 'Confirm'))
  release(h, confirm, cellIndexOf(h, confirm, 'Confirm'))
  await settle(h)
  assert.equal(h.doc.theme, 'plugin:acme/zzz',
    'the CONFIRM dispatches the candidate the user still sees highlighted')
  assert.match(h.view(), /Status\s+Verified/)
  h.dispose()
})

test('B-26 a choice whose candidate source vanished is dropped instead of offering a dead confirm', async () => {
  const themes = new ThemeRegistry()
  const handle = themes.register({ id: 'gone', name: 'Gone', palette: darkColors }, 'acme-owner', 'acme')
  themes.register({ id: 'stay', name: 'Stay', palette: darkColors }, 'acme-owner', 'acme')
  const h = setup({ columns: 140, rows: 40, doc: { theme: 'dark' }, themes })
  await openSelectedRow(h, 'theme')
  await key(h, '\r')
  const goneRow = rowOf(h, 'Gone')
  press(h, goneRow, cellIndexOf(h, goneRow, 'Gone'))
  release(h, goneRow, cellIndexOf(h, goneRow, 'Gone'))
  await settle(h)
  assert.ok(h.view().includes('> plugin:acme/gone (Gone)'))

  handle.dispose()
  h.app.clearActivePluginTheme()
  await settle(h)

  assert.ok(!h.view().includes('Confirm'), `the dead choice is retired:\n${h.view()}`)
  assert.match(h.view(), /Settings · Appearance · Configured theme/, 'and the browse detail is shown again')
  assert.equal(h.replacements(), 0, 'nothing was written for the vanished candidate')
  h.dispose()
})

test('B-27 a rejected write whose field an external writer moved to a THIRD value is attributed as unknown, never as a refusal', async () => {
  // The base this request started from is `dark` and it asks for `light`; before the
  // forced authoritative re-read an external writer lands a THIRD value. Neither the
  // requested value (so not an acceptance) nor the base value (so not a provable
  // refusal) is in the authority: the request's outcome cannot be attributed to it, and
  // a regression that treats every readable mismatch as `Not saved` must fail here.
  const h = setup({
    columns: 200,
    rows: 40,
    doc: { theme: 'dark' },
    themes: pluginThemes(),
    applyReplace: () => {
      h.doc.theme = 'auto'
      throw new Error('settings namespace "tui-app" changed since it was read')
    },
  })
  await openSelectedRow(h, 'theme')
  await key(h, '\r')
  const row = rowOf(h, 'light')
  press(h, row, cellIndexOf(h, row, 'light'))
  release(h, row, cellIndexOf(h, row, 'light'))
  await settle(h)
  const confirm = rowOf(h, 'Confirm')
  press(h, confirm, cellIndexOf(h, confirm, 'Confirm'))
  release(h, confirm, cellIndexOf(h, confirm, 'Confirm'))
  await settle(h)

  const frame = h.view().replace(/\s+/gu, ' ')
  assert.equal(h.doc.theme, 'auto', 'the authority now carries a third value')
  assert.match(frame, /Outcome unknown ·/, `the outcome is not attributed:\n${h.view()}`)
  assert.match(frame, /no longer reads the value/, 'and the reason names the third-value fact')
  assert.match(frame, /request started from either/, 'and the un-attributable outcome')
  assert.doesNotMatch(frame, /Not saved/, 'this is not a provable refusal')
  assert.doesNotMatch(frame, /Commit accepted/, 'and not a claimed acceptance either')
  assert.ok(h.view().includes('Retry save'), 'a retry stays available')
  h.dispose()
})

test('B-28 the leased Settings screen joins the terminal scheme-notification sync in both directions', async () => {
  const h = setup({ columns: 140, rows: 40, doc: { theme: 'dark' } })
  await openSelectedRow(h, 'theme')
  await key(h, '\r')
  const autoRow = rowOf(h, 'auto')
  press(h, autoRow, cellIndexOf(h, autoRow, 'auto'))
  release(h, autoRow, cellIndexOf(h, autoRow, 'auto'))
  await settle(h)
  const beforeAuto = h.writes().length
  const confirm = rowOf(h, 'Confirm')
  press(h, confirm, cellIndexOf(h, confirm, 'Confirm'))
  release(h, confirm, cellIndexOf(h, confirm, 'Confirm'))
  await settle(h)
  // The ACTIVE screen owns the terminal: subscribing on the stopped screens is not
  // enough, or a report would never arrive while the user stays in the workspace.
  assert.ok(
    h.writes().slice(beforeAuto).join('').includes('\x1b[?2031h'),
    `the leased screen subscribes to scheme reports:\n${JSON.stringify(h.writes().slice(beforeAuto))}`,
  )

  // The symmetric direction: a manual theme chosen inside the workspace must release
  // the subscription on the screen that owns the terminal.
  await key(h, '\r')
  const choiceHeading = rowOf(h, 'Choose value')
  const darkRow = h.rowsPlain().findIndex((line, index) => index > choiceHeading && line.includes('dark'))
  assert.ok(darkRow >= 0, `the dark candidate is painted below the chooser heading:\n${h.view()}`)
  press(h, darkRow, cellIndexOf(h, darkRow, 'dark'))
  release(h, darkRow, cellIndexOf(h, darkRow, 'dark'))
  await settle(h)
  const beforeManual = h.writes().length
  const confirmManual = rowOf(h, 'Confirm')
  press(h, confirmManual, cellIndexOf(h, confirmManual, 'Confirm'))
  release(h, confirmManual, cellIndexOf(h, confirmManual, 'Confirm'))
  await settle(h)
  assert.ok(
    h.writes().slice(beforeManual).join('').includes('\x1b[?2031l'),
    `and releases it when the choice leaves auto:\n${JSON.stringify(h.writes().slice(beforeManual))}`,
  )
  h.dispose()
})

test('B-29 leaving the workspace right after choosing auto re-samples on the restored screen', async () => {
  const saved = {
    NO_COLOR: process.env.NO_COLOR,
    FORCE_COLOR: process.env.FORCE_COLOR,
    CI: process.env.CI,
    COLORFGBG: process.env.COLORFGBG,
  }
  process.env.NO_COLOR = ''
  process.env.FORCE_COLOR = ''
  process.env.CI = ''
  delete process.env.COLORFGBG
  try {
    const h = setup({ columns: 140, rows: 40, doc: { theme: 'dark' } })
    await openSelectedRow(h, 'theme')
    await key(h, '\r')
    await key(h, '\x1b[A') // dark -> auto
    const confirm = rowOf(h, 'Confirm')
    press(h, confirm, cellIndexOf(h, confirm, 'Confirm'))
    release(h, confirm, cellIndexOf(h, confirm, 'Confirm'))
    await settle(h)
    // Leave IMMEDIATELY: the observation was issued for the workspace screen, and its
    // stop() releases the probe, so that answer can never be trusted.
    await key(h, '\x1b')
    await key(h, '\x1b')
    await key(h, '\x1b')
    await settle(h)
    assert.ok(!h.view().includes('Settings · '), 'the workspace really closed')
    assert.equal(h.app.currentTheme(), 'dark', 'the abandoned observation applied nothing')

    // The restored screen re-sampled: answering THAT observation must reach the palette.
    h.vt.sendInput('\x1b]11;rgb:ffff/ffff/ffff\x1b\\')
    await settle(h)
    assert.equal(h.app.currentTheme(), 'light', 'the initial detection is not lost across the hand-off')
    h.dispose()
  } finally {
    if (saved.NO_COLOR === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = saved.NO_COLOR
    if (saved.FORCE_COLOR === undefined) delete process.env.FORCE_COLOR
    else process.env.FORCE_COLOR = saved.FORCE_COLOR
    if (saved.CI === undefined) delete process.env.CI
    else process.env.CI = saved.CI
    if (saved.COLORFGBG === undefined) delete process.env.COLORFGBG
    else process.env.COLORFGBG = saved.COLORFGBG
  }
})

/** A theme registry whose names are long enough that the pane width decides how many
 *  LINES each candidate takes. */
function longNamedThemes(count: number): ThemeRegistry {
  const themes = new ThemeRegistry()
  for (let index = 0; index < count; index += 1) {
    themes.register(
      { id: `long${index}`, name: `L${index}-${'W'.repeat(58)}`, palette: darkColors },
      'acme-owner',
      'acme',
    )
  }
  return themes
}

test('B-30 a narrower pane that re-flows the wrapped candidates keeps the confirmed candidate visible', async () => {
  const themes = longNamedThemes(10)
  const h = setup({ columns: 200, rows: 14, doc: { theme: 'dark' }, themes })
  themes.dispose('long0') // the builtin rows still precede the plugins; keep the walk short
  await openSelectedRow(h, 'theme')
  await key(h, '\r')
  for (let index = 0; index < 10; index += 1) await key(h, '\x1b[B')
  await settle(h)
  assert.ok(h.view().includes('> plugin:acme/long9'), `the last candidate is highlighted at 200 columns:\n${h.view()}`)

  // The SAME three-pane layout with a much narrower Detail pane: the candidates wrap
  // into more lines, so the highlight's start row moves even though its INDEX does not.
  h.vt.resize(108, 14)
  await settle(h)
  assert.ok(h.view().includes('> plugin:acme/long9'), `the highlight survives the re-flow:\n${h.view()}`)
  h.dispose()
})

test('B-31 the same re-flow inside the two-pane layout keeps the confirmed candidate visible', async () => {
  const themes = longNamedThemes(10)
  const h = setup({ columns: 107, rows: 14, doc: { theme: 'dark' }, themes })
  themes.dispose('long0')
  await openSelectedRow(h, 'theme')
  await key(h, '\r')
  for (let index = 0; index < 10; index += 1) await key(h, '\x1b[B')
  await settle(h)
  assert.ok(h.view().includes('> plugin:acme/long9'), `the last candidate is highlighted at 107 columns:\n${h.view()}`)

  h.vt.resize(76, 14)
  await settle(h)
  assert.ok(h.view().includes('> plugin:acme/long9'), `the highlight survives the two-pane re-flow:\n${h.view()}`)
  h.dispose()
})

test('B-32 re-entering the choice reveals the highlighted candidate again', async () => {
  const themes = longNamedThemes(10)
  const h = setup({ columns: 108, rows: 14, doc: { theme: 'dark' }, themes })
  themes.dispose('long0')
  await openSelectedRow(h, 'theme')
  await key(h, '\r')
  for (let index = 0; index < 10; index += 1) await key(h, '\x1b[B')
  const confirm = rowOf(h, 'Confirm')
  press(h, confirm, cellIndexOf(h, confirm, 'Confirm'))
  release(h, confirm, cellIndexOf(h, confirm, 'Confirm'))
  await settle(h)
  assert.equal(h.doc.theme, 'plugin:acme/long9', 'the last candidate really committed')

  // Re-enter the choice at UNCHANGED dimensions: the candidate is the committed value
  // (below the fold), and the previous layout sentinels must not suppress the reveal.
  await key(h, '\r')
  await settle(h)
  assert.ok(h.view().includes('> '), `the choice paints its highlight:\n${h.view()}`)
  assert.ok(h.view().includes('> plugin:acme/long9'), `and it is the visible highlighted candidate:\n${h.view()}`)
  h.dispose()
})

test('B-32b Enter first reveals an offscreen selected identity and only a later Enter confirms', async () => {
  const themes = longNamedThemes(10)
  const h = setup({ columns: 108, rows: 14, doc: { theme: 'dark' }, themes })
  await openSelectedRow(h, 'theme')
  await key(h, '\x1b[C') // Right opens the choice
  await key(h, '\x1b[B') // dark -> light
  const lightRow = rowOf(h, '> light')
  const lightCol = cellIndexOf(h, lightRow, '> light')
  for (let index = 0; index < 3; index += 1) {
    wheel(h, lightRow, lightCol, true)
    await settle(h)
  }
  assert.ok(!h.view().includes('> light'), `the selected candidate head has scrolled out of view:\n${h.view()}`)
  assert.ok(!h.rowsPlain().at(-1)!.includes('Enter confirm'), 'the invisible identity cannot advertise keyboard confirmation')

  await key(h, '\r')
  assert.equal(h.replacements(), 0, 'the first Enter is reveal-only')
  assert.ok(h.view().includes('> light'), 'the selected identity is revealed on the new painted frame')
  assert.ok(h.rowsPlain().at(-1)!.includes('Enter confirm'), 'the current frame now advertises the explicit action')
  await key(h, '\r')
  await settle(h)
  assert.equal(h.doc.theme, 'light', 'the next Enter confirms the visible candidate')
  assert.equal(h.replacements(), 1, 'only the second Enter dispatches one write')
  h.dispose()
})


/** Neutralize the environment gates so a detection really queries the terminal. */
function clearThemeEnv(): void {
  process.env.NO_COLOR = ''
  process.env.FORCE_COLOR = ''
  process.env.CI = ''
  delete process.env.COLORFGBG
}

function restoreThemeEnv(): void {
  for (const key of ['NO_COLOR', 'FORCE_COLOR', 'CI'] as const) {
    if (themeEnvSaved[key] === undefined) delete process.env[key]
    else process.env[key] = themeEnvSaved[key]
  }
  if (themeEnvSaved.COLORFGBG === undefined) delete process.env.COLORFGBG
  else process.env.COLORFGBG = themeEnvSaved.COLORFGBG
}

const themeEnvSaved = {
  NO_COLOR: process.env.NO_COLOR,
  FORCE_COLOR: process.env.FORCE_COLOR,
  CI: process.env.CI,
  COLORFGBG: process.env.COLORFGBG,
}

const TERMINAL_QUERY = '\x1b]11;?\x07'
const queryCount = (writes: readonly string[]): number => writes.join('').split(TERMINAL_QUERY).length - 1

/** Model a boot-shaped observation already in flight for the CURRENT screen. */
const startPendingObservation = (h: Harness): Promise<void> => {
  h.app.noteThemeSelection('auto')
  const pending = h.app.autoDetectTheme({ shouldApply: () => h.app.themeFollowsTerminal() })
  assert.equal(queryCount(h.writes()), 1, 'the observation is issued for the screen that owns the terminal')
  return pending
}

test('B-33 entering Transcript Fullscreen re-samples the observation the main screen lost', async () => {
  clearThemeEnv()
  try {
    const h = setup({ columns: 140, rows: 40, doc: { theme: 'dark' } })
    const pending = startPendingObservation(h)
    h.app.setFullscreen(true)
    await pending
    await settle(h)
    assert.ok(queryCount(h.writes()) > 1, `the entering fullscreen screen issues a FRESH observation:\n${JSON.stringify(h.writes())}`)
    h.vt.sendInput('\x1b]11;rgb:ffff/ffff/ffff\x1b\\')
    await settle(h)
    assert.equal(h.app.currentTheme(), 'light', 'and the screen that took the terminal over applies its answer')
    h.dispose()
  } finally {
    restoreThemeEnv()
  }
})

test('B-34 entering the Settings workspace re-samples the observation the return screen lost', async () => {
  clearThemeEnv()
  try {
    const h = setup({ columns: 140, rows: 40, doc: { theme: 'dark' } })
    const pending = startPendingObservation(h)
    await h.open()
    await pending
    await settle(h)
    assert.ok(queryCount(h.writes()) > 1, `the entering workspace screen issues a FRESH observation:\n${JSON.stringify(h.writes())}`)
    h.vt.sendInput('\x1b]11;rgb:ffff/ffff/ffff\x1b\\')
    await settle(h)
    assert.equal(h.app.currentTheme(), 'light', 'and the workspace screen applies its answer')
    assert.match(h.view().replace(/\s+/gu, ' '), /Runtime light/, 'the Detail names the runtime fact it applied')
    h.dispose()
  } finally {
    restoreThemeEnv()
  }
})

test('B-35 a handled hand-off leaves no stale re-sample latch for the next one', async () => {
  clearThemeEnv()
  try {
    const h = setup({ columns: 140, rows: 40, doc: { theme: 'dark' } })
    const pending = startPendingObservation(h)
    h.app.setFullscreen(true)
    await pending
    await settle(h)
    const afterFirstHandoff = queryCount(h.writes())
    assert.ok(afterFirstHandoff > 1, 'the first hand-off re-sampled the abandoned observation')
    h.vt.sendInput('\x1b]11;rgb:ffff/ffff/ffff\x1b\\')
    await settle(h)
    assert.equal(h.app.currentTheme(), 'light', 'and applied its answer')

    // Nothing was in flight any more: the NEXT hand-off must not query again. A late
    // continuation re-arming the latch would issue an extra observation here.
    h.app.setFullscreen(false)
    await settle(h)
    assert.equal(queryCount(h.writes()), afterFirstHandoff, 'no stale latch fires an extra query')
    h.dispose()
  } finally {
    restoreThemeEnv()
  }
})

// ── B-16 / B-17: the narrow-width colour contracts the review asked for ─────

test('B-16 a status WORD that WRAPS keeps its semantic tone on every character (22 columns)', async () => {
  // At 22 columns the narrow pane's label column is 8 and the value area 14, so
  // `Outcome unknown` (15 cells) really wraps. The tone must follow the WORD,
  // not the first wrapped line.
  const h = setup({
    columns: 22,
    rows: 40,
    doc: { theme: 'dark' },
    themes: pluginThemes(),
    applyReplace: () => {
      h.doc.theme = 'auto'
      throw new Error('settings namespace "tui-app" changed since it was read')
    },
  })
  await openSelectedRow(h, 'theme')
  await key(h, '\r')
  const candidate = rowOf(h, 'light')
  press(h, candidate, cellIndexOf(h, candidate, 'light'))
  release(h, candidate, cellIndexOf(h, candidate, 'light'))
  await settle(h)
  const confirm = rowOf(h, 'Confirm')
  press(h, confirm, cellIndexOf(h, confirm, 'Confirm'))
  release(h, confirm, cellIndexOf(h, confirm, 'Confirm'))
  await settle(h)

  const rows = h.rowsPlain()
  const first = rows.findIndex(line => line.includes('Outcome'))
  assert.ok(first >= 0, `the wrapped status word must be painted:\n${h.view()}`)
  const second = rows.findIndex((line, index) => index > first && line.trimStart().startsWith('unknown'))
  assert.ok(second >= 0, `\`Outcome unknown\` must wrap at 22 columns:\n${h.view()}`)
  const tone = hexToRgb(currentPalette.warning)
  const firstCol = visibleWidth(rows[first]!.slice(0, rows[first]!.indexOf('Outcome')))
  for (const [index, character] of [...'Outcome'].entries()) {
    assert.equal(h.vt.getCellFgRgb(first, firstCol + index), tone,
      `the first line's \`${character}\` keeps the warning tone`)
  }
  const secondCol = visibleWidth(rows[second]!.slice(0, rows[second]!.indexOf('unknown')))
  for (const [index, character] of [...'unknown'].entries()) {
    assert.equal(h.vt.getCellFgRgb(second, secondCol + index), tone,
      `the CONTINUATION line's \`${character}\` keeps the warning tone`)
  }
  assert.equal(h.vt.getCellFgRgb(second, secondCol + 'unknown'.length), hexToRgb(currentPalette.textDim),
    'the explanation right after the word stays dim')
  h.dispose()
})

test('B-17 the diagnostic line keeps its field name muted and tones only the status word', async () => {
  for (const [readiness, tone] of [['stale', 'warning'], ['unavailable', 'error']] as const) {
    const h = setup({ columns: 100, rows: 40, readiness })
    await h.open()
    const row = rowOf(h, 'Config')
    assert.equal(h.vt.getCellFgRgb(row, cellIndexOf(h, row, 'Config')), hexToRgb(currentPalette.textMuted),
      `the field name stays muted on a ${readiness} backend`)
    assert.equal(h.vt.getCellFgRgb(row, cellIndexOf(h, row, readiness === 'stale' ? 'Stale' : 'Unavailable')),
      hexToRgb(currentPalette[tone]), `only the status word takes the ${tone} tone`)
    h.dispose()
  }
})

// ── A-16: the frozen §11.2 degradation-ladder matrix (rollout PR4) ──────────
//
// §11.3.2's "a `Status` value of `Verified` and of `Not saved` do not paint the
// same token" is ALREADY covered by B-02 (it pins the `Verified` word to the
// `success` token) and B-03 (it pins `Not saved` to the `error` token) in this
// file, so it is deliberately NOT duplicated here.
//
// A-05/A-05b already pin the short-screen rules/notice boundaries (5/6/8 rows);
// this case walks the frozen §11.2 matrix instead and asserts, per size, the
// chrome the §8 ladder keeps.

interface SettingsLadder {
  readonly layout: 'wide' | 'medium' | 'narrow'
  readonly headerRows: number
  readonly metaRows: number
  readonly ruleRows: number
  readonly noticeRows: number
  readonly paneHeaderRows: number
  readonly contentRows: number
}

/**
 * The §8 ladder over the panel's own documented grants
 * (`settings-workspace-panel.ts`: the exported `76` medium minimum, the `108`
 * wide minimum, the notice `base - 1 >= 2` floor, the diagnostic
 * `base - 1 >= 3` floor, one top rule while the body grant keeps >= 5 rows, and
 * a pane header reserved INSIDE that body grant).
 */
function settingsLadder(width: number, rows: number, noticeLive: boolean): SettingsLadder {
  const safeRows = Math.max(1, Math.floor(rows))
  const layout = width >= 108 ? 'wide' : width >= 76 ? 'medium' : 'narrow'
  const headerRows = safeRows >= 2 ? 1 : 0
  const base = Math.max(0, safeRows - headerRows - 1)
  const noticeRows = safeRows >= 6 && noticeLive && base - 1 >= 2 ? 1 : 0
  const metaRows = safeRows >= 8 && base - noticeRows - 1 >= 3 ? 1 : 0
  const bodyWithoutRules = base - noticeRows - metaRows
  const ruleRows = bodyWithoutRules >= 5 ? 1 : 0
  const bodyRows = bodyWithoutRules - ruleRows
  const paneHeaderRows = layout !== 'narrow' && bodyRows >= 2 ? 1 : 0
  return {
    layout,
    headerRows,
    metaRows,
    ruleRows,
    noticeRows,
    paneHeaderRows,
    contentRows: bodyRows - paneHeaderRows,
  }
}

/** The frozen §11.2 matrix. */
const SETTINGS_MATRIX = [[200, 50], [120, 40], [100, 40], [80, 24], [80, 10], [72, 24], [44, 20]] as const

const paintedFrame = (h: Harness): PaintedFrame => ({
  rows: h.rowsPlain(),
  readColor: (row, col) => h.vt.getCellFgRgb(row, col),
  primaryRgb: hexToRgb(currentPalette.primary),
})

test('A-16 the frozen §11.2 matrix keeps the §8 ladder-derived chrome at every size', async () => {
  for (const [columns, rows] of SETTINGS_MATRIX) {
    for (const noticeLive of [false, true]) {
      const h = setup({ columns, rows, doc: { theme: 'dark' } })
      await h.open()
      if (noticeLive) {
        h.app.notify('governance notice', 'info')
        await h.vt.waitForRender()
      }
      const ladder = settingsLadder(columns, rows, noticeLive)
      const painted = h.rowsPlain()
      assert.equal(painted.length, rows, `the frame must paint exactly ${rows} rows at ${columns}x${rows}`)
      const frame = paintedFrame(h)

      // §8 invariants 1 + 2 (shared helper): the bar is the physical last row and
      // a real body row is reserved from 3 rows up. The Settings body always paints
      // its selection cursor `> <item>` (settings-workspace-panel.ts:813-820), so a
      // regression that blanks the body while leaving the chrome in place fails.
      const categoryBar = columns < 60
        ? 'Right open · Enter open · Esc close'
        : columns < 76
          ? 'Up/Down select · Right open · Enter open · Esc close'
          : 'Up/Down select · Right open · Enter open · Tab panes · Esc close'
      assertBarIsLastRow(painted, frame.readColor, categoryBar)
      const bodyTop = ladder.headerRows + ladder.metaRows + ladder.ruleRows + ladder.noticeRows
      const contentTop = bodyTop + ladder.paneHeaderRows
      const bodyIndexes = Array.from({ length: ladder.contentRows }, (_, index) => contentTop + index)
      assertBodyFloor(painted, bodyIndexes, line => /^> \S/.test(line), `Settings ${columns}x${rows}`)
      assertNoHalfSegmentInBar(painted, painted.length - 1, ' · ')
      assertRowWidths(h, columns)

      // §11.3.2/§4.5: exactly ONE chrome active device, and it is the focused pane
      // label. Wide/medium put the shared pane header on the body's first row, so
      // the focused `[Categories (8)]` is the ONE primary label. The narrow
      // projection paints NO pane header at all: the plain list cursor is not a
      // chrome active device, so the returned device list is EMPTY there.
      const device = assertOneActiveDevice(frame, {
        rows: [bodyTop],
        labelPrefixes: ['[Categories', '[Rows', '[Details'],
      })
      assert.deepEqual(device, ladder.paneHeaderRows === 1 ? ['[Categories'] : [],
        `the focused pane device at ${columns}x${rows} (${ladder.layout}):\n${h.view()}`)

      // §8 step 2: the ONE top rule exists exactly while the body grant keeps
      // >= 5 rows without it.
      assert.equal(painted.filter(line => /^─+$/.test(line)).length, ladder.ruleRows,
        `the decorative rules at ${columns}x${rows}:\n${h.view()}`)

      // §8 step 3: the diagnostic line drops when granting it would leave < 3 body rows.
      assert.equal(painted.some(line => line.includes('Scope:')), ladder.metaRows === 1,
        `the diagnostic line at ${columns}x${rows}:\n${h.view()}`)

      // §8 step 4: the notice drops when granting it would leave < 2 body rows.
      assert.equal(painted.some(line => line.includes('governance notice')), ladder.noticeRows === 1,
        `the notice row at ${columns}x${rows}:\n${h.view()}`)

      // Pane projection: >= 108 three panes, >= 76 two, below one — and each
      // projection paints only its OWN panes.
      const hasCategories = painted.some(line => line.includes('Categories ('))
      const hasRows = painted.some(line => line.includes('Rows ('))
      const hasDetails = painted.some(line => line.includes('Details'))
      if (ladder.layout === 'wide') {
        assert.ok(hasCategories && hasRows && hasDetails, `wide (>=108) paints three panes:\n${h.view()}`)
      } else if (ladder.layout === 'medium') {
        assert.ok(hasCategories && hasRows, `medium (76..107) paints categories + rows:\n${h.view()}`)
        assert.ok(!hasDetails, `medium L0 does not paint the Detail pane:\n${h.view()}`)
      } else {
        assert.ok(!hasCategories && !hasRows && !hasDetails, `narrow (<76) paints no pane header:\n${h.view()}`)
        assert.ok(painted.some(line => line.startsWith('> Appearance')), `the narrow level's list is painted:\n${h.view()}`)
      }
      h.dispose()
    }
  }
})

// ── PR2: the embedded Plugin Manager inside the ONE Settings chrome ───────

/** Move the L0 selection from Appearance to Plugins (three categories down). */
const toPlugins = async (h: Harness): Promise<void> => {
  await key(h, '\x1b[B')
  await key(h, '\x1b[B')
  await key(h, '\x1b[B')
}

test('selecting Plugins previews the live plugin list inside ONE Settings chrome', async () => {
  for (const [columns, rows, dual] of [[120, 40, true], [80, 24, false]] as const) {
    const h = setup({ columns, rows, pluginPage: true })
    await h.open()
    await toPlugins(h)
    assert.equal(h.pluginPages(), 1, 'selecting the category mounts the ONE page')
    const frame = h.rowsPlain()
    // ONE shared pane header: the rail label plus the plugin column labels.
    // header0 / metadata1 / rule2 / pane header3 at both widths.
    assert.match(frame[3]!, /^\[Categories \(8\)\]/, `the rail label owns the header:\n${h.view()}`)
    assert.equal(cellIndexOf(h, 3, 'Plugins'), 24, `the plugin label starts the content column:\n${h.view()}`)
    if (dual) {
      assert.ok(frame[3]!.includes('Details'), `the >=120 preview also paints the Details column:\n${h.view()}`)
    } else {
      assert.doesNotMatch(frame[3]!, /Details/, 'the 76..119 rail projection paints no Details column')
    }
    // The real list preview starts at cell 24 while the keyboard stays on the rail.
    const bodyRow = rowOf(h, dual ? 'PLUGIN PAGE LIST' : 'PLUGIN PAGE')
    assert.equal(cellIndexOf(h, bodyRow, dual ? 'PLUGIN PAGE LIST' : 'PLUGIN PAGE'), 24, 'the preview starts at cell 24')
    if (dual) {
      // The dual column split the page really painted drives the shared header.
      const split = h.pluginPageInstances()[0]!.contentLayout()
      assert.equal(split.dual, true)
      assert.equal(split.leftWidth, 39, '42% of the 94-cell pair, clamped')
      assert.equal(split.rightWidth, 55)
      assert.equal(cellIndexOf(h, bodyRow, 'PLUGIN DETAIL'), 24 + 39 + 2, 'the Details column starts after the gutter')
      assert.equal(cellIndexOf(h, 3, 'Details'), 24 + 39 + 2, 'the shared header label sits on the same column')
    }
    assert.match(frame[3]!, /\[Categories \(8\)\]/, 'the rail keeps the ONE active device')
    assert.doesNotMatch(frame[3]!, /\[Plugins\]/, 'an unfocused preview is never the active device')
    assertBarIsLastRow(frame, (row, col) => h.vt.getCellFgRgb(row, col), 'Esc close')
    assert.match(frame[frame.length - 1]!, /Tab focus/, 'the rail advertises the real Tab focus key')
    h.dispose()
  }
})

test('80×10 keeps the visible plugin preview and Enter moves the keys without a second page', async () => {
  const h = setup({ columns: 80, rows: 10, pluginPage: true })
  await h.open()
  await toPlugins(h)
  assert.equal(h.pluginPages(), 1, 'the visible preview built the ONE page')
  assert.match(h.view(), /PLUGIN PAGE/, 'the short screen still paints the list preview')
  assertBarIsLastRow(h.rowsPlain(), (row, col) => h.vt.getCellFgRgb(row, col), 'Esc close')
  await key(h, '\r')
  assert.equal(h.pluginPages(), 1, 'Enter only moves the focus: no second page')
  // The plugin content now owns the keys, so ITS semantic bar is the last row.
  assertBarIsLastRow(h.rowsPlain(), (row, col) => h.vt.getCellFgRgb(row, col), 'PLUGIN BAR')
  h.dispose()
})

test('44×20 keeps the single category list until Enter, then mounts the page once', async () => {
  const h = setup({ columns: 44, rows: 20, pluginPage: true })
  await h.open()
  await toPlugins(h)
  assert.doesNotMatch(h.view(), /PLUGIN PAGE/, 'no invisible plugin page is painted')
  assert.equal(h.pluginPages(), 0, 'a narrow rail selection alone never mounts the page')
  assert.match(h.view(), /> Plugins/, 'Plugins stays selected in the single column')
  assertBarIsLastRow(h.rowsPlain(), (row, col) => h.vt.getCellFgRgb(row, col), 'Esc close')
  await key(h, '\r')
  assert.equal(h.pluginPages(), 1, 'Enter mounts the page once from the narrow list')
  assert.match(h.view(), /PLUGIN PAGE/)
  assert.equal(h.pluginPageInstances()[0]!.viewports.at(-1)?.width, 44, 'the narrow content owns the full width')
  h.dispose()
})

test('below the body floor no content is painted and every input is fail-closed', async () => {
  const h = setup({ columns: 120, rows: 40, pluginPage: true })
  await h.open()
  await toPlugins(h)
  // 2 terminal rows leave the header and the pinned bar but ZERO body rows.
  h.vt.resize(120, 2)
  await h.vt.waitForRender()
  const short = h.rowsPlain()
  assert.equal(short.length, 2, `the short frame keeps only the mandatory chrome:\n${h.view()}`)
  assert.doesNotMatch(short.join('\n'), /PLUGIN PAGE/, 'no invisible content may be painted')
  // Neither key nor a stale click coordinate can dispatch what the frame no
  // longer paints: the body floor refuses both, and no page is rebuilt.
  await key(h, '\r')
  await key(h, '\x1b[C')
  await h.vt.waitForRender()
  assert.equal(h.pluginPages(), 1, 'the earlier visible page is the ONLY page')
  h.dispose()
})

// ── Phase 3C / C2-A: the About home and the true two-pane navigation ───────
//
// The workspace opens on its About home; the category rail selects and the
// right column shows the selected page at once; Enter/Right hands the keyboard
// to that page. The cases below read the PHYSICALLY painted frame.

/** The first row of each of the five whale variants. The variant is picked
 *  once per open, so the frame carries exactly one of them. */
const WHALE_FIRST_LINES = [
  '        o',
  '       z Z',
  '                   *',
  '       <3',
  '          \\   /',
] as const

test('the About page is the default Settings home: the whale, both versions and the selected rail entry', async () => {
  const h = setup({ columns: 120, rows: 40 })
  await h.openHome()
  const rows = h.rowsPlain()
  assert.match(rows[0]!, /Settings · Categories/, 'the category rail owns the keyboard on the first frame')
  assert.match(h.view(), /^> About/mu, 'About is the selected category')
  assert.ok(
    WHALE_FIRST_LINES.some(line => h.view().includes(line)),
    `the About page paints the shared whale:\n${h.view()}`,
  )
  assert.match(h.view(), /dsh-pi-tui/, 'the About page names the bundle')
  assert.match(h.view(), /TUI\s+\d+\.\d+\.\d+/u, 'the About page states the TUI version')
  assert.match(h.view(), /DSH\s+(?:Unknown|\d+\.\d+\.\d+)/u, 'the About page states the DSH version')
  assert.equal(h.replacements(), 0, 'the About home never writes a config document')
  assert.equal(h.reads(), 1, 'the About home reads the settings document exactly once')
  h.dispose()
})

test('/status is a real /settings alias: it opens the same sessionless About home and reads once', async () => {
  const h = setup({ columns: 120, rows: 40 })
  h.invoke('status')
  await h.vt.waitForRender()
  const rows = h.rowsPlain()
  assert.match(rows[0]!, /Settings · Categories/, 'the alias paints the same workspace chrome')
  assert.match(h.view(), /^> About/mu, 'the alias lands on the same About rail entry')
  assert.ok(
    WHALE_FIRST_LINES.some(line => h.view().includes(line)),
    `the alias paints the same About home:\n${h.view()}`,
  )
  assert.match(h.view(), /TUI\s+\d+\.\d+\.\d+/u)
  assert.match(h.view(), /DSH\s+(?:Unknown|\d+\.\d+\.\d+)/u)
  assert.equal(h.replacements(), 0, 'the alias never writes configuration')
  assert.equal(h.reads(), 1, 'the alias performs the same ONE settings-document read')
  h.dispose()
})

test('a narrow terminal opens on the About content: Esc returns to the categories, Esc closes the workspace', async () => {
  const h = setup({ columns: 44, rows: 20 })
  await h.openHome()
  assert.match(h.rowsPlain()[0]!, /Settings · About/, 'the About content owns the narrow first frame')
  assert.match(h.view(), /dsh-pi-tui/)
  assert.doesNotMatch(h.view(), /Settings · Categories/, 'the narrow first frame is NOT the empty L0 list')
  await key(h, '\u001b')
  assert.match(h.rowsPlain()[0]!, /Settings · Categories/, 'Esc returns to the category rail')
  assert.match(h.view(), /^> About/mu, 'the rail keeps the selected category')
  await key(h, '\u001b')
  assert.doesNotMatch(h.view(), /Settings · /, 'the second Esc closes the workspace')
  h.dispose()
})

test('the direct pages paint exactly the category rail and the content column', async () => {
  for (const [columns, rows] of [[200, 50], [120, 40], [100, 40], [80, 24]] as const) {
    const h = setup({ columns, rows })
    await h.openHome()
    const painted = h.rowsPlain()
    assert.ok(painted.some(line => /^> About/mu.test(line)), `the rail is painted at ${columns}x${rows}:\n${h.view()}`)
    assert.ok(!h.view().includes('Rows ('), `the direct layout paints NO Rows pane at ${columns}x${rows}:\n${h.view()}`)
    assert.ok(!h.view().includes('Details'), `the direct layout paints NO Details pane at ${columns}x${rows}:\n${h.view()}`)
    // The single physical action bar is the last row and states the rail's
    // keys. It spans the WHOLE frame from X=0 (the legacy bar's position), so
    // the 80-column frame no longer squeezes its segments.
    assertBarIsLastRow(
      painted,
      (row, col) => h.vt.getCellFgRgb(row, col),
      'Up/Down navigate · Enter/Right focus · Tab focus · Esc close',
    )
    h.dispose()
  }
})

test('a short wide terminal scrolls the category rail to the last category and hits the painted id', async () => {
  const h = setup({ columns: 80, rows: 8 })
  await h.openHome()
  assert.ok(!h.view().includes('Other settings'), `the last category is not painted yet:\n${h.view()}`)
  // The rail is the only selection owner: End reaches its last entry.
  await key(h, '\u001b[F')
  assert.match(h.view(), /^> Other settings/mu, `End reaches the last category:\n${h.view()}`)
  // The painted entry is the hit target: a click on it selects that category.
  const lastRow = rowOf(h, 'Other settings')
  press(h, lastRow, cellIndexOf(h, lastRow, 'Other settings'))
  release(h, lastRow, cellIndexOf(h, lastRow, 'Other settings'))
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /Settings · Categories/, 'the rail click keeps the keyboard on the rail')
  assert.match(h.view(), /^> Other settings/mu, 'the click hit the painted category id')
  h.dispose()
})

test('the About content scrolls its own facts and never truncates a version value', async () => {
  const h = setup({ columns: 44, rows: 9 })
  await h.openHome()
  const before = h.view()
  assert.match(before, /TUI\s+\d+\.\d+\.\d+/u, 'the first frame shows the TUI version')
  await key(h, '\u001b[B')
  const after = h.view()
  assert.match(after, /DSH\s+(?:Unknown|\d+\.\d+\.\d+)/u, `the DSH version is reachable by scrolling:\n${after}`)
  h.dispose()
})

test('the direct layout holds at every size of the frozen matrix', async () => {
  for (const [columns, rows] of [[200, 50], [120, 40], [100, 40], [80, 24], [80, 10], [80, 8], [72, 24], [44, 20], [30, 8]] as const) {
    const h = setup({ columns, rows })
    await h.openHome()
    const painted = h.rowsPlain()
    assert.equal(painted.length, rows, `the frame paints exactly ${rows} rows at ${columns}x${rows}:\n${h.view()}`)
    assert.ok(
      painted.some(line => /^> About/mu.test(line)) || painted.some(line => /dsh-pi-tui/u.test(line)),
      `the About content is painted at ${columns}x${rows}:\n${h.view()}`,
    )
    // The last physical row always carries the action bar.
    assert.notEqual(painted.at(-1)?.trim(), '', `the action bar is the physical last row at ${columns}x${rows}:\n${h.view()}`)
    assertRowWidths(h, columns)
    h.dispose()
  }
})

test('a resize cycle keeps the selected category, the content focus and the page state', async () => {
  const h = setup({ columns: 200, rows: 50 })
  await h.openHome()
  await h.walkToCategory('Models')
  assert.match(h.view(), /Models & Credentials/u, 'the Models page is painted')
  // The Models page reads its provider catalog after its first frame: wait
  // for the settled projection before the cycle compares it.
  await waitForFrame(h.view, frame => !/Loading provider configuration/u.test(frame), () => h.vt.waitForRender(), 'the Models catalog must settle before the resize cycle')
  const modelsBody = h.view()

  for (const [columns, rows] of [[72, 24], [44, 20], [100, 40], [200, 50]] as const) {
    h.vt.resize(columns, rows)
    await h.vt.waitForRender()
    if (columns < 76) {
      // A narrow terminal has no room for a rail AND a content column: the
      // category list is the only projection, and the page is not addressable
      // there (the plan's narrow rule).
      assert.match(h.view(), /^> Models/mu, `the narrow rail keeps the selection at ${columns}x${rows}:\n${h.view()}`)
      continue
    }
    assert.match(h.view(), /Models & Credentials/u, `the page state survives ${columns}x${rows}:\n${h.view()}`)
  }
  // The selection never changed: the cycle did not re-select a category, and
  // the page was never rebuilt (its own projection is unchanged).
  assert.match(h.view(), /^> Models/mu, 'the selected category survived the resize cycle')
  assert.ok(h.view().includes(modelsBody.split('\n')[4] ?? ''), 'the page projection survived the cycle')
  h.dispose()
})

// ── Settings Tab / Shift+Tab region navigation (real frames) ─────────────

test('Tab/Shift+Tab hand the keyboard to the About content and back at wide/medium sizes', async () => {
  for (const [columns, rows] of [[200, 50], [120, 40], [100, 40], [90, 24]] as const) {
    const h = setup({ columns, rows })
    await h.openHome()
    assert.match(h.rowsPlain()[0]!, /Settings · Categories/u)
    assert.match(h.rowsPlain().at(-1) ?? '', /Tab focus · Esc close/u, `the rail advertises Tab focus at ${columns}x${rows}`)
    await key(h, '\t')
    assert.match(h.rowsPlain()[0]!, /Settings · About/u, `Tab focuses the About content at ${columns}x${rows}`)
    if (columns >= 100) {
      assert.match(h.view(), /Tab focus · Shift\+Tab back/u, 'the About bar advertises both region keys')
    } else {
      // At 90 the lowest-priority region hint is the first segment dropped;
      // the remaining region hint and every semantic verb survive.
      assert.match(h.view(), /Shift\+Tab back/u, 'the reverse region key stays advertised')
      assert.match(h.view(), /c copy fact · C copy all · r refresh/u, 'the semantic verbs keep their hints')
      assert.doesNotMatch(h.view(), /Tab focus/u, 'the forward region hint drops first')
    }
    await key(h, '\t')
    assert.match(h.rowsPlain()[0]!, /Settings · Categories/u, 'Tab returns to the rail')
    await key(h, '\t')
    assert.match(h.rowsPlain()[0]!, /Settings · About/u, 'Tab focuses the About content again')
    await key(h, '\x1b[Z')
    assert.match(h.rowsPlain()[0]!, /Settings · Categories/u, 'Shift+Tab returns to the rail')
    assert.equal(h.replacements(), 0, 'region jumps never write')
    assert.ok(!h.view().includes('←'), 'no header arrows appear')
    h.dispose()
  }
})

test('a narrow /settings keeps the About row Tab inert and its existing Esc path', async () => {
  for (const [columns, rows] of [[72, 24], [44, 20]] as const) {
    const h = setup({ columns, rows })
    await h.openHome()
    assert.match(h.rowsPlain()[0]!, /Settings · About/u, 'the narrow home is the About content')
    const before = h.view()
    for (const data of ['\t', '\x1b[Z']) await key(h, data)
    assert.equal(h.view(), before, `the narrow root Tab is inert at ${columns}x${rows}`)
    assert.doesNotMatch(before, /Tab focus/u, 'the narrow frame advertises no root Tab')
    await key(h, '\x1b')
    assert.match(h.rowsPlain()[0]!, /Settings · Categories/u, 'Esc still returns to the rail')
    h.dispose()
  }
})

test('Tab/Shift+Tab cycle the legacy panes in a real frame without opening a choice', async () => {
  for (const [columns, rows] of [[200, 50], [120, 40]] as const) {
    const h = setup({ columns, rows, doc: { theme: 'dark' } })
    await h.open()
    assert.match(h.rowsPlain().at(-1) ?? '', /Tab panes · Esc close/u)
    await key(h, '\t')
    assert.match(h.rowsPlain()[0]!, /· Rows/u)
    assert.match(h.rowsPlain().at(-1) ?? '', /Tab panes · Shift\+Tab back · Esc back/u)
    await key(h, '\t')
    assert.match(h.rowsPlain()[0]!, /Configured theme/u)
    assert.ok(!h.view().includes('Choose value'), 'Tab focusing Detail never opens the choice')
    await key(h, '\t')
    assert.match(h.rowsPlain()[0]!, /Settings · Categories/u)
    await key(h, '\x1b[Z')
    assert.match(h.rowsPlain()[0]!, /Configured theme/u)
    assert.ok(!h.view().includes('Choose value'), 'the reverse jump never opens the choice')
    assert.deepEqual(h.replaced(), [], 'no region jump wrote a document')
    h.dispose()
  }
})

test('the Models Add catalog reaches Custom provider… with one Tab in a real frame', async () => {
  const providerOptions: CredentialProviderOption[] = Array.from({ length: 40 }, (_, index) => ({
    route: `provider-${index}`,
    label: index === 0 ? 'Anthropic' : `Provider ${String(index).padStart(2, '0')}`,
    ref: `PROVIDER_${index}_API_KEY`,
    configured: false,
    declared: false,
    namesCredential: false,
    group: 'available' as const,
    canProvisionProfile: true,
  }))
  const h = setup({ columns: 120, rows: 40, providerOptions })
  await h.open('Models')
  await waitForFrame(
    h.view,
    frame => /Models & Credentials/u.test(frame) && !/Loading provider configuration/u.test(frame),
    () => h.vt.waitForRender(),
    'the provider catalog must settle',
  )
  await key(h, '\t') // rail -> the Models content page
  await key(h, '\u001b[B') // account row -> the Add Provider… action
  await key(h, '\r')
  assert.match(h.view(), /Available providers/u)
  assert.match(h.view(), /> Anthropic/u)
  await key(h, '\t')
  assert.match(h.view(), /> Custom provider…/u, 'one Tab selects the first enabled action')
  assert.match(h.view(), /Tab sections/u, 'the Models page advertises its region key')
  await key(h, '\u001b[Z')
  assert.match(h.view(), /> Anthropic/u, 'Shift+Tab returns to the first body row')
  assert.deepEqual(h.replaced(), [], 'the region jump never writes')
  h.dispose()
})

test('the 90-column Settings split keeps the Models refresh hint over the region key', async () => {
  // At 90 columns the Settings content column is 66 cells: the Models page's
  // own action bar must keep `r refresh` and drop `Tab sections` first.
  const providerOptions: CredentialProviderOption[] = [{
    route: 'provider-0',
    label: 'Anthropic',
    ref: 'ANTHROPIC_API_KEY',
    configured: false,
    declared: false,
    namesCredential: false,
    group: 'available',
    canProvisionProfile: true,
  }]
  const h = setup({ columns: 90, rows: 24, providerOptions })
  await h.open('Models')
  await key(h, '\t') // rail -> the Models content page
  const bar = h.rowsPlain().at(-1)!
  assert.match(bar, /r refresh/u, 'the existing refresh hint survives the 66-cell content bar')
  assert.doesNotMatch(bar, /Tab sections/u, 'the region hint is the first segment dropped')
  assert.match(bar, /Esc back/u, 'Esc remains the last-row hint')
  h.dispose()
})

test('the Tab hints are whole segments and the action bar keeps the last physical row', async () => {
  // 80x10: the direct bar spans the whole 80-cell frame from X=0, so the whole
  // Tab focus segment fits and is painted intact (it is never squeezed into
  // the 56-cell content column and never cut mid-word).
  const narrow = setup({ columns: 80, rows: 10 })
  await narrow.openHome()
  const bar80 = narrow.rowsPlain().at(-1) ?? ''
  assert.match(bar80, /Up\/Down navigate · Enter\/Right focus · Tab focus · Esc close/u)
  assert.doesNotMatch(bar80, /…/u, 'the bar never truncates a segment mid-word')
  assertNoHalfSegmentInBar(narrow.rowsPlain(), narrow.rowsPlain().length - 1, ' · ')
  narrow.dispose()

  // 90x24 keeps the whole segment visible at medium width.
  const medium = setup({ columns: 90, rows: 24 })
  await medium.openHome()
  assert.match(medium.rowsPlain().at(-1) ?? '', /Tab focus · Esc close/u)
  assertNoHalfSegmentInBar(medium.rowsPlain(), medium.rowsPlain().length - 1, ' · ')
  medium.dispose()

  // Legacy 90x24: the region hints are dropped first, so the pre-existing
  // Refresh hint survives instead of being crowded out of the bar.
  const legacy = setup({ columns: 90, rows: 24, doc: { theme: 'dark' } })
  await legacy.open() // Appearance, category rail focus
  await key(legacy, '\t') // categories -> rows
  const legacyBar = legacy.rowsPlain().at(-1) ?? ''
  assert.match(legacyBar, /r refresh/u, 'the existing refresh hint survives at 90 columns')
  assert.match(legacyBar, /Enter choose/u)
  assert.doesNotMatch(legacyBar, /Tab panes/u, 'the region hint is the first segment dropped')
  assertNoHalfSegmentInBar(legacy.rowsPlain(), legacy.rowsPlain().length - 1, ' · ')
  legacy.dispose()
})

// ── C3 (Phase 3C): the About action row's real mouse targets ──────────────
//
// The action row paints Refresh AND Copy All side by side on a LIVE session;
// BOTH are independent last-painted targets (the retired `.find()` silently
// dropped the second). This is the real-click regression: two separate SGR
// press/release gestures on the SAME painted row, each hitting its own
// button cells. (The sessionless default harness hides the Refresh button by
// contract — the live-session source-sink harness owns the two-button case.)
test('C3 the sessionless About action row: Copy All is clickable and blank cells are inert', async () => {
  const h = setup({ columns: 120, rows: 40 })
  await h.openHome()
  const rows = h.vt.getViewport().map(stripTerminalSequences)
  const actionRowIndex = rows.findIndex(line => line.includes('Copy All ['))
  assert.ok(actionRowIndex !== -1, `the action row is painted:\n${h.view()}`)
  const actionRow = rows[actionRowIndex]!
  const copyAllCol = actionRow.indexOf('Copy All [')
  // The sessionless action row hides the Refresh button (plan §2.1).
  assert.equal(actionRow.includes('Refresh context ['), false, 'the Session-only Refresh is hidden while sessionless')
  // The affordance contract (design language §7.1 role 14): the painted
  // actionable button is `Verb [Key]` in the `primary` token — assert BOTH
  // the text and the token (the ANSI capture carries the real palette).
  assert.match(actionRow, /Copy All \[C\]/u, `the Verb [Key] format paints: ${JSON.stringify(actionRow)}`)
  // THE TOKEN (design language §7.1 role 14): the painted affordance rides
  // the `primary` token — the button's FIRST cell carries the live primary
  // RGB (the same per-cell assertion the A-15 chrome test uses), and it is
  // NOT the muted token.
  const buttonCol = copyAllCol
  const buttonFg = h.vt.getCellFgRgb(actionRowIndex, buttonCol)
  assert.equal(buttonFg, hexToRgb(currentPalette.primary), `the Copy All affordance paints the primary token (got ${buttonFg})`)
  // Click: Copy All copies the report.
  press(h, actionRowIndex, copyAllCol + 2)
  release(h, actionRowIndex, copyAllCol + 2)
  await settle(h)
  assert.equal(h.copied.length, 1, 'the Copy All button copied')
  assert.match(h.copied[0]!, /dsh-pi-tui Status/u, 'the Copy All payload is the report')
  // Blank cells after the button never copy.
  press(h, actionRowIndex, copyAllCol + 20)
  release(h, actionRowIndex, copyAllCol + 20)
  await settle(h)
  assert.equal(h.copied.length, 1, 'a blank-cell click never copies')
  h.dispose()
})

// ── C3 (Phase 3C): the narrow-screen hidden-entry gate ────────────────────
//
// The plan §3.3 narrow case: browsing to About on a NARROW rail must NOT
// start the About reads (nothing About is painted), and the content-focus
// Enter afterwards admits exactly ONE scoped read. The runner's About seams
// are COUNTED in the same harness as the panel, so the assertion observes
// the reads the GATING actually admitted (removing the paintsDirectContent
// condition fails the first assertion).
test('C3 a narrow Account deeplink → rail-browse About reads nothing; Enter reads exactly once', async () => {
  // A minimal runner stub with COUNTED About seams + a LIVE scope.
  const vt = new VirtualTerminal(44, 20)
  const reads: string[] = []
  let generation = 1
  let scopeObject: { readonly sessionId: string; readonly generation: number } = { sessionId: 'sess-narrow', generation }
  const capturedScope = scopeObject
  // The owned-task settlements are COLLECTED: `settleOwned()` drains every
  // pending task deterministically (no fixed timers — the About read chain
  // settles through the same barrier the assertions then observe).
  const pendingOwned: Array<() => void> = []
  const owned: OwnedRunner = (_label, task, runOptions) => {
    const run = (): void => {
      void Promise.resolve()
        .then(() => task())
        .then(
          result => runOptions.onResult?.(result),
          error => runOptions.onError?.(error),
        )
    }
    pendingOwned.push(run)
  }
  /** Deterministically drain every owned task the reads queued (no timers). */
  async function settleCounted(): Promise<void> {
    while (pendingOwned.length > 0) {
      const run = pendingOwned.shift()!
      run()
      // The read chain settles through microtasks; yield until the queue is
      // empty (a chain may enqueue its own next stage).
      for (let at = 0; at < 8; at += 1) await Promise.resolve()
    }
    // Drain any follow-up microtask stages the last chain queued.
    for (let at = 0; at < 8; at += 1) await Promise.resolve()
  }
  const events: TuiAppEvents = { onSubmit: () => {}, onExit: () => {}, runOwned: owned }
  const app = new TuiApp(vt, events, { copySelection: async () => true })
  app.start()
  startedApps.add(app)
  const defs: { name: string; handler?: unknown }[] = []
  const commands = {
    register: (definition: { name: string; handler?: unknown }) => { defs.push(definition); return () => {} },
    list: () => [],
    find: () => undefined,
    execute: async () => undefined,
  }
  const ctx = new Context()
  ctx.provide('commands', commands as never)
  ctx.provide('skills', { list: async () => [], get: async () => undefined, find: () => undefined, execute: async () => undefined } as never)
  const base: Record<string, unknown> = {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    cwd: '/ws',
    sessionCwd: () => '/ws',
    progressUpdatesState: { mode: 'milestones' },
    responseStyleState: { style: 'default' },
    gitAttributionState: { mode: 'off' },
    signal: new AbortController().signal,
    commandRegistry: commands,
    clientCommands: createClientCommandRegistry(parseCommand),
    recordExtensionError: () => {},
    clearExtensionError: () => {},
    captureExtensionHealthRef: () => () => {},
    currentSessionId: 'sess-narrow',
    captureLiveSessionScope: () => capturedScope,
    isSessionScopeCurrent: () => true,
    currentSessionStats: async () => {
      reads.push('stats')
      return { lifetime: { turns: 1, steps: 1, llmMs: 100 } }
    },
    sessionReader: {
      measureContext: () => {
        reads.push('context')
        return 1_000
      },
      sessionStatus: (sessionId: string) => {
        reads.push('projection')
        return { sessionId, cwd: '/ws' }
      },
    },
    forceContextMeasurementResult: () => {
      reads.push('context')
      return { value: 1_000, observation: 'fresh' as const }
    },
    backendKind: 'direct' as const,
    subscribeSessionScopeInvalidation: () => () => {},
    listScopedCommands: () => [],
    displayPreset: () => app.displayPreset(),
    focusEnabled: () => false,
    setDisplayPreset: () => ({ kind: 'unchanged', preset: 'default' }),
    refreshStatus: () => {},
    copyToClipboard: async () => true,
    tuiSettings: undefined,
    extensions: undefined,
    openPluginManager: () => {},
    createPluginManagerPage: () => undefined,
    config: {
      configReadiness: () => 'ready',
      visualTools: { read: () => undefined, setEnabled: async (_enabled: boolean, _revision: number) => {} },
      footerCustomItems: { rawForPersistence: () => ({ kind: 'available', value: undefined }) },
      permissions: { presetNames: () => [], defaultPreset: () => undefined, approvalOverrideOf: () => undefined, approvalOverrideAvailable: () => false },
      subagentModelSelection: { available: () => false },
      web: { available: () => false },
      credentials: { available: () => false, recordsSupported: () => false },
      providers: { available: () => false },
      authorization: { available: () => false },
      account: { available: () => false },
    },
    catalog: { models: { available: () => false } },
  }
  const runner = new Proxy(base, {
    get: (target, property) => property in target ? target[property as string] : () => undefined,
  }) as unknown as TuiCommandRunner
  registerTuiCommandsWithDirectSeams(runner)
  const invoke = (name = 'settings', rawInput = ''): unknown => {
    const definition = defs.find(candidate => candidate.name === name)
    assert.ok(definition?.handler !== undefined, `/${name} must be registered`)
    return (definition.handler as (invocation: { rawInput: string }) => unknown)({ rawInput })
  }
  try {
    // Open the workspace on a NARROW terminal: the About home owns the
    // single column (a plain open IS the entry — one read cycle admitted).
    invoke('settings')
    await vt.waitForRender()
    await settleCounted()
    assert.equal(reads.filter(kind => kind === 'stats').length, 1, 'the narrow About home admits exactly one stats read')
    reads.length = 0

    // Esc: the content hands the keyboard back to the rail (the narrow open
    // landed on the content — the About page STAYS the selected category).
    sendKey(vt, '\x1b')
    await vt.waitForRender()
    await settleCounted()
    assert.equal(reads.length, 0, 'Esc to the rail never reads')
    reads.length = 0

    // Browse the rail to Account and BACK to About: on a narrow terminal the
    // About content is NOT painted while the rail owns the focus — the
    // back-selection must admit NO reads (the hidden-entry gate).
    sendKey(vt, '\x1b[B') // down: About → Models (the category change fires the leave)
    await vt.waitForRender()
    sendKey(vt, '\x1b[B') // down: Models → Account
    await vt.waitForRender()
    sendKey(vt, '\x1b[A') // up: Account → Models
    await vt.waitForRender()
    sendKey(vt, '\x1b[A') // up: Models → About (content NOT painted on narrow)
    await vt.waitForRender()
    await settleCounted()
    assert.equal(reads.length, 0, `the narrow rail-browse of About admits NO reads: ${JSON.stringify(reads)}`)

    // Enter: the content takes the focus and IS painted now — exactly ONE
    // new scoped read for this entry. (The narrow frame dumps on failure.)
    sendKey(vt, '\r')
    await vt.waitForRender()
    await settleCounted()
    if (reads.filter(kind => kind === 'stats').length !== 1) {
      throw new Error(`NARROW FRAME after Enter (reads=${JSON.stringify(reads)}):\n${vt.getViewport().map(stripTerminalSequences).map((line, at) => `${String(at).padStart(2)}|${line}`).join('\n')}`)
    }
    assert.equal(reads.filter(kind => kind === 'stats').length, 1, `the content entry admits exactly one read: ${JSON.stringify(reads)}`)
    const frame = vt.getViewport().map(stripTerminalSequences).join('\n')
    assert.match(frame, /Session ID/, 'the About facts paint after the content entry')

    // C5: close the workspace and open it through the `/status` alias. The
    // alias is the SAME active-Direct entry: exactly one scoped stats,
    // projection and context read, and the same About facts.
    sendKey(vt, '\x1b') // content -> rail
    await vt.waitForRender()
    sendKey(vt, '\x1b') // rail -> close
    await vt.waitForRender()
    reads.length = 0
    invoke('status')
    await vt.waitForRender()
    await settleCounted()
    assert.equal(reads.filter(kind => kind === 'stats').length, 1,
      `the active /status alias admits exactly one stats read: ${JSON.stringify(reads)}`)
    assert.equal(reads.filter(kind => kind === 'projection').length, 1,
      `the active /status alias admits exactly one projection read: ${JSON.stringify(reads)}`)
    assert.equal(reads.filter(kind => kind === 'context').length, 1,
      `the active /status alias admits exactly one context read: ${JSON.stringify(reads)}`)
    assert.match(vt.getViewport().map(stripTerminalSequences).join('\n'), /Session ID/,
      'the alias paints the same active About facts')
  } finally {
    app.dispose()
  }
})

/** Send one key to a bare VirtualTerminal (no harness wrapper). */
function sendKey(vt: VirtualTerminal, data: string): void {
  vt.sendInput(data)
}

test('B-05h the Visual tools row keeps its focus/choice/confirm contract at medium and narrow widths', async () => {
  // Medium (76–107): the row's keyboard/Tab focus, mouse Change confirm and Esc
  // paths are the same workspace behaviors as the other writable rows.
  const medium = setup({ columns: 100, rows: 30 })
  await medium.open('Tools')
  assert.match(medium.view(), /Visual tools/)
  await key(medium, '\t') // categories -> rows
  assert.match(medium.rowsPlain()[0]!, /Settings · Tools · Rows/)
  await key(medium, '\x1b[Z') // Shift+Tab: rows -> categories
  assert.match(medium.rowsPlain()[0]!, /Settings · Categories/)
  await key(medium, '\t') // categories -> rows again
  const changeRow = rowOf(medium, 'Change…')
  press(medium, changeRow, cellIndexOf(medium, changeRow, 'Change…'))
  release(medium, changeRow, cellIndexOf(medium, changeRow, 'Change…'))
  await settle(medium)
  assert.match(medium.view(), /Choose value/)
  await key(medium, '\x1b[B') // On -> Off
  const confirmRow = rowOf(medium, 'Confirm')
  press(medium, confirmRow, cellIndexOf(medium, confirmRow, 'Confirm'))
  release(medium, confirmRow, cellIndexOf(medium, confirmRow, 'Confirm'))
  await settle(medium)
  assert.deepEqual(medium.visualWrites(), [false], 'the mouse Confirm dispatched exactly one Host write')
  assert.match(medium.view(), /Status\s+Verified/)
  await key(medium, '\x1b') // retire the settled choice view -> rows
  await key(medium, '\x1b') // rows -> categories
  assert.match(medium.rowsPlain()[0]!, /Settings · Categories/)
  medium.dispose()

  // Narrow (<76): one column, the same Enter/choice/Confirm path and Esc back.
  const narrow = setup({ columns: 44, rows: 30 })
  await narrow.open('Tools')
  assert.ok(narrow.rowsPlain().some(line => line.includes('> Tools')), `the narrow rail selects Tools:\n${narrow.view()}`)
  await key(narrow, '\t') // narrow Tab stays inert
  assert.ok(narrow.rowsPlain().some(line => line.includes('> Tools')), 'the narrow root Tab is inert')
  await key(narrow, '\r') // L0 -> L1 rows
  assert.match(narrow.view(), /Visual tools/)
  await key(narrow, '\r') // writable L1 -> L2 inline choice
  assert.match(narrow.view(), /Choose value/)
  await key(narrow, '\x1b[B') // On -> Off
  await key(narrow, '\r') // explicit confirm
  await settle(narrow)
  assert.deepEqual(narrow.visualWrites(), [false], 'the narrow explicit confirm dispatches one Host write')
  assert.match(narrow.view(), /Status\s+Verified/)
  await key(narrow, '\x1b') // detail -> rows
  await key(narrow, '\x1b') // rows -> categories
  assert.ok(narrow.rowsPlain().some(line => line.includes('> Tools')), 'Esc returns to the narrow rail with Tools selected')
  narrow.dispose()
})

// ── The shared Settings vertical chrome ───────────────────────────────────
//
// Every case drives the real `/settings` entry, the real TuiApp lease and the
// real VirtualTerminal cells. The expected geometry is the frozen planner:
// header → metadata → at most one top rule → optional notice → optional pane
// header → body → the ONE physical last-row action bar.

const SETTINGS_PROVIDERS: readonly CredentialProviderOption[] = [{
  route: 'acme',
  label: 'Acme Gateway',
  ref: 'ACME_API_KEY',
  configured: true,
  declared: false,
  namesCredential: true,
  group: 'configured',
  canProvisionProfile: true,
}]

/** The physical rows every multi-column frame must agree on. */
const pr1Geometry = (h: Harness): { paneY: number; contentY: number; barY: number } => {
  const rows = h.rowsPlain()
  const paneY = rows.findIndex(line => line.includes('Categories (8)'))
  assert.ok(paneY >= 0, `the shared pane header must be painted:\n${h.view()}`)
  const contentY = paneY + 1
  assert.notEqual((rows[contentY] ?? '').trim(), '', `the first content row must carry real content:\n${h.view()}`)
  return { paneY, contentY, barY: rows.length - 1 }
}

test('direct and legacy settings categories share the pane-header, first-body and action-bar rows at medium and wide widths', async () => {
  const pairs = [['About', 'Appearance'], ['Models', 'Display'], ['Account', 'Tools']] as const
  for (const columns of [80, 100, 107, 108, 120] as const) {
    for (const [directCategory, legacyCategory] of pairs) {
      const direct = setup({ columns, rows: 24 })
      await direct.open(directCategory)
      const directGeometry = pr1Geometry(direct)
      const directHead = direct.rowsPlain()[directGeometry.paneY]!
      assert.match(directHead, /\[Categories \(8\)\]/u, `the rail is the active device:\n${directHead}`)
      assert.match(directHead, new RegExp(`\\b${directCategory}\\b`, 'u'), `the right label names the page:\n${directHead}`)
      assert.doesNotMatch(directHead, /Rows \(|Details/u, 'the direct header fakes no legacy panes')
      assert.match(direct.rowsPlain().at(-1) ?? '', /Esc close/u, 'the last row is the rail action bar')
      direct.dispose()

      const legacy = setup({ columns, rows: 24 })
      await legacy.open(legacyCategory)
      const legacyGeometry = pr1Geometry(legacy)
      const legacyHead = legacy.rowsPlain()[legacyGeometry.paneY]!
      assert.match(legacyHead, /\[Categories \(8\)\].*Rows \(\d+\)/u, `the legacy panes stay adjacent:\n${legacyHead}`)
      legacy.dispose()

      assert.deepEqual(directGeometry, legacyGeometry,
        `direct ${directCategory} and legacy ${legacyCategory} must share the chrome Y at ${columns}:\n${direct.view()}\n---\n${legacy.view()}`)
    }
  }
})

test('120x24 and 120x40 paint header, metadata, rule, pane header, body and bar at the frozen rows', async () => {
  for (const rows of [24, 40] as const) {
    const direct = setup({ columns: 120, rows })
    await direct.openHome()
    const frame = direct.rowsPlain()
    assert.equal(frame.length, rows)
    assert.match(frame[0]!, /^Settings · Categories/u)
    assert.match(frame[1]!, /^Scope: /u)
    assert.match(frame[2]!, /^─+$/u)
    assert.match(frame[3]!, /^\[Categories \(8\)\].*About/u)
    assert.doesNotMatch(frame[3]!, /Rows \(|Details/u, 'the direct projection paints exactly two labels')
    assert.match(frame[4]!, /^> About/u, 'the first real content row follows the pane header')
    assert.match(frame.at(-1) ?? '', /Esc close/u)
    direct.dispose()

    const legacy = setup({ columns: 120, rows })
    await legacy.open('Appearance')
    const legacyFrame = legacy.rowsPlain()
    assert.equal(legacyFrame.length, rows)
    assert.match(legacyFrame[0]!, /^Settings · Categories/u)
    assert.match(legacyFrame[1]!, /^Scope: /u)
    assert.match(legacyFrame[2]!, /^─+$/u)
    assert.match(legacyFrame[3]!, /^\[Categories \(8\)\].*Rows \(2\).*Details/u,
      'the wide legacy frame keeps all three pane headers')
    assert.match(legacyFrame[4]!, /^ {2}About/u)
    assert.match(legacyFrame.at(-1) ?? '', /Esc close/u)
    legacy.dispose()
  }
})

test('medium legacy levels keep Categories+Rows at L0 and Rows+Details at L1/L2', async () => {
  for (const columns of [76, 80, 100, 107] as const) {
    const h = setup({ columns, rows: 24 })
    await h.open('Appearance')
    let frame = h.rowsPlain()
    let pane = frame.findIndex(line => line.includes('Categories (8)'))
    assert.ok(pane >= 0)
    assert.match(frame[pane]!, /\[Categories \(8\)\].*Rows \(2\)/u, 'L0 is Categories + Rows')
    assert.doesNotMatch(frame[pane]!, /Details/u)

    await key(h, '\r') // L0 -> L1
    frame = h.rowsPlain()
    pane = frame.findIndex(line => line.includes('[Rows (2)]'))
    assert.ok(pane >= 0, `L1 must paint the focused Rows header at ${columns}:\n${h.view()}`)
    assert.match(frame[pane]!, /\[Rows \(2\)\].*Details/u, 'L1 is Rows + Details')
    assert.doesNotMatch(frame[pane]!, /Categories/u, 'the categories column is NOT pinned at L1/L2')

    await key(h, '\x1b[C') // L1 -> L2 inline choice
    frame = h.rowsPlain()
    pane = frame.findIndex(line => line.includes('[Details]'))
    assert.ok(pane >= 0)
    assert.match(frame[pane]!, /Rows \(2\).*\[Details\]/u, 'L2 keeps Rows + the focused Details')
    assert.doesNotMatch(frame[pane]!, /Categories/u)
    h.dispose()
  }
})

test('the 72/75/76/107/108 breakpoint edges keep their projection and at most one top rule', async () => {
  for (const columns of [72, 75, 76, 107, 108] as const) {
    const direct = setup({ columns, rows: 24 })
    await direct.openHome()
    assertRowWidths(direct, columns)
    let frame = direct.rowsPlain()
    assert.ok(frame.filter(line => /^─+$/.test(line)).length <= 1, `no second rule at ${columns}:\n${direct.view()}`)
    if (columns < 76) {
      assert.ok(!direct.view().includes('Categories ('), `narrow paints no pane header:\n${direct.view()}`)
    } else {
      const pane = frame.findIndex(line => line.includes('[Categories (8)]'))
      assert.ok(pane >= 0)
      assert.match(frame[pane]!, /\[Categories \(8\)\].*About/u)
      assert.doesNotMatch(frame[pane]!, /Rows \(|Details/u)
    }
    direct.dispose()

    const legacy = setup({ columns, rows: 24 })
    await legacy.open('Appearance')
    assertRowWidths(legacy, columns)
    frame = legacy.rowsPlain()
    assert.equal(frame.filter(line => /^─+$/.test(line)).length, 1, `the one top rule at ${columns}:\n${legacy.view()}`)
    if (columns < 76) {
      assert.ok(!legacy.view().includes('Categories ('), `narrow paints no pane header:\n${legacy.view()}`)
      assert.ok(frame.some(line => line.startsWith('> Appearance')), 'the narrow list is the one pane')
    } else {
      const pane = frame.findIndex(line => line.includes('Categories (8)'))
      assert.ok(pane >= 0)
      assert.match(frame[pane]!, /\[Categories \(8\)\].*Rows \(2\)/u)
      if (columns >= 108) assert.match(frame[pane]!, /Details/u, '108 is the three-column edge')
      else assert.doesNotMatch(frame[pane]!, /Details/u, '76..107 stays two-column')
    }
    legacy.dispose()
  }
})

test('an app notice sits after the top rule and before the pane header at every granted height', async () => {
  const h = setup({ columns: 120, rows: 24, doc: { theme: 'dark' } })
  await h.open('Appearance')
  await key(h, '\r') // L1 exposes the real Detail copy button
  const copyRow = rowOf(h, 'Copy value [C]')
  const copyCol = cellIndexOf(h, copyRow, 'Copy value [C]')
  press(h, copyRow, copyCol)
  release(h, copyRow, copyCol)
  await settle(h)
  assert.ok(h.view().includes('Copy sent'), `the app notice is live:\n${h.view()}`)
  let frame = h.rowsPlain()
  assert.equal(frame.findIndex(line => line.includes('Copy sent')), 3, 'the notice follows the top rule')
  assert.equal(frame.findIndex(line => line.includes('Rows (2)')), 4, 'the pane header follows the notice')
  assert.match(frame[5]!, /Configured theme/u, 'the first real body row follows the pane header')
  assert.match(frame.at(-1) ?? '', /Esc back/u)
  assert.equal(frame.filter(line => line.includes('Copy sent')).length, 1, 'exactly one app-level notice')

  h.vt.resize(100, 6)
  await h.vt.waitForRender()
  frame = h.rowsPlain()
  assert.equal(frame[1]!.includes('Copy sent'), true, `the notice follows the header at 6 rows:\n${h.view()}`)
  assert.equal(frame[2]!.includes('Rows (2)'), true, `the pane header follows the notice at 6 rows:\n${h.view()}`)
  assert.match(frame.at(-1) ?? '', /Esc back/u)
  assert.equal(frame.filter(line => line.includes('Copy sent')).length, 1, 'still one notice')

  h.vt.resize(100, 8)
  await h.vt.waitForRender()
  frame = h.rowsPlain()
  assert.equal(frame[2]!.includes('Copy sent'), true, `the notice follows the diagnostic line at 8 rows:\n${h.view()}`)
  assert.equal(frame[3]!.includes('Rows (2)'), true, `the pane header follows the notice at 8 rows:\n${h.view()}`)
  assert.match(frame.at(-1) ?? '', /Esc back/u)
  h.dispose()
})

test('tiny heights grant only the allowed chrome and keep hidden actions inert', async () => {
  const expected: Record<number, { meta: boolean; rule: boolean; pane: boolean; content: number }> = {
    1: { meta: false, rule: false, pane: false, content: 0 },
    2: { meta: false, rule: false, pane: false, content: 0 },
    3: { meta: false, rule: false, pane: false, content: 1 },
    5: { meta: false, rule: false, pane: true, content: 2 },
    6: { meta: false, rule: false, pane: true, content: 3 },
    8: { meta: true, rule: true, pane: true, content: 3 },
    10: { meta: true, rule: true, pane: true, content: 5 },
  }
  for (const [heightText, grant] of Object.entries(expected)) {
    const height = Number(heightText)
    const h = setup({ columns: 100, rows: height })
    await h.openHome()
    const painted = h.rowsPlain()
    assert.equal(painted.length, height)
    const headerRows = height >= 2 ? 1 : 0
    const paneY = headerRows + (grant.meta ? 1 : 0) + (grant.rule ? 1 : 0)
    const contentY = paneY + (grant.pane ? 1 : 0)
    assert.equal(painted.some(line => line.startsWith('Settings ·')), headerRows === 1, 'the header needs two rows')
    assert.equal(painted.some(line => line.startsWith('Scope: ')), grant.meta, 'the diagnostic keeps its floor')
    assert.equal(painted.filter(line => /^─+$/.test(line)).length, grant.rule ? 1 : 0, 'the one rule keeps its floor')
    assert.equal(painted.some(line => line.includes('Categories (8)')), grant.pane, 'the pane header keeps one content row')
    if (grant.pane) assert.notEqual((painted[contentY] ?? '').trim(), '', 'a granted pane header leaves real content below it')
    assert.match(painted.at(-1) ?? '', /Esc close/u, 'the bar is the physical last row')
    assert.equal(contentY + grant.content, height - 1, 'the granted body ends directly above the bar')

    if (grant.content === 0) {
      const before = h.view()
      for (const data of ['c', 'r', '\r', '\t']) await key(h, data)
      assert.equal(h.view(), before, `no hidden action fires at ${height} rows`)
      assert.deepEqual(h.copied, [], 'copy stays inert with no body')
      assert.equal(h.replacements(), 0, 'refresh never reads/writes with no body')
      await key(h, '\u001b')
      assert.ok(!h.view().includes('Settings ·'), 'Esc still leaves the workspace')
    }
    h.dispose()
  }

  // Narrow: no pane header at any granted body height.
  for (const height of [3, 5, 8] as const) {
    const h = setup({ columns: 72, rows: height })
    await h.openHome()
    const painted = h.rowsPlain()
    assert.equal(painted.length, height)
    assert.ok(!h.view().includes('Categories ('), 'narrow never paints a pane header')
    const headerRows = height >= 2 ? 1 : 0
    const metaRows = height >= 8 ? 1 : 0
    const ruleRows = height >= 8 ? 1 : 0
    const bodyTop = headerRows + metaRows + ruleRows
    assert.notEqual((painted[bodyTop] ?? '').trim(), '', 'the narrow body starts at the shared top')
    assert.match(painted.at(-1) ?? '', /Esc back/u)
    h.dispose()
  }
})

test('each frame paints one last-row action bar naming the live keyboard owner', async () => {
  const assertOneBar = (h: Harness, expected: RegExp, absent: RegExp): void => {
    const rows = h.rowsPlain()
    const bars = rows.filter(line => /Esc (?:close|back)/u.test(line))
    assert.equal(bars.length, 1, `exactly one action bar row:\n${h.view()}`)
    const bar = rows.at(-1)!
    assert.match(bar, expected)
    assert.doesNotMatch(bar, absent)
    assert.doesNotMatch(bar, /^ /u, 'the bar starts at X=0')
  }

  const about = setup({ columns: 120, rows: 24 })
  await about.openHome()
  assertOneBar(about, /Enter\/Right focus · Tab focus · Esc close/u, /Esc back/u)
  await key(about, '\t') // rail -> the About content
  assertOneBar(about, /Esc back/u, /Esc close/u)
  about.dispose()

  const models = setup({ columns: 120, rows: 24, providerOptions: SETTINGS_PROVIDERS })
  await models.open('Models')
  await key(models, '\t')
  assertOneBar(models, /r refresh · .*Esc back/u, /Esc close/u)
  models.dispose()

  const account = setup({ columns: 120, rows: 24 })
  await account.open('Account')
  await key(account, '\t')
  assertOneBar(account, /Esc back/u, /Esc close/u)
  account.dispose()

  const legacy = setup({ columns: 120, rows: 24 })
  await legacy.open('Appearance')
  assertOneBar(legacy, /Right open · Enter open · Tab panes · Esc close/u, /Esc back/u)
  await key(legacy, '\r')
  assertOneBar(legacy, /Enter choose · .*Esc back/u, /Esc close/u)
  await key(legacy, '\x1b[C') // the inline choice (Details holds the keyboard)
  assertOneBar(legacy, /Enter confirm · .*Esc back/u, /Esc close/u)
  legacy.dispose()
})

test('a direct page focus transfer reuses the painted page and performs no settings read or write', async () => {
  const h = setup({ columns: 120, rows: 24, providerOptions: SETTINGS_PROVIDERS })
  await h.open('Models')
  assert.match(h.view(), /Models & Credentials/u)
  const reads = h.reads()

  await key(h, '\t') // the rail hands the keyboard to the SAME page
  assert.match(h.rowsPlain()[0]!, /Settings · Models/u)
  assert.match(h.view(), /Models & Credentials/u)
  assert.equal(h.reads(), reads, 'the focus transfer performed no settings read')
  assert.equal(h.replacements(), 0, 'the focus transfer performed no write')
  await key(h, 'x') // a page-local inert key
  assert.equal(h.reads(), reads)
  assert.equal(h.replacements(), 0)

  await key(h, '\u001b') // the page reports its own exit
  assert.match(h.rowsPlain()[0]!, /Settings · Categories/u)
  await key(h, '\u001b[B') // Models -> Account preview
  assert.match(h.view(), /DeepSeek Account/u)
  assert.equal(h.reads(), reads, 'selecting the preview reads no settings document')
  await key(h, '\t') // Account content focus
  assert.match(h.rowsPlain()[0]!, /Settings · Account/u)
  assert.equal(h.reads(), reads)
  assert.equal(h.replacements(), 0)
  h.dispose()
})

test('pointer and wheel act only on the last-painted body cells', async () => {
  const about = setup({ columns: 120, rows: 24 })
  await about.openHome()
  const copyRow = rowOf(about, 'Copy All [C]')
  const copyCol = cellIndexOf(about, copyRow, 'Copy All [C]')
  press(about, copyRow, copyCol + 2)
  release(about, copyRow, copyCol + 2)
  await settle(about)
  assert.equal(about.copied.length, 1, 'the painted Copy All button is the action')
  const stable = about.view()

  const paneRow = about.rowsPlain().findIndex(line => line.includes('[Categories (8)]'))
  assert.ok(paneRow >= 0)
  press(about, paneRow, 30)
  release(about, paneRow, 30)
  await settle(about)
  assert.equal(about.view(), stable, 'a pane-header click is inert')
  const barRow = about.rowsPlain().length - 1
  press(about, barRow, 2)
  release(about, barRow, 2)
  await settle(about)
  assert.equal(about.view(), stable, 'a bottom-bar click is inert')
  const modelsRail = about.rowsPlain().findIndex(line => line.slice(0, 22).trim() === 'Models')
  assert.ok(modelsRail >= 0)
  press(about, modelsRail, 2)
  release(about, modelsRail, 2)
  await settle(about)
  assert.match(about.rowsPlain()[0]!, /Settings · Categories/u, 'a rail click keeps the keyboard on the rail')
  assert.match(about.view(), /Models & Credentials/u)
  about.dispose()

  const models = setup({ columns: 120, rows: 24, providerOptions: SETTINGS_PROVIDERS })
  await models.open('Models')
  const addRow = rowOf(models, 'Add Provider…')
  const addCol = cellIndexOf(models, addRow, 'Add Provider…')
  press(models, addRow, addCol)
  release(models, addRow, addCol)
  await settle(models)
  assert.match(models.view(), /Add Provider/u, 'the page action row is a real body target')
  assert.equal(models.replacements(), 0, 'opening the add-provider form writes nothing')
  models.dispose()

  const account = setup({ columns: 120, rows: 24 })
  await account.open('Account')
  const backRow = rowOf(account, '← Settings')
  const backCol = cellIndexOf(account, backRow, '← Settings')
  press(account, backRow, backCol)
  release(account, backRow, backCol)
  await settle(account)
  assert.match(account.rowsPlain()[0]!, /Settings · Categories/u, 'the page action returned to the rail')
  account.dispose()

  // Wheel: only the pane under the pointer scrolls; chrome is inert.
  const wheelHarness = setup({ columns: 80, rows: 10 })
  await wheelHarness.openHome()
  const frame0 = wheelHarness.view()
  const wheelPane = wheelHarness.rowsPlain().findIndex(line => line.includes('Categories (8)'))
  assert.ok(wheelPane >= 0)
  wheel(wheelHarness, wheelPane, 2, true)
  await wheelHarness.vt.waitForRender()
  assert.equal(wheelHarness.view(), frame0, 'a wheel on the pane header is inert')
  wheel(wheelHarness, wheelHarness.rowsPlain().length - 1, 2, true)
  await wheelHarness.vt.waitForRender()
  assert.equal(wheelHarness.view(), frame0, 'a wheel on the bottom bar is inert')
  wheel(wheelHarness, wheelPane + 1, 2, true)
  await wheelHarness.vt.waitForRender()
  assert.notEqual(wheelHarness.view(), frame0, 'the wheel over the rail scrolls the rail')
  wheelHarness.dispose()
})

test('a resize, category change or notice insertion between press and release refuses the gesture', async () => {
  const resized = setup({ columns: 100, rows: 24, doc: { theme: 'dark' } })
  await resized.open('Appearance')
  await key(resized, '\r')
  const resizeRow = rowOf(resized, 'Copy value [C]')
  const resizeCol = cellIndexOf(resized, resizeRow, 'Copy value [C]')
  press(resized, resizeRow, resizeCol)
  resized.vt.resize(120, 24)
  await resized.vt.waitForRender()
  release(resized, resizeRow, resizeCol)
  await settle(resized)
  assert.deepEqual(resized.copied, [], 'a resize between press and release refuses the gesture')
  const freshRow = rowOf(resized, 'Copy value [C]')
  const freshCol = cellIndexOf(resized, freshRow, 'Copy value [C]')
  press(resized, freshRow, freshCol)
  release(resized, freshRow, freshCol)
  await settle(resized)
  assert.equal(resized.copied.length, 1, 'an unchanged gesture on the repainted target still copies')
  resized.dispose()

  const switched = setup({ columns: 120, rows: 24 })
  await switched.openHome()
  const accountRow = switched.rowsPlain().findIndex(line => line.slice(0, 22).trim() === 'Account')
  assert.ok(accountRow >= 0)
  press(switched, accountRow, 2)
  await key(switched, '\u001b[B') // About -> Models bumps the state version
  release(switched, accountRow, 2)
  await settle(switched)
  assert.match(switched.view(), /Models & Credentials/u)
  assert.doesNotMatch(switched.view(), /DeepSeek Account/u, 'the old Account press never activated')
  switched.dispose()

  const noticed = setup({ columns: 120, rows: 24 })
  await noticed.openHome()
  const noticeRow = rowOf(noticed, 'Copy All [C]')
  const noticeCol = cellIndexOf(noticed, noticeRow, 'Copy All [C]')
  press(noticed, noticeRow, noticeCol + 2)
  noticed.app.notify('gesture notice', 'info')
  await noticed.vt.waitForRender()
  release(noticed, noticeRow, noticeCol + 2)
  await settle(noticed)
  assert.deepEqual(noticed.copied, [], 'a notice insertion between press and release refuses the gesture')
  const shiftedRow = rowOf(noticed, 'Copy All [C]')
  const shiftedCol = cellIndexOf(noticed, shiftedRow, 'Copy All [C]')
  press(noticed, shiftedRow, shiftedCol + 2)
  release(noticed, shiftedRow, shiftedCol + 2)
  await settle(noticed)
  assert.equal(noticed.copied.length, 1, 'the repainted target still works')
  noticed.dispose()
})

test('CJK values wrap inside their pane and the pane-header device follows the live theme token', async () => {
  const longValue = 'file:主题-主题-主题-主题-主题-主题-主题-主题-主题-主题'
  for (const [columns, rows] of [[80, 24], [120, 40], [44, 20]] as const) {
    const h = setup({ columns, rows, doc: { theme: longValue } })
    await h.open('Appearance')
    if (columns >= 76) {
      const pane = h.rowsPlain().findIndex(line => line.includes('[Categories (8)]'))
      assert.ok(pane >= 0)
      assert.ok(visibleWidth(h.vt.getViewport()[pane]!) <= columns, `the pane header fits ${columns}`)
    }
    await key(h, '\r') // L0 -> L1
    if (columns >= 76) {
      const pane = h.rowsPlain().findIndex(line => line.includes('Rows (2)'))
      assert.ok(pane >= 0)
      assert.ok(visibleWidth(h.vt.getViewport()[pane]!) <= columns, `the rows pane header fits ${columns}`)
    }
    await key(h, '\r') // L1 -> the theme detail / inline choice
    assert.ok(h.view().includes('主题'), `the complete CJK value stays readable at ${columns}x${rows}:\n${h.view()}`)
    assertRowWidths(h, columns)
    h.dispose()
  }

  const h = setup({ columns: 120, rows: 24 })
  await h.openHome()
  let paneRow = h.rowsPlain().findIndex(line => line.includes('[Categories (8)]'))
  assert.ok(paneRow >= 0)
  assert.equal(h.vt.getCellFgRgb(paneRow, 0), hexToRgb(currentPalette.primary), 'the focused rail label uses primary')
  assert.equal(h.vt.getCellFgRgb(paneRow, cellIndexOf(h, paneRow, 'About')), hexToRgb(currentPalette.textDim),
    'the unfocused page label uses textDim')
  await key(h, '\t') // About content owns the keyboard
  paneRow = h.rowsPlain().findIndex(line => line.includes('[About]'))
  assert.ok(paneRow >= 0)
  assert.equal(h.vt.getCellFgRgb(paneRow, 0), hexToRgb(currentPalette.textDim))
  assert.equal(h.vt.getCellFgRgb(paneRow, cellIndexOf(h, paneRow, '[About]')), hexToRgb(currentPalette.primary))
  setTheme('light')
  h.app.requestRender(true)
  await h.vt.waitForRender()
  paneRow = h.rowsPlain().findIndex(line => line.includes('[About]'))
  assert.ok(paneRow >= 0)
  assert.equal(h.vt.getCellFgRgb(paneRow, cellIndexOf(h, paneRow, '[About]')), hexToRgb(currentPalette.primary),
    'the pane-header device follows the live light palette')
  h.dispose()
})


test('a content page below the body floor runs no hidden refresh and keeps its Esc back path', async () => {
  const models = setup({ columns: 120, rows: 24, providerOptions: SETTINGS_PROVIDERS })
  await models.open('Models')
  await key(models, '\t') // rail -> Models content
  models.vt.resize(120, 2)
  await models.vt.waitForRender()
  assert.match(models.rowsPlain().at(-1) ?? '', /Esc back/u)
  const modelReads = models.hostReads()
  await key(models, 'r')
  await key(models, 'c')
  await key(models, '\r')
  assert.equal(models.hostReads(), modelReads, 'the hidden Models refresh/copy/action ran no Host read')

  // A bodyFloor=1 fallback (120x3) must also reject the hidden refresh, both
  // before and after the fallback frame is painted.
  const shortModelReads = models.hostReads()
  models.vt.resize(120, 3)
  models.vt.sendInput('r') // before the resize frame: the old action grant is stale
  await models.vt.waitForRender()
  assert.match(models.rowsPlain().at(-1) ?? '', /Esc back/u)
  assert.equal(models.hostReads(), shortModelReads, 'the shrink-before-repaint r ran no Host read')
  await key(models, 'r')
  assert.equal(models.hostReads(), shortModelReads, 'the painted short fallback r ran no Host read')
  await key(models, '\u001b')
  assert.match(models.rowsPlain()[0]!, /Settings · Categories/u, 'Esc still returns to the rail')
  models.dispose()

  const account = setup({ columns: 120, rows: 24 })
  await account.open('Account')
  await key(account, '\t') // rail -> Account content
  account.vt.resize(120, 2)
  await account.vt.waitForRender()
  assert.match(account.rowsPlain().at(-1) ?? '', /Esc back/u)
  const accountReads = account.hostReads()
  await key(account, 'r')
  await key(account, '\r')
  assert.equal(account.hostReads(), accountReads, 'the hidden Account refresh/action ran no Host read')

  const shortAccountReads = account.hostReads()
  account.vt.resize(120, 3)
  account.vt.sendInput('r') // before the resize frame: the old action grant is stale
  await account.vt.waitForRender()
  assert.match(account.rowsPlain().at(-1) ?? '', /Esc back/u)
  assert.equal(account.hostReads(), shortAccountReads, 'the shrink-before-repaint Account r ran no Host read')
  await key(account, 'r')
  assert.equal(account.hostReads(), shortAccountReads, 'the painted short Account fallback r ran no Host read')
  await key(account, '\u001b')
  assert.match(account.rowsPlain()[0]!, /Settings · Categories/u, 'Esc still returns to the rail')
  account.dispose()

  // Add Provider catalog owns an editable filter: Backspace edits that query
  // when a body exists, so it must be dropped at the zero body grant.
  const catalog = setup({ columns: 120, rows: 24, providerOptions: SETTINGS_PROVIDERS })
  await catalog.open('Models')
  await key(catalog, '\t') // rail -> Models content
  const addRow = rowOf(catalog, 'Add Provider…')
  const addCol = cellIndexOf(catalog, addRow, 'Add Provider…')
  press(catalog, addRow, addCol)
  release(catalog, addRow, addCol)
  await settle(catalog)
  assert.match(catalog.view(), /Type to narrow the list\./u, 'the Add Provider catalog is open')
  for (const character of 'acme') await key(catalog, character)
  assert.match(catalog.view(), /Filter: acme/u, 'the visible filter holds the typed query')
  catalog.vt.resize(120, 2)
  await catalog.vt.waitForRender()
  assert.match(catalog.rowsPlain().at(-1) ?? '', /Esc clear filter/u,
    'the zero-body hint names the real Esc effect while the filter is non-empty')
  await key(catalog, '\u007f')
  catalog.vt.resize(120, 24)
  await catalog.vt.waitForRender()
  assert.match(catalog.view(), /Filter: acme/u, 'the hidden Backspace did not edit the invisible query')
  assert.match(catalog.view(), /Add Provider/u, 'the catalog page stayed mounted')

  // The truthful zero-body Esc performs exactly what it names: first it
  // clears the non-empty filter, then the same frame names the real back.
  catalog.vt.resize(120, 2)
  await catalog.vt.waitForRender()
  assert.match(catalog.rowsPlain().at(-1) ?? '', /Esc clear filter/u)
  await key(catalog, '\u001b')
  assert.match(catalog.rowsPlain().at(-1) ?? '', /Esc back/u,
    'after the clear, the zero-body hint is the real back')
  catalog.vt.resize(120, 24)
  await catalog.vt.waitForRender()
  assert.match(catalog.view(), /Add Provider/u, 'the catalog page stayed mounted after the clear')
  assert.doesNotMatch(catalog.view(), /Filter: acme/u, 'the advertised Esc clear really cleared the filter')

  // With an empty filter the zero-body Esc is a real back to the Models list.
  catalog.vt.resize(120, 2)
  await catalog.vt.waitForRender()
  assert.match(catalog.rowsPlain().at(-1) ?? '', /Esc back/u)
  await key(catalog, '\u001b')
  catalog.vt.resize(120, 24)
  await catalog.vt.waitForRender()
  assert.match(catalog.view(), /Models & Credentials/u, 'the advertised Esc back really left the catalog')
  catalog.dispose()

  const about = setup({ columns: 44, rows: 20 })
  await about.openHome()
  about.vt.resize(44, 2)
  await about.vt.waitForRender()
  const aboutReads = about.reads()
  await key(about, 'r')
  await key(about, 'c')
  await key(about, '\r')
  assert.equal(about.reads(), aboutReads, 'the hidden About refresh performed no settings read')
  assert.deepEqual(about.copied, [], 'the hidden copy keys are inert')
  await key(about, '\u001b')
  assert.match(about.rowsPlain()[0]!, /Settings · Categories/u, 'Esc still returns to the rail')
  about.dispose()
})


test('a resize that keeps the child grant still fails closed until the new terminal frame paints', async () => {
  // Legacy root: r re-reads the settings document. At 120×8 and 120×7 the
  // body budget is 4 both times, so only the terminal frame changed.
  const legacy = setup({ columns: 120, rows: 8 })
  await legacy.open('Appearance')
  const legacyReads = legacy.reads()
  legacy.vt.resize(120, 7)
  legacy.vt.sendInput('r') // before the resize frame: the old bar row is clipped
  await legacy.vt.waitForRender()
  assert.equal(legacy.reads(), legacyReads, 'the same-grant legacy resize rejects r before repaint')
  await key(legacy, 'r') // after repaint the visible bar authorizes it again
  assert.ok(legacy.reads() > legacyReads, 'the repainted frame really reads again')
  legacy.dispose()

  // Models list: the child grant is 4 at both heights; r would start a Host
  // catalog read from the clipped old bar row.
  const models = setup({ columns: 120, rows: 8, providerOptions: SETTINGS_PROVIDERS })
  await models.open('Models')
  await key(models, '\t') // rail -> Models content
  assert.match(models.rowsPlain().at(-1) ?? '', /r refresh/u)
  const modelReads = models.hostReads()
  models.vt.resize(120, 7)
  models.vt.sendInput('r')
  await models.vt.waitForRender()
  assert.equal(models.hostReads(), modelReads, 'the same-grant Models resize rejects the clipped r before repaint')
  await key(models, 'r')
  assert.ok(models.hostReads() > modelReads, 'the repainted Models bar authorizes the real refresh')
  models.dispose()

  // Models reference: the c-copy grant came from the old physical last row.
  const reference = setup({ columns: 120, rows: 8, providerOptions: SETTINGS_PROVIDERS })
  reference.invoke('login', 'ACME_API_KEY')
  await reference.vt.waitForRender()
  assert.match(reference.view(), /API Key Reference/u)
  assert.match(reference.rowsPlain().at(-1) ?? '', /c copy/u, 'the full-height frame advertises copy')
  const copied = reference.copied.length
  reference.vt.resize(120, 7)
  reference.vt.sendInput('c')
  await reference.vt.waitForRender()
  assert.equal(reference.copied.length, copied, 'the same-grant resize rejects the clipped copy grant before repaint')
  await key(reference, 'c')
  assert.equal(reference.copied.length, copied + 1, 'the repainted frame authorizes the real copy')
  reference.dispose()

  // The pointer boxes also describe the old terminal frame: a stale
  // press/release must not activate the old Models action row.
  const mouseModels = setup({ columns: 120, rows: 8, providerOptions: SETTINGS_PROVIDERS })
  await mouseModels.open('Models')
  await key(mouseModels, '\t')
  const mouseAddRow = rowOf(mouseModels, 'Add Provider…')
  const mouseAddCol = cellIndexOf(mouseModels, mouseAddRow, 'Add Provider…')
  mouseModels.vt.resize(120, 7)
  press(mouseModels, mouseAddRow, mouseAddCol)
  release(mouseModels, mouseAddRow, mouseAddCol)
  await settle(mouseModels)
  assert.doesNotMatch(mouseModels.view(), /Custom provider…/u,
    'the stale Models mouse gesture did not open the catalog')
  mouseModels.dispose()

  // The same guard covers the legacy Detail buttons.
  const mouseLegacy = setup({ columns: 120, rows: 8, doc: { theme: 'dark' } })
  await mouseLegacy.open('Appearance')
  await key(mouseLegacy, '\r') // rows level, Detail buttons painted
  const staleCopyRow = rowOf(mouseLegacy, 'Copy value [C]')
  const staleCopyCol = cellIndexOf(mouseLegacy, staleCopyRow, 'Copy value [C]')
  mouseLegacy.vt.resize(120, 7)
  press(mouseLegacy, staleCopyRow, staleCopyCol)
  release(mouseLegacy, staleCopyRow, staleCopyCol)
  await settle(mouseLegacy)
  assert.deepEqual(mouseLegacy.copied, [], 'the stale legacy Detail click did not copy')
  mouseLegacy.dispose()

  // Backspace is not a portable back key: the Add Provider catalog binds it to
  // its query. A same-grant resize must not let it edit the hidden filter.
  const catalog = setup({ columns: 120, rows: 8, providerOptions: SETTINGS_PROVIDERS })
  await catalog.open('Models')
  await key(catalog, '\t')
  const catalogAddRow = rowOf(catalog, 'Add Provider…')
  press(catalog, catalogAddRow, cellIndexOf(catalog, catalogAddRow, 'Add Provider…'))
  release(catalog, catalogAddRow, cellIndexOf(catalog, catalogAddRow, 'Add Provider…'))
  await settle(catalog)
  assert.match(catalog.view(), /Add Provider/u, 'the catalog is open at 8 rows')
  for (const character of 'acme') await key(catalog, character)
  catalog.vt.resize(120, 7)
  catalog.vt.sendInput('\u007f') // Backspace before the resize frame
  await catalog.vt.waitForRender()
  catalog.vt.resize(120, 24)
  await catalog.vt.waitForRender()
  assert.match(catalog.view(), /Filter: acme/u, 'the same-grant stale Backspace did not edit the hidden filter')
  catalog.dispose()

  // Account uses the same root fence: its r refresh is not admitted before the
  // new terminal frame paints.
  const account = setup({ columns: 120, rows: 8 })
  await account.open('Account')
  await key(account, '\t') // rail -> Account content
  const accountReads = account.hostReads()
  account.vt.resize(120, 7)
  account.vt.sendInput('r')
  await account.vt.waitForRender()
  assert.equal(account.hostReads(), accountReads, 'the same-grant Account resize rejects the clipped r before repaint')
  account.dispose()
})
