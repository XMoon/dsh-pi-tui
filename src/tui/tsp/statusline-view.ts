/**
 * TSP-7 PR-A: the native statusline projection — the TSP renderer's two
 * read-only `ui.status` rows built from the ONE committed `StatusSnapshot`.
 *
 * This module is a PURE projection: no IO, no timers, no filesystem, no
 * SDK session, no store access. It reads the existing builtin footer item
 * definitions (`createBuiltinFooterRegistry()`) and maps their already-
 * sanitized `FooterSegment.spans` text onto `ui.seg` nodes — it never
 * re-implements a token/context/permission formatter and never parses the
 * ANSI output of `FooterComposer.render()`.
 *
 * The item set, formats, keys, sides and priorities are the frozen PR-A
 * minimum (see the PR-A plan §1.2). Every item omits itself when its fact is
 * absent, and a row with no segment produces no `status` node at all — the
 * dock never shows a blank native status line.
 * @module @xmoon76/dsh-pi-tui/tui/tsp/statusline-view
 */

import { ui } from '@stencil-hq/tern'
import type { Node, Tone } from '@stencil-hq/tern'
import type { StatusSnapshot } from '../../domain/status/types.ts'
import { createBuiltinFooterRegistry } from '../footer/builtin-items.ts'
import type { FooterItemDefinition, FooterRenderContext, FooterTone } from '../footer/presentation-types.ts'

/**
 * The immutable builtin-only registry. It is created ONCE at module load: a
 * fresh registry per render would re-register every definition on every
 * frame, and no external/custom source is ever attached (PR-A renders six
 * fixed builtin items; the persisted footer configuration is PR-D).
 */
const registry = createBuiltinFooterRegistry()

/**
 * The fixed render context of the six PR-A items: none of them reads the task
 * browser gate or the extension footer text.
 */
const NO_SURFACE_HINTS: FooterRenderContext = { taskBrowserAvailable: false, extensionFooterText: '' }

/** The PR-A priority numbers (Tern drops the smallest first, per row). */
const PRIORITY = {
  permission: 95,
  cwd: 50,
  git: 30,
  plan: 100,
  tokens: 60,
  context: 100,
} as const

/** One PR-A status item: its builtin id, its format, and its native shape. */
interface StatuslineItem {
  readonly id: string
  readonly format: string
  readonly key: string
  readonly icon?: 'shield' | 'folder' | 'git-branch' | 'plan' | 'tokens' | 'context'
  readonly side?: 'right'
  readonly priority: number
}

/**
 * Row 1 (the working environment): permission, cwd, git branch on the LEFT,
 * the plan state on the RIGHT.
 */
const ROW_ONE: readonly StatuslineItem[] = [
  { id: 'permission-preset', format: 'compact', key: 'status-r1-permission', icon: 'shield', priority: PRIORITY.permission },
  { id: 'cwd', format: 'basename', key: 'status-r1-cwd', icon: 'folder', priority: PRIORITY.cwd },
  { id: 'git-branch', format: 'plain', key: 'status-r1-git', icon: 'git-branch', priority: PRIORITY.git },
  { id: 'plan-state', format: 'plain', key: 'status-r1-plan', icon: 'plan', side: 'right', priority: PRIORITY.plan },
]

/** Row 2 (the statistics): token usage on the LEFT, context pressure RIGHT. */
const ROW_TWO: readonly StatuslineItem[] = [
  { id: 'token-usage', format: 'pi', key: 'status-r2-tokens', icon: 'tokens', priority: PRIORITY.tokens },
  { id: 'context', format: 'percent', key: 'status-r2-context', icon: 'context', side: 'right', priority: PRIORITY.context },
]

/** Resolve one builtin definition; an unknown id is an internal contract break. */
function definition(id: string): FooterItemDefinition {
  const def = registry.get(id)
  if (def === undefined) throw new Error(`missing builtin status item: ${id}`)
  return def
}

/**
 * Project one builtin segment's SEMANTIC tone onto the native one.
 *
 * Only the severity/muted family has a portable meaning in Tern: the PiTui
 * palette tones (`text`, `textStrong`, `border`, `primary`, `roleUser`,
 * `shellMode`) are terminal-theme tokens with no negotiated Tern counterpart,
 * so they stay unset and the client's own text styling applies. The tones that
 * DO carry a claim about the fact — a dangerous permission preset, a failure, a
 * success, a de-emphasized value — are forwarded verbatim, because dropping
 * them would let the client paint "yolo" exactly like "read-only".
 *
 * Colour is never the only carrier: the builtin's own text is always present.
 */
function nativeTone(tone: FooterTone | undefined): Tone | undefined {
  switch (tone) {
    case 'warning': return 'warning'
    case 'error': return 'error'
    case 'success': return 'success'
    case 'accent': return 'accent'
    case 'textMuted':
    case 'textDim': return 'muted'
    default: return undefined
  }
}

/**
 * Render one PR-A item through its existing builtin formatter and return the
 * safe plain text plus the semantic tone, or `undefined` when the item has no
 * value to show.
 */
function itemText(snapshot: StatusSnapshot, item: StatuslineItem): { text: string; tone: Tone | undefined } | undefined {
  const segment = definition(item.id).render(
    snapshot,
    { id: item.id, format: item.format },
    'preferred',
    NO_SURFACE_HINTS,
  )
  if (segment === null) return undefined
  const text = segment.spans.map(span => span.text).join('')
  if (text === '') return undefined
  // The item's own semantic tone wins; a segment whose spans disagree keeps the
  // FIRST stated tone (these six builtins emit a single tone per segment, so a
  // disagreement would be a formatter change this projection must not invent
  // precedence for).
  const tone = nativeTone(segment.spans.find(span => span.tone !== undefined)?.tone)
  return { text, tone }
}

/** Build one row's `ui.seg` children (an absent item contributes nothing). */
function rowSegments(snapshot: StatusSnapshot, items: readonly StatuslineItem[]): Node[] {
  const segments: Node[] = []
  for (const item of items) {
    const rendered = itemText(snapshot, item)
    if (rendered === undefined) continue
    segments.push(ui.seg({
      key: item.key,
      text: rendered.text,
      ...(item.icon === undefined ? {} : { icon: item.icon }),
      ...(rendered.tone === undefined ? {} : { tone: rendered.tone }),
      ...(item.side === undefined ? {} : { side: item.side }),
      priority: item.priority,
    }))
  }
  return segments
}

/**
 * The two PR-A native status rows for one committed snapshot, in the frozen
 * order (row 1 then row 2). A row without a single present item contributes
 * no node, so the dock never paints an empty status line.
 */
export function nativeStatuslineRows(snapshot: StatusSnapshot): readonly Node[] {
  const rows: Node[] = []
  const rowOne = rowSegments(snapshot, ROW_ONE)
  if (rowOne.length > 0) rows.push(ui.status({ key: 'status-row-1' }, ...rowOne))
  const rowTwo = rowSegments(snapshot, ROW_TWO)
  if (rowTwo.length > 0) rows.push(ui.status({ key: 'status-row-2' }, ...rowTwo))
  return rows
}
