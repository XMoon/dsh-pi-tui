/**
 * The Work Details Reader's ONE pure document projection (PR4 B3-A2).
 *
 * A Reader is a read-only `mode:'screen'` page presented by the same Tern pane
 * as the resident inline surface. This module only turns ONE
 * `TaskPanelItem` — the current, already-authorized Work Hub row — into the
 * native node tree of that page. It owns no state, opens no surface, reads no
 * source and calls no business operation: the renderer (`tsp/session.ts`)
 * owns the temporary Surface, its identity and its lifecycle.
 *
 * The document is deliberately plain: a `← Work` navigation row, the full
 * wrapped label, one derived description, the durable facts that actually
 * exist on the row, an optional details body and real timestamps. There is NO
 * fabricated activity stream, Job output, transcript, status timeline or
 * Stop/Interrupt/Answer control, and the stable row id (`item.value`) is
 * identity — never regenerated from display text.
 *
 * Untrusted text is projected through the SAME display sanitizer as every
 * other terminal-bound surface; no raw escape/OSC bytes reach the wire.
 *
 * @module @xmoon76/dsh-pi-tui/tui/tsp/work-details
 */

import { span, ui, type Node } from '@stencil-hq/tern'
import type { TaskPanelItem } from '../../app/surface/task-presentation.ts'
import { sanitizeDisplayText } from '../presentation/terminal-text.ts'

/**
 * One Reader reading's presentation identity: the Work Hub panel that opened
 * it, the ephemeral reading epoch and the stable row value it reads. It is NOT
 * a Session generation and never outlives the temporary Screen.
 */
export interface WorkDetailsIdentity {
  readonly panelSerial: number
  readonly readingEpoch: number
  readonly targetValue: string
}

/** The one region a Reader renders its read-only document into. */
export const WORK_DETAILS_REGION = 'main'

/**
 * The key of the Reader's ONE interactive node (the native navigation row the
 * renderer resolves to its actual node id). Stable for the whole reading.
 */
export function workDetailsBackKey(identity: WorkDetailsIdentity): string {
  return `work-back-${identity.panelSerial}-${identity.readingEpoch}`
}

/** The document root key: stable for the whole reading instance. */
function documentKey(identity: WorkDetailsIdentity): string {
  return `work-document-${identity.panelSerial}-${identity.readingEpoch}`
}

/**
 * The description's leading word. It states the row's OWN classification: a
 * Question is never work, and an external leaf is never presented as a local
 * child Session.
 */
function sourceWord(item: TaskPanelItem): string {
  if (item.source === 'question') return 'Question'
  if (item.source === 'job') return 'Job'
  if (item.mode === 'external') return 'External'
  if (item.source === 'subagent') return 'Subagent'
  return 'Work'
}

/** The one derived description: classification + the row's own status word. */
function descriptionText(item: TaskPanelItem): string {
  const word = sourceWord(item)
  return item.status === '' || item.status === word ? word : `${word} · ${item.status}`
}

/**
 * The largest time value a JS Date can represent (±8.64e15 ms). A value
 * outside it is not displayable, so the field is omitted instead of fabricated.
 */
const DISPLAY_TIME_LIMIT = 8.64e15

/** One real finite millisecond timestamp as UTC ISO 8601, or none. */
function isoTime(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || Math.abs(value) > DISPLAY_TIME_LIMIT) return undefined
  return new Date(value).toISOString()
}

/** One labeled fact line: a muted label and its (wrapped) sanitized value. */
function factNode(key: string, label: string, value: string): Node {
  return ui.text(
    { key, wrap: 'word' },
    [span(label.padEnd(10), 'muted'), sanitizeDisplayText(value)],
  )
}

/**
 * Build the complete read-only Reader document for ONE current row.
 *
 * `onBack` is bound by the Screen owner to the captured reading identity; this
 * builder holds no mutable state and never decides whether the reader may
 * close. Every key is stable for the reading instance and never embeds a
 * revision, selection, row count, width or query.
 */
export function buildWorkDetails(
  item: TaskPanelItem,
  identity: WorkDetailsIdentity,
  onBack: () => void,
): Node {
  const started = isoTime(item.startedAt)
  const finished = isoTime(item.finishedAt)
  const detail = item.detail === undefined || item.detail === '' ? undefined : sanitizeDisplayText(item.detail)
  const parent = item.parentLabel ?? item.parentId
  return ui.col(
    { key: documentKey(identity), gap: 'xs' },
    ui.row(
      { key: workDetailsBackKey(identity), onClick: onBack },
      ui.text(span('← Work', 'accent')),
    ),
    ui.text({ key: 'work-label', wrap: 'word' }, span(sanitizeDisplayText(item.label), 'strong')),
    ui.text({ key: 'work-description', wrap: 'word' }, span(sanitizeDisplayText(descriptionText(item)), 'muted')),
    // The stable row id is IDENTITY: the raw value, projected for display only.
    factNode('work-fact-stable-id', 'Stable ID', item.value),
    ...(item.type === undefined || item.type === '' ? [] : [factNode('work-fact-type', 'Type', item.type)]),
    ...(item.mode === undefined || item.mode === '' ? [] : [factNode('work-fact-mode', 'Mode', item.mode)]),
    ...(item.access === undefined || item.access === '' ? [] : [factNode('work-fact-access', 'Access', item.access)]),
    ...(parent === undefined || parent === '' ? [] : [factNode('work-fact-parent', 'Parent', parent)]),
    ...(item.depth === undefined ? [] : [factNode('work-fact-depth', 'Depth', String(item.depth))]),
    ...(detail === undefined
      ? []
      : [
          ui.text({ key: 'work-detail-label' }, span('Details', 'muted')),
          ui.text({ key: 'work-detail', wrap: 'word' }, detail),
        ]),
    ...(started === undefined ? [] : [factNode('work-fact-started', 'Started', started)]),
    ...(finished === undefined ? [] : [factNode('work-fact-finished', 'Finished', finished)]),
  )
}
