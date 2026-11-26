/**
 * The `/settings → Tools → MCP servers` page (FR3 S4 / SUX-07).
 *
 * It is mounted as an EMBEDDED ADAPTIVE WORKBENCH inside the ONE Settings
 * workspace lease (the same body/chrome/Action Bar as the Web Search / Fetch
 * page) — never a second alt-screen, modal or Settings workspace. The Root owns
 * the real Categories rail, the one body/physical-bar grant and the one seat;
 * this page owns only its local List/Detail region, its full-width form and its
 * local questions.
 *
 * Authority is deliberately NOT here: every fact comes from the per-open
 * {@link McpServersController} snapshot, which projects the official Host MCP
 * manager and the read-only configuration-source read. This component owns only
 * transient presentation state (local region, cursor, search query, scroll
 * offsets, pressed gesture), and all of it dies with the page instance.
 *
 * SUX-07 rules pinned here:
 * - The real grant (`width`/`rows`/`barWidth`/`allowDual`) drives the local
 *   List/Detail split; a page-local terminal-width breakpoint never does.
 * - A list click/keyboard move only SELECTS; an explicit `Open [Enter]`/Enter/
 *   Right enters the active Detail. A form row click only selects; the current
 *   field's complete explicit verb (`Edit [Enter]`, `Switch [Enter]`, …)
 *   activates the existing controller intent.
 * - The Add/Edit form and every risk question take the whole body; the physical
 *   Action Bar stays ONE row at the full frame width.
 * - Long names/statuses/diagnostics wrap on real cells; the list scrolls in
 *   PHYSICAL rows and never truncates a status into a different word.
 *
 * @module @xmoon76/dsh-pi-tui/tui/panels/mcp-servers-page
 */

import { Input, matchesKey, truncateToWidth, visibleWidth, type TuiMouseEvent, type TuiMouseEventResult } from '@xmoon76/pi-tui'
import type { McpManagedServerStatus } from '@deepseek-ai/dsh-mcp-manager/types'
import type {
  McpConfigStatus,
  McpServerSourceLabel,
  McpServersController,
  McpServersRow,
  McpServersSnapshot,
} from '../../app/command/mcp-servers.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { ACTION_BAR_SEPARATOR, layoutActionBarRow, type ActionBarSegment } from '../presentation/action-bar.ts'
import { paintActionSpan } from '../presentation/action-ink.ts'
import { color } from '../theme/runtime.ts'
import type { EmbeddedSpecialistPage, WebWorkbenchGrant } from './settings-workspace-panel.ts'
import {
  mcpFormRows,
  mcpFormStatusText,
  renderMcpConfigForm,
  type McpFormRow,
} from './mcp-server-config-form.ts'

/** The page's own name (also the Settings row label and the breadcrumb tail). */
export const MCP_SERVERS_PAGE_TITLE = 'MCP servers'

/** The local region of the mounted workbench. */
type McpPageRegion = 'list' | 'detail'

/** The frozen 34-cell List column of the Adaptive Workbench. */
const MCP_LIST_COLUMN_WIDTH = 34

/** The official status word (never an invented `connected-ish` label). */
export function mcpServerStatusText(status: McpManagedServerStatus): string {
  switch (status.state) {
    case 'disabled': return 'Disabled'
    case 'closed': return 'Closed'
    case 'waiting-credentials': return 'Waiting credentials'
    case 'connecting': return 'Connecting'
    case 'connected': return 'Connected'
    case 'reconnecting': return 'Reconnecting'
    case 'failed':
      switch (status.reason) {
        case 'load': return 'Failed (load)'
        case 'cleanup': return 'Failed (cleanup)'
        case 'gave-up': return 'Failed (gave up)'
        case 'reconnect-disabled': return 'Reconnect disabled'
        case 'unclosed-generation': return 'Failed (unclosed generation)'
      }
  }
}

/** The status ink role: attention colors only for attention states. */
function statusInk(status: McpManagedServerStatus, text: string): string {
  switch (status.state) {
    case 'connected': return color.text(text)
    case 'connecting':
    case 'reconnecting':
    case 'waiting-credentials': return color.warning(text)
    case 'disabled':
    case 'closed': return color.textDim(text)
    case 'failed':
      // A cleanup failure is an ERROR even though the connection may be gone.
      return color.error(text)
  }
}

/** The configuration-source ink: an unproven source is never neutral. */
function sourceInk(text: string): string {
  if (text === 'Configured') return color.text(text)
  if (text === 'Retained/removed' || text === 'Unknown') return color.warning(text)
  return color.textDim(text)
}

/** Pad/truncate one painted line to exactly `width` cells. */
function fit(text: string, width: number): string {
  if (width <= 0) return ''
  const clamped = truncateToWidth(text, width, '…', false)
  const padding = width - visibleWidth(clamped)
  return padding > 0 ? clamped + ' '.repeat(padding) : clamped
}

/** Paint a left and a right run on ONE row, both kept WHOLE (the right run is
 *  dropped when they do not fit together). */
function composeRow(left: string, right: string, width: number): string {
  if (width <= 0) return ''
  if (right === '') return fit(left, width)
  const leftWidth = visibleWidth(left)
  const rightWidth = visibleWidth(right)
  if (leftWidth + rightWidth + 1 > width) return fit(left, width)
  return fit(left + ' '.repeat(width - leftWidth - rightWidth) + right, width)
}

/** One Action-Bar intent a pointer may invoke (never a bare glyph). */
type McpBarAction =
  | 'back'
  | 'apply-input'
  | 'open'
  | 'add'
  | 'edit'
  | 'toggle'
  | 'delete'
  | 'reset'
  | 'probe'
  | 'restart'
  | 'save'
  | 'confirm'
  | 'cancel'
  | 'discard'
  | 'keep-editing'
  | 'refresh'
  | 'start-search'
  | 'finish-search'
  | 'remove-form-row'
  /** Run the current form field's explicit verb through `activateFormRow`. */
  | 'activate-field'
  /** Leave the page after the unconfirmed-outcome warning. */
  | 'leave-anyway'

/** One painted hit target of the LAST frame, in page-local cells. */
type McpPaintedTarget =
  | {
      readonly kind: 'server-row'
      readonly name: string
      readonly row: number
      readonly startCol: number
      readonly endCol: number
    }
  | {
      readonly kind: 'form-row'
      /** The painted row's stable id (the field identity). */
      readonly id: string
      /** The index in the form's field list, resolved at paint time. */
      readonly index: number
      readonly row: number
      readonly startCol: number
      readonly endCol: number
    }
  | {
      readonly kind: 'form-verb'
      readonly id: string
      readonly index: number
      readonly row: number
      readonly startCol: number
      readonly endCol: number
    }
  | {
      readonly kind: 'action'
      /** The semantic intent the painted bar segment advertises. */
      readonly action: McpBarAction
      /** For `activate-field`: the exact stable field id of this frame. */
      readonly fieldId?: string
      readonly row: number
      readonly startCol: number
      readonly endCol: number
    }

/** The last painted frame's geometry (the only pointer authority). */
interface McpPagePaint {
  readonly width: number
  readonly rows: number
  readonly targets: readonly McpPaintedTarget[]
  readonly identity: string
}

/** Build one action-bar line from segments (whole segments only) and report the
 *  painted geometry of the Esc affordance, when it really painted whole. */
function paintBar(segments: readonly McpBarSegment[], width: number, lastIsEscape: boolean): {
  readonly line: string
  readonly escape?: { readonly startCol: number; readonly endCol: number }
  /** Every PAINTED segment with its cells, in display order. */
  readonly spans: readonly {
    readonly action: McpBarAction | undefined
    readonly fieldId: string | undefined
    readonly startCol: number
    readonly endCol: number
  }[]
} {
  const layout = layoutActionBarRow(segments, width)
  if (layout.truncated || layout.spans.length === 0) {
    return { line: color.textMuted(truncateToWidth(layout.text, Math.max(0, width), '…', true)), spans: [] }
  }
  let painted = ''
  let escape: { startCol: number; endCol: number } | undefined
  const spans: { action: McpBarAction | undefined; fieldId: string | undefined; startCol: number; endCol: number }[] = []
  for (const span of layout.spans) {
    if (painted !== '') painted += ACTION_BAR_SEPARATOR
    const isLast = span.inputIndex === segments.length - 1
    const segment = segments[span.inputIndex]
    const ink = isLast && lastIsEscape ? 'secondary' : segment?.ink
    painted += ink === undefined ? color.textMuted(span.text) : paintActionSpan(span.text, ink)
    if (isLast && lastIsEscape) {
      // The physical Escape span is the Root's ONE target, never a second
      // delegated action on the same cells.
      escape = { startCol: span.startCol, endCol: span.endCol }
      continue
    }
    spans.push({ action: segment?.action, fieldId: segment?.fieldId, startCol: span.startCol, endCol: span.endCol })
  }
  return { line: painted, ...escape === undefined ? {} : { escape }, spans }
}

/** Wrap one sentence into at most `maxLines` cell-accurate lines (a word that
 *  cannot fit is left on its own line and truncated by the caller). */
function wrapCells(text: string, width: number, maxLines: number): string[] {
  const words = sanitizedPhysicalLine(text).split(' ').filter(word => word !== '')
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`
    if (visibleWidth(candidate) <= width || current === '') {
      current = candidate
      continue
    }
    lines.push(current)
    current = word
    if (lines.length === maxLines) return lines
  }
  if (current !== '' && lines.length < maxLines) lines.push(current)
  return lines
}

/** Wrap one sentence into at most `maxLines` cell-accurate lines, HARD-SPLITTING
 *  a token that alone exceeds the width. A safety fact may never be dropped
 *  because one legal value has no break opportunity. */
function wrapCellsHard(text: string, width: number, maxLines: number): {
  readonly lines: readonly string[]
  /** The source text the painted lines really reproduce (spaces normalized). */
  readonly reproduced: string
} {
  const lines: string[] = []
  const breaks: boolean[] = []
  let current = ''
  const flush = (): void => {
    if (current === '') return
    lines.push(current)
    breaks.push(false)
    current = ''
  }
  for (const word of sanitizedPhysicalLine(text).split(' ').filter(part => part !== '')) {
    let rest = word
    while (visibleWidth(rest) > Math.max(1, width)) {
      flush()
      if (lines.length >= maxLines) return { lines, reproduced: lines.join(' ') }
      let take = 0
      while (take < rest.length && visibleWidth(rest.slice(0, take + 1)) <= width) take += 1
      if (take === 0) take = 1
      lines.push(rest.slice(0, take))
      breaks.push(true) // a hard split: mid-token, no space belongs here
      rest = rest.slice(take)
      if (lines.length >= maxLines) return { lines, reproduced: reconstruct(lines, breaks) }
    }
    const candidate = current === '' ? rest : `${current} ${rest}`
    if (visibleWidth(candidate) <= width) {
      current = candidate
      continue
    }
    flush()
    current = rest
    if (lines.length >= maxLines) return { lines, reproduced: reconstruct(lines, breaks) }
  }
  flush()
  return { lines, reproduced: reconstruct(lines, breaks) }
}

/** Rejoin painted lines with the separator each break really was. */
function reconstruct(lines: readonly string[], breaks: readonly boolean[]): string {
  let out = ''
  for (let index = 0; index < lines.length; index += 1) {
    out += lines[index] ?? ''
    if (index < breaks.length - 1 && breaks[index] === false) out += ' '
  }
  return out
}

/** Wrap one labelled detail field with a hanging indent. Returns physical
 *  lines; a long unbreakable token is hard-split (never dropped). */
function wrapField(label: string, value: string, width: number, valueInk: (text: string) => string = color.text): string[] {
  const prefix = `${label}: `
  const prefixWidth = visibleWidth(prefix)
  const valueWidth = Math.max(1, width - prefixWidth)
  const wrapped = wrapCellsHard(value, valueWidth, 1000)
  const lines: string[] = []
  for (let index = 0; index < wrapped.lines.length; index += 1) {
    const text = wrapped.lines[index] ?? ''
    if (index === 0) lines.push(color.textDim(prefix) + valueInk(text))
    else lines.push(' '.repeat(prefixWidth) + valueInk(text))
  }
  return lines
}

/** A bar segment that may advertise a pointer intent. */
type McpBarSegment = ActionBarSegment & {
  readonly action?: McpBarAction
  readonly fieldId?: string
  readonly ink?: 'primary' | 'secondary'
}

/** The page itself. */
export class McpServersPage implements EmbeddedSpecialistPage {
  readonly title = MCP_SERVERS_PAGE_TITLE
  focused = false

  private readonly controller: McpServersController
  private readonly requestRender: () => void
  private readonly done: () => void
  private readonly onDispose: (() => void) | undefined
  private readonly searchInput = new Input({ prompt: '/ ', placeholder: 'filter servers', placeholderStyle: color.textDim })
  /** The legacy direct/page-test row budget (the real Root always supplies a
   *  workbench grant; see `setWebWorkbenchGrant`). */
  private rowGrant = 8
  /** The REAL workbench grant of THIS frame. */
  private grant: WebWorkbenchGrant | undefined
  private paintedGrant: WebWorkbenchGrant | undefined
  private region: McpPageRegion = 'list'
  private searching = false
  private listOffset = 0
  private detailOffset = 0
  /** The focused form row index and its physical scroll offset. */
  private formFocus = 0
  private formOffset = 0
  /** The form's real return origin: Add from the List, Edit from an active
   *  Detail. A width never decides it. */
  private formOrigin: 'list' | 'detail' | undefined
  /** The ACTIVE text input of the form (its row + the value being typed). */
  private formInput: { readonly row: McpFormRow; readonly input: Input; readonly initial: string } | undefined
  /** A pending discard question. `unknown` states that the write may already
   *  have been applied, so the copy never claims nothing was written. */
  private discardConfirm: 'dirty' | 'unknown' | undefined
  /** A fresh instance on each opening, including a reopen before repaint. */
  private discardQuestion = 0
  /** FR4: Esc while the Save is unsettled — a notice, never a discard prompt. */
  private configSavingNotice = false
  /** SUX-07 D8b: the explicit parent-leave warning after an unconfirmed
   *  outcome. Only the user's own `d`/Leave anyway confirms it. */
  private unknownLeave = false
  /** The one current configuration receipt's region (never painted twice). */
  private receiptRegion: 'list' | 'detail' = 'detail'
  /** A page-local informational notice (e.g. a running operation keeps the
   *  page on its List Back). It is presentation-only and dies with the page. */
  private localNotice: { readonly text: string; readonly kind: 'info' | 'error' } | undefined
  /** The number of leading List rows that are header/search chrome, never item
   *  targets or wheel owners. */
  private listHeaderRows = 0
  /** The page-local List rows that really paint an item (wheel owners). */
  private listItemRows: number[] = []
  /**
   * The confirmation the LAST PAINTED frame admitted, by exact identity.
   * A plain boolean would be shared across questions: when a new question opens
   * before the previous frame paints, the old `false` could authorise it.
   */
  private paintedConfirmation: { readonly identity: string; readonly blocked: boolean } | undefined
  private disposed = false
  private revision = 0
  private paint: McpPagePaint | undefined
  /** The last painted Action-Bar spans (id + action + cells), page-local. */
  private lastBarSpans: readonly {
    readonly id: string
    readonly action: McpBarAction
    readonly fieldId: string | undefined
    readonly startCol: number
    readonly endCol: number
  }[] = []
  /** The frame being painted (layout decisions must read THIS grant). */
  private rendering: { readonly width: number; readonly bodyRows: number } | undefined
  /** The physical bar width of the frame being painted. */
  private currentBarWidth = 0
  private paintedEscapeSpanValue: { readonly startCol: number; readonly endCol: number } | undefined
  private grantAwaitingPaintValue = true
  private pressed: {
    readonly target: McpPaintedTarget
    readonly row: number
    readonly startCol: number
    readonly endCol: number
    readonly revision: number
    readonly width: number
    readonly rows: number
    readonly identity: string
  } | undefined

  constructor(intents: {
    readonly controller: McpServersController
    readonly requestRender: () => void
    readonly done: () => void
    /** SUX-07: notified exactly once when this page retires through ANY path,
     *  so the command layer can drop its `activeMcpController` reference. */
    readonly onDispose?: () => void
  }) {
    this.controller = intents.controller
    this.requestRender = intents.requestRender
    this.done = intents.done
    this.onDispose = intents.onDispose
    this.searchInput.onEscape = () => { this.cancelSearch() }
    this.searchInput.onSubmit = () => { this.commitSearch() }
  }

  /** The legacy direct-page row budget. The real Settings Root always supplies
   *  {@link setWebWorkbenchGrant}; this keeps the page a normal component in
   *  isolated unit mounts. */
  setMaxRows(rows: number): void {
    const next = Math.max(1, Math.floor(rows))
    if (next !== this.rowGrant) {
      this.rowGrant = next
      this.grantAwaitingPaintValue = true
      this.paintedEscapeSpanValue = undefined
      this.pressed = undefined
    }
  }

  /** The Root's ONE real body/bar grant for this frame. The page paints only
   *  inside it; the bar width is independent of the body width. */
  setWebWorkbenchGrant(grant: WebWorkbenchGrant): void {
    const changed = this.grant === undefined
      || this.grant.width !== grant.width
      || this.grant.rows !== grant.rows
      || this.grant.barWidth !== grant.barWidth
      || this.grant.allowDual !== grant.allowDual
    this.grant = { ...grant }
    if (!changed) return
    // A new grant has not painted yet: the previous frame's bar/decision
    // geometry belongs to different cells.
    this.lastBarSpans = []
    this.paintedEscapeSpanValue = undefined
    this.paintedConfirmation = undefined
    this.pressed = undefined
  }

  /** SUX-07: the MCP form and every risk question own the whole body. */
  workbenchRequiresFullWidth(): boolean {
    const snapshot = this.controller.snapshot()
    return this.unknownLeave
      || this.discardConfirm !== undefined
      || snapshot.configConfirm !== undefined
      || snapshot.confirmingName !== undefined
      || snapshot.editor !== undefined
  }

  /** The page's current LOCAL region (list or Detail). */
  webWorkbenchRegion(): 'list' | 'detail' {
    return this.region
  }

  /** Whether a USER parent navigation may retire the workbench right now. */
  webWorkbenchBlocksParentNavigation(): boolean {
    const snapshot = this.controller.snapshot()
    return this.workbenchRequiresFullWidth()
      || this.searching
      || snapshot.operation?.phase === 'running'
      || snapshot.configOutcomeUnconfirmed === true
      || snapshot.restartOutcomeUnconfirmed === true
      || snapshot.configStatus?.kind === 'saving'
  }

  /** The embedded-page generic alias (same answer). */
  blocksParentNavigation(): boolean {
    return this.webWorkbenchBlocksParentNavigation()
  }

  /** Whether the untouched LIST may yield the keyboard to the visible rail. */
  webWorkbenchCanYieldToRail(): boolean {
    const snapshot = this.controller.snapshot()
    return this.region === 'list'
      && !this.searching
      && !this.workbenchRequiresFullWidth()
      && snapshot.operation?.phase !== 'running'
      && snapshot.configOutcomeUnconfirmed !== true
      && snapshot.restartOutcomeUnconfirmed !== true
      && snapshot.configStatus?.kind !== 'saving'
  }

  /** Whether a grant/sub-view transition still awaits its paint. */
  grantAwaitingPaint(): boolean {
    const grant = this.grant
    if (grant === undefined) return this.grantAwaitingPaintValue
    const painted = this.paintedGrant
    return this.grantAwaitingPaintValue
      || painted === undefined
      || painted.width !== grant.width
      || painted.rows !== grant.rows
      || painted.barWidth !== grant.barWidth
      || painted.allowDual !== grant.allowDual
  }

  /** Whether a pointer press may arm against the CURRENT painted frame. */
  pointerFrameCurrent(): boolean {
    return this.paint !== undefined && this.paint.identity === this.gestureIdentity()
  }

  /** The complete visible Esc affordance of the LAST painted frame. */
  paintedEscapeSpan(): { readonly startCol: number; readonly endCol: number } | undefined {
    return this.paintedEscapeSpanValue
  }

  /** The page's own SEMANTIC identity for one pointer gesture. */
  gestureIdentity(): string {
    const snapshot = this.controller.snapshot()
    const config = snapshot.config
    const facet = snapshot.selectedConfig
    return [
      this.region,
      this.searching ? this.query() : '',
      snapshot.selectedName ?? '',
      snapshot.confirmingName ?? '',
      snapshot.phase,
      snapshot.operation?.phase ?? '',
      String(snapshot.rows.length),
      snapshot.editor === undefined
        ? ''
        : `editor:${snapshot.editor.mode}:${snapshot.editor.name}:${String(this.formFocus)}:${snapshot.editor.dirty ? 'dirty' : 'clean'}`,
      this.formOrigin ?? '',
      this.confirmationIdentity(snapshot) ?? '',
      this.unknownLeave ? 'unknown-leave' : '',
      this.configSavingNotice ? 'saving-notice' : '',
      snapshot.configOutcomeUnconfirmed === true ? 'config-unknown' : '',
      snapshot.restartOutcomeUnconfirmed === true ? 'restart-unknown' : '',
      `rev:${String(this.revision)}`,
      `obs:${String(snapshot.observationEpoch)}`,
      `cfg-read:${String(snapshot.configurationReadEpoch)}`,
      config === undefined ? 'config:none' : config.kind === 'ready' ? `config:ready:${String(config.revision)}` : `config:${config.kind}`,
      `cfg-status:${snapshot.configStatus?.kind ?? 'none'}`,
      facet === undefined
        ? ''
        : `facet:${facet.provenance}:${String(facet.canDelete)}:${String(facet.canReset)}`,
    ].join(':')
  }

  handleInput(data: string): void {
    if (this.disposed) return
    // The Root forwards a body key only while this page owns the keyboard.
    if (!this.focused) return
    const snapshot = this.controller.snapshot()
    // The explicit unconfirmed-outcome leave warning owns the keyboard.
    if (this.unknownLeave) {
      if (data === 'd' || data === 'D') {
        this.unknownLeave = false
        this.done()
        return
      }
      if (data === 'r' || data === 'R') {
        this.unknownLeave = false
        this.controller.refresh()
        this.bumpRevision()
        return
      }
      if (matchesKey(data, 'escape') || matchesKey(data, 'enter') || matchesKey(data, 'tab')) {
        this.unknownLeave = false
        this.bumpRevision()
      }
      return
    }
    // A CRUD confirmation owns the keyboard: only the explicit answer and Esc
    // are accepted, and neither is ever inferred from another key.
    if (snapshot.configConfirm !== undefined) {
      if (matchesKey(data, 'escape')) {
        this.controller.answerConfigConfirm(false)
        return
      }
      if (data === 'y' || data === 'Y') {
        if (this.confirmationVerdict(snapshot) === 'ready') this.controller.answerConfigConfirm(true)
      }
      return
    }
    // A dirty-discard / unknown-discard confirmation: Keep is the default; only
    // an explicit `d` drops the local draft (zero official writes).
    if (this.discardConfirm !== undefined) {
      if (data === 'd' || data === 'D') {
        if (this.confirmationVerdict(snapshot) !== 'ready') return
        const kind = this.discardConfirm
        this.discardConfirm = undefined
        this.formInput = undefined
        this.controller.discardEditor()
        this.formFocus = 0
        this.formOffset = 0
        this.returnFromEditor(kind === 'unknown')
        return
      }
      if (matchesKey(data, 'enter') || matchesKey(data, 'escape') || matchesKey(data, 'tab')) {
        this.discardConfirm = undefined
        this.bumpRevision()
      }
      return
    }
    // A restart confirmation owns the keyboard.
    if (snapshot.confirmingName !== undefined) {
      if (matchesKey(data, 'escape')) {
        this.controller.answerRestart(false)
        return
      }
      if (data === 'y' || data === 'Y') {
        if (this.confirmationVerdict(snapshot) === 'ready') this.controller.answerRestart(true)
      }
      return
    }
    // The ACTIVE form input consumes every key: a/e/t/d/u/s are input chars.
    if (this.formInput !== undefined) {
      if (matchesKey(data, 'escape')) {
        this.formInput = undefined
        this.bumpRevision()
        return
      }
      if (matchesKey(data, 'enter')) {
        this.commitFormInput()
        return
      }
      this.formInput.input.handleInput(data)
      this.requestRender()
      return
    }
    if (this.searching) {
      if (matchesKey(data, 'escape')) {
        this.cancelSearch()
        return
      }
      if (matchesKey(data, 'enter')) {
        this.commitSearch()
        return
      }
      if (matchesKey(data, 'up')) {
        this.moveSelection(-1, snapshot)
        return
      }
      if (matchesKey(data, 'down')) {
        this.moveSelection(1, snapshot)
        return
      }
      // Every other key (including p/x/r/y) is QUERY TEXT here, never an
      // action with side effects.
      const before = this.searchInput.getValue() ?? ''
      this.searchInput.handleInput(data)
      const after = this.searchInput.getValue() ?? ''
      this.reconcileSelection(snapshot)
      if (after !== before) {
        this.revokePointerGesture()
      } else {
        this.requestRender()
      }
      return
    }
    if (snapshot.editor !== undefined) {
      this.handleEditorInput(data, snapshot)
      return
    }
    if (matchesKey(data, 'escape') || matchesKey(data, 'left')) {
      if (this.region === 'detail') {
        this.region = 'list'
        this.bumpRevision()
        return
      }
      // List Back is the REAL parent exit. A dispatched operation keeps the
      // page mounted and states that it is still being observed.
      if (snapshot.operation?.phase === 'running') {
        this.localNotice = { text: 'Waiting for the Host MCP operation…', kind: 'info' }
        this.bumpRevision()
        return
      }
      if (snapshot.configOutcomeUnconfirmed === true || snapshot.restartOutcomeUnconfirmed === true) {
        this.unknownLeave = true
        this.bumpRevision()
        return
      }
      this.done()
      return
    }
    if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      // SUX-07: a pure local List ↔ Detail focus transfer, only while both
      // regions are really painted. A single-region grant makes it inert.
      if (!this.allowDual()) return
      this.region = this.region === 'list' ? 'detail' : 'list'
      this.bumpRevision()
      return
    }
    if (data === '/') {
      // `/` is a LIST action: from the Detail it first returns to the List,
      // then starts the ONE existing client-local filter.
      this.region = 'list'
      this.searching = true
      this.searchInput.focused = this.focused
      this.bumpRevision()
      return
    }
    if (data === 'r' || data === 'R') {
      this.controller.refresh()
      return
    }
    if (data === 'a' || data === 'A') {
      if (this.controller.canBeginAdd()) {
        this.formOrigin = 'list'
        this.region = 'list'
        this.controller.beginAdd()
        this.enterEditor()
      }
      return
    }
    if (this.region === 'detail') {
      if (matchesKey(data, 'up')) return this.scrollDetail(-1)
      if (matchesKey(data, 'down')) return this.scrollDetail(1)
      if (matchesKey(data, 'pageUp')) return this.scrollDetail(-this.detailViewport())
      if (matchesKey(data, 'pageDown')) return this.scrollDetail(this.detailViewport())
      if (data === 'p' || data === 'P') {
        if (this.visibleSelection(snapshot) !== undefined && this.controller.canOperateSelected()) this.controller.probe()
        return
      }
      if (data === 'x' || data === 'X') {
        if (this.visibleSelection(snapshot) !== undefined && this.controller.canOperateSelected()
          && snapshot.restartOutcomeUnconfirmed !== true) this.controller.beginRestart()
        return
      }
      if (data === 'e' || data === 'E') {
        if (this.visibleSelection(snapshot) !== undefined && this.controller.canBeginEdit()) {
          this.formOrigin = 'detail'
          this.controller.beginEdit()
          this.enterEditor()
        }
        return
      }
      if (data === 't' || data === 'T') {
        if (this.visibleSelection(snapshot) !== undefined && this.controller.canEditConfiguration()) this.controller.beginToggle()
        return
      }
      if (data === 'd' || data === 'D') {
        if (this.visibleSelection(snapshot) !== undefined && this.controller.canEditConfiguration()) this.controller.beginDelete()
        return
      }
      if (data === 'u' || data === 'U') {
        if (this.visibleSelection(snapshot) !== undefined && this.controller.canEditConfiguration()) this.controller.beginReset()
        return
      }
      return
    }
    if (matchesKey(data, 'up')) return this.moveSelection(-1, snapshot)
    if (matchesKey(data, 'down')) return this.moveSelection(1, snapshot)
    if (matchesKey(data, 'pageUp')) return this.moveSelection(-this.listPageStep(), snapshot)
    if (matchesKey(data, 'pageDown')) return this.moveSelection(this.listPageStep(), snapshot)
    if (matchesKey(data, 'enter') || matchesKey(data, 'right')) {
      this.openSelectedDetail(snapshot)
      return
    }
  }

  // ── FR4: the configuration form ───────────────────────────────────────────

  private enterEditor(): void {
    this.region = this.formOrigin === 'list' ? 'list' : 'detail'
    this.formFocus = 0
    this.formOffset = 0
    this.formInput = undefined
    this.discardConfirm = undefined
    this.configSavingNotice = false
    this.unknownLeave = false
    this.bumpRevision()
  }

  /** Return to the REAL origin after the editor closes. Add returns to the
   *  SAME List; Edit returns to the original server's Detail while that exact
   *  target is still current/listed, otherwise the List with the truthful
   *  unavailable/refusal status. */
  private returnFromEditor(unknown: boolean): void {
    const snapshot = this.controller.snapshot()
    const origin = this.formOrigin
    this.formOrigin = undefined
    this.region = origin === 'detail' && snapshot.selectedName !== undefined ? 'detail' : 'list'
    this.receiptRegion = this.region
    if (unknown) this.receiptRegion = this.region
    this.bumpRevision()
  }

  /** The non-Esc Action-Bar spans this page's own bar really painted. The
   *  Settings Root owns the physical last row and DELEGATES these to
   *  {@link activateBarSpan}; the ids are `bar:<action>[:<field>]`. */
  paintedBarSpans(): readonly { readonly id: string; readonly startCol: number; readonly endCol: number }[] {
    if (!this.focused) return []
    return this.lastBarSpans.map(span => ({ id: span.id, startCol: span.startCol, endCol: span.endCol }))
  }

  /** Invoke one delegated last-row intent by its painted id. */
  activateBarSpan(id: string): void {
    if (this.paint?.identity !== this.gestureIdentity()) return
    const span = this.lastBarSpans.find(candidate => candidate.id === id)
    if (span === undefined) return
    if (this.modalOwned() && !this.isModalAction(span.action)) return
    if (span.action === 'activate-field') {
      const row = this.currentFormRows().find(candidate => candidate.id === span.fieldId)
      if (row !== undefined) this.activateFormRow(row, this.controller.snapshot())
    } else {
      this.runBarAction(span.action, this.controller.snapshot())
    }
    this.bumpRevision()
  }

  /** Activate the focused form row's state. */
  private activateFormRow(row: McpFormRow, snapshot: McpServersSnapshot): void {
    const editor = snapshot.editor
    if (editor === undefined) return
    if (snapshot.configOutcomeUnconfirmed === true) return
    switch (row.action.kind) {
      case 'cycle-transport':
        this.controller.setEditorTransport(editor.transport === 'stdio' ? 'streamable-http' : 'stdio')
        this.bumpRevision()
        return
      case 'toggle-enabled':
        this.controller.setEditorEnabled(!editor.enabled)
        this.bumpRevision()
        return
      case 'add-arg':
        this.controller.addEditorArg()
        this.formFocus += 1
        this.bumpRevision()
        return
      case 'add-dict-row':
        this.controller.addEditorDictKey(row.action.field)
        this.bumpRevision()
        return
      case 'edit-name':
        if (!editor.nameEditable) return
        this.openFormInput(row, editor.name)
        return
      case 'edit-text':
        this.openFormInput(row, row.action.field === 'command'
          ? editor.command
          : row.action.field === 'cwd' ? editor.cwd : editor.url)
        return
      case 'edit-arg': {
        const current = editor.args[row.action.index] ?? ''
        this.openFormInput(row, current)
        return
      }
      case 'edit-dict-key': {
        const { field, key } = row.action
        if (!this.controller.canRemoveDictKey(field, key)) return
        const entries = field === 'env' ? editor.env : editor.headers
        this.openFormInput(row, entries.find(entry => entry.key === key)?.key ?? '')
        return
      }
      case 'edit-dict-value':
        // A stored value is NEVER re-displayed: the input starts empty and an
        // empty commit keeps the current value.
        this.openFormInput(row, '')
        return
      case 'cycle-dict-form':
        this.controller.setEditorDictForm(row.action.field, row.action.key,
          this.controller.dictValueForm(row.action.field, row.action.key) === 'reference' ? 'literal' : 'reference')
        this.bumpRevision()
        return
    }
  }

  private openFormInput(row: McpFormRow, initial: string): void {
    const placeholder = row.action.kind === 'edit-dict-value'
      ? this.controller.dictValueForm(row.action.field, row.action.key) === 'literal'
        ? 'value (Enter on empty sets it empty · Esc keeps current)'
        : 'credential REF name (Enter on empty keeps current · Esc cancels)'
      : ''
    const input = new Input({
      prompt: '> ',
      placeholder,
      placeholderStyle: color.textDim,
    })
    input.setValue(initial)
    input.focused = this.focused
    this.formInput = { row, input, initial }
    this.requestRender()
  }

  /** Commit the active input through the controller (never a direct write). */
  private commitFormInput(): void {
    const active = this.formInput
    if (active === undefined) return
    this.formInput = undefined
    const value = active.input.getValue() ?? ''
    switch (active.row.action.kind) {
      case 'edit-name':
        this.controller.setEditorField('name', value.trim())
        break
      case 'edit-text':
        this.controller.setEditorField(active.row.action.field, value)
        break
      case 'edit-arg':
        this.controller.setEditorArg(active.row.action.index, value)
        break
      case 'edit-dict-key': {
        const { field, key } = active.row.action
        const trimmed = value.trim()
        if (trimmed !== '' && trimmed !== key) this.controller.renameEditorDictKey(field, key, trimmed)
        break
      }
      case 'edit-dict-value': {
        const { field, key } = active.row.action
        const form = this.controller.dictValueForm(field, key)
        if (value !== '') {
          this.controller.setEditorDictValue(field, key, value, form)
          break
        }
        if (form === 'literal') {
          this.controller.setEditorDictValue(field, key, '', 'literal')
        }
        break
      }
      default:
        break
    }
    this.bumpRevision()
  }

  private handleEditorInput(data: string, snapshot: McpServersSnapshot): void {
    const editor = snapshot.editor
    if (editor === undefined) return
    const rows = this.currentFormRows()
    if (matchesKey(data, 'escape')) {
      // A DISPATCHED write is already on its way to the Host: leaving the form
      // cannot cancel it, so a `Discard changes?` prompt here would imply that
      // it can. The form stays put and says so instead.
      if (snapshot.configStatus?.kind === 'saving') {
        this.configSavingNotice = true
        this.bumpRevision()
        return
      }
      if (editor.dirty) {
        this.discardQuestion += 1
        this.discardConfirm = snapshot.configOutcomeUnconfirmed === true ? 'unknown' : 'dirty'
        this.bumpRevision()
        return
      }
      this.controller.discardEditor()
      this.formFocus = 0
      this.formOffset = 0
      this.configSavingNotice = false
      this.returnFromEditor(false)
      return
    }
    if (this.configSavingNotice) {
      this.configSavingNotice = false
      this.bumpRevision()
      if (matchesKey(data, 'escape')) return
    }
    if (data === 's' || data === 'S') {
      // Save runs ONLY while the form is the current, painted view and while no
      // unconfirmed outcome forbids a blind retry.
      if (snapshot.configOutcomeUnconfirmed !== true) this.controller.saveEditor()
      return
    }
    if (matchesKey(data, 'up')) {
      this.formFocus = Math.max(0, this.formFocus - 1)
      this.bumpRevision()
      return
    }
    if (matchesKey(data, 'down')) {
      this.formFocus = Math.min(rows.length - 1, this.formFocus + 1)
      this.bumpRevision()
      return
    }
    if (matchesKey(data, 'tab')) {
      this.formFocus = (this.formFocus + 1) % Math.max(1, rows.length)
      this.bumpRevision()
      return
    }
    if (matchesKey(data, 'shift+tab')) {
      this.formFocus = (this.formFocus - 1 + Math.max(1, rows.length)) % Math.max(1, rows.length)
      this.bumpRevision()
      return
    }
    if (matchesKey(data, 'backspace') || matchesKey(data, 'delete')) {
      const row = rows[this.formFocus]
      if (row?.removable === true) {
        switch (row.action.kind) {
          case 'edit-arg': this.controller.removeEditorArg(row.action.index); break
          case 'edit-dict-key': this.controller.removeEditorDictKey(row.action.field, row.action.key); break
          default: break
        }
        this.formFocus = Math.max(0, Math.min(this.formFocus, rows.length - 1))
        this.bumpRevision()
      }
      return
    }
    if (matchesKey(data, 'enter')) {
      const row = rows[this.formFocus]
      if (row !== undefined && this.formRowVerb(row, editor) !== undefined) this.activateFormRow(row, snapshot)
      return
    }
  }

  /** The current form rows, from the ONE pure form model. */
  private currentFormRows(): readonly McpFormRow[] {
    const editor = this.controller.snapshot().editor
    if (editor === undefined) return []
    return mcpFormRows(editor,
      (field, key) => this.controller.dictValueForm(field, key),
      (field, key) => this.controller.canRemoveDictKey(field, key))
  }

  /** The complete explicit verb of one field, or undefined when the row has no
   *  legal executable action (a fixed name, an inherited key rename). */
  private formRowVerb(row: McpFormRow, editor: NonNullable<McpServersSnapshot['editor']>): string | undefined {
    switch (row.action.kind) {
      case 'edit-name': return editor.nameEditable ? 'Edit [Enter]' : undefined
      case 'cycle-transport': return 'Switch [Enter]'
      case 'toggle-enabled': return 'Toggle [Enter]'
      case 'add-arg': return 'Add [Enter]'
      case 'add-dict-row': return 'Add [Enter]'
      case 'edit-text': return 'Edit [Enter]'
      case 'edit-arg': return 'Edit [Enter]'
      case 'edit-dict-key':
        return this.controller.canRemoveDictKey(row.action.field, row.action.key) ? 'Edit [Enter]' : undefined
      case 'edit-dict-value': return 'Edit [Enter]'
      case 'cycle-dict-form': return 'Switch [Enter]'
    }
  }

  /**
   * PR-D: the focused form row when it is a REMOVABLE one. The capability comes
   * from {@link mcpFormRows}'s `removable`, never from the painted text, and
   * never while an input, a question or an unsettled save owns the draft.
   */
  private focusedRemovableRow(snapshot: McpServersSnapshot): McpFormRow | undefined {
    const editor = snapshot.editor
    if (editor === undefined) return undefined
    if (this.formInput !== undefined || this.discardConfirm !== undefined) return undefined
    if (snapshot.configConfirm !== undefined || snapshot.confirmingName !== undefined) return undefined
    if (snapshot.configStatus?.kind === 'saving' || snapshot.configOutcomeUnconfirmed === true) return undefined
    const row = this.currentFormRows()[this.formFocus]
    return row?.removable === true ? row : undefined
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed) return undefined
    const paint = this.paint
    if (paint === undefined || event.width !== paint.width) return undefined
    const bodyRows = Math.max(0, paint.rows - 1)
    if (event.type === 'wheel') {
      if (event.wheelDelta === undefined || event.wheelDelta === 0) return undefined
      if (event.y < 0 || event.y >= bodyRows) return undefined
      // ANY effective wheel input starts a new semantic frame — even a
      // boundary/no-op one or one a modal ignores.
      this.revokePointerGesture()
      if (event.y < this.listHeaderRows
        && (!this.allowDual() || event.x < MCP_LIST_COLUMN_WIDTH)) return { handled: true }
      if (this.modalOwned()) {
        if (this.searching && this.region === 'list' && !this.inDetailAt(event.x)) {
          this.moveSelection(event.wheelDelta < 0 ? -1 : 1, this.controller.snapshot())
        }
        return { handled: true }
      }
      // The full-width form's wheel moves ONLY the current field focus; the
      // hidden list selection and Detail offset never move.
      if (this.controller.snapshot().editor !== undefined) {
        this.handleEditorInput(event.wheelDelta < 0 ? '\x1b[A' : '\x1b[B', this.controller.snapshot())
        return { handled: true }
      }
      if (this.allowDual() && event.x >= this.detailX() && event.x < this.detailX() + this.detailWidth()) {
        this.scrollDetail(event.wheelDelta < 0 ? -1 : 1)
        return { handled: true }
      }
      if (this.allowDual() && event.x < MCP_LIST_COLUMN_WIDTH) {
        if (this.listItemRows.includes(event.y)) {
          this.moveSelection(event.wheelDelta < 0 ? -1 : 1, this.controller.snapshot())
        }
        return { handled: true }
      }
      if (!this.allowDual()) {
        if (this.region === 'detail') this.scrollDetail(event.wheelDelta < 0 ? -1 : 1)
        else if (this.listItemRows.includes(event.y)) this.moveSelection(event.wheelDelta < 0 ? -1 : 1, this.controller.snapshot())
        // A List header/phase/receipt/blank row owns no wheel.
      }
      return { handled: true }
    }
    if (event.height !== bodyRows && event.height !== paint.rows) return undefined
    const current = paint.identity === this.gestureIdentity()
    const modal = this.modalOwned()
    const hit = paint.targets.find(candidate => candidate.row === event.y
      && event.x >= candidate.startCol && event.x < candidate.endCol)
    const target = modal
      ? hit !== undefined && this.isModalTarget(hit) ? hit : undefined
      : hit
    if (event.type === 'press') {
      if (target === undefined || event.button !== 'left' || !current) {
        this.pressed = undefined
        return undefined
      }
      this.pressed = {
        target,
        row: target.row,
        startCol: target.startCol,
        endCol: target.endCol,
        revision: this.revision,
        width: paint.width,
        rows: paint.rows,
        identity: paint.identity,
      }
      return { handled: true }
    }
    if (event.type === 'click') {
      const pressed = this.pressed
      this.pressed = undefined
      if (pressed === undefined || target === undefined || !current) return undefined
      if (pressed.revision !== this.revision
        || pressed.identity !== paint.identity
        || pressed.width !== paint.width
        || pressed.rows !== paint.rows
        || pressed.row !== target.row
        || pressed.startCol !== target.startCol
        || pressed.endCol !== target.endCol
        || pressed.target.kind !== target.kind
        || (pressed.target.kind === 'server-row' && target.kind === 'server-row'
          && pressed.target.name !== target.name)
        || (pressed.target.kind === 'form-row' && target.kind === 'form-row'
          && pressed.target.id !== target.id)
        || (pressed.target.kind === 'form-verb' && target.kind === 'form-verb'
          && pressed.target.id !== target.id)
        || (pressed.target.kind === 'action' && target.kind === 'action'
          && (pressed.target.action !== target.action || pressed.target.fieldId !== target.fieldId))) return undefined
      const snapshot = this.controller.snapshot()
      if (target.kind === 'form-row') {
        // SUX-07: a form-row click only SELECTS the field. The explicit verb
        // (bar or body span) is the only activation.
        this.formFocus = target.index
        this.bumpRevision()
        return { handled: true }
      }
      if (target.kind === 'form-verb') {
        const row = this.currentFormRows().find(candidate => candidate.id === target.id)
        if (row !== undefined) this.activateFormRow(row, snapshot)
        this.bumpRevision()
        return { handled: true }
      }
      if (target.kind === 'action') {
        this.runBarAction(target.action, snapshot)
        this.bumpRevision()
        return { handled: true }
      }
      // A server-row click is ALWAYS a selection — during a search it selects
      // the result without leaving the search or running a Host intent.
      this.controller.select(target.name, this.visibleNames(snapshot))
      this.region = 'list'
      this.bumpRevision()
      return { handled: true }
    }
    return undefined
  }

  /**
   * A new effective wheel input retires this page's pending press and advances
   * the revision. It deliberately does NOT set the paint-waiting gate: a wheel
   * burst keeps scrolling against the last painted grant.
   */
  private revokePointerGesture(): void {
    this.pressed = undefined
    this.revision += 1
    this.requestRender()
  }

  /** Invoke one Action-Bar intent from a pointer click. Every action goes
   *  through the SAME controller admission the keyboard key would use — the bar
   *  never invents a capability, it only mirrors the painted affordance. */
  private runBarAction(action: McpBarAction, snapshot: McpServersSnapshot): void {
    switch (action) {
      case 'back':
        if (snapshot.editor !== undefined) {
          if (snapshot.configStatus?.kind === 'saving') {
            this.configSavingNotice = true
            break
          }
        }
        this.handleInput('\x1b')
        return
      case 'open':
        this.openSelectedDetail(snapshot)
        return
      case 'apply-input':
        this.handleInput('\r')
        return
      case 'cancel':
        this.handleInput('\x1b')
        return
      case 'confirm':
        if (this.confirmationVerdict(snapshot) !== 'ready') return
        if (snapshot.configConfirm !== undefined) this.controller.answerConfigConfirm(true)
        else if (snapshot.confirmingName !== undefined) this.controller.answerRestart(true)
        return
      case 'discard':
        if (this.discardConfirm !== undefined && this.confirmationVerdict(snapshot) === 'ready') {
          const kind = this.discardConfirm
          this.discardConfirm = undefined
          this.formInput = undefined
          this.controller.discardEditor()
          this.configSavingNotice = false
          this.returnFromEditor(kind === 'unknown')
        }
        return
      case 'keep-editing':
        if (this.discardConfirm !== undefined) this.discardConfirm = undefined
        if (this.unknownLeave) this.unknownLeave = false
        return
      case 'leave-anyway':
        if (this.unknownLeave) {
          this.unknownLeave = false
          this.done()
        }
        return
      case 'add':
        if (this.region === 'list' && this.controller.canBeginAdd()) {
          this.formOrigin = 'list'
          this.controller.beginAdd()
          this.enterEditor()
        }
        return
      case 'edit':
        if (this.region === 'detail' && this.controller.canBeginEdit()) {
          this.formOrigin = 'detail'
          this.controller.beginEdit()
          this.enterEditor()
        }
        return
      case 'toggle':
        if (this.region === 'detail' && this.controller.canEditConfiguration()) this.controller.beginToggle()
        return
      case 'delete':
        if (this.region === 'detail' && this.controller.canEditConfiguration()) this.controller.beginDelete()
        return
      case 'reset':
        if (this.region === 'detail' && this.controller.canEditConfiguration()) this.controller.beginReset()
        return
      case 'probe':
        if (this.region === 'detail' && this.controller.canOperateSelected()) this.controller.probe()
        return
      case 'restart':
        if (this.region === 'detail' && this.controller.canOperateSelected()
          && snapshot.restartOutcomeUnconfirmed !== true) this.controller.beginRestart()
        return
      case 'refresh':
        this.controller.refresh()
        return
      case 'save':
        if (snapshot.editor !== undefined && snapshot.configOutcomeUnconfirmed !== true) this.handleInput('s')
        return
      case 'start-search':
        if (!this.searching && this.region === 'list') this.handleInput('/')
        return
      case 'finish-search':
        if (this.searching) this.handleInput('\r')
        return
      case 'remove-form-row':
        if (this.focusedRemovableRow(snapshot) !== undefined) this.handleInput('\x7f')
        return
      case 'activate-field':
        // Delegated ids are resolved in `activateBarSpan`.
        return
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.paint = undefined
    this.pressed = undefined
    this.paintedEscapeSpanValue = undefined
    this.formInput = undefined
    this.discardConfirm = undefined
    this.configSavingNotice = false
    this.unknownLeave = false
    this.controller.dispose()
    this.onDispose?.()
  }

  /** The Action-Bar intents a MODAL may accept from a pointer: its own
   *  decision, never a body change. */
  private isModalAction(action: McpBarAction): boolean {
    return action === 'confirm' || action === 'cancel' || action === 'keep-editing'
      || action === 'discard' || action === 'apply-input' || action === 'leave-anyway'
      || (action === 'finish-search' && this.searching)
  }

  /** Whether a body target is selectable while a modal owns the page. */
  private isModalTarget(target: McpPaintedTarget): boolean {
    if (target.kind === 'action') return this.isModalAction(target.action)
    return this.searching && target.kind === 'server-row' && this.region === 'list'
  }

  /** The exact confirmation the CURRENT state asks, or undefined when none is
   *  open. The id names every fact the answer would commit. */
  private confirmationIdentity(snapshot: McpServersSnapshot): string | undefined {
    if (this.discardConfirm !== undefined) {
      return `discard|${this.discardConfirm}|${String(this.discardQuestion)}`
    }
    if (this.unknownLeave) return 'unknown-leave'
    const confirm = snapshot.configConfirm
    if (confirm !== undefined) {
      switch (confirm.kind) {
        case 'save': return `save|${String(confirm.question)}|${confirm.name}|${String(confirm.capturedRevision)}|${confirm.warning ?? ''}`
        case 'delete': return `delete|${String(confirm.question)}|${confirm.name}|${String(confirm.capturedRevision)}`
        case 'reset': return `reset|${String(confirm.question)}|${confirm.name}|${String(confirm.capturedRevision)}`
        case 'toggle': return `toggle|${String(confirm.question)}|${confirm.name}|${String(confirm.capturedRevision)}|${String(confirm.nextEnabled)}`
      }
    }
    if (snapshot.confirmingName !== undefined) {
      return `restart|${String(snapshot.restartQuestion)}|${snapshot.confirmingName}`
    }
    return undefined
  }

  /**
   * The admission verdict for the OPEN confirmation. `unpainted` means the
   * question exists in state but no frame has yet painted its facts — the
   * answer is refused exactly like a blocked one.
   */
  private confirmationVerdict(snapshot: McpServersSnapshot): 'none' | 'unpainted' | 'blocked' | 'ready' {
    const identity = this.confirmationIdentity(snapshot)
    if (identity === undefined) return 'none'
    const painted = this.paintedConfirmation
    if (painted === undefined || painted.identity !== identity) return 'unpainted'
    return painted.blocked ? 'blocked' : 'ready'
  }

  /** Whether a modal decision owns the surface right now (keyboard + mouse). */
  private modalOwned(): boolean {
    const snapshot = this.controller.snapshot()
    return snapshot.configConfirm !== undefined
      || snapshot.confirmingName !== undefined
      || this.discardConfirm !== undefined
      || this.unknownLeave
      || this.formInput !== undefined
      || this.searching
  }

  invalidate(): void {}

  /** The pane-header line the root paints inside the shared body grant. */
  paneHeader(width: number): string {
    const snapshot = this.controller.snapshot()
    const count = this.visibleRows(snapshot).length
    if (this.workbenchRequiresFullWidth()) {
      return this.focused
        ? color.textStrong(`[${MCP_SERVERS_PAGE_TITLE}]`, 'primary')
        : color.textDim(MCP_SERVERS_PAGE_TITLE)
    }
    if (this.allowDual()) {
      const listActive = this.region === 'list' && this.focused
      const detailActive = this.region === 'detail' && this.focused
      const listLabel = `${MCP_SERVERS_PAGE_TITLE} (${String(count)})`
      const left = listActive ? color.textStrong(`[${listLabel}]`, 'primary') : color.textDim(listLabel)
      const right = detailActive ? color.textStrong('[Details]', 'primary') : color.textDim('Details')
      const listWidth = Math.min(MCP_LIST_COLUMN_WIDTH, width)
      const leftFitted = fit(left, listWidth)
      const rightFitted = fit(right, Math.max(1, width - listWidth - 2))
      return fit(`${leftFitted}${' '.repeat(2)}${rightFitted}`, width)
    }
    if (this.region === 'detail') {
      return this.focused ? color.textStrong('[Details]', 'primary') : color.textDim('Details')
    }
    const label = `${MCP_SERVERS_PAGE_TITLE} (${String(count)})`
    return this.focused ? color.textStrong(`[${label}]`, 'primary') : color.textDim(label)
  }

  // ── layout helpers ────────────────────────────────────────────────────────

  private bodyRows(): number {
    return this.grant === undefined ? Math.max(0, this.rowGrant - 1) : this.grant.rows
  }

  private bodyWidth(width: number): number {
    return this.grant?.width ?? width
  }

  private barWidth(width: number): number {
    return this.grant?.barWidth ?? width
  }

  private allowDual(): boolean {
    return this.grant?.allowDual === true && this.bodyRows() >= 2
  }

  private detailX(): number {
    return Math.min(MCP_LIST_COLUMN_WIDTH, this.rendering?.width ?? this.bodyWidth(this.paint?.width ?? 0)) + 2
  }

  private detailWidth(): number {
    const width = this.rendering?.width ?? this.bodyWidth(this.paint?.width ?? 0)
    return Math.max(1, width - this.detailX())
  }

  private detailViewport(): number {
    return Math.max(1, this.bodyRows() - 1)
  }

  private listPageStep(): number {
    return Math.max(1, this.bodyRows() - 1)
  }

  private bumpRevision(): void {
    this.revision += 1
    this.grantAwaitingPaintValue = true
    this.paintedEscapeSpanValue = undefined
    this.requestRender()
  }

  // ── list/search state ─────────────────────────────────────────────────────

  private query(): string {
    return (this.searchInput.getValue() ?? '').trim().toLowerCase()
  }

  private visibleNames(snapshot: McpServersSnapshot): readonly string[] {
    const query = this.query()
    if (query === '') return snapshot.rows.map(row => row.name)
    return snapshot.rows.filter(row => row.name.toLowerCase().includes(query)).map(row => row.name)
  }

  private visibleRows(snapshot: McpServersSnapshot): readonly McpServersRow[] {
    const names = new Set(this.visibleNames(snapshot))
    return snapshot.rows.filter(row => names.has(row.name))
  }

  /** The selected name only while it is really inside the current visible
   *  (filtered) set; a hidden controller selection can never open/act. */
  private visibleSelection(snapshot: McpServersSnapshot): string | undefined {
    const name = snapshot.selectedName
    return name !== undefined && this.visibleNames(snapshot).includes(name) ? name : undefined
  }

  private moveSelection(delta: number, snapshot: McpServersSnapshot): void {
    const names = this.visibleNames(snapshot)
    if (names.length === 0) return
    this.controller.move(delta, names)
    this.reconcileSelection(snapshot)
    this.bumpRevision()
  }

  /** Selection must stay inside the visible (filtered) rows. */
  private reconcileSelection(snapshot: McpServersSnapshot): void {
    const names = this.visibleNames(snapshot)
    if (names.length === 0) return
    if (snapshot.selectedName === undefined || !names.includes(snapshot.selectedName)) {
      this.controller.select(names[0], names)
    }
  }

  private openSelectedDetail(snapshot: McpServersSnapshot): void {
    if (this.visibleSelection(snapshot) === undefined) return
    this.region = 'detail'
    this.detailOffset = 0
    this.bumpRevision()
  }

  private cancelSearch(): void {
    this.searching = false
    this.searchInput.setValue('')
    this.searchInput.focused = false
    this.bumpRevision()
  }

  private commitSearch(): void {
    this.searching = false
    this.searchInput.focused = false
    this.reconcileSelection(this.controller.snapshot())
    this.bumpRevision()
  }

  private scrollDetail(delta: number): void {
    const max = Math.max(0, this.detailContent(this.controller.snapshot(), this.detailWidth()).lines.length - this.detailViewport())
    const next = Math.min(Math.max(0, this.detailOffset + delta), max)
    if (next === this.detailOffset) return
    this.detailOffset = next
    this.bumpRevision()
  }

  /** Whether one page-local cell belongs to the Detail column. */
  private inDetailAt(x: number): boolean {
    return this.allowDual() ? x >= this.detailX() : this.region === 'detail'
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  render(width: number): string[] {
    if (this.disposed) return [fit('', width)]
    const bodyRows = this.bodyRows()
    const bodyWidth = this.bodyWidth(width)
    this.rendering = { width: bodyWidth, bodyRows }
    this.grantAwaitingPaintValue = false
    try {
      return this.renderForGrant(bodyWidth, bodyRows, width)
    } finally {
      this.rendering = undefined
    }
  }

  private renderForGrant(bodyWidth: number, bodyRows: number, rawWidth: number): string[] {
    const snapshot = this.controller.snapshot()
    this.currentBarWidth = this.barWidth(rawWidth)
    // A saved/retired editor closes itself: return to its REAL origin so the ONE
    // current configuration receipt is visible without an extra key.
    if (snapshot.editor === undefined && this.formOrigin !== undefined && !this.workbenchRequiresFullWidth()) {
      this.returnFromEditor(false)
    }
    if (!this.searching) this.reconcileSelection(snapshot)
    const targets: McpPaintedTarget[] = []
    const lines: string[] = []
    this.paintedConfirmation = undefined

    if (bodyRows === 0) {
      const bar = this.renderBar(this.barWidth(rawWidth), snapshot, true)
      this.publishBar(bar, targets, 0)
      const paintedIdentity = this.gestureIdentity()
      this.paint = { width: bodyWidth, rows: 1, targets, identity: paintedIdentity }
      this.paintedGrant = this.grant === undefined ? undefined : { ...this.grant }
      return [fit(bar.line, this.barWidth(rawWidth))]
    }

    if (this.workbenchRequiresFullWidth()) {
      const full = this.renderFullWidth(snapshot, bodyWidth, bodyRows, targets)
      lines.push(...full)
    } else if (this.allowDual()) {
      const listWidth = Math.min(MCP_LIST_COLUMN_WIDTH, bodyWidth)
      const detailWidth = Math.max(1, bodyWidth - listWidth - 2)
      const list = this.renderList(snapshot, listWidth, bodyRows, targets)
      const detail = this.renderDetail(snapshot, detailWidth, bodyRows,
        this.focused && this.region === 'detail' ? targets : undefined,
        this.detailX())
      for (let index = 0; index < bodyRows; index += 1) {
        lines.push(composeRow(list[index] ?? '', detail[index] ?? '', bodyWidth))
      }
    } else if (!this.focused || this.region === 'list') {
      // A passive single-region grant is the rail's own List preview; the
      // page's active Detail region must never leak into the rail seat.
      lines.push(...this.renderList(snapshot, bodyWidth, bodyRows, targets))
    } else {
      lines.push(...this.renderDetail(snapshot, bodyWidth, bodyRows, targets, 0))
    }
    while (lines.length < bodyRows) lines.push(fit('', bodyWidth))
    const bar = this.renderBar(this.barWidth(rawWidth), snapshot, false)
    this.publishBar(bar, targets, lines.length)
    lines.push(fit(bar.line, this.barWidth(rawWidth)))
    const paintedIdentity = this.gestureIdentity()
    this.paint = {
      width: bodyWidth,
      rows: bodyRows + 1,
      targets,
      identity: paintedIdentity,
    }
    this.paintedGrant = this.grant === undefined ? undefined : { ...this.grant }
    return lines.slice(0, bodyRows + 1)
  }

  private publishBar(
    bar: ReturnType<typeof paintBar>,
    targets: McpPaintedTarget[],
    row: number,
  ): void {
    this.paintedEscapeSpanValue = bar.escape
    this.lastBarSpans = []
    for (const span of bar.spans) {
      if (span.action === undefined) continue
      const id = span.fieldId === undefined ? `bar:${span.action}` : `bar:${span.action}:${span.fieldId}`
      this.lastBarSpans = [...this.lastBarSpans, {
        id,
        action: span.action,
        fieldId: span.fieldId,
        startCol: span.startCol,
        endCol: span.endCol,
      }]
      targets.push({ kind: 'action', action: span.action, ...span.fieldId === undefined ? {} : { fieldId: span.fieldId }, row, startCol: span.startCol, endCol: span.endCol })
    }
  }

  /** The full-width form / risk / unconfirmed-leave body. */
  private renderFullWidth(snapshot: McpServersSnapshot, width: number, rows: number, targets: McpPaintedTarget[]): string[] {
    const lines: string[] = []
    if (this.unknownLeave) {
      lines.push(...this.unknownLeaveBody(width, rows).map(line => fit(color.warning(line), width)))
      return lines.slice(0, rows)
    }
    if (this.discardConfirm !== undefined) {
      const body = this.confirmationBody(snapshot, width, rows)
      this.paintedConfirmation = this.confirmationIdentity(snapshot) === undefined
        ? undefined
        : { identity: this.confirmationIdentity(snapshot) as string, blocked: body.blocked }
      lines.push(...body.lines.map(line => fit(color.warning(line), width)))
      return lines.slice(0, rows)
    }
    if (snapshot.configConfirm !== undefined || snapshot.confirmingName !== undefined) {
      const body = this.confirmationBody(snapshot, width, rows)
      const identity = this.confirmationIdentity(snapshot) as string
      this.paintedConfirmation = { identity, blocked: body.blocked }
      lines.push(...body.lines.map(line => fit(color.warning(line), width)))
      return lines.slice(0, rows)
    }
    if (snapshot.editor !== undefined) {
      lines.push(...this.renderEditor(snapshot, snapshot.editor, width, rows, targets))
      return lines.slice(0, rows)
    }
    return lines
  }

  /** The editor body: identity line(s), fields, input and the ONE current
   *  status line. */
  private renderEditor(
    snapshot: McpServersSnapshot,
    editor: NonNullable<McpServersSnapshot['editor']>,
    width: number,
    rows: number,
    targets: McpPaintedTarget[],
  ): string[] {
    const lines: string[] = []
    const identity = this.editorIdentity(editor)
    lines.push(...this.wrapIdentity(identity, width))
    const statusText = this.configSavingNotice
      ? 'Already saving — the write cannot be cancelled here'
      : this.discardConfirm !== undefined
        ? 'Leave the form to answer the discard question'
        : `${mcpFormStatusText(editor, snapshot.configStatus?.text)} · rev ${String(editor.capturedRevision)}`
    const statusLines = wrapCellsHard(statusText, Math.max(1, width), 2).lines
    const statusRows = statusLines.length
    const inputRows = this.formInput === undefined ? 0 : 1
    const fieldRows = Math.max(0, rows - lines.length - statusRows - inputRows)
    const allRows = this.currentFormRows()
    if (this.formFocus >= allRows.length) this.formFocus = Math.max(0, allRows.length - 1)
    const probe = renderMcpConfigForm(editor, width, Math.max(1, fieldRows), this.formFocus, 0,
      (field, key) => this.controller.dictValueForm(field, key),
      (field, key) => this.controller.canRemoveDictKey(field, key))
    const focusedRow = probe.focusedContentRow >= 0 ? probe.focusedContentRow : 0
    if (focusedRow < this.formOffset) this.formOffset = focusedRow
    if (focusedRow >= this.formOffset + fieldRows) this.formOffset = focusedRow - fieldRows + 1
    const rendered = renderMcpConfigForm(editor, width, Math.max(1, fieldRows), this.formFocus, this.formOffset,
      (field, key) => this.controller.dictValueForm(field, key),
      (field, key) => this.controller.canRemoveDictKey(field, key))
    lines.push(...rendered.lines.slice(0, fieldRows))
    // The bar's explicit verb is the primary route; when the bar really drops
    // it, the focused row paints its OWN complete verb span (same sink).
    const barDropsVerb = !this.formBarContainsVerb(width, editor)
    if (barDropsVerb && snapshot.configStatus?.kind !== 'saving' && snapshot.configOutcomeUnconfirmed !== true
      && this.formInput === undefined && fieldRows > 0) {
      const row = allRows[this.formFocus]
      const verb = row === undefined ? undefined : this.formRowVerb(row, editor)
      const painted = rendered.painted.find(candidate => candidate.row.id === row?.id)
      if (row !== undefined && verb !== undefined && painted !== undefined && painted.line >= this.formOffset
        && painted.line < this.formOffset + fieldRows) {
        const line = lines[lines.length - fieldRows + (painted.line - this.formOffset)]
        const suffix = ` ${verb}`
        if (line !== undefined && visibleWidth(stripAnsi(line) + suffix) <= width) {
          const index = lines.length - fieldRows + (painted.line - this.formOffset)
          lines[index] = line + color.textMuted(suffix)
          const indexField = allRows.findIndex(candidate => candidate.id === row.id)
          targets.push({
            kind: 'form-verb',
            id: row.id,
            index: indexField,
            row: index,
            startCol: Math.max(0, width - visibleWidth(suffix)),
            endCol: width,
          })
        }
      }
    }
    if (this.formInput !== undefined) {
      const [inputLine] = this.formInput.input.render(width)
      lines.push(fit(color.textMuted('edit: ') + (inputLine ?? ''), width))
    }
    if (lines.length < rows) {
      for (const statusLine of statusLines) {
        lines.push(fit(this.discardConfirm !== undefined || snapshot.configStatus === undefined
          ? color.textDim(statusLine)
          : this.configStatusInk({ ...snapshot.configStatus, text: statusLine }), width))
      }
    }
    while (lines.length < rows) lines.push(fit('', width))
    // Field rows that really painted (identity/status/input lines are not fields).
    const fixedRows = this.wrapIdentity(identity, width).length
    for (const paintedRow of rendered.painted) {
      const index = allRows.findIndex(candidate => candidate.id === paintedRow.row.id)
      if (index < 0) continue
      const row = fixedRows + (paintedRow.line - this.formOffset)
      if (row < 0 || row >= rows) continue
      targets.push({ kind: 'form-row', id: paintedRow.row.id, index, row, startCol: 0, endCol: width })
    }
    return lines.slice(0, rows)
  }

  /** Whether the form bar keeps the current field's complete verb segment. */
  private formBarContainsVerb(width: number, editor: NonNullable<McpServersSnapshot['editor']>): boolean {
    const row = this.currentFormRows()[this.formFocus]
    const verb = row === undefined ? undefined : this.formRowVerb(row, editor)
    if (verb === undefined) return true
    const bar = this.formBarSegments(this.controller.snapshot(), editor)
    const layout = layoutActionBarRow(bar, width)
    return layout.spans.some(span => bar[span.inputIndex]?.action === 'activate-field')
  }

  /** The editor's fixed identity line(s). */
  private editorIdentity(editor: NonNullable<McpServersSnapshot['editor']>): { full: string; withoutSource: string; name: string } {
    const name = editor.name === '' ? '(unnamed)' : sanitizedPhysicalLine(editor.name)
    const mode = editor.mode === 'add' ? 'Add' : 'Edit'
    const source = editor.mode === 'add' ? 'new user server' : this.editorSourceLabel(editor.name)
    return { full: `${name} · ${mode} · ${source}`, withoutSource: `${name} · ${mode}`, name }
  }

  /** Wrap the form identity, keeping the full name and mode before the source. */
  private wrapIdentity(identity: { full: string; withoutSource: string; name: string }, width: number): string[] {
    for (const tier of [identity.full, identity.withoutSource, identity.name]) {
      const lines = wrapCellsHard(tier, Math.max(1, width - 2), 2).lines
      if (lines.length === 1 && visibleWidth(tier) <= width - 2) {
        return [color.textStrong('> ', 'primary') + color.textStrong(tier, 'primary')].map(line => fit(line, width))
      }
    }
    const picked = wrapCellsHard(identity.name, Math.max(1, width - 2), 2).lines
    return picked.map((line, index) => fit((index === 0 ? color.textStrong('> ', 'primary') : '  ') + color.textStrong(line, 'primary'), width))
  }

  /** The source of the entry being edited (from the same descriptor). */
  private editorSourceLabel(name: string): string {
    const snapshot = this.controller.snapshot()
    const entry = snapshot.config?.kind === 'ready'
      ? snapshot.config.entries.find(candidate => candidate.name === name)
      : undefined
    if (entry === undefined) return 'configuration'
    return entry.provenance === 'user-added'
      ? 'user-added'
      : entry.provenance === 'inherited' ? 'inherited' : 'overridden (user)'
  }

  /** The list column of the active or passive List region. */
  private renderList(snapshot: McpServersSnapshot, width: number, rows: number, targets: McpPaintedTarget[]): string[] {
    const lines: string[] = []
    const visible = this.visibleRows(snapshot)
    const notice = this.localNotice ?? snapshot.notice
    const columns = this.listColumns(width, visible)
    const showHeader = rows >= 4 && width >= 24
    this.listHeaderRows = 0
    this.listItemRows = []
    if (this.searching) {
      const [searchLine] = this.searchInput.render(width)
      lines.push(fit(color.textMuted('search: ') + (searchLine ?? ''), width))
      this.listHeaderRows = 1
    } else if (showHeader) {
      lines.push(this.listHeader(width, columns))
      this.listHeaderRows = 1
    }
    // An empty roster already paints its ONE truthful phase sentence; never
    // repeat it as a second bottom line.
    const phaseRows = snapshot.phase === 'ready' || visible.length === 0 ? 0 : 1
    const configRows = snapshot.configStatus !== undefined && this.receiptRegion === 'list' ? 1 : 0
    const noticeRows = notice === undefined ? 0 : 1
    const summaryRows = !this.allowDual() && visible.length > 0 && rows > 4 ? 1 : 0
    const reserved = lines.length + phaseRows + configRows + noticeRows + summaryRows
    const viewport = Math.max(1, rows - reserved)
    const blocks: Array<{ name: string; lines: readonly string[]; start: number; end: number; selected: boolean }> = []
    let blockCursor = 0
    for (const row of visible) {
      const block = this.listBlock(row, width, columns, row.name === snapshot.selectedName, this.focused && this.region === 'list')
      blocks.push({ ...block, start: blockCursor, end: blockCursor + block.lines.length - 1 })
      blockCursor += block.lines.length
    }
    const selectedBlock = blocks.find(block => block.selected)
    if (selectedBlock !== undefined) {
      if (selectedBlock.end - selectedBlock.start + 1 > viewport) {
        // A block taller than the viewport keeps its IDENTITY line visible.
        this.listOffset = selectedBlock.start
      } else {
        if (selectedBlock.start < this.listOffset) this.listOffset = selectedBlock.start
        if (selectedBlock.end >= this.listOffset + viewport) this.listOffset = selectedBlock.end - viewport + 1
      }
    }
    const total = blocks.length === 0 ? 0 : (blocks[blocks.length - 1]?.end ?? 0) + 1
    this.listOffset = Math.min(Math.max(0, this.listOffset), Math.max(0, total - viewport))
    const rowTop = lines.length
    if (visible.length === 0) {
      const text = snapshot.phase === 'loading'
        ? 'Loading MCP servers…'
        : this.query() !== ''
          ? 'No managed MCP servers match'
          : snapshot.phase === 'unavailable'
            ? `UNAVAILABLE · ${snapshot.phaseReason ?? 'Host MCP Manager not mounted'}`
            : snapshot.phase === 'read-error'
              ? `READ ERROR · ${snapshot.phaseReason ?? 'observation lost'}`
              : 'No managed MCP servers'
      const emptyLines = wrapCellsHard(text, Math.max(1, width), Math.max(1, rows - lines.length)).lines
      for (const emptyLine of emptyLines) {
        lines.push(snapshot.phase === 'unavailable' || snapshot.phase === 'read-error'
          ? color.error(emptyLine)
          : this.emptyInk(emptyLine))
      }
    } else {
      for (let index = 0; index < viewport; index += 1) {
        const physical = this.listOffset + index
        const block = blocks.find(candidate => physical >= candidate.start && physical <= candidate.end)
        if (block === undefined) {
          lines.push(fit('', width))
          continue
        }
        const line = block.lines[physical - block.start] ?? ''
        lines.push(fit(line, width))
        this.listItemRows.push(rowTop + index)
        targets.push({ kind: 'server-row', name: block.name, row: rowTop + index, startCol: 0, endCol: width })
      }
    }
    while (lines.length < rows - phaseRows - configRows - noticeRows - summaryRows) lines.push(fit('', width))
    if (summaryRows === 1) {
      const selected = visible.find(row => row.name === snapshot.selectedName)
      const text = selected === undefined
        ? 'No server selected'
        : `${selected.name} · ${mcpServerStatusText(selected.status)} · ${selected.source}`
      lines.push(fit(color.textDim(truncateToWidth(sanitizedPhysicalLine(text), width, '…', false)), width))
    }
    if (phaseRows === 1) lines.push(fit(this.phaseLine(snapshot, width), width))
    if (configRows === 1 && snapshot.configStatus !== undefined) lines.push(fit(this.configStatusLine(snapshot.configStatus, width), width))
    if (noticeRows === 1 && notice !== undefined) lines.push(fit(this.noticeLine(notice, width), width))
    return lines.slice(0, rows)
  }

  private listColumns(width: number, visible: readonly McpServersRow[]): { name: number; status: number; source: number } {
    const statusMax = visible.length === 0
      ? 0
      : Math.max(...visible.map(row => visibleWidth(mcpServerStatusText(row.status))))
    const sourceFits = width >= 56 && width >= 2 + 1 + 12 + 1 + statusMax + 1 + 17
    const status = sourceFits ? Math.max(8, statusMax) : Math.min(Math.max(8, statusMax), Math.max(8, width - 2 - 1 - 12))
    const name = Math.max(6, width - 2 - 1 - status - (sourceFits ? 18 : 0))
    return { name, status, source: sourceFits ? 17 : 0 }
  }

  private listBlock(
    row: McpServersRow,
    width: number,
    columns: { name: number; status: number; source: number },
    selected: boolean,
    active: boolean,
  ): { readonly name: string; readonly lines: readonly string[]; readonly start: number; readonly end: number; readonly selected: boolean } {
    const cursor = selected && active ? color.textStrong('> ', 'primary') : '  '
    const plainName = truncateToWidth(sanitizedPhysicalLine(row.name), columns.name, '…', false)
    const paddedName = plainName + ' '.repeat(Math.max(0, columns.name - visibleWidth(plainName)))
    const statusText = mcpServerStatusText(row.status)
    const statusLines = wrapCellsHard(statusText, columns.status, 1000).lines
    const source = row.source
    const lines: string[] = []
    for (let index = 0; index < statusLines.length; index += 1) {
      const statusLine = statusLines[index] ?? ''
      const paddedStatus = statusLine + ' '.repeat(Math.max(0, columns.status - visibleWidth(statusLine)))
      const namePart = index === 0 ? paddedName : ' '.repeat(columns.name)
      const cursorPart = index === 0 ? cursor : '  '
      const sourcePart = index === 0 && columns.source > 0
        ? ' ' + fit(sourceInk(source), columns.source)
        : columns.source > 0 ? ' '.repeat(columns.source + 1) : ''
      const nameInk = selected ? color.textStrong(namePart, 'primary') : color.text(namePart)
      lines.push(cursorPart + nameInk + ' ' + statusInk(row.status, paddedStatus) + sourcePart)
    }
    return { name: row.name, lines, start: 0, end: 0, selected }
  }

  private listHeader(width: number, columns: { name: number; status: number; source: number }): string {
    const names = 'Name' + ' '.repeat(Math.max(0, columns.name - 4))
    const statuses = 'Status' + ' '.repeat(Math.max(0, columns.status - 6))
    if (columns.source === 0) return fit(color.textMuted(`  ${names} ${statuses}`), width)
    const sources = 'Source' + ' '.repeat(Math.max(0, columns.source - 6))
    return fit(color.textMuted(`  ${names} ${statuses} ${sources}`), width)
  }

  private emptyInk(text: string): string {
    return color.textDim(text)
  }

  private phaseLine(snapshot: McpServersSnapshot, width: number): string {
    if (snapshot.phase === 'loading') return color.textDim('Loading MCP servers…')
    if (snapshot.phase === 'unavailable') {
      return color.error(truncateToWidth(`UNAVAILABLE · ${snapshot.phaseReason ?? 'Host MCP Manager not mounted'}`, width, '…', false))
    }
    return color.warning(truncateToWidth(`READ ERROR · ${snapshot.phaseReason ?? 'observation lost'} (showing last known)`, width, '…', false))
  }

  private noticeLine(notice: { readonly text: string; readonly kind: 'info' | 'error' }, width: number): string {
    const text = truncateToWidth(sanitizedPhysicalLine(notice.text), width, '…', false)
    return notice.kind === 'error' ? color.error(text) : color.textDim(text)
  }

  /** FR4: the configuration-action status ink. */
  private configStatusInk(status: McpConfigStatus): string {
    switch (status.kind) {
      case 'saved': return color.success(status.text)
      case 'no-changes': return color.textMuted(status.text)
      case 'saving': return color.textDim(status.text)
      case 'unconfirmed': return color.warning(status.text)
      case 'conflict':
      case 'rejected':
      case 'unavailable': return color.error(status.text)
    }
  }

  private configStatusLine(status: McpConfigStatus, width: number): string {
    return truncateToWidth(sanitizedPhysicalLine(status.text), width, '…', false)
      .replace(/^.*$/u, (text) => this.configStatusInk({ ...status, text }))
  }

  /** The detail lines of the selected server (fixed field order, wrapped). */
  private detailLines(snapshot: McpServersSnapshot, width: number): string[] {
    const lines: string[] = []
    if (snapshot.phase !== 'ready') {
      const fact = snapshot.phase === 'unavailable'
        ? `UNAVAILABLE · ${snapshot.phaseReason ?? 'Host MCP Manager not mounted'}`
        : `READ ERROR · ${snapshot.phaseReason ?? 'observation lost'} (showing last known)`
      for (const line of wrapCellsHard(fact, width, 1000).lines) lines.push(color.error(line))
    }
    const row = snapshot.rows.find(candidate => candidate.name === snapshot.selectedName)
    if (row === undefined) {
      // A non-ready observation states its OWN reason; it must never also claim
      // an empty managed fleet.
      if (snapshot.phase === 'ready') {
        lines.push(snapshot.rows.length === 0
          ? color.textDim('No managed MCP servers')
          : color.textDim('Select a managed server'))
      }
      return lines
    }
    const add = (label: string, value: string, ink: (text: string) => string = color.text): void => {
      lines.push(...wrapField(label, value, width, ink))
    }
    add('Server', row.name)
    add('Source', row.source, () => sourceInk(row.source))
    const config = snapshot.selectedConfig
    if (config !== undefined) {
      add('Configuration', config.provenance === 'user-added'
        ? 'User-added'
        : config.provenance === 'inherited' ? 'Inherited' : 'Overridden (user)')
      if (config.enabled !== undefined) add('Saved enabled', config.enabled ? 'yes' : 'no')
      const transport = this.selectedConfigTransport(snapshot)
      if (transport !== undefined) add('Saved transport', transport)
    }
    add('Transport', 'Not exposed', color.textDim)
    add('State', mcpServerStatusText(row.status), (text) => statusInk(row.status, text))
    const status = row.status
    if (status.state === 'connected') add('Tool count', String(status.toolCount))
    if (status.state === 'connecting') add('Attempt', `${String(status.attempt)}${status.attempt === 0 ? ' (first attempt)' : ''}`)
    if (status.state === 'reconnecting') {
      add('Attempt/retry', `${String(status.attempt)}/${String(status.maxAttempts)} · next retry in ${String(Math.max(0, Math.ceil((status.nextRetryAtMs - Date.now()) / 1000)))}s`)
    }
    const lastError = status.state === 'waiting-credentials' || status.state === 'reconnecting'
      ? status.lastError
      : status.state === 'failed' && status.reason !== 'cleanup'
        ? status.lastError
        : undefined
    if (lastError !== undefined) add('Last error', sanitizedPhysicalLine(lastError), color.error)
    if (status.state === 'failed' && status.reason === 'cleanup') {
      add('Cleanup', status.result.closeConfirmed ? 'failed after closure' : 'not confirmed', color.error)
    }
    if (status.state === 'closed' && !status.result.closeConfirmed) {
      add('Cleanup', 'not confirmed', color.warning)
    }
    if (snapshot.lastProbe !== undefined && snapshot.lastProbe.name === row.name) {
      const probe = snapshot.lastProbe.value
      add('Last probe', probe.ok
        ? `ok · ${String(probe.toolNames.length)}${probe.truncated ? '+' : ''} tools · ${String(probe.durationMs)} ms · ${probe.closeConfirmed ? 'closed' : 'cleanup not confirmed'}`
        : `failed at ${probe.stage} · ${sanitizedPhysicalLine(probe.message)}`,
      (text) => snapshot.lastProbe?.kind === 'passed' ? color.text(text) : color.error(text))
    }
    if (snapshot.operation !== undefined && snapshot.operation.name === row.name) {
      add('Operation', snapshot.operation.text ?? snapshot.operation.kind,
        (text) => snapshot.operation?.phase === 'failed' ? color.error(text) : color.textDim(text))
    }
    if (snapshot.configStatus !== undefined && snapshot.configStatus.kind !== 'saving' && this.receiptRegion === 'detail') {
      const receipt = snapshot.configStatus
      add('Configuration', receipt.text, (text) => this.configStatusInk({ ...receipt, text }))
    }
    return lines
  }

  /** The saved transport of the selected entry (from the same descriptor). */
  private selectedConfigTransport(snapshot: McpServersSnapshot): string | undefined {
    const entry = snapshot.config?.kind === 'ready'
      ? snapshot.config.entries.find(candidate => candidate.name === snapshot.selectedName)
      : undefined
    return entry?.effective.transport
  }

  private renderDetail(
    snapshot: McpServersSnapshot,
    width: number,
    rows: number,
    targets?: McpPaintedTarget[],
    startCol = 0,
  ): string[] {
    const lines: string[] = []
    this.listHeaderRows = 0
    const notice = this.localNotice ?? snapshot.notice
    const noticeRows = notice === undefined || (this.allowDual() && this.region !== 'detail') ? 0 : 1
    const viewport = Math.max(1, rows - noticeRows)
    const content = this.detailContent(snapshot, width)
    const all = content.lines
    this.detailOffset = Math.min(Math.max(0, this.detailOffset), Math.max(0, all.length - viewport))
    for (let index = 0; index < viewport; index += 1) {
      const line = all[this.detailOffset + index]
      lines.push(line === undefined ? fit('', width) : fit(line, width))
    }
    if (targets !== undefined) {
      for (const action of content.actions) {
        const row = action.line - this.detailOffset
        if (row < 0 || row >= viewport) continue
        targets.push({ kind: 'action', action: action.action, row, startCol, endCol: startCol + Math.min(width, action.width) })
      }
    }
    if (noticeRows === 1 && notice !== undefined) lines.push(fit(this.noticeLine(notice, width), width))
    return lines.slice(0, rows)
  }

  /** The detail body plus the body action rows for bar segments the physical
   *  bar really had to drop (never a second bar, never a duplicate primary). */
  private detailContent(snapshot: McpServersSnapshot, width: number): {
    readonly lines: readonly string[]
    readonly actions: readonly { readonly line: number; readonly action: McpBarAction; readonly width: number }[]
  } {
    const lines = this.detailLines(snapshot, width)
    if (!this.focused || this.region !== 'detail') return { lines, actions: [] }
    const segments = this.detailBarSegments(snapshot)
    const layout = layoutActionBarRow(segments, Math.max(1, this.currentBarWidth))
    const painted = new Set(layout.spans.map(span => segments[span.inputIndex]?.action))
    // The physical Esc is the Root's target and is never a body fallback.
    const last = segments[segments.length - 1]
    if (last?.action !== undefined) painted.add(last.action)
    const dropped = segments.filter(segment => segment.action !== undefined && !painted.has(segment.action))
    if (dropped.length === 0) return { lines, actions: [] }
    const actions: { line: number; action: McpBarAction; width: number }[] = []
    lines.push('')
    lines.push(color.textMuted('Actions'))
    for (const segment of dropped) {
      if (segment.action === undefined) continue
      const text = segment.ink === 'primary'
        ? color.textStrong(segment.text, 'primary')
        : color.text(segment.text)
      actions.push({ line: lines.length, action: segment.action, width: visibleWidth(segment.text) })
      lines.push(text)
    }
    return { lines, actions }
  }

  /** The full-width unconfirmed-outcome leave warning. */
  private unknownLeaveBody(width: number, rows: number): readonly string[] {
    const snapshot = this.controller.snapshot()
    const facts: string[] = []
    if (snapshot.configOutcomeUnconfirmed === true) {
      facts.push('The configuration change may have been applied by the Host.')
    }
    if (snapshot.restartOutcomeUnconfirmed === true) {
      facts.push('The restart request may still be settling in the Host.')
    }
    const text = `Outcome unconfirmed. ${facts.join(' ')} Leaving does not undo it. Press R to re-observe the Host, or D to leave anyway.`
    const wrapped = wrapCellsHard(text, width, rows)
    return wrapped.lines
  }

  /**
   * The BODY of one pending confirmation: the exact target, the action and its
   * consequence / external reach. Long unbreakable tokens are hard-split; the
   * admission is the CURRENT grant, with no legacy five-line cap.
   */
  private confirmationBody(snapshot: McpServersSnapshot, width: number, availableRows: number): {
    readonly lines: readonly string[]
    readonly blocked: boolean
  } {
    if (this.discardConfirm !== undefined) {
      if (this.discardConfirm === 'unknown') {
        return this.wrapConfirmation(
          'Leave form? The change may have been applied. Discarding local edits does not undo it.',
          width,
          availableRows,
        )
      }
      return this.wrapConfirmation('Discard changes? Unsaved edits are dropped; nothing has been written yet.', width, availableRows)
    }
    const confirm = snapshot.configConfirm
    if (confirm !== undefined) {
      const name = sanitizeName(confirm.name)
      switch (confirm.kind) {
        case 'save':
          return this.wrapConfirmation(`Save server ${name}. ${confirm.warning ?? 'This writes the profile configuration.'}`, width, availableRows)
        case 'delete':
          return this.wrapConfirmation(
            `Permanently delete server ${name} from this profile. This removes your added configuration; it cannot be undone here.`,
            width,
            availableRows,
          )
        case 'reset':
          return this.wrapConfirmation(
            `Reset server ${name} to its inherited configuration. Your override is replaced by the base layer value.`,
            width,
            availableRows,
          )
        case 'toggle':
          return this.wrapConfirmation(
            `${confirm.nextEnabled === true ? 'Enable' : 'Disable'} server ${name}. ${confirm.nextEnabled === true
              ? 'The MCP process may start.'
              : 'The MCP process may stop; live tools may be interrupted.'}`,
            width,
            availableRows,
          )
      }
    }
    if (snapshot.confirmingName !== undefined) {
      return this.wrapConfirmation(
        `Restart server ${sanitizeName(snapshot.confirmingName)}. Live tools may be interrupted while it rebuilds.`,
        width,
        availableRows,
      )
    }
    return { lines: [], blocked: false }
  }

  private wrapConfirmation(text: string, width: number, availableRows: number): { lines: readonly string[]; blocked: boolean } {
    const wanted = sanitizedPhysicalLine(text).replace(/\s+/gu, ' ')
    const wrapped = wrapCellsHard(text, width, Math.max(0, availableRows))
    const complete = wrapped.reproduced.replace(/\s+/gu, ' ') === wanted
    return { lines: wrapped.lines, blocked: !complete || availableRows <= 0 || wrapped.lines.length > availableRows }
  }

  /** The full-width form bar segments (also used to decide the body verb
   *  fallback: the bar and body share the same sink, never a second action). */
  private formBarSegments(snapshot: McpServersSnapshot, editor: NonNullable<McpServersSnapshot['editor']>): readonly McpBarSegment[] {
    const segments: McpBarSegment[] = []
    if (snapshot.configStatus?.kind === 'saving') {
      return [{ text: 'Saving configuration…', priority: 1000 }, { text: 'Esc', priority: 999, action: 'cancel' }]
    }
    if (snapshot.configOutcomeUnconfirmed === true) {
      return [{ text: 'Back [Esc]', priority: 1000, action: 'back' }]
    }
    const row = this.currentFormRows()[this.formFocus]
    const verb = row === undefined ? undefined : this.formRowVerb(row, editor)
    if (row !== undefined && verb !== undefined) {
      segments.push({ text: verb, priority: 800, action: 'activate-field', fieldId: row.id, ink: 'primary' })
    }
    segments.push({ text: 'Save [S]', priority: 900, action: 'save' })
    if (this.focusedRemovableRow(snapshot) !== undefined) {
      // At the 44-column floor, Save/Remove/Back fit whole; the current field's
      // verb yields to the body fallback instead of dropping the Remove fact.
      segments.push({ text: 'Remove [Backspace]', priority: 850, action: 'remove-form-row', ink: 'secondary' })
    }
    segments.push({ text: 'Back [Esc]', priority: 1000, action: 'back' })
    return segments
  }

  /** The Detail's complete bar intents, in frozen display order. The same list
   *  feeds the body fallback when a narrow bar must drop a secondary action. */
  private detailBarSegments(snapshot: McpServersSnapshot): readonly McpBarSegment[] {
    const row = snapshot.rows.find(candidate => candidate.name === snapshot.selectedName)
    const operable = snapshot.phase === 'ready'
      && snapshot.operation?.phase !== 'running'
      && this.visibleSelection(snapshot) !== undefined
      && row?.configured === true
    const facet = snapshot.selectedConfig
    const segments: McpBarSegment[] = []
    if (operable) {
      segments.push({ text: 'Probe [P]', priority: snapshot.selectedConfig === undefined ? 100 : 90, action: 'probe' })
      if (snapshot.restartOutcomeUnconfirmed !== true) {
        segments.push({ text: 'Restart [X]', priority: 60, action: 'restart' })
      }
    }
    if (facet !== undefined && snapshot.configOutcomeUnconfirmed !== true) {
      if (this.controller.canBeginEdit()) segments.push({ text: 'Edit [E]', priority: 100, action: 'edit', ink: 'primary' })
      if (facet.canToggle) segments.push({ text: 'Enable/Disable [T]', priority: 70, action: 'toggle' })
      if (facet.canDelete) segments.push({ text: 'Delete [D]', priority: 50, action: 'delete' })
      if (facet.canReset) segments.push({ text: 'Reset [U]', priority: 40, action: 'reset' })
    }
    if (segments.every(segment => segment.action !== 'edit' && segment.action !== 'probe')) {
      segments.unshift({ text: 'Refresh [R]', priority: 100, action: 'refresh' })
    } else {
      segments.push({ text: 'Refresh [R]', priority: 10, action: 'refresh' })
    }
    segments.push({ text: 'Back [Esc]', priority: 1000, action: 'back' })
    return segments
  }

  private renderBar(width: number, snapshot: McpServersSnapshot, zeroBody: boolean): ReturnType<typeof paintBar> {
    // A confirmation whose target/consequence cannot be fully painted in the
    // CURRENT frame is not executable — neither key nor pointer — so its bar
    // offers only the truthful escape.
    if (this.unknownLeave) {
      if (zeroBody) return paintBar([{ text: 'Keep [Esc]', priority: 1000, action: 'keep-editing' }], width, true)
      return paintBar([
        { text: 'Refresh [R]', priority: 30, action: 'refresh' },
        { text: 'Leave [D]', priority: 20, action: 'leave-anyway', ink: 'secondary' },
        { text: 'Keep [Esc]', priority: 1000, action: 'keep-editing' },
      ], width, true)
    }
    if (this.discardConfirm !== undefined) {
      const verdict = this.confirmationVerdict(snapshot)
      if (zeroBody) return paintBar([{ text: 'Keep [Esc]', priority: 1000, action: 'keep-editing' }], width, true)
      if (verdict === 'blocked' || verdict === 'unpainted') {
        return paintBar([
          { text: 'Resize to review the target and its consequence', short: 'Resize to review', priority: 1000 },
          { text: 'Keep [Esc]', priority: 999, action: 'keep-editing' },
        ], width, true)
      }
      return paintBar([
        { text: 'Discard [D]', short: 'Discard', priority: 40, action: 'discard', ink: 'secondary' },
        { text: 'Keep [Esc]', priority: 1000, action: 'keep-editing' },
      ], width, true)
    }
    const verdict = this.confirmationVerdict(snapshot)
    if (snapshot.configConfirm !== undefined || snapshot.confirmingName !== undefined) {
      if (zeroBody) return paintBar([{ text: 'Cancel [Esc]', priority: 1000, action: 'cancel' }], width, true)
      if (verdict === 'blocked' || verdict === 'unpainted') {
        return paintBar([
          { text: 'Resize to review the target and its consequence', short: 'Resize to review', priority: 1000 },
          { text: 'Cancel [Esc]', priority: 999, action: 'cancel' },
        ], width, true)
      }
      return paintBar([
        { text: 'Confirm [Y]', short: 'Confirm', priority: 50, action: 'confirm', ink: 'primary' },
        { text: 'Cancel [Esc]', priority: 1000, action: 'cancel' },
      ], width, true)
    }
    if (snapshot.editor !== undefined) {
      if (this.formInput !== undefined) {
        if (zeroBody) return paintBar([{ text: 'Esc cancel', priority: 1000, action: 'cancel' }], width, true)
        return paintBar([
          { text: 'Apply [Enter]', short: 'Apply', priority: 40, action: 'apply-input', ink: 'primary' },
          { text: 'Cancel [Esc]', priority: 1000, action: 'cancel' },
        ], width, true)
      }
      if (snapshot.configStatus?.kind === 'saving') {
        if (zeroBody) return paintBar([{ text: 'Saving configuration…', short: 'Saving…', priority: 1000 }, { text: 'Esc', priority: 999, action: 'cancel' }], width, true)
        return paintBar([{ text: 'Saving configuration…', short: 'Saving…', priority: 1000 }, { text: 'Esc', priority: 999, action: 'cancel' }], width, true)
      }
      if (zeroBody) {
        const dirty = snapshot.editor.dirty
        return paintBar([
          dirty
            ? { text: 'Keep [Esc]', priority: 1000, action: 'keep-editing' }
            : { text: 'Back [Esc]', priority: 1000, action: 'back' },
        ], width, true)
      }
      return paintBar(this.formBarSegments(snapshot, snapshot.editor), width, true)
    }
    if (this.searching) {
      if (zeroBody) return paintBar([{ text: 'Cancel [Esc]', priority: 1000, action: 'cancel' }], width, true)
      return paintBar([
        { text: 'Done [Enter]', short: 'Done', priority: 20, action: 'finish-search', ink: 'primary' },
        { text: 'Cancel [Esc]', priority: 1000, action: 'cancel' },
      ], width, true)
    }
    if (this.region === 'detail') {
      if (zeroBody) return paintBar([{ text: 'Back [Esc]', priority: 1000, action: 'back' }], width, true)
      return paintBar(this.detailBarSegments(snapshot), width, true)
    }
    if (zeroBody) return paintBar([{ text: 'Back [Esc]', priority: 1000, action: 'back' }], width, true)
    const addable = this.controller.canBeginAdd()
    const segments: McpBarSegment[] = []
    if (this.visibleSelection(snapshot) !== undefined) {
      segments.push({ text: 'Open [Enter]', short: 'Open', priority: 100, action: 'open', ink: 'primary' })
    }
    if (addable) segments.push({ text: 'Add [A]', short: 'Add', priority: 80, action: 'add' })
    segments.push({ text: 'Search [/]', short: 'Search', priority: 60, action: 'start-search', ink: 'secondary' })
    segments.push({ text: 'Refresh [R]', priority: 40, action: 'refresh' })
    segments.push({ text: 'Back [Esc]', priority: 1000, action: 'back' })
    return paintBar(segments, width, true)
  }
}

/** Keep a confirmation's target name control-free and stable. */
function sanitizeName(name: string): string {
  return sanitizedPhysicalLine(name)
}

/** Strip SGR for a width fit test of an already-painted line. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- deliberate SGR strip for a width test
  return text.replace(/\u001b\[[0-9;]*m/gu, '')
}
