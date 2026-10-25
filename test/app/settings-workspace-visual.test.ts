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
import { registerTuiCommands, resolveComposerDelivery, type TuiCommandRunner } from '../../src/commands.ts'
import { installGitAttributionPrompt, type SystemPromptLike } from '../../src/app/direct/system-prompt.ts'
import { createNotificationRuntime } from '../../src/app/surface/notification-runtime.ts'
import { resolveSubmitDelivery } from '../../src/app/submission/command-policy.ts'
import { createSettingsRuntime } from '../../src/app/surface/settings-runtime.ts'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { TranscriptFolder } from '../../src/transcript.ts'
import { createTerminalNotificationPresentation } from '../../src/tui/notification/runtime.ts'
import { getKeybindings } from '@xmoon76/pi-tui'
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from '@xmoon76/pi-tui'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { TuiApp, type OwnedRunner, type TuiAppEvents } from '../../src/tui-app.ts'
import { color, currentPalette, setTheme } from '../../src/tui/theme/runtime.ts'
import { darkColors } from '../../src/domain/display/theme.ts'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { ThemeRegistry } from '../../src/extension/internal/theme-registry.ts'
import { SettingsRegistry } from '../../src/extension/internal/settings-registry.ts'
import { apply as applyExtensionHost, PI_TUI_EXTENSIONS_SERVICE } from '../../src/extensions.ts'
import { TUI_STARTUP_SERVICE } from '../../src/startup.ts'
import { createDirectSettingsFixture } from '../support/direct-settings-fixture.ts'
import { waitForFrame } from '../support/frame-wait.ts'
import { themePickerRows } from '../../src/app/surface/theme-selection.ts'
import type { CredentialProviderOption, TuiSettingsDoc, VisualToolsState } from '../../src/runtime/config-port.ts'
import { serializeTuiSettingsMutation } from '../../src/runtime/config-port.ts'
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
  /** The REAL in-process extension settings registry the workspace reads its
   *  conditional `Extensions` directory from. A case registers rows on it and
   *  drives the production `/settings` handler, or supplies the same instance
   *  the extension service owns. */
  settingsRegistry?: SettingsRegistry
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
  /** Make every `settings.get()` AFTER a completed write throw: a write that
   *  returned success whose authoritative re-read cannot be performed. */
  getFailureAfterWrite?: boolean
  /** The USER-layer footer definitions the persistence guard must preserve. */
  footerCustomItemsRaw?: unknown
  /**
   * Hold the NEXT document `replace` open until `releaseFirstReplace()` runs.
   * This is what makes a SECOND writer really QUEUE behind the first through
   * the production `serializeTuiSettingsMutation` instead of running after it
   * settled.
   */
  holdFirstReplace?: boolean
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
  /**
   * Compose a LIVE main Session for the About page: the exact seams the real
   * `/settings` command injects (`captureLiveSessionScope` / scope currency /
   * stats / projection / context) answer for this scope, so the About facts and
   * its `c` / `C` copy grants are reachable through the production chain.
   * Omitted = the sessionless home the other cases use.
   */
  liveSession?: {
    readonly sessionId: string
    readonly title?: string
    readonly cwd?: string
    readonly turns?: number
    readonly contextUsed?: number
    /** Replace the About controller's scoped stats read (a controlled
     *  republish/currentness seam). */
    readonly currentSessionStats?: () => Promise<{ lifetime: { turns: number; steps: number; llmMs: number } }>
  }
  /**
   * C2-R3: the REAL Agent authorities this composition reads and writes. Every
   * value lives on the object handed in, so a case can prove the downstream
   * effect on the SAME instance the production seam consumes (never on a UI
   * copy): the session approval override, the Host permission default, the
   * official subagent model-selection section and the official model directory.
   */
  agent?: {
    /** The live session scope the workspace pins (absent = sessionless). */
    readonly sessionId?: string
    /** Whether the pinned scope is still current (a session switch flips it). */
    readonly scopeCurrent?: () => boolean
    /** The approval capability (Remote compositions answer false). */
    readonly approvalAvailable?: boolean
    /** The official per-session approval override the service really holds. */
    readonly approval?: { value: 'ask' | 'never' | undefined }
    /** The Host permission roster, in Host order. */
    readonly permissionNames?: readonly string[]
    /** The Host's effective default for new sessions. */
    readonly permissionDefault?: { value: string | undefined }
    /** The official subagent model-selection section (absent = unavailable). */
    readonly subagent?: {
      enabled: boolean
      allowedModels: { provider: string; model: string }[]
    }
    /**
     * Hold every official subagent section write until the returned promise
     * settles: the ONLY way a case can observe a real in-flight section write
     * (the production queue serializes on it).
     */
    readonly gateSectionWrite?: () => Promise<void>
    /** The official grouped model directory the allowlist picker reads. */
    readonly directory?: readonly {
      readonly id: string
      readonly name: string
      readonly models: readonly { readonly id: string; readonly name?: string }[]
    }[]
  }
  /** The icon style the REAL `TuiApp` starts with (the composition's persisted
   *  read). Omitted = the app's own default. */
  iconStyle?: 'emoji' | 'symbols' | 'minimal'
  /**
   * C2-R2 joined proof: when supplied, the runner's notification read/write
   * seams are delegated to THIS real owner instead of the harness's local
   * variables. The caller hands over the ONE `NotificationRuntime` it composed
   * (over the real terminal presentation), so a case can assert the real
   * `CompletionNotificationController` and the real terminal bytes.
   */
  notificationRuntime?: {
    setMode(mode: string): void
    setMethod(method: string): void
    currentMode(): 'unfocused' | 'always' | 'off'
    currentMethod(): 'auto' | 'osc9' | 'osc777' | 'bell'
    setCompletionOwner(identity: string | undefined): void
    onAgentStatus(agentId: string, status: 'idle' | 'running'): void
  }
  /** The terminal-progress mode the REAL `TuiApp` starts with (the boot read). */
  appTerminalProgress?: 'off' | '9;4' | '7501' | '9;4+7501'
  /** Whether the REAL `TuiApp` is already in fullscreen before the workspace opens. */
  appFullscreen?: boolean
  /**
   * A caller-owned Git attribution state. A case that installs the REAL prompt
   * section BEFORE the confirm must hand the SAME object in, so the section's
   * provider reads what the writer mutates.
   */
  gitAttributionState?: { mode: 'off' | 'product' | 'product-model' }
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
  /** The runner's LIVE prompt policy objects (the same ones the providers read). */
  readonly progressUpdatesState: { mode: 'off' | 'milestones' | 'frequent' }
  readonly responseStyleState: { style: 'default' | 'concise' | 'explanatory' }
  /** C2-R2: the ONE shared Git attribution state the prompt section reads. */
  readonly gitAttributionState: { mode: 'off' | 'product' | 'product-model' }
  /** C2-R2: a live fullscreen-change probe the app really invokes. */
  readonly setOnFullscreenChange: (listener: (fullscreen: boolean) => void) => () => void
  /** How many times the live fullscreen-change callback really ran. */
  readonly fullscreenChanges: () => number
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
  /** C2-R2: every notification mode/method the runner's controller was handed. */
  readonly notificationWrites: () => readonly string[]
  /** C2-R2: every terminal-progress mode the mounted surface was handed. */
  readonly terminalProgressWrites: () => readonly string[]
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
  /** The LIVE Agent authorities this composition reads and writes. */
  readonly agent: NonNullable<HarnessOptions['agent']>
  /** Every official subagent section write, in dispatch order. */
  readonly subagentWrites: () => readonly { enabled: boolean; allowedModels: readonly { provider: string; model: string }[] }[]
  /** Every Host permission-default write, in dispatch order. */
  readonly permissionWrites: () => readonly string[]
  /** The LIVE official subagent section the harness's seam serves. */
  readonly subagentSection: () => { enabled: boolean; allowedModels: readonly { provider: string; model: string }[] } | undefined
  /** Every user-facing notice the app really emitted. */
  readonly notices: () => readonly string[]
  /** Move the LIVE backend readiness the ConfigPort answers. */
  readonly setReadiness: (next: 'ready' | 'stale' | 'unavailable') => void
  /** Resolves once the held first document write really started. */
  readonly firstWriteStarted: () => Promise<void>
  /** Release the held first document write. */
  readonly releaseFirstReplace: () => void
  readonly dispose: () => void
}

/** The painted category order of the Settings rail (the harness walks it). The
 *  conditional `Extensions` category is appended only while the extension
 *  settings registry has live rows, so a case that needs it walks by label. */
const CATEGORY_ORDER = [
  'About', 'Models', 'Account', 'Agent', 'Appearance',
  'Conversation', 'Input & Terminal', 'Tools', 'Plugins',
]

/** Whether the painted frame shows the Settings category rail. A narrow
 *  terminal paints the single-column category list OR the About content, so
 *  the rail's own labels are the witness. */
const railVisible = (vt: VirtualTerminal): boolean =>
  vt.getViewport().map(stripTerminalSequences)
    .some(line => /^(?:> | {2})(?:About|Models|Account|Agent|Appearance|Conversation|Input & Terminal|Tools|Plugins|Extensions)(?: {2,}|\s*$)/u.test(line))

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
  /** The LIVE backend readiness the ConfigPort answers (a case can move it). */
  let readiness = options.readiness ?? 'ready'
  let externalVisualChange = options.visualToolsExternalChange
  let visualState: VisualToolsState | undefined = options.visualToolsUnavailable === true
    ? undefined
    : options.visualTools ?? { enabled: true, revision: 1, userOverridden: false, applied: true }
  const doc: TuiSettingsDoc = { ...DEFAULT_DOC, ...options.doc }
  // C2-R3: the Agent authorities. The MUTABLE parts are the objects the case
  // handed in (a seam reads them on every call), so a write is observable on
  // the exact instance the production consumer would read.
  const agent = options.agent ?? {}
  const subagentWrites: { enabled: boolean; allowedModels: { provider: string; model: string }[] }[] = []
  const permissionWrites: string[] = []
  const approvalState = agent.approval ?? { value: undefined as 'ask' | 'never' | undefined }
  let subagentSection = agent.subagent === undefined
    ? undefined
    : { enabled: agent.subagent.enabled, allowedModels: agent.subagent.allowedModels.map(route => ({ ...route })) }
  /** Whether a replace already ran: the configured re-read failure only applies
   *  to the readback of a COMPLETED write. */
  let wroteOnce = false
  /** The first held `replace` dispatch (the concurrency witness releases it). */
  let releaseFirstReplace: (() => void) | undefined
  let firstReplaceStarted: (() => void) | undefined
  const firstReplaceRunning = options.holdFirstReplace === true
    ? new Promise<void>(resolve => { firstReplaceStarted = resolve })
    : undefined
  let heldReplaceOpen = options.holdFirstReplace === true
  let firstReplaceGate: Promise<void> | undefined = options.holdFirstReplace === true
    ? new Promise<void>(resolve => { releaseFirstReplace = resolve })
    : undefined
  // The TWO live prompt-state objects the runner owns and the R1 writers mutate.
  // They are the SAME objects the registered SystemPrompt providers read.
  const progressUpdatesState = { mode: 'milestones' as const } as { mode: 'off' | 'milestones' | 'frequent' }
  const responseStyleState = { style: 'default' as const } as { style: 'default' | 'concise' | 'explanatory' }
  // C2-R2: the ONE shared Git attribution state the registered prompt section
  // reads. The writer mutates THIS object in place, so a read-back proves the
  // same authority changed rather than a copy.
  const gitAttributionState = options.gitAttributionState
    ?? { mode: 'off' as 'off' | 'product' | 'product-model' }
  // C2-R2: the ONE completion controller the runner owns. This fixture keeps
  // its live mode/method so the Snapshot's read-only facts are the REAL applied
  // values (setNotificationMode/Method are the only writers).
  let notificationMode = 'unfocused'
  let notificationMethod = 'auto'
  const notificationWrites: string[] = []
  const terminalProgressWrites: string[] = []
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
  /** C2-R2: the live fullscreen-change probe (the app invokes THIS callback). */
  let fullscreenChanges = 0
  const setOnFullscreenChange = (listener: (fullscreen: boolean) => void): (() => void) => {
    events.onFullscreenChange = (fullscreen: boolean) => {
      fullscreenChanges += 1
      listener(fullscreen)
    }
    return () => { delete events.onFullscreenChange }
  }
  const originalWrite = vt.write.bind(vt)
  vt.write = (data: string): void => { writes.push(data); originalWrite(data) }
  const notices: string[] = []
  const app = new TuiApp(vt, events, {
    copySelection: options.copySelection ?? (async (text: string) => { copied.push(text); return true }),
    ...options.iconStyle === undefined ? {} : { iconStyle: options.iconStyle },
    ...options.appTerminalProgress === undefined ? {} : { terminalProgressMode: options.appTerminalProgress },
  })
  // The commands notify through the REAL app sink: record what it was really
  // asked to tell the user (a refusal must reach them, not only the Detail).
  {
    const originalNotify = app.notify.bind(app)
    app.notify = (message: string, kind?: 'info' | 'error') => {
      notices.push(message)
      originalNotify(message, kind)
    }
  }
  app.start()
  if (options.appFullscreen === true) app.setFullscreen(true)
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
    progressUpdatesState,
    responseStyleState,
    gitAttributionState,
    // C2-R2: the runner's REAL notification/preferences write seams. The
    // Settings workspace reads their live facts back, so these stubs must
    // actually store what they were handed.
    setNotificationMode: (mode: string) => {
      notificationWrites.push(`mode:${mode}`)
      if (options.notificationRuntime !== undefined) options.notificationRuntime.setMode(mode)
      else notificationMode = mode
    },
    setNotificationMethod: (method: string) => {
      notificationWrites.push(`method:${method}`)
      if (options.notificationRuntime !== undefined) options.notificationRuntime.setMethod(method)
      else notificationMethod = method
    },
    currentNotificationMode: () => options.notificationRuntime?.currentMode() ?? notificationMode,
    currentNotificationMethod: () => options.notificationRuntime?.currentMethod() ?? notificationMethod,
    setTerminalProgressMode: (mode: string) => {
      terminalProgressWrites.push(mode)
      // The REAL mounted surface receives the parsed selection, exactly as the
      // production `SurfaceRuntime` seam does.
      app.setTerminalProgressMode(mode as Parameters<TuiApp['setTerminalProgressMode']>[0])
    },
    signal: new AbortController().signal,
    commandRegistry: commands,
    clientCommands: createClientCommandRegistry(parseCommand),
    recordExtensionError: () => {},
    clearExtensionError: () => {},
    captureExtensionHealthRef: () => () => {},
    // A sessionless surface: the completion install and the legacy session rows
    // must see no live scope. A `liveSession` composition replaces these About
    // seams below with the ones the real `/settings` command injects.
    // C2-R3: the Agent-authority session (an explicit `agent.sessionId`) takes
    // precedence, so an Agent case can pin the scope without composing About
    // statistics; `liveSession` remains the About composition.
    currentSessionId: options.liveSession?.sessionId ?? agent.sessionId,
    captureLiveSessionScope: () => {
      const sessionId = agent.sessionId ?? options.liveSession?.sessionId
      return sessionId === undefined ? undefined : { sessionId, generation: 1 }
    },
    // C3 About seams (this suite's stub composes no StatusRuntime): the
    // sessionless capture answers `unavailable` and no listener ever fires.
    isSessionScopeCurrent: () => (agent.scopeCurrent?.() ?? true) && (options.liveSession !== undefined || agent.sessionId !== undefined),
    currentSessionStats: options.liveSession?.currentSessionStats
      ?? (async () => options.liveSession === undefined ? undefined : {
        lifetime: {
          turns: options.liveSession.turns ?? 3,
          steps: 1,
          llmMs: 1_000,
        },
      }),
    sessionReader: {
      measureContext: () => options.liveSession?.contextUsed,
      sessionStatus: (sessionId: string) => options.liveSession === undefined
        ? undefined
        : { sessionId, cwd: options.liveSession.cwd ?? '/ws', title: options.liveSession.title },
    },
    forceContextMeasurementResult: () => options.liveSession?.contextUsed === undefined
      ? { value: undefined, observation: 'unavailable' as const }
      : { value: options.liveSession.contextUsed, observation: 'fresh' as const },
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
    // C2-R3: the official per-session approval override, read and written on
    // the SAME captured scope. A stale scope is refused exactly like the
    // production surface facade does.
    currentApprovalOverride: (scope: { sessionId: string }) => {
      if (!(agent.scopeCurrent?.() ?? true)) return undefined
      return approvalState.value
    },
    setSessionApprovalPolicy: (scope: { sessionId: string }, value: 'ask' | 'never') => {
      calls.push(`approval:${scope.sessionId}:${value}`)
      if (!(agent.scopeCurrent?.() ?? true)) return 'superseded'
      approvalState.value = value
      return 'applied'
    },
    tuiSettings: options.settingsService === false
      ? undefined
      : options.tuiSettings ?? {
          get: () => {
            reads += 1
            if (options.throwOnGet === true) throw new Error('settings read exploded')
            if (options.getFailureAfterWrite === true && wroteOnce) {
              throw new Error('the settings document became unreadable')
            }
            return doc
          },
          replace: (next: TuiSettingsDoc) => {
            replacements += 1
            replaced.push(next)
            wroteOnce = true
            if (heldReplaceOpen && firstReplaceGate !== undefined) {
              // The FIRST document write stays in flight; anything after it runs
              // only once this resolves.
              heldReplaceOpen = false
              firstReplaceStarted?.()
              const gate = firstReplaceGate
              firstReplaceGate = undefined
              return gate.then(() => {
                if (options.applyReplace === undefined) Object.assign(doc, next)
                else return options.applyReplace(next)
              })
            }
            if (options.applyReplace === undefined) Object.assign(doc, next)
            else return options.applyReplace(next)
          },
        },
    // The Settings workspace reads the LIVE extension-settings directory on
    // every snapshot; the registry here is the real in-process owner.
    extensions: options.themes === undefined && options.settingsRegistry === undefined
      ? undefined
      : { themes: options.themes ?? new ThemeRegistry(), settings: options.settingsRegistry ?? new SettingsRegistry() },
    createPluginManagerPage: (onYieldNavigation: () => void) => {
      if (options.pluginPage !== true) return undefined
      pluginPages += 1
      const page = new FakeEmbeddedPluginPage(onYieldNavigation)
      pluginPageInstances.push(page)
      return page
    },
    config: {
      configReadiness: () => readiness,
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
      footerCustomItems: {
        rawForPersistence: () => ({ kind: 'available' as const, value: options.footerCustomItemsRaw }),
      },
      // The REAL Agent authorities: the workspace reads them on every snapshot
      // and its writers mutate exactly these objects.
      permissions: {
        presetNames: () => agent.permissionNames ?? [],
        defaultPreset: () => agent.permissionDefault?.value,
        setDefaultPreset: async (name: string) => {
          permissionWrites.push(name)
          if (agent.permissionDefault === undefined) throw new Error('settings service unavailable')
          agent.permissionDefault.value = name
        },
        approvalOverrideOf: (sessionId: string) => sessionId === agent.sessionId ? approvalState.value : undefined,
        approvalOverrideAvailable: () => agent.approvalAvailable ?? false,
      },
      subagentModelSelection: {
        available: () => subagentSection !== undefined,
        get: () => subagentSection === undefined
          ? { enabled: false, allowedModels: [] }
          : { enabled: subagentSection.enabled, allowedModels: subagentSection.allowedModels.map(route => ({ ...route })) },
        set: async (value: { enabled: boolean; allowedModels: readonly { provider: string; model: string }[] }) => {
          await agent.gateSectionWrite?.()
          subagentWrites.push({ enabled: value.enabled, allowedModels: value.allowedModels.map(route => ({ ...route })) })
          if (subagentSection === undefined) throw new Error('settings service unavailable')
          subagentSection = { enabled: value.enabled, allowedModels: value.allowedModels.map(route => ({ ...route })) }
        },
      },
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
    catalog: {
      models: {
        available: () => agent.subagent !== undefined && agent.directory !== undefined,
        loadDirectory: async () => ({
          default: { provider: 'p', model: 'm' },
          routableProviders: (agent.directory ?? []).map(group => group.id),
          groups: (agent.directory ?? []).map(group => ({ id: group.id, name: group.name, models: group.models })),
          failures: [],
        }),
      },
    },
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
    agent,
    subagentWrites: () => subagentWrites,
    permissionWrites: () => permissionWrites,
    subagentSection: () => subagentSection,
    notices: () => notices,
    progressUpdatesState,
    responseStyleState,
    gitAttributionState,
    setOnFullscreenChange,
    fullscreenChanges: () => fullscreenChanges,
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
    notificationWrites: () => notificationWrites,
    terminalProgressWrites: () => terminalProgressWrites,
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
    setReadiness: (next: 'ready' | 'stale' | 'unavailable') => { readiness = next },
    /** Resolves once the first held document write really started. */
    firstWriteStarted: () => firstReplaceRunning ?? Promise.resolve(),
    /** Release the held first document write. */
    releaseFirstReplace: () => { releaseFirstReplace?.() },
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
  // The pane starts at the header's active device (`[Rows (…)`) or at the bare
  // label when it is not the focused pane.
  const label = header.indexOf('Rows (')
  const start = header[label - 1] === '[' ? label - 1 : label
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
  assert.match(h.view(), /Rows \(3\)/, 'the row list column is part of the workspace body')
  h.dispose()
})

// ── A-02 / A-03: the wide and medium projections ──────────────────────────

test('A-02 200x60 and 160x40 paint the three-column projection with the real value/source facts', async () => {
  for (const [columns, rows] of [[200, 60], [160, 40]] as const) {
    const h = setup({ columns, rows, doc: { theme: 'plugin:acme/solarized' }, themes: pluginThemes() })
    await h.open()
    const paneRow = rowOf(h, 'Categories (9)')
    const paneLine = h.rowsPlain()[paneRow]!
    assert.match(paneLine, /Rows \(3\)/, 'the middle column is the current category rows')
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
  assert.match(h.rowsPlain()[rowOf(h, 'Categories (9)')]!, /\[Categories \(9\)\]/, 'L0 owns the categories level')
  assert.ok(h.rowsPlain().some(line => line.includes('Rows (3)')), `the rows column exists:\n${h.view()}`)
  assert.ok(!h.view().includes('Details'), 'L0 does not paint the Detail column')
  assert.ok(!h.view().includes('←'), 'no medium header category arrows')
  // The categories level moves with ↑↓.
  await key(h, '\x1b[B')
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Conversation')), `Down selects the next category:\n${h.view()}`)
  await key(h, '\x1b[A')
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Appearance')))
  // Enter advances to L1: rows + detail, no categories column.
  await key(h, '\r')
  assert.match(h.rowsPlain()[rowOf(h, 'Details')]!, /Details/, 'L1 paints the Detail column')
  assert.ok(!h.view().includes('Categories (9)'), 'L1 hides the categories column')
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
  const before = h.rowsPlain()[rowOf(h, 'Rows (3)')]!
  assert.match(before, /\[Rows \(3\)\]/, 'the Rows pane owns focus before editing')
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
  await key(h, '\x1b[B') // Appearance -> Conversation on the categories level
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Conversation')))
  await key(h, '\r') // L0 -> L1
  assert.match(h.rowsPlain()[0]!, /Settings · Conversation · Rows/)
  await key(h, '\r') // L1 -> L2 (detail)
  assert.match(h.rowsPlain()[0]!, /Settings · Conversation · Transcript display/)
  h.vt.resize(72, 24)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /Settings · Conversation · Transcript d/, 'the level, category and row survive the narrow resize')
  h.vt.resize(44, 24)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /Transcript d/, 'the selected row survives the resize')
  h.vt.resize(200, 40)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /Settings · Conversation · Transcript display/, 'the wide projection returns on the same detail context')
  assert.match(h.view(), /Transcript display/, 'the narrow detail level upgrades to the same row')
  assertRowWidths(h, 200)
  h.dispose()
})

// ── A-07: hostile external text ───────────────────────────────────────────

test('A-07 hostile OSC/CSI/CJK theme text is sanitized before paint and never reaches the clipboard', async () => {
  const hostile = `evil\x1b[31mred\x07payload-${'汉'.repeat(60)}`
  const h = setup({ columns: 100, rows: 24, doc: { theme: hostile } })
  await h.open()
  await key(h, '\r') // L0 -> L1 exposes the real Details pane
  const plain = h.view()
  assert.ok(!plain.includes('\x1b'), 'no raw escape sequence may reach the terminal text')
  assert.ok(!plain.includes('[31m'), 'the CSI sequence must be stripped whole, never left as visible payload')
  assertRowWidths(h, 100)
  assert.match(plain, /evilredpayload/u, 'the sanitized source text stays visible')
  // RAW terminal-write safety: the terminal's own write sink is the witness (a
  // parsed viewport would already have interpreted the sequences). The whole
  // hostile value must never be emitted, nor its raw CSI/BEL/C1 bytes.
  const emitted = h.writes().join('')
  assert.ok(!emitted.includes(hostile), 'the raw hostile value must never reach the terminal')
  assert.ok(!emitted.includes('\x1b[31m'), 'the injected CSI must never reach the terminal')
  assert.ok(!emitted.includes('\x07payload'), 'the injected BEL must never reach the terminal')
  assert.ok(!emitted.includes('\u009b'), 'the injected C1 byte must never reach the terminal')
  // PR3: the Legacy Detail has no Copy verb at all — the retired `Copy value
  // [C]` is unevictable AND the copy keys deliver nothing to the clipboard.
  assert.ok(!h.view().includes('Copy value [C]'), `no Legacy copy brand paints:\n${h.view()}`)
  for (const data of ['c', 'C', '\x1b[99u', '\x1b[99:67:99;2u', '\x1b[27;2;67~']) await key(h, data)
  await settle(h)
  assert.deepEqual(h.copied, [], 'the Legacy row never reaches the clipboard')
  assert.equal(h.replacements(), 0, 'and no copy gesture writes the document')
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
  await key(h, '\x1b[B') // Appearance -> Conversation (its first row is Transcript display)
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

test('A-10 About c copies the exact selected fact and its settlement is visible inside the workspace', async () => {
  const h = setup({ columns: 140, rows: 40, liveSession: { sessionId: 'sess-a10', title: 'a10 proof', contextUsed: 1_000 } })
  await h.openHome()
  await key(h, '\r') // rail -> About content
  const frame = h.view()
  assert.ok(!frame.includes('Copy [C]'), `no per-fact Copy badge:\n${frame}`)
  assert.equal(frame.match(/Copy All \[C\]/gu)?.length, 1, `exactly one Copy All badge:\n${frame}`)
  // Select the Title fact (runtime trio, Session ID, Title) and copy it.
  for (let step = 0; step < 4; step += 1) await key(h, '\x1b[B')
  await key(h, 'c')
  await settle(h)
  assert.deepEqual(h.copied, ['a10 proof'], 'the payload is the raw About fact value')
  assert.ok(h.rowsPlain().some(line => line.includes('Copy sent')), `the notice is painted inside the workspace:\n${h.view()}`)
  h.dispose()
})

test('A-10d Legacy choosing and settled Detail never copy, under raw and encoded copy keys', async () => {
  const encodedCopyKeys = ['c', 'C', '\x1b[99u', '\x1b[99:67:99;2u', '\x1b[27;2;67~'] as const
  for (const columns of [72, 44, 30] as const) {
    // A plain palette: this case confirms a real write, and the fixture's theme
    // registry deliberately carries a partial palette.
    const h = setup({ columns, rows: 24, doc: { theme: 'dark' } })
    await h.open()
    await key(h, '\x1b[C') // Categories -> Rows
    await key(h, '\x1b[C') // Rows -> inline choice
    assert.ok(h.view().includes('Choose value'), `the keyboard path reaches choosing at ${columns}:\n${h.view()}`)
    assert.ok(!h.rowsPlain().at(-1)!.includes('c copy'), `no copy hint in choosing at ${columns}:\n${h.view()}`)
    for (const data of encodedCopyKeys) await key(h, data)
    await settle(h)
    assert.deepEqual(h.copied, [], `choosing copies nothing at ${columns}`)
    assert.ok(h.view().includes('Choose value'), `the choice survives the copy keys at ${columns}`)
    assert.equal(h.replacements(), 0, 'no copy key commits a candidate')

    // The whole session's copy surface is still empty after a real Confirm.
    await key(h, '\r')
    await settle(h)
    assert.equal(h.replacements(), 1, `the source fixture reaches settled Detail at ${columns}`)
    assert.ok(!h.view().includes('c copy value'), `settled Detail advertises no copy at ${columns}`)
    for (const data of encodedCopyKeys) await key(h, data)
    await settle(h)
    assert.deepEqual(h.copied, [], `settled Detail copies nothing at ${columns}`)
    assert.equal(h.replacements(), 1, 'no copy key adds a write')
    h.dispose()
  }
})

test('A-10e About c/C accept raw, Kitty and modifyOtherKeys printable events', async () => {
  // Each encoded event is one whole press of the same semantic key: `c` for the
  // selected fact, the Shift+C form for the whole report.
  const factKeys = ['c', '\x1b[99u'] as const
  const allKeys = ['C', '\x1b[99:67:99;2u', '\x1b[27;2;67~'] as const
  for (const encodedKey of factKeys) {
    const h = setup({ columns: 100, rows: 30, liveSession: { sessionId: 'sess-a10e', title: 'a10e proof' } })
    await h.openHome()
    await key(h, '\r') // rail -> About content
    assert.match(h.view(), /c copy fact/u, `the fact key is advertised:\n${h.view()}`)
    await key(h, encodedKey)
    await settle(h)
    assert.deepEqual(h.copied, ['0.5.3'], `the encoded fact key copies the selected raw value (${JSON.stringify(encodedKey)})`)
    h.dispose()
  }
  for (const encodedKey of allKeys) {
    const h = setup({ columns: 100, rows: 30, liveSession: { sessionId: 'sess-a10e', title: 'a10e proof' } })
    await h.openHome()
    await key(h, '\r') // rail -> About content
    await key(h, encodedKey)
    await settle(h)
    assert.equal(h.copied.length, 1, `the encoded Copy All key copies once (${JSON.stringify(encodedKey)})`)
    assert.match(h.copied[0]!, /Session ID: sess-a10e/u, 'the report is the painted About serialization')
    h.dispose()
  }
})

test('A-10f a copy key never edits a Legacy document at any level', async () => {
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
    assert.ok(!h.view().includes('c copy value'), `ordinary Detail advertises no copy verb:\n${h.view()}`)
    await key(h, encodedKey)
    await settle(h)
    assert.deepEqual(h.copied, [], 'the encoded copy key copies nothing')
    assert.equal(h.replacements(), 1, 'the copy key never adds a settings write')
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
  let copyRequests = 0
  const h = setup({
    columns: 100,
    rows: 24,
    liveSession: { sessionId: 'sess-late', title: 'late settlement' },
    copySelection: async (text: string) => {
      copyRequests += 1
      h.copied.push(text)
      return new Promise<boolean>(resolve => { settleCopy = resolve })
    },
  })
  await h.openHome()
  await key(h, 'C') // the rail-focused About Copy All (the real Client sink)
  await settle(h)
  assert.equal(copyRequests, 1, 'the About Copy All really reached the clipboard strategy')
  assert.match(h.copied[0] ?? '', /Session ID: sess-late/u, 'the payload is the painted About report')
  await key(h, '\x1b') // close the workspace before the clipboard settles
  assert.ok(h.view().includes('❯'), 'the editor is restored')
  settleCopy?.(true)
  await settle(h)
  assert.equal(h.app.notifyTextForTest(), '', 'a stale copy must not notify the new surface')
  assert.equal(copyRequests, 1, 'the clipboard strategy ran exactly once')
  h.dispose()
})

// ── A-11: the legacy compatibility bridge ─────────────────────────────────

test('A-11 Agent paints only the five availability-gated rows and no legacy launcher', async () => {
  const h = setup({
    columns: 140,
    rows: 44,
    doc: { theme: 'dark' },
    agent: {
      sessionId: 'session-live',
      approvalAvailable: true,
      approval: { value: undefined },
      permissionNames: ['workspace-write', 'danger-full-access'],
      permissionDefault: { value: 'workspace-write' },
      subagent: { enabled: false, allowedModels: [] },
      directory: [{ id: 'p', name: 'P', models: [{ id: 'm1' }] }],
    },
  })
  await h.open('Agent')
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Agent')), `the Agent category is selected:\n${h.view()}`)
  await key(h, '\r') // L0 -> L1 (the Agent rows level)
  assert.match(h.rowsPlain()[0]!, /Settings · Agent · Rows/)
  const rows = h.rowsPlain()
  const order = ['Approval policy (this session)', 'Default permission', 'Subagent allowed models', 'Subagent model selection', 'User shell sandbox policy']
    .map(label => rows.findIndex(line => line.includes(label)))
  for (const [index, row] of order.entries()) {
    assert.ok(row >= 0, `Agent paints ${JSON.stringify(order[index])}:\n${h.view()}`)
  }
  assert.deepEqual([...order].sort((left, right) => left - right), order, 'the Agent rows keep the frozen order')
  assert.doesNotMatch(h.view(), /Agent settings…/u, 'the legacy launcher is retired')
  // Browsing the rows (L1 -> L2 back) writes nothing at all.
  assert.equal(h.replacements(), 0, 'reading the Agent rows writes no document')
  assert.deepEqual(h.subagentWrites(), [], 'reading the Agent rows writes no official section')
  assert.deepEqual(h.permissionWrites(), [], 'reading the Agent rows writes no Host permission default')
  // The approval row states an override-less session as such — never a saved
  // `ask` it never read.
  await key(h, '\r') // Enter the approval Detail (and its choice)
  const approval = h.view()
  assert.match(approval, /not overridden/u, `an absent override is stated, not faked:\n${approval}`)
  assert.match(approval, /consumer fallback ask/u, 'the consumer fallback is named as the runtime effect')
  assert.match(approval, /not applicable — current session only/u, 'the persisted half is explicitly not applicable')
  h.dispose()
})

test('A-11b Agent hides the approval and delegation rows when their authority is absent', async () => {
  // Sessionless Direct with the capability present: no session-scoped row.
  const sessionless = setup({
    columns: 140,
    rows: 44,
    agent: { approvalAvailable: true, permissionNames: ['workspace-write'], permissionDefault: { value: 'workspace-write' } },
  })
  await sessionless.open('Agent')
  await key(sessionless, '\r')
  assert.doesNotMatch(sessionless.view(), /Approval policy \(this session\)/u, 'a sessionless surface paints no approval row')
  assert.match(sessionless.view(), /Default permission/u, 'the Host-authority rows do not need a Session')
  assert.match(sessionless.view(), /User shell sandbox policy/u, 'the document row does not need a Session')
  assert.doesNotMatch(sessionless.view(), /Subagent (?:allowed models|model selection)/u, 'no official section means no delegation rows')
  sessionless.dispose()

  // A live session on a backend WITHOUT the approval capability (Remote): the
  // row is absent rather than rendered as a saved `ask`.
  const remote = setup({
    columns: 140,
    rows: 44,
    agent: {
      sessionId: 'session-live',
      approvalAvailable: false,
      permissionNames: ['workspace-write'],
      permissionDefault: { value: 'workspace-write' },
    },
  })
  await remote.open('Agent')
  await key(remote, '\r')
  assert.doesNotMatch(remote.view(), /Approval policy \(this session\)/u, 'no capability means no approval row')
  remote.dispose()

  // An empty Host roster paints no default-permission row at all.
  const emptyRoster = setup({
    columns: 140,
    rows: 44,
    agent: { sessionId: 'session-live', approvalAvailable: true, permissionNames: [], permissionDefault: { value: undefined } },
  })
  await emptyRoster.open('Agent')
  await key(emptyRoster, '\r')
  assert.doesNotMatch(emptyRoster.view(), /Default permission/u, 'an empty roster paints no default-permission row')
  assert.match(emptyRoster.view(), /User shell sandbox policy/u, 'the other rows stay reachable')
  emptyRoster.dispose()
})

// ── C2-R3: the Agent writers, end to end through the real workspace keys ──

/**
 * Walk the Agent row cursor to `label` WITHOUT leaving the open workspace
 * (the caller already sits on the Agent Rows level).
 */
async function openRowInAgent(h: Harness, label: string): Promise<void> {
  for (let step = 0; step < 8 && !agentSelectedRowLabel(h).includes(label); step += 1) {
    await key(h, '\x1b[B')
  }
  assert.match(agentSelectedRowLabel(h), new RegExp(`^${label.slice(0, 18)}`, 'u'),
    `the Agent row ${JSON.stringify(label)} was reached:\n${h.view()}`)
}

/**
 * The selected Agent row as the frame paints it. The cursor lives inside the
 * Rows pane, whose column depends on the projection, so the pane's own painted
 * header supplies the offset; only cells INSIDE that pane are read (the
 * category rail has its own cursor).
 */
function agentSelectedRowLabel(h: Harness): string {
  const lines = h.rowsPlain()
  const header = lines.find(candidate => candidate.includes('Rows ('))
  assert.ok(header !== undefined, `the Agent rows pane header must be painted:\n${h.view()}`)
  const label = header.indexOf('Rows (')
  // The active-device bracket `[` belongs to the pane title, not to its cells.
  const start = header[label - 1] === '[' ? label - 1 : label
  const detailAt = header.indexOf('Details', start)
  const end = detailAt < 0 ? undefined : detailAt - 2
  for (const line of lines) {
    const pane = line.slice(start, end)
    if (/^\s{0,2}> /u.test(pane)) return pane.replace(/^\s*> /u, '').trimEnd()
  }
  assert.fail(`the Agent rows pane paints no cursor:\n${h.view()}`)
}

/** Open the workspace on the Agent rows and walk the row cursor to `label`. */
async function openAgentRow(h: Harness, label: string): Promise<void> {
  await h.open('Agent')
  await key(h, '\r') // L0 -> L1
  for (let step = 0; step < 8; step += 1) {
    if (agentSelectedRowLabel(h).includes(label)) return
    await key(h, '\x1b[B')
  }
  assert.fail(`the Agent row ${JSON.stringify(label)} was never reached:\n${h.view()}`)
}

test('R3-01 confirming a permission preset writes the Host default and never the current session', async () => {
  const h = setup({
    columns: 120,
    rows: 40,
    agent: {
      sessionId: 'session-live',
      approvalAvailable: true,
      approval: { value: 'ask' },
      permissionNames: ['workspace-write', 'danger-full-access'],
      permissionDefault: { value: 'workspace-write' },
    },
  })
  await openAgentRow(h, 'Default permission')
  await key(h, '\r') // the Detail opens its inline choice
  assert.match(h.view(), /Choose value/u, `the choice is painted:\n${h.view()}`)
  await key(h, '\x1b[B') // workspace-write -> danger-full-access
  await key(h, '\r') // explicit Confirm
  await settle(h)
  assert.deepEqual(h.permissionWrites(), ['danger-full-access'], 'exactly ONE Host permission default write')
  assert.equal(h.agent.permissionDefault?.value, 'danger-full-access', 'the Host authority really changed')
  assert.match(h.view(), /Verified/u, `the fresh Host read agrees:\n${h.view()}`)
  // The CURRENT session is untouched: no approval write and no preset apply.
  assert.deepEqual(h.calls().filter(call => call.startsWith('approval:')), [], 'the running session approval was not written')
  assert.equal(h.agent.approval?.value, 'ask', 'the live session override is unchanged')
  assert.equal(h.replacements(), 0, 'the permission default is never a TUI document field')
  h.dispose()
})

test('R3-01b a Host permission default that could not be written is never reported as Verified', async () => {
  const h = setup({
    columns: 120,
    rows: 40,
    agent: {
      sessionId: 'session-live',
      approvalAvailable: true,
      permissionNames: ['workspace-write', 'danger-full-access'],
      // No permissionDefault object: the seam throws `settings service
      // unavailable`, exactly like the Direct adapter without a settings service.
      permissionDefault: undefined,
    },
  })
  await openAgentRow(h, 'Default permission')
  await key(h, '\r')
  await key(h, '\x1b[B')
  await key(h, '\r')
  await settle(h)
  const view = h.view()
  assert.doesNotMatch(view, /Verified/u, `a failed default write must not claim Verified:\n${view}`)
  assert.match(view, /Not saved|Outcome unknown/u, `the refusal is stated truthfully:\n${view}`)
  h.dispose()
})

test('R3-02 the approval Confirm targets the pinned session scope; a stale scope dispatches nothing', async () => {
  const h = setup({
    columns: 120,
    rows: 40,
    agent: {
      sessionId: 'session-live',
      approvalAvailable: true,
      approval: { value: undefined },
      permissionNames: ['workspace-write'],
      permissionDefault: { value: 'workspace-write' },
    },
  })
  await openAgentRow(h, 'Approval policy (this session)')
  await key(h, '\r') // Detail + inline choice
  await key(h, '\x1b[B') // ask -> never
  await key(h, '\r')
  await settle(h)
  assert.deepEqual(h.calls().filter(call => call.startsWith('approval:')), ['approval:session-live:never'],
    'the write names the ONE captured session')
  assert.equal(h.agent.approval?.value, 'never', 'the official per-session override really changed')
  assert.match(h.view(), /Verified/u, 'the same-scope readback agrees')
  assert.equal(h.replacements(), 0, 'the approval policy never reaches the TUI document')
  h.dispose()
})

test('R3-02b a session switch revokes the approval row instead of re-targeting the new session', async () => {
  let current = true
  const h = setup({
    columns: 120,
    rows: 40,
    agent: {
      sessionId: 'session-live',
      scopeCurrent: () => current,
      approvalAvailable: true,
      approval: { value: 'ask' },
      permissionNames: ['workspace-write'],
      permissionDefault: { value: 'workspace-write' },
    },
  })
  await openAgentRow(h, 'Approval policy (this session)')
  await key(h, '\r')
  await key(h, '\x1b[B')
  // The session really changed before the Confirm: the captured scope is stale.
  current = false
  await key(h, '\r')
  await settle(h)
  const view = h.view()
  assert.deepEqual(h.calls().filter(call => call.startsWith('approval:')), [],
    'a stale scope dispatches NO approval write at all')
  assert.ok(h.notices().some(message => /the session changed — the approval policy was not applied/u.test(message)),
    `the refusal reaches the user:\n${h.notices().join('\n')}`)
  assert.doesNotMatch(view, /Settings · Agent · Approval policy/u,
    `the spent row is gone from the fresh frame instead of re-targeting a new session:\n${view}`)
  assert.equal(h.agent.approval?.value, 'ask', 'the old override is untouched')
  h.dispose()
})

test('R3-04 the allowlist row mounts the EXISTING picker in the same workspace and toggles the official section', async () => {
  const h = setup({
    columns: 120,
    rows: 40,
    agent: {
      sessionId: 'session-live',
      approvalAvailable: true,
      permissionNames: ['workspace-write'],
      permissionDefault: { value: 'workspace-write' },
      subagent: { enabled: false, allowedModels: [] },
      directory: [
        { id: 'p1', name: 'Provider One', models: [{ id: 'm1', name: 'Model One' }, { id: 'm2', name: 'Model Two' }] },
        { id: 'p2', name: 'Provider Two', models: [{ id: 'm1' }] },
      ],
    },
  })
  await openAgentRow(h, 'Subagent allowed models')
  // Tab focuses the Detail WITHOUT activating anything (the Manage action is
  // painted there), then Enter mounts the SAME picker.
  await key(h, '\t')
  assert.match(h.view(), /Manage allowed models…/u, `the ONE explicit Manage action is painted:\n${h.view()}`)
  await key(h, '\r')
  const picker = h.view()
  assert.match(picker, /Subagent allowed models/u, `the picker is painted in the same lease:\n${picker}`)
  assert.match(picker, /Provider One|Provider Two/u, 'the official grouped directory really painted')
  assert.match(picker, /Enter toggle/u, 'the picker keeps its own semantic hint on the last row')
  // The picker is searchable: filter down to one route and toggle it.
  await key(h, 'm')
  await key(h, '\r')
  await settle(h)
  assert.equal(h.subagentWrites().length, 1, 'exactly ONE official section write')
  assert.deepEqual(h.subagentWrites()[0]?.allowedModels, [{ provider: 'p1', model: 'm1' }],
    'the write carries the exact (provider, model) pair')
  assert.equal(h.subagentSection()?.allowedModels.length, 1, 'the official section really changed')
  // Esc leaves the picker (NOT the workspace) and returns to the Agent rows.
  await key(h, '\x1b')
  const back = h.view()
  assert.match(back, /Settings · Agent/u, `Esc returns to the Agent rows, not the conversation:\n${back}`)
  assert.match(back, /1 route/u, 'the row summary follows the committed official section')
  h.dispose()
})

test('R3-05 enabling the toggle with an EMPTY allowlist writes nothing and moves to the allowlist row', async () => {
  const h = setup({
    columns: 120,
    rows: 40,
    agent: {
      sessionId: 'session-live',
      approvalAvailable: true,
      permissionNames: ['workspace-write'],
      permissionDefault: { value: 'workspace-write' },
      subagent: { enabled: false, allowedModels: [] },
      directory: [{ id: 'p1', name: 'P1', models: [{ id: 'm1' }] }],
    },
  })
  await openAgentRow(h, 'Subagent model selection')
  await key(h, '\r')
  await key(h, '\x1b[B') // off -> on
  await key(h, '\r')
  await settle(h)
  assert.deepEqual(h.subagentWrites(), [], 'an empty allowlist means ZERO official writes')
  assert.equal(h.agent.subagent?.enabled, false, 'the section stays off')
  const view = h.view()
  assert.match(view, /Select at least one Subagent allowed model before enabling model selection\./u,
    `the exact guidance is shown:\n${view}`)
  assert.match(agentSelectedRowLabel(h), /^Subagent allowed models/u,
    `the typed follow-up moved the selection to the allowlist row:\n${view}`)
  h.dispose()
})

test('R3-05b enabling and disabling the toggle preserves every saved route', async () => {
  const h = setup({
    columns: 120,
    rows: 40,
    agent: {
      sessionId: 'session-live',
      approvalAvailable: true,
      permissionNames: ['workspace-write'],
      permissionDefault: { value: 'workspace-write' },
      subagent: { enabled: false, allowedModels: [{ provider: 'p1', model: 'm1' }] },
      directory: [{ id: 'p1', name: 'P1', models: [{ id: 'm1' }] }],
    },
  })
  await openAgentRow(h, 'Subagent model selection')
  await key(h, '\r')
  await key(h, '\x1b[B')
  await key(h, '\r')
  await settle(h)
  assert.deepEqual(h.subagentWrites(), [{ enabled: true, allowedModels: [{ provider: 'p1', model: 'm1' }] }],
    'enabling keeps the existing route')
  assert.match(h.view(), /Verified/u, 'both section halves read back')
  // Disable again in a FRESH open: the routes survive.
  for (let step = 0; step < 3; step += 1) await key(h, '\x1b')
  await settle(h)
  assert.doesNotMatch(h.view(), /Settings ·/u, `the workspace closed:\n${h.view()}`)
  await openAgentRow(h, 'Subagent model selection')
  await key(h, '\r')
  await key(h, '\x1b[A') // the section reads enabled: on -> off
  await key(h, '\r')
  await settle(h)
  assert.equal(h.subagentWrites().length, 2, 'the second toggle dispatched ONE write')
  assert.deepEqual(h.subagentWrites()[1], { enabled: false, allowedModels: [{ provider: 'p1', model: 'm1' }] },
    'disabling never clears the saved routes')
  assert.equal(h.subagentSection()?.allowedModels.length, 1, 'the official section still carries the route')
  h.dispose()
})

test('R3-07 the user shell sandbox policy Confirm stores the raw document value only', async () => {
  const h = setup({
    columns: 120,
    rows: 40,
    doc: { localShellSandbox: 'bypass' },
    agent: { permissionNames: ['workspace-write'], permissionDefault: { value: 'workspace-write' } },
  })
  await openAgentRow(h, 'User shell sandbox policy')
  const before = h.view()
  assert.match(before, /Runtime\s+Next ! \/ !! uses bypass/u, `the consumer effect is its own line:\n${before}`)
  await key(h, '\r')
  await key(h, '\x1b[B') // bypass -> sandbox
  await key(h, '\r')
  await settle(h)
  assert.equal(h.doc.localShellSandbox, 'sandbox', 'the TUI document really stored the new policy')
  assert.equal(h.replacements(), 1, 'exactly ONE whole-document write')
  assert.match(h.view(), /Verified/u, 'the fresh document read agrees')
  assert.match(h.view(), /Next ! \/ !! uses sandbox/u, 'the consumer effect is stated separately')
  assert.deepEqual(h.permissionWrites(), [], 'the shell policy never touches the Host permission default')
  assert.deepEqual(h.subagentWrites(), [], 'the shell policy never touches the subagent section')
  h.dispose()
})

test('R3-06 one queued section write cannot resurrect a route a pending picker write removed', async () => {
  // The cross-surface failure this queue must prevent: the picker removes a
  // route (its write is still in flight), the user leaves the picker and flips
  // the toggle. The toggle owns ONLY `enabled`, so the route list it writes must
  // come from the FRESH section inside the queue — not from the snapshot the
  // user saw before the removal settled.
  let openGate: (() => void) | undefined
  const gate = new Promise<void>(resolve => { openGate = resolve })
  const h = setup({
    columns: 120,
    rows: 40,
    agent: {
      sessionId: 'session-live',
      approvalAvailable: true,
      permissionNames: ['workspace-write'],
      permissionDefault: { value: 'workspace-write' },
      // Enabled with TWO routes: disabling must keep whatever routes survive,
      // and the picker's removal is what they are.
      subagent: { enabled: true, allowedModels: [{ provider: 'p1', model: 'm1' }, { provider: 'p1', model: 'm2' }] },
      directory: [{ id: 'p1', name: 'P1', models: [{ id: 'm1' }, { id: 'm2' }] }],
      gateSectionWrite: () => gate,
    },
  })
  await openAgentRow(h, 'Subagent allowed models')
  await key(h, '\r') // Detail focus
  await key(h, '\r') // Manage → the picker
  assert.match(h.view(), /P1/u, `the picker painted the official directory:\n${h.view()}`)
  // Walk to m2 and toggle it OFF: that section write is held open.
  await key(h, '\x1b[B')
  await key(h, '\r')
  await settle(h, 2)
  // Leave the picker (its own Esc) and flip the toggle while the removal is
  // still in flight. The toggle is 'on' -> 'off', so it needs no route gate.
  await key(h, '\x1b') // picker Esc -> the allowlist row's Detail
  await key(h, '\x1b') // Detail -> Rows
  for (let step = 0; step < 8 && !agentSelectedRowLabel(h).includes('Subagent model selection'); step += 1) {
    await key(h, '\x1b[B')
  }
  assert.match(agentSelectedRowLabel(h), /^Subagent model selection/u, `the toggle row was reached:\n${h.view()}`)
  await key(h, '\r')
  await key(h, '\x1b[A') // the current candidate is `on` → `off`
  await key(h, '\r')
  await settle(h, 2)
  assert.deepEqual(h.subagentWrites(), [], 'nothing settles while the first write is held')

  openGate!()
  await settle(h, 12)
  const writes = h.subagentWrites()
  assert.equal(writes.length, 2, `both intents committed in order: ${JSON.stringify(writes)}`)
  const survived = writes[0]!.allowedModels
  assert.equal(survived.length, 1, 'the picker removed exactly one of the two routes')
  assert.equal(writes[0]!.enabled, true, 'the picker kept the CURRENT enabled half instead of the value it saw when it was built')
  assert.deepEqual(writes[1], { enabled: false, allowedModels: survived },
    'the toggle kept the FRESH route list: the removed route is never resurrected')
  assert.deepEqual(h.subagentSection(), { enabled: false, allowedModels: survived },
    'the official section ends in the merged state of BOTH intents')
  h.dispose()
})

test('R3-09 a NON-CURRENT backend paints no confirmable Agent candidate and claims no current value', async () => {
  for (const readiness of ['stale', 'unavailable'] as const) {
    const h = setup({
      columns: 140,
      rows: 44,
      readiness,
      doc: { localShellSandbox: 'bypass' },
      agent: {
        sessionId: 'session-live',
        approvalAvailable: true,
        approval: { value: 'ask' },
        permissionNames: ['workspace-write', 'danger-full-access'],
        permissionDefault: { value: 'workspace-write' },
        subagent: { enabled: true, allowedModels: [{ provider: 'p1', model: 'm1' }] },
        directory: [{ id: 'p1', name: 'P1', models: [{ id: 'm1' }] }],
      },
    })
    await h.open('Agent')
    await key(h, '\r')
    // The delegation rows report the LAST-KNOWN state and claim no [current],
    // and the Manage action is NOT offered (the picker would refuse anyway).
    assert.match(h.view(), /Subagent allowed models/u, `${readiness}: the row stays reachable`)
    await openRowInAgent(h, 'Subagent allowed models')
    await key(h, '\r')
    assert.doesNotMatch(h.view(), /Manage allowed models…/u,
      `${readiness}: a non-current section offers no Manage action:\n${h.view()}`)
    assert.doesNotMatch(h.view(), /Provider One/u, `${readiness}: the picker never mounts`)
    // Back to the rows level before walking to the toggle.
    await key(h, '\x1b')
    await openRowInAgent(h, 'Subagent model selection')
    await key(h, '\r') // its Detail cannot open a choice with no candidates
    const view = h.view()
    assert.match(view, /No candidate is available for this setting right now\./u,
      `${readiness}: a non-current section offers NO confirmable candidate:\n${view}`)
    assert.doesNotMatch(view, /\[current\]/u, `${readiness}: no [current] chip on an unconfirmed value`)
    assert.doesNotMatch(view, /Enter confirm/u, `${readiness}: no confirm affordance is advertised`)
    h.dispose()
  }
})

test('R3-09b the default permission and shell policy rows offer no candidate on a non-ready backend', async () => {
  for (const readiness of ['stale', 'unavailable'] as const) {
    const h = setup({
      columns: 140,
      rows: 44,
      readiness,
      doc: { localShellSandbox: 'bypass' },
      agent: {
        sessionId: 'session-live',
        approvalAvailable: true,
        permissionNames: ['workspace-write'],
        permissionDefault: { value: 'workspace-write' },
      },
    })
    await h.open('Agent')
    await key(h, '\r')
    // The rows still state their truthful facts…
    assert.match(h.view(), /Default permission/u, `${readiness}: the default-permission row stays painted`)
    await openRowInAgent(h, 'Default permission')
    await key(h, '\r')
    assert.match(h.view(), /No candidate is available for this setting right now\./u,
      `${readiness}: the permission default offers no confirmable candidate`)
    assert.match(h.view(), /Last-known value|Unavailable — no authoritative config document/u,
      `${readiness}: the row states the real freshness`)
    await key(h, '\x1b')
    await openRowInAgent(h, 'User shell sandbox policy')
    await key(h, '\r')
    assert.match(h.view(), /No candidate is available for this setting right now\./u,
      `${readiness}: the shell policy offers no confirmable candidate`)
    h.dispose()
  }
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
  // The row summaries come from the LIVE authorities (C2-R1): the icon row's
  // summary is `app.currentIconStyle()`, so the app must start on the style this
  // token assertion names.
  const h = setup({ columns: 100, rows: 40, iconStyle: 'symbols' })
  await h.open()
  const darkWordmark = h.vt.getCellFgRgb(0, 0)
  assert.equal(darkWordmark, hexToRgb(currentPalette.textStrong), 'the Settings wordmark uses the live textStrong token')
  const ruleRow = h.rowsPlain().findIndex(line => /^─+$/.test(line))
  assert.equal(h.vt.getCellFgRgb(ruleRow, 2), hexToRgb(currentPalette.border), 'the visual rule uses the border token')
  // The active device and the cursor share `primary`; the identity word above
  // does NOT (it is weight-only). This is the exact split the vocabulary fixes:
  // ordinary focus is never the amber `borderFocus` (which equals `warning`).
  const paneHeadRow = rowOf(h, '[Categories (9)]')
  const paneHeadCol = cellIndexOf(h, paneHeadRow, '[Categories (9)]')
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
  const displayRow = rowOf(h, 'Conversation')
  const displayCol = cellIndexOf(h, displayRow, 'Conversation')
  press(h, displayRow, displayCol)
  release(h, displayRow, displayCol)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /Settings · Categories/, 'a category click stays on the categories level')
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Conversation')), 'the clicked category is selected')
  assert.ok(!h.view().includes('· Rows'), 'the click never drilled into the rows level')
  // Enter/Right is the only keyboard level advance; a row click stays at L1.
  await key(h, '\r')
  assert.match(h.rowsPlain()[0]!, /Settings · Conversation · Rows/)
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Transcript display')))
  const rowIndex = rowOf(h, 'Transcript display')
  const rowCol = cellIndexOf(h, rowIndex, 'Transcript display')
  press(h, rowIndex, rowCol)
  release(h, rowIndex, rowCol)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /Settings · Conversation · Rows/, 'a row click stays on the rows level')
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Transcript display')))
  await key(h, '\r')
  assert.match(h.rowsPlain()[0]!, /Settings · Conversation · Transcript display/, 'Enter enters the detail')
  h.dispose()
})

test('the retired Legacy Copy cells are inert while the rails Copy All stays a real click target', async () => {
  const h = setup({ columns: 100, rows: 40, doc: { theme: 'plugin:acme/solarized' }, themes: pluginThemes() })
  await h.open()
  assert.ok(!/c copy value/.test(h.rowsPlain().at(-1) ?? ''), 'c is never advertised outside the Detail level')
  await key(h, '\r') // L0 -> L1: the rows keep the keyboard while the Detail is visible
  assert.match(h.rowsPlain()[rowOf(h, 'Rows (3)')]!, /\[Rows \(3\)\]/, 'the rows level owns the keyboard')
  // The old painted button's coordinates (the Detail action row) are inert now.
  const detailRow = rowOf(h, 'Change…')
  const detailActionCol = cellIndexOf(h, detailRow, 'Change…') + 2
  press(h, detailRow, detailActionCol)
  release(h, detailRow, detailActionCol)
  await settle(h)
  assert.deepEqual(h.copied, [], 'a Legacy Detail action never copies')
  assert.match(h.rowsPlain()[rowOf(h, 'Details')]!, /\[Details\]/, 'the clicked column still becomes the keyboard owner')
  assert.equal(h.replacements(), 0, 'the click opened no write')
  h.dispose()

  // The About page's ONE body Copy All button IS a real last-painted target on a
  // rail-focused frame.
  const about = setup({ columns: 100, rows: 30, liveSession: { sessionId: 'sess-detail-click', title: 'detail click' } })
  await about.openHome()
  const copyAllRow = rowOf(about, 'Copy All [C]')
  const copyAllCol = cellIndexOf(about, copyAllRow, 'Copy All [C]') + 2
  press(about, copyAllRow, copyAllCol)
  release(about, copyAllRow, copyAllCol)
  await settle(about)
  assert.equal(about.copied.length, 1, 'the painted About Copy All really copies')
  assert.match(about.copied[0]!, /Session ID: sess-detail-click/u)
  about.dispose()
})

test('a click anywhere in a visible column takes that column focus', async () => {
  const h = setup({ columns: 100, rows: 40, doc: { theme: 'dark' } })
  await h.open()
  assert.match(h.rowsPlain()[rowOf(h, 'Categories (9)')]!, /\[Categories \(9\)\]/, 'the categories level owns focus at open')
  // Clicking a row selects it and takes the rows level's focus (and therefore
  // the rows + detail composition).
  const iconRow = rowOf(h, 'Icon style')
  const iconCol = cellIndexOf(h, iconRow, 'Icon style')
  press(h, iconRow, iconCol)
  release(h, iconRow, iconCol)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[rowOf(h, 'Rows (3)')]!, /\[Rows \(3\)\]/, 'a row click takes the rows level focus')
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
  assert.ok(!painted.some(line => line.includes('Categories (9)')), 'the pane header yields to the content row')
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

test('a press spanning a Refresh is refused instead of activating the newer frame', async () => {
  // PR3: the Legacy Detail has no copy target left, so this case now proves the
  // SAME press-identity fence through a real painted Legacy action (`Change…`):
  // a stale press must never open the newer frame's choice.
  const h = setup({ columns: 100, rows: 30, doc: { theme: 'dark' } })
  await h.open()
  await key(h, '\r') // L0 -> L1
  await key(h, '\t') // L1 -> the Detail pane (browsing, no choice)
  assert.ok(!h.view().includes('Copy value [C]'), 'the browsing Detail paints no copy action')
  const changeRow = rowOf(h, 'Change…')
  const changeCol = cellIndexOf(h, changeRow, 'Change…')
  press(h, changeRow, changeCol)
  h.doc.theme = 'light'
  await key(h, 'r') // refresh: the row value changes and the state version bumps
  assert.match(h.view(), /light/u, 'R really re-read the new value')
  release(h, changeRow, changeCol)
  await settle(h)
  assert.equal(h.replacements(), 0, 'the stale press never opened a write channel')
  assert.ok(!h.view().includes('Choose value'), 'the stale press did not open the newer frame choice')
  // Positive control: the freshly painted frame still runs the same action.
  await key(h, '\r')
  assert.match(h.view(), /Choose value/u, 'the repainted action still opens the choice')
  assert.equal(h.replacements(), 0, 'opening the choice still writes nothing')
  h.dispose()
})

// ── F4: the wheel owns its own viewport ───────────────────────────────────

test('the wheel scrolls the pane under the pointer without pulling the selection back', async () => {
  const h = setup({ columns: 72, rows: 4, doc: { theme: 'dark' } })
  await h.open()
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Appearance')))
  assert.ok(!h.view().includes('Extensions'), 'no conditional category starts out of view')
  wheel(h, rowOf(h, 'Appearance'), 4, true)
  wheel(h, rowOf(h, 'Appearance'), 4, true)
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('> Appearance'), 'the selection left the viewport instead of forcing a rebase')
  assert.ok(h.view().includes('Plugins') || h.view().includes('Tools') || h.view().includes('Input & Terminal'), `the wheel scrolled the list:\n${h.view()}`)
  await key(h, '\x1b[B')
  await key(h, '\x1b[B')
  await key(h, '\x1b[B')
  await key(h, '\x1b[B')
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Plugins')), 'a selection change still rebases to the selected row')
  h.dispose()
})

// ── F5: unknown persistence is never presented as "not set" ───────────────

test('an unreadable document never fabricates a "not set" persisted preference', async () => {
  const missing = setup({ columns: 100, rows: 40, settingsService: false })
  await missing.open()
  await key(missing, '\x1b[B') // Appearance -> Conversation
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
  // The Detail is one column beside the rows pane, so the wrapped error text is
  // split by the row gutter: assert the reachable fact, not an unwrapped phrase.
  assert.match(throwing.view().replace(/\s+/g, ' '), /read exploded/, 'PgDn reaches the complete read error fact')
  assert.match(throwing.view().replace(/\s+/g, ' '), /could not be read/, 'the read error states its cause')
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
  const paneRow = rowOf(h, 'Categories (9)')
  assert.equal(cellIndexOf(h, paneRow, '[Categories (9)]'), 0, 'the categories level starts at cell 0 and owns focus at L0')
  assert.equal(cellIndexOf(h, paneRow, 'Rows (3)'), 22 + 2, 'the row column starts after the 22-cell column and a 2-cell gap')
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

test('A-10c the About copy failure paths report inside the workspace instead of a false success', async () => {
  for (const failing of [async () => false, async () => { throw new Error('clipboard refused') }]) {
    const h = setup({
      columns: 140,
      rows: 24,
      liveSession: { sessionId: 'sess-fail', title: 'failure path' },
      copySelection: failing,
    })
    await h.openHome()
    await key(h, 'C') // the rail-focused About Copy All (the real Client sink)
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
  assert.match(wide.rowsPlain()[rowOf(wide, 'Categories (9)')]!, /\[Categories \(9\)\]/, 'the categories level owns focus at open')
  const displayRow = rowOf(wide, 'Conversation')
  press(wide, displayRow, 2)
  release(wide, displayRow, 2)
  await wide.vt.waitForRender()
  assert.match(wide.rowsPlain()[rowOf(wide, 'Categories (9)')]!, /\[Categories \(9\)\]/, 'the clicked category keeps the categories level')
  assert.ok(wide.rowsPlain().some(line => line.startsWith('> Conversation')), 'and selects the clicked category')
  await key(wide, '\x1b[B')
  assert.ok(wide.rowsPlain().some(line => line.startsWith('> Input & Terminal')), 'Down now moves the CATEGORY, not the row')
  wide.dispose()

  const medium = setup({ columns: 100, rows: 24, doc: { theme: 'dark' } })
  await medium.open()
  const iconRow = rowOf(medium, 'Icon style')
  const iconCol = cellIndexOf(medium, iconRow, 'Icon style')
  press(medium, iconRow, iconCol)
  release(medium, iconRow, iconCol)
  await medium.vt.waitForRender()
  assert.match(medium.rowsPlain()[rowOf(medium, 'Rows (3)')]!, /\[Rows \(3\)\]/, 'a row click takes the rows level')
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

  const narrow = setup({ columns: 44, rows: 24, iconStyle: 'symbols', doc: { iconStyle: 'symbols', theme: long } })
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
  for (const label of ['Account', 'Agent', 'Appearance']) {
    assert.ok(painted.some(line => line.includes(label)), `the body keeps the real ${label} row:\n${short.view()}`)
  }
  short.dispose()

  // 6 and 8 rows with a LIVE notice: the notice's body floor is honoured first.
  // PR3: the notice now comes from the real About clipboard sink (the Legacy
  // Detail has no copy action left), which is the same App notice row.
  const live = setup({ columns: 100, rows: 24, liveSession: { sessionId: 'sess-notice', title: 'notice proof' } })
  await live.openHome()
  await key(live, '\r') // rail -> About content
  await key(live, 'c') // the selected fact through the real clipboard owner
  await settle(live)
  assert.deepEqual(live.copied, ['0.5.3'], 'the About fact copy reached the clipboard owner')
  assert.ok(live.rowsPlain().some(line => line.includes('Copy sent')), 'the notice is live before the shrink')
  for (const rows of [6, 8]) {
    live.vt.resize(100, rows)
    await live.vt.waitForRender()
    const frame = live.rowsPlain()
    assert.equal(frame.length, rows)
    assert.match(frame.at(-1)!, /Esc back/)
    assert.ok(frame.some(line => line.includes('Copy sent')), `the notice is still granted and painted at ${rows} rows:\n${live.view()}`)
    assert.equal(frame.filter(line => /^─+$/.test(line)).length, 0, `the decorative rules yield at ${rows} rows:\n${live.view()}`)
    if (rows === 8) {
      assert.ok(frame.some(line => line.includes('Config Ready')), 'the freshness/scope metadata is granted at 8 rows')
    }
    if (rows === 6) {
      const paneHeader = frame.findIndex(line => line.includes('[About]'))
      assert.ok(paneHeader >= 0, 'the direct pane identity survives the live notice')
      assert.ok(frame.some(line => line.includes('TUI')), `a real About fact remains in the body:\n${live.view()}`)
      // The header row names the pane the frame really paints and the frame
      // keeps exactly one physical bar.
      assert.equal(frame.filter(line => /Esc (?:back|close)/u.test(line)).length, 1, 'one truthful bar')
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
    assert.ok(h.rowsPlain().some(line => line.startsWith('> Conversation')), `↓ selects Conversation at ${columns}:\n${h.view()}`)
    await key(h, '\r')
    assert.match(h.rowsPlain()[0]!, /Settings · Conversation · Rows/, `Enter enters the Conversation rows at ${columns}`)
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
    assert.ok(h.rowsPlain().some(line => line.includes('Categories (9)')), `L0 categories at ${columns}:\n${h.view()}`)
    assert.ok(!h.view().includes('Details'), 'L0 paints no Detail pane')
    assert.ok(!h.view().includes('Copy value [C]'), 'L0 publishes no Detail button')
    await key(h, '\r')
    assert.ok(h.rowsPlain().some(line => line.includes('Details')), 'L1 paints rows+detail')
    assert.ok(!h.view().includes('Categories (9)'), 'L1 drops the categories column')
    await key(h, '\r')
    assert.ok(h.view().includes('Choose value'), 'L2 enters an inline choice without a second browse Enter')
    assert.ok(h.view().includes('Solarized'), 'the selected source identity remains visible')
    assert.ok(!h.view().includes('Categories (9)'), 'L2 keeps the rows+detail projection')
    await key(h, '\x1b')
    assert.match(h.rowsPlain()[0]!, /· Rows/, 'Esc cancels L2 directly back to L1')
    await key(h, '\x1b')
    assert.ok(h.rowsPlain().some(line => line.includes('Categories (9)')), 'Esc from L1 returns to categories+rows')
    assert.ok(!h.view().includes('Details'), 'and hides the detail again')
    h.dispose()
  }
})

test('the narrow projection keeps the inline choice across resize and exposes no Legacy copy', async () => {
  const h = setup({ columns: 72, rows: 24, doc: { theme: 'dark' } })
  await h.open()
  assert.match(h.rowsPlain()[0]!, /Settings · Categories/)
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Appearance')))
  assert.ok(!h.view().includes('Configured theme'), 'L0 shows only the categories')
  await key(h, '\r')
  assert.match(h.rowsPlain()[0]!, /· Rows/)
  assert.ok(!h.view().includes('Transcript display'), 'L1 shows only the current category rows')
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

  // Cancel back to L1: the medium Detail paints the same row and value, but the
  // retired Legacy Copy action is gone and no copy key reaches the clipboard —
  // while the candidate identity and the write authority are unchanged.
  await key(h, '\x1b')
  h.vt.resize(100, 24)
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /· Rows/u, 'the choice cancelled back to L1')
  assert.ok(!h.view().includes('Copy value [C]'), `no Legacy Copy action on the repainted Detail:\n${h.view()}`)
  for (const data of ['c', 'C', '\x1b[99u', '\x1b[99:67:99;2u', '\x1b[27;2;67~']) await key(h, data)
  await settle(h)
  assert.deepEqual(h.copied, [], 'no copy key reaches the clipboard after the resize cycle')
  assert.equal(h.replacements(), 0, 'no copy key writes the document')
  assert.equal(h.doc.theme, 'dark', 'the configured value is unchanged')
  h.dispose()
})

test('a resize keeps focus/category/row and invalidates the previous painted Confirm hit map', async () => {
  const h = setup({ columns: 200, rows: 40, doc: { theme: 'dark' } })
  await h.open()
  await key(h, '\x1b[B') // Conversation
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
  assert.match(h.rowsPlain()[0]!, /Settings · Conversation/, 'the category and level survive the resize')
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

  const displayRow = rowOf(h, 'Conversation')
  const displayCol = cellIndexOf(h, displayRow, 'Conversation')
  press(h, displayRow, displayCol)
  release(h, displayRow, displayCol)
  await settle(h)
  assert.ok(!h.view().includes('Choose value'), 'a category click retires the old chooser')
  assert.ok(!h.view().includes('Confirm'), 'the old candidate confirm is no longer painted')
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Conversation')), 'the clicked category is selected')
  assert.equal(h.replacements(), 0)

  await key(h, '\x1b[C') // L0 -> L1
  await key(h, '\x1b[C') // L1 -> Conversation display-preset choice
  assert.ok(h.view().includes('Choose value'))
  const thinkingRow = rowOf(h, 'Thinking detail')
  const thinkingCol = cellIndexOf(h, thinkingRow, 'Thinking detail')
  press(h, thinkingRow, thinkingCol)
  release(h, thinkingRow, thinkingCol)
  await settle(h)
  assert.ok(!h.view().includes('Choose value'), 'a row click cancels the chooser before changing selection')
  assert.ok(!h.view().includes('Confirm'))
  assert.match(h.rowsPlain()[0]!, /Settings · Conversation · Rows/)
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
  await key(h, '\x1b[B') // Appearance -> Conversation
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Conversation')))
  await key(h, '\r') // L1
  assert.ok(h.view().includes('Transcript display'), 'the Conversation rows replace the appearance rows')
  await key(h, '\x1b[B') // display-preset -> expand (Transcript detail)
  await key(h, '\x1b[B') // expand -> thinking
  await key(h, '\r') // L2
  assert.match(h.rowsPlain()[0]!, /Thinking detail/, 'the detail follows the new stable row id')
  await key(h, '\x1b') // L1
  await key(h, '\x1b') // L0
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Conversation')), 'the selected category id survives')
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

test('no Legacy Detail level copies; R refreshes in place; browsing never writes', async () => {
  const h = setup({ columns: 100, rows: 40, doc: { theme: 'plugin:acme/solarized', iconStyle: 'symbols' }, themes: pluginThemes() })
  await h.open()
  for (const data of ['c', 'C']) {
    await key(h, data)
    await settle(h)
  }
  assert.deepEqual(h.copied, [], 'the copy keys are inert on the categories level')
  await key(h, '\r') // L1
  for (const data of ['c', 'C']) {
    await key(h, data)
    await settle(h)
  }
  assert.deepEqual(h.copied, [], 'the copy keys are inert on the rows level')
  const readsBefore = h.reads()
  await key(h, 'r')
  assert.ok(h.reads() > readsBefore, 'R re-reads the same authority')
  assert.match(h.rowsPlain()[0]!, /· Rows/, 'R keeps the current level')
  await key(h, '\x1b[B') // Configured theme -> read-only Icon style
  await key(h, '\r') // L2 read-only Detail
  assert.ok(!h.view().includes('Copy value [C]'), 'the read-only Detail paints no Copy action')
  for (const data of ['c', 'C', '\x1b[99u', '\x1b[99:67:99;2u', '\x1b[27;2;67~']) {
    await key(h, data)
    await settle(h)
  }
  assert.deepEqual(h.copied, [], 'no copy key reaches the clipboard from the read-only Detail')
  assert.equal(h.replacements(), 0, 'no navigation or refresh ever writes the config document')
  h.dispose()
})

test('a long CJK read-only value wraps inside the narrow Detail and never reaches the clipboard', async () => {
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
  // The wrapped source stays readable in the Detail (no truncation to fit the
  // pane), while the retired copy verb is absent.
  assert.ok(!h.view().includes('Copy value [C]'), `no Copy action in the wrapped Detail:\n${h.view()}`)
  for (const data of ['c', 'C']) {
    await key(h, data)
    await settle(h)
  }
  assert.deepEqual(h.copied, [], 'the copy keys stay inert on the wrapped value')
  assert.equal(h.replacements(), 0, 'scrolling and copy keys write nothing')
  h.dispose()
})

// ── UX-12: the frozen responsive projection table ─────────────────────────

test('the projection table is frozen: below 76 columns one pane, 76..107 two, 108 and up three', async () => {
  for (const [columns, panes] of [[75, 1], [76, 2], [107, 2], [108, 3]] as const) {
    const h = setup({ columns, rows: 24, doc: { theme: 'dark' } })
    await h.open()
    await key(h, '\r') // L0 -> L1: the rows pane always, plus the detail when the width grants it
    const painted = h.rowsPlain()
    assert.equal(painted.some(line => line.includes('Categories (9)')), panes === 3, `the categories pane at ${columns} columns:\n${h.view()}`)
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
  if (row === 'display-preset') await key(h, '\x1b[B') // Appearance -> Conversation
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

test('B-08 the Input & Terminal handoff keeps its facts readable and gains no edit channel', async () => {
  // C2-R2 migrated every Input & Terminal configuration row, so the read-only
  // handoff is now the ONLY non-edit row of that category: it must keep stating
  // its facts, paint no writer and expose no copy verb.
  const h = setup({ columns: 200, rows: 40, doc: { theme: 'dark' } })
  await h.open('Input & Terminal')
  await key(h, '\r') // L0 -> L1
  for (let step = 0; step < INPUT_TERMINAL_ROWS.length - 1; step += 1) await key(h, '\x1b[B')
  assert.ok(h.view().includes('> Input & terminal settings…'),
    `the handoff is the selected Input & Terminal row:\n${h.view()}`)
  // The FROZEN order, as painted in the ROWS column (the Detail repeats the
  // selected row's label, so the order is read from the list).
  const rowsColumn = h.rowsPlain().map((_, index) => rowsPaneText(h, index)).join('\n')
  let previous = -1
  for (const label of INPUT_TERMINAL_ROWS) {
    const at = rowsColumn.indexOf(label)
    assert.ok(at > previous, `${label} keeps the frozen Input & Terminal order:\n${h.view()}`)
    previous = at
  }
  assert.match(h.view(), /Keyboard shortcuts are still configured by the existing settings editor/u,
    'the handoff advertises only the field that was NOT migrated')
  assert.ok(!h.view().includes('Copy value [C]'), 'a launcher row paints no Legacy Copy action')
  await key(h, '\r') // the legacy handoff (a launcher owns no Detail level)
  const legacy = h.view()
  assert.match(legacy, /Type to search/, `the legacy editor is the physical owner:\n${legacy}`)
  assert.match(legacy, />\s*Keyboard shortcuts/u, 'the handoff lands on the remaining row, never on a migrated field')
  assert.equal(h.replacements(), 0, 'activating a launcher writes nothing')
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
      // the focused `[Categories (9)]` is the ONE primary label. The narrow
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

/** Move the L0 selection from Appearance to Plugins (four categories down:
 *  Agent, Conversation, Input & Terminal, Tools). */
const toPlugins = async (h: Harness): Promise<void> => {
  for (let step = 0; step < 4; step += 1) await key(h, '\x1b[B')
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
    assert.match(frame[3]!, /^\[Categories \(9\)\]/, `the rail label owns the header:\n${h.view()}`)
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
    assert.match(frame[3]!, /\[Categories \(9\)\]/, 'the rail keeps the ONE active device')
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
  const h = setup({ columns: 80, rows: 8, pluginPage: true })
  await h.openHome()
  assert.ok(!h.view().includes('Plugins'), `the last category is not painted yet:\n${h.view()}`)
  // The rail is the only selection owner: End reaches its last entry.
  await key(h, '\u001b[F')
  assert.match(h.view(), /^> Plugins/mu, `End reaches the last category:\n${h.view()}`)
  // The painted entry is the hit target: a click on it selects that category.
  const lastRow = rowOf(h, 'Plugins')
  press(h, lastRow, cellIndexOf(h, lastRow, 'Plugins'))
  release(h, lastRow, cellIndexOf(h, lastRow, 'Plugins'))
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /Settings · Categories/, 'the rail click keeps the keyboard on the rail')
  assert.match(h.view(), /^> Plugins/mu, 'the click hit the painted category id')
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
  // PR3: `C` is the reachable shortcut for the SAME painted report — including
  // when the narrow frame drops the Copy All segment entirely.
  await key(h, 'C')
  await settle(h)
  assert.equal(h.copied.length, 2, 'the keyboard Copy All reaches the same sink')
  assert.equal(h.copied[1]!, h.copied[0]!, 'the badge and the key serialize the SAME painted view')
  // Blank cells after the button never copy.
  press(h, actionRowIndex, copyAllCol + 20)
  release(h, actionRowIndex, copyAllCol + 20)
  await settle(h)
  assert.equal(h.copied.length, 2, 'a blank-cell click never copies')
  // Every About FACT row is inert: the body paints no per-fact copy target.
  for (let row = 0; row < actionRowIndex; row += 1) {
    press(h, row, 40)
    release(h, row, 40)
  }
  await settle(h)
  assert.equal(h.copied.length, 2, 'no fact row publishes a copy hit target')
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
  const paneY = rows.findIndex(line => line.includes('Categories (9)'))
  assert.ok(paneY >= 0, `the shared pane header must be painted:\n${h.view()}`)
  const contentY = paneY + 1
  assert.notEqual((rows[contentY] ?? '').trim(), '', `the first content row must carry real content:\n${h.view()}`)
  return { paneY, contentY, barY: rows.length - 1 }
}

test('direct and legacy settings categories share the pane-header, first-body and action-bar rows at medium and wide widths', async () => {
  const pairs = [['About', 'Appearance'], ['Models', 'Conversation'], ['Account', 'Tools']] as const
  for (const columns of [80, 100, 107, 108, 120] as const) {
    for (const [directCategory, legacyCategory] of pairs) {
      const direct = setup({ columns, rows: 24 })
      await direct.open(directCategory)
      const directGeometry = pr1Geometry(direct)
      const directHead = direct.rowsPlain()[directGeometry.paneY]!
      assert.match(directHead, /\[Categories \(9\)\]/u, `the rail is the active device:\n${directHead}`)
      assert.match(directHead, new RegExp(`\\b${directCategory}\\b`, 'u'), `the right label names the page:\n${directHead}`)
      assert.doesNotMatch(directHead, /Rows \(|Details/u, 'the direct header fakes no legacy panes')
      assert.match(direct.rowsPlain().at(-1) ?? '', /Esc close/u, 'the last row is the rail action bar')
      direct.dispose()

      const legacy = setup({ columns, rows: 24 })
      await legacy.open(legacyCategory)
      const legacyGeometry = pr1Geometry(legacy)
      const legacyHead = legacy.rowsPlain()[legacyGeometry.paneY]!
      assert.match(legacyHead, /\[Categories \(9\)\].*Rows \(\d+\)/u, `the legacy panes stay adjacent:\n${legacyHead}`)
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
    assert.match(frame[3]!, /^\[Categories \(9\)\].*About/u)
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
    assert.match(legacyFrame[3]!, /^\[Categories \(9\)\].*Rows \(3\).*Details/u,
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
    let pane = frame.findIndex(line => line.includes('Categories (9)'))
    assert.ok(pane >= 0)
    assert.match(frame[pane]!, /\[Categories \(9\)\].*Rows \(3\)/u, 'L0 is Categories + Rows')
    assert.doesNotMatch(frame[pane]!, /Details/u)

    await key(h, '\r') // L0 -> L1
    frame = h.rowsPlain()
    pane = frame.findIndex(line => line.includes('[Rows (3)]'))
    assert.ok(pane >= 0, `L1 must paint the focused Rows header at ${columns}:\n${h.view()}`)
    assert.match(frame[pane]!, /\[Rows \(3\)\].*Details/u, 'L1 is Rows + Details')
    assert.doesNotMatch(frame[pane]!, /Categories/u, 'the categories column is NOT pinned at L1/L2')

    await key(h, '\x1b[C') // L1 -> L2 inline choice
    frame = h.rowsPlain()
    pane = frame.findIndex(line => line.includes('[Details]'))
    assert.ok(pane >= 0)
    assert.match(frame[pane]!, /Rows \(3\).*\[Details\]/u, 'L2 keeps Rows + the focused Details')
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
      const pane = frame.findIndex(line => line.includes('[Categories (9)]'))
      assert.ok(pane >= 0)
      assert.match(frame[pane]!, /\[Categories \(9\)\].*About/u)
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
      const pane = frame.findIndex(line => line.includes('Categories (9)'))
      assert.ok(pane >= 0)
      assert.match(frame[pane]!, /\[Categories \(9\)\].*Rows \(3\)/u)
      if (columns >= 108) assert.match(frame[pane]!, /Details/u, '108 is the three-column edge')
      else assert.doesNotMatch(frame[pane]!, /Details/u, '76..107 stays two-column')
    }
    legacy.dispose()
  }
})

test('an app notice sits after the top rule and before the pane header at every granted height', async () => {
  // PR3: the notice comes from the REAL About clipboard sink (the Legacy Detail
  // has no copy action left); the notice row allocation is the same chrome.
  const h = setup({ columns: 120, rows: 24, liveSession: { sessionId: 'sess-notice2', title: 'notice allocation' } })
  await h.openHome()
  await key(h, '\r') // rail -> About content
  await key(h, 'C') // Copy All: the whole painted report reaches the sink
  await settle(h)
  assert.equal(h.copied.length, 1, 'the About Copy All really reached the clipboard owner')
  assert.ok(h.view().includes('Copy sent'), `the app notice is live:\n${h.view()}`)
  let frame = h.rowsPlain()
  assert.equal(frame.findIndex(line => line.includes('Copy sent')), 3, 'the notice follows the top rule')
  assert.equal(frame.findIndex(line => line.includes('[About]')), 4, 'the pane header follows the notice')
  assert.ok(frame.slice(5).some(line => /TUI {2}0\.5\.3/u.test(line)),
    `a real About fact follows the pane header (the whale art may take the first rows):\n${h.view()}`)
  assert.match(frame.at(-1) ?? '', /Esc back/u)
  assert.equal(frame.filter(line => line.includes('Copy sent')).length, 1, 'exactly one app-level notice')

  h.vt.resize(100, 6)
  await h.vt.waitForRender()
  frame = h.rowsPlain()
  assert.equal(frame[1]!.includes('Copy sent'), true, `the notice follows the header at 6 rows:\n${h.view()}`)
  assert.equal(frame[2]!.includes('[About]'), true, `the pane header follows the notice at 6 rows:\n${h.view()}`)
  assert.match(frame.at(-1) ?? '', /Esc back/u)
  assert.equal(frame.filter(line => line.includes('Copy sent')).length, 1, 'still one notice')

  h.vt.resize(100, 8)
  await h.vt.waitForRender()
  frame = h.rowsPlain()
  assert.equal(frame[2]!.includes('Copy sent'), true, `the notice follows the diagnostic line at 8 rows:\n${h.view()}`)
  assert.equal(frame[3]!.includes('[About]'), true, `the pane header follows the notice at 8 rows:\n${h.view()}`)
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
    assert.equal(painted.some(line => line.includes('Categories (9)')), grant.pane, 'the pane header keeps one content row')
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

  const paneRow = about.rowsPlain().findIndex(line => line.includes('[Categories (9)]'))
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
  const wheelPane = wheelHarness.rowsPlain().findIndex(line => line.includes('Categories (9)'))
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
  // The About Copy All is the remaining real clipboard target: every fence below
  // is proven on it (the Legacy Copy hit that used to own this case is retired).
  const resized = setup({ columns: 100, rows: 30, liveSession: { sessionId: 'sess-gesture', title: 'gesture proof' } })
  await resized.openHome()
  await settle(resized)
  const resizeRow = rowOf(resized, 'Copy All [C]')
  const resizeCol = cellIndexOf(resized, resizeRow, 'Copy All [C]')
  press(resized, resizeRow, resizeCol + 2)
  resized.vt.resize(120, 30)
  await resized.vt.waitForRender()
  release(resized, resizeRow, resizeCol + 2)
  await settle(resized)
  assert.deepEqual(resized.copied, [], 'a resize between press and release refuses the gesture')
  const freshRow = rowOf(resized, 'Copy All [C]')
  const freshCol = cellIndexOf(resized, freshRow, 'Copy All [C]')
  // A DIFFERENT cell inside the same painted button: a repeat press on the SAME
  // cell is a word-select (a double click), not a disclosure click.
  press(resized, freshRow, freshCol + 5)
  release(resized, freshRow, freshCol + 5)
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

  const noticed = setup({ columns: 120, rows: 24, liveSession: { sessionId: 'sess-gesture2' } })
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
      const pane = h.rowsPlain().findIndex(line => line.includes('[Categories (9)]'))
      assert.ok(pane >= 0)
      assert.ok(visibleWidth(h.vt.getViewport()[pane]!) <= columns, `the pane header fits ${columns}`)
    }
    await key(h, '\r') // L0 -> L1
    if (columns >= 76) {
      const pane = h.rowsPlain().findIndex(line => line.includes('Rows (3)'))
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
  let paneRow = h.rowsPlain().findIndex(line => line.includes('[Categories (9)]'))
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

  // The same guard covers the Legacy Detail buttons (`Change…` is the remaining
  // painted action: the Legacy Copy hit is retired).
  const mouseLegacy = setup({ columns: 120, rows: 8, doc: { theme: 'dark' } })
  await mouseLegacy.open('Appearance')
  await key(mouseLegacy, '\r') // rows level, Detail buttons painted
  const staleChangeRow = rowOf(mouseLegacy, 'Change…')
  const staleChangeCol = cellIndexOf(mouseLegacy, staleChangeRow, 'Change…')
  mouseLegacy.vt.resize(120, 7)
  press(mouseLegacy, staleChangeRow, staleChangeCol)
  release(mouseLegacy, staleChangeRow, staleChangeCol)
  await settle(mouseLegacy)
  assert.doesNotMatch(mouseLegacy.view(), /Choose value/u, 'the stale legacy Detail click did not open the choice')
  assert.equal(mouseLegacy.replacements(), 0, 'the stale legacy Detail click wrote nothing')
  assert.deepEqual(mouseLegacy.copied, [], 'and it copied nothing')
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

// ── C2-R0: the LIVE extension settings directory (L6, no faked count) ─────
//
// The count is never pre-seeded in the snapshot: a real in-process
// `SettingsRegistry` (the object the extension service exposes as
// `runner.extensions.settings`) is registered/unregistered, its invalidation
// reaches the surface's render path, and the production `/settings` handler
// reads the live directory on every frame.

test('C2-R0 a live registration appends Extensions and its launcher reaches the existing editor row', async () => {
  let invalidations = 0
  let requestRender: () => void = () => {}
  const registry = new SettingsRegistry(() => { invalidations += 1; requestRender() })
  const h = setup({ columns: 120, rows: 40, settingsRegistry: registry, pluginPage: true })
  requestRender = () => h.app.requestRender()
  const handle = registry.register({
    id: 'acme.demo-threshold',
    label: 'Demo threshold',
    description: 'The demo plugin threshold',
    currentValue: '3',
    values: ['1', '3', '5'],
    order: 10,
    onChange: () => true,
  }, 'acme-owner')
  assert.equal(invalidations, 1, 'the registry invalidation reached the surface render path')
  await h.vt.waitForRender()
  await h.openHome()
  assert.match(h.view(), /Categories \(10\)/u, 'the live directory appends the tenth category')
  await key(h, '\u001b[F')
  assert.match(h.view(), /^> Extensions/mu, `End reaches the live category:\n${h.view()}`)
  await key(h, '\r')
  assert.match(h.rowsPlain()[0]!, /Settings · Extensions · Rows/u)
  assert.match(h.view(), /Configure extension settings…/u, 'the transition launcher is painted')
  assert.match(h.view(), /1 setting · 1 contributor/u, 'the summary counts the live rows and owners')
  assert.match(h.view(), /Existing settings editor/u, 'the transition scope is stated')
  await key(h, '\r')
  const legacy = h.view()
  assert.match(legacy, /Type to search/u, `the existing editor is the physical owner:\n${legacy}`)
  assert.ok(!legacy.includes('Settings · '), 'the workspace is retired, not stacked underneath')
  assert.match(legacy, /Demo threshold/u, 'the editor opens on the registered row')

  // The live unregistration is the same chain in reverse: the category and its
  // launcher disappear, and Esc still has a legal return.
  await key(h, '\u001b') // legacy -> conversation
  await h.openHome()
  assert.match(h.view(), /Categories \(10\)/u)
  await key(h, '\u001b[F')
  await key(h, '\r') // Extensions rows
  handle.dispose()
  assert.equal(invalidations, 2, 'the unregistration invalidated the surface too')
  // The gesture that discovers the empty directory never opens the old editor.
  await key(h, '\r')
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('Type to search'), 'no stale launcher opens the editor')
  assert.match(h.rowsPlain()[0]!, /Settings · Categories/u, 'the rail owns the keyboard again')
  assert.match(h.view(), /^> Plugins/mu, 'the selected Extensions category fell back to Plugins')
  assert.match(h.view(), /Categories \(9\)/u, 'the empty directory paints the nine fixed categories')
  await key(h, '\u001b')
  assert.ok(h.view().includes('❯'), 'Esc still closes the workspace legally')
  h.dispose()
})

test('C2-R0 a stale keyboard Enter cannot open a replaced contributor before the repaint', async () => {
  let requestRender: () => void = () => {}
  const registry = new SettingsRegistry(() => requestRender())
  const h = setup({ columns: 120, rows: 40, settingsRegistry: registry })
  requestRender = () => h.app.requestRender()
  const oldCalls: string[] = []
  const newCalls: string[] = []
  const oldOwner = registry.register({
    id: 'acme.replaced',
    label: 'Replaced setting v1',
    description: 'The first owner generation',
    currentValue: '5',
    values: ['3', '5'],
    order: 5,
    onChange: (value) => { oldCalls.push(value); return true },
  }, 'acme-owner-old')
  await h.vt.waitForRender()
  await h.openHome()
  await key(h, '\u001b[F') // End -> Extensions
  await key(h, '\r') // its Rows level
  assert.match(h.rowsPlain()[0]!, /Settings · Extensions · Rows/u)
  assert.match(h.view(), /Configure extension settings…/u)
  // The same id is unregistered and re-registered under a different owner and
  // callback BEFORE any repaint; the count stays 1 and only the revision moves.
  oldOwner.dispose()
  registry.register({
    id: 'acme.replaced',
    label: 'Replaced setting v2',
    description: 'The second owner generation',
    currentValue: '3',
    values: ['3', '5'],
    order: 5,
    onChange: (value) => { newCalls.push(value); return true },
  }, 'acme-owner-new')
  // A keyboard Enter arrives before the repaint. It must neither open the
  // existing editor nor advance the level with the spent frame.
  h.vt.sendInput('\r')
  assert.ok(!h.view().includes('Type to search'), 'the stale Enter did not mount the legacy editor')
  assert.deepEqual(oldCalls, [], 'the replaced owner callback never runs')
  assert.deepEqual(newCalls, [], 'the current owner callback does not run from a stale key either')
  // The frame composed against the CURRENT registry keeps the level where the
  // user was: neither the editor (no Settings chrome) nor the Detail level may
  // have been entered by the refused key.
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /Settings · Extensions · Rows/u, 'the refused key left the level untouched')
  assert.ok(!h.view().includes('Change…'), 'the refused key entered no Detail action')
  // The repainted launcher is actionable again and targets the CURRENT row.
  await key(h, '\r')
  const legacy = h.view()
  assert.match(legacy, /Type to search/u, `the existing editor is the physical owner:\n${legacy}`)
  assert.match(legacy, /Replaced setting v2/u, 'the editor opened on the CURRENT registration')
  assert.ok(!legacy.includes('Replaced setting v1'), 'the replaced label is gone')
  // Activating the row runs the CURRENT callback through the registry's own
  // apply path; the replaced generation is never invoked.
  await key(h, '\r')
  await settle(h)
  assert.equal(oldCalls.length, 0, 'the replaced owner callback still never ran')
  assert.equal(newCalls.length, 1, 'the current owner callback ran exactly once')
  h.dispose()
})

test('C2-R0 a cross-generation pointer release cannot open a replaced contributor', async () => {
  let requestRender: () => void = () => {}
  const registry = new SettingsRegistry(() => requestRender())
  const h = setup({ columns: 120, rows: 40, settingsRegistry: registry })
  requestRender = () => h.app.requestRender()
  const calls: string[] = []
  const oldOwner = registry.register({
    id: 'acme.pointer-replaced',
    label: 'Pointer setting v1',
    description: 'The pressed owner generation',
    currentValue: '3',
    values: ['3', '5'],
    order: 5,
    onChange: (value) => { calls.push(`old:${value}`); return true },
  }, 'acme-pointer-old')
  await h.vt.waitForRender()
  await h.openHome()
  await key(h, '\u001b[F')
  await key(h, '\r')
  const frame = h.rowsPlain()
  const row = frame.findIndex(line => line.includes('Configure extension settings…'))
  assert.ok(row >= 0, `the launcher must be painted:\n${h.view()}`)
  const col = cellIndexOf(h, row, 'Configure extension settings…') + 1
  // The press is recorded against the frame that painted owner A.
  press(h, row, col)
  oldOwner.dispose()
  registry.register({
    id: 'acme.pointer-replaced',
    label: 'Pointer setting v2',
    description: 'The replacement owner generation',
    currentValue: '5',
    values: ['3', '5'],
    order: 5,
    onChange: (value) => { calls.push(`new:${value}`); return true },
  }, 'acme-pointer-new')
  // The release of the recorded press arrives before the repaint: it must not
  // complete the gesture recorded against the replaced generation.
  release(h, row, col)
  assert.ok(!h.view().includes('Type to search'), 'the straddling release did not mount the legacy editor')
  assert.deepEqual(calls, [], 'no owner callback ran from the stale pointer gesture')
  await h.vt.waitForRender()
  assert.match(h.rowsPlain()[0]!, /Settings · Extensions · Rows/u, 'the refused release left the level untouched')
  // The repainted frame admits a FRESH activation of the current row.
  await key(h, '\r')
  assert.match(h.view(), /Type to search/u, 'a fresh activation after the repaint opens the editor')
  assert.match(h.view(), /Pointer setting v2/u, 'the editor opened on the replacement owner row')
  h.dispose()
})

// ── C2-R0: the REAL extension service → Settings repaint chain ────────────
//
// The cases above inject the in-process SettingsRegistry directly. This one
// proves the same production path the PLAN requires: a real Cordis plugin fiber
// calls the public `registerSetting()`, the service's InvalidateBatcher flushes
// into the LIVE surface render sink, the production `/settings` handler reads
// `runner.extensions.settings.snapshot()`, and the painted frame moves — with
// the fiber dispose (the HMR unload) moving it back.

test('C2-R0 a real extension fiber registration reaches the mounted Settings workspace and its unload retracts it', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    const startupFiber = ctx.plugin((c) => { c.provide(TUI_STARTUP_SERVICE, {}) })
    await startupFiber
    const hostFiber = ctx.plugin(applyExtensionHost)
    await hostFiber
    const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as unknown as {
      registerSetting(contribution: {
        readonly id: string
        readonly label: string
        readonly description?: string
        readonly currentValue: string
        readonly values?: readonly string[]
        readonly onChange?: (value: string) => boolean
      }): { readonly id: string; setValue(value: string): void; dispose(): void }
      settings: SettingsRegistry
      attachSurface(
        bridge: { subscribe(listener: (state: unknown) => void): () => void },
        capabilities: ReadonlySet<string>,
        surfaceId: string,
        requestRender?: (force?: boolean) => void,
      ): void
      detachSurface(surfaceId?: string): void
    }
    assert.ok(service !== undefined, 'the extension service is provided by the real host')
    // The workspace reads the SERVICE's own registry, not a test-owned copy.
    const h = setup({ columns: 120, rows: 24, settingsRegistry: service.settings, pluginPage: true })
    // Wire the service's batcher to THIS surface, exactly like the production
    // extension runtime does after the SurfaceHost attaches.
    service.attachSurface(
      { subscribe: () => () => {} },
      new Set(),
      'c2-r0-surface',
      () => h.app.requestRender(),
    )
    await h.vt.waitForRender()
    await h.openHome()
    assert.match(h.rowsPlain()[0]!, /Settings · Categories/u)
    assert.equal(h.view().includes('Categories (9)'), true, 'no Extensions category without live rows')

    // A real plugin fiber registers through the PUBLIC service API.
    const fiber = ctx.plugin((pluginCtx) => {
      const svc = pluginCtx.get(PI_TUI_EXTENSIONS_SERVICE) as unknown as {
        registerSetting(contribution: {
          readonly id: string
          readonly label: string
          readonly description?: string
          readonly currentValue: string
          readonly values?: readonly string[]
        }): unknown
      }
      svc.registerSetting({
        id: 'fiber.demo-limit',
        label: 'Demo limit',
        description: 'Registered by a real fiber',
        currentValue: '3',
        values: ['1', '3', '5'],
      })
    })
    await fiber
    // The batcher flush is a microtask; the repaint it schedules is the ONLY
    // reason the frame can change (no key was pressed).
    await new Promise<void>(resolve => queueMicrotask(resolve))
    await new Promise<void>(resolve => setTimeout(resolve, 25))
    await h.vt.waitForRender()
    assert.match(h.view(), /Categories \(10\)/u, 'the live registration appended Extensions with no user input')
    await key(h, '\u001b[F')
    await key(h, '\r')
    assert.match(h.rowsPlain()[0]!, /Settings · Extensions · Rows/u)
    assert.match(h.view(), /Configure extension settings…/u)
    assert.match(h.view(), /1 setting · 1 contributor/u, 'the summary counts the fiber-owned live rows')

    // The fiber dispose is the HMR unload: the directory retracts through the
    // same service → batcher → surface chain.
    await fiber.dispose()
    await new Promise<void>(resolve => queueMicrotask(resolve))
    await new Promise<void>(resolve => setTimeout(resolve, 25))
    await h.vt.waitForRender()
    assert.match(h.rowsPlain()[0]!, /Settings · Categories/u, 'the unload moved the keyboard to the rail')
    assert.match(h.view(), /^> Plugins/mu, 'the emptied Extensions category falls back to Plugins')
    assert.match(h.view(), /Categories \(9\)/u, 'the category is retracted without user input')
    // Neither the register nor the unload started the existing editor: the
    // Settings workspace still owns the frame.
    assert.match(h.rowsPlain()[0]!, /Settings · /u, 'the Settings workspace still owns the frame')
    assert.ok(!h.view().includes('Type to search'), 'the existing settings list never mounted')
    service.detachSurface('c2-r0-surface')
    h.dispose()
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const disposedFiber of runtime.fibers) await Promise.resolve(disposedFiber.dispose())
    }
  }
})

// ── C2-R1: the five migrated Appearance / Conversation writers ─────────────
//
// Every case below drives the REAL composition: the registered `/settings`
// command builds the snapshot, the panel owns the choice, the command's ONE
// `commitSettingsWorkspaceField` applies the live owner and persists through
// the serialized document queue, and the assertions read the SINK (the app's
// live icon/disclosure state, the shared prompt-state objects, the document
// the write really produced) — never a count of dispatched requests alone.

/** The frozen Appearance row membership (C2-R1). */
const APPEARANCE_ROWS = ['Configured theme', 'Icon style', 'Footer & status line…'] as const

/** The frozen Conversation row order (C2-R2: the launcher is retired, the two
 *  migrated policy rows sit LAST). */
const CONVERSATION_ROWS = [
  'Transcript display', 'Transcript detail', 'Thinking detail',
  'Progress updates', 'Response style', 'Submit while busy', 'Git attribution',
] as const

/** The frozen Input & Terminal row order (C2-R2: six writable rows, then the
 *  remaining Keyboard shortcuts handoff LAST). */
const INPUT_TERMINAL_ROWS = [
  'Home/End keys', 'Fullscreen', 'Mouse wheel lines',
  'Notifications', 'Notification method', 'Terminal progress',
  'Input & terminal settings…',
] as const

/** Select one LEGACY row of a category at L1 with the real keys. */
async function selectRow(h: Harness, category: string, row: string): Promise<void> {
  await h.open(category)
  await key(h, '\r') // L0 -> L1
  const target = CONVERSATION_ROWS.indexOf(row as (typeof CONVERSATION_ROWS)[number])
  const steps = target >= 0 ? target : 0
  for (let step = 0; step < steps; step += 1) await key(h, '\x1b[B')
}

/** Press Down (bounded) until the painted highlight sits on `value`. Each row's
 *  candidate order is its own authority, so a case navigates by the identity it
 *  wants instead of assuming an offset. The highlight is read from the DETAIL
 *  column the choice really paints (the Rows pane has its own `> ` cursor). */
async function highlightCandidate(h: Harness, value: string): Promise<void> {
  /** The candidate the DETAIL column's own cursor currently marks. The Rows
   *  pane has its own `> ` cursor, so the search starts where the painted
   *  Details column starts (the pane header's `[Details]` marker). */
  const selectedCandidate = (): string | undefined => {
    const lines = h.rowsPlain()
    const header = lines.findIndex(line => line.includes('[Details]'))
    assert.ok(header >= 0, `the Details pane header must be painted:\n${h.view()}`)
    const paneStart = Math.max(0, lines[header]!.indexOf('[Details]') - 2)
    for (const line of lines.slice(header + 1)) {
      const tail = line.slice(paneStart)
      const at = tail.indexOf('> ')
      if (at >= 0) return tail.slice(at + 2)
    }
    return undefined
  }
  // The candidate list does NOT wrap (Down clamps at the last entry), so the
  // helper walks to the TOP first and then searches downwards.
  for (let step = 0; step < 6; step += 1) await key(h, '\x1b[A')
  for (let step = 0; step < 6; step += 1) {
    if (selectedCandidate()?.startsWith(value)) return
    await key(h, '\x1b[B')
  }
  assert.fail(`the ${value} candidate must be reachable:\n${h.view()}`)
}

/** Open the L2 choice of one already-selected row and confirm the candidate
 *  `steps` rows below the current one (the painted list order). */
async function chooseCandidate(h: Harness, steps: number): Promise<void> {
  await key(h, '\r') // L1 -> L2 choice
  for (let step = 0; step < steps; step += 1) await key(h, '\x1b[B')
  await key(h, '\r') // explicit Confirm
  await settle(h)
}

// Regression: C2-R1 acceptance R1-01.
test('Appearance keeps Theme + Icon style + the Footer launcher; Conversation is the frozen seven', async () => {
  const h = setup({ columns: 120, rows: 40 })
  await h.open('Appearance')
  await key(h, '\r')
  const appearance = h.view()
  assert.match(appearance, /Rows \(3\)/u, 'Appearance states its real three rows')
  assert.match(appearance, /Configured theme/u)
  assert.match(appearance, /Icon style/u)
  assert.match(appearance, /Footer & status line…/u)
  assert.doesNotMatch(appearance, /Transcript detail|Thinking detail|Progress updates|Response style/u)

  await key(h, '\x1b') // Rows -> Categories (narrow/wide both keep the level)
  await h.vt.waitForRender()
  await walkToConversation(h)
  await key(h, '\r')
  const conversation = h.view()
  assert.match(conversation, /Rows \(7\)/u, 'Conversation states its real seven rows')
  let previous = -1
  for (const label of CONVERSATION_ROWS) {
    const at = conversation.indexOf(label)
    assert.ok(at > previous, `${label} keeps its frozen position:\n${conversation}`)
    previous = at
  }
  h.dispose()
})

/** Walk an ALREADY-OPEN workspace's rail to Conversation from any category. */
async function walkToConversation(h: Harness): Promise<void> {
  for (let step = 0; step < CATEGORY_ORDER.length; step += 1) {
    if (h.rowsPlain().some(line => line.startsWith('> Conversation'))) return
    await key(h, '\x1b[B')
  }
  assert.fail(`the rail never reached Conversation:\n${h.view()}`)
}

// Regression: C2-R1 acceptance R1-02.
test('browsing, moving, Tab, wheel and Esc never mutate any of the five', async () => {
  const h = setup({ columns: 120, rows: 40, iconStyle: 'emoji' })
  const iconBefore = h.app.currentIconStyle()
  const expandBefore = h.app.isTranscriptDetailExpanded()
  const thinkingBefore = h.app.isThinkingExpanded()
  const progressBefore = h.progressUpdatesState.mode
  const responseBefore = h.responseStyleState.style

  await h.open('Appearance')
  await key(h, '\r')
  await key(h, '\x1b[B') // Configured theme -> Icon style
  await key(h, '\r') // the inline choice
  assert.match(h.view(), /Choose value/u)
  await key(h, '\x1b[B')
  await key(h, '\t')
  wheel(h, 8, 6)
  await settle(h)
  await key(h, '\x1b') // cancel

  await key(h, '\x1b') // Rows -> Categories
  await h.vt.waitForRender()
  await walkToConversation(h)
  await key(h, '\r')
  for (let step = 0; step < 6; step += 1) {
    await key(h, '\x1b[B')
    await key(h, '\r') // details / choice
    await key(h, '\x1b[B')
    await key(h, '\x1b') // cancel
  }

  assert.equal(h.replacements(), 0, 'browsing never writes the document')
  assert.equal(h.app.currentIconStyle(), iconBefore, 'the live icon style is untouched')
  assert.equal(h.app.isTranscriptDetailExpanded(), expandBefore, 'the transcript disclosure is untouched')
  assert.equal(h.app.isThinkingExpanded(), thinkingBefore, 'the thinking disclosure is untouched')
  assert.equal(h.progressUpdatesState.mode, progressBefore, 'the shared progress state is untouched')
  assert.equal(h.responseStyleState.style, responseBefore, 'the shared response state is untouched')
  h.dispose()
})

// Regression: C2-R1 acceptance R1-03.
test('Icon style applies live and persists only its own document field', async () => {
  const fixture = createDirectSettingsFixture({ theme: 'dark', iconStyle: 'emoji' })
  const h = setup({ columns: 140, rows: 40, tuiSettings: fixture.settings, iconStyle: 'emoji' })
  await h.open('Appearance')
  await key(h, '\r')
  await key(h, '\x1b[B') // Icon style
  await key(h, '\r')
  assert.match(h.view(), /> emoji\s+\[current\]/u, 'the LIVE style owns the current chip')
  await key(h, '\x1b[B') // emoji -> symbols
  await key(h, '\r') // Confirm
  await settle(h)

  assert.equal(h.app.currentIconStyle(), 'symbols', 'the surface really switched its glyph vocabulary')
  assert.equal(fixture.document().iconStyle, 'symbols', 'the document stores the new style')
  assert.equal(fixture.document().theme, 'dark', 'no other field was rewritten')
  assert.equal(fixture.calls.length, 1, 'exactly one path-scoped mutation')
  assert.deepEqual(fixture.calls[0]!.ops, [{ op: 'set', path: ['iconStyle'], value: 'symbols' }])
  assert.match(h.view(), /Status\s+Verified/u, 'the authoritative re-read verified the write')
  assert.match(h.view(), /Persisted\s+symbols/u, 'the persisted fact follows the document')
  h.dispose()
})

// Regression: C2-R1 acceptance R1-04.
test('a missing or invalid stored iconStyle keeps its raw persisted fact while the runtime normalizes', async () => {
  for (const stored of [undefined, 'garbage'] as const) {
    const h = setup({
      columns: 140,
      rows: 40,
      // An old/invalid document: the field is absent or carries junk.
      tuiSettings: (() => {
        const values: TuiSettingsDoc = { ...DEFAULT_DOC }
        if (stored === undefined) delete (values as { iconStyle?: string }).iconStyle
        else (values as { iconStyle?: string }).iconStyle = stored
        return { get: () => values, replace: (next: TuiSettingsDoc) => { Object.assign(values, next) } }
      })(),
      iconStyle: 'emoji',
    })
    await h.open('Appearance')
    await key(h, '\r')
    await key(h, '\x1b[B')
    assert.match(h.view(), /Value\s+emoji/u, `the runtime normalizes ${JSON.stringify(stored)} to emoji`)
    assert.match(h.view(), /Persisted\s+not set|Persisted\s+garbage/u,
      `the raw stored fact is never replaced by the normalized value (${JSON.stringify(stored)})`)
    assert.ok(!h.view().includes('Persisted  emoji') && !/Persisted\s+emoji/u.test(h.view()),
      'a normalized runtime value is never presented as the stored one')
    assert.equal(h.replacements(), 0)
    h.dispose()
  }
})

// Regression: C2-R1 acceptance R1-05.
test('Transcript detail confirms into the SAME Ctrl+O owner and writes no document', async () => {
  const h = setup({ columns: 140, rows: 40 })
  const before = h.app.isTranscriptDetailExpanded()
  await h.open('Conversation')
  await key(h, '\r')
  await key(h, '\x1b[B') // Transcript display -> Transcript detail
  await key(h, '\r')
  assert.match(h.view(), /> collapsed\s+\[current\]/u)
  await key(h, '\x1b[B') // collapsed -> expanded
  await key(h, '\r')
  await settle(h)

  assert.equal(h.app.isTranscriptDetailExpanded(), true, 'the Ctrl+O master switch really changed')
  assert.equal(h.replacements(), 0, 'the runtime-only field writes NO settings document')
  assert.equal(h.doc.displayPreset, DEFAULT_DOC.displayPreset, 'the display preset is untouched')
  assert.match(h.view(), /Status\s+Verified/u, 'the live runtime fact was verified')
  assert.match(h.view(), /Persisted\s+not applicable — runtime-only/u, 'the Detail never claims a save')
  assert.ok(!h.view().includes('Saving…'), 'no persistence phase is painted for a runtime-only field')

  // The hotkey keeps sharing the ONE owner: a later Ctrl+O changes what the
  // next Settings open reads (the workspace is closed first: ONE lease).
  await key(h, '\x1b') // Detail -> Rows
  await key(h, '\x1b') // Rows -> Categories
  await key(h, '\x1b') // close
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('Settings · '), 'the workspace closed before the re-open')
  await h.open('Conversation')
  await key(h, '\r')
  await key(h, '\x1b[B')
  assert.match(h.view(), /Value\s+expanded/u, 'a re-open reads the hotkey-updated fact')
  h.dispose()
})

// Regression: C2-R1 acceptance R1-06.
test('Thinking detail confirms into the SAME Alt+T owner and writes no document', async () => {
  const h = setup({ columns: 140, rows: 40 })
  await h.open('Conversation')
  await key(h, '\r')
  for (let step = 0; step < 2; step += 1) await key(h, '\x1b[B') // -> Thinking detail
  await key(h, '\r')
  assert.match(h.view(), /> collapsed\s+\[current\]/u)
  await key(h, '\x1b[B')
  await key(h, '\r')
  await settle(h)
  assert.equal(h.app.isThinkingExpanded(), true, 'the shared Thinking disclosure really changed')
  assert.equal(h.replacements(), 0, 'the runtime-only field writes NO settings document')
  assert.match(h.view(), /Persisted\s+not applicable — runtime-only/u)
  h.dispose()
})

// Regression: C2-R1 acceptance R1-07.
test('Progress updates writes the SAME shared state and persists Off / Milestones / Frequent', async () => {
  const fixture = createDirectSettingsFixture({ progressUpdates: 'milestones' })
  const h = setup({ columns: 140, rows: 40, tuiSettings: fixture.settings })
  await h.open('Conversation')
  await key(h, '\r')
  for (let step = 0; step < 3; step += 1) await key(h, '\x1b[B') // -> Progress updates
  await key(h, '\r')
  assert.match(h.view(), /> milestones\s+\[current\]/u)
  await key(h, '\x1b[A') // milestones -> off
  await key(h, '\r')
  await settle(h)

  assert.equal(h.progressUpdatesState.mode, 'off', 'the shared object the prompt provider reads changed')
  assert.equal(fixture.document().progressUpdates, 'off', 'the cadence really persisted')
  assert.equal(fixture.document().responseStyle, 'default', 'the OTHER prompt axis is untouched')
  assert.equal(h.responseStyleState.style, 'default', 'the live response style is untouched')
  assert.match(h.view(), /Status\s+Verified/u)
  assert.match(h.view(), /Persisted\s+off/u, 'the persisted fact follows the stored value')
  h.dispose()
})

// Regression: C2-R1 acceptance R1-08.
test('Response style writes the SAME shared state and never touches the progress axis', async () => {
  const fixture = createDirectSettingsFixture({ progressUpdates: 'frequent', responseStyle: 'default' })
  const h = setup({ columns: 140, rows: 40, tuiSettings: fixture.settings })
  h.progressUpdatesState.mode = 'frequent'
  await h.open('Conversation')
  await key(h, '\r')
  for (let step = 0; step < 4; step += 1) await key(h, '\x1b[B') // -> Response style
  await key(h, '\r')
  await key(h, '\x1b[B') // default -> concise
  await key(h, '\r')
  await settle(h)

  assert.equal(h.responseStyleState.style, 'concise', 'the shared response-style object changed')
  assert.equal(fixture.document().responseStyle, 'concise')
  assert.equal(h.progressUpdatesState.mode, 'frequent', 'the progress axis is untouched in memory')
  assert.equal(fixture.document().progressUpdates, 'frequent', 'and untouched in the document')
  assert.match(h.view(), /Status\s+Verified/u)
  h.dispose()
})

// Regression: C2-R1 acceptance R1-09.
test('every persisted field needs an agreeing authoritative re-read to be Verified', async () => {
  for (const [field, steps, category] of [
    ['icon-style', 1, 'Appearance'],
    ['progress-updates', 3, 'Conversation'],
    ['response-style', 4, 'Conversation'],
  ] as const) {
    const h = setup({ columns: 140, rows: 40 })
    await h.open(category)
    await key(h, '\r')
    for (let step = 0; step < steps; step += 1) await key(h, '\x1b[B')
    await chooseCandidate(h, 1)
    assert.equal(h.replacements(), 1, `${field} wrote exactly once`)
    assert.match(h.view(), /Status\s+Verified/u, `${field} verified after the re-read agreed`)
    h.dispose()
  }
})

// Regression: C2-R1 acceptance R1-10.
test('a completed write whose re-read is unavailable is Commit accepted, never Verified', async () => {
  // The write REALLY completes (the document stores the new value) and only the
  // authoritative RE-READ then fails: `verifyCommittedField` must report
  // `Commit accepted · verification unavailable` and keep the applied runtime.
  const h = setup({ columns: 140, rows: 40, doc: { responseStyle: 'default' }, getFailureAfterWrite: true })
  await h.open('Conversation')
  await key(h, '\r')
  for (let step = 0; step < 4; step += 1) await key(h, '\x1b[B') // Response style
  await key(h, '\r')
  await key(h, '\x1b[B') // default -> concise
  await key(h, '\r')
  await settle(h)

  assert.equal(h.replacements(), 1, 'the document write really ran')
  assert.equal(h.responseStyleState.style, 'concise', 'the runtime fact stays applied')
  assert.match(h.view(), /Commit accepted/u, 'a completed write without a readback is accepted, not verified')
  assert.match(h.view(), /verification unavailable/u)
  assert.ok(!h.view().includes('Status  Verified'), 'an unperformed readback is never Verified')
  h.dispose()
})

// Regression: C2-R1 acceptance R1-11.
test('a write the authority readably disagrees with is Not saved and keeps both facts apart', async () => {
  const h = setup({
    columns: 140,
    rows: 40,
    doc: { responseStyle: 'default' },
    applyReplace: () => {}, // the write returns success, the document never changes
  })
  await h.open('Conversation')
  await key(h, '\r')
  for (let step = 0; step < 4; step += 1) await key(h, '\x1b[B') // Response style
  await key(h, '\r')
  await key(h, '\x1b[B') // default -> concise
  await key(h, '\r')
  await settle(h)

  assert.equal(h.responseStyleState.style, 'concise', 'the live fact applied first (apply-first contract)')
  assert.match(h.view(), /Not saved · the write reported success/u)
  assert.match(h.view(), /authoritative document reads/u)
  assert.match(h.view(), /Value\s+concise/u, 'the runtime fact is still shown as applied')
  assert.match(h.view(), /Persisted\s+default/u, 'the stored fact still reads the old value')
  assert.match(h.view(), /Retry save/u)
  assert.ok(!h.view().includes('Status  Verified'))
  h.dispose()
})

// Regression: C2-R1 acceptance R1-12.
test('a refused write is attributed from a fresh read: base, expected and unreadable all stay unblamed', async () => {
  const notSaved = setup({
    columns: 140,
    rows: 40,
    doc: { responseStyle: 'default' },
    applyReplace: () => { throw new Error('settings namespace "tui-app" changed since it was read') },
  })
  await notSaved.open('Conversation')
  await key(notSaved, '\r')
  for (let step = 0; step < 4; step += 1) await key(notSaved, '\x1b[B')
  await key(notSaved, '\r')
  await key(notSaved, '\x1b[B')
  await key(notSaved, '\r')
  await settle(notSaved)
  assert.match(notSaved.view(), /Not saved · the response style is applied/u)
  assert.match(notSaved.view(), /storing it failed/u)
  assert.ok(!notSaved.view().includes('Status  Verified'))
  assert.equal(notSaved.responseStyleState.style, 'concise', 'the refused persistence keeps the applied runtime')
  notSaved.dispose()

  // A rejection whose fresh read already carries the REQUESTED value: neither
  // acceptance nor refusal may be attributed to THIS commit.
  const expected = setup({
    columns: 140,
    rows: 40,
    doc: { responseStyle: 'default' },
    applyReplace: () => {
      expected.doc.responseStyle = 'concise' // the value is in place, attribution is impossible
      throw new Error('post-write describe failed')
    },
  })
  await expected.open('Conversation')
  await key(expected, '\r')
  for (let step = 0; step < 4; step += 1) await key(expected, '\x1b[B')
  await key(expected, '\r')
  await key(expected, '\x1b[B')
  await key(expected, '\r')
  await settle(expected)
  assert.match(expected.view(), /Outcome unknown/u, 'a value already in place is never attributed as this commit')
  assert.match(expected.view(), /already reads concise/u)
  expected.dispose()

  // A rejection whose fresh read carries a THIRD value: someone else wrote in
  // between, so this request is not attributed either.
  const third = setup({
    columns: 140,
    rows: 40,
    doc: { responseStyle: 'default' },
    applyReplace: () => {
      third.doc.responseStyle = 'explanatory'
      throw new Error('post-write describe failed')
    },
  })
  await third.open('Conversation')
  await key(third, '\r')
  for (let step = 0; step < 4; step += 1) await key(third, '\x1b[B')
  await key(third, '\r')
  await key(third, '\x1b[B')
  await key(third, '\r')
  await settle(third)
  assert.match(third.view(), /Outcome unknown/u, 'a third value is never a refusal')
  assert.match(third.view(), /started from either/u)
  third.dispose()

  // A non-ready backend is refused BEFORE the write: the runtime still applies,
  // and NO document write is dispatched (the readiness gate, not the classifier).
  const staleGate = setup({
    columns: 140,
    rows: 40,
    doc: { responseStyle: 'default' },
  })
  await staleGate.open('Conversation')
  await key(staleGate, '\r')
  for (let step = 0; step < 4; step += 1) await key(staleGate, '\x1b[B')
  await key(staleGate, '\r')
  staleGate.setReadiness('stale') // the gate refuses the persistence
  await key(staleGate, '\x1b[B')
  await key(staleGate, '\r')
  await settle(staleGate)
  assert.match(staleGate.view(), /Not saved · the response style is applied/u,
    'the stale gate refuses the persistence BEFORE the write for the apply-first rows')
  assert.equal(staleGate.replacements(), 0, 'the readiness gate dispatched no write')
  staleGate.dispose()

  // A rejection whose fresh read is UNAVAILABLE — the Remote-shaped case the
  // plan's R1-12 names: the replace WAS attempted and threw, then the
  // authoritative readback cannot be performed either. Neither acceptance nor
  // refusal may be attributed, so it is `Outcome unknown`, never `Not saved`.
  const unreadable = setup({
    columns: 140,
    rows: 40,
    doc: { responseStyle: 'default' },
    // `ready` at commit time (so the write really runs), `replace` throws, and
    // every read AFTER that write fails: `classifyRejectedWrite` therefore takes
    // its `unavailable` branch.
    getFailureAfterWrite: true,
    applyReplace: () => {
      throw new Error('post-write describe failed')
    },
  })
  await unreadable.open('Conversation')
  await key(unreadable, '\r')
  for (let step = 0; step < 4; step += 1) await key(unreadable, '\x1b[B')
  await key(unreadable, '\r')
  await key(unreadable, '\x1b[B')
  await key(unreadable, '\r')
  await settle(unreadable)
  assert.equal(unreadable.replacements(), 1, 'the rejected write really reached the document writer')
  assert.equal(unreadable.responseStyleState.style, 'concise',
    'the apply-first runtime fact stays live through the unreadable rejection')
  assert.match(unreadable.view(), /Outcome unknown/u,
    'a rejection whose readback is unavailable cannot be attributed to this commit')
  assert.match(unreadable.view(), /post-write describe failed/u, 'the real failure reason is stated')
  assert.match(unreadable.view(), /could not be re-read/u, 'the unavailable readback is named')
  assert.ok(!unreadable.view().includes('Status  Verified'), 'an unattributable write is never Verified')
  assert.doesNotMatch(unreadable.view(), /Status\s+Not saved/u,
    'an unreadable authority is never reported as a refusal')
  unreadable.dispose()
})

// Regression: C2-R1 acceptance R1-13.
test('a QUEUED second write re-reads the live document and preserves the pass-through fields', async () => {
  const userItems = [{ schemaVersion: 1, id: 'user:clock', kind: 'text', text: 'hi' }]
  const trust = { schemaVersion: 1, command: 'echo hi', timeoutMs: 300 }
  const keybindings = { schemaVersion: 1, bindings: { ctrlx: 'app.exit' } }
  const fixture = createDirectSettingsFixture({
    theme: 'dark',
    iconStyle: 'emoji',
    progressUpdates: 'milestones',
    // The real USER-layer definitions and trust data ride the document, exactly
    // as the effective read returns them, so the guard's projection is a no-op.
    footerCustomItems: userItems,
    footerCommand: trust,
    keybindings,
  })
  /**
   * The write path the R1 writers really use (`serializeTuiSettingsMutation`),
   * with the FIRST task held open. That is the only shape that can prove the
   * queue-internal re-read: the second task must not have read the document yet.
   */
  let releaseFirst!: () => void
  const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve })
  let firstStarted!: () => void
  const firstRunning = new Promise<void>(resolve => { firstStarted = resolve })
  let writeIndex = 0
  const commit = (mutate: (doc: TuiSettingsDoc) => TuiSettingsDoc): Promise<unknown> =>
    serializeTuiSettingsMutation(fixture.settings, async () => {
      writeIndex += 1
      if (writeIndex === 1) {
        firstStarted()
        await firstHeld
      }
      // The production shape: read INSIDE the queue, project the raw USER
      // definitions, then replace.
      return fixture.settings.replace(
        mutate({ ...fixture.settings.get(), footerCustomItems: userItems }),
      )
    })

  const first = commit(doc => ({ ...doc, iconStyle: 'symbols' }))
  await firstRunning
  // The FIRST write is still in flight; the second is queued behind it and has
  // NOT read the document yet.
  assert.equal(fixture.calls.length, 0, 'the held write has not reached the Host')
  const second = commit(doc => ({ ...doc, progressUpdates: 'off' }))
  releaseFirst()
  await first
  await second

  const document = fixture.document() as unknown as Record<string, unknown>
  assert.equal(document.iconStyle, 'symbols', 'the first field landed')
  assert.equal(document.progressUpdates, 'off', 'the queued field landed too — it read the FIRST result')
  assert.equal(document.theme, 'dark', 'no unrelated field was rewritten')
  assert.deepEqual(document.keybindings, keybindings, 'the keybinding pass-through survives verbatim')
  assert.deepEqual(document.footerCommand, trust, 'the trusted footer command survives verbatim')
  assert.deepEqual(document.footerCustomItems, userItems, 'the USER definitions survive verbatim')
  assert.equal(fixture.calls.length, 2, 'two path-scoped writes, never one whole-document overwrite')
  // The second write's ops carry ONLY its own field: it reconciled against the
  // document the FIRST write produced, so the first field emits no op again.
  assert.deepEqual(fixture.calls[0]!.ops, [{ op: 'set', path: ['iconStyle'], value: 'symbols' }])
  assert.deepEqual(fixture.calls[1]!.ops, [{ op: 'set', path: ['progressUpdates'], value: 'off' }],
    'the queued write did not re-pin the first field or the pass-through raw fields')
  assert.deepEqual(
    [fixture.calls[0]!.revision, fixture.calls[1]!.revision],
    [7, 8],
    'each write fences the revision its own read produced',
  )
})

// Regression: C2-R2 acceptance R2-01.
test('the migrated Conversation keeps no launcher while Input & Terminal hands off only Keyboard shortcuts', async () => {
  const conversation = setup({ columns: 120, rows: 40 })
  await conversation.open('Conversation')
  await key(conversation, '\r')
  // Conversation has no unmigrated field left: no launcher may be painted (a
  // launcher for nothing is a false affordance).
  assert.ok(!conversation.view().includes('More conversation settings'),
    `Conversation paints no launcher anymore:\n${conversation.view()}`)
  assert.match(conversation.view(), /Rows \(7\)/u)
  conversation.dispose()

  const h = setup({ columns: 120, rows: 40 })
  await h.open('Input & Terminal')
  await key(h, '\r')
  for (let step = 0; step < INPUT_TERMINAL_ROWS.length - 1; step += 1) await key(h, '\x1b[B')
  assert.ok(h.view().includes('> Input & terminal settings…'),
    `the remaining handoff owns the last Input & Terminal row:\n${h.view()}`)
  await key(h, '\r')
  const legacy = h.view()
  assert.match(legacy, /Type to search/u, 'the existing complete editor is the physical owner')
  assert.match(legacy, />\s*Keyboard shortcuts/u, 'it lands on the remaining row, never on a migrated field')
  assert.ok(!legacy.includes('Settings · '), 'the workspace was retired, never stacked underneath')
  h.dispose()
})

// Regression: C2-R1 acceptance R1-18.
test('every migrated row never copies, at every responsive width', async () => {
  // The copy keys are the retired configuration verb: they must carry nothing
  // from ANY migrated row (Detail AND its open choice), at every width.
  const MIGRATED: readonly (readonly [string, string])[] = [
    ['Appearance', 'Icon style'],
    ['Conversation', 'Transcript detail'],
    ['Conversation', 'Thinking detail'],
    ['Conversation', 'Progress updates'],
    ['Conversation', 'Response style'],
  ]
  for (const [columns, rows] of [[120, 40], [80, 24], [44, 24], [44, 8]] as const) {
    for (const [category, label] of MIGRATED) {
      const h = setup({ columns, rows })
      await h.open(category)
      await key(h, '\r')
      const steps = label === 'Icon style' ? 1 : CONVERSATION_ROWS.indexOf(label as (typeof CONVERSATION_ROWS)[number])
      for (let step = 0; step < steps; step += 1) await key(h, '\x1b[B')
      // Settled Detail.
      for (const data of ['c', 'C']) await key(h, data)
      await settle(h)
      assert.deepEqual(h.copied, [], `${label} copies nothing from its Detail at ${columns}x${rows}`)
      assert.equal(h.replacements(), 0, `${label} writes nothing on a copy key at ${columns}x${rows}`)
      // The open choice.
      await key(h, '\r')
      if (h.view().includes('Choose value')) {
        for (const data of ['c', 'C']) await key(h, data)
        await settle(h)
        assert.deepEqual(h.copied, [], `${label} copies nothing while choosing at ${columns}x${rows}`)
        assert.equal(h.replacements(), 0, `${label} never commits on a copy key at ${columns}x${rows}`)
        assert.match(h.view(), /Choose value/u, `${label} keeps its choice at ${columns}x${rows}`)
      }
      h.dispose()
    }
  }
})

// Regression: C2-R1 acceptance R1-01.
test('every required size walks the real rows: frozen order and Appearance membership', async () => {
  /** Walk a category's Rows level from the TOP, pressing Down until the
   *  selection reaches the last row, collecting every row label the frame
   *  really paints. A scrolled-away row is therefore VISITED, never skipped. */
  const walkedRows = async (h: Harness, category: string, expected: readonly string[]): Promise<string[]> => {
    await h.open(category)
    await key(h, '\r') // L0 -> L1
    const seen: string[] = []
    for (let step = 0; step <= expected.length; step += 1) {
      // The ROWS column is where the row cursor lives: the Categories rail has
      // its own `> ` cursor, so the search starts at the pane header that names
      // the Rows column.
      const lines = h.rowsPlain()
      const header = lines.findIndex(line => line.includes('Rows ('))
      // A multi-column frame publishes the pane header that delimits the Rows
      // column; a NARROW frame paints one column and therefore no pane header at
      // all, so the whole body line is that column's cell.
      let cells: string[]
      if (header >= 0) {
        const paneStart = Math.max(0, lines[header]!.indexOf('Rows (') - 2)
        const detailsAt = lines[header]!.indexOf('Details', paneStart)
        cells = lines.slice(header + 1).map(line => line.slice(paneStart, detailsAt < 0 ? undefined : detailsAt))
      } else {
        cells = lines
      }
      const cursorCell = cells.find(cell => cell.trimStart().startsWith('> '))
      assert.ok(cursorCell !== undefined, `a row cursor must be painted in the Rows column:\n${h.view()}`)
      // The label is the painted text between the cursor and its summary column.
      // A launcher's summary starts in the SAME cell, so the longest expected
      // label that prefixes the cell is the row's identity.
      const rest = cursorCell.trimStart().slice(2)
      const label = [...expected].sort((left, right) => right.length - left.length)
        .find(candidate => rest.startsWith(candidate))
      assert.ok(label !== undefined, `the painted row ${JSON.stringify(rest)} must be an expected row`)
      if (label !== '' && seen.at(-1) !== label) seen.push(label)
      await key(h, '\x1b[B')
    }
    return seen
  }

  // The plan's R2-01 size list, in full.
  for (const [columns, rows] of [[200, 50], [120, 40], [100, 40], [80, 24], [80, 10], [72, 24], [44, 20], [44, 8]] as const) {
    const conversation = setup({ columns, rows })
    const conversationRows = await walkedRows(conversation, 'Conversation', CONVERSATION_ROWS)
    assert.deepEqual(conversationRows, [...CONVERSATION_ROWS],
      `${columns}x${rows} walks the complete frozen Conversation order`)
    assert.doesNotMatch(conversation.view(), /Configured theme|Visual tools/u,
      `${columns}x${rows} leaks no other category's rows`)
    conversation.dispose()

    const appearance = setup({ columns, rows })
    const appearanceRows = await walkedRows(appearance, 'Appearance', APPEARANCE_ROWS)
    assert.deepEqual(appearanceRows, [...APPEARANCE_ROWS],
      `${columns}x${rows} walks the complete Appearance membership`)
    assert.doesNotMatch(appearance.view(), /Transcript detail|Thinking detail|Progress updates|Response style/u,
      `${columns}x${rows} keeps the migrated Conversation rows out of Appearance`)
    appearance.dispose()

    const inputTerminal = setup({ columns, rows })
    const inputRows = await walkedRows(inputTerminal, 'Input & Terminal', INPUT_TERMINAL_ROWS)
    assert.deepEqual(inputRows, [...INPUT_TERMINAL_ROWS],
      `${columns}x${rows} walks the complete frozen Input & Terminal order`)
    assert.doesNotMatch(inputTerminal.view(), /Transcript display|Icon style|Visual tools/u,
      `${columns}x${rows} leaks no other category's rows`)
    inputTerminal.dispose()
  }
})

// Regression: C2-R1 acceptance R1-03.
test('every icon candidate applies live and persists through its ONE field', async () => {
  // emoji -> symbols -> minimal -> emoji, each a separate confirmed write.
  for (const [start, next] of [['emoji', 'symbols'], ['symbols', 'minimal'], ['minimal', 'emoji']] as const) {
    const fixture = createDirectSettingsFixture({ theme: 'dark', iconStyle: start })
    const h = setup({ columns: 140, rows: 40, tuiSettings: fixture.settings, iconStyle: start })
    await h.open('Appearance')
    await key(h, '\r')
    await key(h, '\x1b[B') // Icon style
    await key(h, '\r')
    assert.match(h.view(), new RegExp(`> ${start}\\s+\\[current\\]`, 'u'),
      `the live ${start} owns [current]:\n${h.view()}`)
    await highlightCandidate(h, next)
    await key(h, '\r')
    await settle(h)
    assert.equal(h.app.currentIconStyle(), next, `${start} -> ${next} really changed the surface`)
    assert.equal(fixture.document().iconStyle, next, 'and the document stores exactly that style')
    assert.deepEqual(fixture.calls.at(-1)!.ops, [{ op: 'set', path: ['iconStyle'], value: next }])
    assert.match(h.view(), /Status\s+Verified/u)
    h.dispose()
  }
})

// Regression: C2-R1 acceptance R1-04.
test('the runtime fact drives [current] even when the document disagrees', async () => {
  // The apply-first contract leaves the runtime live on a failed persistence, so
  // the document legitimately lags: the row must report the LIVE style.
  const h = setup({
    columns: 140,
    rows: 40,
    iconStyle: 'symbols',
    doc: { iconStyle: 'minimal' },
    applyReplace: () => { throw new Error('settings namespace "tui-app" changed since it was read') },
  })
  await h.open('Appearance')
  await key(h, '\r')
  await key(h, '\x1b[B') // Icon style
  const frame = h.view()
  assert.match(frame, /Value\s+symbols/u, 'the row value is the LIVE style, not the stored one')
  assert.match(frame, /Persisted\s+minimal/u, 'the stored fact stays separately readable')
  await key(h, '\r')
  const choice = h.view()
  assert.match(choice, /> symbols\s+\[current\]/u, 'the LIVE style owns the current chip')
  assert.doesNotMatch(choice, /> minimal\s+\[current\]/u, 'the stored value never claims to be live')
  // A refused write keeps the difference explicit on the same screen.
  await highlightCandidate(h, 'minimal')
  await key(h, '\r')
  await settle(h)
  assert.equal(h.app.currentIconStyle(), 'minimal', 'the runtime really switched (apply-first)')
  assert.match(h.view(), /Value\s+minimal/u, 'the LIVE style is the row value after the refusal')
  // The document already carries `minimal` when the rejection is classified, so
  // the outcome is NOT attributed to this commit: it is `Outcome unknown`, never
  // a false `Not saved` for a value the authority really holds.
  assert.match(h.view(), /Outcome unknown/u)
  assert.match(h.view(), /already reads minimal/u)
  assert.match(h.view(), /Retry save/u, 'the explicit retry stays reachable')
  h.dispose()
})

// Regression: C2-R1 acceptance R1-07.
test('every progress cadence persists and clears its own axis only', async () => {
  for (const target of ['off', 'frequent', 'milestones'] as const) {
    const fixture = createDirectSettingsFixture({ progressUpdates: target === 'off' ? 'milestones' : 'off', responseStyle: 'concise' })
    const h = setup({ columns: 140, rows: 40, tuiSettings: fixture.settings })
    await h.open('Conversation')
    await key(h, '\r')
    for (let step = 0; step < 3; step += 1) await key(h, '\x1b[B')
    await key(h, '\r')
    await highlightCandidate(h, target)
    await key(h, '\r')
    await settle(h)
    assert.equal(h.progressUpdatesState.mode, target, `the shared state carries ${target}`)
    assert.equal(fixture.document().progressUpdates, target)
    assert.equal(h.responseStyleState.style, 'default', 'the response axis is untouched in memory')
    assert.equal(fixture.document().responseStyle, 'concise', 'and untouched in the document')
    assert.match(h.view(), /Status\s+Verified/u)
    h.dispose()
  }
})

// Regression: C2-R1 acceptance R1-08.
test('every response style persists and clears its own axis only', async () => {
  for (const target of ['concise', 'explanatory', 'default'] as const) {
    const fixture = createDirectSettingsFixture({
      progressUpdates: 'frequent',
      responseStyle: target === 'concise' ? 'default' : 'concise',
    })
    const h = setup({ columns: 140, rows: 40, tuiSettings: fixture.settings })
    h.progressUpdatesState.mode = 'frequent'
    await h.open('Conversation')
    await key(h, '\r')
    for (let step = 0; step < 4; step += 1) await key(h, '\x1b[B')
    await key(h, '\r')
    await highlightCandidate(h, target)
    await key(h, '\r')
    await settle(h)
    assert.equal(h.responseStyleState.style, target, `the shared state carries ${target}`)
    assert.equal(fixture.document().responseStyle, target)
    assert.equal(h.progressUpdatesState.mode, 'frequent', 'the progress axis is untouched in memory')
    assert.equal(fixture.document().progressUpdates, 'frequent', 'and untouched in the document')
    assert.match(h.view(), /Status\s+Verified/u)
    h.dispose()
  }
})

// Regression: C2-R2 acceptance R2-01.
test('the lease return stays ONE stack: Esc ends the editor, never a second Settings', async () => {
  const h = setup({ columns: 120, rows: 40 })
  await h.open('Input & Terminal')
  await key(h, '\r')
  for (let step = 0; step < INPUT_TERMINAL_ROWS.length - 1; step += 1) await key(h, '\x1b[B')
  await key(h, '\r') // the remaining Keyboard shortcuts handoff
  assert.match(h.view(), /Type to search/u, 'the existing editor is the physical owner')
  assert.ok(!h.view().includes('Settings · '), 'the workspace lease was retired, never stacked')
  await key(h, '\x1b') // leave the editor
  await h.vt.waitForRender()
  const returned = h.view()
  assert.ok(!returned.includes('Type to search'), 'the editor is gone')
  assert.ok(!returned.includes('Settings · '), 'no Settings frame survives behind it either')
  assert.match(returned, /❯/u, 'the paused conversation is the restored surface (the pre-R1 contract)')
  // No double stack: a fresh /settings takes exactly ONE lease, and its own
  // level count still closes it.
  await h.open('Conversation')
  assert.match(h.view(), /Settings · /u, 'the workspace re-opens normally')
  for (let step = 0; step < 3; step += 1) await key(h, '\x1b')
  assert.ok(!h.view().includes('Settings · '), 'the re-opened workspace closes with the same level count')
  h.dispose()
})

// Regression: C2-R1 acceptance R1-16.
test('a held new-field commit never settles a closed or replacement workspace', async () => {
  const h = setup({ columns: 120, rows: 40, holdOwned: true })
  await h.open('Conversation')
  await key(h, '\r')
  for (let step = 0; step < 3; step += 1) await key(h, '\x1b[B')
  await key(h, '\r') // the choice
  await key(h, '\x1b[A') // milestones -> off
  await key(h, '\r') // Confirm: the write is held
  await settle(h)
  assert.match(h.view(), /Saving…/u, 'the pending phase is stated while the write is in flight')
  assert.equal(h.replacements(), 0, 'the held write has not run yet')

  // Close the workspace while the write is in flight, then release it.
  await key(h, '\x1b') // Detail -> Rows
  await key(h, '\x1b') // Rows -> Categories
  await key(h, '\x1b') // close
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('Settings · '), 'Esc at L0 closed the workspace')
  h.releaseOwned()
  await settle(h)
  assert.equal(h.replacements(), 1, 'the already-dispatched write still completes under its owner')
  assert.equal(h.doc.progressUpdates, 'off', 'and it really landed in the document')

  // A NEWLY opened workspace never inherits the previous instance's outcome.
  await h.open('Conversation')
  await key(h, '\r')
  for (let step = 0; step < 3; step += 1) await key(h, '\x1b[B')
  const reopened = h.view()
  assert.match(reopened, /Value\s+off/u, 'the re-open reads the committed value')
  assert.ok(!reopened.includes('Verified ·'), 'a new instance never inherits the previous settlement')
  assert.ok(!reopened.includes('Not saved'))
  h.dispose()
})

// Regression: C2-R1 acceptance R1-16.
test('a FAILED new-field save retries the same value through the same writer', async () => {
  let refuse = true
  const h = setup({
    columns: 140,
    rows: 40,
    doc: { progressUpdates: 'milestones' },
    applyReplace: (next) => {
      if (refuse) throw new Error('settings namespace "tui-app" changed since it was read')
      Object.assign(h.doc, next)
    },
  })
  await h.open('Conversation')
  await key(h, '\r')
  for (let step = 0; step < 3; step += 1) await key(h, '\x1b[B') // Progress updates
  await key(h, '\r')
  await highlightCandidate(h, 'frequent')
  await key(h, '\r')
  await settle(h)
  assert.equal(h.replacements(), 1, 'the first attempt really reached the document writer')
  assert.match(h.view(), /Not saved · the progress updates cadence is applied/u)
  assert.equal(h.progressUpdatesState.mode, 'frequent', 'the runtime fact stays applied')
  assert.match(h.view(), /Retry save/u, 'the failed row offers the explicit retry')

  // The write can succeed now: Retry must re-dispatch the SAME value through the
  // ONE commit channel and really verify it. `Retry save` is a PAINTED button,
  // so it is activated the way a user activates it.
  refuse = false
  const retryRow = rowOf(h, 'Retry save')
  press(h, retryRow, cellIndexOf(h, retryRow, 'Retry save'))
  release(h, retryRow, cellIndexOf(h, retryRow, 'Retry save'))
  await settle(h)
  assert.equal(h.replacements(), 2, 'the retry used the same writer exactly once')
  assert.equal(h.doc.progressUpdates, 'frequent', 'the retried value is the one the user chose')
  assert.equal(h.progressUpdatesState.mode, 'frequent', 'the live axis still carries it')
  assert.match(h.view(), /Status\s+Verified/u, 'the retry verifies its own authoritative re-read')
  assert.ok(!h.view().includes('Retry save'), 'a verified row offers no retry')
  h.dispose()
})

// Regression: C2-R1 acceptance R1-17.
test('a real Registry revision change keeps an open new-field choice and revokes only the frame', async () => {
  let requestRender: () => void = () => {}
  const registry = new SettingsRegistry(() => requestRender())
  const h = setup({ columns: 120, rows: 40, settingsRegistry: registry })
  requestRender = () => h.app.requestRender()
  await h.open('Conversation')
  await key(h, '\r')
  for (let step = 0; step < 4; step += 1) await key(h, '\x1b[B') // Response style
  await key(h, '\r') // the choice
  await key(h, '\x1b[B') // default -> concise
  assert.ok(h.view().includes('> concise'), `the candidate is highlighted:\n${h.view()}`)

  // A plugin registers an UNRELATED settings row: the directory revision moves.
  // The invalidation only SCHEDULES a frame; the registry callback runs inside
  // the registration, so the next key arrives against the spent frame.
  const handle = registry.register({
    id: 'acme.demo-threshold',
    label: 'Demo threshold',
    description: 'The demo plugin threshold',
    currentValue: '3',
    values: ['1', '3', '5'],
    order: 10,
    onChange: () => true,
  }, 'acme-owner')
  // A Confirm from the REVOKED frame: it must dispatch nothing, because the
  // frame that published the grant was composed against the previous directory.
  h.vt.sendInput('\r')
  assert.equal(h.replacements(), 0, 'an old-frame Confirm never dispatches after the directory moved')
  assert.equal(h.doc.responseStyle, undefined, 'and the document is untouched')
  await h.vt.waitForRender()
  assert.match(h.view(), /Categories \(10\)/u, 'the live directory really changed')
  const afterRegister = h.view()
  assert.match(afterRegister, /Choose value/u, 'the open Response style choice survives')
  assert.match(afterRegister, /> concise/u, 'on the SAME candidate identity')
  assert.equal(h.replacements(), 0, 'the registry change wrote nothing')
  // The preserved choice still confirms through the ONE writer.
  await key(h, '\r')
  await settle(h)
  assert.equal(h.replacements(), 1, 'the preserved choice dispatches exactly one write')
  assert.equal(h.doc.responseStyle, 'concise')
  handle.dispose()
  h.dispose()
})

// Regression: C2-R1 acceptance R1-13.
test('a held Settings commit and a queued LEGACY write share the ONE production writer', async () => {
  // The production system admits ONE Settings workspace lease and ONE pending
  // write per workspace, so two overlapping Settings commits are not reachable.
  // What IS reachable is a Settings commit overlapping another settings-document
  // writer — and every such writer goes through the SAME
  // `serializeTuiSettingsMutation` + `withUserFooterCustomItems` pair. This case
  // holds the DELIVERED Settings commit inside its queued task and submits the
  // pre-existing complete editor's own `Submit while busy` write behind it.
  const userItems = [{ schemaVersion: 1, id: 'user:clock', kind: 'text', text: 'hi' }]
  const trust = { schemaVersion: 1, command: 'echo hi', timeoutMs: 300 }
  const keybindings = { schemaVersion: 1, bindings: { ctrlx: 'app.exit' } }
  const h = setup({
    columns: 140,
    rows: 40,
    doc: { theme: 'dark', iconStyle: 'emoji', busyEnter: 'queue' },
    footerCustomItemsRaw: userItems,
    holdFirstReplace: true,
  })
  Object.assign(h.doc, { footerCommand: trust, keybindings })

  // 1. The Settings workspace commits Icon style emoji -> symbols; its document
  //    write is held INSIDE the queue.
  await h.open('Appearance')
  await key(h, '\r')
  await key(h, '\x1b[B') // Icon style
  await key(h, '\r')
  await h.vt.waitForRender()
  await key(h, '\x1b[B') // emoji -> symbols
  await key(h, '\r')
  await h.firstWriteStarted()
  assert.equal(h.replacements(), 1, 'the Settings write started and is held inside the queue')

  // 2. While it is held, the real handoff opens the existing complete editor on
  //    the remaining Keyboard shortcuts row, and THAT editor's own write is
  //    queued behind it.
  await key(h, '\x1b') // Detail -> Rows
  await key(h, '\x1b') // Rows -> Categories
  await h.vt.waitForRender()
  // Walk the rail DOWN from the current category (Appearance) to Input &
  // Terminal; the rail is the only selection owner.
  for (let step = 0; step < CATEGORY_ORDER.length; step += 1) {
    if (h.rowsPlain().some(line => line.startsWith('> Input & Terminal'))) break
    await key(h, '\x1b[B')
  }
  assert.ok(h.rowsPlain().some(line => line.startsWith('> Input & Terminal')),
    `the rail reached Input & Terminal:\n${h.view()}`)
  await key(h, '\r') // L0 -> L1
  for (let step = 0; step < INPUT_TERMINAL_ROWS.length - 1; step += 1) await key(h, '\x1b[B')
  await key(h, '\r') // the handoff
  await h.vt.waitForRender()
  assert.match(h.view(), /Type to search/u, `the legacy editor owns the screen:\n${h.view()}`)
  assert.match(h.view(), />\s*Keyboard shortcuts/u, 'it landed on the remaining row')
  // The legacy complete editor still owns its own `Submit while busy` writer:
  // filter to that row and activate it (a cycle row) — its document write is
  // queued behind the held Settings write.
  for (const data of 'Submit while busy') await key(h, data)
  await settle(h, 8)
  assert.ok(h.view().includes('> Submit while busy'), `the filtered row is selected:\n${h.view()}`)
  await key(h, '\r') // cycle the row: the legacy writer runs
  await settle(h, 8)
  assert.ok(h.replacements() >= 1, 'the legacy write is QUEUED behind the held Settings write')

  // 3. Release the first write: both land, and the queued one carries the FIRST
  //    write's result plus the production USER-layer footer projection.
  h.releaseFirstReplace()
  await settle(h, 12)
  assert.equal(h.replacements(), 2, 'both delivered writes reached the document writer')
  const document = h.doc as unknown as Record<string, unknown>
  assert.equal(document.iconStyle, 'symbols', 'the Settings field landed')
  assert.equal(document.busyEnter, 'steer', 'the queued legacy field landed too')
  assert.equal(document.theme, 'dark', 'no unrelated field was rewritten')
  assert.deepEqual(document.footerCustomItems, userItems,
    'the production writer projected the detached USER footer definitions')
  assert.deepEqual(document.footerCommand, trust, 'the trusted footer command survived verbatim')
  assert.deepEqual(document.keybindings, keybindings, 'the keybinding pass-through survived verbatim')
  const queued = h.replaced()[1]!
  assert.equal(queued.iconStyle, 'symbols',
    'the QUEUED write read the document AFTER the first write — never the open-time snapshot')
  assert.equal(queued.busyEnter, 'steer')
  h.dispose()
})

test('a PENDING apply-first commit already shows the RUNTIME value it applied', async () => {
  // The apply-first writers mutate their live owner SYNCHRONOUSLY; only the
  // document write is slow. While that write is held, the row must already show
  // the runtime value that really took effect and the OLD stored value — never
  // the stale pre-commit pair. (The two runtime-only disclosure rows have no
  // document write at all, so they never enter this pending phase.)
  const cases = [
    {
      label: 'Icon style',
      category: 'Appearance',
      steps: 1,
      applied: 'symbols',
      doc: { iconStyle: 'emoji' } as Partial<TuiSettingsDoc>,
      runtimeFact: /Value\s+symbols/u,
      persistedFact: /Persisted\s+emoji/u,
    },
    {
      label: 'Progress updates',
      category: 'Conversation',
      steps: 3,
      applied: 'off',
      doc: { progressUpdates: 'milestones' } as Partial<TuiSettingsDoc>,
      runtimeFact: /Value\s+off/u,
      persistedFact: /Persisted\s+milestones/u,
    },
    {
      label: 'Response style',
      category: 'Conversation',
      steps: 4,
      applied: 'concise',
      doc: { responseStyle: 'default' } as Partial<TuiSettingsDoc>,
      runtimeFact: /Value\s+concise/u,
      persistedFact: /Persisted\s+default/u,
    },
  ] as const

  for (const entry of cases) {
    const h = setup({ columns: 140, rows: 40, doc: entry.doc, holdFirstReplace: true })
    await h.open(entry.category)
    await key(h, '\r')
    for (let step = 0; step < entry.steps; step += 1) await key(h, '\x1b[B')
    await key(h, '\r') // Detail -> the choice
    await h.vt.waitForRender()
    await highlightCandidate(h, entry.applied)
    await key(h, '\r') // Confirm: the document write is held
    await h.firstWriteStarted()
    const pending = h.view()
    assert.match(pending, /Saving…/u, `${entry.label} states the pending phase:\n${pending}`)
    // For an apply-first row `primary` is `runtime`, so this field's RUNTIME fact
    // is painted as `Value` and the OTHER fact carries its explicit label
    // (`Persisted`) — the Detail never re-labels one as the other.
    assert.match(pending, entry.runtimeFact,
      `${entry.label} already shows the runtime value it applied, not the stale snapshot:\n${pending}`)
    assert.match(pending, entry.persistedFact,
      `${entry.label} still reports the stored value separately while pending:\n${pending}`)
    assert.doesNotMatch(pending, /Value\s+(?:emoji|milestones|default)\b/u,
      `${entry.label} never keeps the pre-commit runtime value as the primary fact:\n${pending}`)
    assert.doesNotMatch(pending, /Status\s+Verified/u, `${entry.label} is not Verified before settlement`)
    h.releaseFirstReplace()
    await settle(h, 10)
    h.dispose()
  }
})

// ── C2-R2: the eight migrated Conversation / Input & Terminal writers ───────
//
// Every case below drives the REAL composition (the registered `/settings`
// command, the workspace panel, the ONE `commitSettingsWorkspaceField` writer
// and the serialized document queue) and reads the real SINK: the app's live
// screen/terminal-progress state, the shared `gitAttributionState` object, the
// ONE completion controller's own mode/method, the keymap the Home/End preset
// writes and the document the write produced.

/** Walk an open-or-not workspace to one row and open its L2 choice (both the
 *  Detail-level facts and the choice are observed by the caller). */
async function chooseRow(
  h: Harness,
  category: string,
  rows: readonly string[],
  label: string,
): Promise<void> {
  await selectWorkspaceRow(h, category, rows, label)
  await key(h, '\r') // L1 -> L2 choice
}

/** Walk an open-or-not workspace to one row's settled DETAIL level. */
async function selectWorkspaceRow(
  h: Harness,
  category: string,
  rows: readonly string[],
  label: string,
): Promise<void> {
  await h.open(category)
  await key(h, '\r') // L0 -> L1
  const target = rows.indexOf(label)
  assert.ok(target >= 0, `the harness must know ${JSON.stringify(label)}`)
  for (let step = 0; step < target; step += 1) await key(h, '\x1b[B')
  assert.ok(h.view().includes(`> ${label}`), `the ${label} row owns the selection:\n${h.view()}`)
}

/** The DETAILS column of the painted frame as ONE whitespace-collapsed
 *  sentence: a long user-facing sentence wraps at the pane width, so a prose
 *  assertion must read the column the sentence is painted in — never the whole
 *  frame, whose other columns would be interleaved between the wrapped lines. */
const detailsPaneText = (h: Harness): string => {
  const lines = h.rowsPlain()
  // The pane header names Details whether or not IT owns the focus
  // (`[Details]` while focused, a plain `Details` while the Rows pane is).
  const header = lines.findIndex(line => /(?:\[)?Details(?:\])?/u.test(line))
  assert.ok(header >= 0, `the Details pane header must be painted:\n${h.view()}`)
  const marker = lines[header]!.search(/(?:\[)?Details(?:\])?/u)
  const paneStart = Math.max(0, marker - 2)
  return lines.slice(header + 1)
    .map(line => line.slice(paneStart))
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

// Regression: C2-R2 acceptance R2-03 / R2-04.
test('Submit while busy confirms into the TUI document and the NEXT busy Enter reads it', async () => {
  const fixture = createDirectSettingsFixture({ theme: 'dark', busyEnter: 'queue' })
  const h = setup({ columns: 140, rows: 40, tuiSettings: fixture.settings })
  await chooseRow(h, 'Conversation', CONVERSATION_ROWS, 'Submit while busy')
  assert.match(h.view(), /> queue\s+\[current\]/u, 'the stored value owns the current chip')
  assert.match(h.view(), /Runtime\s+Next busy Enter: queue/u,
    'the Runtime fact names the policy the next submit really applies')
  await highlightCandidate(h, 'steer')
  await key(h, '\r')
  await settle(h)

  assert.equal(fixture.document().busyEnter, 'steer', 'the document stores the new policy')
  assert.deepEqual(fixture.calls.at(-1)!.ops, [{ op: 'set', path: ['busyEnter'], value: 'steer' }],
    'exactly one path-scoped write of its own field')
  assert.match(h.view(), /Status\s+Verified/u, 'the authoritative re-read verified the write')
  // The consumer reads the SAME document field: this is the production rule the
  // next busy Enter applies (no second policy object exists).
  assert.equal(resolveComposerDelivery(true, 'enter', fixture.document().busyEnter), 'steer',
    'the next busy Enter routes the draft into the running turn')
  assert.equal(resolveComposerDelivery(false, 'enter', fixture.document().busyEnter), 'queue',
    'a NON-busy submit is unaffected')
  h.dispose()
})

// Regression: C2-R2 acceptance R2-04.
test('Submit while busy never presents a missing or invalid stored value as the saved one', async () => {
  for (const stored of [undefined, 'garbage'] as const) {
    const values: TuiSettingsDoc = { ...DEFAULT_DOC, theme: 'dark' }
    if (stored === undefined) delete (values as { busyEnter?: string }).busyEnter
    else (values as { busyEnter?: string }).busyEnter = stored
    const h = setup({
      columns: 140,
      rows: 40,
      tuiSettings: { get: () => values, replace: (next: TuiSettingsDoc) => { Object.assign(values, next) } },
    })
    await chooseRow(h, 'Conversation', CONVERSATION_ROWS, 'Submit while busy')
    const frame = h.view()
    if (stored === undefined) {
      assert.match(frame, /Value\s+not set/u, 'a readable document with no value says `not set`')
      assert.match(frame, /Next busy Enter: queue \(default; no valid saved value\)/u,
        'the consumer default is NAMED as a default')
    } else {
      assert.match(frame, /Value\s+invalid stored value: garbage/u,
        'an invalid stored value is reported verbatim, never replaced by the default')
      assert.match(frame, /Next busy Enter: queue \(default; no valid saved value\)/u)
    }
    assert.ok(!/> (?:queue|steer)\s+\[current\]/u.test(frame),
      `no candidate may claim [current] without an exact stored match (${JSON.stringify(stored)}):\n${frame}`)
    assert.equal(h.replacements(), 0, 'reading the row writes nothing')
    h.dispose()
  }
})

// Regression: C2-R2 acceptance R2-05.
test('Git attribution confirms into the SAME prompt-state object the registered section reads', async () => {
  const fixture = createDirectSettingsFixture({ theme: 'dark', gitAttribution: 'off' })
  const h = setup({ columns: 140, rows: 40, tuiSettings: fixture.settings })
  await chooseRow(h, 'Conversation', CONVERSATION_ROWS, 'Git attribution')
  assert.match(h.view(), /> off\s+\[current\]/u)
  await highlightCandidate(h, 'product-model')
  await key(h, '\r')
  await settle(h)

  assert.equal(h.gitAttributionState.mode, 'product-model',
    'the ONE state the tui:git-attribution SystemPrompt section reads changed')
  assert.equal(fixture.document().gitAttribution, 'product-model', 'and the document stores it')
  assert.deepEqual(fixture.calls.at(-1)!.ops, [{ op: 'set', path: ['gitAttribution'], value: 'product-model' }])
  assert.match(h.view(), /Status\s+Verified/u)
  // The REGISTERED section reads that SAME object: prove the registered
  // provider's text really changed (source -> decision -> prompt sink), with
  // provider/model staying the official DSH variables, never a TUI copy.
  //
  // ORDER IS LOAD-BEARING: registering AFTER the confirm would pass even for a
  // provider that snapshotted the text at registration time. The section is
  // therefore registered on the OFF text above… — see the sibling case
  // `the already-registered git attribution section follows a later confirm`,
  // which registers BEFORE the change and reads the text back after it.
  type Section = Parameters<SystemPromptLike['section']>[0]
  const lateRegistered = new Map<string, Section>()
  installGitAttributionPrompt({
    section: (section) => { lateRegistered.set(section.name, section); return () => { lateRegistered.delete(section.name) } },
  }, h.gitAttributionState)
  const lateText = (): string => {
    const text = lateRegistered.get('tui:git-attribution')!.text
    return typeof text === 'function' ? (text as () => string)() : String(text)
  }
  assert.match(lateText(), /Co-Authored-By: @xmoon76\/dsh-pi-tui/u)
  assert.match(lateText(), /Assisted-By: \{\{provider\}\}\/\{\{model\}\}/u)
  h.dispose()
})

// Regression: C2-R2 acceptance R2-05 (dynamic follow-up of a REGISTERED section).
test('the already-registered git attribution section follows a later confirm', async () => {
  // The registered provider is installed FIRST, while the mode is still `off`,
  // and it is never re-registered. Reading it after the workspace confirm is
  // what proves the section is DYNAMIC: a provider that snapshotted its text at
  // registration time would keep returning the empty off-text here.
  type Section = Parameters<SystemPromptLike['section']>[0]
  const registered = new Map<string, Section>()
  const state: { mode: 'off' | 'product' | 'product-model' } = { mode: 'off' }
  installGitAttributionPrompt({
    section: (section) => { registered.set(section.name, section); return () => { registered.delete(section.name) } },
  }, state as never)
  const text = (): string => {
    const value = registered.get('tui:git-attribution')!.text
    return typeof value === 'function' ? (value as () => string)() : String(value)
  }
  // Reverse control: the pre-change registration really renders the OFF text.
  assert.equal(text(), '', 'the off mode renders no section text at all')

  const fixture = createDirectSettingsFixture({ theme: 'dark', gitAttribution: 'off' })
  const h = setup({ columns: 140, rows: 40, tuiSettings: fixture.settings, gitAttributionState: state })
  await chooseRow(h, 'Conversation', CONVERSATION_ROWS, 'Git attribution')
  await highlightCandidate(h, 'product')
  await key(h, '\r')
  await settle(h)

  // The SAME registration now renders the product trailer — no re-registration.
  assert.match(text(), /Co-Authored-By: @xmoon76\/dsh-pi-tui/u,
    'the already-registered section follows the change dynamically')
  assert.doesNotMatch(text(), /Assisted-By/u, 'the product mode adds no Assisted-By trailer')
  h.dispose()
})

// Regression: C2-R2 acceptance R2-06.
test('Home/End keys confirms into the ONE keymap preset and leaves every other binding alone', async () => {
  const fixture = createDirectSettingsFixture({ theme: 'dark', homeEndKeys: 'input' })
  const h = setup({ columns: 140, rows: 40, tuiSettings: fixture.settings })
  // The real boot applies the persisted preset BEFORE the workspace opens
  // (`applyBootDisplay`), so the live keymap fact is the one the user runs.
  getKeybindings().setUserBindings({ 'tui.altScreen.search': 'ctrl+f' })
  h.app.setHomeEndMode(fixture.document().homeEndKeys)
  await chooseRow(h, 'Input & Terminal', INPUT_TERMINAL_ROWS, 'Home/End keys')
  assert.match(h.view(), /> input\s+\[current\]/u, 'the live keymap fact owns the chip')
  await highlightCandidate(h, 'viewport')
  await key(h, '\r')
  await settle(h)

  const user = getKeybindings().getUserBindings()
  assert.equal(user['tui.altScreen.top'], 'home', 'the fullscreen viewport now owns Home')
  assert.equal(user['tui.altScreen.bottom'], 'end', 'and End')
  assert.equal(user['tui.altScreen.search'], 'ctrl+f', 'no other user binding was rewritten')
  assert.match(h.view(), /Value\s+viewport/u, `the settled Value is the applied preset:\n${h.view()}`)
  // Re-open the choice: the LIVE fact (not the document) owns the chip.
  await key(h, '\r')
  assert.match(h.view(), /> viewport\s+\[current\]/u, `the live fact follows the applied preset:\n${h.view()}`)
  assert.equal(fixture.document().homeEndKeys, 'viewport')
  assert.deepEqual(fixture.calls.at(-1)!.ops, [{ op: 'set', path: ['homeEndKeys'], value: 'viewport' }])
  h.dispose()
})

// Regression: C2-R2 acceptance R2-07 / R2-08.
test('Fullscreen stores the preference while the workspace still owns the screen, and applies it on the normal exit', async () => {
  const h = setup({ columns: 140, rows: 40, doc: { theme: 'dark', fullscreen: 'off' } })
  h.setOnFullscreenChange(() => {})
  await selectWorkspaceRow(h, 'Input & Terminal', INPUT_TERMINAL_ROWS, 'Fullscreen')
  assert.match(detailsPaneText(h), /Current transcript mode: off \(Settings lease is separate\); applied after normal Settings close/u,
    `the Runtime fact names the paused transcript mode and the post-close apply:\n${h.view()}`)
  await key(h, '\r') // the choice
  await highlightCandidate(h, 'on')
  await key(h, '\r')
  await settle(h)

  assert.equal(h.doc.fullscreen, 'on', 'the preference is stored')
  assert.equal(h.replacements(), 1, 'exactly ONE document write')
  assert.match(h.view(), /Status\s+Verified/u)
  assert.equal(h.app.isFullscreen(), false, 'the physical screen did NOT switch while the workspace is open')
  assert.equal(h.fullscreenChanges(), 0, 'no screen-change callback fired during the commit')

  // Leaving the workspace normally is what applies the verified preference.
  await key(h, '\x1b') // choice -> detail
  await key(h, '\x1b')
  await key(h, '\x1b')
  await h.vt.waitForRender()
  assert.equal(h.app.isFullscreen(), true, 'the transcript screen switched after the normal exit')
  assert.equal(h.replacements(), 1, 'the post-close switch wrote NO second document copy')
  assert.equal(h.fullscreenChanges(), 0, 'the hand-off keeps `persistPreference: false`: no second notify/write')
  h.dispose()
})

// Regression: C2-R2 acceptance R2-08.
test('Fullscreen never switches the screen when the workspace closes for another reason', async () => {
  // A Legacy hand-off closes the workspace through the compatibility bridge: the
  // verified preference must NOT swap the screen behind the mounting editor.
  const h = setup({ columns: 140, rows: 40, doc: { theme: 'dark', fullscreen: 'off' } })
  await chooseRow(h, 'Input & Terminal', INPUT_TERMINAL_ROWS, 'Fullscreen')
  await highlightCandidate(h, 'on')
  await key(h, '\r')
  await settle(h)
  assert.equal(h.doc.fullscreen, 'on')
  // Navigate to the remaining handoff row and activate it: `legacy-handoff`.
  await key(h, '\x1b') // back to the rows level
  for (let step = 0; step < INPUT_TERMINAL_ROWS.length - 1; step += 1) await key(h, '\x1b[B')
  assert.ok(h.view().includes('> Input & terminal settings…'))
  await key(h, '\r')
  await h.vt.waitForRender()
  assert.match(h.view(), /Type to search/u, 'the existing editor owns the screen')
  assert.equal(h.app.isFullscreen(), false, 'a legacy hand-off never swaps the screen')
  h.dispose()
})

// Regression: C2-R2 acceptance R2-09.
test('Mouse wheel lines confirms the NEXT-mount step and never claims the mounted viewport changed', async () => {
  const fixture = createDirectSettingsFixture({ theme: 'dark', wheelScrollLines: '1' })
  const h = setup({ columns: 140, rows: 40, tuiSettings: fixture.settings })
  await selectWorkspaceRow(h, 'Input & Terminal', INPUT_TERMINAL_ROWS, 'Mouse wheel lines')
  assert.match(detailsPaneText(h), /Number of transcript lines moved per mouse-wheel event in fullscreen\. Applies on the next fullscreen entry; the existing fullscreen viewport keeps its constructor-time step\./u,
    `the row states the next-entry semantics verbatim:\n${h.view()}`)
  await key(h, '\r') // the choice
  await highlightCandidate(h, '5')
  await key(h, '\r')
  await settle(h)

  assert.equal(h.app.currentWheelScrollLines(), 5, 'the NEXT mount option changed')
  assert.equal(fixture.document().wheelScrollLines, '5')
  assert.deepEqual(fixture.calls.at(-1)!.ops, [{ op: 'set', path: ['wheelScrollLines'], value: '5' }])
  assert.match(h.view(), /Status\s+Verified/u)
  h.dispose()
})

// Regression: C2-R2 acceptance R2-10 / R2-11.
test('Notifications and Notification method confirm into the ONE completion controller', async () => {
  const fixture = createDirectSettingsFixture({ theme: 'dark', notificationMode: 'unfocused', notificationMethod: 'auto' })
  const h = setup({ columns: 140, rows: 40, tuiSettings: fixture.settings })
  await chooseRow(h, 'Input & Terminal', INPUT_TERMINAL_ROWS, 'Notifications')
  assert.match(h.view(), /> unfocused\s+\[current\]/u)
  await highlightCandidate(h, 'always')
  await key(h, '\r')
  await settle(h)
  assert.ok(h.notificationWrites().includes('mode:always'), 'the ONE controller received the mode')
  assert.equal(fixture.document().notificationMode, 'always')

  // Back to the SAME rows level, then the next row (Notification method).
  await key(h, '\x1b') // Detail -> Rows
  await key(h, '\x1b[B')
  assert.ok(h.view().includes('> Notification method'), `the next row owns the selection:\n${h.view()}`)
  await key(h, '\r')
  await highlightCandidate(h, 'osc9')
  await key(h, '\r')
  await settle(h)
  assert.ok(h.notificationWrites().includes('method:osc9'), 'the SAME controller received the method')
  assert.equal(fixture.document().notificationMethod, 'osc9')
  assert.equal(fixture.document().notificationMode, 'always', 'the mode is untouched by the method write')
  h.dispose()
})

// Regression: C2-R2 acceptance R2-12.
test('Terminal progress confirms into the mounted surface and its document field, leaving Progress updates alone', async () => {
  const fixture = createDirectSettingsFixture({ theme: 'dark', terminalProgress: '9;4+7501', progressUpdates: 'milestones' })
  const h = setup({ columns: 140, rows: 40, tuiSettings: fixture.settings })
  h.progressUpdatesState.mode = 'milestones'
  await chooseRow(h, 'Input & Terminal', INPUT_TERMINAL_ROWS, 'Terminal progress')
  assert.match(h.view(), /> 9;4\+7501\s+\[current\]/u)
  await highlightCandidate(h, 'off')
  await key(h, '\r')
  await settle(h)

  assert.deepEqual(h.terminalProgressWrites(), ['off'], 'the mounted surface received the selection once')
  assert.equal(h.app.currentTerminalProgressMode(), 'off', 'the app really applies it')
  assert.equal(fixture.document().terminalProgress, 'off')
  assert.equal(h.progressUpdatesState.mode, 'milestones', 'the Agent narration cadence is untouched')
  assert.equal(fixture.document().progressUpdates, 'milestones', 'and so is its document field')
  assert.match(h.view(), /Status\s+Verified/u)
  h.dispose()
})

// Regression: C2-R2 acceptance R2-02 / R2-13 (the persist-first gate and the
// field isolation of every writer).
test('a persist-first confirm refuses to write when the document cannot be read', async () => {
  const h = setup({ columns: 140, rows: 40, doc: { theme: 'dark', busyEnter: 'queue' }, throwOnGet: true })
  await chooseRow(h, 'Conversation', CONVERSATION_ROWS, 'Submit while busy')
  await highlightCandidate(h, 'steer')
  await key(h, '\r')
  await settle(h)
  assert.equal(h.replacements(), 0, 'an unreadable document receives NO write')
  assert.match(h.view(), /Not saved · the busy Enter policy was not stored/u,
    `the refusal names the field and the unreadable document:\n${h.view()}`)
  assert.match(h.view(), /could not be read/u)
  assert.doesNotMatch(h.view(), /Status\s+Verified/u)
  h.dispose()
})

// Regression: C2-R2 acceptance R2-13.
test('every migrated writer changes exactly its own document field', async () => {
  const cases = [
    { category: 'Conversation', rows: CONVERSATION_ROWS, label: 'Submit while busy', applied: 'steer', path: 'busyEnter', doc: { busyEnter: 'queue' } },
    { category: 'Conversation', rows: CONVERSATION_ROWS, label: 'Git attribution', applied: 'product', path: 'gitAttribution', doc: { gitAttribution: 'off' } },
    { category: 'Input & Terminal', rows: INPUT_TERMINAL_ROWS, label: 'Home/End keys', applied: 'viewport', path: 'homeEndKeys', doc: { homeEndKeys: 'input' } },
    { category: 'Input & Terminal', rows: INPUT_TERMINAL_ROWS, label: 'Fullscreen', applied: 'on', path: 'fullscreen', doc: { fullscreen: 'off' } },
    { category: 'Input & Terminal', rows: INPUT_TERMINAL_ROWS, label: 'Mouse wheel lines', applied: '3', path: 'wheelScrollLines', doc: { wheelScrollLines: '1' } },
    { category: 'Input & Terminal', rows: INPUT_TERMINAL_ROWS, label: 'Notifications', applied: 'always', path: 'notificationMode', doc: { notificationMode: 'unfocused' } },
    { category: 'Input & Terminal', rows: INPUT_TERMINAL_ROWS, label: 'Notification method', applied: 'bell', path: 'notificationMethod', doc: { notificationMethod: 'auto' } },
    { category: 'Input & Terminal', rows: INPUT_TERMINAL_ROWS, label: 'Terminal progress', applied: '7501', path: 'terminalProgress', doc: { terminalProgress: '9;4+7501' } },
  ] as const

  for (const entry of cases) {
    const fixture = createDirectSettingsFixture({
      theme: 'dark',
      footerCommand: { schemaVersion: 1, command: 'echo hi', timeoutMs: 300 },
      keybindings: { schemaVersion: 1, bindings: { ctrlx: 'app.exit' } },
      ...entry.doc,
    })
    const h = setup({ columns: 140, rows: 40, tuiSettings: fixture.settings })
    await chooseRow(h, entry.category, entry.rows, entry.label)
    await highlightCandidate(h, entry.applied)
    await key(h, '\r')
    await settle(h)
    assert.deepEqual(fixture.calls.at(-1)!.ops, [{ op: 'set', path: [entry.path], value: entry.applied }],
      `${entry.label} writes ONLY its own document path`)
    assert.equal(fixture.calls.length, 1, `${entry.label} dispatched exactly one path-scoped write`)
    const document = fixture.document() as unknown as Record<string, unknown>
    assert.deepEqual(document.footerCommand, { schemaVersion: 1, command: 'echo hi', timeoutMs: 300 },
      `${entry.label} preserves the trusted footer command verbatim`)
    assert.deepEqual(document.keybindings, { schemaVersion: 1, bindings: { ctrlx: 'app.exit' } },
      `${entry.label} preserves the keybinding pass-through verbatim`)
    assert.equal(document.theme, 'dark', `${entry.label} rewrote no unrelated field`)
    h.dispose()
  }
})

// ── C2-R2 acceptance R2-08: the Fullscreen NEGATIVE matrix ───────────────────
//
// The positive path (one write, Verified, switch on normal exit) is proven
// above. Every case here drives the REAL `onClose(reason)` wiring and asserts
// the one thing that must not happen: a physical screen switch. The stored
// preference is always allowed to land — that is the next-mount path.

/** The pieces a negative case needs: the harness plus a switch probe. */
function fullscreenProbe(): {
  readonly switches: boolean[]
  readonly setup: (h: Harness) => void
} {
  const switches: boolean[] = []
  return {
    switches,
    setup: (h) => { h.setOnFullscreenChange(fullscreen => switches.push(fullscreen)) },
  }
}

// Regression: C2-R2 acceptance R2-08.
test('a Fullscreen choice whose write is still PENDING when the user leaves switches nothing', async () => {
  const probe = fullscreenProbe()
  // The document write is held: the commit never settles before the close.
  const h = setup({ columns: 140, rows: 40, doc: { theme: 'dark', fullscreen: 'off' }, holdFirstReplace: true })
  probe.setup(h)
  await chooseRow(h, 'Input & Terminal', INPUT_TERMINAL_ROWS, 'Fullscreen')
  await highlightCandidate(h, 'on')
  await key(h, '\r') // Confirm: the document write is held open
  await h.firstWriteStarted()
  assert.equal(h.replacements(), 1, 'the write really started and is held')
  assert.match(h.view(), /Saving…/u)

  // Leave the workspace while the write is unsettled.
  await key(h, '\x1b') // choice -> detail
  await key(h, '\x1b')
  await key(h, '\x1b')
  await h.vt.waitForRender()
  h.releaseFirstReplace()
  await settle(h, 12)

  assert.deepEqual(probe.switches, [], 'an unsettled choice never switches the screen')
  assert.equal(h.app.isFullscreen(), false, 'the transcript screen is unchanged')
  assert.equal(h.doc.fullscreen, 'on', 'the preference still lands once the write completes')
  h.dispose()
})

// Regression: C2-R2 acceptance R2-08.
test('a Fullscreen choice refused with Not saved keeps the screen and leaves the preference alone', async () => {
  const probe = fullscreenProbe()
  const h = setup({
    columns: 140,
    rows: 40,
    doc: { theme: 'dark', fullscreen: 'off' },
    // The write "succeeds" but the authority keeps reading the old value.
    applyReplace: () => {},
  })
  probe.setup(h)
  await chooseRow(h, 'Input & Terminal', INPUT_TERMINAL_ROWS, 'Fullscreen')
  await highlightCandidate(h, 'on')
  await key(h, '\r')
  await settle(h)
  assert.match(h.view(), /Status\s+Not saved/u, 'the authoritative disagreement is a refusal')
  await key(h, '\x1b')
  await key(h, '\x1b')
  await key(h, '\x1b')
  await h.vt.waitForRender()
  assert.deepEqual(probe.switches, [], 'a Not saved preference is never applied')
  assert.equal(h.app.isFullscreen(), false)
  h.dispose()
})

// Regression: C2-R2 acceptance R2-08.
test('a Fullscreen choice that completed without a readable readback switches nothing', async () => {
  const probe = fullscreenProbe()
  const h = setup({ columns: 140, rows: 40, doc: { theme: 'dark', fullscreen: 'off' }, getFailureAfterWrite: true })
  probe.setup(h)
  await chooseRow(h, 'Input & Terminal', INPUT_TERMINAL_ROWS, 'Fullscreen')
  await highlightCandidate(h, 'on')
  await key(h, '\r')
  await settle(h)
  assert.match(h.view(), /Commit accepted/u, 'a write with no readback is accepted-but-unverified')
  assert.match(h.view(), /verification unavailable/u)
  await key(h, '\x1b')
  await key(h, '\x1b')
  await key(h, '\x1b')
  await h.vt.waitForRender()
  assert.deepEqual(probe.switches, [], 'an UNVERIFIED preference is never applied')
  assert.equal(h.app.isFullscreen(), false)
  h.dispose()
})

// Regression: C2-R2 acceptance R2-08.
test('a Fullscreen choice whose rejection cannot be attributed switches nothing', async () => {
  const probe = fullscreenProbe()
  const h = setup({
    columns: 140,
    rows: 40,
    doc: { theme: 'dark', fullscreen: 'off' },
    applyReplace: (next) => {
      // The value lands, then the write reports failure: the outcome cannot be
      // attributed to this request, so it is neither accepted nor refused.
      Object.assign(h.doc, next)
      throw new Error('post-write describe failed')
    },
  })
  probe.setup(h)
  await chooseRow(h, 'Input & Terminal', INPUT_TERMINAL_ROWS, 'Fullscreen')
  await highlightCandidate(h, 'on')
  await key(h, '\r')
  await settle(h)
  assert.match(h.view(), /Outcome unknown/u, 'an unattributable write is Outcome unknown')
  await key(h, '\x1b')
  await key(h, '\x1b')
  await key(h, '\x1b')
  await h.vt.waitForRender()
  assert.deepEqual(probe.switches, [], 'an Outcome unknown is never applied')
  assert.equal(h.app.isFullscreen(), false)
  h.dispose()
})

// Regression: C2-R2 acceptance R2-08.
test('a verified Fullscreen choice does not switch when a Question takes the surface over', async () => {
  const probe = fullscreenProbe()
  const h = setup({ columns: 140, rows: 40, doc: { theme: 'dark', fullscreen: 'off' } })
  probe.setup(h)
  await chooseRow(h, 'Input & Terminal', INPUT_TERMINAL_ROWS, 'Fullscreen')
  await highlightCandidate(h, 'on')
  await key(h, '\r')
  await settle(h)
  assert.match(h.view(), /Status\s+Verified/u)
  // A blocking Question ARRIVES while the workspace is leased: it preempts the
  // workspace through the FORCED close path (never the user's own exit).
  const questions = h.app.askQuestions([{ id: 'q1', question: 'proceed?', options: [{ label: 'yes' }] }])
  await h.vt.waitForRender()
  questions.catch(() => {})
  assert.deepEqual(probe.switches, [], 'a Question takeover never applies the pending preference')
  assert.equal(h.app.isFullscreen(), false, 'the question owns the surface untouched')
  h.dispose()
})

// Regression: C2-R2 acceptance R2-08.
test('a verified Fullscreen choice does not switch when another writer changed the stored value', async () => {
  const probe = fullscreenProbe()
  const h = setup({ columns: 140, rows: 40, doc: { theme: 'dark', fullscreen: 'off' } })
  probe.setup(h)
  await chooseRow(h, 'Input & Terminal', INPUT_TERMINAL_ROWS, 'Fullscreen')
  await highlightCandidate(h, 'on')
  await key(h, '\r')
  await settle(h)
  assert.equal(h.doc.fullscreen, 'on', 'the choice really persisted')
  // An EXTERNAL writer flips the stored preference before the workspace closes.
  h.doc.fullscreen = 'off'
  await key(h, '\x1b')
  await key(h, '\x1b')
  await key(h, '\x1b')
  await h.vt.waitForRender()
  assert.deepEqual(probe.switches, [],
    'the close re-read no longer matches the verified target, so nothing switches')
  assert.equal(h.app.isFullscreen(), false)
  h.dispose()
})

// Regression: C2-R2 acceptance R2-08.
test('a verified Fullscreen choice does not switch on a legacy hand-off', async () => {
  const probe = fullscreenProbe()
  const h = setup({ columns: 140, rows: 40, doc: { theme: 'dark', fullscreen: 'off' } })
  probe.setup(h)
  await chooseRow(h, 'Input & Terminal', INPUT_TERMINAL_ROWS, 'Fullscreen')
  await highlightCandidate(h, 'on')
  await key(h, '\r')
  await settle(h)
  await key(h, '\x1b') // back to the rows level
  for (let step = 0; step < INPUT_TERMINAL_ROWS.length - 1; step += 1) await key(h, '\x1b[B')
  await key(h, '\r') // the legacy hand-off closes the workspace
  await h.vt.waitForRender()
  assert.match(h.view(), /Type to search/u, 'the existing editor owns the screen')
  assert.deepEqual(probe.switches, [], 'a legacy hand-off is not a user exit')
  assert.equal(h.app.isFullscreen(), false)
  h.dispose()
})

// ── C2-R2 acceptance R2-10 / R2-11: the JOINED notification proof ───────────
//
// One case per axis, driven through the REAL workspace Confirm into the REAL
// `CompletionNotificationController` (the ONE owner the composition constructs)
// and read back as REAL terminal bytes from the REAL terminal presentation. The
// focus tracker and the agent-identity fence are the production ones, not
// fixtures: `createNotificationRuntime` + `createTerminalNotificationPresentation`
// are the same calls `src/app/bootstrap.ts` makes.

/** A real notification owner over a recording terminal writer. */
function realNotificationOwner(): {
  readonly writes: string[]
  readonly runtime: ReturnType<typeof createNotificationRuntime>
} {
  const writes: string[] = []
  const presentation = createTerminalNotificationPresentation({
    writer: { write: (sequence: string) => { writes.push(sequence) } },
  })
  const runtime = createNotificationRuntime({
    presentation,
    notificationMode: 'unfocused',
    notificationMethod: 'auto',
  })
  return { writes, runtime }
}

// Regression: C2-R2 acceptance R2-10.
test('a Notifications confirm reaches the ONE controller and gates the next real completion', async () => {
  const owner = realNotificationOwner()
  const fixture = createDirectSettingsFixture({ theme: 'dark', notificationMode: 'unfocused' })
  const h = setup({
    columns: 140,
    rows: 40,
    tuiSettings: fixture.settings,
    notificationRuntime: owner.runtime,
  })
  // The terminal is FOCUSED, so the `unfocused` default suppresses a settle.
  owner.runtime.setCompletionOwner('agent-1')
  owner.runtime.noteUserInput()
  owner.runtime.onAgentStatus('agent-1', 'running')
  owner.runtime.onAgentStatus('agent-1', 'idle')
  assert.deepEqual(owner.writes, [], 'the default mode suppresses a settle while focused')

  await chooseRow(h, 'Input & Terminal', INPUT_TERMINAL_ROWS, 'Notifications')
  await highlightCandidate(h, 'always')
  await key(h, '\r')
  await settle(h)
  assert.match(h.view(), /Status\s+Verified/u)
  assert.equal(fixture.document().notificationMode, 'always')

  // The SAME controller, driven by a REAL same-agent running -> idle, now emits.
  owner.runtime.onAgentStatus('agent-1', 'running')
  owner.runtime.onAgentStatus('agent-1', 'idle')
  assert.equal(owner.writes.length, 1, 'the freshly selected mode lets the next settle through')

  // A RETIRED agent's late idle still emits nothing (the production fence).
  owner.runtime.onAgentStatus('agent-retired', 'running')
  owner.runtime.onAgentStatus('agent-retired', 'idle')
  assert.equal(owner.writes.length, 1, 'a late idle from a non-current agent never notifies')
  h.dispose()
})

// Regression: C2-R2 acceptance R2-11.
test('a Notification method confirm selects the real emitter and never emits a notification itself', async () => {
  const owner = realNotificationOwner()
  const fixture = createDirectSettingsFixture({ theme: 'dark', notificationMode: 'always', notificationMethod: 'auto' })
  const h = setup({
    columns: 140,
    rows: 40,
    tuiSettings: fixture.settings,
    notificationRuntime: owner.runtime,
  })
  owner.runtime.setCompletionOwner('agent-1')
  // Start from `always` so the mode is not the variable under test.
  owner.runtime.setMode('always')
  await h.open('Input & Terminal')
  await key(h, '\r')
  for (let step = 0; step < INPUT_TERMINAL_ROWS.indexOf('Notification method'); step += 1) await key(h, '\x1b[B')
  assert.ok(h.view().includes('> Notification method'))
  await key(h, '\r')
  await highlightCandidate(h, 'bell')
  await key(h, '\r')
  await settle(h)
  assert.equal(fixture.document().notificationMethod, 'bell')
  assert.deepEqual(owner.writes, [],
    'confirming the method emits NO notification — a synthetic probe is never sent')

  // The NEXT real completion uses the selected emitter (one BEL byte).
  owner.runtime.onAgentStatus('agent-1', 'running')
  owner.runtime.onAgentStatus('agent-1', 'idle')
  assert.deepEqual(owner.writes, ['\x07'], 'the same controller now delivers with the confirmed method')
  h.dispose()
})

// ── C2-R2 acceptance R2-03: the JOINED busy-Enter route ─────────────────────
//
// The Document -> consumer link is the whole point of a persist-first field, so
// this case joins the two halves on ONE document: the REAL workspace Confirm
// writes it, and the REAL submit boundary (`resolveSubmitDelivery`, the exact
// function `SubmissionController` calls with `deps.tuiSettings?.get().busyEnter`)
// is then asked what the next busy Enter does — reading that same document.

// Regression: C2-R2 acceptance R2-03.
test('a Submit while busy confirm changes the very value the submit boundary reads', async () => {
  const fixture = createDirectSettingsFixture({ theme: 'dark', busyEnter: 'queue' })
  const h = setup({ columns: 140, rows: 40, tuiSettings: fixture.settings })
  await chooseRow(h, 'Conversation', CONVERSATION_ROWS, 'Submit while busy')
  await highlightCandidate(h, 'steer')
  await key(h, '\r')
  await settle(h)
  assert.match(h.view(), /Status\s+Verified/u)

  // The consumer side, evaluated against the SAME document the write verified —
  // no test-local copy of the policy is involved.
  const document = fixture.settings.get()
  assert.equal(resolveSubmitDelivery(undefined, true, 'enter', document.busyEnter), 'steer',
    'a busy plain Enter now steers the draft into the running turn')
  assert.equal(resolveSubmitDelivery(undefined, true, 'accelerated', document.busyEnter), 'queue',
    'the accelerated chord still takes the opposite delivery')
  assert.equal(resolveSubmitDelivery(undefined, false, 'enter', document.busyEnter), 'queue',
    'an IDLE submit is unaffected by the busy policy')
  // And the row itself reports that same next-action policy as its Runtime fact.
  await key(h, '\r')
  assert.match(h.view(), /Runtime\s+Next busy Enter: steer/u,
    `the Detail's Runtime fact agrees with the consumer:\n${h.view()}`)
  h.dispose()
})

// ── C2-R2 acceptance R2-14 / R2-12: the remaining failure and legacy cases ───

// Regression: C2-R2 acceptance R2-14.
test('a refused persist-first write keeps the stored fact and Retry uses the same writer', async () => {
  let refuse = true
  const h = setup({
    columns: 140,
    rows: 40,
    doc: { theme: 'dark', busyEnter: 'queue' },
    applyReplace: (next) => {
      if (refuse) throw new Error('settings namespace "tui-app" changed since it was read')
      Object.assign(h.doc, next)
    },
  })
  await chooseRow(h, 'Conversation', CONVERSATION_ROWS, 'Submit while busy')
  await highlightCandidate(h, 'steer')
  await key(h, '\r')
  await settle(h)
  assert.equal(h.replacements(), 1, 'the first attempt reached the document writer')
  // A persist-first refusal must NOT be dressed up as applied: the primary
  // Value still reports the STORED fact, and no runtime switch is claimed.
  assert.match(h.view(), /Status\s+Not saved/u, `the refusal is stated:\n${h.view()}`)
  // A persist-first row's PRIMARY fact is the stored document value, so the
  // unchanged store is painted as `Value` (there is no separate `Persisted`
  // row on this row kind) — and the runtime half still says queue.
  assert.match(h.view(), /Value\s+queue/u, 'the stored fact is unchanged')
  assert.match(h.view(), /Runtime\s+Next busy Enter: queue/u,
    'the next action really is still queue — nothing was applied')
  assert.match(h.view(), /Retry save/u, 'the row offers the explicit retry')

  // Retry through the SAME writer (the painted button, as a user clicks it).
  refuse = false
  const retryRow = rowOf(h, 'Retry save')
  press(h, retryRow, cellIndexOf(h, retryRow, 'Retry save'))
  release(h, retryRow, cellIndexOf(h, retryRow, 'Retry save'))
  await settle(h)
  assert.equal(h.replacements(), 2, 'the retry used the same writer exactly once')
  assert.equal(h.doc.busyEnter, 'steer', 'the retried value is the one the user chose')
  assert.match(h.view(), /Status\s+Verified/u, 'the retry verifies its own authoritative re-read')
  assert.match(h.view(), /Runtime\s+Next busy Enter: steer/u, 'and the consumer fact follows it')
  h.dispose()
})

// Regression: C2-R2 acceptance R2-12.
test('a legacy terminalProgress "on" reads as the dual protocol and is never written back', async () => {
  const values: TuiSettingsDoc = { ...DEFAULT_DOC, theme: 'dark', terminalProgress: 'on' }
  const h = setup({
    columns: 140,
    rows: 40,
    tuiSettings: {
      get: () => values,
      replace: (next: TuiSettingsDoc) => { Object.assign(values, next) },
    },
    // The legacy value is what the mounted surface was booted with.
    appTerminalProgress: '9;4+7501',
  })
  await h.open('Input & Terminal')
  await key(h, '\r')
  for (let step = 0; step < INPUT_TERMINAL_ROWS.indexOf('Terminal progress'); step += 1) await key(h, '\x1b[B')
  assert.ok(h.view().includes('> Terminal progress'))
  // This row is runtime-primary: the LIVE fact reads the dual protocol and the
  // RAW stored value (`on`) is reported separately as `Persisted`.
  assert.match(h.view(), /Runtime\s+9;4\+7501|Value\s+9;4\+7501/u,
    `the retired value reads as the dual protocol:\n${h.view()}`)
  assert.match(h.view(), /Persisted\s+on/u,
    `the raw stored value is reported verbatim, never rewritten:\n${h.view()}`)
  assert.equal(h.replacements(), 0, 'merely reading a legacy value writes NOTHING back')

  // A confirm on a DIFFERENT candidate is the only thing that may rewrite it.
  await key(h, '\r')
  await highlightCandidate(h, 'off')
  await key(h, '\r')
  await settle(h)
  // This case supplies its OWN document object, so the authoritative read is
  // that object — never the harness's default copy.
  assert.equal(values.terminalProgress, 'off', 'only an explicit confirmation rewrites the field')
  h.dispose()
})

// Regression: C2-R2 acceptance R2-04.
test('a persist-first row reads the CURRENT raw value even when another writer just changed it', async () => {
  // The painted read and the Confirm are separate moments. This case proves the
  // row reports the document as it really is at THIS read — a stale value can
  // never be presented as the stored one — by changing the document between two
  // snapshot reads and re-opening the row.
  const values: TuiSettingsDoc = { ...DEFAULT_DOC, theme: 'dark', busyEnter: 'queue' }
  const h = setup({
    columns: 140,
    rows: 40,
    tuiSettings: {
      get: () => values,
      replace: (next: TuiSettingsDoc) => { Object.assign(values, next) },
    },
  })
  await chooseRow(h, 'Conversation', CONVERSATION_ROWS, 'Submit while busy')
  assert.match(h.view(), /> queue\s+\[current\]/u, 'the first read marks queue')

  // Another writer commits `steer` behind the workspace's back WHILE the choice
  // is open. A live choice must NOT silently re-anchor on an external write —
  // its candidates stay the ones the user is looking at.
  values.busyEnter = 'steer'
  await key(h, 'r') // the refresh key is deliberately inert during a live choice
  await settle(h)
  assert.match(h.view(), /> queue\s+\[current\]/u,
    `an external write never rewrites the open choice's candidates:\n${h.view()}`)
  assert.equal(h.replacements(), 0, 'and nothing was written')

  // Cancel the live choice, then use the workspace's OWN refresh gesture: `r`
  // re-reads the authorities at the Detail level and the row must then report
  // the value the document really holds NOW.
  await key(h, '\x1b') // cancel the choice, back to the Detail level
  await settle(h)
  await key(h, 'r')
  await settle(h)
  assert.match(h.view(), /Value\s+steer/u,
    `the re-read row reports the CURRENT stored value, never the stale one:\n${h.view()}`)
  assert.match(h.view(), /Runtime\s+Next busy Enter: steer/u,
    'the consumer fact follows the same fresh read')
  await key(h, '\r') // re-open the choice on the fresh snapshot
  assert.match(h.view(), /> steer\s+\[current\]/u, 'the fresh snapshot owns [current]')
  assert.doesNotMatch(h.view(), /> queue\s+\[current\]/u,
    'the previous stored value no longer claims to be current')
  h.dispose()
})

// Regression: C2-R2 acceptance R2-03 (the consumer chain, not just the value).
test('a Submit while busy confirm is readable through the runtime owner the viewer path uses', async () => {
  // The previous case proved the DOCUMENT value. This one proves that the
  // runtime owner's accessor reads the committed value — with a reverse
  // control — so a writer that stops reaching the document the owner reads
  // fails here even when the document looks right.
  //
  // SCOPE: `SettingsRuntime.busyEnter()` is NOT the main submit path. The main
  // boundary reads `deps.tuiSettings.get().busyEnter` directly
  // (`submission/controller.ts:1778`); this accessor serves the Subagent Viewer
  // path (`application-events.ts:704`). The joined main-submit proof lives in
  // `test/app/submit-hot-path.test.ts` ("a Submit while busy settings write
  // reaches the REAL main-session submit route"), which drives the real
  // `/settings` confirm and then the real `SubmissionController.submit()`.
  const fixture = createDirectSettingsFixture({ theme: 'dark', busyEnter: 'queue' })
  const h = setup({ columns: 140, rows: 40, tuiSettings: fixture.settings })
  // The runtime owner over the SAME document the workspace writes.
  const settingsOwner = createSettingsRuntime({
    surface: {
      app: h.app,
      status: { snapshot: () => ({}) as never, subscribe: () => () => {} },
    },
    signal: new AbortController().signal,
    tuiSettings: fixture.settings as never,
    settingsForms: undefined,
    isCleanedUp: () => false,
    backend: { config: { footerCustomItems: { rawForPersistence: () => ({ kind: 'available', value: undefined }) } } } as never,
    diag: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} } as never,
    status: { refresh: () => {} },
    extensions: () => undefined,
  })
  // Reverse control BEFORE the change: the owner really reports the old policy.
  assert.equal(settingsOwner.busyEnter(), 'queue', 'the owner starts on the stored queue policy')

  await chooseRow(h, 'Conversation', CONVERSATION_ROWS, 'Submit while busy')
  await highlightCandidate(h, 'steer')
  await key(h, '\r')
  await settle(h)

  // The OWNER's own accessor — not a test-side document read — is what the
  // submit boundary consumes.
  assert.equal(settingsOwner.busyEnter(), 'steer',
    'the runtime owner reads the value the workspace just committed')
  assert.equal(resolveSubmitDelivery(undefined, true, 'enter', settingsOwner.busyEnter()), 'steer',
    'a busy plain Enter steers through the owner, not through a document read')
  assert.equal(resolveSubmitDelivery(undefined, true, 'accelerated', settingsOwner.busyEnter()), 'queue',
    'the accelerated chord still inverts the owner policy')
  assert.equal(resolveSubmitDelivery(undefined, false, 'enter', settingsOwner.busyEnter()), 'queue',
    'an idle submit is unaffected')
  h.dispose()
})

// Regression: C2-R2 acceptance R2-06 (confirm -> real fullscreen key routing).
test('a Home/End confirm changes what the real fullscreen Home key does', async () => {
  // ONE joined case. The workspace Confirm writes the preset through its ONE
  // owner, then the SAME `h.app` goes to fullscreen over a transcript that
  // really OVERFLOWS the viewport (a transcript that fits cannot prove a scroll
  // either way) and receives the physical Home key.
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS))
  getKeybindings().setUserBindings({ 'tui.altScreen.search': 'ctrl+f' })
  // A SHORT terminal so the 60-line transcript overflows it.
  const h = setup({ columns: 80, rows: 24, doc: { theme: 'dark', homeEndKeys: 'input' } })
  const resolve = (): { readonly top: unknown; readonly bottom: unknown; readonly search: unknown } => {
    const manager = getKeybindings()
    return {
      top: manager.getResolvedBindings()['tui.altScreen.top'],
      bottom: manager.getResolvedBindings()['tui.altScreen.bottom'],
      search: manager.getResolvedBindings()['tui.altScreen.search'],
    }
  }
  const folder = new TranscriptFolder()
  folder.apply([
    {
      type: 'assistant/message',
      surfaceOp: 'append',
      seq: SessionSeq(0),
      time: Date.now() - 60_000,
      data: {
        stream: [], turn: 0, step: 0,
        message: {
          id: MessageId('m1'), role: 'assistant',
          source: { kind: 'model', provider: 'p', model: 'm' },
          content: [{ type: 'text', text: Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n') }],
        },
      },
    } as SessionEvent,
  ])
  const hasLine = (text: string): boolean => h.rowsPlain().some(line => line
    .replace(/↓ Latest.*$/, '')
    .replace(/[│┃█]$/, '')
    .trim()
    .endsWith(text))

  // ── BEFORE the confirm: the persisted `input` preset (the call
  // `applyBootDisplay` makes). Home must NOT scroll; Ctrl+Home must.
  h.app.setHomeEndMode(h.doc.homeEndKeys)
  h.app.setTranscript(folder.messages())
  h.app.setFullscreen(true)
  await h.vt.waitForRender()
  assert.ok(hasLine('line 60'), `precondition: the tail is visible:\n${h.view()}`)
  assert.ok(!hasLine('line 1'), `precondition: the head is scrolled away:\n${h.view()}`)
  h.vt.sendInput('\x1bOH') // Home
  await h.vt.waitForRender()
  assert.ok(!hasLine('line 1'), `in \`input\` mode Home does NOT scroll the viewport:\n${h.view()}`)
  h.vt.sendInput('\x1b[7^') // Ctrl+Home
  await h.vt.waitForRender()
  assert.ok(hasLine('line 1'), `Ctrl+Home scrolls in \`input\` mode:\n${h.view()}`)
  h.app.setFullscreen(false)
  await h.vt.waitForRender()

  // ── THE CONFIRM through the real workspace.
  await chooseRow(h, 'Input & Terminal', INPUT_TERMINAL_ROWS, 'Home/End keys')
  assert.match(h.view(), /> input\s+\[current\]/u, 'the live keymap fact owns the chip')
  await highlightCandidate(h, 'viewport')
  await key(h, '\r')
  await settle(h)
  assert.match(h.view(), /Status\s+Verified/u, 'the confirm was Verified by its persistence read-back')
  const after = resolve()
  assert.equal(after.top, 'home', 'the confirm makes the viewport own Home')
  assert.equal(after.bottom, 'end', 'and End')
  assert.equal(after.search, 'ctrl+f', 'no other user binding was disturbed')
  assert.match(h.view(), /Value\s+viewport/u, `the row reports the applied preset:\n${h.view()}`)

  // ── AFTER the confirm: leave the workspace; the SAME physical Home now
  // scrolls the SAME surface's viewport.
  await key(h, '\x1b') // choice -> detail
  await key(h, '\x1b') // detail -> rows
  await key(h, '\x1b') // rows -> categories
  await key(h, '\x1b') // close the workspace
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('Settings · '), 'the workspace released the screen')
  h.app.setFullscreen(true)
  await h.vt.waitForRender()
  assert.ok(hasLine('line 60'), `precondition: the tail is visible again:\n${h.view()}`)
  h.vt.sendInput('\x1bOH') // Home — now the viewport owns it
  await h.vt.waitForRender()
  assert.ok(hasLine('line 1'),
    `after the confirm the same Home scrolls the viewport to the top:\n${h.view()}`)
  h.dispose()
})

// Regression: C2-R2 acceptance R2-09 (the next mount really receives it).
test('a Mouse wheel lines confirm reaches the NEXT fullscreen mount', async () => {
  const fixture = createDirectSettingsFixture({ theme: 'dark', wheelScrollLines: '1' })
  const h = setup({ columns: 140, rows: 40, tuiSettings: fixture.settings })
  await chooseRow(h, 'Input & Terminal', INPUT_TERMINAL_ROWS, 'Mouse wheel lines')
  await highlightCandidate(h, '5')
  await key(h, '\r')
  await settle(h)
  assert.equal(h.app.currentWheelScrollLines(), 5, 'the preference the next mount reads changed')

  // Mount a REAL fullscreen viewport on that same app and measure one wheel. A
  // multi-turn transcript WITH turn activities is what makes the pane scrollable
  // at this height (the same shape the wheel suite uses).
  const folder = new TranscriptFolder()
  // The transcript clock must be recent: the window/fold logic treats ancient
  // timestamps differently, and the wheel suite uses `Date.now() - 60s` too.
  const t0 = Date.now() - 60_000
  for (let turn = 0; turn < 25; turn += 1) {
    folder.apply([
      { type: 'turn/start', surfaceOp: 'append', seq: SessionSeq(turn * 10), time: t0 + turn * 1000, data: { turn } },
      {
        type: 'user/message', surfaceOp: 'append', seq: SessionSeq(turn * 10 + 1), time: t0 + 1 + turn * 1000,
        data: { id: MessageId(`u${turn}`), role: 'user', content: [{ type: 'text', text: `prompt ${turn}` }], source: { kind: 'user' } },
      },
      {
        type: 'assistant/message', surfaceOp: 'append', seq: SessionSeq(turn * 10 + 2), time: t0 + 2 + turn * 1000,
        data: {
          turn, step: 1,
          message: {
            id: MessageId(`a${turn}`), role: 'assistant',
            content: [{ type: 'text', text: `answer ${turn}` }], source: { kind: 'model', provider: 'p', model: 'm' },
          },
        },
      },
      { type: 'turn/end', surfaceOp: 'append', seq: SessionSeq(turn * 10 + 3), time: t0 + 3 + turn * 1000, data: { turn, reason: { kind: 'completed' } } },
    ] as SessionEvent[])
  }
  // Leave the workspace through its own Esc path first: while the lease is
  // held the workspace alt screen owns the physical screen, so the transcript
  // viewport the wheel applies to only exists afterwards. (The repo allows ONE
  // live TuiApp per process, so this must be the same app.)
  await key(h, '\x1b') // choice -> detail
  await key(h, '\x1b') // detail -> rows
  await key(h, '\x1b') // rows -> categories
  await key(h, '\x1b') // close the workspace
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('Settings · '), 'the workspace released the screen')

  // Mount the REAL transcript viewport on that same app and measure one wheel.
  h.app.setTranscript(folder.messages(), folder.turnActivities())
  h.app.setFullscreen(true)
  await h.vt.waitForRender()
  const bottom = h.app.fullscreenScrollForTest()
  assert.ok(bottom !== undefined && bottom.maxScrollTop > 0, 'precondition: a scrollable transcript')
  h.vt.sendInput('\x1b[<64;50;10M') // one wheel-up event
  await h.vt.waitForRender()
  const after = h.app.fullscreenScrollForTest()
  assert.equal(after?.scrollTop, bottom.maxScrollTop - 5,
    'the freshly mounted viewport scrolls the confirmed 5 lines per wheel event')
  h.dispose()
})
// Regression: C2-R2 acceptance R2-12 (the real terminal sink, not the mode).
test('a Terminal progress confirm really stops the OSC 9;4 terminal writes', async () => {
  // `VirtualTerminal.setProgress` is the physical OSC 9;4 sink the mounted
  // PiTui screen drives (the OSC 7501 `setProgressState` path belongs to the
  // Tern terminal, a different renderer). Observing THIS sink is what proves
  // the confirm changes terminal state, not merely a stored mode.
  const h = setup({ columns: 140, rows: 40, doc: { theme: 'dark', terminalProgress: '9;4' }, appTerminalProgress: '9;4' })
  const progress: boolean[] = []
  h.vt.setProgress = (active: boolean) => { progress.push(active) }
  // Positive control: a running interval reaches the sink on this protocol.
  h.app.setTerminalProgress(true)
  await h.vt.waitForRender()
  assert.ok(progress.length > 0, `the booted 9;4 protocol really drives the sink:\n${progress.join(', ')}`)

  await chooseRow(h, 'Input & Terminal', INPUT_TERMINAL_ROWS, 'Terminal progress')
  await highlightCandidate(h, 'off')
  await key(h, '\r')
  await settle(h)
  assert.equal(h.doc.terminalProgress, 'off', 'the document stores the OFF selection')
  assert.equal(h.app.currentTerminalProgressMode(), 'off', 'the surface adopted it')

  // Negative control: with the selection off, no further interval may claim the
  // protocol. This is the load-bearing half — a mode that changed but kept
  // writing would pass a "currentTerminalProgressMode() === 'off'"-only check.
  const afterOff = progress.length
  h.app.setTerminalProgress(true)
  h.app.setTerminalProgress(false)
  await h.vt.waitForRender()
  assert.equal(progress.length, afterOff,
    `no 9;4 activity is written while the selection is off:\n${progress.join(', ')}`)
  h.dispose()
})
// Regression: C2-R2 acceptance R2-07 (the symmetric direction).
test('a Fullscreen On -> Off choice switches OFF after the normal exit', async () => {
  // R2-07 requires BOTH directions. The Off -> On case is above; leaving the
  // alt screen takes a different path (the alt screen stops, the main screen
  // restarts and takes the keyboard back), so it needs its own witness.
  const h = setup({ columns: 140, rows: 40, doc: { theme: 'dark', fullscreen: 'on' }, appFullscreen: true })
  h.setOnFullscreenChange(() => {})
  assert.equal(h.app.isFullscreen(), true, 'precondition: the transcript is in fullscreen')
  await selectWorkspaceRow(h, 'Input & Terminal', INPUT_TERMINAL_ROWS, 'Fullscreen')
  assert.match(detailsPaneText(h), /Current transcript mode: on \(Settings lease is separate\); applied after normal Settings close/u,
    `the Runtime fact reports the live transcript mode:\\n${h.view()}`)
  await key(h, '\r') // the choice
  await highlightCandidate(h, 'off')
  await key(h, '\r')
  await settle(h)
  assert.equal(h.doc.fullscreen, 'off', 'the preference is stored')
  assert.equal(h.replacements(), 1, 'exactly ONE document write')
  assert.match(h.view(), /Status\s+Verified/u)
  assert.equal(h.app.isFullscreen(), true, 'the screen does NOT switch while the workspace is open')

  await key(h, '\x1b') // choice -> detail
  await key(h, '\x1b')
  await key(h, '\x1b')
  await h.vt.waitForRender()
  assert.equal(h.app.isFullscreen(), false, 'the normal exit leaves the alt screen')
  assert.equal(h.replacements(), 1, 'the post-close switch wrote NO second document copy')
  assert.equal(h.fullscreenChanges(), 0, 'and fired no persistence callback')
  h.dispose()
})
