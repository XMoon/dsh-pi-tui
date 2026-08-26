/**
 * The widget outlet (M4, plan §9/§19): renders `input.widget.above` /
 * `input.widget.below` contributions as bounded rows in the host's editor
 * zone. The host OWNS the row budget and the layout: a widget can never
 * push the editor off-screen, and the lowest-importance widgets collapse
 * first under pressure (plan §19 height priority — minimum editor
 * usability always wins).
 *
 * Contract:
 * - contributions are structured `InputWidget` values compiled by the
 *   ComponentCompiler into private components;
 * - the outlet produces TEXT for the host's fixed editor-zone Text rows
 *   (the host merges them into its root layout — widgets never touch the
 *   root Container or focus);
 * - empty/removal clears the previously painted rows (the fork's emptied
 *   pane quirk — an outlet rebuild always rewrites the full text);
 * - a throwing contribution is recorded in the health ledger and omitted
 *   (per-contribution isolation, plan §18);
 * - a theme switch re-bakes (the compiled components read the palette at
 *   render time, and the outlet re-renders on themeRevision change).
 * @module @xmoon76/dsh-pi-tui/extension/widget-outlet
 */

import type { Component } from '@xmoon76/pi-tui'
import { visibleWidth } from '@xmoon76/pi-tui'
import { ExtensionLedger } from './ledger.ts'
import { compileView } from './component-compiler.ts'
import type { InputWidget } from '../public-types.ts'

/** A render sink for one outlet (the host wires the active screen). */
export interface OutletRenderSink {
  requestRender(): void
}

/** The compiled + measured state of one widget contribution. */
interface WidgetEntry {
  readonly component: Component
  /** The rendered rows at the current width (re-baked on width change). */
  rows: string[]
  /** The visible height (rows) the widget occupies at the current width. */
  height: number
  readonly importance: number
  readonly maxHeight: number
}

/** The widget outlet for one editor-zone position (above or below). */
export class WidgetOutlet {
  private readonly ledger: ExtensionLedger
  private readonly sink: OutletRenderSink
  private readonly slot: 'input.widget.above' | 'input.widget.below'
  private revision = -1
  private themeRevision = -1
  private width = 80
  /** The host-owned row budget for this position. */
  private rowBudget = 3
  private textValue = ''
  /** P2-03: compiled nodes cached by contribution IDENTITY — a refresh
   * (revision/width/theme change) reuses the SAME compiled tree for an
   * unchanged contribution instead of recompiling every pass (the
   * compiler contract promises reference-stable trees; the cache makes
   * the promise real). Invalidation: the ledger revision bumps on every
   * register/replace/dispose, so a stale identity key never survives a
   * contribution change. The key is the OWNER-SCOPED identity
   * (`owner\0id` — the ledger allows two owners to share a local id, and
   * an id-only key would make them overwrite each other's compiled tree
   * on every refresh; the review's P2). */
  private readonly compiledNodes = new Map<string, { value: InputWidget; node: ReturnType<typeof compileView> }>()
  // Cache entries are additionally checked by value identity in refresh(); a
  // same-id replace therefore cannot reuse the old compiled tree.

  constructor(ledger: ExtensionLedger, sink: OutletRenderSink, slot: 'input.widget.above' | 'input.widget.below') {
    this.ledger = ledger
    this.sink = sink
    this.slot = slot
  }

  /** The current widget text (the host merges it into its editor zone). */
  text(): string {
    return this.textValue
  }

  /** Whether any widget contribution currently renders content. */
  hasContent(): boolean {
    return this.textValue !== ''
  }

  /**
   * Rebuild the widget text from the ledger. Cheap: skipped when neither
   * the ledger revision, the theme revision, the width nor the row budget
   * changed. Rendering is deferred to render() time per contribution; this
   * pass only MEASURES the compiled components at the current width and
   * applies the host row budget.
   */
  refresh(themeRevision = 0, width = this.width, rowBudget = this.rowBudget): void {
    const snapshot = this.ledger.snapshot<InputWidget>(this.slot)
    if (snapshot.revision === this.revision && themeRevision === this.themeRevision
      && width === this.width && rowBudget === this.rowBudget) return
    this.revision = snapshot.revision
    this.themeRevision = themeRevision
    this.width = width
    this.rowBudget = rowBudget
    const contentWidth = Math.max(1, width)
    // Compile (or reuse) each contribution; a throwing compile is recorded
    // and the contribution omitted. P2-03: an unchanged contribution's
    // compiled tree is REUSED across refreshes (identity-keyed cache) —
    // the M11 benchmark measures the refresh cost, and the compiler's
    // reference-stability promise only pays off when the tree survives.
    const entries: WidgetEntry[] = []
    for (const record of snapshot.records) {
      try {
        const widget = record.value
        // P2-03: compile once per contribution identity; an EMPTY view is
        // cached too (abdication is re-derived from the ledger value each
        // pass — a replace() recompiles through the new record).
        const cacheKey = `${record.owner}\u0000${record.id}`
        const cached = this.compiledNodes.get(cacheKey)
        let node: ReturnType<typeof compileView>
        if (cached !== undefined && cached.value === widget) {
          node = cached.node
        } else {
          node = compileView(widget?.view)
          this.compiledNodes.set(cacheKey, { value: widget, node })
        }
        if (node.isEmpty) {
          this.ledger.clearError(this.slot, record.id, record.owner)
          continue
        }
        // Render at the CURRENT width so the height is truthful for the
        // budget pass (a width change re-measures; the compiled component
        // stays live and re-wraps).
        const rows = node.component.render(contentWidth).filter(line => visibleWidth(line) > 0 || line !== '')
        const importance = widget?.importance ?? 0
        const maxHeight = widget?.maxHeight === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(widget.maxHeight))
        entries.push({
          component: node.component,
          rows,
          height: rows.length,
          importance,
          maxHeight,
        })
        this.ledger.clearError(this.slot, record.id, record.owner)
      } catch (error) {
        this.ledger.recordError(this.slot, record.id, record.owner, safeMessage(error))
      }
    }
    // P2-03: prune cache entries whose contribution left the ledger (a
    // removed contribution's compiled tree must not linger). The live set
    // uses the SAME owner-scoped keys (an id-only set would keep a stale
    // tree alive when the OTHER owner with the same id was removed).
    if (this.compiledNodes.size > snapshot.records.length) {
      const live = new Set(snapshot.records.map(record => `${record.owner}\u0000${record.id}`))
      for (const key of [...this.compiledNodes.keys()]) {
        if (!live.has(key)) this.compiledNodes.delete(key)
      }
    }
    // Host row budget (plan §19): drop whole widgets in ASCENDING
    // importance until the total fits; keep at least one widget; then cap
    // each remaining widget to its declared maxHeight (truncate rows from
    // the BOTTOM so the leading content survives).
    const budget = Math.max(1, rowBudget)
    const totalOf = (list: readonly WidgetEntry[]): number => list.reduce((sum, entry) => sum + entry.height, 0)
    let kept = entries
    // A declared maxHeight is a HARD cap, applied regardless of the row
    // budget: a widget that asks for 2 rows never renders 3 even when the
    // zone has room (the cap is the widget's own contract, the budget is
    // the host's).
    for (const entry of kept) {
      if (entry.rows.length > entry.maxHeight) {
        entry.rows = entry.rows.slice(0, entry.maxHeight)
        entry.height = entry.rows.length
      }
    }
    if (totalOf(kept) > budget) {
      const byImportance = [...kept].sort((a, b) => a.importance - b.importance)
      for (const victim of byImportance) {
        if (kept.length === 1) break
        const without = kept.filter(entry => entry !== victim)
        if (totalOf(without) <= budget) {
          kept = without
          break
        }
        kept = without
      }
      // Still over: drop tail widgets until the budget fits.
      while (totalOf(kept) > budget && kept.length > 1) kept = kept.slice(0, -1)
      // A single over-budget widget: truncate to the budget (bottom rows
      // dropped — the widget keeps its identity under pressure).
      if (kept.length === 1 && totalOf(kept) > budget) {
        kept[0]!.rows = kept[0]!.rows.slice(0, budget)
        kept[0]!.height = kept[0]!.rows.length
      }
    }
    const lines: string[] = []
    for (const entry of kept) lines.push(...entry.rows)
    this.textValue = lines.join('\n')
    this.sink.requestRender()
  }

  /** Dispose the outlet (surface teardown). */
  dispose(): void {
    this.textValue = ''
  }
}

/** A safe single-line error message for the health ledger (no stack
 * traces — the plan's error policy; hostile toString is handled). */
function safeMessage(error: unknown): string {
  try {
    const message = error instanceof Error ? error.message : String(error)
    return message.replace(/\s+/g, ' ').slice(0, 200)
  } catch {
    return 'unknown widget error'
  }
}
