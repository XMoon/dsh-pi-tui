/**
 * Phase 3B / B2-A — the fullscreen Settings workspace panel.
 *
 * ONE client-local component owns the whole read-only Settings surface: the
 * category / row / detail responsive layout (wide three-column, medium
 * two-column, narrow three-level drill-down), the per-open selection and
 * scroll state, the keyboard navigation and the last-painted mouse hit map.
 * It is the layout ROOT of the temporary Settings alt screen
 * (`TuiApp.openSettingsWorkspace`), so every key arrives on its own
 * {@link SettingsWorkspacePanel.handleInput} and every click on the alt
 * screen's `onCellPress`/`onCellClick` is re-proved against the cells this
 * component actually painted.
 *
 * The panel owns NO configuration authority: its rows are a detached read
 * projection assembled by the `/settings` command from the existing ConfigPort /
 * DisplayState / presentation-preference readers, and the only verbs it exposes
 * are navigate, refresh (re-read the same authority), copy the exact source
 * value and hand off to the existing legacy settings editor. B2-A never writes.
 * @module @xmoon76/dsh-pi-tui/tui/panels/settings-workspace-panel
 */

import {
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@xmoon76/pi-tui'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { color } from '../theme/runtime.ts'

/** The three frozen B2-A categories. */
export type SettingsWorkspaceCategoryId = 'appearance' | 'display' | 'other'

/** The narrow-layout drill-down level; also the wide/medium focus owner. */
export type SettingsWorkspacePage = 'categories' | 'rows' | 'detail'

/** The stable identity of one readonly pilot row. */
export type SettingsWorkspaceRowId =
  | 'theme'
  | 'icon-style'
  | 'display-preset'
  | 'thinking'
  | 'legacy-settings'

/** How current one row's value is, as the reader proved it. */
export type SettingsWorkspaceFreshness = 'runtime' | 'ready' | 'last-known' | 'unavailable' | 'read-error'

/**
 * ONE row of the detached read projection. `summary` is the human-facing
 * display value, `value` is the exact source value the user copies (a
 * source-qualified theme id, a raw configured icon style, a runtime preset) —
 * never a re-derived display string.
 */
export interface SettingsWorkspaceRow {
  readonly id: SettingsWorkspaceRowId
  readonly category: SettingsWorkspaceCategoryId
  readonly label: string
  readonly summary: string
  readonly value?: string
  readonly scope: string
  readonly freshness: SettingsWorkspaceFreshness
  readonly description: string
  readonly action: 'inspect' | 'open-legacy'
}

/** The snapshot one open/refresh reads from the live authorities. */
export interface SettingsWorkspaceSnapshot {
  readonly configReadiness: 'ready' | 'stale' | 'unavailable'
  readonly rows: readonly SettingsWorkspaceRow[]
  readonly capturedAt: number
  readonly readIssue?: string
}

/** The read-only projection the app supplies (no shadow store, no watch). */
export interface SettingsWorkspaceSource {
  readSnapshot(): SettingsWorkspaceSnapshot
}

/** The client-local capabilities the panel consumes. */
export interface SettingsWorkspacePanelIntents {
  /** The live terminal row budget (the panel never reads the terminal itself). */
  readonly rows: () => number
  readonly requestRender: () => void
  /** The ONE app-owned transient notice (never a second notice store). */
  readonly notice: () => { readonly text: string; readonly kind: 'info' | 'error' } | undefined
  /** Esc at the outermost narrow level, or Esc/Backspace in wide/medium. */
  readonly onClose: () => void
  /** The compatibility bridge: open the existing complete settings editor. */
  readonly onOpenLegacy: () => void
  /** Copy the exact captured source value through the app's clipboard owner. */
  readonly onCopy: (text: string) => void
}

type SettingsLayout = 'wide' | 'medium' | 'narrow'

interface SettingsChromePlan {
  readonly width: number
  readonly rows: number
  readonly layout: SettingsLayout
  readonly headerRows: number
  readonly metaRows: number
  readonly ruleRows: number
  readonly noticeRows: number
  readonly actionRows: number
  readonly bodyRows: number
}

interface PaneBox {
  /** Absolute panel column of the pane. */
  readonly x: number
  readonly width: number
  /** Absolute panel row of the pane's first CONTENT line. */
  readonly contentTop: number
  readonly contentRows: number
  /** The scrollable extent measured at paint. */
  readonly maxOffset: number
}

interface PaneBoxes {
  categories?: PaneBox
  rows?: PaneBox
  detail?: PaneBox
}

interface HitTarget {
  readonly kind: 'category' | 'row' | 'copy' | 'legacy' | 'pane' | 'category-prev' | 'category-next'
  /** The stable identity: a category id, a row id or the pane name. */
  readonly id: string
  /** Absolute panel row of the painted cell. */
  readonly row: number
  readonly startCol: number
  readonly endCol: number
}

interface DetailProjection {
  readonly lines: readonly string[]
  readonly content: readonly string[]
  readonly viewport: number
  readonly button?: { readonly text: string; readonly kind: 'copy' | 'legacy' }
}

const CATEGORY_ORDER: readonly SettingsWorkspaceCategoryId[] = ['appearance', 'display', 'other']

const CATEGORY_LABELS: Record<SettingsWorkspaceCategoryId, string> = {
  appearance: 'Appearance',
  display: 'Display',
  other: 'Other settings',
}

const FOCUS_ORDER: readonly SettingsWorkspacePage[] = ['categories', 'rows', 'detail']

const WIDE_CATEGORY_WIDTH = 22
const WIDE_ROWS_WIDTH = 42
const MEDIUM_ROWS_WIDTH = 40
const COLUMN_GAP = 2

/** The minimum column count of the two-column (medium) projection. */
export const SETTINGS_WORKSPACE_MEDIUM_MIN_COLUMNS = 96
/** The minimum column count of the three-column (wide) projection. */
const WIDE_MIN_COLUMNS = 150

/** The frozen responsive breakpoints of THIS component (not a project rule). */
function layoutForWidth(width: number): SettingsLayout {
  if (width >= WIDE_MIN_COLUMNS) return 'wide'
  if (width >= SETTINGS_WORKSPACE_MEDIUM_MIN_COLUMNS) return 'medium'
  return 'narrow'
}

/** The initial focus owner at a given terminal width: wide/medium start on the
 *  row list (their category switch is visible), narrow on the category list
 *  (its drill-down root). */
export function settingsWorkspaceInitialFocus(columns: number): SettingsWorkspacePage {
  return columns >= SETTINGS_WORKSPACE_MEDIUM_MIN_COLUMNS ? 'rows' : 'categories'
}

/**
 * The ONE per-frame row allocation, in the frozen §4.4 priority order: the
 * Action Bar and the Header are granted first, then the BODY keeps at least one
 * real row (from three terminal rows on), then the optional notice (rows>=6,
 * body>=2 after it) and freshness/scope metadata (rows>=8, body>=3 after it).
 * The decorative rules are LAST: they are granted only when the body would still
 * keep three real rows, so decoration never crowds out readable content.
 */
function planSettingsChrome(width: number, rows: number, noticeLive: boolean): SettingsChromePlan {
  const safeRows = Math.max(1, Math.floor(rows))
  const headerRows = safeRows >= 2 ? 1 : 0
  const actionRows = 1
  // Rows the body could use once the mandatory chrome is granted.
  const base = Math.max(0, safeRows - headerRows - actionRows)
  // §4.4: the notice keeps the body at two rows; the metadata keeps it at three.
  const noticeRows = safeRows >= 6 && noticeLive && base - 1 >= 2 ? 1 : 0
  const metaRows = safeRows >= 8 && base - noticeRows - 1 >= 3 ? 1 : 0
  const bodyWithoutRules = base - noticeRows - metaRows
  const ruleRows = bodyWithoutRules >= 5 ? 2 : 0
  const bodyRows = Math.max(0, bodyWithoutRules - ruleRows)
  return {
    width,
    rows: safeRows,
    layout: layoutForWidth(width),
    headerRows,
    metaRows,
    ruleRows,
    noticeRows,
    actionRows,
    bodyRows,
  }
}

/** Truncate one rendered line to the pane width and pad it with plain spaces. */
function fit(text: string, width: number): string {
  if (width <= 0) return ''
  const clamped = truncateToWidth(text, width, '…', false)
  const padding = width - visibleWidth(clamped)
  return padding > 0 ? clamped + ' '.repeat(padding) : clamped
}

/** Pad a body projection to its granted viewport so the frame never under-paints. */
function padBody(lines: string[], viewport: number, width: number): string[] {
  while (lines.length < viewport) lines.push(fit('', width))
  return lines.slice(0, viewport)
}

/** Keep the selected index inside its viewport with the smallest rebase. */
function rebaseOffset(offset: number, selected: number, count: number, viewport: number): number {
  if (viewport <= 0) return 0
  let next = offset
  if (selected < next) next = selected
  if (selected >= next + viewport) next = selected - viewport + 1
  const max = Math.max(0, count - viewport)
  return Math.min(Math.max(0, next), max)
}

/** Clamp a user-authored scroll offset without pulling the selection back. */
function clampOffset(offset: number, count: number, viewport: number): number {
  if (viewport <= 0) return 0
  return Math.min(Math.max(0, offset), Math.max(0, count - viewport))
}

/**
 * The Detail display projection of arbitrary source text: complete terminal
 * sequences and unknown control bytes are stripped (the display boundary), but
 * the MEANINGFUL whitespace controls are made visible as `\n` / `\r` / `\t`,
 * other controls as `\xNN`, and a literal backslash as `\\`. The projection is
 * therefore AMBIGUITY-FREE — a raw newline and a literal `\n` can never render
 * identically — while the raw copy source stays the untouched DTO value.
 */
function escapedPhysicalLine(text: string): string {
  const stripped = stripTerminalSequences(text)
  let out = ''
  for (const character of stripped) {
    const code = character.codePointAt(0) ?? 0
    if (character === '\\') out += '\\\\'
    else if (character === '\n') out += '\\n'
    else if (character === '\r') out += '\\r'
    else if (character === '\t') out += '\\t'
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) out += `\\x${code.toString(16).padStart(2, '0')}`
    else out += character
  }
  return out
}

function freshnessText(
  row: SettingsWorkspaceRow,
  readiness: SettingsWorkspaceSnapshot['configReadiness'],
): string {
  switch (row.freshness) {
    case 'runtime':
      return 'Runtime now · live Client state'
    case 'ready':
      return 'Ready · on-open snapshot'
    case 'last-known':
      return readiness === 'unavailable'
        ? 'Last-known value · backend unavailable'
        : 'Last-known value · reconnecting'
    case 'unavailable':
      return 'Unavailable — no authoritative config document'
    case 'read-error':
      return 'Read error — the configuration document could not be read'
  }
}

/**
 * The Settings workspace component. Constructed per open with the live read
 * source; `dispose()` only retires local interaction state (there are no
 * timers or listeners to release).
 */
export class SettingsWorkspacePanel implements Component {
  private snapshot: SettingsWorkspaceSnapshot
  private categoryId: SettingsWorkspaceCategoryId = 'appearance'
  private rowId: SettingsWorkspaceRowId
  private focus: SettingsWorkspacePage
  private categoryOffset = 0
  private rowOffset = 0
  private detailOffset = 0
  private paintedTargets: readonly HitTarget[] = []
  private paintedPanes: PaneBoxes = {}
  private paintedViewport = 1
  /** The state version a press must still match at release: every navigation,
   *  refresh or focus change bumps it, so a gesture that spans a data or page
   *  change is refused instead of acting on the newer snapshot. */
  private revision = 0
  private pressedGesture: {
    readonly target: HitTarget
    readonly revision: number
    readonly focus: SettingsWorkspacePage
    readonly categoryId: SettingsWorkspaceCategoryId
  } | undefined
  /** The last selection index AND viewport height each list was rebased
   *  against: the wheel may scroll a list so its selection leaves the viewport,
   *  so only a SELECTION or VIEWPORT change (never a plain repaint) may pull it
   *  back — while a real shrink must reveal the selection again. */
  private lastCategoryIndex = -1
  private lastRowIndex = -1
  private lastCategoryViewport = -1
  private lastRowViewport = -1
  /** The last painted geometry: a terminal resize between a press and its
   *  release must refuse the gesture even when the target's own geometry is
   *  unchanged (the plan's "sizes changed ⇒ reject"). */
  private lastRenderWidth = -1
  private lastRenderRows = -1
  private chrome: SettingsChromePlan | undefined
  private disposed = false
  private readonly source: SettingsWorkspaceSource
  private readonly intents: SettingsWorkspacePanelIntents

  constructor(
    source: SettingsWorkspaceSource,
    intents: SettingsWorkspacePanelIntents,
    /** The initial focus owner: wide/medium start on the row list, narrow on
     *  the category list (its drill-down root). */
    focus: SettingsWorkspacePage,
  ) {
    this.source = source
    this.intents = intents
    this.snapshot = source.readSnapshot()
    this.focus = focus
    this.rowId = this.firstRowOf(this.categoryId)
  }

  // ── rendering ────────────────────────────────────────────────────────────

  render(width: number): string[] {
    const liveRows = this.intents.rows()
    // A terminal resize is a gesture boundary: a press recorded against the old
    // geometry must not resolve against the new one, even when the target's own
    // cells did not move (the plan's "sizes changed ⇒ reject").
    if (this.lastRenderWidth >= 0 && (this.lastRenderWidth !== width || this.lastRenderRows !== liveRows)) {
      this.bumpRevision()
    }
    this.lastRenderWidth = width
    this.lastRenderRows = liveRows
    const plan = planSettingsChrome(width, liveRows, this.intents.notice() !== undefined)
    this.chrome = plan
    const lines: string[] = []
    const targets: HitTarget[] = []
    const panes: PaneBoxes = {}
    if (plan.headerRows === 1) lines.push(...this.renderHeader(plan, targets))
    if (plan.metaRows === 1) lines.push(this.renderMetadata(plan))
    if (plan.ruleRows >= 1) lines.push(color.border('─'.repeat(Math.max(1, plan.width))))
    const bodyTop = plan.headerRows + plan.metaRows + (plan.ruleRows >= 1 ? 1 : 0)
    if (plan.bodyRows > 0) lines.push(...this.renderBody(plan, bodyTop, targets, panes))
    if (plan.ruleRows >= 2) lines.push(color.border('─'.repeat(Math.max(1, plan.width))))
    if (plan.noticeRows === 1) lines.push(this.renderNotice(plan))
    if (plan.actionRows === 1) lines.push(this.renderActionBar(plan))
    this.paintedTargets = targets
    this.paintedPanes = panes
    return lines.slice(0, plan.rows)
  }

  invalidate(): void {}

  private renderHeader(plan: SettingsChromePlan, targets: HitTarget[]): string[] {
    const layout = plan.layout
    const row = this.selectedRow()
    const right = layout === 'wide' ? 'Read-only preview' : 'Read-only'
    if (layout === 'medium') {
      // The medium header carries the ONLY visible category switch: the arrows
      // are real painted mouse targets, and their focus is expressed by the
      // brackets rather than by colour alone.
      const arrowText = this.focus === 'categories' ? '[← category →]' : '← category →'
      const prefix = `SETTINGS · ${CATEGORY_LABELS[this.categoryId]}  `
      const left = `${color.primary('SETTINGS')}${color.textMuted(' · ')}${color.text(CATEGORY_LABELS[this.categoryId])}  ${this.focus === 'categories' ? color.borderFocus(arrowText) : color.textMuted(arrowText)}`
      const arrowStart = visibleWidth(prefix)
      const room = plan.width - visibleWidth(right) - 1
      if (arrowStart + visibleWidth(arrowText) <= room) {
        const prev = arrowText.indexOf('←')
        const next = arrowText.indexOf('→')
        targets.push({ kind: 'category-prev', id: 'category', row: 0, startCol: arrowStart + prev, endCol: arrowStart + prev + 1 })
        targets.push({ kind: 'category-next', id: 'category', row: 0, startCol: arrowStart + next, endCol: arrowStart + next + 1 })
      }
      return [composeEdge(left, color.textMuted(right), plan.width)]
    }
    const title = layout === 'narrow'
      ? this.focus === 'categories'
        ? 'SETTINGS · Categories'
        : this.focus === 'rows'
          ? `SETTINGS · ${CATEGORY_LABELS[this.categoryId]} · Rows`
          : `SETTINGS · ${CATEGORY_LABELS[this.categoryId]} / ${row?.label ?? '—'}`
      : `SETTINGS · ${CATEGORY_LABELS[this.categoryId]}`
    const lead = `${color.primary('SETTINGS')}${color.textMuted(title.slice('SETTINGS'.length))}`
    return [composeEdge(lead, color.textMuted(right), plan.width)]
  }

  private renderMetadata(plan: SettingsChromePlan): string {
    const row = this.selectedRow()
    const scope = row?.scope ?? 'TUI preferences'
    const captured = new Date(this.snapshot.capturedAt)
    const hh = String(captured.getHours()).padStart(2, '0')
    const mm = String(captured.getMinutes()).padStart(2, '0')
    const text = `Scope: ${scope}  ·  Refreshed ${hh}:${mm} / Config ${this.snapshot.configReadiness.toUpperCase()}`
    return fit(color.textMuted(sanitizedPhysicalLine(text)), plan.width)
  }

  private renderNotice(plan: SettingsChromePlan): string {
    const notice = this.intents.notice()
    if (notice === undefined) return fit('', plan.width)
    const text = sanitizedPhysicalLine(notice.text)
    return fit(notice.kind === 'error' ? color.error(text) : color.textDim(text), plan.width)
  }

  private renderBody(
    plan: SettingsChromePlan,
    bodyTop: number,
    targets: HitTarget[],
    panes: PaneBoxes,
  ): string[] {
    if (plan.layout === 'narrow') return this.renderNarrowBody(plan, bodyTop, targets, panes)
    return this.renderColumnBody(plan, bodyTop, targets, panes)
  }

  private renderColumnBody(
    plan: SettingsChromePlan,
    bodyTop: number,
    targets: HitTarget[],
    panes: PaneBoxes,
  ): string[] {
    const wide = plan.layout === 'wide'
    const categoryWidth = wide ? WIDE_CATEGORY_WIDTH : 0
    const rowsWidth = wide ? WIDE_ROWS_WIDTH : MEDIUM_ROWS_WIDTH
    const rowsX = wide ? categoryWidth + COLUMN_GAP : 0
    const detailX = rowsX + rowsWidth + COLUMN_GAP
    const detailWidth = Math.max(1, plan.width - detailX)
    // The shared pane-header line is a grant of its own: below two body rows it
    // would consume the ONLY body row, so the real content wins and the header
    // is dropped (the Action Bar still names the current pane).
    const showPaneHeader = plan.bodyRows >= 2
    const contentTop = bodyTop + (showPaneHeader ? 1 : 0)
    const contentRows = Math.max(0, plan.bodyRows - (showPaneHeader ? 1 : 0))
    this.paintedViewport = Math.max(1, contentRows)

    const rows = this.currentRows()
    const selectedRowIndex = this.indexOfRow(rows)
    if (selectedRowIndex !== this.lastRowIndex || contentRows !== this.lastRowViewport) {
      this.rowOffset = rebaseOffset(this.rowOffset, selectedRowIndex, rows.length, contentRows)
      this.lastRowIndex = selectedRowIndex
      this.lastRowViewport = contentRows
    } else {
      this.rowOffset = clampOffset(this.rowOffset, rows.length, contentRows)
    }
    if (wide) {
      const selectedCategoryIndex = CATEGORY_ORDER.indexOf(this.categoryId)
      if (selectedCategoryIndex !== this.lastCategoryIndex || contentRows !== this.lastCategoryViewport) {
        this.categoryOffset = rebaseOffset(this.categoryOffset, selectedCategoryIndex, CATEGORY_ORDER.length, contentRows)
        this.lastCategoryIndex = selectedCategoryIndex
        this.lastCategoryViewport = contentRows
      } else {
        this.categoryOffset = clampOffset(this.categoryOffset, CATEGORY_ORDER.length, contentRows)
      }
    }
    const categories = wide
      ? CATEGORY_ORDER.slice(this.categoryOffset, this.categoryOffset + contentRows)
      : []

    const detail = this.detailLines(detailWidth, contentRows)
    const out: string[] = []
    if (showPaneHeader) {
      let head = ''
      if (wide) {
        head += fit(this.paneHeader('CATEGORIES', CATEGORY_ORDER.length, this.focus === 'categories'), categoryWidth)
          + ' '.repeat(COLUMN_GAP)
      }
      head += fit(this.paneHeader('SETTINGS', rows.length, this.focus === 'rows'), rowsWidth) + ' '.repeat(COLUMN_GAP)
      head += fit(this.paneHeader('DETAILS', undefined, this.focus === 'detail'), detailWidth)
      out.push(head)
    }

    // Real item targets precede the pane fallback so a click resolves to the row.
    const itemHits: HitTarget[] = []
    if (wide) {
      panes.categories = {
        x: 0,
        width: categoryWidth,
        contentTop,
        contentRows,
        maxOffset: Math.max(0, CATEGORY_ORDER.length - contentRows),
      }
      for (let i = 0; i < categories.length; i += 1) {
        itemHits.push({ kind: 'category', id: categories[i]!, row: contentTop + i, startCol: 0, endCol: categoryWidth })
      }
    }
    panes.rows = { x: rowsX, width: rowsWidth, contentTop, contentRows, maxOffset: Math.max(0, rows.length - contentRows) }
    for (let i = 0; i < rows.length - this.rowOffset && i < contentRows; i += 1) {
      const row = rows[this.rowOffset + i]
      if (row === undefined) break
      itemHits.push({ kind: 'row', id: row.id, row: contentTop + i, startCol: rowsX, endCol: rowsX + rowsWidth })
    }
    panes.detail = {
      x: detailX,
      width: detailWidth,
      contentTop,
      contentRows,
      maxOffset: Math.max(0, detail.content.length - detail.viewport),
    }
    if (detail.button !== undefined) {
      itemHits.push({
        kind: detail.button.kind,
        id: this.rowId,
        row: contentTop + Math.max(0, contentRows - 1),
        startCol: detailX,
        endCol: detailX + visibleWidth(detail.button.text),
      })
    }
    targets.push(...itemHits)
    // The pane fallback must cover the pane's WHOLE painted area (every content
    // row), so a click anywhere in a column can take that column's focus.
    for (let i = 0; i < contentRows; i += 1) {
      targets.push({ kind: 'pane', id: 'rows', row: contentTop + i, startCol: rowsX, endCol: rowsX + rowsWidth })
      targets.push({ kind: 'pane', id: 'detail', row: contentTop + i, startCol: detailX, endCol: detailX + detailWidth })
      if (wide) targets.push({ kind: 'pane', id: 'categories', row: contentTop + i, startCol: 0, endCol: categoryWidth })
    }

    for (let i = 0; i < contentRows; i += 1) {
      let line = ''
      if (wide) line += fit(this.categoryLine(categories[i]), categoryWidth) + ' '.repeat(COLUMN_GAP)
      line += fit(this.rowLine(rows[this.rowOffset + i]), rowsWidth) + ' '.repeat(COLUMN_GAP)
      line += fit(detail.lines[i] ?? '', detailWidth)
      out.push(line)
    }
    return out
  }

  private renderNarrowBody(
    plan: SettingsChromePlan,
    bodyTop: number,
    targets: HitTarget[],
    panes: PaneBoxes,
  ): string[] {
    const width = plan.width
    const viewport = plan.bodyRows
    this.paintedViewport = Math.max(1, viewport)
    const out: string[] = []
    if (this.focus === 'categories') {
      const selectedIndex = CATEGORY_ORDER.indexOf(this.categoryId)
      if (selectedIndex !== this.lastCategoryIndex || viewport !== this.lastCategoryViewport) {
        this.categoryOffset = rebaseOffset(this.categoryOffset, selectedIndex, CATEGORY_ORDER.length, viewport)
        this.lastCategoryIndex = selectedIndex
        this.lastCategoryViewport = viewport
      } else {
        this.categoryOffset = clampOffset(this.categoryOffset, CATEGORY_ORDER.length, viewport)
      }
      const visible = CATEGORY_ORDER.slice(this.categoryOffset, this.categoryOffset + viewport)
      panes.categories = { x: 0, width, contentTop: bodyTop, contentRows: viewport, maxOffset: Math.max(0, CATEGORY_ORDER.length - viewport) }
      for (let i = 0; i < visible.length; i += 1) {
        const id = visible[i]!
        targets.push({ kind: 'category', id, row: bodyTop + i, startCol: 0, endCol: width })
        out.push(fit(this.categoryLine(id), width))
      }
      return padBody(out, viewport, width)
    }
    if (this.focus === 'rows') {
      const rows = this.currentRows()
      const selectedIndex = this.indexOfRow(rows)
      if (selectedIndex !== this.lastRowIndex || viewport !== this.lastRowViewport) {
        this.rowOffset = rebaseOffset(this.rowOffset, selectedIndex, rows.length, viewport)
        this.lastRowIndex = selectedIndex
        this.lastRowViewport = viewport
      } else {
        this.rowOffset = clampOffset(this.rowOffset, rows.length, viewport)
      }
      const visible = rows.slice(this.rowOffset, this.rowOffset + viewport)
      panes.rows = { x: 0, width, contentTop: bodyTop, contentRows: viewport, maxOffset: Math.max(0, rows.length - viewport) }
      for (let i = 0; i < visible.length; i += 1) {
        const row = visible[i]!
        targets.push({ kind: 'row', id: row.id, row: bodyTop + i, startCol: 0, endCol: width })
        out.push(fit(this.rowLine(row), width))
      }
      return padBody(out, viewport, width)
    }
    const detail = this.detailLines(width, viewport)
    panes.detail = { x: 0, width, contentTop: bodyTop, contentRows: viewport, maxOffset: Math.max(0, detail.content.length - detail.viewport) }
    if (detail.button !== undefined) {
      targets.push({
        kind: detail.button.kind,
        id: this.rowId,
        row: bodyTop + Math.max(0, viewport - 1),
        startCol: 0,
        endCol: visibleWidth(detail.button.text),
      })
    }
    for (let i = 0; i < viewport; i += 1) out.push(fit(detail.lines[i] ?? '', width))
    return out
  }

  private paneHeader(label: string, count: number | undefined, focused: boolean): string {
    const text = count === undefined ? label : `${label} (${count})`
    const marked = focused ? `[${text}]` : text
    return focused ? color.borderFocus(marked) : color.textMuted(marked)
  }

  private categoryLine(id: SettingsWorkspaceCategoryId | undefined): string {
    if (id === undefined) return ''
    const selected = id === this.categoryId
    const marker = selected ? '> ' : '  '
    const text = `${marker}${CATEGORY_LABELS[id]}`
    return selected ? color.textStrong(text) : color.text(text)
  }

  private rowLine(row: SettingsWorkspaceRow | undefined): string {
    if (row === undefined) return ''
    const selected = row.id === this.rowId
    const marker = selected ? '> ' : '  '
    const width = this.paneRowWidth()
    const label = fit(`${marker}${sanitizedPhysicalLine(row.label)}`, width)
    const labelCells = visibleWidth(label)
    // The configured NAME owns its cells first (the frozen hierarchy: the name
    // stays identifiable, the list SUMMARY is what truncates). Only a label that
    // fills the whole pane at all drops the summary.
    const summaryCellRoom = Math.max(0, width - labelCells - 1)
    const value = summaryCellRoom >= 1
      ? truncateToWidth(sanitizedPhysicalLine(row.summary), summaryCellRoom, '…', false)
      : ''
    const gap = Math.max(1, width - labelCells - visibleWidth(value))
    const painted = label + ' '.repeat(gap) + value
    return selected ? color.textStrong(painted) : color.text(painted)
  }

  private paneRowWidth(): number {
    const chrome = this.chrome
    if (chrome === undefined) return MEDIUM_ROWS_WIDTH
    if (chrome.layout === 'wide') return WIDE_ROWS_WIDTH
    if (chrome.layout === 'medium') return MEDIUM_ROWS_WIDTH
    return chrome.width
  }

  /** The detail pane projection: scrollable content plus the pinned action row. */
  private detailLines(width: number, viewport: number): DetailProjection {
    const row = this.selectedRow()
    const includeTitle = this.chrome?.layout !== 'narrow'
    const button = row === undefined
      ? undefined
      : row.value !== undefined
        ? { text: '[Copy value]', kind: 'copy' as const }
        : row.action === 'open-legacy'
          ? { text: '[Open existing settings…]', kind: 'legacy' as const }
          : undefined
    // The pinned button row costs one viewport row when both exist. A viewport
    // too short for it paints NO button, so it must publish no target either.
    const pinned = button !== undefined && viewport >= 2 ? 1 : 0
    const scrollViewport = Math.max(0, viewport - pinned)
    const content = row === undefined ? [] : this.detailContent(row, width, includeTitle)
    const maxOffset = Math.max(0, content.length - scrollViewport)
    this.detailOffset = Math.min(Math.max(0, this.detailOffset), maxOffset)
    const lines: string[] = []
    for (let i = 0; i < scrollViewport; i += 1) lines.push(content[this.detailOffset + i] ?? '')
    if (pinned === 1 && button !== undefined) lines.push(this.detailButtonLine(width, button))
    return { lines, content, viewport: scrollViewport, button: pinned === 1 ? button : undefined }
  }

  private detailContent(row: SettingsWorkspaceRow, width: number, includeTitle: boolean): string[] {
    const labelWidth = width >= 26 ? 12 : 8
    const bodyWidth = Math.max(1, width - labelWidth)
    const lines: string[] = []
    if (includeTitle) lines.push(color.textStrong(sanitizedPhysicalLine(row.label)))
    const field = (label: string, value: string): void => {
      const head = fit(color.textDim(label), labelWidth)
      const wrapped = wrapTextWithAnsi(escapedPhysicalLine(value), bodyWidth)
      const parts = wrapped.length === 0 ? [''] : wrapped
      lines.push(head + parts[0]!)
      for (const extra of parts.slice(1)) lines.push(' '.repeat(labelWidth) + extra)
    }
    field('Value', row.summary)
    if (row.value !== undefined && row.value !== row.summary) field('Source', row.value)
    field('Scope', row.scope)
    field('Freshness', freshnessText(row, this.snapshot.configReadiness))
    field('Description', row.description)
    if (row.freshness === 'read-error' && this.snapshot.readIssue !== undefined) field('Issue', this.snapshot.readIssue)
    return lines
  }

  private detailButtonLine(
    width: number,
    button: { readonly text: string; readonly kind: 'copy' | 'legacy' },
  ): string {
    const paint = button.kind === 'copy'
      ? `${color.accent(button.text)}  ${color.textMuted('Read-only preview · edit using Other settings')}`
      : `${color.accent(button.text)}  ${color.textMuted('opens the existing complete settings editor')}`
    return fit(paint, width)
  }

  private renderActionBar(plan: SettingsChromePlan): string {
    const copyable = this.selectedRow()?.value !== undefined
    // Below the body floor every navigation/clipboard action is refused, so the
    // bar must advertise ONLY the Esc/back semantics it really honours.
    if (this.bodyFloor() < 1) {
      const back = plan.layout === 'narrow'
        ? this.focus === 'detail' ? 'Esc rows' : this.focus === 'rows' ? 'Esc categories' : 'Esc close'
        : 'Esc close'
      return fit(color.textDim(back), plan.width)
    }
    let hints: string
    if (plan.layout === 'wide') {
      // Each focus owner advertises exactly the keys it honours: `C` and `←→
      // category` are inert outside their owner, and Enter inspects (never
      // opens) on the row list.
      hints = this.focus === 'categories'
        ? 'Esc close | Tab next pane | ↑↓ choose | Enter open'
        : this.focus === 'rows'
          ? 'Esc close | Tab next pane | ↑↓ choose | Enter inspect | R refresh'
          : `Esc close | Tab pane | ↑↓/PgDn scroll | ${copyable ? 'C copy value' : 'PgUp/PgDn scroll'}`
    } else if (plan.layout === 'medium') {
      hints = this.focus === 'categories'
        ? 'Esc close | ←→ category | ↑↓ select | Tab pane'
        : this.focus === 'rows'
          ? 'Esc close | Tab pane | ↑↓ select | Enter inspect | R refresh'
          : `Esc close | Tab pane | ↑↓/PgDn scroll | ${copyable ? 'C copy value' : 'PgUp/PgDn scroll'}`
    } else if (this.focus === 'categories') {
      hints = 'Esc close | ↑↓ select | Enter open'
    } else if (this.focus === 'rows') {
      hints = 'Esc categories | ↑↓ select | Enter details'
    } else {
      hints = copyable ? 'Esc rows | ↑↓/Pg keys scroll | C copy value' : 'Esc rows | ↑↓/Pg keys scroll'
    }
    return fit(color.textDim(hints), plan.width)
  }

  // ── state helpers ────────────────────────────────────────────────────────

  private currentRows(): readonly SettingsWorkspaceRow[] {
    return this.snapshot.rows.filter(row => row.category === this.categoryId)
  }

  private firstRowOf(category: SettingsWorkspaceCategoryId): SettingsWorkspaceRowId {
    const rows = this.snapshot.rows.filter(row => row.category === category)
    return rows[0]?.id ?? this.snapshot.rows[0]?.id ?? 'theme'
  }

  private indexOfRow(rows: readonly SettingsWorkspaceRow[]): number {
    const index = rows.findIndex(row => row.id === this.rowId)
    return index < 0 ? 0 : index
  }

  private selectedRow(): SettingsWorkspaceRow | undefined {
    return this.snapshot.rows.find(row => row.id === this.rowId)
  }

  /** Re-read the same authorities; keep the stable selection when it survives. */
  private refresh(): void {
    const next = this.source.readSnapshot()
    this.snapshot = next
    if (next.rows.every(row => row.id !== this.rowId)) this.rowId = this.firstRowOf(this.categoryId)
    this.detailOffset = 0
    this.bumpRevision()
    this.intents.requestRender()
  }

  /** Every navigation/focus/refresh change bumps the state version a pending
   *  press must still match at release. */
  private bumpRevision(): void {
    this.revision += 1
  }

  /** The per-frame body floor at the LIVE terminal height: below it every
   *  navigation/clipboard action is hidden and therefore inert. Only the row
   *  allocation matters here, and that is a pure function of the height (the
   *  width only chooses the projection). */
  private bodyFloor(): number {
    return planSettingsChrome(this.chrome?.width ?? 0, this.intents.rows(), this.intents.notice() !== undefined).bodyRows
  }

  // ── keyboard ─────────────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (this.disposed) return
    if (matchesKey(data, 'escape') || matchesKey(data, 'backspace')) return this.goBack()
    // Below the body floor the frame grants no body row: every navigation and
    // clipboard action is invisible, so only the Esc/back semantics survive
    // (never a hidden action the user cannot see). The floor is computed from
    // the LIVE height — a key may arrive BEFORE the first paint, and reading the
    // last render's plan would then swallow it.
    if (this.bodyFloor() < 1) return
    if (matchesKey(data, 'tab')) return this.cycleFocus(1)
    if (matchesKey(data, 'shift+tab')) return this.cycleFocus(-1)
    if (matchesKey(data, 'up')) return this.move(-1)
    if (matchesKey(data, 'down')) return this.move(1)
    if (matchesKey(data, 'pageUp')) return this.page(-1)
    if (matchesKey(data, 'pageDown')) return this.page(1)
    if (matchesKey(data, 'home')) return this.jump(-1)
    if (matchesKey(data, 'end')) return this.jump(1)
    if (matchesKey(data, 'left')) return this.horizontal(-1)
    if (matchesKey(data, 'right')) return this.horizontal(1)
    if (matchesKey(data, 'enter')) return this.confirm()
    if (data === 'r' || data === 'R') return this.refresh()
    if (data === 'c' || data === 'C') return this.copy()
    // Everything else is inert inside the workspace: no key ever leaks to the
    // hidden editor, transcript or a host composer action.
  }

  private goBack(): void {
    if (this.chrome?.layout === 'narrow') {
      if (this.focus === 'detail') {
        this.focus = 'rows'
        this.bumpRevision()
        this.intents.requestRender()
        return
      }
      if (this.focus === 'rows') {
        this.focus = 'categories'
        this.bumpRevision()
        this.intents.requestRender()
        return
      }
    }
    this.intents.onClose()
  }

  private cycleFocus(direction: 1 | -1): void {
    const index = FOCUS_ORDER.indexOf(this.focus)
    this.focus = FOCUS_ORDER[(index + direction + FOCUS_ORDER.length) % FOCUS_ORDER.length]!
    this.bumpRevision()
    this.intents.requestRender()
  }

  private move(delta: number): void {
    if (this.focus === 'detail') return this.scroll(delta)
    if (this.focus === 'categories') return this.moveCategory(delta)
    this.moveRow(delta)
  }

  private page(delta: number): void {
    const step = this.paintedViewport
    if (this.focus === 'detail') return this.scroll(delta * step)
    if (this.focus === 'categories') return this.moveCategory(delta * step)
    this.moveRow(delta * step)
  }

  private jump(direction: 1 | -1): void {
    if (this.focus === 'detail') {
      this.detailOffset = direction < 0 ? 0 : Number.MAX_SAFE_INTEGER
      this.intents.requestRender()
      return
    }
    if (this.focus === 'categories') {
      this.selectCategory(CATEGORY_ORDER[direction < 0 ? 0 : CATEGORY_ORDER.length - 1]!)
      return
    }
    const rows = this.currentRows()
    if (rows.length === 0) return
    this.selectRow(rows[direction < 0 ? 0 : rows.length - 1]!.id)
  }

  private horizontal(direction: 1 | -1): void {
    if (this.focus !== 'categories') return
    this.moveCategory(direction)
  }

  private moveCategory(delta: number): void {
    const index = CATEGORY_ORDER.indexOf(this.categoryId)
    const next = Math.min(Math.max(0, index + delta), CATEGORY_ORDER.length - 1)
    this.selectCategory(CATEGORY_ORDER[next]!)
  }

  private selectCategory(category: SettingsWorkspaceCategoryId): void {
    if (category !== this.categoryId) {
      this.categoryId = category
      this.rowId = this.firstRowOf(category)
      this.rowOffset = 0
      this.detailOffset = 0
      this.bumpRevision()
    }
    this.intents.requestRender()
  }

  private moveRow(delta: number): void {
    const rows = this.currentRows()
    if (rows.length === 0) return
    const index = this.indexOfRow(rows)
    const next = Math.min(Math.max(0, index + delta), rows.length - 1)
    this.selectRow(rows[next]!.id)
  }

  private selectRow(id: SettingsWorkspaceRowId): void {
    if (id !== this.rowId) {
      this.rowId = id
      this.detailOffset = 0
      this.bumpRevision()
    }
    this.intents.requestRender()
  }

  private scroll(delta: number): void {
    const max = this.paintedPanes.detail?.maxOffset ?? 0
    this.detailOffset = Math.min(Math.max(0, this.detailOffset + delta), max)
    this.intents.requestRender()
  }

  private confirm(): void {
    if (this.focus === 'detail') {
      // A readonly detail is never a save: Enter keeps its documented meaning
      // as navigation only.
      return
    }
    if (this.focus === 'categories') {
      this.focus = 'rows'
      this.bumpRevision()
      this.intents.requestRender()
      return
    }
    const row = this.selectedRow()
    if (row?.action === 'open-legacy') {
      this.intents.onOpenLegacy()
      return
    }
    this.focus = 'detail'
    this.bumpRevision()
    this.intents.requestRender()
  }

  /** The keyboard Copy verb: only the Detail view may copy (a hidden action is
   *  never executed), and the exact source value is the payload. */
  private copy(): void {
    if (this.focus !== 'detail') return
    this.copySelected()
  }

  /** The mouse Copy verb: the painted button IS the action, independent of
   *  which pane owns the keyboard focus. */
  private copySelected(): void {
    const row = this.selectedRow()
    if (row?.value === undefined) return
    this.intents.onCopy(row.value)
  }

  // ── mouse ────────────────────────────────────────────────────────────────

  /** Wheel only: the pane under the pointer scrolls; everything else falls
   *  through to the alt screen's `onCellPress`/`onCellClick` identity path. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed) return undefined
    if (event.type !== 'wheel') return undefined
    const delta = event.wheelDelta ?? 0
    if (delta === 0) return undefined
    const pane = this.paneAt(event.x, event.y)
    if (pane === undefined) return undefined
    if (pane === 'detail') this.scroll(delta)
    else if (pane === 'rows') this.scrollRows(delta)
    else this.scrollCategories(delta)
    return { handled: true }
  }

  onCellPress(x: number, y: number): void {
    if (this.disposed) return
    const target = this.targetAt(x, y)
    this.pressedGesture = target === undefined
      ? undefined
      : { target, revision: this.revision, focus: this.focus, categoryId: this.categoryId }
  }

  onCellClick(x: number, y: number): void {
    if (this.disposed) return
    const pressed = this.pressedGesture
    this.pressedGesture = undefined
    const target = this.targetAt(x, y)
    if (pressed === undefined || target === undefined) return
    // The gesture must still resolve to the SAME painted target AND the same
    // state version/page/category: a refresh, a selection change, a page switch
    // or a category change between press and release refuses the click rather
    // than acting on the newer snapshot.
    if (
      this.revision !== pressed.revision ||
      this.focus !== pressed.focus ||
      this.categoryId !== pressed.categoryId ||
      target.kind !== pressed.target.kind ||
      target.id !== pressed.target.id ||
      target.row !== pressed.target.row ||
      target.startCol !== pressed.target.startCol ||
      target.endCol !== pressed.target.endCol
    ) {
      return
    }
    this.activate(target)
  }

  private activate(target: HitTarget): void {
    switch (target.kind) {
      case 'category':
        this.selectCategory(target.id as SettingsWorkspaceCategoryId)
        // A real item click takes ITS column's keyboard focus (the §5
        // "click the corresponding column" contract); in the narrow
        // single-column projection the same click is the drill-down gesture
        // (the same step as Enter).
        this.takeColumnFocus(this.chrome?.layout === 'narrow' ? 'rows' : 'categories')
        return
      case 'row': {
        this.selectRow(target.id as SettingsWorkspaceRowId)
        // The row's `open-legacy` action is the ONE navigation verb (never an
        // edit); in narrow the click continues into the Detail level, while
        // wide/medium keep the row list as the keyboard owner.
        if (this.selectedRow()?.action === 'open-legacy') {
          this.intents.onOpenLegacy()
          return
        }
        this.takeColumnFocus(this.chrome?.layout === 'narrow' ? 'detail' : 'rows')
        return
      }
      case 'copy':
        this.takeColumnFocus('detail')
        this.copySelected()
        return
      case 'legacy':
        this.takeColumnFocus('detail')
        this.intents.onOpenLegacy()
        return
      case 'category-prev':
        // The header arrows ARE the medium category control: like every other
        // real item, they take their column's keyboard focus before acting.
        this.takeColumnFocus('categories')
        this.moveCategory(-1)
        return
      case 'category-next':
        this.takeColumnFocus('categories')
        this.moveCategory(1)
        return
      case 'pane':
        this.takeColumnFocus(target.id as SettingsWorkspacePage)
        return
    }
  }

  /** Make one column the keyboard owner (no-op when it already is). */
  private takeColumnFocus(page: SettingsWorkspacePage): void {
    if (this.focus === page) return
    this.focus = page
    this.bumpRevision()
    this.intents.requestRender()
  }

  private scrollRows(delta: number): void {
    const pane = this.paintedPanes.rows
    if (pane === undefined) return
    this.rowOffset = Math.min(Math.max(0, this.rowOffset + delta), pane.maxOffset)
    this.intents.requestRender()
  }

  private scrollCategories(delta: number): void {
    const pane = this.paintedPanes.categories
    if (pane === undefined) return
    this.categoryOffset = Math.min(Math.max(0, this.categoryOffset + delta), pane.maxOffset)
    this.intents.requestRender()
  }

  private paneAt(x: number, y: number): SettingsWorkspacePage | undefined {
    const panes = this.paintedPanes
    const hit = (pane: PaneBox | undefined): boolean =>
      pane !== undefined && y >= pane.contentTop && y < pane.contentTop + pane.contentRows && x >= pane.x && x < pane.x + pane.width
    if (hit(panes.detail)) return 'detail'
    if (hit(panes.rows)) return 'rows'
    if (hit(panes.categories)) return 'categories'
    return undefined
  }

  private targetAt(x: number, y: number): HitTarget | undefined {
    return this.paintedTargets.find(target => target.row === y && x >= target.startCol && x < target.endCol)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pressedGesture = undefined
    this.paintedTargets = []
    this.paintedPanes = {}
  }
}

/** Compose a themed left region and a themed right region on one row. */
function composeEdge(left: string, right: string, width: number): string {
  if (width <= 0) return ''
  const rightWidth = visibleWidth(right)
  if (rightWidth === 0) return fit(left, width)
  if (rightWidth + 2 > width) return fit(left, width)
  const room = width - rightWidth - 1
  const lead = truncateToWidth(left, room, '…', false)
  const gap = width - visibleWidth(lead) - rightWidth
  return lead + ' '.repeat(Math.max(1, gap)) + right
}
