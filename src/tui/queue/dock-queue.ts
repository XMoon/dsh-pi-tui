/**
 * The clickable Dock Queue pane (PR-Q).
 *
 * It replaces the historical plain `Text` queue pane with the SAME row budget
 * and the same pinned-chrome position, and adds exactly the navigation
 * affordance the frozen product allows:
 * - a compact ` Queue · N` header whose right-aligned `Manage [Key]` is a real
 *   click target (the key text is the LIVE effective `app.queue.open` binding,
 *   never a hard-coded chord);
 * - one clickable row per queued message: an authoritative Host row carries its
 *   occurrence id as the overlay's preselection hint, a client-local
 *   `sending…` echo opens the manager WITHOUT an id (it has no Host occurrence).
 *
 * The pane performs NO queue mutation, owns no editor and no delete: every
 * actual edit/remove happens inside the Wide Overlay after explicit
 * confirmation. The hit map is built from the LAST render, and a click only
 * acts on the exact identity the press resolved, so a repaint between press and
 * release (a new pending presentation) can never retarget the click.
 *
 * Pointer availability: PiTui enables terminal mouse reporting on the
 * fullscreen alt screen alone. In the regular main screen this component paints
 * the same rows and receives no pointer events at all — `Alt+I` and `/queue`
 * are the keyboard entries there.
 *
 * @module @xmoon76/dsh-pi-tui/tui/queue/dock-queue
 */

import type { Component, TuiMouseDispatchResult, TuiMouseEvent, TuiMouseEventResult } from '@xmoon76/pi-tui'
import { truncateToWidth, visibleWidth } from '@xmoon76/pi-tui'
import { color } from '../theme/runtime.ts'

/** One queued row this pane paints. */
export interface DockQueueRow {
  /** The Host occurrence id, or undefined for a client-local echo. */
  readonly id?: string
  readonly text: string
  readonly local: boolean
}

/** The live facts one Queue pane paint consumes. */
export interface DockQueueModel {
  readonly rows: readonly DockQueueRow[]
  readonly running: boolean
  /** The effective steer/recall hints ('' when the binding is disabled). */
  readonly steerKey: string
  readonly recallKey: string
  /** The effective `app.queue.open` primary key ('' when disabled/unbound). */
  readonly manageKey: string
  /** A subagent viewer hides the bulk recall hint (the parent queue is not editable). */
  readonly viewer: boolean
}

/** The pane's ONE open intent. */
export interface DockQueueCallbacks {
  /** Open the manager; `itemId` is a Host occurrence preselection hint. */
  open(itemId?: string): void
}

/** One last-painted hit region. */
type DockQueueHit =
  | { readonly kind: 'manage' }
  | { readonly kind: 'row'; readonly id?: string }
  | { readonly kind: 'inert' }

/** One press-time identity (the exact target a release may activate). */
interface DockQueuePress {
  readonly hit: DockQueueHit
  readonly width: number
}

const EMPTY_MODEL: DockQueueModel = {
  rows: [],
  running: false,
  steerKey: '',
  recallKey: '',
  manageKey: '',
  viewer: false,
}

export class DockQueue implements Component {
  private model: DockQueueModel = EMPTY_MODEL
  private readonly callbacks: DockQueueCallbacks
  private hits: DockQueueHit[] = []
  private lastRenderWidth = -1
  private pressed: DockQueuePress | undefined

  constructor(callbacks: DockQueueCallbacks) {
    this.callbacks = callbacks
  }

  /** Replace the painted model. The caller repaints (the pane keeps no cache). */
  setModel(model: DockQueueModel): void {
    this.model = model
    this.pressed = undefined
  }

  invalidate(): void {}

  /** Whether the pane currently paints any row (the pinned chrome height). */
  hasRows(): boolean {
    return this.model.rows.length > 0
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width))
    this.lastRenderWidth = safeWidth
    this.hits = []
    const rows = this.model.rows
    if (rows.length === 0) return []
    const lines: string[] = []
    lines.push(this.headerLine(safeWidth))
    this.hits.push(this.lastHeaderHit)
    for (const row of rows) {
      const text = sanitizeRowText(row.text)
      const prefix = '❯ '
      const suffix = row.local ? ' sending…' : ''
      const prefixWidth = visibleWidth(prefix)
      const suffixWidth = visibleWidth(suffix)
      const suffixFits = prefixWidth + suffixWidth + 1 <= safeWidth
      const available = Math.max(1, safeWidth - prefixWidth - (suffixFits ? suffixWidth : 0))
      const truncated = truncateToWidth(text, available, '…')
      lines.push(`${color.roleUser('❯')} ${truncated}${color.textDim(suffixFits ? suffix : '')}`)
      this.hits.push(row.local ? { kind: 'row' } : { kind: 'row', id: row.id })
    }
    // The bulk steer/recall hint addresses authoritative rows only; a pane
    // holding only local echoes keeps its `sending…` state and advertises no
    // no-op gesture (the historical pane rule).
    const hasLocalRows = rows.some(row => row.local)
    if (rows.some(row => !row.local)) {
      const scope = hasLocalRows ? 'accepted' : 'all'
      const steerHint = this.model.running
        ? `${this.model.steerKey === '' ? 'the steer key' : this.model.steerKey.toLowerCase()} to steer ${scope}`
        : 'waiting for the next prompt — send a message to continue'
      const hint = this.model.viewer
        ? steerHint
        : `${steerHint} · ${this.model.recallKey === '' ? 'the recall key' : this.model.recallKey.toLowerCase()} to recall ${scope}`
      lines.push(color.textDim(truncateToWidth(`  ${hint}`, Math.max(1, safeWidth - 2), '…')))
      this.hits.push({ kind: 'inert' })
    }
    return lines
  }

  handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | TuiMouseEventResult | undefined {
    if (event.type !== 'press' && event.type !== 'click' && event.type !== 'release') return undefined
    if (event.type === 'release') {
      this.pressed = undefined
      return undefined
    }
    if (event.button !== 'left') return undefined
    if (event.width !== this.lastRenderWidth) return undefined
    const hit = this.hits[event.y]
    if (hit === undefined || hit.kind === 'inert') return undefined
    if (event.type === 'press') {
      this.pressed = { hit, width: event.width }
      return { handled: true }
    }
    // click: the release may only activate the EXACT target the press resolved
    // in the EXACT painted geometry — a repaint between them clears the latch.
    const pressed = this.pressed
    this.pressed = undefined
    if (pressed === undefined || pressed.width !== event.width) return undefined
    if (pressed.hit.kind !== hit.kind) return undefined
    if (pressed.hit.kind === 'row' && hit.kind === 'row') {
      if (pressed.hit.id !== hit.id) return undefined
      this.callbacks.open(hit.id)
      return { handled: true }
    }
    if (hit.kind === 'manage') {
      this.callbacks.open()
      return { handled: true }
    }
    return undefined
  }

  /** The header paint result (also the manage hit region of this frame). */
  private lastHeaderHit: DockQueueHit = { kind: 'inert' }

  private headerLine(width: number): string {
    const count = this.model.rows.filter(row => !row.local).length
    const left = ` Queue · ${count}`
    const right = this.model.manageKey === '' ? 'Manage' : `Manage [${this.model.manageKey}]`
    const leftWidth = visibleWidth(left)
    const rightWidth = visibleWidth(right)
    if (rightWidth > width) {
      // Ultra-narrow: the clickable Manage affordance is the only survivor.
      this.lastHeaderHit = { kind: 'manage' }
      return color.primary(truncateToWidth(right, width, '…'))
    }
    if (leftWidth + 1 + rightWidth <= width) {
      this.lastHeaderHit = { kind: 'manage' }
      const gap = width - leftWidth - rightWidth
      return color.textStrong(left) + ' '.repeat(gap) + color.primary(right)
    }
    // The count yields first and whole; the title is truncated only when it
    // cannot share the row with the manage affordance.
    this.lastHeaderHit = { kind: 'manage' }
    const title = truncateToWidth('Queue', Math.max(1, width - rightWidth - 1), '')
    const gap = Math.max(1, width - visibleWidth(title) - rightWidth)
    return color.textStrong(title) + ' '.repeat(gap) + color.primary(right)
  }
}

/** The pane's historical single-line display projection. */
function sanitizeRowText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}
