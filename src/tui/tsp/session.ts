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
import { cancellationError } from '../../runtime/process/tasks.ts'
import type {
  DisplayDockNotice,
  DisplayStatusFacts,
  DisplayWelcomeFacts,
  SurfaceDisplaySeam,
} from '../../app/surface/display-seam.ts'
import type { SubmissionComposerPort } from '../../app/submission/composer-port.ts'
import type { SubmitPendingDetail } from '../../app/submission/ack.ts'
import type { SurfaceInteractionPresenter } from '../../app/surface/interaction-presenter.ts'
import { createTspComposer, type TspComposer, type TspComposerEdit } from './editor.ts'
import type { PendingInputPresentation, PendingTailRow, QueueItem } from '../../app/surface/pending-presentation.ts'
import { projectTranscriptStructure } from '../transcript/structure.ts'
import type { TranscriptMessage, TurnActivity } from '../../domain/transcript/types.ts'
import type { TranscriptWindowState } from '../../domain/transcript/window.ts'
import type { TodoItem, TranscriptSearchPresentation } from '../../tui-app.ts'
import type { StreamingToolPreview } from '../../app/surface/streaming-tool-preparing.ts'
import { TranscriptNodeKeys, transcriptView } from './transcript-view.ts'

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

/** The B1 refusal notice for submit gestures (B2 binds the real onSubmit). */
const SUBMIT_NOT_READY = 'the TSP composer is not wired for submission yet — the draft was preserved'

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
  /** The keyboard exit intent (Ctrl+C / empty Ctrl+D through the composer). */
  exit(): void
  /** Real user input on the editor seat (editable/submit keys). */
  noteUserInput(): void
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
  let lastMain: Node | undefined
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
   * PR3-A supports NO viewer, so this read is the explicit UNSUPPORTED capability
   * (the seam's `supportsViewer` is false and `enterView` declines at its real
   * admission point). It is deliberately NOT a generation authority: a future
   * renderer that presents a viewer must read the EXISTING viewer owner's
   * generation instead of maintaining a second one here.
   */
  let viewerGeneration = 0

  /** Re-render both regions in ONE frame (the SDK diffs). */
  let composerFocused = false
  const render = (): void => {
    if (disposed) return
    const dockNode = dockView()
    const mainNode = lastMain
    surface.render({
      ...(mainNode === undefined ? {} : { main: mainNode }),
      ...(dockNode === undefined ? {} : { dock: dockNode }),
    })
    // Focus the composer only AFTER its node exists in a committed frame (a
    // focus op for an absent node is meaningless); the node id is stable, so
    // one call after the FIRST dock render is enough for the whole lifetime
    // (B3 re-focuses after modal close).
    if (!composerFocused && dockNode !== undefined) {
      composerFocused = true
      composer.setFocused(true)
      surface.focus('dock.composer')
    }
  }

  const dockView = (): Node | undefined => {
    const lines: ReturnType<typeof ui.text | typeof ui.editor>[] = []
    for (const facts of dock.welcome) {
      const model = facts.model === undefined ? '' : ` · ${facts.model}`
      lines.push(ui.text({ key: `welcome-${facts.sessionId}`, text: `DSH session ${facts.sessionId}${model}` }))
    }
    // The pending-input presentation IS visible on this renderer: the queue
    // lane (authoritative queued + local echoes) and the ordered conversation
    // tail, exactly as the ONE join produced them.
    for (const item of pending.queued) {
      lines.push(ui.text({ key: `queue-${item.id}`, text: `queued (${item.mode}): ${item.text}` }))
    }
    for (const [index, row] of pending.tail.entries()) {
      lines.push(ui.text({ key: `tail-${index}`, text: pendingRowText(row, index) }))
    }
    if (pending.running && pending.queued.length === 0 && pending.tail.length === 0) {
      lines.push(ui.text({ key: 'pending-running', text: 'queued input is running…' }))
    }
    if (pendingSubmit !== undefined) {
      lines.push(ui.text({ key: 'pending-submit', text: pendingSubmit === 'submit' ? 'Submitting…' : 'Queued…' }))
    }
    if (dock.statusLine !== '') lines.push(ui.text({ key: 'status', text: dock.statusLine }))
    for (const notice of dock.notices) {
      lines.push(ui.text({ key: `notice-${notice.id}`, text: notice.kind === 'error' ? `! ${notice.text}` : notice.text }))
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
    _streamingToolPreviews?: readonly StreamingToolPreview[],
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
      scopeEpoch += 1
      scopePrefix = `s${scopeEpoch}-`
      scopeKeys = new TranscriptNodeKeys()
    }
    lastMain = transcriptView(projectTranscriptStructure(messages), scopeKeys, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      scopePrefix,
    })
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
      // The generation-bump window: drop the retained transcript to the
      // EXPLICIT Loading state and FENCE the retired source until a frame
      // with a NEW token commits.
      retiredSource = projectionScope
      lastMain = loadingMain()
      render()
    },
    resetInputHistory() {
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
    supportsModals: false,
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
  let inputBound = false
  /** The bound application input handlers (B1: editor-local + lifecycle). */
  let boundHandlers: TspInputHandlers | undefined

  const dispatchKey = (key: Key): boolean => {
    // 1. The disposal fence: `disposed` is checked by the loop before this.
    // 2. No active modal in B1 (supportsModals stays false).
    // 3. The interrupt/exit intent routes through the SAME exit orchestration
    //    as PiTui's Ctrl+C (B2 binds the real cancel; B1 keeps the quit
    //    route) — legal in the pre-binding window too.
    if (key.ctrl === true && key.name === 'c') return true
    // 4. The composer reducer owns everything else (Ctrl+D empty-exit,
    //    Enter gestures, paste, edits). A typed `q` is TEXT now.
    const edit = composer.applyKey(key)
    if (edit.kind === 'edited') render()
    if (edit.kind === 'submit') {
      // B1: the application submit admission is not wired yet — refuse
      // EXPLICITLY and keep the draft (no Host mutation, no success notice).
      if (boundHandlers !== undefined) boundHandlers.noteUserInput()
      display.notify(SUBMIT_NOT_READY, 'info')
    }
    if (edit.kind === 'edited' && boundHandlers !== undefined) boundHandlers.noteUserInput()
    if (edit.kind === 'exit-empty') return true
    return false
  }

  /** Route one input: exit intents act; everything else waits for the bind. */
  const routeInput = (input: SessionInput): boolean => {
    if (input.type !== 'key') return false
    const key = input.key
    // The legal pre-binding exit intents bypass the held queue (a quit during
    // the compatibility window must not wait for a bind that never comes —
    // e.g. a cancelled startup).
    if (key.ctrl === true && key.name === 'c') return true
    if (key.ctrl === true && key.name === 'd' && composer.getDraft() === '') return true
    if (!inputBound) {
      if (heldKeys.length < HELD_KEYS_LIMIT) heldKeys.push(key)
      return false
    }
    return dispatchKey(key)
  }

  const inputLoop = (): void => {
    void (async () => { // allowlist: the mounted renderer's own loop — every rejection is caught and routed to onFatal/requestExit, never unhandled
      try {
        for await (const input of session) {
          if (disposed) return
          if (routeInput(input)) {
            if (exitRequested) continue
            exitRequested = true
            options.log?.('tsp renderer: exit key', { key: input.type === 'key' ? input.key.name : undefined })
            options.requestExit()
          }
        }
      } catch (error) {
        if (disposed) return
        // The tty owner died after mount: FATAL, never a normal exit — the
        // runner's fatal lifecycle owns the error outcome and cleanup.
        options.log?.('tsp renderer: input loop failed', { error: String(error) })
        if (!exitRequested) {
          exitRequested = true
          const fatal = options.onFatal
          if (fatal !== undefined) fatal(error)
          else options.requestExit()
        }
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
  /** The B0 INERT modal presenter: no form exists yet, so every ask rejects
   *  with the flow's cancellation error (never a fabricated answer). The
   *  fail-closed admission in the interaction runtime decides BEFORE this
   *  presenter is consulted; the rejects are the belt to that suspenders for
   *  any direct call. B3 replaces this with the real TSP presenter. */
  const inertInteraction: SurfaceInteractionPresenter = {
    showApprovalPrompt() { return Promise.reject(cancellationError('approval prompt cancelled')) },
    askQuestions() { return Promise.reject(cancellationError('question flow cancelled')) },
    setSettledQuestionAnswersLookup() {},
    notify(text, kind) { display.notify(text, kind) },
  }
  return {
    display,
    composer: composerPort,
    interaction: inertInteraction,
    bindInput: (handlers) => {
      if (disposed) throw new Error('the TSP renderer is disposed')
      if (inputBound) throw new Error('the TSP renderer input is already bound')
      inputBound = true
      boundHandlers = handlers
      // Consume the held pre-bind keys ONCE, in arrival order. An exit
      // intent among them (possible only if the draft emptied through held
      // edits — the legal PRE-bind Ctrl+C/Ctrl+D already acted) routes the
      // exit; the caller's handlers now observe every subsequent key.
      const held = heldKeys.splice(0, heldKeys.length)
      for (const key of held) {
        if (disposed) return
        if (dispatchKey(key)) {
          if (exitRequested) continue
          exitRequested = true
          options.log?.('tsp renderer: exit key (held)', { key: key.name })
          options.requestExit()
        }
      }
    },
    dispose: async () => {
      if (disposed) return
      disposed = true
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
 * Whether one decoded key is the EXIT intent (exported for tests): Ctrl+C
 * always; Ctrl+D only through the composer reducer's empty-draft branch. The
 * PR3-A read-only `q` quit retired when the composer became active — a typed
 * `q` is editor text now.
 */
export function isQuitKey(key: { readonly name: string; readonly ctrl?: boolean }): boolean {
  if (key.name === 'c') return key.ctrl === true
  return false
}
