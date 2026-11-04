/**
 * The APPLICATION-COMPOSED proof of the TSP slash-command completion.
 *
 * Every case drives the real production chain and asserts only what the user
 * can see on the wire or what a counted application callback recorded:
 *
 *   the REAL `registerTuiCommands` catalog commit + its provenance screen
 *     -> the composition root's `installTspCommandCompletions` seam
 *     -> the REAL `SurfaceRuntime.installTspCommandCompletions` forward
 *        (the mount's installer reference — no second catalog, no second claims)
 *     -> the REAL `mountTspRenderer` completion seat + the SAME installed
 *        provider factory the PiTui surface composes
 *     -> the shipped `@stencil-hq/tern` SDK over a scripted pane tty
 *     -> the controlled `ui.editor` wire `text`/UTF-16 `cursor`, the candidate
 *        rows the frames really carried, and the ONE application submit entry
 *        wired to the REAL `createSubmissionController`.
 *
 * EVIDENCE LEVEL: application-composed / SDK wire. PRODUCTION under test: the
 * command catalog and its provenance screen, the surface runtime, the TSP
 * renderer and its completion seat, the autocomplete composition, the extension
 * command bridge, the submission controller, the input-history owner and the
 * display seam. DECLARED STAND-INS: the scripted pane tty (no physical Tern
 * client), a scripted Host commands service plus scripted plugin faces (no real
 * plugin host), and an inert Agent with recording writer sinks (no model turn).
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-slash-completion-composition.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { connect as sdkConnect } from '@stencil-hq/tern'
import type { Session } from '@stencil-hq/tern'
import { Context } from '@deepseek-ai/cordis'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { registerTuiCommands, type TuiCommandRunner } from '../../src/commands.ts'
import { commandSummaryOf, type SurfaceCommandSummary } from '../../src/domain/catalog/surface.ts'
import type { HumanSkillSummary } from '../../src/domain/catalog/skill.ts'
import { listGlobalCommands } from '../../src/runtime/direct/surface-catalog.ts'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { CommandBridge } from '../../src/extension/internal/command-bridge.ts'
import type { TuiAutocompleteQuery, TuiAutocompleteSuggestions } from '../../src/extension/public-types.ts'
import type { HostFileListResult, HostFilePort, HostFileResolveResult, HostFileScope } from '../../src/runtime/host-file-port.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import {
  createSurfaceRuntime,
  type SurfaceRendererMount,
  type SurfaceRuntime,
  type TspCommandCompletionInstallation,
} from '../../src/app/surface/runtime.ts'
import { createSubmissionController, type SubmissionControllerDeps } from '../../src/app/submission/controller.ts'
import { bindSubmissionRuntime, type SubmissionRuntimeSurface } from '../../src/app/submission/runtime.ts'
import { preparePrompt } from '../../src/app/submission/prepared-prompt.ts'
import { mergeDraft } from '../../src/app/submission/steer.ts'
import { createSessionOwnershipCore } from '../../src/app/session/ownership-core.ts'
import { createInputHistory } from '../../src/app/surface/input-history.ts'
import { TranscriptFolder } from '../../src/domain/transcript/folder.ts'
import { TranscriptWindowController } from '../../src/domain/transcript/window.ts'
import { createPluginManagerWorkspacePanel } from '../../src/tui/plugin-manager/workspace.ts'
import { mountTspRenderer, type TspRenderer } from '../../src/tui/tsp/session.ts'
import { draftHasAttachments } from '../../src/client/media/draft-attachments.ts'
import { DraftFileStore } from '../../src/client/media/attachment/file-draft.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import type { ComposerSubmitRequest } from '../../src/tui-app.ts'
import type { SurfaceEventRoutingSource } from '../../src/app/surface/event-routing.ts'
import type { ModelApplyOutcome, ModelPickerRequest } from '../../src/app/command/model-presentation.ts'
import type { TspBuiltinPickers } from '../../src/app/command/tsp-capability.ts'
import { foldWireNodes, wireNodes, type WireNode } from '../support/tsp-picker-wire.ts'
import { waitUntil } from '../support/tsp-runner-harness.ts'
import { installTspPane, type TspPane } from '../support/tsp-terminal-fixture.ts'
import { sessionScopeFacts } from '../support/session-scope-facts.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'

const nullPresentation = {
  handleFocusReport: () => {},
  markFocused: () => {},
  focusState: () => 'focused' as const,
  notify: () => {},
  enableFocusReporting: () => {},
  disableFocusReporting: () => {},
}

const SESSION_ID = 'session-ic-composition'
/** The controlled composer's node path inside the Quiet Composer shell. */
const EDITOR_ID = 'dock.quiet-composer.composer'

// The shipped SDK decoder is the only key authority: every byte below is what a
// physical terminal sends, and the renderer receives its own decoded `Key`. The
// sequences are composed from `ESC` so no raw control byte is written by hand.
const ESC = String.fromCharCode(27)
const UP = `${ESC}[A`
const DOWN = `${ESC}[B`
const HOME = `${ESC}[H`
const SHIFT_ENTER = `${ESC}[13;2u`
const TAB = '\t'
const ENTER = '\r'
const ESCAPE = ESC

/**
 * The bounded observation window for this file's ABSENCE claims. A popup that
 * correctly never appears has no event to await (the seat deliberately commits
 * no render for a closed seat), so the case waits exactly this window and then
 * reads the wire, while every PRESENCE claim waits an authoritative pane frame
 * or callback. The bound covers one SDK input dispatch plus the suggestion
 * settlement the seat would have painted.
 */
const ABSENCE_WINDOW_MS = 220

/** A row of the scripted Host global command catalog. */
interface HostRow {
  readonly name: string
  readonly description: string
  readonly definitionId?: string
  readonly input?: { readonly hint: string }
}

// The provenance the screen must recognise, one row per source it names:
// `settings` is ALSO a TUI built-in the mounted renderer cannot run, so keeping
// it proves the GENUINE Host-origin rule ran first; `alpha` is an ordinary
// Host row; `help`/`login`/`logout`/`rewind` are TUI registrations the screen
// withdraws; `model` rides the mounted presenter capability.
const HOST_ROWS: readonly HostRow[] = [
  { name: 'alpha', description: 'Host alpha command' },
  { name: 'settings', description: 'Host settings panel', definitionId: '@host/genuine/settings' },
]
/** The live dynamic Skill catalog: its wrapper row is never a TUI builtin. */
const SKILL_ROWS: readonly HumanSkillSummary[] = [
  { name: 'glab', description: 'GitLab workflow' },
]
/** The plugin command contribution (merged in by the real candidate synthesis). */
const CONTRIBUTION_NAME = 'deploy-report'

/** One row of the slash popup as the wire carries it. */
interface PopupRow {
  readonly id: string
  readonly value: string
  readonly highlighted: boolean
}

/** Every candidate row the CURRENT wire carries, in painted order. A row is the
 *  styled `el` button the seat's own projection produced; its leaf text children
 *  carry the name and the description. */
function popupRows(pane: TspPane): PopupRow[] {
  const live = wireNodes(pane)
  const leafText = (node: WireNode): string => {
    const own = node.p.text
    if (typeof own === 'string' && own !== '') return own
    const subtree = live.filter(entry => entry.id.startsWith(`${node.id}.`))
    const leaves = subtree.filter(entry => typeof entry.p.text === 'string' && entry.p.text !== '')
      .filter(entry => !subtree.some(inner => inner.id.startsWith(`${entry.id}.`)
        && typeof inner.p.text === 'string' && inner.p.text !== ''))
    return leaves.map(entry => String(entry.p.text)).join('')
  }
  return live
    .filter(node => node.k === 'el' && /\.slash-[^.]+$/.test(node.id))
    .map(node => {
      const attrs = node.p.attrs as Record<string, unknown> | undefined
      const label = leafText(node)
      // The row's own `title`/`aria` is the seat's composed
      // `${row.name} — ${description}` text: its leading token is the EXACT
      // command name, never the concatenated label/description spans.
      const title = typeof node.p.title === 'string' ? node.p.title : ''
      const aria = typeof node.p.aria === 'string' ? node.p.aria : ''
      const full = title !== '' ? title : (aria !== '' ? aria : label)
      const name = /^\/([a-z0-9._:-]+)/u.exec(full)?.[1]
        ?? /(?:\u203a| )\/([a-z0-9._:-]+)/u.exec(label)?.[1] ?? ''
      return {
        id: node.id,
        value: name,
        highlighted: attrs?.['data-highlight'] === 'true',
      }
    })
}

/** Whether a candidate row was painted in one of the frames after `mark`. */
function h_rows_changed(pane: TspPane, mark: number): boolean {
  const frames = pane.frames()
  for (let index = Math.max(0, mark); index < frames.length; index += 1) {
    for (const op of frames[index]!.ops) {
      if (op[0] === 'add' && String(op[1]).includes('.slash-')) return true
    }
  }
  return false
}

/** The candidate values, in painted order. */
function popupValues(pane: TspPane): string[] {
  return popupRows(pane).map(row => row.value)
}

/** The controlled composer's wire facts: the ONE visible draft and UTF-16 caret. */
function editorWire(pane: TspPane): { text: string; cursor: number } {
  const node = wireNodes(pane).find(candidate => candidate.id === EDITOR_ID)
  assert.ok(node, 'the controlled composer editor is on the wire')
  return { text: String(node.p.text ?? ''), cursor: Number(node.p.cursor ?? 0) }
}

/** Whether any frame from `fromFrame` onwards carried the slash popup at all —
 *  its row buttons, its menu container or its own hint line. The LIVE fold alone
 *  cannot prove an absence claim: a row that was painted and then removed is gone
 *  from it, so every intermediate frame has to be inspected. */
function popupPaintedSince(pane: TspPane, fromFrame: number): boolean {
  const frames = pane.frames()
  for (let index = Math.max(0, fromFrame); index < frames.length; index += 1) {
    const live = foldWireNodes(frames.slice(0, index + 1))
    if (live.some(node => node.id.includes('slash-'))) return true
    if (live.some(node => String(node.p.text ?? '').includes('Tab/Enter complete'))) return true
  }
  return false
}


/**
 * The scripted Host commands service: the global-layer rows the Direct catalog
 * seam reads, plus the TUI's OWN compatibility mirrors. A name a scripted Host
 * row already owns refuses the mirror exactly like the official service, so the
 * surviving winner keeps its genuine `definitionId` provenance.
 */
function scriptedCommands(rows: readonly HostRow[]) {
  const mirrored: SurfaceCommandSummary[] = []
  const taken = new Set(rows.map(row => row.name))
  return {
    /** The effective global-layer view the completion merge reads. */
    list(): readonly SurfaceCommandSummary[] {
      return [
        ...rows.map(row => commandSummaryOf(row)),
        ...mirrored,
      ]
    },
    register(definition: SurfaceCommandSummary & { handler?: unknown }): () => void {
      if (taken.has(definition.name)) {
        throw new Error(`command "${definition.name}" is already registered`)
      }
      taken.add(definition.name)
      mirrored.push(commandSummaryOf(definition))
      let released = false
      return (): void => {
        if (released) return
        released = true
        taken.delete(definition.name)
        const index = mirrored.indexOf(definition)
        if (index >= 0) mirrored.splice(index, 1)
      }
    },
  }
}

/**
 * The plugin command contributions, registered through the PRODUCTION
 * `CommandBridge` (its real generation counter and disposal semantics), which
 * is the face `mergeContributions` merges into the display catalog.
 */
function scriptedContributions() {
  const bridge = new CommandBridge(() => {}, new Set<string>())
  const handles = new Map<string, { dispose(): void }>()
  return {
    bridge,
    add(name: string): void {
      const outcome = bridge.register({
        id: `plugin-${name}`,
        name,
        description: `plugin ${name}`,
        sessionless: true,
        handler: async () => ({ kind: 'success' as const }),
      }, 'plugin-owner')
      assert.equal(outcome.kind, 'registered', `the ${name} contribution must register`)
      if (outcome.kind === 'registered') handles.set(name, outcome.handle)
    },
    remove(name: string): void {
      handles.get(name)?.dispose()
      handles.delete(name)
    },
  }
}

/**
 * A Host-file port that COUNTS: I-C opens no file seat, so every method of this
 * witness port must stay unreached while the completion runs.
 */
function countingHostFilePort(): { port: HostFilePort; calls: () => number } {
  let calls = 0
  const count = (): void => { calls += 1 }
  return {
    calls: () => calls,
    port: {
      async listReferences(): Promise<HostFileListResult> {
        count()
        return { kind: 'unavailable', reason: 'the witness port never discovers files' }
      },
      async resolveReference(): Promise<HostFileResolveResult> {
        count()
        return { kind: 'unavailable', reason: 'the witness port never probes a path' }
      },
      async canonicalizeMentions(_scope: HostFileScope, text: string): Promise<string> {
        count()
        return text
      },
    },
  }
}

/**
 * The scripted plugin autocomplete chain. `suggestOwned` is consulted only when
 * the host catalog has nothing to answer, and a HELD answer resolves exactly
 * when the case releases it — so "the answer arrived late" is a fact the test
 * drives, never a race it hopes to lose.
 */
interface ScriptedPluginChain {
  suggestOwned(query: TuiAutocompleteQuery): Promise<TuiAutocompleteSuggestions | null>
  /** Releases held answer `index` with these candidates. */
  release(index: number, items: readonly { value: string; label: string }[]): void
  /** Releases every outstanding answer with no candidates. */
  releaseAll(): void
  readonly asked: () => number
  /** Arm the next call so it resolves immediately with no candidates. */
  quiet(): void
  /** Hold the NEXT call until `release` (the late-answer window under test). */
  hold(): void
}

function scriptedPluginChain(): ScriptedPluginChain {
  const held: Array<(value: TuiAutocompleteSuggestions | null) => void> = []
  let immediate = true
  let asked = 0
  const chain: ScriptedPluginChain = {
    asked: () => asked,
    quiet: () => { immediate = true },
    hold: () => { immediate = false },
    async suggestOwned(): Promise<TuiAutocompleteSuggestions | null> {
      asked += 1
      if (immediate) return null
      return new Promise<TuiAutocompleteSuggestions | null>((resolve) => { held.push(resolve) })
    },
    release(index, items) {
      const resolve = held[index]
      if (resolve === undefined) return
      held[index] = () => {}
      resolve({ items: [...items], prefix: '/' })
    },
    releaseAll() {
      for (let index = 0; index < held.length; index += 1) chain.release(index, [])
    },
  }
  return chain
}

/** What a case may script before the mount is built. */
interface MountOptions {
  /** Advertise the native Model presenter kinds on the pane (the real fact the
   *  catalog screen reads for `/model`). */
  readonly modelPicker?: boolean
  /** Keep every plugin answer held until the case releases it. */
  readonly holdPluginAnswers?: boolean
  readonly contributions?: readonly string[]
  readonly hostRows?: readonly HostRow[]
}

interface ChainHarness {
  readonly surface: SurfaceRuntime<SessionEvent>
  readonly pane: TspPane
  readonly session: Session
  readonly renderer: () => TspRenderer
  readonly commands: ReturnType<typeof registerTuiCommands>
  readonly contributions: ReturnType<typeof scriptedContributions>
  /** Add/remove a plugin command contribution through the REAL bridge. */
  readonly addContribution: (name: string) => void
  readonly plugin: ScriptedPluginChain
  readonly hostFileCalls: () => number
  /** The ONE application submit entry the real binding forwards to. */
  readonly submits: Array<{ text: string; request: string; token: number | undefined }>
  /** The real submission controller's writer sink. */
  readonly writes: unknown[]
  readonly selects: string[]
  readonly cancels: () => number
  /** Re-commit the effective catalog through the ONE production commit point. */
  commitCatalog(): void
  editor(): { text: string; cursor: number }
  rows(): PopupRow[]
  values(): string[]
  /** One real key sequence, awaited on the frame it must paint. */
  press(bytes: string): Promise<void>
  /** A raw trigger awaited on the popup it must open. */
  triggerQuietly(bytes: string): Promise<void>
  /** One real key sequence that must change nothing on the wire. */
  pressQuietly(bytes: string): Promise<void>
  /** A program-owned draft write (no key, so no natural trigger runs). */
  setDraft(text: string): Promise<void>
  clickRow(row: PopupRow): Promise<void>
  waitNoRowPaint(sinceFrame: number, label: string): Promise<void>
  frameCount(): number
  dispose(): Promise<void>
}

/**
 * Compose ONE real mount: the surface runtime, the TSP renderer over the
 * scripted pane, the REAL command catalog commit (with its provenance screen
 * pointed at this mount), and the REAL submission controller behind the
 * surface's `pendingInputBinding`.
 */
async function mountChain(
  life: TestLifecycle,
  home: string,
  options: MountOptions = {},
): Promise<ChainHarness> {
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const pane = installTspPane({
    composerActions: true,
    modelQuick: true,
    ...(options.modelPicker === false ? {} : { modelPicker: true }),
  })
  life.defer(() => pane.restore())
  const connected = await sdkConnect({ timeout: 500, exitHooks: false })
  assert.ok(connected !== null, 'the shipped SDK accepts the scripted pane')
  const session: Session = connected

  const hostFile = countingHostFilePort()
  const plugin = scriptedPluginChain()
  if (options.holdPluginAnswers === true) plugin.hold()
  const contributions = scriptedContributions()
  for (const name of options.contributions ?? [CONTRIBUTION_NAME]) contributions.add(name)
  const hostRows = options.hostRows ?? HOST_ROWS
  const registry = scriptedCommands(hostRows)
  const ctx = new Context()
  ctx.provide('commands', registry as never)
  ctx.provide('skills', { list: async () => [], get: async () => undefined } as never)

  let folder = new TranscriptFolder()
  const controllerWindow = new TranscriptWindowController({ windowTurns: 20, stepTurns: 10 })
  const source: SurfaceEventRoutingSource<SessionEvent> = {
    isCleanedUp: () => false,
    isAttachedSession: candidate => candidate.id === SESSION_ID,
    currentSessionId: () => SESSION_ID,
    hasLiveAgent: () => true,
    completionOwnerId: () => undefined,
    observeMainEvent: () => ({ refreshAgents: false }),
    appendOpeningViewerEvent: () => false,
    main: () => ({
      folder: { apply: (events: readonly SessionEvent[]) => folder.apply(events) },
      stats: { apply: () => {} },
      get window() { return controllerWindow },
      previews: new Map(),
      applyToolPreview: () => {},
      refreshRecentPerformanceAvailability: () => {},
    }),
    viewedChildId: () => undefined,
    viewedChild: () => { throw new Error('no viewer in this composition') },
    mainFolder: () => folder,
    viewedChildFolder: () => { throw new Error('no viewer in this composition') },
    pendingSubjectId: () => undefined,
    pendingSnapshot: () => undefined,
    submissionEchoes: () => undefined,
    queueTextOf: () => '',
    exitView: () => {},
    refreshStatusCheap: () => {},
    refreshStatusAndWelcome: () => {},
    refreshWorkspaceFacts: () => {},
    applyGoalChange: () => {},
    sessionTitleOf: () => undefined,
    extendLoadedHistory: () => false,
    settleLocalSubmitAck: () => {},
    markSubmitLatency: () => {},
    observeDurableSubmission: () => {},
    markContextDirty: () => {},
    refreshContextMeasurement: () => {},
    currentWorkingFromLog: () => false,
    flushTurn: () => {},
    registeredAgentIs: () => false,
    isCurrentOwnerAgent: () => false,
    viewedChildAgent: () => undefined,
    setViewedChildAgent: () => {},
    setViewedQueueAgent: () => {},
    agentForSession: () => undefined,
    applyViewedChildAssistantInput: () => { throw new Error('no viewer in this composition') },
    applyMainAssistantInput: input => folder.applyLiveInput(input),
  }

  const selects: string[] = []
  const surface = createSurfaceRuntime<SessionEvent>({
    tuiVersion: '0.0.0-test',
    notificationPresentation: nullPresentation,
    notificationMode: undefined,
    notificationMethod: undefined,
    mainProgressAuthority: 'local-events',
    terminalProgress: undefined,
    createPluginManagerPanel: createPluginManagerWorkspacePanel,
    permissionUi: {
      options: () => ['read-only', 'workspace-write', 'danger-full-access'],
      select: id => { selects.push(id) },
    },
    modelPickerAvailable: () => true,
    openModelPicker: () => {},
    openModelQuick: () => {
      // The registered /model command's quick presentation, opened through the
      // renderer's OWN late-bound entry: the request's presentation is a
      // stand-in, the menu and its key ownership are production.
      const presentation = mountedRenderer?.modelPresentation
      const openQuick = presentation?.openQuick
      assert.ok(openQuick, 'the pane negotiated the native Model quick presentation')
      openQuick({
        subject: { sessionless: false },
        entry: 'models',
        isCurrent: () => true,
        retry: () => {},
        apply: async () => ({ kind: 'applied' }) as unknown as ModelApplyOutcome,
        runOwned: (_label, task) => { void task() },
      } satisfies ModelPickerRequest)
    },
    openSessionBrowser: () => {},
    sessionBrowserAvailable: () => true,
  })
  surface.attachEventRouting(source)

  const submits: Array<{ text: string; request: string; token: number | undefined }> = []
  const writes: unknown[] = []
  let cancels = 0
  let controller!: ReturnType<typeof createSubmissionController<AgentLike>>
  let mountedRenderer: TspRenderer | undefined
  const rendererMount: SurfaceRendererMount = {
    mount: (binding, statusReader) => {
      mountedRenderer = mountTspRenderer(session, {
        copyVisual: async () => false,
        requestExit: () => {},
        onFatal: (error) => { throw new Error(`the mount routed a fatal: ${String(error)}`) },
      })
      mountedRenderer.bindStatusReader(statusReader)
      mountedRenderer.bindImages(binding)
      return mountedRenderer
    },
    releaseUnmounted: async () => { await mountedRenderer?.dispose() },
  }
  surface.start({
    events: {
      onSubmit: (text: string, request: ComposerSubmitRequest, scopeToken?: number) => {
        submits.push({ text, request: String(request), token: scopeToken })
        controller.submit(text, request, scopeToken)
      },
      onExit: () => {},
      onCancel: () => { cancels += 1 },
      shouldRememberInput: text => !draftHasAttachments(text, images, files),
    },
    renderer: rendererMount,
    workspaceRoot: home,
    iconStyle: 'emoji',
    displayState: { preset: 'compact' },
    historySearchSource: { search: () => Promise.reject(new Error('not exercised')) },
    readImage: () => Promise.reject(new Error('not exercised')),
    imageScope: () => undefined,
    present: { call: () => undefined, result: () => undefined },
    sessionCwd: () => home,
    captureHistoryScope: () => ({ sessionId: SESSION_ID, isCurrent: () => true }),
    onTerminalResize: () => {},
    copySelection: async () => false,
    deliveredFiles: { snapshot: () => undefined, isCurrent: () => false },
    openExternalUrl: () => {},
    readClipboardText: async () => undefined,
    imageFallbackColor: text => text,
  })
  surface.bindRendererInput()

  // The REAL submission controller, composed exactly as the I-A composition
  // test does: the application's onSubmit calls its PUBLIC entry with the live
  // third argument (the mount's occurrence token), and its writer sink is the
  // only counted business-prompt witness.
  const images = new DraftImageStore()
  const files = new DraftFileStore()
  const historyOwner = createInputHistory({
    surface: { get display() { return surface.display } },
    clientCwd: home,
    sessionCwd: () => home,
    diag: createDiag({ stderrLevel: 'off' }),
    isCleanedUp: () => false,
  })
  const agent: AgentLike = { status: 'idle', session: { id: SESSION_ID }, options: {}, cancel: () => {} }
  const core = createSessionOwnershipCore({ isSurfaceDisposed: () => false, resetForGeneration: () => {} })
  core.setCurrentOwner({} as never, SESSION_ID)
  let draft = ''
  const runtimeSurface: SubmissionRuntimeSurface = {
    withWriter: async (_scope, task) => task(),
    withPromptAdmission: async (_scope, _line, task) => task(),
    isDisposed: () => false,
    isScopeCurrent: () => true,
    mergeDraftIntoEditor: text => {
      draft = mergeDraft(draft, text)
      return draft === text
    },
    restoreStaleDraftIntoEditor: text => {
      draft = mergeDraft(draft, text)
      return draft === text ? 'merged-verbatim' : 'merged'
    },
    consumeDraftAttachments: () => {},
    markDispatch: () => {},
    beginLocalSubmission: () => {},
    settleLocalSubmission: () => {},
    settleSubmitAck: () => {},
    notify: () => {},
    refuseByTransitionFence: text => { draft = mergeDraft(draft, text) },
    prepareMessage: async (text, requestId) => preparePrompt(SESSION_ID, text, { images, files }, requestId),
    prompt: async (sessionId, message) => {
      writes.push({ sessionId, message })
      return { kind: 'committed', value: undefined }
    },
  }
  const submissionRuntime = bindSubmissionRuntime({ surface: runtimeSurface })
  const inert = new Proxy(function inert(): void {}, {
    get: (_target, key) => (key === 'then' ? undefined : inert),
    apply: () => undefined,
  })
  const deps: Record<string, unknown> = {
    app: () => surface.composer,
    diag: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} },
    signal: new AbortController().signal,
    isCleanedUp: () => false,
    logError: () => {},
    liveAgent: () => agent,
    ownership: {
      generation: () => core.generation(),
      captureSubject: () => core.subject(),
      transitionPending: () => false,
    },
    scope: {
      captureLive: () => ({ sessionId: SESSION_ID, subject: core.captureSubject()! } as never),
      isCurrent: () => true,
      requireLive: () => ({ sessionId: SESSION_ID, subject: core.captureSubject()! } as never),
    },
    session: {
      ensureSession: async () => {},
      beginCommandSettlement: () => {},
      abortCommandSettlement: () => {},
      settleCommandSettlement: () => {},
      trackSettlementWork: () => {},
    },
    submissionRuntime,
    command: {
      ...new Proxy({}, { get: () => () => false }),
      withCommandDelivery: <T,>(_delivery: unknown, run: () => T): T => run(),
      wasAdvertisedClaim: () => false,
      hostClaimOf: () => undefined,
      hostOriginClaimOf: () => undefined,
      hostCatalogResolves: () => false,
      clientClaimsLine: () => false,
      isSkillWrapperName: () => false,
      isSkillInvocation: () => false,
      takeCommandDraftDisposition: () => undefined,
      clientCommands: { get: () => undefined, execute: async () => undefined },
    },
    commandPlane: { available: () => false, execute: async () => undefined, findHandler: () => undefined },
    backendKind: 'remote',
    backend: inert,
    drafts: { images, files },
    status: { sessionCwd: () => home },
    surface: { refreshPendingInput: () => {} },
    history: {
      persist: (record: Parameters<typeof historyOwner.persist>[0]) => historyOwner.persist(record),
      persistAfterSession: async (
        resolveSession: () => Promise<string | undefined>,
        persist: (sessionId: string | undefined) => void,
      ) => { persist(await resolveSession()) },
    },
    viewer: { isViewing: () => false },
    extensions: {
      findContribution: () => undefined,
      handlerFor: () => undefined,
      commandIdFor: () => undefined,
      recordHealthRef: () => undefined,
      recordError: () => {},
      clearError: () => {},
    },
    artifacts: { start: () => {} },
    shell: { run: () => {}, interrupt: () => {} },
    supportsLocalShellCards: false,
    supportsTuiBuiltinUi: true,
    retainsStaleDraftRestore: true,
    model: { selected: { get current() { return undefined } } },
    image: { attachments: () => undefined, llm: () => undefined },
    tuiSettings: undefined,
    captureMatches: () => true,
    ownerWasReplaced: () => false,
    direct: { withPromptAdmission: async (_agent: unknown, _hasImages: boolean, task: () => Promise<unknown>) => task() },
    requestExit: () => {},
    isPlanActive: () => false,
    prepareTransport: async (text: string, requestId: string) => preparePrompt(SESSION_ID, text, { images, files }, requestId),
  }
  controller = createSubmissionController<AgentLike>(deps as unknown as SubmissionControllerDeps<AgentLike>)

  // The REAL runner the command layer registers into: a Direct-shaped fake Host
  // service, the REAL Client command registry and the REAL extension registries.
  // The presentation object is the SAME live-mount seam `createCommandSurface`
  // and `bootstrap` compose: catalog commits reach the CURRENT mount through
  // `surface.installTspCommandCompletions`, and the picker capability is read
  // live from the mounted presenters at each commit.
  const base: Record<string, unknown> = {
    ctx,
    app: undefined,
    diag: createDiag({ stderrLevel: 'off' }),
    currentSessionId: undefined,
    cwd: home,
    sessionCwd: () => home,
    signal: new AbortController().signal,
    commandRegistry: registry as never,
    clientCommands: createClientCommandRegistry(parseCommand),
    hostShellCompletion: false,
    transcriptExportAvailable: false,
    imageStore: images,
    fileStore: files,
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: () => {},
    prepareDraftMessage: async (text: string) => ({ role: 'user', content: [{ type: 'text', text }] }),
    requestExit: () => {},
    beginClientWrite: () => () => {},
    deliveredFilesSnapshot: () => undefined,
    exit: () => {},
    ensureSession: async () => {},
    listScopedCommands: () => [],
    hostFile: hostFile.port,
    extensions: {
      commands: contributions.bridge,
      autocomplete: plugin,
      health: () => [],
    },
  }
  const runner = new Proxy(base, {
    get: (target, key) => (key in target ? target[key as string] : inert),
  }) as unknown as TuiCommandRunner

  const capabilities = (): TspBuiltinPickers => ({
    modelPicker: surface.modelPresentation !== undefined,
    presetPicker: surface.presetPresentation !== undefined,
    sessionBrowser: surface.sessionBrowserPresentation !== undefined,
    taskCenter: surface.display.supportsTaskCenter,
  })
  const commands = registerTuiCommands(
    runner,
    { skills: { skills: [...SKILL_ROWS], complete: true } },
    { listGlobalCommands: () => listGlobalCommands(registry as never).map(commandSummaryOf) },
    undefined,
    undefined,
    {
      notify: () => {},
      titleRefusalNoticeOwner: 'result-card',
      titleSuccessNoticeVisible: false,
      composer: () => surface.composer,
      installTspCommandCompletions: (installation: TspCommandCompletionInstallation) => {
        surface.installTspCommandCompletions(installation)
      },
      tspCommandPickerCapabilities: capabilities,
    },
  )

  // The formal status fact that admits the Quiet Composer's Permission menu, and
  // the late-bound Model quick entry the real composition installs after the
  // command registration. Both are needed so case E can open the real owners.
  // The surface's OWN status store is the reader the mount was bound with:
  // committing the permission fact through the application seam is what makes
  // the Quiet Composer's real Permission menu operable (no second binding).
  surface.commitStatus(
    { access: { permissionPreset: { id: 'workspace-write', label: 'Workspace Write', matched: true } } } as never,
    {},
    undefined,
  )
  surface.display.commitDisplaySubject({}, {}, undefined)
  await waitUntil('the first frame carried the controlled composer', () =>
    wireNodes(pane).some(node => node.id === EDITOR_ID))

  const renderer = (): TspRenderer => {
    assert.ok(mountedRenderer, 'the TSP renderer committed its mount')
    return mountedRenderer
  }
  const harness: ChainHarness = {
    surface,
    pane,
    session,
    renderer,
    commands,
    contributions,
    addContribution: (name) => contributions.add(name),
    plugin,
    hostFileCalls: hostFile.calls,
    submits,
    writes,
    selects,
    cancels: () => cancels,
    commitCatalog: () => commands.refreshCommandCompletions(),
    editor: () => editorWire(pane),
    rows: () => popupRows(pane),
    values: () => popupValues(pane),
    async press(bytes) {
      const mark = pane.frameCount()
      const before = editorWire(pane)
      pane.key(bytes)
      // The SDK delivers a key asynchronously. A key that edits the draft
      // commits a controlled-editor frame; a candidate query commits its own
      // frame; a key with NO visual effect (a Tab that only re-queries the
      // SAME list) commits no frame at all. Either paint ends the wait.
      await waitUntil(`the ${JSON.stringify(bytes)} key was delivered`, () =>
        pane.frameCount() > mark || editorWire(pane).text !== before.text
          || editorWire(pane).cursor !== before.cursor || h_rows_changed(pane, mark))
    },
    /** A raw key with NO frame wait (a trigger whose only sink is the popup). */
    async triggerQuietly(bytes) {
      pane.key(bytes)
      // reason: bounded SDK-key delivery window — the trigger's authoritative
      // sink is the candidate list the caller waits for next.
      await new Promise(resolve => setTimeout(resolve, ABSENCE_WINDOW_MS))
    },
    async pressQuietly(bytes) {
      pane.key(bytes)
      // reason: bounded negative-observation window — the SDK's async input
      // loop is the single producer of a routed key; a correctly ignored
      // gesture has no positive sink to await.
      await new Promise(resolve => setTimeout(resolve, ABSENCE_WINDOW_MS))
    },
    async setDraft(text) {
      surface.composer.setDraft(text)
      await waitUntil('the composer wire carries the program-owned draft', () => editorWire(pane).text === text)
    },
    async clickRow(row) {
      pane.event({ ev: 'action', sf: pane.frames().at(-1)!.sf, id: row.id, act: 'click' })
      // reason: bounded click-settlement window — the frame a refused click
      // would not produce has no positive sink to await.
      await new Promise(resolve => setTimeout(resolve, ABSENCE_WINDOW_MS))
    },
    async waitNoRowPaint(sinceFrame, label) {
      // reason: bounded absence window — every settlement the seat would have
      // painted writes a frame; a correctly dropped answer writes none.
      await new Promise(resolve => setTimeout(resolve, ABSENCE_WINDOW_MS))
      assert.equal(popupPaintedSince(pane, sinceFrame), false, label)
      assert.equal(harness.rows().length, 0, `${label}: the live wire carries no candidate rows`)
    },
    frameCount: () => pane.frameCount(),
    dispose: async () => {
      plugin.releaseAll()
      await surface.dispose()
      await session.close()
    },
  }
  life.defer(() => harness.dispose())
  return harness
}

interface AgentLike {
  status: string
  readonly session: { readonly id: string }
  readonly options: Record<string, unknown>
  cancel(): void
}

// ── A. Catalog provenance through the REAL registerTuiCommands ───────────────

test('a provenance-screened catalog keeps Host, skill and extension rows, drops unsupported TUI rows, and gates /model on the mounted picker -> the rendered popup rows', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-ic-provenance-')
  const h = await mountChain(life, home)
  // TSP I-C: the genuine Host-origin winner is never screened by the
  // TUI-builtin gate, even under a name the mounted renderer cannot run.
  assert.deepEqual(h.commands.hostClaimOf({ name: 'settings' }), { claimed: true, attachments: false },
    'the Host claims still route /settings through the advertised union')
  assert.deepEqual(h.commands.hostOriginClaimOf({ name: 'settings' }), { claimed: true, attachments: false },
    'the genuine Host-origin authority still owns the same name')
  assert.equal(h.commands.isSkillWrapper('glab'), true, 'the live dynamic skill wrapper is really installed')

  const shown = await visibleCatalog(h)
  assert.ok(shown.includes('settings'), `the genuine Host-origin row survives the screen: ${shown.join(', ')}`)
  assert.ok(shown.includes('glab'), `the live skill wrapper survives the screen: ${shown.join(', ')}`)
  assert.ok(shown.includes(CONTRIBUTION_NAME), `the extension contribution survives the screen: ${shown.join(', ')}`)
  assert.ok(shown.includes('model'), `a mounted Model presenter keeps /model: ${shown.join(', ')}`)
  for (const unsupported of ['help', 'rewind', 'login', 'logout']) {
    assert.equal(shown.includes(unsupported), false, `/${unsupported} is not offered in the full catalog scan`)
    // A name-typed query is the DIRECT witness: had the screen kept that TUI
    // Client registration, the provider would have returned exactly it.
    await h.surface.composer.setDraft(`/${unsupported}`)
    await waitUntil(`the /${unsupported} query reached the wire`, () => h.editor().text === `/${unsupported}`)
    await h.triggerQuietly(TAB)
    assert.equal(h.values().includes(unsupported), false,
      `the mounted renderer cannot run /${unsupported}, so the provenance screen dropped that row`)
    assert.deepEqual(h.submits, [], `the /${unsupported} query never submitted`)
  }
  await h.surface.composer.setDraft('/')
  await waitUntil('the catalog query returned to /', () => h.editor().text === '/')
  assert.deepEqual(h.editor(), { text: '/', cursor: 1 }, 'typing / only queried the catalog; it never edited a row')
  assert.equal(h.submits.length, 0, 'catalog completion never submits')

  // The SAME live capability read the command layer samples per commit: false
  // removes /model, and the genuine Host-origin row still survives. Overriding
  // the SURFACE's own getter is the real fact `bootstrap` reads; no renderer
  // internals are replaced and no second catalog is installed.
  Object.defineProperty(h.surface, 'modelPresentation', { configurable: true, get: () => undefined })
  h.commitCatalog()
  const after = await visibleCatalog(h)
  assert.equal(after.includes('model'), false, 'without the mounted presenter /model leaves the menu')
  assert.ok(after.includes('settings'), 'the genuine Host-origin row is never gated by the picker')
  assert.ok(after.includes('glab'), 'the live skill wrapper is never gated by the picker')
  assert.ok(after.includes(CONTRIBUTION_NAME), 'the extension contribution is never gated by the picker')
  assert.equal(h.commands.hostClaimOf({ name: 'settings' })?.claimed, true,
    'the advertised Host claim survived the recommit')
  assert.equal(h.commands.hostOriginClaimOf({ name: 'settings' })?.claimed, true,
    'the genuine Host-origin claim survived the recommit')
})

/**
 * Re-open the popup and walk the REAL candidate list through its own Tab /
 * Shift+Tab gestures, so a catalog of more than six rows is observed in full.
 * The first highlighted row is recorded once per position; the walk is bounded
 * by the number of rows the wire can show, never an open-ended loop.
 */
async function visibleCatalog(h: ChainHarness): Promise<string[]> {
  const seen = new Set<string>()
  // A fresh query starts on the empty first line. Program-owned draft writes
  // commit their own frame but deliberately run no completion trigger.
  h.surface.composer.setDraft('')
  await waitUntil('the composer is clear for the catalog observation', () => h.editor().text === '')
  await h.press('/')
  await waitUntil('the first candidate window painted', () => h.values().length > 0)
  const total = 64 // bounded: the scripted catalog is smaller than this window
  for (let step = 0; step < total; step += 1) {
    for (const value of h.values()) seen.add(value)
    const highlighted = h.rows().find(row => row.highlighted)
    if (highlighted === undefined) break
    const before = highlighted.id
    await h.press(TAB)
    const after = h.rows().find(row => row.highlighted)
    if (after?.id === before || after === undefined) break
    if (after.id === h.rows()[0]?.id) {
      for (const value of h.values()) seen.add(value)
      break // wrapped back to the first row: the whole window was visited
    }
  }
  return [...seen]
}

test('a failed source synthesis installs an empty candidate set while the Host claims still route -> Tab paints no popup and the claims still resolve', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-ic-collision-')
  const h = await mountChain(life, home)
  // `display:'none'` is the command layer's FAILED-SOURCE state: a fresh
  // contribution colliding with the Host catalog fails the synthesis at the
  // SAME single commit point that forwards the catalog to the mount.
  h.addContribution('alpha')
  h.commitCatalog()
  assert.deepEqual(h.commands.hostClaimOf({ name: 'alpha' }), { claimed: true, attachments: false },
    'the Host still claims the bare /alpha line')
  assert.deepEqual(h.commands.hostOriginClaimOf({ name: 'alpha' }), { claimed: true, attachments: false },
    'the genuine Host-origin authority still resolves the name')
  assert.deepEqual(h.commands.hostClaimOf({ name: 'settings' }), { claimed: true, attachments: false },
    'the genuine Host settings claim is never withdrawn by the failed display')
  assert.deepEqual(h.commands.hostOriginClaimOf({ name: 'settings' }), { claimed: true, attachments: false },
    'the routing authority still owns /settings')
  assert.equal(h.commands.wasAdvertised('alpha'), true, 'the advertised claim survives the empty display')
  assert.equal(h.commands.isSkillWrapper('glab'), true, 'the live skill wrapper still exists')

  const since = h.frameCount()
  await h.press('/')
  await h.waitNoRowPaint(since, 'the empty display list offers no candidate row')
  await h.pressQuietly(TAB)
  assert.equal(h.values().length, 0, 'Tab cannot open a shell of a menu against the empty source')
  assert.deepEqual(h.editor(), { text: '/', cursor: 1 }, 'the failed source never wrote a candidate into the draft')
  assert.equal(h.submits.length, 0, 'the failed source never submitted')
})

// ── B. Accept never executes ─────────────────────────────────────────────────

test('Tab then Enter accepts /new into the composer -> the wire shows /new␠ with zero submissions, and the next Enter submits that line once', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-ic-accept-')
  const h = await mountChain(life, home)
  await typeKeys(h, '/ne')
  await waitUntil('the natural query painted', () => h.values().length > 0)
  // Escape closes only the list; the draft stays exactly what the user typed.
  await h.press(ESCAPE)
  assert.deepEqual(h.values(), [], 'Escape closed the candidate list')
  assert.deepEqual(h.editor(), { text: '/ne', cursor: 3 }, 'the dismissal edited nothing')
  assert.equal(h.submits.length, 0, 'the dismissal ran no cancel and no submit')
  // Tab is now the seat's OWN trigger: the fresh list highlights /new.
  await h.triggerQuietly(TAB)
  assert.deepEqual(h.values()[0], 'new', 'the Tab trigger re-opened the list on /new')
  // A plain Enter accepts the highlighted row. It only ever EDITS the composer.
  await h.press(ENTER)
  await waitUntil('the accept reached the composer wire', () => h.editor().text === '/new ')
  assert.deepEqual(h.editor(), { text: '/new ', cursor: 5 },
    'the accept wrote the command name plus the provider separator with the caret after it (UTF-16)')
  assert.deepEqual(h.values(), [], 'the accepted frame carries no stale popup')
  assert.equal(h.submits.length, 0, 'accepting a candidate recorded ZERO application submissions')
  assert.equal(h.writes.length, 0, 'the real controller wrote ZERO business prompts')

  // The LATER plain Enter is the only gesture that reaches the existing
  // submission path (the same live third argument / scopeToken chain I-A uses).
  await h.press(ENTER)
  await waitUntil('the application submit entry recorded the submission', () => h.submits.length === 1)
  assert.deepEqual(h.submits.map(entry => entry.text), ['/new '],
    'exactly ONE submission of the resulting composer line')
  assert.equal(typeof h.submits[0]!.token, 'number',
    'the application submit entry carried the mount\'s live scope token into the real controller')
  assert.equal(h.submits[0]!.request, 'enter', 'the gesture stayed the plain Enter the composer reports')
  assert.deepEqual(h.editor(), { text: '/new ', cursor: 5 },
    'the second Enter submitted the resulting line without a second draft edit')
})

/** Type one draft through REAL decoded SDK keys: each character is its own
 *  committed composer edit, never a program-owned draft replacement. */
async function typeKeys(h: ChainHarness, text: string): Promise<void> {
  for (const char of text) await h.press(char)
}

// ── C. Every catalog commit replaces the source ──────────────────────────────

test('a catalog commit that withdraws a command removes its row from the wire -> the stale row cannot be clicked or accepted', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-ic-replace-')
  const h = await mountChain(life, home)
  await typeKeys(h, '/g')
  await waitUntil('the L1 candidate painted', () => h.values().includes('glab'))
  const stale = h.rows().find(row => row.value === 'glab')
  assert.ok(stale, 'the live skill wrapper row is on the wire before the recommit')

  // L2: the REAL single commit point re-synthesises the catalog WITHOUT the
  // skill wrapper (a genuine Host same-name winner blocks its registration).
  const l2: readonly HostRow[] = [
    { name: 'alpha', description: 'Host alpha command' },
    { name: 'settings', description: 'Host settings panel', definitionId: '@host/genuine/settings' },
    { name: 'glab', description: 'the genuine Host glab', definitionId: '@host/genuine/glab' },
  ]
  // Drive the same `installSnapshot` commit the coordinator owns: the Host
  // authority changes, the wrapper is retired and the catalog is reinstalled.
  h.commands.installSnapshot(Object.freeze({
    commands: Object.freeze(l2.map(row => Object.freeze({ ...row }))),
    scopedCommands: Object.freeze([]),
    skills: Object.freeze([]),
    issues: Object.freeze([]),
  }))
  await waitUntil('the new catalog withdrew the old row', () => !h.values().includes('glab'))
  assert.equal(h.commands.isSkillWrapper('glab'), false, 'the live wrapper was really retired by the recommit')
  assert.equal(h.commands.hostOriginClaimOf({ name: 'glab' })?.claimed, true,
    'the same name is now the genuine Host winner, never the withdrawn wrapper')

  // The stale painted row's own identity cannot write into the composer.
  await h.clickRow(stale)
  assert.deepEqual(h.editor(), { text: '/g', cursor: 2 }, 'the withdrawn row cannot be accepted by click')
  assert.equal(h.submits.length, 0, 'the withdrawn row cannot submit')
  // A plain Enter with the new (empty) source belongs to the Composer again:
  // its ordinary draft text can still be submitted, but never a withdrawn row.
  await h.press(ENTER)
  assert.deepEqual(h.submits.map(entry => entry.text), ['/g'],
    'the key submitted the LIVE draft text, never the withdrawn candidate')
  assert.ok(!h.editor().text.includes('/glab'),
    'the withdrawn command was never written into the composer')
})

// ── D. Late/async currentness ────────────────────────────────────────────────

test('a slow extension answer arriving after the user typed on paints no popup, writes no draft and submits nothing -> the wire stays on the typed query', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-ic-late-typed-')
  const h = await mountChain(life, home, { holdPluginAnswers: true })
  // An unknown token is the honest plugin-fallback path: the REAL host
  // provider answers null and the command layer's extensionSuggest wrapper
  // asks the REAL plugin registry, whose answer is scripted to be late.
  await typeKeys(h, '/zz')
  await waitUntil('the plugin chain was really asked', () => h.plugin.asked() > 0)
  const before = h.frameCount()
  await h.press('q')
  await waitUntil('the typed-on document reached the wire', () => h.editor().text === '/zzq')
  h.plugin.release(0, [{ value: 'stale', label: 'stale' }])
  await h.waitNoRowPaint(before, 'a superseded plugin answer never paints')
  assert.deepEqual(h.editor(), { text: '/zzq', cursor: 4 }, 'the late answer never wrote a candidate into the draft')
  assert.equal(h.submits.length, 0, 'the late answer never submitted')
  assert.equal(h.hostFileCalls(), 0, 'the late path never touched the Host-file port')
})

test('a slow extension answer arriving after a new display subject commits paints no popup, writes no draft and submits nothing -> the wire carries the committed subject', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-ic-late-subject-')
  const h = await mountChain(life, home, { holdPluginAnswers: true })
  await typeKeys(h, '/zz')
  await waitUntil('the plugin chain was really asked', () => h.plugin.asked() > 0)
  const before = h.frameCount()
  // The application's OWN formal display commit (a new projection source).
  const subject = {}
  h.surface.display.setTranscript([], undefined, undefined, undefined, undefined, subject)
  h.plugin.release(0, [{ value: 'stale', label: 'stale' }])
  await h.waitNoRowPaint(before, 'a plugin answer from the outgoing subject never paints')
  assert.deepEqual(h.editor(), { text: '/zz', cursor: 3 }, 'the late answer never wrote a draft')
  assert.equal(h.submits.length, 0, 'the late answer never submitted')
  assert.equal(h.hostFileCalls(), 0, 'no file discovery ran for the late answer')
})

test('a slow extension answer arriving after a scope begin paints no popup, writes no draft and submits nothing -> the wire keeps the original query', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-ic-late-scope-')
  const h = await mountChain(life, home, { holdPluginAnswers: true })
  await typeKeys(h, '/zz')
  await waitUntil('the plugin chain was really asked', () => h.plugin.asked() > 0)
  const before = h.frameCount()
  h.renderer().display.beginInputHistoryScope('B')
  h.plugin.release(0, [{ value: 'stale', label: 'stale' }])
  await h.waitNoRowPaint(before, 'a plugin answer from the retired scope never paints')
  assert.deepEqual(h.editor(), { text: '/zz', cursor: 3 }, 'the late answer never wrote a draft')
  assert.equal(h.submits.length, 0, 'the late answer never submitted')
  assert.equal(h.hostFileCalls(), 0, 'no file discovery ran for the late answer')
})

// ── E. Seat priority ─────────────────────────────────────────────────────────

test('a Modal or Permission menu owning the keys keeps arrows and Enter from the hidden composer popup -> no candidate is consumed or painted, and keys work again after the owner closes', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-ic-priority-')
  const h = await mountChain(life, home)
  await typeKeys(h, '/n')
  await waitUntil('the composer popup is open before the modal', () => h.values().length > 0)
  const before = h.editor()
  // A REAL Question through the mount's own interaction presenter: the modal
  // seat is above the composer's completion seat in dispatchKey's fixed ladder.
  const promise = h.renderer().interaction.askQuestions(
    [{ id: 'q1', question: 'Pick one?', options: [{ label: 'first' }, { label: 'second' }] }],
    undefined,
    undefined,
    false,
  )
  promise.catch(() => {})
  await waitUntil('the real Question owns a modal wire layer', () =>
    wireNodes(h.pane).some(node => /^layer\.modal-\d+$/.test(node.id)))
  assert.equal(h.rows().length, 0, 'the hidden popup is withdrawn at the modal paint')
  const modalFrame = h.frameCount()
  await h.pressQuietly(DOWN)
  await h.pressQuietly(ENTER)
  assert.equal(h.rows().length, 0, 'the hidden popup was never painted or consumed under the modal')
  assert.deepEqual(h.editor(), before, 'the modal Arrow/Enter never edited the hidden composer draft')
  assert.equal(h.submits.length, 0, 'the modal Arrow/Enter never submitted the hidden draft')
  assert.ok(h.frameCount() >= modalFrame, 'the modal stayed the visible owner on the wire')
  // Close through the modal's OWN Escape route; keys then return to the composer.
  await h.pressQuietly(ESCAPE)
  await waitUntil('the modal seat closed', () =>
    !wireNodes(h.pane).some(node => /^layer\.modal-\d+$/.test(node.id)))
  await typeKeys(h, 'e')
  await waitUntil('a fresh composer query painted after the modal closed', () => h.values().length > 0)
  assert.deepEqual(h.editor(), { text: '/ne', cursor: 3 }, 'the composer keys work again after the modal')
  assert.equal(h.submits.length, 0, 'the reopened seat still never submits on its own')

  // The REAL Quiet Composer Permission menu: its trigger is the wire's own
  // node, and Arrow/Enter belong to the menu while it is expanded.
  const trigger = wireNodes(h.pane).find(node => node.k === 'el'
    && node.id.includes('.composer-permission-s') && !node.id.includes('option'))
  assert.ok(trigger, 'the Permission trigger is on the wire')
  h.pane.event({ ev: 'action', sf: h.pane.frames().at(-1)!.sf, id: trigger.id, act: 'click' })
  await waitUntil('the Permission menu owns its options on the wire', () =>
    wireNodes(h.pane).filter(node => node.k === 'el' && node.id.includes('.composer-permission-option-')).length === 3)
  assert.equal(h.rows().length, 0, 'the hidden composer popup was withdrawn under the Permission menu')
  const optionsBefore = wireNodes(h.pane).filter(node => node.id.includes('.composer-permission-option-'))
    .map(node => (node.p.attrs as Record<string, unknown> | undefined)?.['data-highlight'] === 'true')
  await h.press(DOWN)
  const optionsAfter = wireNodes(h.pane).filter(node => node.id.includes('.composer-permission-option-'))
    .map(node => (node.p.attrs as Record<string, unknown> | undefined)?.['data-highlight'] === 'true')
  assert.notDeepEqual(optionsAfter, optionsBefore, 'the Arrow moved the MENU highlight, not a candidate row')
  assert.equal(h.rows().length, 0, 'the hidden composer popup was not painted under the Permission menu')
  assert.deepEqual(h.editor(), { text: '/ne', cursor: 3 }, 'the menu Arrow never edited the draft')
  assert.equal(h.submits.length, 0, 'the menu Arrow never submitted')
  await h.press(ESCAPE)
  assert.equal(h.cancels(), 0, 'the menu Escape closed only the menu, it never became a cancel intent')
  // The REAL Model Quick menu: the combined Model/Effort trigger opens it
  // through the surface's late-bound /model command entry. Its arrows and
  // Enter belong to that higher presenter, never to the hidden popup.
  const modelTrigger = wireNodes(h.pane).find(node => node.k === 'el'
    && node.id.includes('.composer-model-quick') && !node.id.includes('menu'))
  assert.ok(modelTrigger, 'the Model Quick trigger is on the wire')
  h.pane.event({ ev: 'action', sf: h.pane.frames().at(-1)!.sf, id: modelTrigger.id, act: 'click' })
  await waitUntil('the Model Quick menu mounted on the wire', () =>
    wireNodes(h.pane).some(node => node.id.includes('.composer-quick-menu-')))
  assert.equal(h.rows().length, 0, 'the hidden composer popup was withdrawn under the Model Quick menu')
  const quickFrame = h.frameCount()
  await h.pressQuietly(DOWN)
  await h.pressQuietly(ENTER)
  assert.equal(h.rows().length, 0, 'the Model Quick menu owned the keys without painting a candidate list')
  assert.deepEqual(h.editor(), { text: '/ne', cursor: 3 }, 'the Model Quick gestures never edited the draft')
  assert.equal(h.submits.length, 0, 'the Model Quick gestures never submitted')
  assert.ok(h.frameCount() >= quickFrame, 'the Model Quick menu remained the visible owner')
  // Its own Escape closes it; then the composer's keys work again.
  await h.pressQuietly(ESCAPE)
  await waitUntil('the Model Quick menu closed', () =>
    !wireNodes(h.pane).some(node => node.id.includes('.composer-quick-menu-')))
  await h.press(ENTER)
  await waitUntil('a fresh composer key submitted after the Model Quick menu', () => h.submits.length === 1)
  assert.deepEqual(h.submits.map(entry => entry.text), ['/ne'],
    'the composer keys work again after the Model Quick menu: a plain Enter submits the live draft')
  assert.equal(h.rows().length, 0, 'the key never painted a hidden candidate list')
})


// ── F. Session switch A -> B -> A ────────────────────────────────────────────

test('an open popup at A is withdrawn when B publishes and needs a fresh query after returning to A -> the stale row never reaches B or A', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-ic-switch-')
  const h = await mountChain(life, home)
  // A's REAL formal history/recall scope: the I-B composition's publication seam.
  h.surface.display.beginInputHistoryScope('A')
  h.surface.display.resetInputHistory(['newest A row', 'older A row'], 'A')
  await typeKeys(h, '/n')
  await waitUntil('A\'s candidate list painted', () => h.values().length > 0)
  const stale = h.rows().find(row => row.value === 'new')
  assert.ok(stale, 'A\'s /new row is on the wire')
  // B publishes through the SAME seam; the list belongs to A's scope only.
  // `beginInputHistoryScope` is a pure-state commit, so a real decoded key
  // drives the frame that withdraws A's painted rows.
  h.surface.display.beginInputHistoryScope('B')
  await h.press('x')
  await waitUntil('B withdrew A\'s candidate list', () => h.values().length === 0)
  assert.deepEqual(h.editor(), { text: '/nx', cursor: 3 }, 'the publication edited no draft; the probe key did')
  await h.clickRow(stale)
  assert.deepEqual(h.editor(), { text: '/nx', cursor: 3 }, 'A\'s stale row cannot be accepted into B')
  assert.equal(h.submits.length, 0, 'A\'s stale row cannot submit into B')
  // Back to A: no list is resurrected from the retired scope.
  h.surface.display.beginInputHistoryScope('A')
  assert.deepEqual(h.values(), [], 'returning to A shows no stale popup')
  await h.pressQuietly(HOME)
  assert.deepEqual(h.editor(), { text: '/nx', cursor: 0 },
    'the retired completion list consumed no arrow; the caret moved to the line start')
  assert.equal(h.submits.length, 0, 'the recall arrow submitted nothing')
  // A fresh Edit is required before candidates paint again: the natural
  // trigger runs off the composer's OWN committed edit, never off a scope seam.
  await h.surface.composer.setDraft('')
  await waitUntil('the program-owned clear reached the wire', () => h.editor().text === '')
  await typeKeys(h, '/n')
  await waitUntil('a fresh query painted A\'s new list', () => h.values().length > 0)
  assert.deepEqual(h.editor(), { text: '/n', cursor: 2 }, 'only the fresh query rebuilt the seat')
})

// ── G. I-B coexistence ───────────────────────────────────────────────────────

test('with the popup closed unmodified arrows recall newest-first and restore the original draft -> with it open they walk candidates and leave the recall kernel unchanged', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-ic-coexistence-')
  const h = await mountChain(life, home)
  h.surface.display.beginInputHistoryScope(SESSION_ID)
  h.surface.display.resetInputHistory(['newest row', 'oldest row'], SESSION_ID)
  await typeKeys(h, '/n')
  await waitUntil('the candidate list is open', () => h.values().length > 0)
  const factsBefore = h.renderer().scopeFactCountForTest()
  const reconcileBefore = h.renderer().reconcileStepsForTest()
  const highlightedBefore = h.rows().find(row => row.highlighted)?.id
  await h.press(UP)
  assert.deepEqual(h.editor(), { text: '/n', cursor: 2 },
    'with the popup open, Up walked a candidate and never recalled history')
  assert.notEqual(h.rows().find(row => row.highlighted)?.id, highlightedBefore,
    'the candidate highlight really moved')
  assert.equal(h.renderer().scopeFactCountForTest(), factsBefore,
    'the recall kernel settled no new scope fact while the list owned the arrow')
  assert.equal(h.renderer().reconcileStepsForTest(), reconcileBefore,
    'the recall snapshot did not reseed/reconcile while the list owned the arrow')
  assert.equal(h.submits.length, 0, 'a candidate arrow submitted nothing')
  await h.press(ESCAPE)
  assert.deepEqual(h.values(), [], 'Escape closed only the candidate list')
  // Popup CLOSED: the I-B recall is the owner again. A first Up moves the caret
  // to the line start, the second Up recalls the newest row, Down from index 0
  // restores the original draft exactly as the I-B composition proves.
  await h.press(UP)
  assert.deepEqual(h.editor(), { text: '/n', cursor: 0 }, 'the first Up is the I-B line Home step')
  await h.press(UP)
  assert.deepEqual(h.editor(), { text: 'newest row', cursor: 0 }, 'unmodified Up recalls the newest row')
  await h.press(UP)
  assert.equal(h.editor().text, 'oldest row', 'a second Up recalls the older row')
  assert.equal(h.renderer().scopeFactCountForTest(), factsBefore,
    'browsing the recall snapshot still added no new scope fact')
  await h.press(DOWN)
  assert.equal(h.editor().text, 'newest row', 'Down walks back toward index 0')
  await h.press(DOWN)
  assert.deepEqual(h.editor(), { text: '/n', cursor: 2 },
    'Down from index 0 restored the original draft and caret')
  assert.equal(h.submits.length, 0, 'no recall arrow submitted')
})

// ── H. No file, argument or shell seat ───────────────────────────────────────

test('an argument position, an at-mention, a second-line command, shell lines and an absolute path paint no candidate popup -> no HostFilePort method is ever called', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-ic-no-file-seat-')
  const h = await mountChain(life, home)
  for (const draft of ['/attach ', '@', `first${SHIFT_ENTER}/name`, '!', '!!', '/usr/bin']) {
    // Program-owned draft writes commit their own controlled-editor frame but
    // run NO natural completion query; one real decoded key then probes the
    // seat against that exact document.
    await h.setDraft(draft)
    const since = h.frameCount()
    await h.press('!')
    assert.equal(h.rows().length, 0, `${JSON.stringify(draft)} paints no candidate popup`)
    assert.equal(popupPaintedSince(h.pane, since), false,
      `${JSON.stringify(draft)} never painted a candidate list in any frame`)
    assert.equal(h.submits.length, 0, `${JSON.stringify(draft)} submitted nothing`)
    assert.equal(h.hostFileCalls(), 0, `${JSON.stringify(draft)} never reached the Host-file port`)
  }
  assert.equal(h.hostFileCalls(), 0, 'no HostFilePort method was called for any of these documents')
  // I-C opens no Client-local path seat: the mount passes `localFdPath: null`
  // to the shared factory, so no `fd` executable is ever resolved or spawned.
  // The counting port plus the seat's own null fallback are the witness.
  assert.equal(h.values().length, 0, 'the final frame carries no candidate rows at all')
  assert.equal(h.hostFileCalls(), 0,
    'no file, argument, shell or absolute-path document opened a Host-file discovery')
})
