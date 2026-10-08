/**
 * The experimental Tern TSP renderer session (PR3-A): the ONE physical-tty
 * owner when the composition root selects the TSP renderer, and the display
 * seam implementation that turns application display facts into official SDK
 * nodes.
 *
 * Ownership contract (plan PR3-A §3.1):
 *
 * - `connectTspRenderer()` runs the official `connect()` BEFORE PiTui could
 *   take stdin. `null` means the environment has no TSP (the composition root
 *   then mounts PiTui unchanged); a THROW is a startup failure on the
 *   runner's fatal path — never a fallback, never swallowed. Once the SDK
 *   session exists it is an OWNED resource: a mount failure closes it before
 *   re-raising (no leaked raw-mode stdin listener).
 * - The returned mount owns the SDK session for the whole process lifetime:
 *   ONE `inline` surface whose `main` region carries the live transcript and
 *   whose `dock` region carries the read-only banner, status facts, notices
 *   and the pending-input presentation. No `process.stdin.on`/`setRawMode`
 *   of our own — the SDK session owns the tty (its own exit hooks restore it
 *   on process exit/signals).
 * - The input loop consumes `for await (const input of session)`. Quit
 *   (Ctrl+C, Ctrl+D or `q`) routes through the injected `requestExit` — the
 *   SAME exit orchestration as `/exit`. A LOOP FAILURE (the tty owner died)
 *   routes through the injected `onFatal` — the runner's fatal lifecycle —
 *   never a normal exit code. Everything else is ignored (read-only).
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
import type { Node, Session, SessionInput, Surface } from '@stencil-hq/tern'
import type {
  DisplayDockNotice,
  DisplayStatusFacts,
  DisplayWelcomeFacts,
  SurfaceDisplaySeam,
} from '../../app/surface/display-seam.ts'
import type { PendingInputPresentation, PendingTailRow, QueueItem } from '../../app/surface/pending-presentation.ts'
import { projectTranscriptStructure } from '../transcript/structure.ts'
import type { TranscriptMessage, TurnActivity } from '../../domain/transcript/types.ts'
import type { TranscriptWindowState } from '../../domain/transcript/window.ts'
import type { TodoItem, TranscriptSearchPresentation } from '../../tui-app.ts'
import type { StreamingToolPreview } from '../../app/surface/streaming-tool-preparing.ts'
import { TranscriptNodeKeys, transcriptView } from './transcript-view.ts'

/** The banner the read-only renderer pins in its dock. */
const READ_ONLY_BANNER = 'DSH TSP renderer · experimental read-only · q / Ctrl+C quits'

/** The renderer-local dock state (banner + status facts + welcome + notices). */
interface DockState {
  statusLine: string
  notices: readonly DisplayDockNotice[]
  welcome: readonly DisplayWelcomeFacts[]
}

/** How many transient notices the dock keeps (oldest evicted). */
const NOTICE_LIMIT = 3

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
}

/** The mounted TSP renderer (the display seam + the one-shot disposer). */
export interface TspRenderer {
  readonly display: SurfaceDisplaySeam
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
  } catch (error) {
    // The session is an OWNED resource from the moment connect returned it:
    // a mount failure must not leak its raw-mode stdin listener.
    await session.close().catch(() => {})
    throw error
  }
}

/** Mount the renderer over an already-connected SDK session. */
export function mountTspRenderer(session: Session, options: TspRendererOptions): TspRenderer {
  let surface: Surface
  try {
    surface = session.open({ mode: 'inline', title: 'dsh' })
  } catch (error) {
    void session.close().catch(() => {})
    throw error
  }
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
  const dock: DockState = { statusLine: READ_ONLY_BANNER, notices: [], welcome: [] }
  const pending: { queued: readonly QueueItem[]; tail: readonly PendingTailRow[]; running: boolean } = { queued: [], tail: [], running: false }
  let viewerGeneration = 0

  /** Re-render both regions in ONE frame (the SDK diffs). */
  const render = (): void => {
    if (disposed) return
    const dockNode = dockView()
    const mainNode = lastMain
    surface.render({
      ...(mainNode === undefined ? {} : { main: mainNode }),
      ...(dockNode === undefined ? {} : { dock: dockNode }),
    })
  }

  const dockView = (): Node | undefined => {
    const lines: ReturnType<typeof ui.text>[] = []
    for (const facts of dock.welcome) {
      const model = facts.model === undefined ? '' : ` · ${facts.model}`
      lines.push(ui.text({ key: `welcome-${facts.sessionId}`, text: `DSH session ${facts.sessionId}${model}` }))
    }
    // The pending-input presentation IS visible on the read-only renderer:
    // the queue lane (authoritative queued + local echoes) and the ordered
    // conversation tail, exactly as the ONE join produced them.
    for (const item of pending.queued) {
      lines.push(ui.text({ key: `queue-${item.id}`, text: `queued (${item.mode}): ${item.text}` }))
    }
    for (const [index, row] of pending.tail.entries()) {
      lines.push(ui.text({ key: `tail-${index}`, text: pendingRowText(row, index) }))
    }
    if (pending.running && pending.queued.length === 0 && pending.tail.length === 0) {
      lines.push(ui.text({ key: 'pending-running', text: 'queued input is running…' }))
    }
    if (dock.statusLine !== '') lines.push(ui.text({ key: 'status', text: dock.statusLine }))
    for (const notice of dock.notices) {
      lines.push(ui.text({ key: `notice-${notice.id}`, text: notice.kind === 'error' ? `! ${notice.text}` : notice.text }))
    }
    if (lines.length === 0) return undefined
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
    dock.statusLine = parts.length === 0 ? READ_ONLY_BANNER : `${READ_ONLY_BANNER} · ${parts.join(' · ')}`
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

  // ── Input: quit routes the exit intent; a loop failure is FATAL ──
  const consumeInput = (input: SessionInput): boolean => {
    if (input.type !== 'key') return false
    return isQuitKey(input.key)
  }

  const inputLoop = (): void => {
    void (async () => {
      try {
        for await (const input of session) {
          if (disposed) return
          if (consumeInput(input)) {
            if (exitRequested) continue
            exitRequested = true
            options.log?.('tsp renderer: quit key', { key: input.type === 'key' ? input.key.name : undefined })
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
  return {
    display,
    dispose: async () => {
      if (disposed) return
      disposed = true
      try {
        await surface.close({ keep: false })
      } finally {
        // A close failure still restores the tty (the SDK's #finish runs in
        // its own finally); re-raise the FIRST error after both steps.
        await session.close()
      }
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

/** Whether one decoded key is the PR3-A quit intent (exported for tests). */
export function isQuitKey(key: { readonly name: string; readonly ctrl?: boolean }): boolean {
  if (key.name === 'c' || key.name === 'd') return key.ctrl === true
  return key.name === 'q'
}
