/**
 * TSP-7 PR-A/PR-B/PR-D: the native statusline projection — the TSP renderer's
 * read-only `ui.status` rows built from the ONE committed `StatusSnapshot`.
 *
 * This module is a PURE projection: no IO, no timers, no filesystem, no
 * SDK session, no store access. It reads the existing builtin footer item
 * definitions (`createBuiltinFooterRegistry()`) and maps their already-
 * sanitized `FooterSegment.spans` text onto `ui.seg` nodes — it never
 * re-implements a token/context/permission formatter and never parses the
 * ANSI output of `FooterComposer.render()`.
 *
 * Modes (PR-D):
 * - `default` — the frozen PR-A/PR-B two-row shape (byte-for-byte the same
 *   item set/keys/priorities; PR-D must not change it).
 * - `compact` — the plan's OWN fixed single native row (NOT the PiTui
 *   `COMPACT_FOOTER_LAYOUT`): permission, cwd, git, run on the left; plan,
 *   the attention badge and the context pressure on the right, with the
 *   right-side facts above the environment ones so a narrow pane keeps them.
 * - `custom` — the validated `FooterLayoutV1` placements, each rendered by
 *   its OWN registry definition at `preferred` density; unsupported refs
 *   (USER command items, extension items, unknown ids) keep their placement
 *   with a visible `Unavailable` marker — they are never silently dropped.
 *
 * Every item omits itself when its fact is absent, and a row with no segment
 * produces no `status` node at all — the dock never shows a blank native
 * status line.
 * @module @xmoon76/dsh-pi-tui/tui/tsp/statusline-view
 */

import { ui } from '@stencil-hq/tern'
import type { Node, Tone } from '@stencil-hq/tern'
import type { StatusSnapshot } from '../../domain/status/types.ts'
import { createBuiltinFooterRegistry } from '../footer/builtin-items.ts'
import { FooterCustomItemCatalog } from '../footer/custom-item-catalog.ts'
import type { FooterItemDefinition, FooterRenderContext } from '../footer/presentation-types.ts'
import type { FooterItemRef, FooterLayoutV1, FooterTone } from '../footer/presentation-types.ts'
import type { FooterItemRegistry } from '../footer/item-registry.ts'
import { customItemName, CUSTOM_FOOTER_ITEM_PREFIX } from '../../domain/footer/custom-items.ts'
import type { TspNativeFooterConfig } from '../../domain/footer/tsp-native-config.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { clampMiddle } from './picker-text.ts'
import { TSP_FOOTER_NOTICES } from '../../domain/footer/tsp-native-config.ts'

/**
 * The immutable builtin-only lookup for the FROZEN default/compact presets
 * (PR-A/PR-B). It is created ONCE at module load: those two presets render a
 * fixed builtin item set with no custom source ever attached, so a shared
 * immutable registry is their single source. The CONFIGURED `custom`
 * projection deliberately does NOT use it — every mount compiles its own
 * registry with the USER catalog attached (see compileNativeFooterPresentation).
 */
const BUILTIN_PRESET_REGISTRY = createBuiltinFooterRegistry()

/**
 * The fixed render context of the six PR-A items: none of them reads the task
 * browser gate or the extension footer text.
 */
const NO_SURFACE_HINTS: FooterRenderContext = { taskBrowserAvailable: false, extensionFooterText: '' }

/** The PR-A + PR-B priority numbers (Tern drops the smallest first, PER ROW). */
const PRIORITY = {
  /** PR-B: the attention badge — the highest row-1 claim (a failure or a
   * blocked human wait outranks every environment fact). */
  attention: 110,
  permission: 95,
  cwd: 50,
  git: 30,
  plan: 100,
  /** PR-B: the machine run phase — above the environment items, below attention. */
  run: 105,
  tokens: 60,
  context: 100,
  /** PR-B: the cache share. */
  cache: 35,
  /** PR-B: the recent (R5) / whole-session (All) output rate. */
  speed: 45,
  /** PR-B: the time-to-first-token — the first statistic Tern may drop. */
  ttfb: 25,
} as const

/** One status item: its builtin id, its format, its density and its native shape. */
interface StatuslineItem {
  readonly id: string
  readonly format: string
  readonly key: string
  readonly icon?: 'shield' | 'folder' | 'git-branch' | 'plan' | 'tokens' | 'context' | 'run' | 'tasks' | 'cache' | 'gauge' | 'timer'
  readonly side?: 'right'
  readonly priority: number
  /**
   * PR-B: the density the item renders at. `run-state` and `tasks` are fixed to
   * `compact` so the attention badge and the phase word survive a narrower pane;
   * every other item keeps the builtin's `preferred` form.
   */
  readonly density?: 'compact'
}

/**
 * Row 1 (the working environment + the run state / attention): permission, cwd,
 * git branch, run state on the LEFT, the plan state and the attention badge on
 * the RIGHT.
 */
const ROW_ONE: readonly StatuslineItem[] = [
  { id: 'permission-preset', format: 'compact', key: 'status-r1-permission', icon: 'shield', priority: PRIORITY.permission },
  { id: 'cwd', format: 'basename', key: 'status-r1-cwd', icon: 'folder', priority: PRIORITY.cwd },
  { id: 'git-branch', format: 'plain', key: 'status-r1-git', icon: 'git-branch', priority: PRIORITY.git },
  // PR-B: the run phase. An idle subject renders nothing (the builtin omits it),
  // so a quiet session never shows a useless `idle` word.
  { id: 'run-state', format: 'plain', key: 'status-r1-run', icon: 'run', density: 'compact', priority: PRIORITY.run },
  { id: 'plan-state', format: 'plain', key: 'status-r1-plan', icon: 'plan', side: 'right', priority: PRIORITY.plan },
  // PR-B: the ONE attention badge — the GLOBAL job/agent totals, the failure
  // marker and the parked-Question count in the builtin's own compact form. It
  // omits itself when no fact exists, so no empty `[]` badge is ever painted.
  { id: 'tasks', format: 'badge', key: 'status-r1-attention', icon: 'tasks', side: 'right', density: 'compact', priority: PRIORITY.attention },
]

/** Row 2 (the statistics): tokens, cache, TTFB and the rate on the LEFT, the
 *  context pressure on the RIGHT. Every item omits itself when its fact is
 *  absent, so a missing sample never paints a fabricated zero. */
const ROW_TWO: readonly StatuslineItem[] = [
  { id: 'token-usage', format: 'pi', key: 'status-r2-tokens', icon: 'tokens', priority: PRIORITY.tokens },
  { id: 'cache-hit', format: 'pi', key: 'status-r2-cache', icon: 'cache', priority: PRIORITY.cache },
  { id: 'performance', format: 'latency', key: 'status-r2-ttfb', icon: 'timer', priority: PRIORITY.ttfb },
  { id: 'performance', format: 'speed-both', key: 'status-r2-speed', icon: 'gauge', priority: PRIORITY.speed },
  { id: 'context', format: 'percent', key: 'status-r2-context', icon: 'context', side: 'right', priority: PRIORITY.context },
]

/**
 * PR-D: the TSP compact preset — ONE native row, in the plan's fixed segment
 * order (§2.2). It is deliberately NOT the PiTui `COMPACT_FOOTER_LAYOUT`: no
 * Model (the Composer owns it), no stats row, and the right-side attention
 * and context facts sit ABOVE the left environment ones so a narrow pane that
 * drops by priority keeps them (`tasks` 110 > run 105 > context 109 > plan
 * 100 > permission 95 > cwd 50 > git 30).
 */
const COMPACT_ROW: readonly StatuslineItem[] = [
  { id: 'permission-preset', format: 'compact', key: 'status-r1-permission', icon: 'shield', priority: 95 },
  { id: 'cwd', format: 'basename', key: 'status-r1-cwd', icon: 'folder', priority: 50 },
  { id: 'git-branch', format: 'plain', key: 'status-r1-git', icon: 'git-branch', priority: 30 },
  { id: 'run-state', format: 'plain', key: 'status-r1-run', icon: 'run', density: 'compact', priority: 105 },
  { id: 'plan-state', format: 'plain', key: 'status-r1-plan', icon: 'plan', side: 'right', priority: 100 },
  { id: 'tasks', format: 'badge', key: 'status-r1-attention', icon: 'tasks', side: 'right', density: 'compact', priority: 110 },
  { id: 'context', format: 'percent', key: 'status-r1-context', icon: 'context', side: 'right', priority: 109 },
]

/** Resolve one builtin definition; an unknown id is an internal contract break. */
function definition(id: string): FooterItemDefinition {
  const def = BUILTIN_PRESET_REGISTRY.get(id)
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
    // PR-B: `run-state`/`tasks` render COMPACT so the phase word and the
    // attention badge survive a narrower pane (the plan's explicit choice — it
    // is a density hint, never a second layout engine).
    item.density ?? 'preferred',
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

// ── PR-D: the configured native presentation ───────────────────────────────

/**
 * The compiled per-mount presentation of one `TspNativeFooterConfig`: the
 * mode, the validated layout (custom only) and the ONE registry carrying the
 * builtin definitions plus the USER text definitions (a mount-local
 * `createBuiltinFooterRegistry()` with the USER catalog attached as its
 * custom source — the plan §3.3 single-registry ownership). It is built once
 * per TSP mount and never rebuilt per frame.
 */
export interface NativeFooterPresentation {
  readonly mode: 'default' | 'compact' | 'custom'
  readonly layout: FooterLayoutV1 | undefined
  /** The ONE mount-local registry: builtins with the USER catalog attached. */
  readonly registry: FooterItemRegistry
  /** The USER-layer command definition ids (rendered unavailable). */
  readonly userCommandIds: ReadonlySet<string>
  /**
   * The notices this mount enqueues at bind time: the resolver's own plus the
   * renderer-decided unavailable-items notice (a registry fact).
   */
  readonly notices: readonly string[]
}

/**
 * Compile one boot-time footer config into the renderer's immutable
 * presentation. The layout and the item classification were already decided
 * by the domain resolver; this step builds the ONE mount-local registry —
 * a fresh `createBuiltinFooterRegistry()` with the USER text catalog attached
 * through `setCustomSource` (never the module-level builtin-only lookup, and
 * never a second per-frame rebuild).
 *
 * The returned notices are the renderer-owned ones the resolver could not
 * decide (the domain must not carry a second builtin id list): whether a
 * custom layout actually references an item with no renderable definition —
 * a USER command item, an extension item or an unknown id — is a REGISTRY
 * fact, decided here against the real definitions.
 */
export function compileNativeFooterPresentation(config: TspNativeFooterConfig): NativeFooterPresentation {
  const notices = [...config.notices]
  const registry = createBuiltinFooterRegistry()
  const catalog = new FooterCustomItemCatalog(config.userTextItems)
  registry.setCustomSource(catalog)
  if (config.mode === 'custom' && config.layout !== undefined) {
    let unsupported = false
    for (const row of config.layout.rows) {
      for (const ref of [...row.left, ...row.right]) {
        if (ref.id === 'view-scope') continue // the retired inert builtin
        if (isExtensionId(ref.id)) { unsupported = true; continue }
        if (registry.get(ref.id) === undefined) unsupported = true
      }
    }
    if (unsupported && !notices.includes(TSP_FOOTER_NOTICES.unavailableItems)) {
      notices.push(TSP_FOOTER_NOTICES.unavailableItems)
    }
  }
  return {
    mode: config.mode,
    layout: config.layout,
    registry,
    userCommandIds: config.userCommandIds,
    notices,
  }
}
/** The visibility bound of an unavailable item's clamped name (cells). */
const UNAVAILABLE_NAME_CELLS = 18

/**
 * The visible marker for one unsupported placement. The label never carries
 * the underlying command string or plugin path — only the user-facing name
 * (for a USER command item) or the fixed kind word.
 */
function unavailableText(kind: 'item' | 'extension' | 'command', name?: string): string {
  if (kind === 'command' && name !== undefined && name !== '') {
    return `Unavailable: ${clampMiddle(sanitizedPhysicalLine(name), UNAVAILABLE_NAME_CELLS)}`
  }
  return `Unavailable: ${kind}`
}

/** One unsupported placement's native shape: the warning marker. */
function unavailableSeg(kind: 'item' | 'extension' | 'command', name?: string): { text: string; tone: Tone } {
  return { text: unavailableText(kind, name), tone: 'warning' as const }
}

/** Whether an id belongs to the extension namespace (`ext:…`). */
function isExtensionId(id: string): boolean {
  return id.startsWith('ext:')
}

/**
 * Render one custom placement through its registry definition at `preferred`
 * density, or return the placement's unavailable marker. Returns `undefined`
 * only for a legitimately absent fact (the item renders nothing) and for the
 * retired inert `view-scope` item. The returned importance is the user's
 * override when present, otherwise the resolved definition's default (the
 * unavailable markers use the fixed plan priority 70).
 */
function customRefSegments(
  snapshot: StatusSnapshot,
  presentation: NativeFooterPresentation,
  ref: FooterItemRef,
  side: 'left' | 'right',
): { text: string; tone: Tone | undefined; importance: number } | undefined {
  // The retired viewer identity block stays INERT (registered, renders
  // nothing) — not an unsupported marker and never an error.
  if (ref.id === 'view-scope') return undefined
  // Extension items (the legacy `ext:*` bridge and owned `ext:<owner>/<id>`
  // items) are EXPLICIT_UNAVAILABLE in TSP: no extension state exists on this
  // renderer, and the synthetic builtin must not fabricate an empty bridge.
  if (isExtensionId(ref.id)) {
    return { ...unavailableSeg('extension'), importance: ref.importance ?? 70 }
  }
  // The ONE mount-local registry answers every lookup (builtins + the USER
  // catalog attached through setCustomSource — the single source of truth).
  const def = presentation.registry.get(ref.id)
  if (def === undefined) {
    if (ref.id.startsWith(CUSTOM_FOOTER_ITEM_PREFIX)) {
      // A USER command definition (classified by the resolver) or an unknown
      // `user:*` ref: the name is user-facing text, never the command string.
      const kind = presentation.userCommandIds.has(ref.id) ? 'command' : 'item'
      return { ...unavailableSeg(kind, customItemName(ref.id)), importance: ref.importance ?? 70 }
    }
    return { ...unavailableSeg('item'), importance: ref.importance ?? 70 }
  }
  const segment = def.render(snapshot, ref, 'preferred', NO_SURFACE_HINTS)
  if (segment === null) return undefined
  if (segment.spans.length === 0) return undefined
  // The LAST output boundary: every span text and the user prefix/suffix pass
  // the one-physical-line sanitization before entering `ui.seg` (the builtins
  // already sanitize their own facts; a USER text item or a hostile snapshot
  // fact must not smuggle C0/C1 or OSC/CSI through the dock).
  let text = sanitizedPhysicalLine(segment.spans.map(span => span.text).join(''))
  if (text === '') return undefined
  // The user's prefix/suffix are display decoration for a REAL rendering
  // only — an unavailable placeholder never carries them.
  if (ref.prefix !== undefined) text = `${sanitizedPhysicalLine(ref.prefix)}${text}`
  if (ref.suffix !== undefined) text = `${text}${sanitizedPhysicalLine(ref.suffix)}`
  const refTone = ref.tone !== undefined && ref.tone !== 'auto' ? nativeTone(ref.tone) : undefined
  const tone = refTone !== undefined
    ? refTone
    : nativeTone(segment.spans.find(span => span.tone !== undefined)?.tone)
  return { text, tone, importance: ref.importance ?? def.defaultImportance }
}

/**
 * The custom rows: one `ui.status` per layout row (1..2), each with the
 * left-zone and right-zone segments in their persisted placement order.
 * Keys are derived from the STABLE PLACEMENT PATH (row/zone/index) — never
 * from the bare user id — so a duplicate id keeps two independent segments.
 */
function customRows(snapshot: StatusSnapshot, presentation: NativeFooterPresentation): readonly Node[] {
  const layout = presentation.layout
  if (layout === undefined) return []
  const rows: Node[] = []
  for (const [rowIndex, row] of layout.rows.entries()) {
    const rowNumber = rowIndex + 1
    const segments: Node[] = []
    for (const [zone, refs] of [['left', row.left], ['right', row.right]] as const) {
      for (const [index, ref] of refs.entries()) {
        const rendered = customRefSegments(snapshot, presentation, ref, zone)
        if (rendered === undefined) continue
        segments.push(ui.seg({
          key: `footer-r${rowNumber}-${zone[0]}${index}`,
          text: rendered.text,
          ...(rendered.tone === undefined ? {} : { tone: rendered.tone }),
          ...(zone === 'left' ? {} : { side: 'right' as const }),
          priority: rendered.importance,
        }))
      }
    }
    if (segments.length > 0) rows.push(ui.status({ key: `status-row-${rowNumber}` }, ...segments))
  }
  return rows
}

/**
 * The two PR-A native status rows for one committed snapshot, in the frozen
 * order (row 1 then row 2). A row without a single present item contributes
 * no node, so the dock never paints an empty status line.
 */
export function nativeStatuslineRows(snapshot: StatusSnapshot): readonly Node[]
/**
 * PR-D: the configured projection. With a presentation the mode decides the
 * shape (`default` keeps the frozen PR-A/B rows; `compact` is the fixed TSP
 * single row; `custom` walks the validated layout); without one the frozen
 * default stays byte-for-byte (an unconfigured mount keeps PR-A/B).
 */
export function nativeStatuslineRows(snapshot: StatusSnapshot, presentation: NativeFooterPresentation | undefined): readonly Node[]
export function nativeStatuslineRows(snapshot: StatusSnapshot, presentation?: NativeFooterPresentation): readonly Node[] {
  if (presentation === undefined || presentation.mode === 'default') {
    const rows: Node[] = []
    const rowOne = rowSegments(snapshot, ROW_ONE)
    if (rowOne.length > 0) rows.push(ui.status({ key: 'status-row-1' }, ...rowOne))
    const rowTwo = rowSegments(snapshot, ROW_TWO)
    if (rowTwo.length > 0) rows.push(ui.status({ key: 'status-row-2' }, ...rowTwo))
    return rows
  }
  if (presentation.mode === 'compact') {
    const row = rowSegments(snapshot, COMPACT_ROW)
    if (row.length > 0) return [ui.status({ key: 'status-row-1' }, ...row)]
    return []
  }
  return customRows(snapshot, presentation)
}
