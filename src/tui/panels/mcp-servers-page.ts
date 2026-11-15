/**
 * The `/settings → Tools → MCP servers` page (FR3 S4).
 *
 * It is mounted as an EMBEDDED SPECIALIST PAGE inside the ONE Settings
 * workspace lease (the same body/chrome/Action Bar as the subagent allowlist
 * picker and the Web Search / Fetch page) — never a second alt-screen, modal
 * or Settings workspace.
 *
 * Authority is deliberately NOT here: every fact comes from the per-open
 * {@link McpServersController} snapshot, which projects the official Host MCP
 * manager and the read-only configuration-source read. This component owns only
 * transient presentation state (view, cursor, search query, scroll offsets,
 * pressed gesture), and all of it dies with the page instance.
 *
 * The page fixes the contract's UI vocabulary: official status values only (no
 * invented `connected-ish` flags), `Not exposed` for the transport the official
 * list does not publish, `Unknown` for an unproven configuration source, and a
 * cleanup failure reported as its OWN problem instead of a probe success. A
 * non-ready observation explains itself and offers no executable action.
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
import type { EmbeddedSpecialistPage } from './settings-workspace-panel.ts'
import {
  mcpFormRows,
  mcpFormStatusText,
  renderMcpConfigForm,
  type McpFormRow,
} from './mcp-server-config-form.ts'

/** The page's own name (also the Settings row label and the breadcrumb tail). */
export const MCP_SERVERS_PAGE_TITLE = 'MCP servers'

/** The three responsive layout classes of THIS page (not a project rule). */
type McpPageLayout = 'wide' | 'medium' | 'narrow'

/** The page's own view state: a wide frame paints both regions; the others
 *  paint one region at a time. */
type McpPageView = 'list' | 'detail' | 'editor'

/** The wide frame's ONE focused region. */
type McpPageFocus = 'list' | 'detail'

/** The frozen breakpoints: `≥108` two columns, `76–107` compact single column,
 *  `≤75` list-only. Below a usable body the wide frame degrades to the compact
 *  projection (a two-column frame with one row would hide both columns). */
export function mcpServersLayoutFor(width: number, bodyRows: number): McpPageLayout {
  if (width >= 108 && bodyRows >= 5) return 'wide'
  if (width <= 75) return 'narrow'
  return 'medium'
}

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
  | 'enter-detail'
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

/** One painted hit target of the LAST frame, in page-local cells. A form row
 *  carries the FIELD identity so a click activates exactly the row that was
 *  painted (never a row that scrolled into that cell afterwards). */
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
      readonly kind: 'action'
      /** The semantic intent the painted bar segment advertises. */
      readonly action: McpBarAction
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
  /** Every PAINTED segment with its cells, in display order. A segment the
   *  layout dropped is absent here, so a pointer target is never invented. */
  readonly spans: readonly { readonly action: McpBarAction | undefined; readonly startCol: number; readonly endCol: number }[]
} {
  const layout = layoutActionBarRow(segments, width)
  if (layout.truncated || layout.spans.length === 0) {
    return { line: color.textMuted(truncateToWidth(layout.text, Math.max(0, width), '…', true)), spans: [] }
  }
  let painted = ''
  let escape: { startCol: number; endCol: number } | undefined
  const spans: { action: McpBarAction | undefined; startCol: number; endCol: number }[] = []
  for (const span of layout.spans) {
    if (painted !== '') painted += ACTION_BAR_SEPARATOR
    const isLast = span.inputIndex === segments.length - 1
    painted += isLast && lastIsEscape ? paintActionSpan(span.text, 'secondary') : color.textMuted(span.text)
    if (isLast && lastIsEscape) escape = { startCol: span.startCol, endCol: span.endCol }
    spans.push({ action: segments[span.inputIndex]?.action, startCol: span.startCol, endCol: span.endCol })
  }
  return { line: painted, ...escape === undefined ? {} : { escape }, spans }
}

/**
 * Wrap one sentence into at most `maxLines` cell-accurate lines (a word that
 * cannot fit is left on its own line and truncated by the caller). Used for a
 * safety disclosure that must not depend on a one-line Action Bar.
 */
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

/** A bar segment that may advertise a pointer intent. */
type McpBarSegment = ActionBarSegment & { readonly action?: McpBarAction }

/** The body line budget one confirmation may consume. */
const MCP_CONFIRM_BODY_MAX_LINES = 5

/**
 * Wrap one sentence into at most `maxLines` cell-accurate lines, HARD-SPLITTING
 * a token that alone exceeds the width. A safety fact may never be dropped
 * because one legal value (a 63-character DNS label, a 32-character name) has
 * no break opportunity. Returns the lines AND the reconstruction of the source
 * they really painted: a hard split is a mid-token break (no space inserted),
 * while a normal word wrap is a space break. The caller compares the
 * reconstruction to the source text to decide VISIBILITY, so the proof is the
 * painted content itself — never the assumption that wrapping succeeded.
 */
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

/** The long list/detail hints, shortened when the frame is tight. */
const LIST_HINTS: readonly McpBarSegment[] = [
  { text: '↑/↓ move', short: '↑/↓', priority: 30 },
  { text: 'Enter details', short: 'Enter', priority: 20, action: 'enter-detail' },
  { text: 'a Add', priority: 18, action: 'add' },
  { text: '/ search', priority: 15 },
  { text: 'r refresh', priority: 10, action: 'refresh' },
  // The Esc affordance is the ONE required segment at every width: it is never
  // compacted away from `Verb [Esc]` (only a frame too narrow for even that
  // truncates it).
  { text: 'Back [Esc]', priority: 1000, action: 'back' },
]
const EDITOR_HINTS: readonly McpBarSegment[] = [
  { text: '↑/↓ field', short: '↑/↓', priority: 30 },
  { text: 'Enter edit', short: 'Enter', priority: 25 },
  { text: 'Tab next', short: 'Tab', priority: 20 },
  { text: 's Save', priority: 40, action: 'save' },
  { text: 'Back [Esc]', priority: 1000, action: 'back' },
]
const EDITOR_INPUT_HINTS: readonly McpBarSegment[] = [
  { text: 'Enter apply', short: 'Enter', priority: 30, action: 'apply-input' },
  { text: 'Esc cancel', short: 'Esc', priority: 1000, action: 'cancel' },
]
const DISCARD_HINTS: readonly McpBarSegment[] = [
  { text: 'Keep editing', short: 'Keep', priority: 900, action: 'keep-editing' },
  { text: 'Discard', short: 'd', priority: 899, action: 'discard' },
  { text: 'Esc', priority: 999, action: 'keep-editing' },
]
/** The confirmation ANSWER segments. `Esc` is the required affordance and `y`
 *  is the only affirmative key, so both are compacted (never dropped) before
 *  the target sentence — the target sentence itself carries the HIGHEST
 *  priority, because a confirmation whose subject vanished would let the user
 *  answer a question they cannot read (§7.2 "safety facts kept"). */
const CONFIRM_HINTS: readonly McpBarSegment[] = [
  { text: 'Y confirm', short: 'y', priority: 900, action: 'confirm' },
  { text: 'Esc cancel', short: 'Esc', priority: 999, action: 'cancel' },
]
const SEARCH_HINTS: readonly ActionBarSegment[] = [
  { text: 'type to filter', priority: 20 },
  { text: 'Enter done', priority: 10 },
  { text: 'Esc cancel', short: 'Esc', priority: 1000 },
]

/** The page itself. */
export class McpServersPage implements EmbeddedSpecialistPage {
  readonly title = MCP_SERVERS_PAGE_TITLE
  focused = false

  private readonly controller: McpServersController
  private readonly requestRender: () => void
  private readonly done: () => void
  private readonly searchInput = new Input({ prompt: '/ ', placeholder: 'filter servers', placeholderStyle: color.textDim })
  private rowGrant = 8
  private view: McpPageView = 'list'
  private wideFocus: McpPageFocus = 'list'
  private searching = false
  private listOffset = 0
  private detailOffset = 0
  /** FR4: the focused form row index and its scroll offset. */
  private formFocus = 0
  private formOffset = 0
  /** FR4: the ACTIVE text input of the form (its row + the value being typed). */
  private formInput: { readonly row: McpFormRow; readonly input: Input; readonly initial: string } | undefined
  /** FR4: the pending `Discard changes?` confirmation of a dirty form. */
  private discardConfirm = false
  /** FR4: Esc while the Save is unsettled — a notice, never a discard prompt. */
  private configSavingNotice = false
  /**
   * The confirmation the LAST PAINTED frame admitted, by exact identity.
   *
   * A plain boolean would be shared across questions: when `s`/`t`/`x` opens a
   * NEW question the page has not painted yet, the previous frame's `false`
   * would authorise the new one. Executability is therefore bound to the
   * identity that really painted — an unpainted question is never executable.
   */
  private paintedConfirmation: { readonly identity: string; readonly blocked: boolean } | undefined
  private disposed = false
  private revision = 0
  private paint: McpPagePaint | undefined
  /** The last painted Action-Bar spans (id + action + cells), page-local. */
  private lastBarSpans: readonly { readonly id: string; readonly action: McpBarAction; readonly startCol: number; readonly endCol: number }[] = []
  /** The frame being painted (layout decisions must read THIS grant, not the
   *  previous frame's paint). */
  private rendering: { readonly width: number; readonly bodyRows: number } | undefined
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
  }) {
    this.controller = intents.controller
    this.requestRender = intents.requestRender
    this.done = intents.done
    this.searchInput.onEscape = () => { this.cancelSearch() }
    this.searchInput.onSubmit = () => { this.commitSearch() }
  }

  /** The root's row-budget seam: the granted lines INCLUDE the Action Bar. */
  setMaxRows(rows: number): void {
    const next = Math.max(1, Math.floor(rows))
    if (next !== this.rowGrant) {
      this.rowGrant = next
      // A new grant has not painted yet: the previous frame's geometry is not
      // clickable and only the real Esc may act until this one paints.
      this.grantAwaitingPaintValue = true
      this.paintedEscapeSpanValue = undefined
      this.pressed = undefined
    }
  }

  /** Whether a grant/sub-view transition still awaits its paint. */
  grantAwaitingPaint(): boolean {
    return this.grantAwaitingPaintValue
  }

  /** The complete visible Esc affordance of the LAST painted frame. */
  paintedEscapeSpan(): { readonly startCol: number; readonly endCol: number } | undefined {
    return this.paintedEscapeSpanValue
  }

  /**
   * The page's own SEMANTIC identity for one pointer gesture: the view, the
   * selected row, the transient action states and the painted business rows.
   * The Settings root re-proves the painted frame too; this identity is the
   * page-side half of the same rule.
   */
  gestureIdentity(): string {
    const snapshot = this.controller.snapshot()
    return [
      this.view,
      this.wideFocus,
      this.searching ? this.query() : '',
      snapshot.selectedName ?? '',
      snapshot.confirmingName ?? '',
      snapshot.phase,
      snapshot.operation?.phase ?? '',
      String(snapshot.rows.length),
      snapshot.editor === undefined ? '' : `editor:${snapshot.editor.mode}:${String(this.formFocus)}:${snapshot.editor.dirty ? 'dirty' : 'clean'}`,
      snapshot.configConfirm === undefined ? '' : `confirm:${snapshot.configConfirm.kind}:${snapshot.configConfirm.name}`,
      this.discardConfirm ? 'discard' : '',
      this.configSavingNotice ? 'saving-notice' : '',
    ].join(':')
  }

  handleInput(data: string): void {
    if (this.disposed) return
    const snapshot = this.controller.snapshot()
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
      // No other key may dispatch a Host write.
      return
    }
    // The dirty-discard confirmation: Keep editing is the default; only an
    // explicit `d` drops the draft (zero official writes).
    if (this.discardConfirm) {
      if (data === 'd' || data === 'D') {
        // The discard body states what is dropped; when the current grant
        // cannot paint that fact, `d` is refused exactly like `y` is for the
        // other confirmations (the bar offers only cancel).
        if (this.confirmationVerdict(snapshot) !== 'ready') return
        this.discardConfirm = false
        this.formInput = undefined
        this.controller.discardEditor()
        this.formFocus = 0
        this.formOffset = 0
        this.bumpRevision()
        return
      }
      // Enter/Esc/anything else keeps editing.
      if (matchesKey(data, 'enter') || matchesKey(data, 'escape') || matchesKey(data, 'tab')) {
        this.discardConfirm = false
        this.bumpRevision()
      }
      return
    }
    // A restart confirmation owns the keyboard: only the explicit answer and
    // Esc are accepted, and neither is ever inferred from another key.
    if (snapshot.confirmingName !== undefined) {
      if (matchesKey(data, 'escape')) {
        this.controller.answerRestart(false)
        return
      }
      if (data === 'y' || data === 'Y') {
        if (this.confirmationVerdict(snapshot) === 'ready') this.controller.answerRestart(true)
      }
      // No other key may dispatch a Host operation.
      return
    }
    // The ACTIVE form input consumes every key: a/e/t/d/u/s are input
    // characters here, never page actions.
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
      this.searchInput.handleInput(data)
      this.reconcileSelection(snapshot)
      this.requestRender()
      return
    }
    if (this.view === 'editor') {
      this.handleEditorInput(data, snapshot)
      return
    }
    if (matchesKey(data, 'escape')) {
      if (this.view === 'detail') {
        this.leaveDetail()
        return
      }
      if (this.wideFocus === 'detail') {
        this.wideFocus = 'list'
        this.bumpRevision()
        return
      }
      this.done()
      return
    }
    if (data === '/') {
      this.searching = true
      this.searchInput.focused = this.focused
      this.grantAwaitingPaintValue = true
      this.paintedEscapeSpanValue = undefined
      this.requestRender()
      return
    }
    if (data === 'r' || data === 'R') {
      this.controller.refresh()
      return
    }
    if (data === 'a' || data === 'A') {
      // Add is a list action; a search query keeps every letter as text.
      if (!this.inDetail() && this.controller.canBeginAdd()) {
        this.controller.beginAdd()
        this.enterEditor()
      }
      return
    }
    if (this.inDetail()) {
      if (matchesKey(data, 'up')) return this.scrollDetail(-1)
      if (matchesKey(data, 'down')) return this.scrollDetail(1)
      if (matchesKey(data, 'pageUp')) return this.scrollDetail(-this.detailViewport())
      if (matchesKey(data, 'pageDown')) return this.scrollDetail(this.detailViewport())
      if (data === 'p' || data === 'P') {
        if (this.controller.canOperateSelected()) this.controller.probe()
        return
      }
      if (data === 'x' || data === 'X') {
        if (this.controller.canOperateSelected()) this.controller.beginRestart()
        return
      }
      if (data === 'e' || data === 'E') {
        if (this.controller.canBeginEdit()) {
          this.controller.beginEdit()
          this.enterEditor()
        }
        return
      }
      if (data === 't' || data === 'T') {
        if (this.controller.canEditConfiguration()) this.controller.beginToggle()
        return
      }
      if (data === 'd' || data === 'D') {
        if (this.controller.canEditConfiguration()) this.controller.beginDelete()
        return
      }
      if (data === 'u' || data === 'U') {
        if (this.controller.canEditConfiguration()) this.controller.beginReset()
        return
      }
      return
    }
    if (matchesKey(data, 'up')) return this.moveSelection(-1, snapshot)
    if (matchesKey(data, 'down')) return this.moveSelection(1, snapshot)
    if (matchesKey(data, 'pageUp')) return this.moveSelection(-this.listViewport(), snapshot)
    if (matchesKey(data, 'pageDown')) return this.moveSelection(this.listViewport(), snapshot)
    if (matchesKey(data, 'enter')) {
      if (snapshot.rows.length === 0 || snapshot.selectedName === undefined) return
      if (this.layoutClass() === 'wide') {
        if (this.wideFocus !== 'detail') {
          this.wideFocus = 'detail'
          this.detailOffset = 0
          this.bumpRevision()
        }
      } else {
        this.view = 'detail'
        this.detailOffset = 0
        this.bumpRevision()
      }
      return
    }
  }

  // ── FR4: the configuration form ───────────────────────────────────────────

  private enterEditor(): void {
    this.view = 'editor'
    this.formFocus = 0
    this.formOffset = 0
    this.formInput = undefined
    this.discardConfirm = false
    this.configSavingNotice = false
    this.bumpRevision()
  }

  /** The non-Esc Action-Bar spans this page's own bar really painted. The
   *  Settings Root owns the physical last row and DELEGATES these to
   *  {@link activateBarSpan}; the ids are `bar:<action>`. */
  paintedBarSpans(): readonly { readonly id: string; readonly startCol: number; readonly endCol: number }[] {
    return this.lastBarSpans.map(span => ({ id: span.id, startCol: span.startCol, endCol: span.endCol }))
  }

  /** Invoke one delegated last-row intent by its painted id. */
  activateBarSpan(id: string): void {
    const span = this.lastBarSpans.find(candidate => candidate.id === id)
    if (span === undefined) return
    this.runBarAction(span.action, this.controller.snapshot())
    this.bumpRevision()
  }

  /** Activate the focused form row (Enter). */
  private activateFormRow(row: McpFormRow, snapshot: McpServersSnapshot): void {
    const editor = snapshot.editor
    if (editor === undefined) return
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
        // The EXPLICIT storage-form choice: reference ⇄ literal. Switching
        // never guesses from the typed text.
        this.controller.setEditorDictForm(row.action.field, row.action.key,
          this.controller.dictValueForm(row.action.field, row.action.key) === 'reference' ? 'literal' : 'reference')
        this.bumpRevision()
        return
    }
  }

  private openFormInput(row: McpFormRow, initial: string): void {
    // N10: the placeholder states what an EMPTY Enter really does for the
    // storage form this key uses — a literal CAN be committed as the empty
    // string, so the old `blank keeps current` hint was a lie for that form.
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
        // The input starts EMPTY for a stored value (it is never re-displayed),
        // so "unchanged" and "explicitly empty" are different keys:
        // - Esc cancels the edit (the value stays as it was);
        // - an EMPTY Enter on a LITERAL commits the empty string — the official
        //   schema allows it, and for a base-owned key (which cannot be removed)
        //   it is the only way to override an inherited value with nothing;
        // - an EMPTY Enter on a CREDENTIAL REFERENCE keeps the current value: a
        //   blank reference is not a valid `${credential:REF}` token.
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
    if (editor === undefined) {
      // The editor closed underneath (a saved draft): return to the detail.
      this.view = this.layoutClass() === 'wide' ? 'list' : 'detail'
      this.bumpRevision()
      return
    }
    // The SAME removal gate the renderer uses: a base-owned key row is not
    // removable, so a backspace on it must not even reach the intent.
    const rows = mcpFormRows(editor,
      (field, key) => this.controller.dictValueForm(field, key),
      (field, key) => this.controller.canRemoveDictKey(field, key))
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
        this.discardConfirm = true
        this.bumpRevision()
        return
      }
      this.controller.discardEditor()
      this.formFocus = 0
      this.formOffset = 0
      this.configSavingNotice = false
      this.view = this.layoutClass() === 'wide' ? 'list' : 'detail'
      this.bumpRevision()
      return
    }
    if (this.configSavingNotice) {
      // Any further key dismisses the notice; it never becomes a discard.
      this.configSavingNotice = false
      this.bumpRevision()
      if (matchesKey(data, 'escape')) return
    }
    if (data === 's' || data === 'S') {
      // Save runs ONLY while the form is the current, painted view.
      if (this.view === 'editor') this.controller.saveEditor()
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
      if (row !== undefined) this.activateFormRow(row, snapshot)
      return
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed) return undefined
    const paint = this.paint
    if (paint === undefined || event.width !== paint.width) return undefined
    // A MODAL decision owns the BODY exactly like it owns the keyboard: a
    // pointer must not change the draft or the selection the question is
    // about. Its OWN decision actions (confirm/cancel/keep/discard) stay
    // reachable — otherwise a mouse user could be trapped in a question the
    // keyboard can answer. Body targets are refused; the modal's action
    // segments are resolved below against the same painted spans.
    const modal = this.modalOwned()
    if (modal && event.type === 'wheel') return undefined
    const bodyRows = Math.max(0, paint.rows - 1)
    if (event.height !== bodyRows && event.height !== paint.rows) return undefined
    if (event.type === 'wheel') {
      if (event.wheelDelta === undefined || event.wheelDelta === 0) return undefined
      const delta = event.wheelDelta < 0 ? -1 : 1
      if (this.inDetailAt(event.x)) {
        this.scrollDetail(delta)
      } else if (this.layoutClass() === 'wide' || this.view === 'list') {
        this.moveSelection(delta, this.controller.snapshot())
      }
      return { handled: true }
    }
    const hit = paint.targets.find(candidate => candidate.row === event.y
      && event.x >= candidate.startCol && event.x < candidate.endCol)
    const target = modal
      ? hit !== undefined && hit.kind === 'action' && this.isModalAction(hit.action) ? hit : undefined
      : hit
    if (event.type === 'press') {
      if (target === undefined || event.button !== 'left') {
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
      if (pressed === undefined || target === undefined) return undefined
      // The release must resolve against the SAME painted cell and state: a
      // repaint between press and release refuses the gesture.
      if (pressed.revision !== this.revision
        || pressed.identity !== paint.identity
        || pressed.width !== paint.width
        || pressed.rows !== paint.rows
        || pressed.row !== target.row
        || pressed.startCol !== target.startCol
        || pressed.endCol !== target.endCol
        // The TARGET identity must match too: a repaint that moved a different
        // row into the same cell refuses the gesture.
        || pressed.target.kind !== target.kind
        || (pressed.target.kind === 'server-row' && target.kind === 'server-row'
          && pressed.target.name !== target.name)
        || (pressed.target.kind === 'form-row' && target.kind === 'form-row'
          && pressed.target.id !== target.id)
        || (pressed.target.kind === 'action' && target.kind === 'action'
          && pressed.target.action !== target.action)) return undefined
      const snapshot = this.controller.snapshot()
      if (target.kind === 'form-row') {
        // A form-row click is the Enter equivalent on THAT row: focus it and
        // activate the same intent.
        this.formFocus = target.index
        const row = mcpFormRows(snapshot.editor as NonNullable<McpServersSnapshot['editor']>,
          (field, key) => this.controller.dictValueForm(field, key),
          (field, key) => this.controller.canRemoveDictKey(field, key))[target.index]
        if (row !== undefined && snapshot.configStatus?.kind !== 'saving') {
          this.activateFormRow(row, snapshot)
        }
        this.bumpRevision()
        return { handled: true }
      }
      if (target.kind === 'action') {
        this.runBarAction(target.action, snapshot)
        this.bumpRevision()
        return { handled: true }
      }
      this.controller.select(target.name, this.visibleNames(snapshot))
      if (this.layoutClass() === 'wide') this.wideFocus = 'list'
      this.bumpRevision()
      return { handled: true }
    }
    return undefined
  }

  /**
   * Invoke one Action-Bar intent from a pointer click. Every action goes
   * through the SAME controller admission the keyboard key would use — the bar
   * never invents a capability, it only mirrors the painted affordance.
   */
  private runBarAction(action: McpBarAction, snapshot: McpServersSnapshot): void {
    switch (action) {
      case 'back':
        if (this.view === 'editor') {
          if (snapshot.configStatus?.kind === 'saving') {
            this.configSavingNotice = true
            break
          }
          this.handleInput('\x1b')
          return
        }
        if (this.view === 'detail') {
          this.handleInput('\x1b')
          return
        }
        if (this.wideFocus === 'detail') {
          this.wideFocus = 'list'
          break
        }
        this.done()
        return
      case 'enter-detail':
        // The List's visible `Enter details` affordance IS the keyboard Enter.
        if (!this.inDetail() && snapshot.selectedName !== undefined) {
          this.handleInput('\r')
        }
        return
      case 'apply-input':
        // The input-mode bar's `Enter apply` is the SAME commit the keyboard
        // Enter runs — no second input handler.
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
        if (this.discardConfirm) {
          this.discardConfirm = false
          this.formInput = undefined
          this.controller.discardEditor()
          this.configSavingNotice = false
          this.view = this.layoutClass() === 'wide' ? 'list' : 'detail'
        }
        return
      case 'keep-editing':
        if (this.discardConfirm) this.discardConfirm = false
        return
      case 'add':
        if (!this.inDetail() && this.controller.canBeginAdd()) {
          this.controller.beginAdd()
          this.enterEditor()
        }
        return
      case 'edit':
        if (this.controller.canBeginEdit()) {
          this.controller.beginEdit()
          this.enterEditor()
        }
        return
      case 'toggle':
        if (this.controller.canEditConfiguration()) this.controller.beginToggle()
        return
      case 'delete':
        if (this.controller.canEditConfiguration()) this.controller.beginDelete()
        return
      case 'reset':
        if (this.controller.canEditConfiguration()) this.controller.beginReset()
        return
      case 'probe':
        if (this.controller.canOperateSelected()) this.controller.probe()
        return
      case 'restart':
        if (this.controller.canOperateSelected()) this.controller.beginRestart()
        return
      case 'refresh':
        this.controller.refresh()
        return
      case 'save':
        if (this.view === 'editor') this.handleInput('s')
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
    this.discardConfirm = false
    this.configSavingNotice = false
    this.controller.dispose()
  }

  /** The Action-Bar intents a MODAL may accept from a pointer: its own
   *  decision, never a body change. */
  private isModalAction(action: McpBarAction): boolean {
    // The input-mode bar is the input's OWN decision surface: apply/cancel are
    // reachable in that modal exactly like confirm/cancel are in a question.
    return action === 'confirm' || action === 'cancel' || action === 'keep-editing'
      || action === 'discard' || action === 'apply-input'
  }

  /** The exact confirmation the CURRENT state asks, or undefined when none is
   *  open. The id names every fact the answer would commit. */
  private confirmationIdentity(snapshot: McpServersSnapshot): string | undefined {
    if (this.discardConfirm) return 'discard'
    const confirm = snapshot.configConfirm
    if (confirm !== undefined) {
      switch (confirm.kind) {
        case 'save': return `save|${confirm.name}|${String(confirm.capturedRevision)}|${confirm.warning ?? ''}`
        case 'delete': return `delete|${confirm.name}|${String(confirm.capturedRevision)}`
        case 'reset': return `reset|${confirm.name}|${String(confirm.capturedRevision)}`
        case 'toggle': return `toggle|${confirm.name}|${String(confirm.capturedRevision)}|${String(confirm.nextEnabled)}`
      }
    }
    if (snapshot.confirmingName !== undefined) return `restart|${snapshot.confirmingName}`
    return undefined
  }

  /**
   * The admission verdict for the OPEN confirmation. `unpainted` means the
   * question exists in state but no frame has yet painted its facts — the
   * answer is refused exactly like a blocked one, so a key that arrives inside
   * the render window can never commit an unreviewed write.
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
      || this.discardConfirm
      || this.formInput !== undefined
      || this.searching
  }

  invalidate(): void {}

  /** The pane-header line the root paints inside the shared body grant. */
  /**
   * The page header. It always names the identity the CURRENT view edits: with
   * the form open that is the FORM's target (`Name · Add/Edit · source`), never
   * the server that happened to be selected in the list before Add started.
   */
  paneHeader(width: number): string {
    const identity = this.editorIdentity()
    if (this.layoutClass() !== 'wide') {
      // The FORM target is the one fact that must survive a narrow header: the
      // page label is dropped first, then the source, so the user can always
      // read WHICH server and WHICH mode they are editing (N08). The identity
      // is never silently dropped by composeRow.
      if (identity !== undefined) {
        const room = width - visibleWidth(MCP_SERVERS_PAGE_TITLE) - 3
        const compact = identity.full.length > 0 && room >= visibleWidth(identity.full)
          ? identity.full
          : room >= visibleWidth(identity.withoutSource) ? identity.withoutSource : identity.name
        return fit(this.focused
          ? composeRow(color.textDim(MCP_SERVERS_PAGE_TITLE), color.textStrong(compact, 'primary'), width)
          : composeRow(color.textDim(MCP_SERVERS_PAGE_TITLE), color.text(compact), width), width)
      }
      const left = this.focused
        ? color.textStrong(`[${MCP_SERVERS_PAGE_TITLE}]`, 'primary')
        : color.textDim(MCP_SERVERS_PAGE_TITLE)
      return left
    }
    if (identity !== undefined) {
      return composeRow(color.textDim(MCP_SERVERS_PAGE_TITLE), color.textStrong(identity.full, 'primary'), width)
    }
    const listActive = this.wideFocus === 'list'
    const left = listActive
      ? color.textStrong(`[${MCP_SERVERS_PAGE_TITLE}]`, 'primary')
      : color.textDim(MCP_SERVERS_PAGE_TITLE)
    const right = listActive
      ? color.textDim(this.controller.snapshot().selectedName ?? 'Selected server')
      : color.textStrong(`[${this.controller.snapshot().selectedName ?? 'Selected server'}]`, 'primary')
    return composeRow(left, right, width)
  }

  /**
   * The editor's FIXED identity line: `▸ <Name> · Add/Edit` plus the source
   * when it fits. The name and the mode are the target identity (never the
   * previously selected server); the source is the detail.
   */
  private editorIdentityLine(
    identity: { readonly full: string; readonly withoutSource: string; readonly name: string },
    width: number,
  ): string {
    const marker = color.textStrong('▸ ', 'primary')
    for (const tier of [identity.full, identity.withoutSource, identity.name]) {
      if (visibleWidth(`▸ ${tier}`) <= width) return fit(marker + color.textStrong(tier, 'primary'), width)
    }
    return fit(marker + color.textStrong(identity.name, 'primary'), width)
  }

  /**
   * The BODY of one pending confirmation: the exact target, the action and its
   * consequence / external reach. Long unbreakable tokens are hard-split, and
   * `blocked` reports that even that could not fit — the page then refuses to
   * confirm rather than accepting an uninformed `y`.
   */
  private confirmationBody(snapshot: McpServersSnapshot, width: number, availableRows: number): {
    readonly lines: readonly string[]
    readonly blocked: boolean
  } {
    if (this.discardConfirm) {
      return this.wrapConfirmation('Discard changes? Unsaved edits are dropped; nothing has been written yet.', width, availableRows)
    }
    const confirm = snapshot.configConfirm
    if (confirm !== undefined) {
      const name = confirm.name
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
        `Restart server ${snapshot.confirmingName}. Live tools may be interrupted while it rebuilds.`,
        width,
        availableRows,
      )
    }
    return { lines: [], blocked: false }
  }

  /**
   * Wrap a confirmation sentence, hard-splitting unbreakable tokens. The
   * visibility proof concatenates the painted lines WITHOUT separators: a hard
   * split does not insert a space into the text, so joining with spaces would
   * falsely mismatch a fully-painted long host and block a legal confirmation.
   */
  private wrapConfirmation(text: string, width: number, availableRows: number): { readonly lines: readonly string[]; readonly blocked: boolean } {
    const wanted = sanitizedPhysicalLine(text).replace(/\s+/gu, ' ')
    const wrapped = wrapCellsHard(text, width, MCP_CONFIRM_BODY_MAX_LINES)
    const complete = wrapped.reproduced.replace(/\s+/gu, ' ') === wanted
    // The admission is the CURRENT GRANT: a fact set that wraps completely but
    // does not fit the rows this frame really gives cannot be reviewed either.
    return { lines: wrapped.lines, blocked: !complete || wrapped.lines.length > Math.max(1, availableRows) }
  }

  /**
   * The tiered `Name · Add/Edit · source` identity of the OPEN form. The narrow
   * header drops the SOURCE first, then the mode, so the NAME is the last fact
   * kept — the target identity is the contract, the source is the detail.
   */
  private editorIdentity(): { readonly full: string; readonly withoutSource: string; readonly name: string } | undefined {
    const editor = this.controller.snapshot().editor
    if (editor === undefined) return undefined
    const name = editor.name === '' ? '(unnamed)' : sanitizedPhysicalLine(editor.name)
    const mode = editor.mode === 'add' ? 'Add' : 'Edit'
    const source = editor.mode === 'add' ? 'new user server' : this.editorSourceLabel()
    return { full: `${name} · ${mode} · ${source}`, withoutSource: `${name} · ${mode}`, name }
  }

  /** The source of the entry being edited (from the same descriptor). */
  private editorSourceLabel(): string {
    const snapshot = this.controller.snapshot()
    const entry = snapshot.config?.kind === 'ready'
      ? snapshot.config.entries.find(candidate => candidate.name === snapshot.editor?.name)
      : undefined
    if (entry === undefined) return 'configuration'
    return entry.provenance === 'user-added'
      ? 'user-added'
      : entry.provenance === 'inherited' ? 'inherited' : 'overridden (user)'
  }

  // ── layout helpers ────────────────────────────────────────────────────────

  private bodyRows(): number {
    return Math.max(0, this.rowGrant - 1)
  }

  private layoutClass(): McpPageLayout {
    if (this.rendering !== undefined) return mcpServersLayoutFor(this.rendering.width, this.rendering.bodyRows)
    return mcpServersLayoutFor(this.paint?.width ?? 0, this.paint?.rows === undefined ? this.bodyRows() : this.paint.rows - 1)
  }

  private inDetail(): boolean {
    return this.view === 'detail' || (this.layoutClass() === 'wide' && this.wideFocus === 'detail')
  }

  /** Whether one page-local column belongs to the detail region. */
  private inDetailAt(x: number): boolean {
    if (this.layoutClass() !== 'wide') return this.inDetail()
    return x >= this.wideListWidth() + 2
  }

  private detailViewport(): number {
    return Math.max(1, this.bodyRows() - 1)
  }

  private listViewport(): number {
    return Math.max(1, this.bodyRows() - (this.layoutClass() === 'narrow' ? 0 : 1) - 1)
  }

  private wideListWidth(): number {
    const width = this.rendering?.width ?? this.paint?.width ?? 0
    return Math.min(64, Math.max(48, Math.floor(width * 0.5)))
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

  private leaveDetail(): void {
    this.view = 'list'
    this.detailOffset = 0
    this.bumpRevision()
  }

  private scrollDetail(delta: number): void {
    const max = Math.max(0, this.detailLines(this.controller.snapshot()).length - this.detailViewport())
    const next = Math.min(Math.max(0, this.detailOffset + delta), max)
    if (next === this.detailOffset) return
    this.detailOffset = next
    this.bumpRevision()
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  render(width: number): string[] {
    if (this.disposed) return [fit('', width)]
    this.grantAwaitingPaintValue = false
    const bodyRows = this.bodyRows()
    this.rendering = { width, bodyRows }
    try {
      return this.renderForGrant(width, bodyRows)
    } finally {
      this.rendering = undefined
    }
  }

  private renderForGrant(width: number, bodyRows: number): string[] {
    const snapshot = this.controller.snapshot()
    // FR4: a SAVED (or authority-retired) editor closes itself. Step back to
    // the view the form was opened from so the ONE config-status line of the
    // list/detail is visible; no input is needed to leave a closed form.
    if (this.view === 'editor' && snapshot.editor === undefined) {
      this.view = this.layoutClass() === 'wide' ? 'list' : 'detail'
      this.formInput = undefined
      this.discardConfirm = false
      this.formFocus = 0
      this.formOffset = 0
      this.bumpRevision()
    }
    if (!this.searching) this.reconcileSelection(snapshot)
    // The confirmation body belongs to whichever view hosts the question: the
    // Editor hosts Save/discard, the DETAIL hosts Toggle/Delete/Reset/Restart.
    // It is wrapped and admitted against the column that REALLY paints it —
    // the wide Detail is a narrower column than the frame, and the Editor
    // spends rows on its identity and status lines. A fact set is executable
    // only when it fits THAT grant, never the frame's nominal width.
    const targets: McpPaintedTarget[] = []
    const lines: string[] = []
    const layout = mcpServersLayoutFor(width, bodyRows)
    const confirmationWidth = this.view === 'editor' || layout !== 'wide'
      ? width
      : Math.max(1, width - this.wideListWidth() - 2)
    const confirmation = this.confirmationBody(snapshot, confirmationWidth,
      this.view === 'editor' ? Math.max(1, bodyRows - 2) : Math.max(1, bodyRows))
    const confirmationIdentity = this.confirmationIdentity(snapshot)
    this.paintedConfirmation = confirmationIdentity === undefined
      ? undefined
      : { identity: confirmationIdentity, blocked: confirmation.blocked }
    if (this.view === 'editor') {
      const editorFrame = this.renderEditor(snapshot, width, bodyRows, confirmation)
      lines.push(...editorFrame.lines)
      // Every painted field row is a pointer target on THIS frame; a press whose
      // frame repaints never completes (the identity/revision check above).
      for (const fieldRow of editorFrame.fieldRows) {
        targets.push({
          kind: 'form-row',
          id: fieldRow.id,
          index: fieldRow.index,
          row: fieldRow.line,
          startCol: 0,
          endCol: width,
        })
      }
    } else if (layout === 'wide') {
      const listWidth = this.wideListWidth()
      const detailWidth = Math.max(1, width - listWidth - 2)
      const left = this.renderList(snapshot, listWidth, bodyRows, targets)
      const right = this.renderDetail(snapshot, detailWidth, bodyRows, confirmation)
      for (let index = 0; index < bodyRows; index += 1) {
        lines.push(composeRow(left[index] ?? '', right[index] ?? '', width))
      }
    } else if (this.view === 'detail') {
      lines.push(...this.renderDetail(snapshot, width, bodyRows, confirmation).map(line => fit(line, width)))
    } else {
      lines.push(...this.renderList(snapshot, width, bodyRows, targets))
    }
    while (lines.length < bodyRows) lines.push(fit('', width))
    const bar = this.renderBar(width, snapshot)
    this.paintedEscapeSpanValue = bar.escape
    const barRow = lines.length
    this.lastBarSpans = []
    for (const span of bar.spans) {
      if (span.action === undefined) continue
      this.lastBarSpans = [...this.lastBarSpans, { id: `bar:${span.action}`, action: span.action, startCol: span.startCol, endCol: span.endCol }]
      targets.push({ kind: 'action', action: span.action, row: barRow, startCol: span.startCol, endCol: span.endCol })
    }
    lines.push(fit(bar.line, width))
    this.paint = {
      width,
      rows: this.rowGrant,
      targets,
      identity: this.gestureIdentity(),
    }
    return lines.slice(0, this.rowGrant)
  }

  /** FR4: the whole-page configuration form (never a third column). Returns the
   *  painted lines AND the physical rows of the fields that were painted, so
   *  the caller can register them as pointer targets. */
  private renderEditor(snapshot: McpServersSnapshot, width: number, rows: number, confirmation: { readonly lines: readonly string[] }): {
    readonly lines: string[]
    readonly fieldRows: readonly { readonly id: string; readonly index: number; readonly line: number }[]
  } {
    const editor = snapshot.editor
    if (editor === undefined) {
      return { lines: [fit(color.textDim('The configuration form was closed'), width)], fieldRows: [] }
    }
    const statusRows = 1
    const inputRows = this.formInput === undefined ? 0 : 1
    // RC-B: the editor's fixed IDENTITY line is painted INSIDE the body grant.
    // The Root's narrow layout grants no pane-header row (`paneHeaderRows = 0`),
    // so a child `paneHeader()` is never drawn there: the identity must be part
    // of the child's own content to be a real, always-visible fact.
    const identity = this.editorIdentity()
    const identityLines = identity === undefined ? [] : [this.editorIdentityLine(identity, width)]
    // RC-B: a confirmation's TARGET + ACTION + CONSEQUENCE live in the body,
    // wrapped (long host names hard-split, never dropped), so the safety facts
    // survive any Action Bar compaction. `blocked` means the current grant
    // cannot show them all — the page then refuses to confirm.
    const disclosure = confirmation.lines
    const bodyRows = Math.max(1, rows - statusRows - inputRows - identityLines.length - disclosure.length)
    // Keep the focused row inside the painted window. The scroller reasons in
    // PHYSICAL content rows (group headers occupy rows too), never in field
    // indices: a short grant would otherwise let the focused field scroll out
    // of view while the user believes they are editing it.
    const probe = renderMcpConfigForm(editor, width, bodyRows, this.formFocus, 0,
      (field, key) => this.controller.dictValueForm(field, key),
      (field, key) => this.controller.canRemoveDictKey(field, key))
    const formRowCount = mcpFormRows(editor,
      (field, key) => this.controller.dictValueForm(field, key),
      (field, key) => this.controller.canRemoveDictKey(field, key)).length
    if (this.formFocus >= formRowCount) this.formFocus = Math.max(0, formRowCount - 1)
    const focusedRow = probe.focusedContentRow >= 0 ? probe.focusedContentRow : 0
    if (focusedRow < this.formOffset) this.formOffset = focusedRow
    if (focusedRow >= this.formOffset + bodyRows) this.formOffset = focusedRow - bodyRows + 1
    const rendered = renderMcpConfigForm(editor, width, bodyRows, this.formFocus, this.formOffset,
      (field, key) => this.controller.dictValueForm(field, key),
      (field, key) => this.controller.canRemoveDictKey(field, key))
    const lines = [...identityLines, ...disclosure.map(line => fit(color.warning(line), width)), ...rendered.lines]
    if (this.formInput !== undefined) {
      const [inputLine] = this.formInput.input.render(width)
      lines.push(fit(color.textMuted('edit: ') + (inputLine ?? ''), width))
    }
    const pinned = `rev ${String(editor.capturedRevision)}`
    const statusText = this.configSavingNotice
      ? 'Already saving — the write cannot be cancelled here'
      : this.discardConfirm
        ? 'Discard changes? [Keep editing] [Discard d]'
        : `${mcpFormStatusText(editor, snapshot.configStatus?.text)} · ${pinned}`
    const painted = truncateToWidth(sanitizedPhysicalLine(statusText), width, '…', false)
    lines.push(fit(this.discardConfirm || snapshot.configStatus === undefined
      ? color.textDim(painted)
      : this.configStatusInk({ ...snapshot.configStatus, text: painted }), width))
    // The field rows that really painted, with their PHYSICAL line index (the
    // input/status lines below them are not fields).
    const formRows = mcpFormRows(editor,
      (field, key) => this.controller.dictValueForm(field, key),
      (field, key) => this.controller.canRemoveDictKey(field, key))
    const fixedRowsAbove = identityLines.length + disclosure.length
    const fieldRows = rendered.painted.flatMap(paintedRow => {
      const index = formRows.findIndex(candidate => candidate.id === paintedRow.row.id)
      return index < 0 ? [] : [{ id: paintedRow.row.id, index, line: paintedRow.line + fixedRowsAbove }]
    })
    return { lines: lines.slice(0, rows), fieldRows }
  }

  /** The list column of the wide/compact projections. */
  private renderList(
    snapshot: McpServersSnapshot,
    width: number,
    rows: number,
    targets: McpPaintedTarget[],
  ): string[] {
    const lines: string[] = []
    const showHeader = this.layoutClass() !== 'narrow' && rows >= 4
    if (this.searching) {
      const [searchLine] = this.searchInput.render(width)
      lines.push(fit(color.textMuted('search: ') + (searchLine ?? ''), width))
    } else if (showHeader) {
      lines.push(this.listHeader(width))
    }
    const noticeRows = snapshot.notice === undefined ? 0 : 1
    // FR4: the ONE configuration-action status line (saving/saved/conflict).
    const configRows = snapshot.configStatus === undefined ? 0 : 1
    const phaseRows = snapshot.phase === 'ready' ? 0 : 1
    const summaryRows = this.layoutClass() === 'wide' ? 0 : 1
    const reserved = lines.length + noticeRows + configRows + phaseRows + summaryRows
    const viewport = Math.max(1, rows - reserved)
    const visible = this.visibleRows(snapshot)
    // Keep the selected row inside the painted list window.
    const selectedIndex = visible.findIndex(row => row.name === snapshot.selectedName)
    if (selectedIndex >= 0) {
      if (selectedIndex < this.listOffset) this.listOffset = selectedIndex
      if (selectedIndex >= this.listOffset + viewport) this.listOffset = selectedIndex - viewport + 1
    }
    const maxOffset = Math.max(0, visible.length - viewport)
    this.listOffset = Math.min(Math.max(0, this.listOffset), maxOffset)
    const rowTop = lines.length
    if (visible.length === 0) {
      const text = snapshot.phase === 'loading'
        ? 'Loading MCP servers…'
        : this.query() !== ''
          ? 'No managed MCP servers match'
          : snapshot.phase === 'unavailable'
            ? 'MCP Manager unavailable'
            : 'No managed MCP servers'
      lines.push(this.emptyInk(text))
    } else {
      for (let index = 0; index < viewport; index += 1) {
        const row = visible[this.listOffset + index]
        if (row === undefined) break
        const selected = row.name === snapshot.selectedName
        const marker = selected ? color.textStrong('▸ ', 'primary') : '  '
        const { name: nameWidth, status: statusWidth, source: sourceWidth } = this.listColumns(width)
        const plainName = truncateToWidth(sanitizedPhysicalLine(row.name), nameWidth, '…', false)
        const plainStatus = mcpServerStatusText(row.status)
        const plainStatusText = truncateToWidth(plainStatus, statusWidth, '…', false)
        const paddedName = plainName + ' '.repeat(Math.max(0, nameWidth - visibleWidth(plainName)))
        const paddedStatus = plainStatusText + ' '.repeat(Math.max(0, statusWidth - visibleWidth(plainStatusText)))
        const sourcePart = sourceWidth === 0
          ? ''
          : ' ' + sourceInk(truncateToWidth(row.source, sourceWidth, '…', false))
        const line = marker
          + (selected ? color.textStrong(paddedName, 'primary') : color.text(paddedName))
          + ' '
          + statusInk(row.status, paddedStatus)
          + sourcePart
        lines.push(fit(line, width))
        targets.push({
          kind: 'server-row',
          name: row.name,
          row: rowTop + index,
          startCol: 0,
          endCol: width,
        })
      }
    }
    while (lines.length < rows - noticeRows - configRows - phaseRows - summaryRows) lines.push(fit('', width))
    if (summaryRows === 1) {
      const selected = snapshot.rows.find(row => row.name === snapshot.selectedName)
      const text = selected === undefined
        ? 'No server selected'
        : `${selected.name} · ${mcpServerStatusText(selected.status)} · ${selected.source}`
      lines.push(fit(color.textDim(truncateToWidth(sanitizedPhysicalLine(text), width, '…', false)), width))
    }
    if (phaseRows === 1) lines.push(fit(this.phaseLine(snapshot, width), width))
    if (configRows === 1 && snapshot.configStatus !== undefined) {
      lines.push(fit(this.configStatusLine(snapshot.configStatus, width), width))
    }
    if (noticeRows === 1 && snapshot.notice !== undefined) lines.push(fit(this.noticeLine(snapshot.notice, width), width))
    return lines.slice(0, rows)
  }

  /** The frozen list columns: Status 16, Source 17 (the longest official
   *  source label), the rest is the name. The narrow projection drops the
   *  source column (it stays in the Detail and the summary line). */
  private listColumns(width: number): { readonly name: number; readonly status: number; readonly source: number } {
    if (this.layoutClass() === 'narrow') {
      const status = 11
      return { name: Math.max(6, width - 2 - 1 - status), status, source: 0 }
    }
    const status = 16
    const source = 17
    return { name: Math.max(6, width - 2 - 1 - status - 1 - source), status, source }
  }

  private listHeader(width: number): string {
    const { name, status, source } = this.listColumns(width)
    const names = 'Name' + ' '.repeat(Math.max(0, name - 4))
    const statuses = 'Status' + ' '.repeat(Math.max(0, status - 6))
    if (source === 0) return fit(color.textMuted(`  ${names} ${statuses}`), width)
    const sources = 'Source' + ' '.repeat(Math.max(0, source - 6))
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

  /** FR4: the configuration-action status ink — the design-language §3.2
   *  status-word contract (`Verified`/saved → success, `Not saved` → error,
   *  `Outcome unknown` → warning, `Saving…` → textDim, `Unavailable` → error).
   *  A saved configuration is never painted as a connection claim. */
  private configStatusInk(status: McpConfigStatus): string {
    switch (status.kind) {
      case 'saved': return color.success(status.text)
      case 'saving': return color.textDim(status.text)
      case 'unconfirmed': return color.warning(status.text)
      case 'conflict':
      case 'rejected':
      case 'unavailable': return color.error(status.text)
    }
  }

  /** FR4: the ONE configuration-action status line (a saved config is never a
   *  connection claim). */
  private configStatusLine(status: McpConfigStatus, width: number): string {
    return truncateToWidth(sanitizedPhysicalLine(status.text), width, '…', false)
      .replace(/^.*$/u, (text) => this.configStatusInk({ ...status, text }))
  }

  /** The detail lines of the selected server (fixed field order). */
  private detailLines(snapshot: McpServersSnapshot): string[] {
    const row = snapshot.rows.find(candidate => candidate.name === snapshot.selectedName)
    if (row === undefined) {
      return snapshot.rows.length === 0
        ? [color.textDim('No managed MCP servers')]
        : [color.textDim('Select a managed server')]
    }
    const lines: string[] = []
    const add = (label: string, value: string, ink: (text: string) => string = color.text): void => {
      lines.push(`${color.textDim(`${label}: `)}${ink(value)}`)
    }
    add('Server', row.name)
    add('Source', row.source, () => sourceInk(row.source))
    // FR4: the configuration provenance from the SAME descriptor (a plugin
    // registration has no config entry and therefore no provenance line).
    const config = snapshot.selectedConfig
    if (config !== undefined) {
      add('Configuration', config.provenance === 'user-added'
        ? 'User-added'
        : config.provenance === 'inherited' ? 'Inherited' : 'Overridden (user)')
      if (config.enabled !== undefined) add('Saved enabled', config.enabled ? 'yes' : 'no')
      const transport = this.selectedConfigTransport(snapshot)
      if (transport !== undefined) add('Saved transport', transport)
    }
    // The official list publishes no transport: a "Not exposed" fact beats an
    // invented stdio/http claim.
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
      add('Operation', snapshot.operation.text ?? snapshot.operation.kind, (text) => snapshot.operation?.phase === 'failed' ? color.error(text) : color.textDim(text))
    }
    // FR4: the ONE configuration-action status slot (a saved config is never a
    // connected claim; the state above stays the manager's own fact).
    if (snapshot.configStatus !== undefined && snapshot.configStatus.kind !== 'saving') {
      const status = snapshot.configStatus
      add('Configuration', status.text, (text) => this.configStatusInk({ ...status, text }))
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

  private renderDetail(snapshot: McpServersSnapshot, width: number, rows: number, confirmation: { readonly lines: readonly string[] }): string[] {
    const lines: string[] = [...confirmation.lines.map(line => fit(color.warning(line), width))]
    const noticeRows = snapshot.notice === undefined ? 0 : 1
    const viewport = Math.max(1, rows - noticeRows)
    const all = this.detailLines(snapshot)
    this.detailOffset = Math.min(Math.max(0, this.detailOffset), Math.max(0, all.length - viewport))
    for (let index = 0; index < viewport; index += 1) {
      const line = all[this.detailOffset + index]
      if (line === undefined) {
        lines.push(fit('', width))
        continue
      }
      lines.push(fit(truncateToWidth(line, width, '…', false), width))
    }
    if (noticeRows === 1 && snapshot.notice !== undefined) lines.push(fit(this.noticeLine(snapshot.notice, width), width))
    return lines.slice(0, rows)
  }

  private renderBar(width: number, snapshot: McpServersSnapshot): ReturnType<typeof paintBar> {
    // RC-B: a confirmation whose target/consequence cannot be fully painted in
    // the CURRENT frame is not executable — neither key nor pointer — so its
    // bar offers only the escape. This branch precedes every confirmation
    // branch (Save, Toggle, Delete, Reset) so `Y confirm` is never painted on
    // an unreviewable question.
    const verdict = this.confirmationVerdict(snapshot)
    if (verdict === 'blocked' || verdict === 'unpainted') {
      return paintBar([
        { text: 'Resize to review the target and its consequence', short: 'Resize to review', priority: 1000 },
        { text: 'Esc cancel', short: 'Esc', priority: 999, action: 'cancel' },
      ], width, true)
    }
    if (snapshot.configConfirm !== undefined) {
      const confirm = snapshot.configConfirm
      const name = sanitizedPhysicalLine(confirm.name)
      if (confirm.kind === 'delete') {
        return paintBar(
          [{ text: `Delete ${name}? This removes your added configuration permanently`, short: `Delete ${name}?`, priority: 1000 }, ...CONFIRM_HINTS],
          width,
          true,
        )
      }
      if (confirm.kind === 'reset') {
        return paintBar(
          [{ text: `Remove your override and restore the inherited configuration for ${name}?`, short: `Reset ${name}?`, priority: 1000 }, ...CONFIRM_HINTS],
          width,
          true,
        )
      }
      if (confirm.kind === 'save') {
        // The BODY carries the target + capability + consequence (wrapped and
        // hard-split); the bar carries the DECISION and must never let a long
        // server name or HTTP host push `Y confirm`/`Esc` out of the row. The
        // question segment therefore drops FIRST when the row is tight.
        return paintBar([
          { text: `Save ${sanitizedPhysicalLine(confirm.name)}?`, short: 'Save?', priority: 800 },
          ...CONFIRM_HINTS,
        ], width, true)
      }
      return paintBar(
        [{ text: 'Change saved configuration? The MCP process may stop or start', short: 'Change config?', priority: 1000 }, ...CONFIRM_HINTS],
        width,
        true,
      )
    }
    if (this.discardConfirm) {
      return paintBar([{ text: 'Discard changes?', short: 'Discard?', priority: 1000 }, ...DISCARD_HINTS], width, true)
    }
    if (this.view === 'editor') {
      if (this.formInput !== undefined) return paintBar(EDITOR_INPUT_HINTS, width, true)
      // While the Save is unsettled the draft is FROZEN: `s Save` would be a
      // second submit and the navigation keys would be inert, so only the
      // truthful leave affordance is painted.
      if (snapshot.configStatus?.kind === 'saving') {
        return paintBar([
          { text: 'Saving configuration…', short: 'Saving…', priority: 1000 },
          { text: 'Esc', priority: 999 },
        ], width, true)
      }
      return paintBar(EDITOR_HINTS, width, true)
    }
    if (snapshot.confirmingName !== undefined) {
      return paintBar(
        [{
          text: `Restart ${sanitizedPhysicalLine(snapshot.confirmingName)}? Live tools may be interrupted`,
          short: `Restart ${sanitizedPhysicalLine(snapshot.confirmingName)}?`,
          priority: 1000,
        }, ...CONFIRM_HINTS],
        width,
        true,
      )
    }
    if (this.searching) return paintBar(SEARCH_HINTS, width, true)
    if (this.inDetail()) {
      const selectedRow = snapshot.rows.find(row => row.name === snapshot.selectedName)
      // Probe/Restart follow the FR3 roster rules only: a live entry on a
      // current observation with no in-flight operation. A retained cleanup
      // record (`configured:false`) is diagnostic only.
      const operable = snapshot.phase === 'ready'
        && snapshot.operation?.phase !== 'running'
        && snapshot.selectedName !== undefined
        && selectedRow?.configured === true
      // Each CRUD affordance is painted from the facet the controller actually
      // computed from the same-generation descriptor: a plugin-owned server has
      // no config entry (so no `e/t/d/u`) but STILL offers `p/x`, while an
      // inherited entry offers edit/toggle but neither Delete nor Reset.
      const facet = snapshot.selectedConfig
      const segments: McpBarSegment[] = []
      if (operable) {
        segments.push({ text: 'p probe', priority: 30, action: 'probe' }, { text: 'x restart', priority: 25, action: 'restart' })
      }
      if (facet !== undefined) {
        // `e` uses the SAME predicate the key handler uses, so the painted bar
        // can never advertise an Edit the controller would refuse.
        if (this.controller.canBeginEdit()) segments.push({ text: 'e edit', priority: 24, action: 'edit' })
        if (facet.canToggle) segments.push({ text: 't enable/disable', short: 't toggle', priority: 23, action: 'toggle' })
        if (facet.canDelete) segments.push({ text: 'd delete', priority: 22, action: 'delete' })
        if (facet.canReset) segments.push({ text: 'u reset', priority: 21, action: 'reset' })
      }
      segments.push({ text: 'r refresh', priority: 10, action: 'refresh' }, { text: 'Back [Esc]', priority: 1000, action: 'back' })
      return paintBar(segments, width, true)
    }
    // The List Add hint uses the SAME gate the `a` key handler calls, so an
    // in-flight Probe/Restart or a non-ready descriptor can never advertise an
    // Add that does nothing.
    const addable = this.controller.canBeginAdd()
    return paintBar(addable ? LIST_HINTS : LIST_HINTS.filter(segment => !segment.text.includes('Add')), width, true)
  }
}
