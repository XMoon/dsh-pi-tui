/**
 * The selected-Job workspace presenter (Phase 3B / B1-A): the typed Header,
 * the retained Output body, a transient notice row and the pinned bottom Action
 * Bar of the Job fullscreen workspace. The notice row renders the app's OWN live
 * notice (the ONE notice authority) while the workspace owns the terminal, so a
 * Stop settlement stays visible where the user is looking — never a second Stop
 * state.
 *
 * The panel IS the layout root and the keyboard focus target of the ONE
 * short-lived `TuiAltScreen` a Job view opens (the opener calls
 * `setLayoutRoot(panel)`), so no proxy component sits outside the mounted
 * layout tree. It holds no durable fact: every `update(state)` replaces the
 * whole frozen projection and asks the owning surface for a repaint. It never
 * observes a Job, reads a backend, owns a timer, or decides open/close —
 * `Esc` and the `tasks.stop` component action are intents injected by the
 * opener, and the Job's own `label` is never rewritten for anything but the
 * displayed one-line summary.
 *
 * The typed INPUT contract (`JobInspectorState` + its opening row) belongs to
 * the application owner that constructs it (`app/surface/task-runtime`, like
 * `TaskBrowserViewState`); this module owns the pure DISPLAY projection
 * (`JobInspectorView` / `deriveJobInspectorView`) and the component.
 *
 * @module @xmoon76/dsh-pi-tui/tui/panels/job-inspector-panel
 */

import { ScrollView, Text, VStack, matchesKey, truncateToWidth, visibleWidth, type Component } from '@xmoon76/pi-tui'
import { componentKeymap } from '../keybindings/component-keymap.ts'
import { color } from '../theme/runtime.ts'
import type { JobInspectorState } from '../../app/surface/task-runtime.ts'

/** The pure, non-authoritative display projection of the ONE captured state. */
export interface JobInspectorView {
  readonly jobId: string
  readonly kind: string
  readonly label: string
  readonly status: string
  readonly progress?: string
  readonly detail?: string
  readonly retainedText: string
  readonly gapBefore: boolean
  readonly settled: boolean
  readonly observationError?: string
  readonly phase: 'connecting' | 'observed' | 'unavailable'
}

/** Job kinds whose `label` is the shell command the Job was started with. */
const COMMAND_KINDS = new Set(['bash', 'pwsh'])

/** Below this width or row count the header collapses to at most TWO rows
 *  (plan §5 A1: "below 80×10"). */
const COMPACT_WIDTH = 80
const COMPACT_ROWS = 10

/** The Action Bar's own row — the ONE chrome row that is NEVER budgeted away. */
const ACTION_BAR_ROWS = 1
/** The plan's compact-header contract (§5): below 80×10 the header collapses to
 *  at most TWO rows. */
const COMPACT_HEADER_MAX_ROWS = 2
/** The full header's bounded row count (status, progress, detail, facts, command). */
const FULL_HEADER_MAX_ROWS = 5

/**
 * The ONE per-frame chrome plan of the workspace: the pinned Action Bar keeps
 * its row first, then the header (status + fact markers, then the Command/Label
 * summary, then the descriptive fact text), then the transient notice. Every
 * fixed child derives its row count from THIS plan, so no combination of a short
 * terminal and a live notice can ever push the Action Bar off the screen.
 */
interface JobInspectorChromePlan {
  readonly compact: boolean
  readonly headerRows: number
  readonly noticeRows: number
}

/** Derive the chrome plan for the CURRENT frame: pure in the live row grant, the
 *  rendered width and whether a notice is live. */
const planChrome = (
  width: number,
  rows: number,
  noticeLive: boolean,
): JobInspectorChromePlan => {
  const safeRows = Math.max(1, Math.floor(rows))
  const compact = width < COMPACT_WIDTH || safeRows < COMPACT_ROWS
  const budget = Math.max(0, safeRows - ACTION_BAR_ROWS)
  const headerMax = Math.min(compact ? COMPACT_HEADER_MAX_ROWS : FULL_HEADER_MAX_ROWS, budget)
  // The notice yields to the header and, together with everything else, to the
  // Action Bar: it only takes a row when the header can still have its own.
  const noticeRows = noticeLive && budget - headerMax >= 1 ? 1 : 0
  return { compact, headerRows: Math.max(0, Math.min(headerMax, budget - noticeRows)), noticeRows }
}

/** The retained-body placeholder of a phase with no `text` yet: three
 *  distinct statements, so "still connecting", "settled with nothing
 *  retained" and "the observation failed" can never be mistaken for each
 *  other. */
const BODY_CONNECTING = 'Waiting for retained output…'
const BODY_EMPTY = 'No retained output'
const BODY_UNAVAILABLE = 'Retained output unavailable'

/** The one line every phase shows at the physical bottom: the port's retained
 *  tail is a bounded preview, never the Job's full history. */
const RETAINED_NOTE = 'Retained preview · not full history'

/** The pure display fold of the ONE captured Job state. It answers exactly
 *  one question — what the user may see — and never re-derives authority: the
 *  observed snapshot (when present) is the ONLY source of Job metadata, and
 *  the opener row is a first-frame identity fallback. */
export function deriveJobInspectorView(state: JobInspectorState): JobInspectorView {
  const observed = state.observed
  if (observed !== undefined) {
    return {
      jobId: observed.jobId,
      kind: observed.kind,
      label: observed.label,
      status: observed.status,
      ...(observed.progress === undefined ? {} : { progress: observed.progress }),
      ...(observed.detail === undefined ? {} : { detail: observed.detail }),
      retainedText: observed.text,
      gapBefore: observed.gapBefore,
      settled: observed.settled,
      // A follow-stream error is NOT exclusive with a gap or a settlement:
      // the last good snapshot keeps its own facts (plan §4.2 rule 1).
      ...(observed.error === undefined ? {} : { observationError: observed.error }),
      phase: 'observed',
    }
  }
  if (state.observationError !== undefined) {
    // The port never opened a stream. Identity/status fall back to the row
    // this view was opened from, no retained output exists, and the reason
    // stays visible — never a fabricated "finished with no output".
    return {
      jobId: state.opening.jobId,
      kind: state.opening.kind,
      label: state.opening.label,
      status: state.opening.status,
      ...(state.opening.detail === undefined ? {} : { detail: state.opening.detail }),
      retainedText: '',
      gapBefore: false,
      settled: false,
      observationError: state.observationError,
      phase: 'unavailable',
    }
  }
  return {
    jobId: state.opening.jobId,
    kind: state.opening.kind,
    label: state.opening.label,
    status: state.opening.status,
    ...(state.opening.detail === undefined ? {} : { detail: state.opening.detail }),
    retainedText: '',
    gapBefore: false,
    settled: false,
    phase: 'connecting',
  }
}

/** The opener-injected intents. The panel owns no lifecycle of its own. */
export interface JobInspectorPanelIntents {
  /** The live physical row grant. The shell owns the terminal; the panel
   *  reads it per frame and never keeps a second `terminal.rows` copy. */
  readonly rows: () => number
  /** Repaint through the owning surface (the panel never paints itself). */
  readonly requestRender: () => void
  /** The app's LIVE transient notice (the ONE notice authority), read per frame.
   *  The workspace renders it on its OWN chrome row, so a Stop settlement stays
   *  visible without leaving the workspace — and no second notice state exists. */
  readonly notice: () => { readonly text: string; readonly kind: 'info' | 'error' } | undefined
  /** `Esc` — the opener's ONE close intent. */
  readonly onClose: () => void
  /** The live Stop capability (never a cached boolean). */
  readonly canStop: () => boolean
  /** The `tasks.stop` component action, dispatched only while `canStop()`. */
  readonly onStop: () => void
}

/** A raw `label`/`detail`/`error` is shown on ONE row: hard line breaks become
 *  spaces for DISPLAY only (the `View` keeps the original text). */
const oneLine = (text: string): string => text.replace(/\r?\n/g, ' ')

/** The bracketed fact markers of one view, in priority order: independent and
 *  co-visible, never a mutually exclusive status switch. */
const markerTokens = (view: JobInspectorView): string[] => [
  ...(view.gapBefore ? ['[GAP]'] : []),
  ...(view.observationError === undefined ? [] : ['[ERROR]']),
  ...(view.settled ? ['[SETTLED]'] : []),
]

/** The same markers as ONE row. */
const flagMarkers = (view: JobInspectorView): string => markerTokens(view).join(' ')

/** The DESCRIPTIVE facts of one view (the markers already say WHAT happened):
 *  the eviction note and the follow-stream error text. */
const flagTexts = (view: JobInspectorView): string => [
  ...(view.gapBefore ? ['Earlier output evicted'] : []),
  ...(view.observationError === undefined ? [] : [`error: ${oneLine(view.observationError)}`]),
].join('   ')

/** `${reserved}   ${flexText}` with the RESERVED head's room claimed FIRST, so a
 *  long flexible field is the ONLY thing a narrow row truncates. */
const withReservedHead = (reserved: string, flexText: string, width: number): string => {
  const room = width - visibleWidth(reserved) - 3
  return room >= 8 ? `${reserved}   ${truncateToWidth(flexText, room, '…')}` : reserved
}

/** `${prefix} · ${status}` with the STATUS's room claimed first, so a long Job
 *  identity can never push the status out of the row. */
const withReservedStatus = (prefix: string, status: string, width: number): string => {
  const room = width - visibleWidth(status) - 3
  return room >= 8 ? `${truncateToWidth(prefix, room, '…')} · ${status}` : status
}

/** The bounded typed header: Job identity, status, progress, the independent
 *  gap/error/settled facts, and the command-or-label identity. */
class JobInspectorHeader implements Component {
  private view: JobInspectorView
  private readonly plan: (width: number) => JobInspectorChromePlan

  constructor(view: JobInspectorView, plan: (width: number) => JobInspectorChromePlan) {
    this.view = view
    this.plan = plan
  }

  setView(view: JobInspectorView): void {
    this.view = view
  }

  render(width: number): string[] {
    const view = this.view
    const { compact, headerRows } = this.plan(width)
    if (headerRows <= 0) return []
    const kind = COMMAND_KINDS.has(view.kind) ? 'Command' : 'Label'
    const identity = `Job ${view.jobId} · ${view.kind}`
    const command = `${kind}: ${oneLine(view.label)}`
    const lines: string[] = []
    if (compact) {
      // TWO rows at most, in PRIORITY order. Row one carries the STATUS and every
      // fact marker (never shortened); row two carries the Command/Label summary
      // the locked UI always shows, followed by the descriptive fact text while the
      // row still has room for it — so the summary can never be displaced by a
      // GAP/ERROR description, and the identity prefix is kept only when it fits
      // beside the status.
      let head = view.status
      for (const marker of markerTokens(view)) {
        if (visibleWidth(head) + visibleWidth(marker) + 1 <= width) head += ` ${marker}`
      }
      const withIdentity = `${identity} · ${head}`
      lines.push(visibleWidth(withIdentity) <= width ? withIdentity : head)
      const facts = flagTexts(view)
      lines.push(facts === '' ? command : `${command}   ${facts}`)
    } else {
      // The identity never pushes the status out of its row, and the markers
      // never push the (unbounded) fact text out of theirs.
      lines.push(withReservedStatus(identity, view.status, width))
      if (view.progress !== undefined) lines.push(`progress: ${oneLine(view.progress)}`)
      if (view.detail !== undefined) lines.push(`detail: ${oneLine(view.detail)}`)
      const markers = flagMarkers(view)
      if (markers !== '') {
        const facts = flagTexts(view)
        lines.push(facts === '' ? markers : withReservedHead(markers, facts, width))
      }
      lines.push(command)
    }
    return lines.slice(0, headerRows).map(line => truncateToWidth(line, width, '…', true))
  }

  invalidate(): void {
    // Nothing cached: the view is the only input and the layout frame caches
    // per frame.
  }
}

/** The pinned bottom Action Bar: the effective `tasks.stop` hint (only while
 *  Stop is live) plus `Esc back`, degrading to `Esc back` alone when the row
 *  cannot carry more. It never follows the body. */
class JobInspectorActionBar implements Component {
  private readonly canStop: () => boolean

  constructor(canStop: () => boolean) {
    this.canStop = canStop
  }

  render(width: number): string[] {
    // The Stop verb comes from the SAME component keymap the handler matches;
    // it disappears the moment the live capability does.
    const stopKey = componentKeymap.keyHint('tasks.stop')
    const stop = this.canStop() && stopKey !== '' ? `${stopKey} stop · ` : ''
    const back = 'Esc back'
    const withNote = `${back}    ${RETAINED_NOTE}`
    const full = `${stop}${withNote}`
    const line = visibleWidth(full) <= width
      ? full
      : visibleWidth(withNote) <= width ? withNote : back
    return [truncateToWidth(line, width, '…', true)]
  }

  invalidate(): void {
    // Nothing cached.
  }
}

/** The app's live transient notice as ONE workspace chrome row: the row exists
 *  only while a notice is live (ZERO rows otherwise), so the pinned Action Bar
 *  always stays the last row. The wording/level come from the ONE notice
 *  authority (the app), never from a second Stop state. */
class JobInspectorNoticeRow implements Component {
  private readonly notice: () => { readonly text: string; readonly kind: 'info' | 'error' } | undefined
  private readonly plan: (width: number) => JobInspectorChromePlan

  constructor(
    notice: () => { readonly text: string; readonly kind: 'info' | 'error' } | undefined,
    plan: (width: number) => JobInspectorChromePlan,
  ) {
    this.notice = notice
    this.plan = plan
  }

  render(width: number): string[] {
    const live = this.notice()
    if (live === undefined || this.plan(width).noticeRows === 0) return []
    const line = live.kind === 'info' ? color.textDim(`ℹ ${live.text}`) : color.error(`✗ ${live.text}`)
    return [truncateToWidth(line, width, '…', true)]
  }

  invalidate(): void {
    // Nothing cached: the notice is read live on every frame.
  }
}

/** The retained-body text of one view (the ScrollView's only child). */
const bodyText = (view: JobInspectorView): string => {
  if (view.phase === 'unavailable') return BODY_UNAVAILABLE
  if (view.phase === 'connecting') return BODY_CONNECTING
  return view.retainedText === '' ? BODY_EMPTY : view.retainedText
}

/**
 * The Job workspace root: a fixed typed header, ONE primary follow-end
 * `ScrollView` over the retained body, and the fixed bottom Action Bar. It is
 * the `setLayoutRoot` root AND the keyboard focus target, so `Esc`/`tasks.stop`
 * arrive on its own {@link handleInput}.
 */
export class JobInspectorPanel extends VStack {
  private readonly header: JobInspectorHeader
  private readonly body: Text
  private readonly intents: JobInspectorPanelIntents
  private disposed = false

  constructor(initial: JobInspectorState, intents: JobInspectorPanelIntents) {
    const view = deriveJobInspectorView(initial)
    // The ONE chrome plan every fixed child derives its row count from: the Action
    // Bar first, then the header, then the notice.
    const plan = (width: number): JobInspectorChromePlan =>
      planChrome(width, intents.rows(), intents.notice() !== undefined)
    const header = new JobInspectorHeader(view, plan)
    const body = new Text('', 0, 0)
    body.setText(bodyText(view))
    const bar = new JobInspectorActionBar(intents.canStop)
    super([
      // Every fixed child renders AT MOST the rows the plan granted it (zero
      // included), so the pinned Action Bar can never be pushed off the screen;
      // the body absorbs whatever remains and may reach zero rows.
      { component: header, shrink: 0 },
      { component: new ScrollView(body, { follow: 'end', primary: true, scrollbar: 'auto' }), basis: 0, grow: 1 },
      // The transient notice row sits ABOVE the pinned Action Bar and renders
      // zero rows when nothing is live or the budget is too short.
      { component: new JobInspectorNoticeRow(intents.notice, plan), shrink: 0 },
      { component: bar, shrink: 0 },
    ])
    this.header = header
    this.body = body
    this.intents = intents
  }

  /** Replace the whole frozen projection with the latest captured state and
   *  ask the owning surface for one repaint. Inert after dispose(). */
  update(state: JobInspectorState): void {
    if (this.disposed) return
    const view = deriveJobInspectorView(state)
    this.header.setView(view)
    this.body.setText(bodyText(view))
    this.invalidate()
    this.intents.requestRender()
  }

  /** `Esc` closes the workspace; the `tasks.stop` component action fires only
   *  while the opener's live Stop capability holds. Every other key is inert:
   *  the Job workspace is read-only and never leaks into the original editor
   *  or transcript. */
  handleInput(data: string): void {
    if (this.disposed) return
    if (matchesKey(data, 'escape')) {
      this.intents.onClose()
      return
    }
    if (componentKeymap.matches(data, 'tasks.stop') && this.intents.canStop()) this.intents.onStop()
  }

  /** Make updates and intents inert. The owned children (the body text, the
   *  ScrollView) are released by the inherited container chain. */
  dispose(): void {
    this.disposed = true
    super.dispose()
  }
}
