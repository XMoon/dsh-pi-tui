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
import { MCP_HTTP_TARGET_MARKER } from '../../app/command/mcp-servers.ts'
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

/** One painted hit target of the LAST frame, in page-local cells. */
interface McpPaintedTarget {
  readonly kind: 'server-row'
  readonly name: string
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
function paintBar(segments: readonly ActionBarSegment[], width: number, lastIsEscape: boolean): {
  readonly line: string
  readonly escape?: { readonly startCol: number; readonly endCol: number }
} {
  const layout = layoutActionBarRow(segments, width)
  if (layout.truncated || layout.spans.length === 0) {
    return { line: color.textMuted(truncateToWidth(layout.text, Math.max(0, width), '…', true)) }
  }
  let painted = ''
  let escape: { startCol: number; endCol: number } | undefined
  for (const span of layout.spans) {
    if (painted !== '') painted += ACTION_BAR_SEPARATOR
    const isLast = span.inputIndex === segments.length - 1
    painted += isLast && lastIsEscape ? paintActionSpan(span.text, 'secondary') : color.textMuted(span.text)
    if (isLast && lastIsEscape) escape = { startCol: span.startCol, endCol: span.endCol }
  }
  return { line: painted, ...escape === undefined ? {} : { escape } }
}

/** The long list/detail hints, shortened when the frame is tight. */
const LIST_HINTS: readonly ActionBarSegment[] = [
  { text: '↑/↓ move', short: '↑/↓', priority: 30 },
  { text: 'Enter details', short: 'Enter', priority: 20 },
  { text: 'a Add', priority: 18 },
  { text: '/ search', priority: 15 },
  { text: 'r refresh', priority: 10 },
  // The Esc affordance is the ONE required segment at every width: it is never
  // compacted away from `Verb [Esc]` (only a frame too narrow for even that
  // truncates it).
  { text: 'Back [Esc]', priority: 1000 },
]
const EDITOR_HINTS: readonly ActionBarSegment[] = [
  { text: '↑/↓ field', short: '↑/↓', priority: 30 },
  { text: 'Enter edit', short: 'Enter', priority: 25 },
  { text: 'Tab next', short: 'Tab', priority: 20 },
  { text: 's Save', priority: 40 },
  { text: 'Back [Esc]', priority: 1000 },
]
const EDITOR_INPUT_HINTS: readonly ActionBarSegment[] = [
  { text: 'Enter apply', short: 'Enter', priority: 30 },
  { text: 'Esc cancel', short: 'Esc', priority: 1000 },
]
const DISCARD_HINTS: readonly ActionBarSegment[] = [
  { text: 'Keep editing', short: 'Keep', priority: 900 },
  { text: 'Esc', priority: 999 },
]
/** The confirmation ANSWER segments. `Esc` is the required affordance and `y`
 *  is the only affirmative key, so both are compacted (never dropped) before
 *  the target sentence — the target sentence itself carries the HIGHEST
 *  priority, because a confirmation whose subject vanished would let the user
 *  answer a question they cannot read (§7.2 "safety facts kept"). */
const CONFIRM_HINTS: readonly ActionBarSegment[] = [
  { text: 'Y confirm', short: 'y', priority: 900 },
  { text: 'Esc cancel', short: 'Esc', priority: 999 },
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
  private disposed = false
  private revision = 0
  private paint: McpPagePaint | undefined
  /** The frame being painted (layout decisions must read THIS grant, not the
   *  previous frame's paint). */
  private rendering: { readonly width: number; readonly bodyRows: number } | undefined
  private paintedEscapeSpanValue: { readonly startCol: number; readonly endCol: number } | undefined
  private grantAwaitingPaintValue = true
  private pressed: {
    readonly name: string
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
      if (data === 'y' || data === 'Y') this.controller.answerConfigConfirm(true)
      // No other key may dispatch a Host write.
      return
    }
    // The dirty-discard confirmation: Keep editing is the default; only an
    // explicit `d` drops the draft (zero official writes).
    if (this.discardConfirm) {
      if (data === 'd' || data === 'D') {
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
      if (data === 'y' || data === 'Y') this.controller.answerRestart(true)
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
    const input = new Input({
      prompt: '> ',
      placeholder: row.action.kind === 'edit-dict-value' ? 'new value (blank keeps current)' : '',
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
        // An empty commit keeps the stored value (the form never rewrites a
        // hidden value it did not just type). A non-empty commit uses the FORM
        // the user explicitly chose for this key.
        if (value !== '') {
          this.controller.setEditorDictValue(field, key, value, this.controller.dictValueForm(field, key))
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
      if (editor.dirty) {
        this.discardConfirm = true
        this.bumpRevision()
        return
      }
      this.controller.discardEditor()
      this.formFocus = 0
      this.formOffset = 0
      this.view = this.layoutClass() === 'wide' ? 'list' : 'detail'
      this.bumpRevision()
      return
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
    const target = paint.targets.find(candidate => candidate.row === event.y
      && event.x >= candidate.startCol && event.x < candidate.endCol)
    if (event.type === 'press') {
      if (target === undefined || event.button !== 'left') {
        this.pressed = undefined
        return undefined
      }
      this.pressed = {
        name: target.name,
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
        || pressed.name !== target.name
        || pressed.row !== target.row
        || pressed.startCol !== target.startCol
        || pressed.endCol !== target.endCol) return undefined
      const snapshot = this.controller.snapshot()
      this.controller.select(target.name, this.visibleNames(snapshot))
      if (this.layoutClass() === 'wide') this.wideFocus = 'list'
      this.bumpRevision()
      return { handled: true }
    }
    return undefined
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.paint = undefined
    this.pressed = undefined
    this.paintedEscapeSpanValue = undefined
    this.formInput = undefined
    this.discardConfirm = false
    this.controller.dispose()
  }

  invalidate(): void {}

  /** The pane-header line the root paints inside the shared body grant. */
  paneHeader(width: number): string {
    if (this.layoutClass() !== 'wide') {
      return this.focused
        ? color.textStrong(`[${MCP_SERVERS_PAGE_TITLE}]`, 'primary')
        : color.textDim(MCP_SERVERS_PAGE_TITLE)
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
    const targets: McpPaintedTarget[] = []
    const lines: string[] = []
    const layout = mcpServersLayoutFor(width, bodyRows)
    if (this.view === 'editor') {
      lines.push(...this.renderEditor(snapshot, width, bodyRows))
    } else if (layout === 'wide') {
      const listWidth = this.wideListWidth()
      const detailWidth = Math.max(1, width - listWidth - 2)
      const left = this.renderList(snapshot, listWidth, bodyRows, targets)
      const right = this.renderDetail(snapshot, detailWidth, bodyRows)
      for (let index = 0; index < bodyRows; index += 1) {
        lines.push(composeRow(left[index] ?? '', right[index] ?? '', width))
      }
    } else if (this.view === 'detail') {
      lines.push(...this.renderDetail(snapshot, width, bodyRows).map(line => fit(line, width)))
    } else {
      lines.push(...this.renderList(snapshot, width, bodyRows, targets))
    }
    while (lines.length < bodyRows) lines.push(fit('', width))
    const bar = this.renderBar(width, snapshot)
    this.paintedEscapeSpanValue = bar.escape
    lines.push(fit(bar.line, width))
    this.paint = {
      width,
      rows: this.rowGrant,
      targets,
      identity: this.gestureIdentity(),
    }
    return lines.slice(0, this.rowGrant)
  }

  /** FR4: the whole-page configuration form (never a third column). */
  private renderEditor(snapshot: McpServersSnapshot, width: number, rows: number): string[] {
    const editor = snapshot.editor
    if (editor === undefined) {
      return [fit(color.textDim('The configuration form was closed'), width)]
    }
    const statusRows = 1
    const inputRows = this.formInput === undefined ? 0 : 1
    const bodyRows = Math.max(1, rows - statusRows - inputRows)
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
    const lines = [...rendered.lines]
    if (this.formInput !== undefined) {
      const [inputLine] = this.formInput.input.render(width)
      lines.push(fit(color.textMuted('edit: ') + (inputLine ?? ''), width))
    }
    const statusText = this.discardConfirm
      ? 'Discard changes? [Keep editing] [Discard d]'
      : mcpFormStatusText(editor, snapshot.configStatus?.text)
    const painted = truncateToWidth(sanitizedPhysicalLine(statusText), width, '…', false)
    lines.push(fit(this.discardConfirm || snapshot.configStatus === undefined
      ? color.textDim(painted)
      : this.configStatusInk({ ...snapshot.configStatus, text: painted }), width))
    return lines.slice(0, rows)
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

  private renderDetail(snapshot: McpServersSnapshot, width: number, rows: number): string[] {
    const lines: string[] = []
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
        // The external-capability disclosure is the question: it must survive
        // whole-segment drops AND its compaction must keep the SAFETY FACT —
        // for an HTTP entry the compaction still names the target host (a
        // bare `Save configuration?` would hide what the user is enabling).
        const warning = confirm.warning ?? 'Save this configuration?'
        const markerAt = warning.indexOf(MCP_HTTP_TARGET_MARKER)
        // The compaction keeps the TARGET HOST itself (the shortest form that
        // still answers "which external service?"); the full sentence is used
        // whenever the row has room for it.
        const short = markerAt === -1
          ? 'External command?'
          : `External service: ${warning.slice(markerAt + MCP_HTTP_TARGET_MARKER.length)}`
        // The compaction must still answer BOTH "which capability?" and
        // "which target?", so the tests assert `external service` + the host.
        return paintBar([{ text: warning, short, priority: 1000 }, ...CONFIRM_HINTS], width, true)
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
      const segments: ActionBarSegment[] = []
      if (operable) {
        segments.push({ text: 'p probe', priority: 30 }, { text: 'x restart', priority: 25 })
      }
      if (facet !== undefined) {
        segments.push({ text: 'e edit', priority: 24 })
        if (facet.canToggle) segments.push({ text: 't enable/disable', short: 't toggle', priority: 23 })
        if (facet.canDelete) segments.push({ text: 'd delete', priority: 22 })
        if (facet.canReset) segments.push({ text: 'u reset', priority: 21 })
      }
      segments.push({ text: 'r refresh', priority: 10 }, { text: 'Back [Esc]', priority: 1000 })
      return paintBar(segments, width, true)
    }
    const addable = snapshot.phase === 'ready'
      && snapshot.config?.kind === 'ready'
      // Add dispatches a write, so it is not offered while one is unsettled.
      && snapshot.configStatus?.kind !== 'saving'
    return paintBar(addable ? LIST_HINTS : LIST_HINTS.filter(segment => !segment.text.includes('Add')), width, true)
  }
}
