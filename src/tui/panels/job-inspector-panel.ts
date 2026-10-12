/**
 * The selected-Job workspace presenter (Phase 3B / B1-A): the typed Header,
 * the retained Output body and the pinned bottom Action Bar of the Job
 * fullscreen workspace.
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

/** The rows the header always leaves outside itself: the bottom Action Bar
 *  and at least ONE body row. */
const HEADER_RESERVED_ROWS = 2

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

/** The bracketed fact markers of one view: independent and co-visible, never a
 *  mutually exclusive status switch. */
const flagMarkers = (view: JobInspectorView): string => [
  view.gapBefore ? '[GAP]' : '',
  view.observationError === undefined ? '' : '[ERROR]',
  view.settled ? '[SETTLED]' : '',
].filter(Boolean).join(' ')

/** The fact texts of one view, in the same order. With markers they stay
 *  terse (`[ERROR] <reason>`); without them each fact carries its own label
 *  (the short-terminal row has no marker to pair with). */
const flagDetails = (view: JobInspectorView, withMarkers: boolean): string => [
  view.gapBefore ? (withMarkers ? '[GAP] Earlier output evicted' : 'Earlier output evicted') : '',
  view.observationError === undefined
    ? ''
    : (withMarkers ? `[ERROR] ${oneLine(view.observationError)}` : `error: ${oneLine(view.observationError)}`),
  view.settled ? (withMarkers ? '[SETTLED]' : 'settled') : '',
].filter(Boolean).join('   ')

/** The bounded typed header: Job identity, status, progress, the independent
 *  gap/error/settled facts, and the command-or-label identity. */
class JobInspectorHeader implements Component {
  private view: JobInspectorView
  private readonly rows: () => number

  constructor(view: JobInspectorView, rows: () => number) {
    this.view = view
    this.rows = rows
  }

  setView(view: JobInspectorView): void {
    this.view = view
  }

  render(width: number): string[] {
    const view = this.view
    const rows = Math.max(1, Math.floor(this.rows()))
    const budget = Math.max(1, rows - HEADER_RESERVED_ROWS)
    const kind = COMMAND_KINDS.has(view.kind) ? 'Command' : 'Label'
    // The status + the fact markers are the two facts a short row must never
    // lose: they are assembled FIRST and the identity prefix is kept only when
    // it still fits beside them.
    const statusWithMarkers = flagMarkers(view) === '' ? view.status : `${view.status}  ${flagMarkers(view)}`
    const identity = `Job ${view.jobId} · ${view.kind} · `
    const command = `${kind}: ${oneLine(view.label)}`
    const lines: string[] = []
    if (width < COMPACT_WIDTH || rows < COMPACT_ROWS) {
      // Short/narrow terminal: at most TWO rows. The second row carries the fact
      // details when there are any, else the Command/Label identity (never a
      // body-injected error text).
      lines.push(
        visibleWidth(identity) + visibleWidth(statusWithMarkers) <= width
          ? `${identity}${statusWithMarkers}`
          : statusWithMarkers,
      )
      const details = flagDetails(view, false)
      lines.push(details !== '' ? details : command)
    } else {
      lines.push(`${identity}${view.status}`)
      if (view.progress !== undefined) lines.push(`progress: ${oneLine(view.progress)}`)
      if (view.detail !== undefined) lines.push(`detail: ${oneLine(view.detail)}`)
      const markers = flagDetails(view, true)
      if (markers !== '') lines.push(markers)
      lines.push(command)
    }
    return lines.slice(0, budget).map(line => truncateToWidth(line, width, '…', true))
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
    const header = new JobInspectorHeader(view, intents.rows)
    const body = new Text('', 0, 0)
    body.setText(bodyText(view))
    const bar = new JobInspectorActionBar(intents.canStop)
    super([
      // The pinned chrome never shrinks; the body absorbs the remainder and
      // may reach zero rows on a very short terminal.
      { component: header, shrink: 0 },
      { component: new ScrollView(body, { follow: 'end', primary: true, scrollbar: 'auto' }), basis: 0, grow: 1 },
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
