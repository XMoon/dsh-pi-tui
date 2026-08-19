/**
 * The theme registry (M5, plan §10 item 4): plugins register named color
 * palettes into the host's theme picker. The registry holds SEMANTIC
 * palettes (the same ColorPalette shape the host's custom theme files
 * resolve to) — never raw ANSI or terminal escapes. The host owns palette
 * application (themeRevision bump + repaint); the registry only decides
 * WHICH palettes are selectable and what happens when the selected one
 * unloads.
 *
 * Contract (plan M5 gates):
 * - a selected plugin theme whose owner unloads falls back to the built-in
 *   palette (the host re-applies 'dark'), never a dangling reference;
 * - registration is fiber-bound (owner unload removes the theme);
 * - name collisions are an explicit conflict error (never a silent
 *   override);
 * - the registry never applies a palette itself — the host's applyPalette
 *   is the only application path.
 * @module @xmoon76/dsh-pi-tui/theme-registry
 */

import type { ColorPalette } from './theme.ts'
import type { TuiThemeContribution, TuiThemeHandle, TuiThemeRegistrySnapshot } from './extension/public-types.ts'







/** Internal registration record. */
interface ThemeRecord {
  readonly id: string
  readonly name: string
  readonly palette: ColorPalette
  readonly description: string | undefined
  readonly owner: string
  disposed: boolean
}

/**
 * The theme registry. One instance backs the runner; the extension service
 * exposes registration; the runner consults {@link byName} / {@link names}
 * when composing the theme picker and applying a selection.
 */
export class ThemeRegistry {
  private readonly records = new Map<string, ThemeRecord>()
  private revision = 0
  private readonly onInvalidate: () => void

  constructor(onInvalidate: () => void = () => {}) {
    this.onInvalidate = onInvalidate
  }

  /**
   * Register one theme. A duplicate id or a duplicate SELECTABLE name is
   * an explicit error (never a silent override — pickers must be
   * unambiguous).
   * @param contribution - the theme.
   * @param owner - the Cordis fiber name.
   * @returns a handle to remove the theme.
   */
  register(contribution: TuiThemeContribution, owner: string): TuiThemeHandle {
    if (this.records.has(contribution.id)) {
      throw new Error(`duplicate theme contribution id "${contribution.id}"`)
    }
    for (const record of this.records.values()) {
      if (record.disposed) continue
      if (record.name === contribution.name) {
        throw new Error(`duplicate theme name "${contribution.name}" (owner "${record.owner}")`)
      }
    }
    if (contribution.name === '') throw new Error('theme name must not be empty')
    this.records.set(contribution.id, {
      id: contribution.id,
      name: contribution.name,
      palette: contribution.palette,
      description: contribution.description,
      owner,
      disposed: false,
    })
    this.revision += 1
    this.onInvalidate()
    return {
      id: contribution.id,
      dispose: () => this.dispose(contribution.id),
    }
  }

  /** Remove one theme by id (idempotent). */
  dispose(id: string): void {
    const record = this.records.get(id)
    if (record === undefined || record.disposed) return
    record.disposed = true
    this.records.delete(id)
    this.revision += 1
    this.onInvalidate()
  }

  /** Dispose every theme owned by one fiber (owner unload). */
  disposeOwner(owner: string): void {
    for (const [id, record] of [...this.records]) {
      if (record.owner === owner) this.dispose(id)
    }
  }

  /** The live record for one selectable name, or undefined. */
  byName(name: string): ThemeRecord | undefined {
    for (const record of this.records.values()) {
      if (record.disposed) continue
      if (record.name === name) return record
    }
    return undefined
  }

  /** The selectable names (sorted; the host appends them to the picker's
   * built-in auto/dark/light list). */
  names(): string[] {
    return [...this.records.values()]
      .filter(record => !record.disposed)
      .map(record => record.name)
      .sort((left, right) => left.localeCompare(right))
  }

  /** The palette for one name, or undefined. */
  paletteFor(name: string): ColorPalette | undefined {
    return this.byName(name)?.palette
  }

  /** Whether any theme is live (health /status). */
  hasAny(): boolean {
    for (const record of this.records.values()) {
      if (!record.disposed) return true
    }
    return false
  }

  /** An immutable snapshot (diagnostics + /status). */
  snapshot(): TuiThemeRegistrySnapshot {
    const themes = [...this.records.values()]
      .filter(record => !record.disposed)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(record => ({
        id: record.id,
        name: record.name,
        description: record.description,
        owner: record.owner,
      }))
    return { themes, revision: this.revision }
  }
}
