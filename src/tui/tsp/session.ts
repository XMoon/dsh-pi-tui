/**
 * The experimental Tern TSP renderer session (PR3-A + PR3-B B1): the ONE
 * physical-tty owner when the composition root selects the TSP renderer, and
 * the display seam implementation that turns application display facts into
 * official SDK nodes.
 *
 * Ownership contract (plan PR3-A §3.1, PR3-B §3.4):
 *
 * - `connectTspRenderer()` runs the official `connect()` BEFORE PiTui could
 *   take stdin. `null` means the environment has no TSP (the composition root
 *   then mounts PiTui unchanged); a THROW is a startup failure on the
 *   runner's fatal path — never a fallback, never swallowed. Once the SDK
 *   session exists it is an OWNED resource: a mount failure closes it before
 *   re-raising (no leaked raw-mode stdin listener).
 * - The returned mount owns the SDK session for the whole process lifetime:
 *   ONE `inline` surface whose `main` region carries the live transcript and
 *   whose `dock` region carries the banner, status facts, notices, the
 *   pending-input presentation and the CONTROLLED composer (`ui.editor`,
 *   program-owned text/cursor; native edit/undo/send are NOT advertised).
 *   No `process.stdin.on`/`setRawMode` of our own — the SDK session owns the
 *   tty (its own exit hooks restore it on process exit/signals).
 * - The input loop consumes `for await (const input of session)` — the ONE
 *   input path. Ctrl+C (and Ctrl+D on an empty draft) routes through the
 *   injected `requestExit` — the SAME exit orchestration as `/exit`; a typed
 *   `q` is editor text (the PR3-A read-only `q` quit retired with the
 *   composer). Submit gestures (Enter / Ctrl+Enter) are refused with an
 *   explicit notice until B2 binds the real application onSubmit. A LOOP
 *   FAILURE (the tty owner died) routes through the injected `onFatal` — the
 *   runner's fatal lifecycle — never a normal exit code.
 * - `dispose()` closes the surface (`keep: false`) and then the session,
 *   exactly once; the returned promise settles only after the SDK restored
 *   the tty (its 50 ms input drain), so the exit/fatal/HMR orchestration can
 *   AWAIT it before writing the resume hint or starting the next renderer.
 *
 * This module is reachable ONLY through the composition root's explicit
 * `DSH_PI_TUI_RENDERER=tsp` opt-in (a lazy dynamic import); the default
 * product path never loads it.
 * @module @xmoon76/dsh-pi-tui/tui/tsp/session
 */

import { connect as sdkConnect, ui } from '@stencil-hq/tern'
import type { Key, Node, Session, SessionInput, Surface } from '@stencil-hq/tern'
import type { ComposerSubmitRequest } from '../../tui-app.ts'
import type {
  DisplayDockNotice,
  DisplayStatusFacts,
  DisplayWelcomeFacts,
  SurfaceDisplaySeam,
} from '../../app/surface/display-seam.ts'
import type { SubmissionComposerPort } from '../../app/submission/composer-port.ts'
import type { SubmitPendingDetail } from '../../app/submission/ack.ts'
import type { SettledQuestionAnswersLookup, SurfaceInteractionPresenter } from '../../app/surface/interaction-presenter.ts'
import type { SurfaceImageBinding } from '../../app/surface/runtime.ts'
import type { ImageAttachmentRefLike } from '../../domain/media/types.ts'
import { TSP_CONTINUED_INSPECTION_LABEL } from '../keybindings/hints.ts'
import { createTspComposer, type TspComposer, type TspComposerEdit } from './editor.ts'
import { sanitizeDisplayText } from '../presentation/terminal-text.ts'
import { createTspInteractionSeat, type TspContinuedRow, type TspInteractionSeat } from './interaction.ts'
import { TspModelPicker } from './model-picker.ts'
import { TspPresetPicker } from './preset-picker.ts'
import { TspSessionBrowser } from './session-browser.ts'
import { TspWorkHub } from './work-hub.ts'
import type { ModelPresentation } from '../../app/command/model-presentation.ts'
import type { PresetPresentation } from '../../app/command/preset-presentation.ts'
import type { SessionBrowserPresentation } from '../../app/command/session-browser-presentation.ts'
import type { TaskCenterPresentationPort } from '../../app/surface/task-presentation-port.ts'
import type { PendingInputPresentation, PendingTailRow, QueueItem } from '../../app/surface/pending-presentation.ts'
import { projectTranscriptStructure } from '../transcript/structure.ts'
import type { ToolPresenter } from '../transcript/tool-presentation.ts'
import type { TranscriptMessage, TranscriptToolMessage, TurnActivity } from '../../domain/transcript/types.ts'
import type { TranscriptWindowState } from '../../domain/transcript/window.ts'
import type { TodoItem, TranscriptSearchPresentation } from '../../tui-app.ts'
import type { StreamingToolPreview } from '../../app/surface/streaming-tool-preparing.ts'
import { TranscriptNodeKeys, transcriptView, toolRowImageBlocks, imageRefProblem, MAX_IMAGE_BLOB_BYTES, type ToolSvgState } from './transcript-view.ts'
import { admitSvg, type SvgAdmission } from '../../domain/visual/svg-admission.ts'
import { authorizeSvg, svgDigest } from '../../domain/visual/svg.ts'
import { visualFactLine, visualPartsFromText } from '../../domain/visual/visual-facts.ts'
import type { ToolImageState } from './transcript-view.ts'

/**
 * The banner the composer-active renderer pins in its dock. The PR3-A
 * read-only banner (with its bare `q` quit key) retired together with the
 * composer: a typed `q` is EDITOR TEXT now. Like the PR3-A banner, it names
 * NO chord labels — the renderer owns no keymap (there is no authority to
 * route a chord label through), and the host-keybindings gate keeps its
 * sanctioned-seam list closed to non-keymap copy. The submit/newline
 * gestures are the SDK editor's own affordances.
 */
const DOCK_BANNER = 'DSH TSP renderer · experimental composer'

/** The renderer-local dock state (banner + status facts + welcome + notices). */
interface DockState {
  statusLine: string
  notices: readonly DisplayDockNotice[]
  welcome: readonly DisplayWelcomeFacts[]
}

/** How many transient notices the dock keeps (oldest evicted). */
const NOTICE_LIMIT = 3

/**
 * PR3-B §3.3 (the B1 slice): the renderer's editor-local + lifecycle input
 * handlers, bound ONCE by `SurfaceRuntime.start`. The submission members
 * arrive with B2 (the plan's transitional contract); B1 delivers the
 * lifecycle/user-activity projection so a pre-bind key can never act as an
 * application gesture.
 */
export interface TspInputHandlers {
  /** The keyboard exit intent (the empty-draft Ctrl+D through the composer). */
  exit(): void
  /**
   * The interrupt/cancel intent — the EXISTING application cancel path
   * (PR3-B §3.4 row 3): aborts a running local shell / interrupts the live
   * Agent; NEVER an unconditional exit.
   */
  cancel(): void
  /**
   * PR3-B B2 (§3.4 submission gesture ordering): the EXISTING application
   * submit entry — `ApplicationEvents.events.onSubmit(text, request)`. The
   * renderer snapshots the draft, CLEARS the composer BEFORE the callback
   * (so a synchronous failure restoration merges into the empty/current
   * draft), and never applies a stale pre-callback snapshot afterwards.
   */
  submit(text: string, request: ComposerSubmitRequest): void
  /**
   * PR3-B B2: the draft-steer entry (`events.onSteer`) with the same
   * before-callback ordering; the submission controller owns the outcome.
   */
  steer(text: string): void
  /** Real user input on the editor seat (editable/submit keys). */
  noteUserInput(): void
  /**
   * PR3-B B3 (§3.8): the FRESH authoritative continued-Question rows for the
   * Alt+Q list (the seat filters `presentation === 'parked'`). A read of the
   * ONE controller — never a renderer-owned registry.
   */
  listContinuedQuestions(): readonly TspContinuedRow[]
  /**
   * PR3-B B3 (§3.8): reopen one continued Question through the ORIGINAL
   * controller, whose own recheck decides. The renderer mounts no form itself.
   */
  reopenContinuedQuestion(sessionId: string, callId: string): boolean
}

/** The B1 binding: editor-local + lifecycle only (submissions are B2). */
export interface TspInputBinding {
  /**
   * Bind the application handlers ONCE (a second bind throws — exactly ONE
   * input owner). Consumes the held pre-bind keys in arrival order; the
   * legal pre-bind exit intents already acted and are NOT re-delivered.
   */
  bindInput(handlers: TspInputHandlers): void
}

/** What the TSP renderer needs from the composition root. */
export interface TspRendererOptions {
  /** The workspace root for tool-args path relativization in the mapper. */
  readonly cwd?: string
  /**
   * The exit intent: invoked ONCE on the quit key. Routes through the SAME
   * exit orchestration as `/exit` (surface teardown, Host retirement,
   * appExit) — never `process.exit`.
   */
  readonly requestExit: () => void
  /**
   * The FATAL intent: a mounted renderer failure (the SDK input loop died —
   * the tty owner is gone). Routes through the runner's fatal lifecycle
   * (error outcome, no resume hint), never a normal exit.
   */
  readonly onFatal?: (error: unknown) => void
  /** SDK connect timeout override (tests); default is the SDK's 1000 ms. */
  readonly connectTimeout?: number
  /**
   * PR-B1: the presentation bridge over the REGISTERED tool definitions (the
   * SAME bridge the PiTui renderer consumes). It is consulted ONLY to decide
   * whether a tool row's displayed target is PROVEN to be a command, a single
   * path or a pattern. An absent bridge leaves every row's target plain
   * `text` — the behaviour before PR-B1.
   */
  readonly toolPresenter?: ToolPresenter
  /** The connect seam (tests); default is the shipped SDK `connect`. */
  readonly connect?: typeof sdkConnect
  /** Diagnostics sink for the renderer's own lifecycle facts. */
  readonly log?: (message: string, fields?: Record<string, unknown>) => void
  /**
   * Diagnostics sink for FAILURES (R2-3): a secondary tty-restoration error on
   * a failure path is recorded here while the PRIMARY error stays the one that
   * propagates — never a silent `catch {}`, never a fallback/retry.
   */
  readonly logError?: (message: string, fields?: Record<string, unknown>) => void
}

/** The mounted TSP renderer (the display seam + the one-shot disposer). */
export interface TspRenderer extends TspInputBinding {
  readonly display: SurfaceDisplaySeam
  readonly modelPresentation: ModelPresentation | undefined
  /**
   * PR4-A: the native `/preset` preset picker. Absent when the pane does not
   * advertise the official kinds it renders.
   */
  readonly presetPresentation: PresetPresentation | undefined
  /** Internal read-only Session Browser seam; absent unless all required kinds are negotiated. */
  readonly sessionBrowserPresentation: SessionBrowserPresentation | undefined
  /**
   * B3-A1: the Task Center presentation sink. It is ALWAYS present — the
   * internal native Work Hub is the renderer's implementation — but the
   * renderer's `display.supportsTaskCenter` stays false, so no production
   * `/tasks` path reaches it in A1.
   */
  readonly taskPresentation: TaskCenterPresentationPort
  /**
   * PR3-B B1: the composer projection backed by the renderer's ONE
   * program-owned composer (`getDraft()` reads the VISIBLE editor, never a
   * hidden PiTui instance). Every port mutator commits a controlled frame.
   */
  readonly composer: SubmissionComposerPort
  /**
   * PR3-B §B0: the INERT modal presenter. No TSP form exists yet (B3 mounts
   * the real interaction presenter), so every ask rejects with the flow's
   * cancellation error and the settled-lookup/notify members are inert —
   * consistent with `supportsModals === false` (the fail-closed admission in
   * `app/surface/interaction-runtime.ts` keeps deciding before any presenter
   * call).
   */
  readonly interaction: SurfaceInteractionPresenter
  /**
   * PR-C: install the ONE image binding (the mount's loader and scope
   * sampler) on this renderer. It is SYNCHRONOUS and ONE-TIME: the binding
   * must be in place before the renderer's first tool projection, and the
   * renderer refuses a second binding or a binding after disposal.
   *
   * The binding carries PRESENTATION capability only: the loader stays the
   * single cache and read authority, and `session.blob()` stays the single
   * blob sender.
   */
  readonly bindImages: (binding: SurfaceImageBinding) => void
  /**
   * Stop the input loop, close the surface + session ONCE. The promise
   * settles only after the SDK restored the tty (input drain included), so
   * callers awaiting it can safely touch the terminal afterwards.
   */
  readonly dispose: () => Promise<void>
}

/**
 * Probe and connect the TSP renderer. Returns `undefined` when the terminal
 * has no TSP (`connect() === null`) — the caller then mounts PiTui exactly as
 * before. A connect/handshake FAILURE propagates (fatal startup path). Once
 * connected, the session is owned: a MOUNT failure closes it before
 * re-raising (no leaked tty owner).
 */
export async function connectTspRenderer(options: TspRendererOptions): Promise<TspRenderer | undefined> {
  const session = await (options.connect ?? sdkConnect)({
    app: 'dsh-pi-tui',
    ...(options.connectTimeout === undefined ? {} : { timeout: options.connectTimeout }),
  })
  if (session === null) return undefined
  try {
    return mountTspRenderer(session, options)
  } catch (primary) {
    // The session is an OWNED resource from the moment connect returned it:
    // a mount failure must not leak its raw-mode stdin listener. The PRIMARY
    // mount error stays the one that propagates; a secondary tty-restoration
    // failure is recorded (R2-3) and never replaces it.
    await closeRestoring(session, options.logError, primary)
    throw primary
  }
}

/**
 * Close one owned session on a failure path. The `primary` error keeps
 * propagating; a secondary restore failure is recorded through `logError`
 * (R2-3) — never swallowed, never a retry/fallback.
 */
async function closeRestoring(
  session: Session,
  logError: ((message: string, fields?: Record<string, unknown>) => void) | undefined,
  primary: unknown,
): Promise<void> {
  try {
    await session.close()
  } catch (restorationFailure) {
    logError?.('tsp renderer: tty restore failed while releasing an owned session', {
      error: errorText(restorationFailure),
      primary: errorText(primary),
    })
  }
}

/** A safe one-line error text (never throws on a hostile value). */
function errorText(value: unknown): string {
  try {
    if (value instanceof Error) return typeof value.message === 'string' ? value.message : '<error>'
    return String(value)
  } catch {
    return '<unprintable error>'
  }
}

/** Mount the renderer over an already-connected SDK session. */
export function mountTspRenderer(session: Session, options: TspRendererOptions): TspRenderer {
  // Ownership rule (R2-3): the session belongs to the CALLER until this mount
  // succeeds. A throwing `open` therefore re-raises WITHOUT closing here —
  // `connectTspRenderer` (the owner that connected it) performs the recorded
  // release, so there is exactly ONE close and no bare fire-and-forget
  // promise inside this synchronous function.
  const surface: Surface = session.open({ mode: 'inline', title: 'dsh' })
  let disposed = false
  let exitRequested = false
  /** Monotonic renderer-local identities (notices; scope epochs). */
  let noticeSeq = 0
  let scopeEpoch = 0

  /**
   * The renderer's FATAL path (the tty owner is gone, or a modal frame commit
   * failed): ONE latch for every fatal source, routed to the runner's fatal
   * lifecycle (error outcome, no resume hint) — never a normal exit and never
   * a second invocation.
   */
  const routeFatal = (error: unknown): void => {
    if (exitRequested) return
    exitRequested = true
    const fatal = options.onFatal
    if (fatal !== undefined) fatal(error)
    else options.requestExit()
  }

  // ── Renderer-local presentation state ──
  /** The CURRENT presentation-key scope namespace (`scope-<n>-` prefixes). */
  let scopeKeys = new TranscriptNodeKeys()
  let scopePrefix = 's0-'
  /** The token of the source the current scope was built from (`===` only). */
  let projectionScope: object | undefined
  /**
   * The hydration fence: after `beginSessionHydration()` the RETIRED source
   * token is rejected until a frame with a DIFFERENT token commits. This is
   * the PR2 switch-window rule made real — the old fold's late repaint can
   * never lift the Loading state nor relabel old rows as the new subject.
   */
  let retiredSource: object | undefined
  /**
   * PR3-B §3.4 row 1: the session/hydration INPUT fence. Between a generation
   * bump (`beginSessionHydration`) and the new subject's first committed frame,
   * the composer must not accept edits and must never submit: the draft belongs
   * to the OUTGOING subject (its session may already be replaced), so a write
   * here would target a stale owner. Composer keys are dropped (the existing
   * draft is preserved — not cleared); the lifecycle cancel/exit intents stay
   * available.
   */
  let hydrating = false
  let lastMain: Node | undefined
  let modelPicker: TspModelPicker | undefined
  let presetPicker: TspPresetPicker | undefined
  let sessionBrowser: TspSessionBrowser | undefined
  /** B3-A1: the internal native Work Hub presenter (same ONE layer). */
  let workHub: TspWorkHub | undefined
  const dock: DockState = { statusLine: DOCK_BANNER, notices: [], welcome: [] }
  const pending: { queued: readonly QueueItem[]; tail: readonly PendingTailRow[]; running: boolean } = { queued: [], tail: [], running: false }
  /** The application's pending-submit fact, surfaced as a dock line. */
  let pendingSubmit: SubmitPendingDetail | undefined
  /**
   * PR3-B B1: the ONE program-owned composer. The SDK controls the editor
   * node (`text`/`cursor` in UTF-16 units); the native edit/undo/send
   * features are NOT advertised — every authoritative mutation (a reducer
   * edit OR a composer-port mutator) re-renders the controlled state in one
   * frame through the `onChanged` sink.
   */
  const composer: TspComposer = createTspComposer({
    onChanged: () => render(),
    setSubmitPending: (detail) => {
      pendingSubmit = detail
      render()
    },
    notify: (text, kind) => display.notify(text, kind),
  })
  /**
   * PR3-B B3: the ONE interaction seat (the renderer's modal presentation
   * owner). It is created at mount and replaced the B0 INERT presenter, so the
   * `interaction` projection the surface installs is REAL from the start; the
   * `supportsModals` capability only flips once `bindInput` has installed the
   * application callbacks the seat routes Alt+Q through (never before).
   */
  const seat: TspInteractionSeat = createTspInteractionSeat({
    render: () => render(),
    // A frame/focus failure while settling a prompt must reach the runner's
    // fatal lifecycle (the tty owner is broken), never become a silent modal
    // cancellation; a repeated failure keeps the FIRST fatal (exitRequested).
    onFatal: (error) => { routeFatal(error) },
    notify: (text, kind) => { display.notify(text, kind) },
    setSettledQuestionAnswersLookup: (lookup) => {
      settledQuestionAnswers = lookup
      if (!rebuildLastMain()) return
      render()
    },
  })
  modelPicker = new TspModelPicker({
    render: () => render(),
    canInteract: () => !disposed && !hydrating && inputBound && !seat.hasModalSeat(),
    notify: (text, kind) => display.notify(text, kind),
    // The ONE Surface owner performs the native scroll the Reader's keys ask
    // for. The presenter names a wire id of the frame IT built; the SDK stays
    // here and is never handed to the business/Host side.
    nativeScroll: (id, to) => { surface.scroll(id, to) },
  })
  presetPicker = new TspPresetPicker({
    render: () => render(),
    canInteract: () => !disposed && !hydrating && inputBound && !seat.hasModalSeat(),
    notify: (text, kind) => display.notify(text, kind),
    // The SAME ONE Surface owner performs the native scroll the Overview/Guide
    // reading keys ask for. The presenter names a wire id of the frame IT built.
    nativeScroll: (id, to) => { surface.scroll(id, to) },
  })
  sessionBrowser = new TspSessionBrowser({
    surfaceId: surface.id,
    render: () => render(),
    canInteract: () => !disposed && !hydrating && inputBound && !seat.hasModalSeat(),
    notify: (text, kind) => display.notify(text, kind),
    nativeScroll: (id, to) => { surface.scroll(id, to) },
    scrollSupported: session.caps.features.includes('scroll'),
  })
  modelPicker.resize(session.caps.cols, session.caps.cell.w)
  workHub = new TspWorkHub({
    surfaceId: surface.id,
    render: () => render(),
    canInteract: () => !disposed && !hydrating && inputBound && !seat.hasModalSeat(),
    // The pane width is derived from the SDK's live geometry — NEVER from a
    // desktop window width (a TSP pane can be a split of any window).
    paneWidth: () => session.caps.cols * session.caps.cell.w,
  })
  /**
   * The ONE seat's FOUR-WAY presenter exclusivity (plan §10.2).
   *
   * `presenterOpenGeneration` is the seat's operation witness. A retirement
   * callback may synchronously open a NEWER presenter while an earlier open is
   * still retiring its siblings (a Session Browser's `onClose` can open
   * another panel). The newer lifetime owns the seat, so the earlier open must
   * come back inert instead of overwriting it. Render priority is NOT a
   * substitute: a merely hidden sibling keeps its input owner alive.
   */
  let presenterOpenGeneration = 0
  /**
   * Commit one presenter open after retiring the three siblings, or stay inert.
   *
   * The sibling sweep is a LIST of retirement steps and the generation is
   * re-checked BETWEEN them: a retirement callback may synchronously open a
   * newer presenter, and a stale outer open must then stop sweeping — running
   * the remaining `retire()` calls would dispose the newer presenter the
   * callback just opened.
   */
  const openExclusively = <Handle>(
    retireSteps: readonly (() => void)[],
    open: () => Handle,
    inert: Handle,
  ): Handle => {
    const generation = ++presenterOpenGeneration
    for (const retire of retireSteps) {
      // A previously retired presenter's callback may have taken the seat.
      if (generation !== presenterOpenGeneration) return inert
      retire()
    }
    if (generation !== presenterOpenGeneration) return inert
    return open()
  }
  /** The three sibling presenters, in the fixed retirement order. */
  const siblingRetirements = (...excluded: readonly ('model' | 'preset' | 'browser' | 'hub')[]): Array<() => void> => {
    const steps: Array<() => void> = []
    if (!excluded.includes('model')) steps.push(() => modelPicker?.retire())
    if (!excluded.includes('preset')) steps.push(() => presetPicker?.retire())
    if (!excluded.includes('browser')) steps.push(() => sessionBrowser?.retire())
    if (!excluded.includes('hub')) steps.push(() => workHub?.retire())
    return steps
  }
  const modelPresentation: ModelPresentation = {
    open: (request) => openExclusively(
      siblingRetirements('model'),
      () => modelPicker!.presentation.open(request),
      // A superseded open never minted a panel; its handle is inert and the
      // command's own read owner checks `isDisposed()` before every read.
      {
        setLoading: () => {},
        setDirectory: () => {},
        setLoadError: () => {},
        isDisposed: () => true,
        close: () => {},
      },
    ),
    notify: (message, kind) => modelPicker!.presentation.notify(message, kind),
  }
  const presetPresentation: PresetPresentation = {
    open: (request) => openExclusively(
      siblingRetirements('preset'),
      () => presetPicker!.presentation.open(request),
      {
        setLoading: () => {},
        setRoster: () => {},
        setLoadError: () => {},
        isDisposed: () => true,
        close: () => {},
      },
    ),
    notify: (message, kind) => presetPicker!.presentation.notify(message, kind),
  }
  const sessionBrowserPresentation: SessionBrowserPresentation = {
    open: (request) => openExclusively(
      siblingRetirements('browser'),
      () => sessionBrowser!.presentation.open(request),
      // The read owner retires its OWN panel and starts no read for this inert
      // handle (it is `isDisposed()` from the first instant).
      { isDisposed: () => true, setSnapshot: () => {}, close: () => {} },
    ),
    notify: (message, kind) => sessionBrowser!.presentation.notify(message, kind),
  }
  /**
   * The Task Center presentation sink the surface installs is a SEAT WRAPPER,
   * not the hub's own port: the Work Hub open retires the three sibling
   * non-blocking presenters in the SAME synchronous stack. Every other member
   * is the hub's own passive sink (A1 keeps no second roster/summary/Quick
   * projection).
   */
  const taskPresentation: TaskCenterPresentationPort = {
    openBrowser: (items, onSelect, onClose, openOptions) => openExclusively(
      siblingRetirements('hub'),
      () => workHub!.taskPresentation.openBrowser(items, onSelect, onClose, openOptions),
      { close: () => {}, setItems: () => {}, setRefreshState: () => {} },
    ),
    setQuickTaskItems: items => workHub!.taskPresentation.setQuickTaskItems(items),
    setAgents: agents => workHub!.taskPresentation.setAgents(agents),
    setTasks: jobs => workHub!.taskPresentation.setTasks(jobs),
    setQuestionAttention: count => workHub!.taskPresentation.setQuestionAttention(count),
    setTaskSummary: summary => workHub!.taskPresentation.setTaskSummary(summary),
  }
  /**
   * PR3-A supports NO viewer, so this read is the explicit UNSUPPORTED capability
   * (the seam's `supportsViewer` is false and `enterView` declines at its real
   * admission point). It is deliberately NOT a generation authority: a future
   * renderer that presents a viewer must read the EXISTING viewer owner's
   * generation instead of maintaining a second one here.
   */
  let viewerGeneration = 0
  /**
   * PR3-B B3 (§3.9): the authoritative settled-answer lookup installed by the
   * interaction owner, and the last transcript projection the native nodes were
   * built from. The lookup is never cached into answers — it is re-read on
   * every rebuild, so a settled batch reaches the `ask_user_question` row
   * without a second fold.
   */
  let settledQuestionAnswers: SettledQuestionAnswersLookup | undefined
  let lastMessages: readonly TranscriptMessage[] = []
  /**
   * PR-B3: the LAST committed Preparing snapshot — the application owner's
   * read-only projection of the live tool-call arguments. It is NOT a second
   * preview authority: the renderer never creates, filters, re-sorts or times
   * a preview, and it never decides when a Preparing row disappears (the
   * owner clears the preview and the NEXT snapshot says so). It exists only
   * so the existing `rebuildLastMain()` repaint (a settled Question answer)
   * redraws the SAME rows instead of dropping them for one frame.
   */
  let lastStreamingToolPreviews: readonly StreamingToolPreview[] = []
  /**
   * PR-C: the ONE image binding of this renderer, installed by the mount
   * BEFORE the first tool projection. It carries the mount's loader (the
   * single cache and read authority) and the scope sampler (the immutable
   * display-subject identity the read is authorized under). Without it the
   * renderer has NO image capability.
   */
  let imageBinding: SurfaceImageBinding | undefined
  let imageBindingInstalled = false
  /**
   * PR-C: the immutable image scope of the CURRENT display subject, captured
   * ONCE per projection source. An ordinary repaint or delta REUSES it: the
   * scope is never re-resolved when an async read settles, so a retired
   * presentation can never read under a successor's authorization.
   */
  let activeImageScope: unknown | undefined
  /**
   * PR-C: the CURRENT presentation subscriptions, keyed by attachment id.
   * They are short-lived presentation subscribers, NOT an image cache: the
   * loader owns the bytes, this map owns only the "this row waits for this
   * attachment" fact.
   */
  const imageSubscriptions = new Map<string, () => void>()
  /**
   * PR-C: the image preparation was ABORTED by a fatal blob failure. The
   * projection must not continue: the last committed frame stands, and the
   * fatal lifecycle owns the exit.
   */
  let imageProjectionAborted = false
  /**
   * PR-D: the SVG blob preparation was ABORTED by a fatal blob failure (the
   * tty owner is gone). The same fatal lifecycle owns the exit; the last
   * committed frame stands and no further blob may be sent.
   */
  let visualProjectionAborted = false
  /** PR-D: admitted SVG digests → admission verdicts (bounded replay cache). */
  const svgAdmissions = new Map<string, SvgAdmission>()
  /** PR-D: admitted SVG digests → the ONE sender's blob id (content-addressed). */
  const svgBlobIds = new Map<string, string>()
  /**
   * PR-D RFL-016: the tool-card keys the user EXPANDED via the Tern `toggle`
   * event. A ready SVG card starts collapsed; only the user's expansion
   * requests its blob (the actual display demand), and collapsing/window/scope
   * changes release the id cache.
   */
  const expandedToolKeys = new Set<string>()
  /** PR-D RFL-019: the CURRENT projection's actual node key PATH → disclosure.
   *  The path comes from the real tool-node ancestor chain (never by splitting
   *  ids on dots), so dotted subCallIds and an absent ToggleEvent.key are both
   *  unambiguous. A toggle whose id does not end with a current path is
   *  stale/foreign and is ignored. */
  const toolDisclosureByPath = new Map<string, string>()

  /** The hardware caret this renderer last asked for (the ONE focus truth it
   *  keeps: it re-issues the op only when the DESIRED seat changes, including
   *  the return to the composer after a modal — the pre-B3 one-shot latch left
   *  the composer dead after the first modal close). */
  let lastAppliedFocusId: string | null | undefined

  /** Apply the seat's desired hardware focus after a committed frame. */
  const applyFocus = (force: boolean): void => {
    if (disposed) return
    const desired = seat.hasModalSeat()
      ? seat.desiredFocusId()
      : workHub?.isOpen() === true
        ? workHub.desiredFocusId() ?? null
        : sessionBrowser?.isOpen() === true
          ? sessionBrowser.desiredFocusId() ?? null
          : presetPicker?.isOpen() === true
            ? presetPicker.desiredFocusId() ?? null
            : modelPicker?.isOpen() === true
              ? modelPicker.desiredFocusId() ?? null
              : 'dock.composer'
    if (!force && desired === lastAppliedFocusId) return
    lastAppliedFocusId = desired
    composer.setFocused(desired === 'dock.composer')
    surface.focus(desired)
  }

  /** Re-render every region in ONE frame (the SDK diffs). The `layer` region is
   *  ALWAYS submitted (an omitted region would be deleted by the full-view
   *  diff, wiping an open modal on the next unrelated repaint). */
  function render(): void {
    if (disposed) return
    if (seat.hasModalSeat()) {
      sessionBrowser?.suspend()
      modelPicker?.suspend()
      presetPicker?.suspend()
      workHub?.suspend()
    }
    const dockNode = dockView()
    const mainNode = lastMain
    surface.render({
      ...(mainNode === undefined ? {} : { main: mainNode }),
      ...(dockNode === undefined ? {} : { dock: dockNode }),
      // Modal-first, then the four mutually-exclusive non-blocking presenters
      // in their frozen priority order; the empty seat layer is the fallback.
      layer: seat.hasModalSeat()
        ? seat.renderLayer()
        : workHub?.renderLayer()
          ?? sessionBrowser?.renderLayer()
          ?? presetPicker?.renderLayer()
          ?? modelPicker?.renderLayer()
          ?? seat.renderLayer(),
    })
    // The focus op is meaningful only for a node of a COMMITTED frame (the
    // SDK never validates it), so it always follows the render above.
    applyFocus(false)
  }

  /**
   * PR-C: whether the pane can carry a native image at all. The `image` kind
   * and the `blobs` feature are NEGOTIATED by the client — the mapper never
   * infers them from a TypeScript prop.
   */
  const nativeImagesSupported = (): boolean =>
    session.caps.kinds.includes('image') && session.caps.features.includes('blobs')

  /**
   * PR-C: the image attachments the CURRENT window projects, in window
   * order. The row rule is the mapper's own ({@link toolRowImageBlocks}), so
   * the reader and the view can never disagree: a row that does not project
   * an image is never read, and a malformed reference is never read either.
   */
  const projectedImageRefs = (): ImageAttachmentRefLike[] => {
    const refs: ImageAttachmentRefLike[] = []
    const visit = (message: TranscriptMessage): void => {
      if (message.kind !== 'tool') return
      for (const block of toolRowImageBlocks(message)) {
        if (imageRefProblem(block.attachment) !== undefined) continue
        refs.push(block.attachment as ImageAttachmentRefLike)
      }
      for (const child of message.subCalls ?? []) visit(child)
    }
    for (const message of lastMessages) visit(message)
    return refs
  }

  /** PR-C: drop every presentation subscription of the current subject. */
  const releaseImageSubscriptions = (): void => {
    for (const unsubscribe of imageSubscriptions.values()) unsubscribe()
    imageSubscriptions.clear()
  }

  /**
   * PR-C: the per-attachment render state of the current subject, prepared
   * BEFORE the projection so the mapper stays pure and the blob is sent
   * before the frame that references it.
   *
   * The `session.blob()` call is the ONE blob sender of the renderer: the
   * SDK dedupes the content, so a repeated projection never sends the bytes
   * twice. The 16 MiB gate is checked against the READY bytes — the
   * reference's own byte count is identity, never a send permit.
   */
  const prepareImageStates = (): ReadonlyMap<string, ToolImageState> | undefined => {
    const binding = imageBinding
    if (binding === undefined) return undefined
    const states = new Map<string, ToolImageState>()
    const refs = projectedImageRefs()
    if (!nativeImagesSupported()) {
      for (const ref of refs) states.set(ref.attachmentId, { state: 'unsupported' })
      return states
    }
    const scope = activeImageScope
    if (scope === undefined) {
      for (const ref of refs) states.set(ref.attachmentId, { state: 'no-scope' })
      return states
    }
    for (const ref of refs) {
      const load = binding.imageLoader.get(ref, scope)
      if (load.state === 'idle' || load.state === 'loading') {
        states.set(ref.attachmentId, { state: 'loading' })
        continue
      }
      if (load.state === 'error') {
        states.set(ref.attachmentId, { state: 'error' })
        continue
      }
      if (load.bytes.length > MAX_IMAGE_BLOB_BYTES) {
        states.set(ref.attachmentId, { state: 'too-large' })
        continue
      }
      try {
        states.set(ref.attachmentId, { state: 'ready', blobId: session.blob(load.bytes, ref.mediaType) })
      } catch (error) {
        // An unexpected blob failure is a RENDERER failure, not an image
        // state: the tty owner is gone. It goes to the fatal lifecycle, and
        // THIS projection is ABORTED. The read SUCCEEDED, so the row must
        // not be mislabelled as a read failure, and no further blob may be
        // sent after the fatal.
        routeFatal(error)
        imageProjectionAborted = true
        return undefined
      }
    }
    return states
  }

  /**
   * PR-C: the CURRENT window's image subscriptions. An attachment that left
   * the window is unsubscribed; a new one is subscribed BEFORE it is read.
   * The loader dedupes the read per (scope, attachment id), so two blocks
   * naming the same attachment read once.
   */
  const syncImageSubscriptions = (): void => {
    const binding = imageBinding
    const scope = activeImageScope
    // PR-C: a pane that negotiated no native image reads NOTHING: the
    // subscription set stays empty, so no attachment is even asked for.
    if (binding === undefined || scope === undefined || !nativeImagesSupported()) {
      releaseImageSubscriptions()
      return
    }
    const wanted = new Map<string, ImageAttachmentRefLike>()
    for (const ref of projectedImageRefs()) wanted.set(ref.attachmentId, ref)
    for (const [id, unsubscribe] of imageSubscriptions) {
      if (wanted.has(id)) continue
      unsubscribe()
      imageSubscriptions.delete(id)
    }
    for (const [id, ref] of wanted) {
      if (imageSubscriptions.has(id)) continue
      const source = projectionScope
      const unsubscribe = binding.imageLoader.subscribe(id, () => {
        // A settle may only repaint the subject that is still on screen: a
        // retired source, a retired scope, a hydration window or a disposed
        // renderer never emit a frame for it.
        if (disposed || hydrating) return
        if (source !== projectionScope) return
        if (scope !== activeImageScope) return
        if (!imageSubscriptions.has(id)) return
        if (!rebuildLastMain()) return
        render()
      }, scope)
      imageSubscriptions.set(id, unsubscribe)
      if (binding.imageLoader.get(ref, scope).state === 'idle') binding.imageLoader.load(ref, scope)
    }
  }

  /**
   * PR-D: prepare the per-row SVG display states BEFORE the pure projection.
   *
   * The admission gate runs on the DURABLE call args, and a row is authorized
   * only when its FINAL result blocks still carry a credential whose digest
   * matches those args. A ready row sends the SAME admitted bytes through the
   * ONE `session.blob()` sender (content-addressed, so a repeated projection
   * never re-sends). A fatal blob failure aborts the projection exactly like
   * the PR-C image path.
   */
  /**
   * PR-D display demand: send one admitted SVG through the ONE blob sender
   * only when the projection actually needs its image node. The map is
   * content-addressed and pruned to the current window (and cleared on a
   * subject/scope change), so collapse/paging/backscroll/reconnect do not
   * accumulate sends or blob ids.
   */
  const sendSvgBlob = (source: string, digest: string): string | undefined => {
    if (visualProjectionAborted) return undefined
    const known = svgBlobIds.get(digest)
    if (known !== undefined) return known
    try {
      const blobId = session.blob(Buffer.from(source, 'utf8'), 'image/svg+xml')
      svgBlobIds.set(digest, blobId)
      return blobId
    } catch (error) {
      routeFatal(error)
      visualProjectionAborted = true
      return undefined
    }
  }

  const prepareSvgStates = (): ReadonlyMap<TranscriptToolMessage, ToolSvgState> | undefined => {
    const states = new Map<TranscriptToolMessage, ToolSvgState>()
    const admit = (source: string): SvgAdmission => {
      const digest = svgDigest(source)
      const cached = svgAdmissions.get(digest)
      if (cached !== undefined) return cached
      const verdict = admitSvg(source)
      if (svgAdmissions.size >= 32) svgAdmissions.clear()
      svgAdmissions.set(digest, verdict)
      return verdict
    }
    const visit = (message: TranscriptMessage): boolean => {
      if (message.kind !== 'tool') return true
      if (message.name === 'dsh_pi_tui_svg') {
        // The exact row object is the key: the fold may reuse a bare
        // call/sub-call id across turns/steps, and only THIS row's final
        // content may authorize its drawing.
        {
          // Success is a prerequisite for EVERY drawing sink: a block/error
          // result never sends a blob, even if its feedback copied the valid
          // machine line/credential from the original result.
          if (message.status !== 'ok') {
            states.set(message, { state: 'invalid', reason: 'the tool result was not successful' })
          } else {
            const blocks = message.resultBlocks ?? (() => {
              const parts = visualPartsFromText(message.result)
              return parts.fact === undefined ? [] : [{ type: 'text' as const, text: visualFactLine(parts.fact) }]
            })()
            const authorization = authorizeSvg(message.args, blocks, message.status, admit)
            if (authorization.state === 'text') {
              states.set(message, { state: 'invalid', reason: authorization.reason })
            } else if (!nativeImagesSupported()) {
              // No native image/blob capability: still publish the admitted
              // source so a nested child can read it (the top-level card gets
              // it from the args code block).
              states.set(message, { state: 'unsupported', fact: authorization.fact, source: authorization.source })
            } else {
              // Authorization only. The blob bytes are sent by the mapper's
              // `request` when the image node is projected (display demand).
              states.set(message, {
                state: 'ready',
                fact: authorization.fact,
                source: authorization.source,
                request: () => sendSvgBlob(authorization.source, authorization.fact.digest),
              })
            }
          }
        }
      }
      for (const child of message.subCalls ?? []) {
        if (!visit(child)) return false
      }
      return true
    }
    for (const message of lastMessages) {
      if (!visit(message)) return undefined
    }
    // Release blob ids whose rows left the current window; the lazy request
    // re-sends only if such a row returns. This bounds the Send cache by the
    // live tool-card demand, not the session lifetime.
    const live = new Set<string>()
    for (const state of states.values()) if (state.state === 'ready') live.add(state.fact.digest)
    for (const digest of [...svgBlobIds.keys()]) {
      if (!live.has(digest)) svgBlobIds.delete(digest)
    }
    return states
  }

  /** Rebuild the canonical transcript from the last projection (same scope and
   *  source identity: a settled-answer repaint is NOT a new subject).
   *
   *  PR-B3: the hydration fence also guards this rebuild. While a NEW subject
   *  is pending, the retired source's messages must not overwrite the
   *  explicit Loading state — an answered-Question lookup that resolves
   *  during that window would otherwise resurrect the old rows (and their old
   *  Preparing rows) under the new subject's scope. */
  const rebuildLastMain = (): boolean => {
    if (disposed || hydrating) return true
    // PR-C: an aborted projection STAYS aborted. The fatal already took the
    // renderer down, so no further blob may even be ATTEMPTED.
    if (imageProjectionAborted || visualProjectionAborted) return false
    const imageStates = prepareImageStates()
    // PR-C: a fatal blob failure ABORTED this projection: the last committed
    // frame stands and the caller must not render a new one.
    if (imageProjectionAborted) return false
    const svgStates = prepareSvgStates()
    // PR-D: the same fatal fence for the native SVG blob sender.
    if (visualProjectionAborted) return false
    lastMain = transcriptView(projectTranscriptStructure(lastMessages), scopeKeys, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      scopePrefix,
      ...(settledQuestionAnswers === undefined ? {} : { settledQuestionAnswersLookup: settledQuestionAnswers }),
      ...(options.toolPresenter === undefined ? {} : { toolPresenter: options.toolPresenter }),
      preparingPreviews: lastStreamingToolPreviews,
      chartKindsSupported: session.caps.kinds.includes('chart'),
      ...(svgStates === undefined ? {} : { toolSvgStates: svgStates }),
      expandedToolKeys,
      toolImageStates: imageStates,
    })
    // Record the CURRENT projection's actual tool-node id → disclosure path.
    // The walk uses the real parent/child key chain, so a dotted subCallId is
    // never split and an absent ToggleEvent.key never needs a fallback.
    toolDisclosureByPath.clear()
    const recordDisclosures = (node: Node, path: string, parentTool: string | undefined): void => {
      const nodeKey = (node.props as { key?: string }).key
      let tool = parentTool
      if (node.kind === 'tool' && nodeKey !== undefined) {
        const own = nodeKey.startsWith(`${scopePrefix}msg-`)
          ? nodeKey.slice(scopePrefix.length)
          : nodeKey.startsWith('msg-') ? nodeKey : undefined
        tool = own ?? (parentTool !== undefined ? `${parentTool}/${nodeKey}` : undefined)
        if (tool !== undefined) toolDisclosureByPath.set(path, tool)
      }
      for (const [index, child] of node.children.entries()) {
        const childKey = (child.props as { key?: string }).key
        recordDisclosures(child, path === '' ? (childKey ?? String(index)) : `${path}.${childKey ?? String(index)}`, tool)
      }
    }
    recordDisclosures(lastMain, '', undefined)
    if (visualProjectionAborted) return false
    return true
  }

  const dockView = (): Node | undefined => {
    const lines: ReturnType<typeof ui.text | typeof ui.editor>[] = []
    for (const facts of dock.welcome) {
      const model = facts.model === undefined ? '' : ` · ${facts.model}`
      lines.push(ui.text({ key: `welcome-${facts.sessionId}`, text: sanitizeDisplayText(`DSH session ${facts.sessionId}${model}`) }))
    }
    // The pending-input presentation IS visible on this renderer: the queue
    // lane (authoritative queued + local echoes) and the ordered conversation
    // tail, exactly as the ONE join produced them.
    for (const item of pending.queued) {
      lines.push(ui.text({ key: `queue-${item.id}`, text: sanitizeDisplayText(`queued (${item.mode}): ${item.text}`) }))
    }
    for (const [index, row] of pending.tail.entries()) {
      lines.push(ui.text({ key: `tail-${index}`, text: sanitizeDisplayText(pendingRowText(row, index)) }))
    }
    if (pending.running && pending.queued.length === 0 && pending.tail.length === 0) {
      lines.push(ui.text({ key: 'pending-running', text: 'queued input is running…' }))
    }
    if (pendingSubmit !== undefined) {
      lines.push(ui.text({ key: 'pending-submit', text: pendingSubmit === 'submit' ? 'Submitting…' : 'Queued…' }))
    }
    if (dock.statusLine !== '') lines.push(ui.text({ key: 'status', text: sanitizeDisplayText(dock.statusLine) }))
    // PR3-B B3 (§3.8): the parked-Question count is a PRESENTATION of the ONE
    // controller's read (`InteractionRuntime.publishAttention` → presenter);
    // the Alt+Q entry is the inspection route, never an answerability fact.
    if (seat.attentionCount() > 0) {
      lines.push(ui.text({ key: 'question-attention', text: `Continued questions: ${seat.attentionCount()} · ${TSP_CONTINUED_INSPECTION_LABEL}` }))
    }
    for (const notice of dock.notices) {
      const noticeText = sanitizeDisplayText(notice.text)
      lines.push(ui.text({ key: `notice-${notice.id}`, text: notice.kind === 'error' ? `! ${noticeText}` : noticeText }))
    }
    // The controlled composer: SDK `ui.editor` with client-supplied
    // text/cursor (UTF-16). The native edit/undo/send features are NOT
    // advertised (`sendable` stays unset); the program owns every edit.
    lines.push(ui.editor({
      key: 'composer',
      text: composer.state().text,
      cursor: composer.state().cursor,
      maxLines: 8,
      placeholder: 'Message',
      prompt: '> ',
    }))
    return ui.col({ key: 'dock' }, ...lines)
  }

  // ── The transcript projection (the ONLY writer is setTranscript) ──
  const loadingMain = (): Node => ui.col({ key: 'transcript' }, ui.md({ key: 'loading', text: 'Loading session…' }))
  const setTranscript = (
    messages: readonly TranscriptMessage[],
    _activities?: ReadonlyMap<number, TurnActivity>,
    _window?: TranscriptWindowState & { firstTurn?: number; lastTurn?: number; hasNewer?: boolean },
    streamingToolPreviews?: readonly StreamingToolPreview[],
    _searchPresentation?: TranscriptSearchPresentation,
    source?: object,
  ): void => {
    if (disposed) return
    // Hydration fence: while a NEW source is pending, a frame still carrying
    // the RETIRED source is dropped (it reads the old fold — its rows can
    // never lift the Loading state).
    if (retiredSource !== undefined && source === retiredSource) return
    // The projection source identity governs the presentation-key scope: a
    // NEW identity (session commit, cold rehydrate, viewer switch) re-scopes
    // into a FRESH namespace (a new epoch prefix + allocator), so identical
    // shapes across folds can never inherit SDK node ids or terminal-local
    // state. Ordinary deltas keep the same source and the same keys.
    if (source !== undefined && source !== projectionScope) {
      projectionScope = source
      retiredSource = undefined
      // The new subject committed: the hydration input fence lifts with it.
      hydrating = false
      scopeEpoch += 1
      scopePrefix = `s${scopeEpoch}-`
      scopeKeys = new TranscriptNodeKeys()
      // PR-C: the retired subject's image subscriptions go with it, and the
      // NEW subject gets its OWN immutable scope - sampled ONCE here, never
      // re-resolved when a read settles.
      releaseImageSubscriptions()
      svgBlobIds.clear()
      expandedToolKeys.clear()
      activeImageScope = imageBinding?.imageScope()
    }
    // PR3-B B3 (§3.9): remember the projection so a settled-answer lookup can
    // rebuild the native nodes WITHOUT a new fold, a new scope or a new source
    // identity — the settled repaint is a presentation change only.
    // PR-B3: the Preparing snapshot is committed with it, AFTER the source
    // fence — a retired frame contributes no preview to the new subject.
    lastMessages = messages
    lastStreamingToolPreviews = streamingToolPreviews ?? []
    // PR-C: the image subscriptions follow the CURRENT window: an attachment
    // that left it is unsubscribed, a new one is subscribed and read.
    syncImageSubscriptions()
    if (!rebuildLastMain()) return
    render()
  }

  /** Mutable renderer-local mirror of the last committed status facts. */
  const statusFacts: { busy?: boolean; working?: boolean; planMode?: boolean; sessionTitle?: string; todos?: readonly TodoItem[]; compactionPhase?: DisplayStatusFacts['compactionPhase'] } = {}
  const flushStatus = (): void => {
    const parts: string[] = []
    if (statusFacts.busy === true || statusFacts.working === true) parts.push('working')
    if (statusFacts.planMode === true) parts.push('plan')
    if (statusFacts.compactionPhase !== undefined && statusFacts.compactionPhase !== 'idle') parts.push(`compacting (${statusFacts.compactionPhase})`)
    if (statusFacts.sessionTitle !== undefined && statusFacts.sessionTitle !== '') parts.push(statusFacts.sessionTitle)
    const todos = statusFacts.todos
    if (todos !== undefined && todos.length > 0) {
      const open = todos.filter(todo => todo.status !== 'completed').length
      parts.push(`todos ${todos.length - open}/${todos.length}`)
    }
    dock.statusLine = parts.length === 0 ? DOCK_BANNER : `${DOCK_BANNER} · ${parts.join(' · ')}`
    render()
  }

  const display: SurfaceDisplaySeam = {
    setTranscript,
    commitDisplaySubject() {
      // The shared StatusStore sections are committed by the surface
      // aggregate at its ONE atomic commit point (surface.commitStatus);
      // the read-only renderer has no chrome projection of its own.
    },
    commitStatusFacts(facts) {
      // PRESENCE is the write authority: an explicitly-present
      // `sessionTitle: undefined` CLEARS (Remote current-facts rely on it).
      if (facts.busy !== undefined) statusFacts.busy = facts.busy
      if (facts.working !== undefined) statusFacts.working = facts.working
      if (facts.planMode !== undefined) statusFacts.planMode = facts.planMode
      if ('sessionTitle' in facts) statusFacts.sessionTitle = facts.sessionTitle
      if (facts.todos !== undefined) statusFacts.todos = facts.todos
      if (facts.compactionPhase !== undefined) statusFacts.compactionPhase = facts.compactionPhase
      flushStatus()
    },
    resetSessionFacts() {
      // The HYDRATE-TAIL clear only: stale notices and the exit latch. The
      // status facts stay — the hydrate calling this just committed them.
      dock.notices = []
      render()
    },
    beginSessionHydration() {
      if (disposed) return
      sessionBrowser?.retire()
      modelPicker?.retire()
      presetPicker?.retire()
      // B3-A1: the Work Hub belongs to the outgoing subject — a newly
      // committed owner never inherits its panel.
      workHub?.retire()
      // P3: the transient Alt+Q list belongs to the subject that opened it — a
      // newly committed owner must not inherit it (and its keys).
      seat.closeTransientList()
      // The generation-bump window: drop the retained transcript to the
      // EXPLICIT Loading state and FENCE the retired source until a frame
      // with a NEW token commits — AND fence the composer input for the same
      // window (§3.4 row 1).
      hydrating = true
      retiredSource = projectionScope
      // PR-C: the retired subject's image subscriptions go with it - a late
      // settle of the outgoing subject must not repaint the incoming one.
      releaseImageSubscriptions()
      // PR-B3: the retired subject's Preparing rows go with it — the new
      // subject's own snapshot replaces them when it commits.
      lastStreamingToolPreviews = []
      lastMain = loadingMain()
      render()
    },
    clearActiveDraft() {
      // PR3-B §7.3 (B2 external-review F1, publication atomicity): the
      // session-lifecycle authority calls this INSIDE the synchronous
      // publication block — pre-`setCurrentOwner`, where a THROW would be
      // classified as a pre-publication failure with the draft already
      // lost. This path is therefore PURE STATE (no render IO): the emptied
      // editor rides the next frame the renderer commits (B's hydration
      // repaint), and the hydration input fence keeps the window
      // un-editable, so the outgoing text is never submittable meanwhile.
      if (disposed) return
      composer.clearDraftStateOnly()
    },
    retainsStaleDraftRestore() {
      // PR3-B §7.3 (F2): the switch authority DROPPED the old draft, so a
      // stale submission's late restore must not reseed the new session's
      // composer — the stale-settle sites skip the merge and notify instead.
      return false
    },
    resetInputHistory() {
      // Editor-only; no recall surface exists on the read-only renderer.
    },
    beginInputHistoryScope() {
      // Editor-only; no recall surface exists on the read-only renderer.
    },
    settleScopeInput() {
      // Editor-only; no recall surface exists on the read-only renderer.
    },
    setSearchResult() {
      // Search chrome is PiTui-only (input-gated); nothing to present.
    },
    notify(text, kind = 'info') {
      if (disposed) return
      noticeSeq += 1
      dock.notices = [...dock.notices.slice(-(NOTICE_LIMIT - 1)), { id: `n${noticeSeq}`, text, kind }]
      render()
    },
    setDockNotice(notice) {
      if (disposed) return
      if (notice === undefined) {
        if (dock.notices.length === 0) return
        dock.notices = []
      } else {
        if (dock.notices.length === 1 && dock.notices[0]?.id === notice.id && dock.notices[0].text === notice.text) return
        dock.notices = [notice]
      }
      render()
    },
    setWelcomeCard(facts) {
      if (disposed) return
      dock.welcome = [facts]
      render()
    },
    setWelcomeIdle(idle) {
      if (disposed) return
      if (idle) dock.welcome = []
      render()
    },
    setTerminalCwd() {
      // The TSP pane owns its cwd presentation (OSC 7 would fight the SDK tty).
    },
    setPendingInputPresentation(presentation: PendingInputPresentation) {
      if (disposed) return
      pending.queued = presentation.queued
      pending.tail = presentation.tail
      pending.running = presentation.running
      render()
    },
    getSessionTitle: () => statusFacts.sessionTitle ?? '',
    getViewerGeneration: () => viewerGeneration,
    supportsTaskCenter: false,
    supportsViewer: false,
    // PR3-B B3 (§3.5.1): the capability is advertised only once the seat's
    // application wiring is real — `bindInput` has installed the handlers the
    // modal routes Alt+Q and its forms through. Before that the interaction
    // runtime keeps its own fail-closed admission.
    get supportsModals() { return boundHandlers !== undefined },
  }

  // ── Input: the ONE SDK loop, the fixed §3.4 precedence ──
  // (B1: no modal exists yet — the interaction runtime's fail-closed
  // admission owns Question/Approval; a loop failure is FATAL.)
  /**
   * PR3-B §3.3 (the B1 review F4 contract): keys arriving BEFORE the
   * application binding are HELD in this bounded renderer-local queue (the
   * loop starts at connect, before `SurfaceRuntime.start` commits ownership).
   * `bindInput` consumes it exactly ONCE; a dispose without binding discards
   * it unconsumed. The LEGAL early exit intents (Ctrl+C, empty-draft Ctrl+D —
   * the PR3-A compatibility window) bypass the queue and route the same exit
   * controller; nothing else acts before the binding exists.
   */
  const heldKeys: Key[] = []
  const HELD_KEYS_LIMIT = 128
  let heldOverflowed = false
  let inputBound = false
  /** The bound application input handlers (B1: editor-local + lifecycle). */
  let boundHandlers: TspInputHandlers | undefined

  /** Route one exit-intent decision to the BOUND handler when bound. */
  const routeExit = (held: boolean): void => {
    if (exitRequested) return
    exitRequested = true
    options.log?.('tsp renderer: exit key', { held })
    if (boundHandlers !== undefined) boundHandlers.exit()
    else options.requestExit()
  }

  const dispatchKey = (key: Key, handlers: TspInputHandlers): boolean => {
    // 1. The disposal fence: `disposed` is checked by the loop before this.
    // 2. The MODAL SEAT owns every key while it is up (PR3-B B3 addendum
    //    §3.5.4). The SDK's `overlay(modal: true)` masks the picture but does
    //    NOT capture the keyboard, so this app-side route IS the modal
    //    boundary; it precedes the hydration fence (a form for the CURRENT
    //    subject stays answerable while a later hydration starts — the
    //    controller/renderer presentation retirement withdraws it).
    if (seat.hasModalSeat()) {
      seat.handleKey(key, handlers)
      return false
    }
    // 3. `Alt+Q` (PR3-B B3 §3.8): the inspection entry for parked continued
    //    Questions — only with no modal and outside the hydration window (the
    //    list belongs to the subject that is currently owned, so the SAME
    //    fence as every other key applies).
    if (!fencedOut(key) && key.alt === true && key.ctrl !== true && key.meta !== true
      && key.shift !== true && key.name === 'q') {
      seat.openContinuedList(handlers)
      return false
    }
    // 4. The interrupt/cancel intent (PR3-B §3.4 row 3): Ctrl+C and Escape
    //    map to the EXISTING application cancel path — never an
    //    unconditional exit. Interrupting a live Agent must not kill the
    //    TUI. The composer's exit-empty (below) is the only exit gesture.
    if (key.ctrl === true && key.name === 'c') {
      handlers.cancel()
      return false
    }
    if (workHub?.handleKey(key)) return false
    if (sessionBrowser?.handleKey(key)) return false
    if (presetPicker?.handleKey(key)) return false
    if (modelPicker?.handleKey(key)) return false
    if (key.name === 'escape') {
      handlers.cancel()
      return false
    }
    // 5. The composer reducer owns everything else (Ctrl+D empty-exit,
    //    Enter gestures, paste, edits). A typed `q` is TEXT now.
    const edit = composer.applyKey(key)
    if (edit.kind === 'submit') {
      handlers.noteUserInput()
      // PR3-B §3.4 submission gesture ordering: snapshot the serialized
      // draft, CLEAR the composer BEFORE invoking onSubmit (a synchronous
      // rejection/restore merges into the empty draft instead of being
      // erased by a post-callback clear), and never re-apply a stale
      // pre-callback editor snapshot afterwards. The submission controller
      // owns the business outcome (admission, rollback, queue).
      const serializedDraft = composer.getDraft()
      composer.setDraft('')
      handlers.submit(serializedDraft, edit.gesture)
    }
    if (edit.kind === 'edited') handlers.noteUserInput()
    if (edit.kind === 'exit-empty') return true
    return false
  }

  /**
   * PR3-B §3.4 row 1: the session/hydration input fence. ONE predicate for
   * BOTH the live key path and the held-key replay at the bind — a second copy
   * would let the replay bypass the fence (the B2 review's F3 follow-up).
   * The lifecycle cancel/exit intents are never fenced: they are not writes.
   *
   * PR3-B B3 (§3.5.4): a live MODAL SEAT outranks the fence. The form was
   * presented for the subject the surface still owns (the controller/renderer
   * retirement is what withdraws it when the owner really changes), so its
   * answer keys stay deliverable while a later hydration starts.
   */
  const fencedOut = (key: Key): boolean => {
    if (!hydrating) return false
    if (seat.hasModalSeat()) return false
    const lifecycleIntent = (key.ctrl === true && (key.name === 'c' || key.name === 'd'))
      || key.name === 'escape'
    return !lifecycleIntent
  }

  /** Route one input: exit intents act; everything else waits for the bind. */
  const routeInput = (input: SessionInput): boolean => {
    if (input.type === 'event') {
      // The client REFUSED a protocol operation (Tern answers a rejected operation
      // with `error`): `msg` is always present, while `sf`/`s`/`op`/`sheet`/`id` are
      // all OPTIONAL (pinned SDK `wire.ts` `ErrorEvent`/`decodeEvent`). The SDK itself
      // neither interprets nor consumes it (`Surface.dispatch` has no `error` branch),
      // so this is the ONE place the application can see it at all. Record ONLY the
      // fields the client actually sent (never fabricate `sf`/`s`/`op`, never log the
      // raw wire object), never attribute another surface's error to this renderer
      // (a `msg`-only error is a session-level fact), and never branch on the optional
      // `id`. An `error` is never modal, picker, focus or business input: stopping here
      // means it cannot reach the seat or a presenter, re-assert focus, settle a modal,
      // repaint or write. It is NOT fatal and is never retried.
      if (input.event.ev === 'error') {
        if (input.event.sf === undefined || input.event.sf === surface.id) {
          options.logError?.('tsp renderer: client rejected protocol operation', {
            ...(input.event.sf === undefined ? {} : { sf: input.event.sf }),
            ...(input.event.s === undefined ? {} : { s: input.event.s }),
            ...(input.event.op === undefined ? {} : { op: input.event.op }),
            msg: input.event.msg,
          })
        }
        return false
      }
      // PR3-B B3 (§3.5.5): the modal seat gates events addressed at the
      // underlying composer. A terminal focus claim must not move the caret
      // away from an open form, so the seat's own focus is re-asserted; every
      // other event keeps its existing (unhandled) course.
      // PR-D RFL-016: the Tern disclosure event. A ready SVG card starts
      // collapsed; expanding it is the real display demand that sends the
      // blob. The node id's last segment is the `ui.tool` key (the same key the
      // mapper wrote), with the event's optional `key` taking precedence.
      if (input.event.ev === 'toggle' && input.event.sf === surface.id) {
        // The SDK node id still carries the B2 child key (`sub-...`); the
        // disclosure identity is the parent-scoped path from the last tool-card
        // key (`msg-N`) through that child key. The mapper builds exactly the
        // same `msg-N/sub-...` path, so two parents with the same subCallId do
        // not share expansion while node ids stay untouched.
        let disclosure: string | undefined
        let matched = -1
        for (const [path, value] of toolDisclosureByPath) {
          if (path.length > matched && (input.event.id === path || input.event.id.endsWith(`.${path}`))) {
            disclosure = value
            matched = path.length
          }
        }
        if (disclosure === undefined) return false
        if (input.event.collapsed) expandedToolKeys.delete(disclosure)
        else expandedToolKeys.add(disclosure)
        if (rebuildLastMain()) render()
        return false
      }
      if (input.event.ev === 'resize' && input.event.sf === surface.id && typeof input.event.cols === 'number') {
        // The SDK has already folded this event into `caps` (cols AND the cell
        // size), so the presenter's layout rule reads the live geometry.
        modelPicker?.resize(input.event.cols, session.caps.cell.w)
        render()
      }
      if (seat.hasModalSeat()) { if (seat.handleEvent(input.event)) applyFocus(true); return false }
      if (!hydrating && inputBound && 'sf' in input.event && input.event.sf === surface.id) {
        // B3-A1: the Work Hub is the highest non-modal native presenter. Its
        // local SELECT/ACTIVATE/ACTION admission never reaches a business
        // router (A1 has no details/stop/open path).
        if (workHub?.handleEvent(input.event)) return false
        if (sessionBrowser?.handleEvent(input.event)) return false
        if (presetPicker?.handleEvent(input.event)) return false
        if (modelPicker?.handleEvent(input.event)) return false
        if ((workHub?.isOpen() === true || sessionBrowser?.isOpen() === true
          || presetPicker?.isOpen() === true || modelPicker?.isOpen() === true)
          && input.event.ev === 'focus') applyFocus(true)
      }
      return false
    }
    const key = input.key
    // PRE-BIND Ctrl+C keeps the PR3-A emergency-exit compatibility (a quit
    // during a cancelled startup must not wait for a bind that never comes);
    // once bound it becomes the CANCEL intent (dispatchKey). Escape has no
    // emergency semantics and is held like any other key.
    if (key.ctrl === true && key.name === 'c' && !inputBound) return true
    // The empty-draft Ctrl+D exit is ORDER-dependent (the reducer decides it
    // against the live draft): pre-bind, it may act directly ONLY while the
    // held queue is EMPTY — with held keys the draft's emptiness is not yet
    // knowable (the held edits have not applied), so the gesture must wait
    // and re-decide in arrival order at the bind.
    // While the fence is up the composer accepts NO key: the draft (and any
    // submit) would belong to a subject the surface is replacing. Dropped, not
    // held, and the existing draft is preserved.
    if (fencedOut(key)) return false
    if (!inputBound) {
      if (key.ctrl === true && key.name === 'd' && heldKeys.length === 0 && composer.getDraft() === '') return true
      if (heldKeys.length < HELD_KEYS_LIMIT) {
        heldKeys.push(key)
      } else if (!heldOverflowed) {
        // Fail loud ONCE (never a silent drop): the pre-bind window received
        // more input than the bounded queue holds. The dropped tail is
        // observable on the dock; the held prefix still replays at the bind.
        heldOverflowed = true
        display.notify('too much input arrived before startup finished — later keys were dropped', 'error')
      }
      return false
    }
    // `inputBound` implies `boundHandlers` (bindInput sets both together);
    // assert the pairing for the type system rather than silently defaulting.
    if (boundHandlers === undefined) throw new Error('the TSP input is bound without handlers')
    return dispatchKey(key, boundHandlers)
  }

  const inputLoop = (): void => {
    void (async () => { // allowlist: the mounted renderer's own loop — every rejection is caught and routed to onFatal/requestExit, never unhandled
      try {
        for await (const input of session) {
          if (disposed) return
          if (routeInput(input)) routeExit(false)
        }
      } catch (error) {
        if (disposed) return
        // The tty owner died after mount: FATAL, never a normal exit — the
        // runner's fatal lifecycle owns the error outcome and cleanup.
        options.log?.('tsp renderer: input loop failed', { error: String(error) })
        routeFatal(error)
      }
    })()
  }
  inputLoop()

  render()
  // PR3-B B1: the composer PORT adapter — the application's
  // `SubmissionComposerPort` projection backed by the renderer's ONE
  // composer object. `getDraft()` reads the VISIBLE TSP composer, never a
  // hidden PiTui instance; `setSubmitPending` surfaces the existing pending
  // fact in the dock (no derived queue state).
  const composerPort: SubmissionComposerPort = composer
  return {
    display,
    get modelPresentation() {
      // The native B2 Model layer needs the picker surface itself, the native
      // Row of the Reader's Back control and the read-only Reader's overlay —
      // the three kinds its render paths really construct. A pane that
      // advertises fewer kinds is refused BEFORE the handler (fail closed);
      // the list-first revision retired the detail Cards, so this is the exact
      // set the presenter uses (see the evidence index).
      return ['picker', 'row', 'overlay'].every(kind => session.caps.kinds.includes(kind))
        ? modelPresentation
        : undefined
    },
    get presetPresentation() {
      // The Preset layer renders ONE native `ui.picker` with `layout:'cards'` and
      // `preview:'none'` and the THREE-entry native footer, ONE native `ui.overlay`
      // Details page whose `Back` control is the #301-proven native `ui.row({onClick})`
      // navigation row over `text` identity facts, and a SHIPPED preset's inline guide
      // body (`md`), and it drives the reading body with the SDK's `scroll` op
      // (Owner A4 amendment, 2026-10-14: the measured client paints no stylesheet
      // border/background on an `el` button, so the Details way back is native
      // navigation, not an `html.button`; no stylesheet is used anywhere on this
      // layer). A pane that does not advertise every one of those kinds AND the
      // `scroll` feature is refused BEFORE the handler (fail closed) instead of
      // being handed a page it cannot present.
      const kinds = ['picker', 'row', 'overlay', 'text', 'md']
      return kinds.every(kind => session.caps.kinds.includes(kind))
        && session.caps.features.includes('scroll')
        ? presetPresentation
        : undefined
    },
    get sessionBrowserPresentation() {
      const kinds = ['picker', 'row', 'overlay', 'text']
      return kinds.every(kind => session.caps.kinds.includes(kind))
        && session.caps.features.includes('scroll')
        ? sessionBrowserPresentation
        : undefined
    },
    composer: composerPort,
    // PR3-B B3 (§3.5.1): the REAL interaction presenter (the seat) replaces
    // the B0 inert one. It is installed with the mount, but the surface only
    // opts into modals once `bindInput` has committed the application wiring.
    interaction: seat.presenter,
    // B3-A1: the internal native Work Hub presentation sink, wrapped by the
    // seat's four-way presenter exclusivity. It is always supplied with the
    // mount; the display seam's `supportsTaskCenter:false` stays the ONE
    // production reachability truth until A3.
    taskPresentation,
    // PR-C: the ONE image binding. It is installed before the first tool
    // projection (the mount does it) and never twice.
    bindImages: (binding) => {
      if (disposed) throw new Error('the TSP renderer is disposed')
      if (imageBindingInstalled) throw new Error('the TSP renderer image binding is already installed')
      imageBindingInstalled = true
      imageBinding = binding
    },
    bindInput: (handlers) => {
      if (disposed) throw new Error('the TSP renderer is disposed')
      if (inputBound) throw new Error('the TSP renderer input is already bound')
      inputBound = true
      boundHandlers = handlers
      // Consume the held pre-bind keys ONCE, in arrival order. An exit
      // intent among them (possible only when held edits emptied the draft)
      // routes the exit through the same bound handler; the caller's
      // handlers now observe every subsequent key.
      const held = heldKeys.splice(0, heldKeys.length)
      for (const key of held) {
        if (disposed) return
        // The SAME fence as the live path: a key held across a generation bump
        // must not be applied to a subject the surface is replacing.
        if (fencedOut(key)) continue
        if (dispatchKey(key, handlers)) routeExit(true)
      }
    },
    dispose: async () => {
      if (disposed) return
      disposed = true
      // PR-C: the image subscriptions die BEFORE the surface closes: an
      // in-flight read may still settle inside the loader, but it can no
      // longer send a blob or a frame.
      releaseImageSubscriptions()
      // PR3-B B3 (§3.5.6): the seat retires SYNCHRONOUSLY — every active and
      // queued modal promise settles (approval `cancelled`, question the flow's
      // cancellation error) before the surface/session close below, and the
      // call is idempotent with the interaction owner's own `withdrawPending`.
      seat.dispose()
      // B3-A1: the Work Hub retires BEFORE the older presenters and before
      // the surface/session close (A1 adds no second SDK resource).
      workHub?.retire()
      sessionBrowser?.retire()
      modelPicker?.retire()
      presetPicker?.retire()
      // Both steps are ALWAYS attempted — the tty restore (and the SDK's own
      // input drain) lives inside `session.close()`, so a surface-close
      // failure must still reach it, exactly once. A `try/finally` would
      // silently DISCARD the surface-close error in favour of the session
      // error (R3-2); instead both are collected and surfaced with the
      // repository's disposal contract: one failure rethrows the exact
      // thrown value, two or more aggregate without truncating either.
      const failures: unknown[] = []
      try {
        await surface.close({ keep: false })
      } catch (error) {
        failures.push(error)
      }
      try {
        await session.close()
      } catch (error) {
        failures.push(error)
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'TSP renderer disposal')
    },
  }
}

/** One pending-tail row as a single dock line (the join already ordered and
 *  classified it; the renderer only presents the row's own DTO fields and
 *  keeps the non-user Context identity distinct). */
function pendingRowText(row: PendingInputPresentation['tail'][number], index: number): string {
  if (row.kind === 'context') return `[${index + 1}] context: ${row.row.text}`
  const status = row.row.status === undefined ? '' : ` (${row.row.status}…)`
  return `[${index + 1}] you${status}: ${row.row.text}`
}

/**
 * Whether one decoded key is the PRE-BIND emergency EXIT intent (exported
 * for tests): only Ctrl+C before the application binding exists (the PR3-A
 * compatibility window — a cancelled startup still needs its quit). Once
 * bound, Ctrl+C becomes the CANCEL intent and the composer's empty-draft
 * Ctrl+D is the exit gesture (dispatchKey/applyKey). The PR3-A read-only
 * `q` quit retired when the composer became active.
 */
export function isQuitKey(key: { readonly name: string; readonly ctrl?: boolean }): boolean {
  if (key.name === 'c') return key.ctrl === true
  return false
}
