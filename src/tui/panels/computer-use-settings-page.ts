/**
 * The `Settings → Tools → Computer Use` specialist page (PR-5 / MAC-09 v2,
 * SUX-08 grouped Overview + Applications workbench).
 *
 * ONE embedded page inside the existing Settings workspace lease:
 *
 * - `Overview` is a Standard grouped Detail tenant: ONE continuous semantic
 *   line model (Availability → Permissions → Authorization → Application
 *   access → Help/Recovery) inside the real Detail pane. The same model paints
 *   the normal and the short grant; a short grant only drops optional
 *   explanatory prose, never a fact or an action.
 * - `Applications` is the existing Adaptive Workbench grant: the page's own
 *   local List/Detail projection (grouped `Always allowed` / `Refused`) inside
 *   the Root's ONE chrome, seat and physical Action Bar.
 * - A dangerous confirmation is the ONE full-width sub-view (persistent PTC,
 *   revoke, ask again); its complete risk + exact target must be visible in the
 *   SAME frame before the confirm verb exists.
 *
 * Every action forwards to the per-open {@link CuaAccessSettingsController} and
 * carries the exact observation/target capture it was painted against. The page
 * owns only transient presentation state (mode, local selection, scroll,
 * confirmation, help) and dies with the page instance; it never holds a second
 * permission/application authority.
 *
 * Safety rules pinned here:
 *  - an action requires the CURRENT painted frame (observation revision +
 *    projection identity) and a live re-proof of its target;
 *  - the confirmation is its OWN projection: risk + target + confirm verb must
 *    be complete in the same grant, otherwise only Cancel exists;
 *  - hit targets are the exact semantic verb spans the frame really painted,
 *    never a bracket-text re-scan and never the fitted padding;
 *  - a short grant never duplicates a permission action: it scrolls.
 *
 * @module @xmoon76/dsh-pi-tui/tui/panels/computer-use-settings-page
 */

import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@xmoon76/pi-tui'
import { runDetached } from '../../runtime/process/tasks.ts'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import {
  cuaActionAdmitted,
  type CuaAccessSettingsController,
  type CuaAccessSettingsSnapshot,
  type CuaActionCapture,
  type CuaReadState,
} from '../../app/command/cua-access-settings.ts'
import type { CuaApplicationFact, CuaPermission, CuaSystemStatus } from '../../runtime/cua-access-port.ts'
import { layoutActionBarRow, type ActionBarSegment } from '../presentation/action-bar.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { color } from '../theme/runtime.ts'
import type { EmbeddedSpecialistPage, SpecialistParentLeaveTarget, WebWorkbenchGrant } from './settings-workspace-panel.ts'

/** The page title (also the Tools row label and breadcrumb tail). */
export const COMPUTER_USE_PAGE_TITLE = 'Computer Use'

type PageMode = 'overview' | 'applications'
type ListRegion = 'list' | 'detail'
type ApplicationGroup = 'allowed' | 'refused'

type PageActionKind =
  | 'refresh'
  | 'help'
  | 'plugins'
  | 'request'
  | 'open'
  | 'preset'
  | 'persistent-ptc'
  | 'manage'
  | 'open-application'
  | 'revoke'
  | 'retry'

/** ONE painted action. `capture` is present for every controller-owned write. */
interface PageAction {
  readonly id: string
  readonly kind: PageActionKind
  readonly capture?: CuaActionCapture
}

type LineTone = 'strong' | 'fact' | 'dim' | 'muted' | 'warning' | 'error'

interface PageLine {
  readonly text: string
  readonly tone?: LineTone
  /** A `Label: ` prefix painted `textDim` while the value keeps its own tone. */
  readonly label?: string
  /** A complete painted verb (and its exact cell span in this physical line). */
  readonly action?: PageAction
  readonly span?: { readonly startCol: number; readonly endCol: number }
  /** A selectable application row (selection only; never a business action). */
  readonly select?: { readonly group: ApplicationGroup; readonly id: string }
  /** Optional explanation: dropped only when a short grant cannot hold the
   *  essential facts. Never a fact, action or recovery path. */
  readonly detail?: boolean
  /** A weak section heading attached to its populated group. It is optional
   *  presentation: a short grant omits it entirely rather than deferring a
   *  standalone label to the prose tail. */
  readonly heading?: boolean
}

type PaintedTarget =
  | { readonly kind: 'action'; readonly row: number; readonly startCol: number; readonly endCol: number; readonly action: PageAction }
  | { readonly kind: 'select'; readonly row: number; readonly startCol: number; readonly endCol: number; readonly group: ApplicationGroup; readonly id: string }
  | { readonly kind: 'focus'; readonly row: number; readonly startCol: number; readonly endCol: number; readonly region: ListRegion }

interface BarSpan {
  readonly id: string
  readonly startCol: number
  readonly endCol: number
}

interface Paint {
  readonly width: number
  /** The body rows painted WITHOUT the one physical bar. */
  readonly bodyRows: number
  /** The complete painted bar width (workbench grant barWidth; detail width). */
  readonly bodyWidth: number
  readonly identity: string
  readonly targets: readonly PaintedTarget[]
  readonly barSpans: readonly BarSpan[]
  readonly escapeSpan?: { readonly startCol: number; readonly endCol: number }
}

interface Confirmation {
  readonly action: PageAction
  readonly title: string
  readonly risk: string
  /** The complete exact target facts (identity, decision, consequence). */
  readonly target: readonly string[]
  readonly confirm: string
  readonly epoch: number
  /** The local view the decision returns to after cancel/settlement. */
  readonly returnMode: PageMode
  readonly returnRegion: ListRegion
  offset: number
}

interface BarRender {
  readonly text: string
  readonly spans: readonly BarSpan[]
  readonly escapeSpan?: { readonly startCol: number; readonly endCol: number }
}

const HELP_LINES = [
  'Why two permissions? Accessibility reads and operates UI controls; Screen Recording captures the selected application window. They are separate and neither implies the other.',
  'Which .app should I authorize? The official helper named above (DSH Computer Use.app), not tmux, Terminal, an editor, or the Client machine\'s shell.',
  'I opened the TUI on another computer. The permission prompts belong to the Host Mac. The Client machine cannot grant them.',
  'Is the macOS automation list relevant? No. Automation/Apple Events permission is a different control path; it is not the official Computer Use helper permission.',
  'Request did not make it Allowed. Request only asks the Host provider to open its guidance. Complete the macOS prompt on the Host Mac, then Refresh and read the fresh observation.',
  'What is the difference between revoking an application and disabling the bundle? Revoke removes that persisted application decision; disabling the bundle removes the Computer Use provider from this profile and stops new CUA calls. Neither clears macOS TCC permissions.',
]

const PERMISSION_LABEL: Readonly<Record<CuaPermission, string>> = {
  accessibility: 'Accessibility',
  screenRecording: 'Screen Recording',
}

const PERMISSION_EXPLANATION: Readonly<Record<CuaPermission, string>> = {
  accessibility: 'Reads and operates UI controls.',
  screenRecording: 'Captures the selected application window.',
}

/** Fit one painted line to exactly `width` display cells (no overflow). */
function fit(text: string, width: number): string {
  if (width <= 0) return ''
  const clamped = truncateToWidth(text, width, '…', false)
  const padding = width - visibleWidth(clamped)
  return padding > 0 ? clamped + ' '.repeat(padding) : clamped
}

/** Slice a string by display cells; used to paint semantic role spans. */
function sliceCells(text: string, start: number, end: number): string {
  if (end <= start) return ''
  let out = ''
  let col = 0
  for (const char of text) {
    const width = Math.max(1, visibleWidth(char))
    const next = col + width
    if (next > start && col < end) out += char
    col = next
    if (col >= end) break
  }
  return out
}

/** Wrap one physical text line by display cells; long unbreakable tokens split. */
function wrapText(text: string, width: number): string[] {
  if (width <= 0) return ['']
  const clean = sanitizedPhysicalLine(text)
  if (clean === '') return ['']
  const lines: string[] = []
  let current = ''
  for (const char of clean) {
    if (visibleWidth(current + char) > width) {
      lines.push(current)
      current = char
    } else {
      current += char
    }
  }
  lines.push(current)
  return lines
}

function readPhaseText<T>(read: CuaReadState<T>, fallback = 'Unknown'): string {
  switch (read.phase) {
    case 'idle': return 'Not read'
    case 'loading': return 'Reading…'
    case 'disabled': return 'Not queried (bundle disabled)'
    case 'unavailable': return 'Unavailable'
    case 'failed': return 'Read failed'
    case 'unknown': return 'Unknown'
    case 'ready': return fallback
  }
}

function permissionText(allowed: boolean): string {
  return allowed ? 'Allowed' : 'Not allowed'
}

function systemOf(snapshot: CuaAccessSettingsSnapshot): CuaSystemStatus | undefined {
  return snapshot.system.phase === 'ready' ? snapshot.system.value : undefined
}

function platformName(status: CuaSystemStatus | undefined): string {
  if (status === undefined) return 'Unknown'
  return status.platform === 'darwin' ? 'macOS' : 'Unsupported platform (win32)'
}

function responsibleApplication(status: CuaSystemStatus | undefined): string {
  if (status === undefined || status.platform !== 'darwin') return 'Unknown'
  return status.launchApplication === undefined
    ? 'Not reported by macOS (responsibility unknown)'
    : `${sanitizedPhysicalLine(status.launchApplication.name)} · ${sanitizedPhysicalLine(status.launchApplication.path)}`
}

function helperIdentity(status: CuaSystemStatus | undefined): string {
  if (status === undefined) return 'Unknown'
  return status.platform === 'win32'
    ? `${sanitizedPhysicalLine(status.helper.name ?? 'helper')} · pid ${String(status.helper.pid)}`
    : `${sanitizedPhysicalLine(status.helper.name ?? 'DSH Computer Use')} · pid ${String(status.helper.pid)}`
}

function applicationName(application: CuaApplicationFact): string {
  return sanitizedPhysicalLine(application.name)
}

function applicationIdentity(application: CuaApplicationFact): string {
  const name = applicationName(application)
  return application.executablePath === undefined
    ? name
    : `${name} · ${sanitizedPhysicalLine(application.executablePath)}`
}

/** ONE embedded page; constructed only when the Settings lease opens it. */
export class ComputerUseSettingsPage implements EmbeddedSpecialistPage {
  private readonly controller: CuaAccessSettingsController
  private readonly requestRender: () => void
  private readonly done: () => void
  private readonly openPlugins: (() => void) | undefined
  private readonly diag: Diag
  private readonly unsubscribe: () => void

  readonly title = COMPUTER_USE_PAGE_TITLE
  focused = false

  // ── grants ───────────────────────────────────────────────────────────────
  /** The Standard Detail tenant grant: body rows PLUS the one physical bar. */
  private detailGrant = 1
  /** The body rows of the LAST render: a zero-body frame paints only its safe
   *  bar, and no key the bar did not advertise may run an action. */
  private lastBodyRows = 0
  /** The Adaptive Workbench grant of the CURRENT frame, when that projection
   *  is live. The Root installs it before every render. */
  private workbenchGrant: WebWorkbenchGrant | undefined
  private grantAwaitingPaintValue = true

  // ── page-local presentation ──────────────────────────────────────────────
  private mode: PageMode = 'overview'
  private listRegion: ListRegion = 'list'
  private selection: { readonly group: ApplicationGroup; readonly id: string } | undefined
  private overviewCursor = 0
  private overviewOffset = 0
  private listOffset = 0
  private detailOffset = 0
  private confirmation: Confirmation | undefined
  private confirmationVisible = false
  private help = false
  private notice: { readonly kind: 'info' | 'error'; readonly text: string } | undefined
  /** The receipt/notice the last Overview frame revealed. A NEW abnormal fact
   *  moves the scrollport to itself once; an ordinary browse never jumps. */
  private revealedActionAt: number | undefined
  private revealedNotice: string | undefined
  private disposed = false
  private revision = 0
  private paint: Paint | undefined
  private overviewActions: PageAction[] = []
  private overviewActionRows: number[] = []
  private detailActions: PageAction[] = []
  private visibleActionIds = new Set<string>()
  /** Applications help is REAL content (never an invisible Esc step). */
  private helpOffset = 0
  /** Whether the LAST published list targets really contain the selected row
   *  (computed from the final painted result, never re-derived at admission). */
  private paintedListSelection = false
  /** The last settled action revealed in the workbench (one reveal per result). */
  private revealedWorkbenchActionAt: number | undefined
  private pressed: { readonly identity: string; readonly target: PaintedTarget } | undefined
  private paintedBarSpansValue: readonly BarSpan[] = []
  private paintedEscapeSpanValue: { readonly startCol: number; readonly endCol: number } | undefined

  constructor(intents: {
    readonly controller: CuaAccessSettingsController
    readonly requestRender: () => void
    readonly done: () => void
    readonly openPlugins?: () => void
    readonly diag: Diag
  }) {
    this.controller = intents.controller
    this.requestRender = intents.requestRender
    this.done = intents.done
    this.openPlugins = intents.openPlugins
    this.diag = intents.diag
    this.unsubscribe = this.controller.subscribe(() => {
      // Retire an invalidated full-width risk BEFORE the next Root compose, so
      // the Root never chooses the stale grant for a page that already returned
      // to its normal projection. The subscription is the ONE owner of this
      // transition; render itself never changes the projection.
      const snapshot = this.controller.getSnapshot()
      if (this.confirmation !== undefined && this.confirmation.epoch !== snapshot.epoch) {
        this.mode = this.confirmation.returnMode
        this.listRegion = this.confirmation.returnRegion
        this.confirmation = undefined
        this.confirmationVisible = false
        this.pressed = undefined
        this.notice = { kind: 'info', text: 'The Host observation changed; the confirmation was discarded. Review the current state and act again.' }
      }
      this.revision += 1
      this.requestRender()
    })
    this.start('computer use settings refresh', () => this.controller.refresh(true))
  }

  /**
   * Start one controller intent from a synchronous input/paint handler.
   *
   * The handler cannot await, so the intent becomes a detached task with a real
   * owner: a failure reaches the runner diagnostics instead of becoming an
   * unhandled rejection, while the controller still publishes the action's own
   * outcome (ok / failed / unknown) into the snapshot.
   */
  private start(label: string, intent: () => Promise<void>): void {
    runDetached(label, intent, { diag: this.diag })
  }

  // ── EmbeddedSpecialistPage: grants and Root contracts ───────────────────

  setMaxRows(rows: number): void {
    const next = Math.max(1, Math.floor(rows))
    if (next === this.detailGrant) return
    this.detailGrant = next
    this.revokeGrant()
  }

  setWebWorkbenchGrant(grant: WebWorkbenchGrant): void {
    const previous = this.workbenchGrant
    this.workbenchGrant = grant
    if (previous === undefined
      || previous.width !== grant.width
      || previous.rows !== grant.rows
      || previous.barWidth !== grant.barWidth
      || previous.allowDual !== grant.allowDual) {
      this.revokeGrant()
    }
  }

  grantAwaitingPaint(): boolean {
    return this.grantAwaitingPaintValue
  }

  pointerFrameCurrent(): boolean {
    return this.frameCurrent()
  }

  paintedEscapeSpan(): { readonly startCol: number; readonly endCol: number } | undefined {
    return this.paintedEscapeSpanValue
  }

  paintedBarSpans(): readonly BarSpan[] {
    return this.paintedBarSpansValue
  }

  activateBarSpan(id: string): void {
    if (!this.frameCurrent()) return
    switch (id) {
      case 'bar:refresh':
        this.refresh()
        return
      case 'bar:help':
        this.help = !this.help
        if (this.help) this.helpOffset = 0
        this.bump()
        return
      case 'bar:open':
        this.openSelectedApplication()
        return
      case 'bar:confirm':
        this.confirmCurrent()
        return
      default:
        return
    }
  }

  /** SUX-08: the page's CURRENT projection is the Adaptive Workbench (the
   *  Applications view or a dangerous confirmation). The Root reads this live
   *  from the mounted page and never caches a second local view state. */
  embeddedWorkbenchActive(): boolean {
    return this.mode === 'applications' || this.confirmation !== undefined
  }

  webWorkbenchRegion(): 'list' | 'detail' {
    return this.listRegion
  }

  webWorkbenchBlocksParentNavigation(): boolean {
    return this.confirmation !== undefined || this.controller.getSnapshot().busy
  }

  webWorkbenchCanYieldToRail(): boolean {
    return this.mode === 'applications'
      && this.confirmation === undefined
      && this.listRegion === 'list'
      && !this.controller.getSnapshot().busy
  }

  workbenchRequiresFullWidth(): boolean {
    return this.confirmation !== undefined
  }

  /**
   * SUX-08: the Applications list/rail Back is a LOCAL return to the same
   * mounted Overview instance (one controller, one lease, no dispose/remount).
   * A confirmation or an accepted action keeps the page.
   */
  leaveEmbeddedWorkbench(): boolean {
    if (this.mode !== 'applications' || this.webWorkbenchBlocksParentNavigation()) return false
    this.mode = 'overview'
    this.listRegion = 'list'
    this.confirmation = undefined
    this.pressed = undefined
    this.bump()
    return true
  }

  blocksParentNavigation(): boolean {
    return this.confirmation !== undefined || this.controller.getSnapshot().busy
  }

  /**
   * The ONE guarded parent leave of the hosted Detail tenant. A confirmation
   * or an accepted action owns the page; an ordinary browse (including an
   * unknown receipt that is already painted) leaves without a write.
   */
  requestParentLeave(_target: SpecialistParentLeaveTarget, _leave: () => void): 'allow' | 'refuse' {
    // `allow` is a QUERY: the Root's ONE leave transaction owns the continuation.
    // A page that opens its own question returns `refuse` and calls the captured
    // continuation only after the user really confirms; a clean page never calls
    // it itself (which would close/apply the same leave twice).
    if (this.webWorkbenchBlocksParentNavigation()) return 'refuse'
    this.pressed = undefined
    return 'allow'
  }

  gestureIdentity(): string {
    return [
      'computer-use',
      this.mode,
      this.listRegion,
      this.selection?.group ?? '-',
      this.selection?.id ?? '-',
      this.revision,
      this.overviewCursor,
      this.overviewOffset,
      this.listOffset,
      this.detailOffset,
      this.help ? 'help' : 'no-help',
      this.confirmation?.title ?? 'no-confirm',
      this.confirmation?.offset ?? 0,
      this.notice?.text ?? 'no-notice',
    ].join('|')
  }

  /** Revoke one in-flight body press when another owner claims the gesture
   *  (the Root calls this on a focus/seat handoff or an active wheel). */
  cancelPointer(): void {
    this.pressed = undefined
  }

  invalidate(): void {
    this.bump()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.controller.close()
    this.paint = undefined
    this.pressed = undefined
    this.overviewActions = []
    this.visibleActionIds.clear()
    this.paintedBarSpansValue = []
    this.paintedEscapeSpanValue = undefined
  }

  // ── rendering ────────────────────────────────────────────────────────────

  render(width: number): string[] {
    const snapshot = this.controller.getSnapshot()
    this.grantAwaitingPaintValue = false
    const frame = this.mode === 'overview' && this.confirmation === undefined
      ? this.renderOverview(snapshot, width)
      : this.renderWorkbench(snapshot, width)
    this.paint = {
      width,
      bodyRows: frame.bodyRows,
      bodyWidth: frame.bodyWidth,
      identity: this.gestureIdentity(),
      targets: frame.targets,
      barSpans: frame.bar.spans,
      ...(frame.bar.escapeSpan === undefined ? {} : { escapeSpan: frame.bar.escapeSpan }),
    }
    this.paintedBarSpansValue = frame.bar.spans
    this.paintedEscapeSpanValue = frame.bar.escapeSpan
    return frame.lines
  }

  paneHeader(width: number): string {
    if (this.mode === 'overview' && this.confirmation === undefined) {
      return this.focused
        ? color.textStrong(`[${COMPUTER_USE_PAGE_TITLE}]`, 'primary')
        : color.textDim(COMPUTER_USE_PAGE_TITLE)
    }
    if (this.workbenchRequiresFullWidth()) {
      return this.focused
        ? color.textStrong(`[${COMPUTER_USE_PAGE_TITLE}]`, 'primary')
        : color.textDim(COMPUTER_USE_PAGE_TITLE)
    }
    if (this.paintsBothRegions()) {
      const listActive = this.focused && this.listRegion === 'list'
      const detailActive = this.focused && this.listRegion === 'detail'
      const listWidth = this.listColumnWidth(width)
      const detailWidth = Math.max(1, width - listWidth - 2)
      const left = listActive
        ? color.textStrong('[Applications]', 'primary')
        : color.textDim('Applications')
      const right = detailActive
        ? color.textStrong('[Application]', 'primary')
        : color.textDim('Application')
      return fit(`${fit(left, listWidth)}${' '.repeat(2)}${fit(right, detailWidth)}`, width)
    }
    const label = this.listRegion === 'list' ? 'Applications' : 'Application'
    return this.focused
      ? color.textStrong(`[${label}]`, 'primary')
      : color.textDim(label)
  }

  // ── Overview (Standard grouped Detail tenant) ────────────────────────────

  private renderOverview(snapshot: CuaAccessSettingsSnapshot, width: number): {
    readonly lines: string[]
    readonly bodyRows: number
    readonly bodyWidth: number
    readonly bar: BarRender
    readonly targets: readonly PaintedTarget[]
  } {
    const bodyRows = Math.max(0, this.detailGrant - 1)
    const lines = this.buildOverview(snapshot, width, bodyRows)
    const actionLines = lines
      .map((line, index) => line.action === undefined ? undefined : { line, index })
      .filter((candidate): candidate is { line: PageLine; index: number } => candidate !== undefined)
    this.overviewActionRows = actionLines.map(candidate => candidate.index)
    this.overviewActions = actionLines.map(candidate => candidate.line.action!)
    this.overviewCursor = Math.max(0, Math.min(this.overviewCursor, Math.max(0, this.overviewActions.length - 1)))
    const receiptAt = snapshot.action?.at
    const noticeText = this.notice?.text
    if (receiptAt !== this.revealedActionAt || noticeText !== this.revealedNotice) {
      this.revealedActionAt = receiptAt
      this.revealedNotice = noticeText
      // A new action receipt / notice is an abnormal fact the user must see:
      // move the scrollport so that fact's own lines are visible in THIS grant.
      const prefixes = receiptAt !== undefined
        ? ['Action:', 'Action outcome unconfirmed:', 'Action failed:']
        : noticeText !== undefined ? ['Notice:', 'Error:'] : []
      const index = lines.findIndex(line => prefixes.some(prefix => line.text.startsWith(prefix)))
      if (index >= 0) this.overviewOffset = index
    }
    const maxOffset = Math.max(0, lines.length - bodyRows)
    this.overviewOffset = Math.max(0, Math.min(this.overviewOffset, maxOffset))
    const visible = lines.slice(this.overviewOffset, this.overviewOffset + bodyRows)
    const targets: PaintedTarget[] = []
    const out: string[] = []
    this.visibleActionIds.clear()
    const selectedAction = this.overviewActions[this.overviewCursor]
    for (let index = 0; index < bodyRows; index += 1) {
      const line = visible[index]
      if (line === undefined) {
        out.push(fit('', width))
        continue
      }
      // The active device: the selected body action paints the `> ` cursor in
      // place of its two-space indent (same cell budget, same span).
      const withCursor = line.action !== undefined && line.action === selectedAction
        ? `> ${line.text.startsWith('  ') ? line.text.slice(2) : line.text.trimStart()}`
        : line.text
      const semantic = this.paintLine({ ...line, text: withCursor })
      out.push(fit(semantic, width))
      if (line.action !== undefined && line.span !== undefined && line.action === selectedAction) {
        this.visibleActionIds.add(line.action.id)
        targets.push({
          kind: 'action',
          row: index,
          startCol: line.span.startCol,
          endCol: line.span.endCol,
          action: line.action,
        })
      } else if (line.action !== undefined && line.span !== undefined) {
        // A non-selected painted action is still a pointer target (the click
        // selects AND activates that exact painted verb).
        targets.push({
          kind: 'action',
          row: index,
          startCol: line.span.startCol,
          endCol: line.span.endCol,
          action: line.action,
        })
      }
    }
    this.lastBodyRows = bodyRows
    const bar = this.renderOverviewBar(width, snapshot, bodyRows)
    return { lines: [...out, fit(bar.text, width)], bodyRows, bodyWidth: width, bar, targets }
  }

  /** The ONE continuous Overview model. Order and priority are frozen; a short
   *  grant drops optional prose only. */
  private buildOverview(snapshot: CuaAccessSettingsSnapshot, width: number, bodyRows: number): PageLine[] {
    const lines: PageLine[] = []
    const shortGrant = bodyRows < 10
    const push = (text: string, options: Omit<PageLine, 'text'> = {}): void => {
      lines.push({ text, ...options })
    }
    const pushWrapped = (text: string, options: Omit<PageLine, 'text' | 'label'> = {}): void => {
      const room = options.detail === true ? Math.min(width, 72) : width
      for (const part of wrapText(text, room)) push(part, options)
    }
    const pushFact = (label: string, value: string, tone: LineTone = 'fact'): void => {
      for (const part of wrapText(`${label}: ${value}`, width)) {
        push(part, { tone, label: part.startsWith(`${label}:`) ? `${label}: ` : undefined })
      }
    }
    const pushAction = (verb: string, action: PageAction): void => {
      const text = `  ${verb}`
      if (visibleWidth(text) > width) return
      push(text, { action, span: { startCol: 2, endCol: 2 + visibleWidth(verb) } })
    }
    const pushHeading = (text: string): void => {
      push(text, { tone: 'dim', detail: true, heading: true })
    }
    const capture = (kind: CuaActionCapture['kind'], extra: Partial<CuaActionCapture> = {}): CuaActionCapture =>
      ({ epoch: snapshot.epoch, kind, ...extra })
    const admitted = (candidate: CuaActionCapture): boolean => cuaActionAdmitted(snapshot, candidate).ok
    const busy = snapshot.busy
    const bundle = snapshot.bundle
    const providerReady = bundle.phase === 'ready' && bundle.enabled && bundle.providerReady

    // 1. Availability
    pushHeading('Availability')
    switch (bundle.phase) {
      case 'idle':
        pushFact('Bundle', 'Not read', 'dim')
        break
      case 'loading':
        pushFact('Bundle', 'Reading…', 'dim')
        break
      case 'disabled':
        pushFact('Bundle', 'Disabled', 'warning')
        break
      case 'unknown':
        pushFact('Bundle', 'Unknown', 'warning')
        break
      case 'ready':
        pushFact('Bundle', bundle.providerReady ? 'Enabled · provider ready' : 'Enabled · provider unavailable', bundle.providerReady ? 'fact' : 'warning')
        break
    }
    if (bundle.error !== undefined && bundle.error !== '') pushWrapped(bundle.error, { detail: true })
    if (bundle.phase === 'disabled' || bundle.phase === 'unknown' || (bundle.phase === 'ready' && !bundle.providerReady)) {
      if (bundle.reason !== undefined && bundle.reason !== bundle.error) pushWrapped(bundle.reason, { detail: true })
      pushWrapped('Enable the official bundle in Settings → Plugins; this page starts no CUA query while it is disabled or the provider is unavailable.', { detail: true })
      if (!busy) pushAction('Open Settings → Plugins', { id: 'plugins', kind: 'plugins' })
    }
    const system = systemOf(snapshot)
    pushFact('Host', platformName(system), system === undefined ? 'dim' : 'fact')
    if (system?.platform === 'darwin') {
      // The real responsible application is a first-class fact of the scrollport
      // (it is what the user must authorize in macOS), but it must never push
      // the first missing permission/action off a 4-row first screen.
      for (const part of wrapText(`Responsible app: ${responsibleApplication(system)}`, width)) {
        push(part, { tone: 'dim', label: 'Responsible app: ', detail: true })
      }
      for (const part of wrapText(`Helper: ${helperIdentity(system)}`, width)) {
        push(part, { tone: 'dim', label: 'Helper: ', detail: true })
      }
      for (const part of wrapText(`Helper parent: ${sanitizedPhysicalLine(system.parent.path ?? system.parent.name ?? 'Unknown')}`, width)) {
        push(part, { tone: 'dim', label: 'Helper parent: ', detail: true })
      }
    }
    if (system?.platform === 'win32') {
      pushWrapped('This page manages the official macOS Computer Use provider only; this Host cannot grant Accessibility or Screen Recording.', { detail: true })
      if (!busy) pushAction('Open Settings → Plugins', { id: 'plugins', kind: 'plugins' })
    }
    if (system === undefined && ['unavailable', 'failed', 'unknown'].includes(snapshot.system.phase)) {
      pushFact('Provider', snapshot.system.reason ?? readPhaseText(snapshot.system), 'warning')
      pushWrapped('The official permission facts are unavailable; no permission can be granted or revoked from this frame.', { detail: true })
      if (!busy) pushAction('Open Settings → Plugins', { id: 'plugins', kind: 'plugins' })
    }

    // 2. Permissions. The heading belongs to the group only when the real
    // permission facts exist; an unsupported/non-ready Host gets no empty
    // heading. Missing-first keeps the first missing permission and its action
    // on the first screen.
    const permissionsStart = lines.length
    if (providerReady && system?.platform === 'darwin') {
      const groups = ([
        { permission: 'accessibility' as const, allowed: system.accessibility },
        { permission: 'screenRecording' as const, allowed: system.screenRecording },
      ]).sort((left, right) => Number(left.allowed) - Number(right.allowed))
      for (const group of groups) {
        pushFact(PERMISSION_LABEL[group.permission], permissionText(group.allowed), group.allowed ? 'fact' : 'warning')
        if (!busy) {
          const request = capture('request', { permission: group.permission })
          if (admitted(request)) {
            pushAction(group.allowed ? 'Request again' : 'Request permission', {
              id: `request:${group.permission}`,
              kind: 'request',
              capture: request,
            })
          }
          const open = capture('open', { permission: group.permission })
          if (admitted(open)) {
            pushAction('Open settings', {
              id: `open:${group.permission}`,
              kind: 'open',
              capture: open,
            })
          }
        }
        // The optional explanation follows the fact and its actions.
        pushWrapped(PERMISSION_EXPLANATION[group.permission], { detail: true })
      }
      if (!system.accessibility || !system.screenRecording) {
        pushWrapped('Complete the macOS prompt on the HOST Mac, then Refresh and read the fresh observation.', { detail: true })
      }
    }
    if (lines.length > permissionsStart) lines.splice(permissionsStart, 0, {
      text: 'Permissions', tone: 'dim', detail: true, heading: true,
    })

    // 3. Authorization. The heading is present only when this Host really
    // exposes the preset/PTC facts; a short grant omits the optional heading
    // instead of deferring it to the prose tail.
    const authorizationStart = lines.length
    if (providerReady && system?.platform !== 'win32') {
      if (snapshot.preset.phase === 'ready') {
        const value = snapshot.preset.value ?? 'unknown'
        pushFact('New Sessions', value === 'ptc' ? 'ptc (PTC is the saved default)' : value)
        if (!snapshot.preset.available) pushWrapped('The saved default preset is not available on this Host.', { detail: true })
        else if (snapshot.preset.decision === undefined) {
          pushWrapped('The Host preset authority cannot be proven right now; no default can be saved.', { detail: true })
        } else if (!busy) {
          const preset = capture('preset')
          if (admitted(preset)) {
            pushAction('Set PTC default', { id: 'preset', kind: 'preset', capture: preset })
          }
        }
      } else {
        pushFact('New Sessions', snapshot.preset.reason ?? 'Read failed', 'warning')
      }
      const ptc = snapshot.ptc.phase === 'ready' ? snapshot.ptc.value : undefined
      if (ptc !== undefined) {
        pushFact('PTC execution', `${ptc.persistent ? 'Persistent' : 'Non-persistent'}${ptc.writable ? '' : ' (read-only)'}`)
        if (!busy) {
          const persistent = capture('persistent-ptc')
          if (admitted(persistent)) {
            pushAction('Persistent PTC mode…', {
              id: 'persistent-ptc',
              kind: 'persistent-ptc',
              capture: persistent,
            })
          }
        }
      } else {
        pushFact('PTC execution', snapshot.ptc.reason ?? readPhaseText(snapshot.ptc), 'warning')
      }
    }
    if (lines.length > authorizationStart) lines.splice(authorizationStart, 0, {
      text: 'Authorization', tone: 'dim', detail: true, heading: true,
    })

    // 4. Application access
    pushHeading('Application access')
    const applications = snapshot.applications
    if (applications.phase === 'ready') {
      const value = applications.value
      const total = value === undefined ? 0 : value.allowedApps.length + value.blockedApps.length
      pushFact('Applications', value === undefined
        ? readPhaseText(applications)
        : total === 0
          ? 'none saved yet'
          : `${String(value.allowedApps.length)} always allowed · ${String(value.blockedApps.length)} refused`)
      if (value?.persistentAvailable === false) {
        pushWrapped('The Host reports durable application storage is unavailable; persisted decisions may not survive.', { detail: true })
      }
      if (!busy && value !== undefined && system?.platform !== 'win32') {
        pushAction('Manage applications', { id: 'manage', kind: 'manage' })
      }
    } else {
      pushFact('Applications', snapshot.applications.reason ?? readPhaseText(applications), 'warning')
    }

    // 5. Help / recovery
    push('', { detail: true })
    if (this.help) {
      push('Help and recovery', { tone: 'strong' })
      for (const item of HELP_LINES) pushWrapped(`  ${item}`, { detail: true })
      if (!busy && this.openPlugins !== undefined) {
        pushAction('Open Settings → Plugins', { id: 'plugins', kind: 'plugins' })
      }
    }
    if (snapshot.action !== undefined) {
      const prefix = snapshot.action.state === 'ok'
        ? 'Action'
        : snapshot.action.state === 'unknown' ? 'Action outcome unconfirmed' : 'Action failed'
      pushWrapped(`${prefix}: ${snapshot.action.text}`, { tone: snapshot.action.state === 'ok' ? 'fact' : 'warning' })
    }
    if (this.notice !== undefined) {
      pushWrapped(`${this.notice.kind === 'error' ? 'Error' : 'Notice'}: ${this.notice.text}`, {
        tone: this.notice.kind === 'error' ? 'error' : 'dim',
      })
    }
    if (!shortGrant) return lines
    // A short grant keeps the SAME model: essential facts/actions come first so
    // the first recovery action can never be pushed off-screen by long prose,
    // and the prose stays in the same scrollport below them.
    const essential = lines.filter(line => line.detail !== true)
    const prose = lines.filter(line => line.detail === true && line.heading !== true)
    return [...essential, ...prose]
  }

  private renderOverviewBar(width: number, snapshot: CuaAccessSettingsSnapshot, bodyRows: number): BarRender {
    if (snapshot.busy) {
      return this.layoutBar(width, [{ id: 'bar:wait', text: 'Waiting for the action to settle…', priority: 1000 }])
    }
    // H0: no body row exists, so only the truthful safe escape is painted (and
    // published); refresh/help/select/activate would be hidden actions.
    if (bodyRows === 0) {
      return this.layoutBar(width, [{ id: 'bar:escape', text: 'Back [Esc]', priority: 1000 }])
    }
    return this.layoutBar(width, [
      ...(this.overviewActions.length > 0 ? [{ id: 'bar:select', text: 'Up/Down select', priority: 30 }] : []),
      ...(this.overviewActions.length > 0 ? [{ id: 'bar:enter', text: 'Enter activate', priority: 40 }] : []),
      { id: 'bar:refresh', text: 'r Refresh', priority: 60 },
      { id: 'bar:help', text: '? Help', priority: 50 },
      { id: 'bar:escape', text: 'Back [Esc]', priority: 1000 },
    ])
  }

  // ── Applications (Adaptive Workbench) ────────────────────────────────────

  private liveWorkbenchGrant(width: number): WebWorkbenchGrant {
    return this.workbenchGrant ?? {
      width,
      rows: Math.max(0, this.detailGrant - 1),
      barWidth: width,
      allowDual: false,
    }
  }

  private paintsBothRegions(): boolean {
    // The projection is the MODE's, not a retained grant's: after returning to
    // the Overview the old dual grant must never make an Overview verb passive.
    if (this.mode !== 'applications' || this.confirmation !== undefined) return false
    const grant = this.workbenchGrant
    return grant !== undefined && grant.allowDual
  }

  private listColumnWidth(width: number): number {
    return Math.max(20, Math.min(34, Math.max(1, width - 36)))
  }

  private renderWorkbench(snapshot: CuaAccessSettingsSnapshot, width: number): {
    readonly lines: string[]
    readonly bodyRows: number
    readonly bodyWidth: number
    readonly bar: BarRender
    readonly targets: readonly PaintedTarget[]
  } {
    const grant = this.liveWorkbenchGrant(width)
    const bodyRows = Math.max(0, grant.rows)
    this.lastBodyRows = bodyRows
    if (snapshot.action !== undefined && snapshot.action.at !== this.revealedWorkbenchActionAt) {
      this.revealedWorkbenchActionAt = snapshot.action.at
      // Reuse the ONE scrollport: a new abnormal result is revealed at its
      // first line once, instead of remaining below a long path/decision.
      this.listOffset = 0
      this.detailOffset = 0
    }
    const bodyWidth = grant.width
    const targets: PaintedTarget[] = []
    this.visibleActionIds.clear()
    this.detailActions = []
    const out: string[] = []
    if (this.confirmation !== undefined) {
      this.lastBodyRows = bodyRows
      const built = this.buildConfirmation(snapshot, bodyWidth, bodyRows)
      for (let index = 0; index < bodyRows; index += 1) out.push(fit(built.lines[index] ?? '', bodyWidth))
      for (const target of built.targets) targets.push(target)
      const bar = this.layoutBar(grant.barWidth, [
        ...(this.confirmationVisible
          ? [{ id: 'bar:confirm', text: 'Confirm [Enter]', short: 'Confirm', priority: 900 }]
          : []),
        { id: 'bar:escape', text: 'Cancel [Esc]', short: 'Cancel [Esc]', priority: 1000 },
      ])
      return { lines: [...out, fit(bar.text, grant.barWidth)], bodyRows, bodyWidth, bar, targets }
    }
    if (this.help) {
      const built = this.buildWorkbenchHelp(bodyWidth, bodyRows)
      for (let index = 0; index < bodyRows; index += 1) {
        const line = built.lines[index]
        out.push(fit(line === undefined ? '' : this.paintLine(line), bodyWidth))
      }
      const bar = this.renderWorkbenchSafeBar(grant.barWidth, snapshot)
      return { lines: [...out, fit(bar.text, grant.barWidth)], bodyRows, bodyWidth, bar, targets }
    }
    const both = this.paintsBothRegions()
    const listWidth = both ? this.listColumnWidth(bodyWidth) : bodyWidth
    const detailWidth = both ? Math.max(1, bodyWidth - listWidth - 2) : bodyWidth
    const list = this.buildApplicationList(snapshot, listWidth, bodyRows)
    const detail = this.buildApplicationDetail(snapshot, detailWidth, bodyRows)
    const listLine = (index: number): string => {
      const line = list.lines[index]
      return line === undefined ? '' : this.paintLine(line)
    }
    const detailLine = (index: number): string => {
      const line = detail.lines[index]
      return line === undefined ? '' : this.paintLine(line)
    }
    for (let index = 0; index < bodyRows; index += 1) {
      if (both) {
        out.push(`${fit(listLine(index), listWidth)}${' '.repeat(2)}${fit(detailLine(index), detailWidth)}`)
      } else if (this.listRegion === 'list') {
        out.push(fit(listLine(index), listWidth))
      } else {
        out.push(fit(detailLine(index), detailWidth))
      }
    }
    // A transient notice stays visible in EVERY projection (the Overview model
    // carries its own; the workbench has no spare row, so it takes the last one).
    // The overwritten row loses its business targets: a notice cell must never
    // activate an action that is no longer painted there.
    const noticeRow = this.notice !== undefined && out.length > 0 ? out.length - 1 : undefined
    if (noticeRow !== undefined) {
      const text = `${this.notice!.kind === 'error' ? 'Error' : 'Notice'}: ${this.notice!.text}`
      out[noticeRow] = fit(this.toneText(this.notice!.kind === 'error' ? 'error' : 'dim', text), bodyWidth)
    }
    // ONE final admission derived from what THIS frame really painted (after
    // clipping and the notice replacement). A hidden region's rows/verbs are
    // not a pointer/keyboard route; in the dual projection BOTH regions are
    // visible and both stay admissible.
    const listPainted = both || this.listRegion === 'list'
    const detailPainted = both || this.listRegion === 'detail'
    for (const target of list.targets) {
      if (!listPainted) continue
      if (target.row !== noticeRow) targets.push(target)
    }
    for (const target of detail.targets) {
      if (!detailPainted) continue
      if (target.row === noticeRow) {
        if (target.kind === 'action') {
          this.detailActions = this.detailActions.filter(action => action.id !== target.action.id)
          this.visibleActionIds.delete(target.action.id)
        }
        continue
      }
      targets.push(both ? { ...target, startCol: target.startCol + listWidth + 2, endCol: target.endCol + listWidth + 2 } : target)
    }
    if (!detailPainted) {
      for (const action of this.detailActions) this.visibleActionIds.delete(action.id)
      this.detailActions = []
    }
    this.paintedListSelection = listPainted && this.selection !== undefined
      && targets.some(target => target.kind === 'select'
        && target.group === this.selection!.group && target.id === this.selection!.id)
    // A passive region cell click only moves the local focus (never a write).
    // Registered LAST so every painted row/verb keeps its own target.
    if (both && bodyRows > 0) {
      for (let row = 0; row < bodyRows; row += 1) {
        targets.push({ kind: 'focus', row, startCol: 0, endCol: Math.max(1, listWidth), region: 'list' })
        targets.push({ kind: 'focus', row, startCol: listWidth + 2, endCol: bodyWidth, region: 'detail' })
      }
    }
    const bar = bodyRows === 0
      ? this.renderWorkbenchSafeBar(grant.barWidth, snapshot)
      : this.listRegion === 'list'
        ? this.renderApplicationListBar(grant.barWidth)
        : this.renderApplicationDetailBar(grant.barWidth)
    return { lines: [...out, fit(bar.text, grant.barWidth)], bodyRows, bodyWidth, bar, targets }
  }

  /** H0: the ONE safe bar of a frame with no body row. An accepted action still
   *  owns the page (Waiting only); otherwise Back is the only route. */
  private renderWorkbenchSafeBar(width: number, snapshot: CuaAccessSettingsSnapshot): BarRender {
    if (snapshot.busy) {
      return this.layoutBar(width, [{ id: 'bar:wait', text: 'Waiting for the action to settle…', priority: 1000 }])
    }
    return this.layoutBar(width, [{ id: 'bar:escape', text: 'Back [Esc]', priority: 1000 }])
  }

  private applicationGroups(snapshot: CuaAccessSettingsSnapshot): Array<{
    readonly group: ApplicationGroup
    readonly label: string
    readonly applications: readonly CuaApplicationFact[]
  }> {
    const value = snapshot.applications.phase === 'ready' ? snapshot.applications.value : undefined
    if (value === undefined) return []
    return [
      { group: 'allowed', label: 'Always allowed', applications: value.allowedApps },
      { group: 'refused', label: 'Refused', applications: value.blockedApps },
    ]
  }

  private repairSelection(snapshot: CuaAccessSettingsSnapshot): void {
    const groups = this.applicationGroups(snapshot)
    const rows = groups.flatMap(entry => entry.applications.map(application => ({ group: entry.group, id: application.id })))
    if (rows.length === 0) {
      this.selection = undefined
      return
    }
    if (this.selection !== undefined && rows.some(row => row.group === this.selection!.group && row.id === this.selection!.id)) return
    const previousGroup = this.selection?.group
    const sameGroup = previousGroup === undefined ? undefined : rows.find(row => row.group === previousGroup)
    this.selection = sameGroup ?? rows[0]
  }

  private selectedApplication(snapshot: CuaAccessSettingsSnapshot): {
    readonly group: ApplicationGroup
    readonly application: CuaApplicationFact
  } | undefined {
    if (this.selection === undefined) return undefined
    for (const entry of this.applicationGroups(snapshot)) {
      if (entry.group !== this.selection.group) continue
      const application = entry.applications.find(candidate => candidate.id === this.selection!.id)
      if (application !== undefined) return { group: entry.group, application }
    }
    return undefined
  }

  private applicationRows(snapshot: CuaAccessSettingsSnapshot): Array<{
    readonly group: ApplicationGroup
    readonly groupLabel: string
    readonly application: CuaApplicationFact
  }> {
    return this.applicationGroups(snapshot).flatMap(entry =>
      entry.applications.map(application => ({ group: entry.group, groupLabel: entry.label, application })))
  }

  private buildApplicationList(snapshot: CuaAccessSettingsSnapshot, width: number, bodyRows: number): {
    readonly lines: PageLine[]
    readonly targets: readonly PaintedTarget[]
  } {
    this.repairSelection(snapshot)
    const lines: PageLine[] = []
    const receiptPush = (text: string, options: Omit<PageLine, 'text'> = {}): void => { lines.push({ text, ...options }) }
    this.pushReceiptLines(snapshot, width, receiptPush)
    const entries = this.applicationGroups(snapshot)
    if (snapshot.applications.phase !== 'ready' || snapshot.applications.value === undefined) {
      lines.push({
        text: snapshot.applications.reason ?? readPhaseText(snapshot.applications),
        tone: 'warning',
      })
      this.listOffset = 0
      return { lines, targets: [] }
    }
    for (const entry of entries) {
      if (lines.length > 0) lines.push({ text: '' })
      lines.push({ text: entry.label, tone: 'dim' })
      if (entry.applications.length === 0) {
        lines.push({ text: '  none saved', tone: 'dim', detail: true })
        continue
      }
      for (const application of entry.applications) {
        const selected = this.selection?.group === entry.group && this.selection?.id === application.id
        const name = applicationName(application)
        lines.push({
          text: `${selected ? '> ' : '  '}${name}`,
          tone: selected ? 'strong' : 'fact',
          select: { group: entry.group, id: application.id },
        })
      }
    }
    // The list scrollport is bodyRows physical rows; the selection is revealed
    // only by the user's own movement (never an automatic first-frame jump).
    const maxOffset = Math.max(0, lines.length - bodyRows)
    this.listOffset = Math.max(0, Math.min(this.listOffset, maxOffset))
    const visible = lines.slice(this.listOffset, this.listOffset + bodyRows)
    const targets: PaintedTarget[] = []
    for (let index = 0; index < visible.length; index += 1) {
      const line = visible[index]
      if (line?.select === undefined) continue
      targets.push({ kind: 'select', row: index, startCol: 0, endCol: width, group: line.select.group, id: line.select.id })
    }
    return { lines: visible, targets }
  }

  private buildApplicationDetail(snapshot: CuaAccessSettingsSnapshot, width: number, bodyRows: number): {
    readonly lines: PageLine[]
    readonly targets: readonly PaintedTarget[]
  } {
    const lines: PageLine[] = []
    const targets: PaintedTarget[] = []
    const push = (text: string, options: Omit<PageLine, 'text'> = {}): void => {
      lines.push({ text, ...options })
    }
    const selected = this.selectedApplication(snapshot)
    const storageUnavailable = snapshot.applications.phase === 'ready'
      && snapshot.applications.value?.persistentAvailable === false
    this.pushReceiptLines(snapshot, width, push)
    if (selected === undefined) {
      lines.push({ text: 'Select an application to review its persisted decision.', tone: 'dim' })
      if (storageUnavailable) {
        for (const part of wrapText('The Host reports durable application storage is unavailable; persisted decisions may not survive.', width)) {
          push(part, { tone: 'warning' })
        }
      }
      const maxOffset = Math.max(0, lines.length - Math.max(1, bodyRows))
      this.detailOffset = Math.max(0, Math.min(this.detailOffset, maxOffset))
      return { lines: lines.slice(this.detailOffset, this.detailOffset + bodyRows), targets }
    }
    const { group, application } = selected
    push('Application', { tone: 'strong' })
    for (const part of wrapText(`  ${applicationName(application)}`, width)) push(part)
    if (application.executablePath !== undefined) {
      push('Path', { tone: 'dim' })
      for (const part of wrapText(`  ${sanitizedPhysicalLine(application.executablePath)}`, width)) push(part, { tone: 'dim' })
    }
    push(`Decision: ${group === 'allowed' ? 'Always allowed' : 'Refused'}`, {
      label: 'Decision: ',
      tone: 'fact',
    })
    for (const part of wrapText('Persisted decisions only; this Session\'s temporary grants are not listed here.', width)) {
      push(part, { detail: true })
    }
    if (storageUnavailable) {
      for (const part of wrapText('The Host reports durable application storage is unavailable; persisted decisions may not survive.', width)) {
        push(part, { tone: 'warning' })
      }
    }
    const busy = snapshot.busy
    if (busy) {
      const visible = lines.slice(this.detailOffset, this.detailOffset + bodyRows)
      return { lines: visible, targets }
    }
    const verb = group === 'allowed' ? 'Revoke access…' : 'Allow asking again…'
    const action: PageAction = group === 'allowed'
      ? {
        id: `revoke:${application.id}`,
        kind: 'revoke',
        capture: { epoch: snapshot.epoch, kind: 'revoke', applicationId: application.id, applicationGroup: 'allowed' },
      }
      : {
        id: `retry:${application.id}`,
        kind: 'retry',
        capture: { epoch: snapshot.epoch, kind: 'retry', applicationId: application.id, applicationGroup: 'refused' },
      }
    if (cuaActionAdmitted(snapshot, action.capture!).ok
      && this.applicationIdentityUnique(snapshot, group, application)) {
      const text = `  ${verb}`
      if (visibleWidth(text) <= width) {
        lines.push({ text, action, span: { startCol: 2, endCol: 2 + visibleWidth(verb) } })
      }
    } else if (!this.applicationIdentityUnique(snapshot, group, application)) {
      for (const part of wrapText('This decision shares its visible identity with another decision; no dangerous action is offered here.', width)) {
        push(part, { tone: 'warning' })
      }
    }
    const maxOffset = Math.max(0, lines.length - Math.max(1, bodyRows))
    this.detailOffset = Math.max(0, Math.min(this.detailOffset, maxOffset))
    const visible = lines.slice(this.detailOffset, this.detailOffset + bodyRows)
    // The one detail action's target is resolved against the VISIBLE slice.
    const actionIndex = visible.findIndex(line => line.action !== undefined)
    if (actionIndex >= 0) {
      const line = visible[actionIndex]!
      if (line.span !== undefined && line.action !== undefined) {
        // The action is admitted ONLY while its complete verb is painted in
        // THIS frame (a scrolled-out verb has no key or pointer authority).
        this.detailActions = [line.action]
        this.visibleActionIds.add(line.action.id)
        targets.push({ kind: 'action', row: actionIndex, startCol: line.span.startCol, endCol: line.span.endCol, action: line.action })
      }
    }
    return { lines: visible, targets }
  }

  /** The ONE settled-action receipt, visible in the ACTIVE projection too: after
   *  a revoke/retry the readback may remove the row, yet the user must still see
   *  what happened and how to recover from an unconfirmed outcome. */
  private pushReceiptLines(
    snapshot: CuaAccessSettingsSnapshot,
    width: number,
    push: (text: string, options?: Omit<PageLine, 'text'>) => void,
  ): void {
    const action = snapshot.action
    if (action === undefined) return
    if (action.target !== undefined) {
      for (const part of wrapText(`Target: ${action.target}`, width)) push(part, { tone: 'dim' })
    }
    const prefix = action.state === 'ok' ? 'Action' : action.state === 'unknown' ? 'Action outcome unconfirmed' : 'Action failed'
    for (const part of wrapText(`${prefix}: ${action.text}`, width)) {
      push(part, { tone: action.state === 'ok' ? 'fact' : 'warning' })
    }
    if (action.state === 'unknown') {
      for (const part of wrapText('Refresh to read the authoritative state before deciding again.', width)) {
        push(part, { tone: 'warning', detail: true })
      }
    }
  }

  /** The REAL Applications help: the same durable recovery text as the Overview,
   *  rendered inside the current workbench projection (its own scroll). */
  private buildWorkbenchHelp(width: number, bodyRows: number): { readonly lines: PageLine[] } {
    const lines: PageLine[] = []
    const push = (text: string, options: Omit<PageLine, 'text'> = {}): void => { lines.push({ text, ...options }) }
    push('Help and recovery', { tone: 'strong' })
    for (const item of HELP_LINES) {
      const parts = wrapText(`  ${item}`, width)
      for (const part of parts) push(part, { detail: true })
    }
    const maxOffset = Math.max(0, lines.length - bodyRows)
    this.helpOffset = Math.max(0, Math.min(this.helpOffset, maxOffset))
    return { lines: lines.slice(this.helpOffset, this.helpOffset + bodyRows) }
  }

  /** Two decisions in the SAME group that cannot be told apart by their public
   *  identity must never be confirmed: the exact target would be a guess. */
  private applicationIdentityUnique(
    snapshot: CuaAccessSettingsSnapshot,
    group: ApplicationGroup,
    application: CuaApplicationFact,
  ): boolean {
    const entries = this.applicationGroups(snapshot).find(entry => entry.group === group)?.applications ?? []
    const identity = applicationIdentity(application)
    return entries.filter(candidate => applicationIdentity(candidate) === identity).length <= 1
  }

  private openSelectedApplication(): void {
    if (this.mode !== 'applications' || this.confirmation !== undefined) return
    // The final painted target result is the ONE admission: a scrolled-out,
    // notice-overwritten or otherwise unpainted selection cannot open.
    if (this.selection === undefined || !this.paintedListSelection) return
    this.listRegion = 'detail'
    this.detailOffset = 0
    this.bump()
  }

  private renderApplicationListBar(width: number): BarRender {
    if (this.controller.getSnapshot().busy) {
      return this.layoutBar(width, [{ id: 'bar:wait', text: 'Waiting for the action to settle…', priority: 1000 }])
    }
    const hasSelection = this.selection !== undefined && this.paintedListSelection
    return this.layoutBar(width, [
      ...(hasSelection ? [{ id: 'bar:open', text: 'Enter open', priority: 700 }] : []),
      ...(this.paintsBothRegions() ? [{ id: 'bar:tab', text: 'Tab detail', priority: 40 }] : []),
      { id: 'bar:refresh', text: 'r Refresh', priority: 60 },
      { id: 'bar:help', text: '? Help', priority: 50 },
      { id: 'bar:escape', text: 'Back [Esc]', priority: 1000 },
    ])
  }

  private renderApplicationDetailBar(width: number): BarRender {
    if (this.controller.getSnapshot().busy) {
      return this.layoutBar(width, [{ id: 'bar:wait', text: 'Waiting for the action to settle…', priority: 1000 }])
    }
    return this.layoutBar(width, [
      ...(this.detailActions.length > 0 ? [{ id: 'bar:enter', text: 'Enter activate', priority: 700 }] : []),
      ...(this.paintsBothRegions() ? [{ id: 'bar:tab', text: 'Tab list', priority: 40 }] : []),
      { id: 'bar:refresh', text: 'r Refresh', priority: 60 },
      { id: 'bar:help', text: '? Help', priority: 50 },
      { id: 'bar:escape', text: 'Back [Esc]', priority: 1000 },
    ])
  }

  // ── the ONE dangerous confirmation (full width) ─────────────────────────

  private buildConfirmation(snapshot: CuaAccessSettingsSnapshot, width: number, bodyRows: number): {
    readonly lines: string[]
    readonly targets: readonly PaintedTarget[]
  } {
    const confirmation = this.confirmation!
    const lines: PageLine[] = []
    const pushWrapped = (text: string, tone?: LineTone): void => {
      for (const part of wrapText(text, width)) lines.push({ text: part, ...(tone === undefined ? {} : { tone }) })
    }
    pushWrapped(`  ${confirmation.title}`, 'warning')
    pushWrapped('', undefined)
    pushWrapped(`  ${confirmation.risk}`)
    pushWrapped('', undefined)
    for (const fact of confirmation.target) pushWrapped(`  ${fact}`, 'dim')
    pushWrapped('', undefined)
    pushWrapped('  Nothing changes until Confirm is activated; Cancel returns with zero writes.', 'dim')
    const maxOffset = Math.max(0, lines.length - bodyRows)
    confirmation.offset = Math.max(0, Math.min(confirmation.offset, maxOffset))
    const visible = lines.slice(confirmation.offset, confirmation.offset + bodyRows)
    this.confirmationVisible = confirmation.offset === 0 && lines.length <= bodyRows
    return {
      lines: visible.map(line => this.paintLine(line)),
      targets: [],
    }
  }

  // ── keyboard ─────────────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (this.disposed) return
    // H0: the frame paints only Back (or Waiting); a key it did not advertise
    // must not start a read, a mode switch or an action.
    if (this.lastBodyRows === 0 && !matchesKey(data, 'escape')) return
    const current = this.frameCurrent()
    if (this.notice !== undefined) {
      this.notice = undefined
      this.bump()
      if (matchesKey(data, 'escape')) return
      if (!current) return
    }
    const snapshot = this.controller.getSnapshot()
    // An accepted action owns the page until its own settlement: no second
    // action, no parent leave and a truthful Waiting notice (never Cancel).
    if (snapshot.busy) {
      if (matchesKey(data, 'escape')) {
        this.notice = { kind: 'info', text: 'Waiting for the action to settle; it cannot be cancelled from here.' }
        this.bump()
      }
      return
    }
    if (this.confirmation !== undefined) {
      this.handleConfirmationInput(data, current)
      return
    }
    if (matchesKey(data, 'escape') || matchesKey(data, 'left')) {
      // An accepted action owns the page: the physical bar paints Waiting with
      // no escape, and the keyboard must not retire the page behind that bar.
      if (this.controller.getSnapshot().busy) return
      if (this.help) {
        this.help = false
        this.bump()
        return
      }
      if (this.mode === 'applications') {
        if (this.listRegion === 'detail') {
          this.listRegion = 'list'
          this.detailOffset = 0
          this.bump()
          return
        }
        this.leaveEmbeddedWorkbench()
        return
      }
      this.done()
      return
    }
    if (!current) return
    if (this.mode === 'overview') {
      this.handleOverviewInput(data, snapshot)
      return
    }
    this.handleApplicationsInput(data, snapshot)
  }

  private handleOverviewInput(data: string, snapshot: CuaAccessSettingsSnapshot): void {
    const bodyRows = Math.max(1, this.detailGrant - 1)
    if (matchesKey(data, 'up')) return this.moveOverview(-1)
    if (matchesKey(data, 'down')) return this.moveOverview(1)
    if (matchesKey(data, 'pageDown')) return this.scrollOverview(Math.max(1, bodyRows))
    if (matchesKey(data, 'pageUp')) return this.scrollOverview(-Math.max(1, bodyRows))
    if (matchesKey(data, 'home')) {
      this.overviewOffset = 0
      this.bump()
      return
    }
    if (matchesKey(data, 'end')) {
      this.overviewOffset = Number.MAX_SAFE_INTEGER
      this.bump()
      return
    }
    if (matchesKey(data, 'enter') || matchesKey(data, 'right')) {
      const action = this.overviewActions[this.overviewCursor]
      if (action === undefined || !this.visibleActionIds.has(action.id)) return
      this.activate(action, snapshot)
      return
    }
    if (data === 'r' || data === 'R') {
      this.refresh()
      return
    }
    if (data === '?' || data === 'h' || data === 'H') {
      this.help = !this.help
      this.bump()
    }
  }

  private handleApplicationsInput(data: string, snapshot: CuaAccessSettingsSnapshot): void {
    if (this.help) {
      const step = this.workbenchBodyRows()
      if (matchesKey(data, 'up')) return this.scrollWorkbenchHelp(-1)
      if (matchesKey(data, 'down')) return this.scrollWorkbenchHelp(1)
      if (matchesKey(data, 'pageDown')) return this.scrollWorkbenchHelp(step)
      if (matchesKey(data, 'pageUp')) return this.scrollWorkbenchHelp(-step)
      if (data === 'r' || data === 'R') {
        this.refresh()
        return
      }
      if (data === '?' || data === 'h' || data === 'H') {
        this.help = false
        this.bump()
      }
      return
    }
    if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      if (!this.paintsBothRegions()) return
      this.listRegion = this.listRegion === 'list' ? 'detail' : 'list'
      this.bump()
      return
    }
    if (data === 'r' || data === 'R') {
      this.refresh()
      return
    }
    if (data === '?' || data === 'h' || data === 'H') {
      this.help = true
      this.helpOffset = 0
      this.bump()
      return
    }
    if (this.listRegion === 'list') {
      if (matchesKey(data, 'up')) return this.moveApplication(-1, snapshot)
      if (matchesKey(data, 'down')) return this.moveApplication(1, snapshot)
      if (matchesKey(data, 'pageDown')) return this.scrollApplicationList(1)
      if (matchesKey(data, 'pageUp')) return this.scrollApplicationList(-1)
      if (matchesKey(data, 'enter') || matchesKey(data, 'right')) {
        this.openSelectedApplication()
        return
      }
      return
    }
    // The Detail is a full scrollport: a long path/receipt may push the ONE
    // verb below the grant, and it must stay reachable by the keyboard.
    const step = this.workbenchBodyRows()
    if (matchesKey(data, 'up')) return this.scrollApplicationDetail(-1)
    if (matchesKey(data, 'down')) return this.scrollApplicationDetail(1)
    if (matchesKey(data, 'pageDown')) return this.scrollApplicationDetail(step)
    if (matchesKey(data, 'pageUp')) return this.scrollApplicationDetail(-step)
    if (matchesKey(data, 'home')) {
      this.detailOffset = 0
      this.bump()
      return
    }
    if (matchesKey(data, 'end')) {
      this.detailOffset = Number.MAX_SAFE_INTEGER
      this.bump()
      return
    }
    if (matchesKey(data, 'enter') || matchesKey(data, 'right')) {
      const action = this.detailActions[0]
      if (action === undefined || !this.visibleActionIds.has(action.id)) return
      this.activate(action, snapshot)
    }
  }

  private handleConfirmationInput(data: string, current: boolean): void {
    if (matchesKey(data, 'escape') || data === 'n' || data === 'N') {
      this.cancelConfirmation()
      return
    }
    if (data === 'y' || data === 'Y' || matchesKey(data, 'enter')) {
      if (!current) return
      if (!this.confirmationVisible) {
        this.notice = { kind: 'info', text: 'The complete risk and target must be visible before confirming; resize and review it.' }
        this.bump()
        return
      }
      this.confirmCurrent()
      return
    }
    if (matchesKey(data, 'up')) return this.scrollConfirmation(-1)
    if (matchesKey(data, 'down')) return this.scrollConfirmation(1)
    if (matchesKey(data, 'pageDown')) return this.scrollConfirmation(Math.max(1, this.confirmationBodyRows()))
    if (matchesKey(data, 'pageUp')) return this.scrollConfirmation(-Math.max(1, this.confirmationBodyRows()))
  }

  /** Open the ONE dangerous confirmation for an explicit selected action. */
  private activate(action: PageAction, snapshot: CuaAccessSettingsSnapshot): void {
    if (this.disposed || !this.frameCurrent()) return
    if (action.capture !== undefined) {
      const admitted = cuaActionAdmitted(snapshot, action.capture)
      if (!admitted.ok) {
        this.notice = { kind: 'info', text: admitted.reason }
        this.bump()
        return
      }
    }
    switch (action.kind) {
      case 'refresh':
        this.refresh()
        return
      case 'help':
        this.help = !this.help
        this.bump()
        return
      case 'plugins':
        if (this.openPlugins === undefined) {
          this.notice = { kind: 'info', text: 'The Plugin Manager is not available in this composition.' }
          this.bump()
          return
        }
        this.openPlugins()
        return
      case 'manage':
        if (snapshot.applications.phase !== 'ready' || snapshot.applications.value === undefined) return
        this.mode = 'applications'
        this.listRegion = 'list'
        this.listOffset = 0
        this.detailOffset = 0
        this.repairSelection(snapshot)
        this.bump()
        return
      case 'open-application':
        this.openSelectedApplication()
        return
      case 'request':
        this.start('computer use permission request', () => this.controller.requestPermission(action.capture!))
        return
      case 'open':
        this.start('computer use permission settings', () => this.controller.openSettings(action.capture!))
        return
      case 'preset':
        this.start('computer use PTC default', () => this.controller.setPtcDefault(action.capture!))
        return
      case 'persistent-ptc':
        this.openConfirmation(action, 'persistent-ptc', snapshot)
        return
      case 'revoke':
        this.openConfirmation(action, 'revoke', snapshot)
        return
      case 'retry':
        this.openConfirmation(action, 'retry', snapshot)
        return
    }
  }

  private openConfirmation(
    action: PageAction,
    kind: 'persistent-ptc' | 'revoke' | 'retry',
    snapshot: CuaAccessSettingsSnapshot,
  ): void {
    const returnMode = this.mode
    const returnRegion = this.listRegion
    let title: string
    let risk: string
    let confirm: string
    const target: string[] = []
    if (kind === 'persistent-ptc') {
      title = 'Enable persistent PTC mode?'
      risk = 'The official runtime may reload and interrupt in-flight Computer Use calls. The Host setting is re-read after the action; it is not assumed saved.'
      confirm = 'Use persistent mode'
      target.push('Change: PTC execution → Persistent')
    } else {
      const group = action.capture?.applicationGroup
      const selected = group === undefined
        ? undefined
        : this.visibleApplication(snapshot, group, action.capture?.applicationId)
      if (selected === undefined) {
        this.notice = { kind: 'info', text: 'That application decision is no longer in the current observation; refresh and act again.' }
        this.bump()
        return
      }
      target.push(`Application: ${applicationIdentity(selected)}`)
      target.push(`Decision: ${group === 'allowed' ? 'Always allowed' : 'Refused'}`)
      if (kind === 'revoke') {
        title = 'Revoke this application decision?'
        risk = 'Affected Computer Use work may stop immediately; input already dispatched cannot be undone. No other application is changed.'
        confirm = 'Revoke access'
      } else {
        title = 'Allow this application to ask again?'
        risk = 'This clears the persisted refusal only. The next selection will ask again and nothing is approved automatically.'
        confirm = 'Ask again'
      }
    }
    this.confirmation = {
      action,
      title,
      risk,
      target,
      confirm,
      epoch: snapshot.epoch,
      returnMode,
      returnRegion,
      offset: 0,
    }
    this.pressed = undefined
    this.bump()
  }

  private visibleApplication(
    snapshot: CuaAccessSettingsSnapshot,
    group: ApplicationGroup,
    id: string | undefined,
  ): CuaApplicationFact | undefined {
    if (id === undefined) return undefined
    const entry = this.applicationGroups(snapshot).find(candidate => candidate.group === group)
    return entry?.applications.find(application => application.id === id)
  }

  private confirmCurrent(): void {
    const confirmation = this.confirmation
    if (confirmation === undefined) return
    if (!this.frameCurrent() || !this.confirmationVisible) return
    const snapshot = this.controller.getSnapshot()
    if (confirmation.epoch !== snapshot.epoch) {
      this.confirmation = undefined
      this.notice = { kind: 'info', text: 'The Host observation changed; the confirmation was discarded. Refresh before acting again.' }
      this.bump()
      return
    }
    // The target must still be paintably unique and admitted by the current
    // observation; the same opaque id on a newer observation is not reused.
    if (confirmation.action.capture === undefined
      || !cuaActionAdmitted(snapshot, confirmation.action.capture).ok) {
      this.confirmation = undefined
      this.notice = { kind: 'info', text: 'The painted target is no longer current; refresh before acting again.' }
      this.bump()
      return
    }
    if (confirmation.action.kind === 'revoke' || confirmation.action.kind === 'retry') {
      const group = confirmation.action.capture?.applicationGroup
      const application = group === undefined
        ? undefined
        : this.visibleApplication(snapshot, group, confirmation.action.capture?.applicationId)
      if (application === undefined || !this.applicationIdentityUnique(snapshot, group!, application)) {
        this.confirmation = undefined
        this.notice = { kind: 'info', text: 'That exact application decision can no longer be told apart or is gone; refresh and act again.' }
        this.bump()
        return
      }
    }
    const action = confirmation.action
    // Return to the captured view FIRST: the dispatched write keeps its own
    // owner and the visible page stays truthful while it settles.
    this.mode = confirmation.returnMode
    this.listRegion = confirmation.returnRegion
    this.confirmation = undefined
    this.confirmationVisible = false
    this.bump()
    if (action.kind === 'persistent-ptc') this.start('computer use persistent PTC', () => this.controller.enablePersistentPtc(action.capture!))
    else if (action.kind === 'revoke') this.start('computer use revoke', () => this.controller.revoke(action.capture!))
    else if (action.kind === 'retry') this.start('computer use retry approval', () => this.controller.retryApproval(action.capture!))
  }

  private cancelConfirmation(): void {
    const confirmation = this.confirmation
    if (confirmation === undefined) return
    this.mode = confirmation.returnMode
    this.listRegion = confirmation.returnRegion
    this.confirmation = undefined
    this.confirmationVisible = false
    this.pressed = undefined
    this.bump()
  }

  private confirmationBodyRows(): number {
    return Math.max(1, this.liveWorkbenchGrant(this.paint?.bodyWidth ?? 80).rows)
  }

  private scrollConfirmation(delta: number): void {
    if (this.confirmation === undefined) return
    const width = this.paint?.bodyWidth ?? 80
    const bodyRows = this.confirmationBodyRows()
    const probe = this.confirmationBodyLineCount(width)
    const maxOffset = Math.max(0, probe - bodyRows)
    this.confirmation = { ...this.confirmation, offset: Math.max(0, Math.min(this.confirmation.offset + delta, maxOffset)) }
    this.bump()
  }

  private confirmationBodyLineCount(width: number): number {
    const confirmation = this.confirmation
    if (confirmation === undefined) return 0
    let count = 0
    const add = (text: string): void => { count += wrapText(text, width).length }
    add(`  ${confirmation.title}`)
    add('')
    add(`  ${confirmation.risk}`)
    add('')
    for (const fact of confirmation.target) add(`  ${fact}`)
    add('')
    add('  Nothing changes until Confirm is activated; Cancel returns with zero writes.')
    return count
  }

  // ── local navigation and scrolling ───────────────────────────────────────

  private moveOverview(delta: number): void {
    const count = this.overviewActions.length
    if (count === 0) return
    this.overviewCursor = Math.max(0, Math.min(count - 1, this.overviewCursor + delta))
    const row = this.overviewActionRows[this.overviewCursor]
    const bodyRows = Math.max(1, this.detailGrant - 1)
    if (row !== undefined) {
      if (row < this.overviewOffset) this.overviewOffset = row
      else if (row >= this.overviewOffset + bodyRows) this.overviewOffset = row - bodyRows + 1
    }
    this.bump()
  }

  private scrollOverview(delta: number): void {
    this.overviewOffset = Math.max(0, this.overviewOffset + delta)
    this.bump()
  }

  private moveApplication(delta: number, snapshot: CuaAccessSettingsSnapshot): void {
    const rows = this.applicationRows(snapshot)
    if (rows.length === 0) return
    const currentIndex = this.selection === undefined
      ? -1
      : rows.findIndex(row => row.group === this.selection!.group && row.application.id === this.selection!.id)
    const next = currentIndex < 0
      ? (delta > 0 ? 0 : rows.length - 1)
      : Math.max(0, Math.min(rows.length - 1, currentIndex + delta))
    const target = rows[next]
    if (target === undefined) return
    this.selection = { group: target.group, id: target.application.id }
    const bodyRows = Math.max(1, this.liveWorkbenchGrant(this.paint?.bodyWidth ?? 80).rows)
    const lineIndex = this.applicationRowLineIndex(snapshot)
    if (lineIndex !== undefined) {
      if (lineIndex < this.listOffset) this.listOffset = lineIndex
      else if (lineIndex >= this.listOffset + bodyRows) this.listOffset = lineIndex - bodyRows + 1
    }
    this.bump()
  }

  /** A selection reveal HINT for the next paint only: admission is the final
   *  published target set, never this independently derived row index. */
  private applicationRowLineIndex(snapshot: CuaAccessSettingsSnapshot): number | undefined {
    if (this.selection === undefined) return undefined
    const bodyWidth = this.paint?.bodyWidth ?? this.liveWorkbenchGrant(80).width
    const width = this.paintsBothRegions() ? this.listColumnWidth(bodyWidth) : bodyWidth
    // The List layout puts the settled receipt first; the same receipt count is
    // the starting offset so the reveal hint stays aligned with the real list.
    let row = this.receiptLineCount(snapshot, width)
    for (const entry of this.applicationGroups(snapshot)) {
      if (row > 0) row += 1 // the blank separator (also before the first group after a receipt)
      if (entry.group === this.selection.group) {
        const index = entry.applications.findIndex(application => application.id === this.selection!.id)
        return index < 0 ? undefined : row + 1 + index
      }
      row += 1 + Math.max(1, entry.applications.length)
    }
    return undefined
  }

  /** The exact number of body lines `pushReceiptLines` contributes. */
  private receiptLineCount(snapshot: CuaAccessSettingsSnapshot, width: number): number {
    const action = snapshot.action
    if (action === undefined) return 0
    const prefix = action.state === 'ok' ? 'Action' : action.state === 'unknown' ? 'Action outcome unconfirmed' : 'Action failed'
    let count = action.target === undefined ? 0 : wrapText(`Target: ${action.target}`, width).length
    count += wrapText(`${prefix}: ${action.text}`, width).length
    if (action.state === 'unknown') {
      count += wrapText('Refresh to read the authoritative state before deciding again.', width).length
    }
    return count
  }

  private scrollApplicationList(direction: 1 | -1): void {
    const bodyRows = Math.max(1, this.liveWorkbenchGrant(this.paint?.bodyWidth ?? 80).rows)
    this.listOffset = Math.max(0, this.listOffset + direction * bodyRows)
    this.bump()
  }

  private workbenchBodyRows(): number {
    return Math.max(1, this.liveWorkbenchGrant(this.paint?.bodyWidth ?? 80).rows)
  }

  private scrollApplicationDetail(delta: number): void {
    this.detailOffset = Math.max(0, this.detailOffset + delta)
    this.bump()
  }

  private scrollWorkbenchHelp(delta: number): void {
    this.helpOffset = Math.max(0, this.helpOffset + delta)
    this.bump()
  }

  private scrollWorkbenchRegion(delta: number, region: 'list' | 'detail'): void {
    if (region === 'detail') {
      this.detailOffset = Math.max(0, this.detailOffset + delta)
    } else {
      this.listOffset = Math.max(0, this.listOffset + delta)
    }
    this.bump()
  }

  // ── pointer ──────────────────────────────────────────────────────────────

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed || this.grantAwaitingPaintValue) return undefined
    const paint = this.paint
    if (paint === undefined || paint.width !== event.width) return undefined
    const bodyRows = paint.bodyRows
    if (event.type === 'wheel') {
      if (event.wheelDelta === undefined || event.wheelDelta === 0) return undefined
      if (event.y < 0 || event.y >= bodyRows) return undefined
      if (!this.frameCurrent()) return undefined
      if (this.controller.getSnapshot().busy) return { handled: true }
      if (this.confirmation !== undefined) {
        this.scrollConfirmation(event.wheelDelta)
        return { handled: true }
      }
      if (this.mode === 'applications') {
        const delta = event.wheelDelta
        if (this.help) {
          this.scrollWorkbenchHelp(delta)
          return { handled: true }
        }
        const both = this.paintsBothRegions()
        if (!both) {
          this.scrollWorkbenchRegion(delta, this.listRegion)
          return { handled: true }
        }
        const listWidth = this.listColumnWidth(paint.bodyWidth)
        // The two-cell gutter between painted regions owns no scroll.
        if (event.x >= listWidth && event.x < listWidth + 2) return { handled: true }
        this.scrollWorkbenchRegion(delta, event.x < listWidth ? 'list' : 'detail')
        return { handled: true }
      }
      this.scrollOverview(event.wheelDelta)
      return { handled: true }
    }
    if (event.y < 0 || event.y >= bodyRows) return undefined
    if (!this.frameCurrent()) return undefined
    const target = paint.targets.find(candidate =>
      candidate.row === event.y && event.x >= candidate.startCol && event.x < candidate.endCol)
    if (event.type === 'press') {
      if (target === undefined) return undefined
      if (this.controller.getSnapshot().busy) return { handled: true }
      this.pressed = { identity: paint.identity, target }
      return { handled: true }
    }
    if (event.type === 'click') {
      const pressed = this.pressed
      this.pressed = undefined
      if (pressed === undefined || pressed.identity !== paint.identity) return undefined
      if (target === undefined || !sameTarget(pressed.target, target)) return undefined
      this.activateTarget(target)
      return { handled: true }
    }
    return undefined
  }

  private activateTarget(target: PaintedTarget): void {
    const snapshot = this.controller.getSnapshot()
    if (this.controller.getSnapshot().busy) return
    if (target.kind === 'focus') {
      this.listRegion = target.region
      this.bump()
      return
    }
    if (target.kind === 'select') {
      this.selection = { group: target.group, id: target.id }
      this.listRegion = 'list'
      this.bump()
      return
    }
    // A click on the passive region's cells only takes that region's focus; it
    // never dispatches a business action that belongs to the other seat.
    if (this.paintsBothRegions() && this.listRegion !== 'detail') {
      this.listRegion = 'detail'
      this.bump()
      return
    }
    this.activate(target.action, snapshot)
  }

  // ── admission ────────────────────────────────────────────────────────────

  private frameCurrent(): boolean {
    return this.paint !== undefined && this.paint.identity === this.gestureIdentity()
  }

  private revokeGrant(): void {
    this.grantAwaitingPaintValue = true
    this.paintedBarSpansValue = []
    this.paintedEscapeSpanValue = undefined
    this.pressed = undefined
    this.confirmationVisible = false
    // A resize is a frame boundary: a transient notice about the PREVIOUS grant
    // must not swallow the first deliberate key on the new one.
    this.notice = undefined
  }

  private refresh(): void {
    this.start('computer use settings refresh', () => this.controller.refresh(true))
  }

  private bump(): void {
    this.revision += 1
    this.requestRender()
  }

  // ── painting helpers ─────────────────────────────────────────────────────

  /** Paint one semantic line with its role tone and its exact action span. */
  private paintLine(line: PageLine): string {
    if (line.action !== undefined && line.span !== undefined) {
      const before = sliceCells(line.text, 0, line.span.startCol)
      const verb = sliceCells(line.text, line.span.startCol, line.span.endCol)
      const after = sliceCells(line.text, line.span.endCol, visibleWidth(line.text))
      const cursor = before.trimStart().startsWith('>')
      return `${cursor ? color.primary(before) : color.text(before)}${color.primary(verb)}${color.textMuted(after)}`
    }
    if (line.select !== undefined) {
      const prefix = sliceCells(line.text, 0, 2)
      const name = sliceCells(line.text, 2, visibleWidth(line.text))
      return line.tone === 'strong'
        ? `${color.primary(prefix)}${color.textStrong(name)}`
        : `${color.text(prefix)}${color.text(name)}`
    }
    if (line.label !== undefined) {
      const labelWidth = visibleWidth(line.label)
      return `${color.textDim(sliceCells(line.text, 0, labelWidth))}${this.toneText(line.tone, sliceCells(line.text, labelWidth, visibleWidth(line.text)))}`
    }
    return this.toneText(line.tone, line.text)
  }

  private toneText(tone: LineTone | undefined, text: string): string {
    switch (tone) {
      case 'strong': return color.textStrong(text)
      case 'dim': return color.textDim(text)
      case 'muted': return color.textMuted(text)
      case 'warning': return color.warning(text)
      case 'error': return color.error(text)
      case 'fact':
      case undefined: return color.text(text)
    }
  }

  private layoutBar(width: number, segments: readonly { readonly id: string; readonly text: string; readonly short?: string; readonly priority: number }[]): BarRender {
    const layout = layoutActionBarRow(segments.map(({ text, short, priority }): ActionBarSegment => ({
      text,
      priority,
      ...(short === undefined ? {} : { short }),
    })), width)
    const spans: BarSpan[] = []
    let escapeSpan: { startCol: number; endCol: number } | undefined
    for (const span of layout.spans) {
      const segment = segments[span.inputIndex]
      if (segment === undefined) continue
      if (segment.id === 'bar:escape') escapeSpan = { startCol: span.startCol, endCol: span.endCol }
      else if (segment.id !== 'bar:select' && segment.id !== 'bar:enter' && segment.id !== 'bar:tab' && segment.id !== 'bar:wait') {
        spans.push({ id: segment.id, startCol: span.startCol, endCol: span.endCol })
      }
    }
    return { text: layout.text, spans, ...(escapeSpan === undefined ? {} : { escapeSpan }) }
  }
}

/** ONE target identity: the same kind, action id and painted cells. */
function sameTarget(left: PaintedTarget, right: PaintedTarget): boolean {
  if (left.kind !== right.kind) return false
  if (left.row !== right.row || left.startCol !== right.startCol || left.endCol !== right.endCol) return false
  if (left.kind === 'action' && right.kind === 'action') return left.action.id === right.action.id
  if (left.kind === 'select' && right.kind === 'select') return left.group === right.group && left.id === right.id
  if (left.kind === 'focus' && right.kind === 'focus') return left.region === right.region
  return false
}
