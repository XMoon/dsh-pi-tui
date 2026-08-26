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
 *
 * SELECTION IDENTITY (the review's P2): the picker/apply/persist path uses
 * SOURCE-QUALIFIED selectable values — `plugin:<owner>/<id>` for plugin
 * themes (never the bare contribution name), the bare name for custom
 * files, `auto|dark|light` for builtins. The bare NAME remains an internal
 * registration namespace only (a duplicate name among plugins is still an
 * explicit conflict), so a plugin theme can never shadow or collide with a
 * custom FILE of the same name (the two sources live in disjoint value
 * namespaces), and a persisted `plugin:…` value degrades deterministically
 * when the plugin unloads — it never silently becomes the file theme of
 * the same name. The plugin selectable value embeds the plugin's STABLE
 * owner name (the nearest named ancestor's display name — stable across
 * HMR, like the M4 canonical footer keys) and the contribution id, both
 * percent-encoded (an injective encoding: a literal `~` owner can never
 * collide with an encoded slash owner). The DISPLAYED name is still the
 * contribution name; the selectable value is the identity.
 * @module @xmoon76/dsh-pi-tui/theme-registry
 */

import type { ColorPalette } from './theme.ts'
import type { TuiThemeContribution, TuiThemeHandle, TuiThemeRegistrySnapshot } from './extension/public-types.ts'

/** Host-reserved theme names: the /settings picker dispatches these to
 * the builtin branches BEFORE the plugin branch, so a plugin theme with
 * one of these names could never be selected. Rejected at registration. */
const RESERVED_THEME_NAMES: ReadonlySet<string> = new Set(['auto', 'dark', 'light'])

/** The source-qualified selectable prefix for plugin themes. */
const PLUGIN_SELECTABLE_PREFIX = 'plugin:'


/** Internal registration record. */
interface ThemeRecord {
  readonly id: string
  readonly name: string
  readonly palette: ColorPalette
  readonly description: string | undefined
  /** The registration owner (`uid:name` — unique per fiber instance). */
  readonly owner: string
  /** The plugin's STABLE owner name (the nearest named ancestor's display
   * name — stable across HMR; the source-qualified selectable value embeds
   * it, so a persisted identity survives a reload). */
  readonly stableOwner: string
  disposed: boolean
}

/** Percent-encode one selectable-value segment (owner / id). The encoding
 * is injective (encodeURIComponent never escapes ASCII letters/digits, and
 * '%' itself is escaped), so a literal '~' owner can never collide with an
 * encoded slash owner — the same argument as the M4 canonical footer keys. */
function encodeSegment(value: string): string {
  return encodeURIComponent(value)
}

/**
 * The theme registry. One instance backs the runner; the extension service
 * exposes registration; the runner consults the SOURCE-QUALIFIED
 * selectable values when composing the theme picker and applying a
 * selection.
 */
export class ThemeRegistry {
  private readonly records = new Map<string, ThemeRecord>()
  private revision = 0
  private readonly onInvalidate: () => void

  constructor(onInvalidate: () => void = () => {}) {
    this.onInvalidate = onInvalidate
  }

  /** The source-qualified selectable value of one record. */
  static selectableValueOf(record: ThemeRecord): string {
    return `${PLUGIN_SELECTABLE_PREFIX}${encodeSegment(record.stableOwner)}/${encodeSegment(record.id)}`
  }

  /** The source-qualified selectable value for a contribution BEFORE it is
   * registered: `plugin:<stableOwner>/<id>`. The service computes it while
   * registering (the same encoding the record's value uses, so the
   * unload hook can name the selection deterministically). */
  static selectableValue(stableOwner: string, id: string): string {
    return `${PLUGIN_SELECTABLE_PREFIX}${encodeSegment(stableOwner)}/${encodeSegment(id)}`
  }

  /**
   * Register one theme. A duplicate id or a duplicate display NAME is an
   * explicit error (never a silent override — a picker showing two
   * plugins with the same name is still ambiguous, even though their
   * selectable VALUES are distinct).
   * @param contribution - the theme.
   * @param owner - the Cordis fiber identity (`uid:name`; unique per
   *   fiber instance — health + owner-scoped disposal).
   * @param stableOwner - the plugin's STABLE owner name (the nearest
   *   named ancestor's display name; defaults to `owner` for direct use).
   * @returns a handle to remove the theme.
   */
  register(contribution: TuiThemeContribution, owner: string, stableOwner = owner): TuiThemeHandle {
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
    // The HOST-BUILTIN theme names are reserved: the /settings picker and
    // the apply path dispatch 'auto'/'dark'/'light' to the BUILTIN
    // branches BEFORE the plugin branch, so a plugin theme with one of
    // these names would register, appear in the picker, and never be
    // selectable (the review's P2/P3).
    if (RESERVED_THEME_NAMES.has(contribution.name)) {
      throw new Error(`theme name "${contribution.name}" is reserved by the host (auto/dark/light)`)
    }
    this.records.set(contribution.id, {
      id: contribution.id,
      name: contribution.name,
      palette: contribution.palette,
      description: contribution.description,
      owner,
      stableOwner,
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

  /** The identity ({id, owner}) of one theme, resolved by the
   * SOURCE-QUALIFIED selectable value ONLY — the unified bridge protocol
   * addresses themes by selectable value (the /settings picker and the
   * startup/advanced apply paths all pass the selectable value; a mixed
   * name/id lookup is inherently ambiguous — the review's P2). */
  identityOfSelectable(value: string): { id: string; owner: string; name: string } | undefined {
    const record = this.bySelectable(value)
    if (record === undefined) return undefined
    return { id: record.id, owner: record.owner, name: record.name }
  }

  /** The live record for one source-qualified selectable value, or
   * undefined. A value in ANY other namespace (a bare name, a legacy
   * `custom:` reference) never resolves — plugin selectable values are
   * the ONLY identity for plugin themes. */
  bySelectable(value: string): ThemeRecord | undefined {
    if (!value.startsWith(PLUGIN_SELECTABLE_PREFIX)) return undefined
    const rest = value.slice(PLUGIN_SELECTABLE_PREFIX.length)
    const slash = rest.indexOf('/')
    if (slash < 0) return undefined
    let stableOwner: string | undefined
    let id: string | undefined
    try {
      stableOwner = decodeURIComponent(rest.slice(0, slash))
      id = decodeURIComponent(rest.slice(slash + 1))
    } catch {
      // A malformed percent-encoding is not a theme identity.
      return undefined
    }
    for (const record of this.records.values()) {
      if (record.disposed) continue
      if (record.stableOwner === stableOwner && record.id === id) return record
    }
    return undefined
  }

  /** The live record for one display NAME (internal diagnostics; the
   * picker/apply paths use bySelectable — a name lookup can never be the
   * identity of a SELECTION). */
  byName(name: string): ThemeRecord | undefined {
    for (const record of this.records.values()) {
      if (record.disposed) continue
      if (record.name === name) return record
    }
    return undefined
  }

  /** The source-qualified selectable values (sorted; the host appends
   * them to the picker's builtin auto/dark/light + custom-file list). */
  selectableValues(): string[] {
    return [...this.records.values()]
      .filter(record => !record.disposed)
      .map(record => ThemeRegistry.selectableValueOf(record))
      .sort((left, right) => left.localeCompare(right))
  }

  /** The display NAMES (sorted — diagnostics, /status counts; never a
   * selection identity). */
  names(): string[] {
    return [...this.records.values()]
      .filter(record => !record.disposed)
      .map(record => record.name)
      .sort((left, right) => left.localeCompare(right))
  }

  /** The palette for one source-qualified selectable value, or undefined. */
  paletteForSelectable(value: string): ColorPalette | undefined {
    return this.bySelectable(value)?.palette
  }

  /** Whether one source-qualified selectable value is live. */
  hasSelectable(value: string): boolean {
    return this.bySelectable(value) !== undefined
  }

  /** The display name for one source-qualified selectable value, or
   * undefined. (The UI shows the NAME; the value is the identity.) */
  displayNameForSelectable(value: string): string | undefined {
    return this.bySelectable(value)?.name
  }

  /** The palette for one selectable NAME (internal diagnostics — the
   * apply path must use paletteForSelectable, never a name). */
  paletteFor(name: string): ColorPalette | undefined {
    return this.byName(name)?.palette
  }

  /** The source-qualified selectable value of the LIVE plugin theme with
   * the given display NAME, or undefined. The advanced host-state
   * `setTheme` path is NAME-addressed (its documented Phase-4 contract —
   * a plugin calls `host.setTheme(<its own theme name>)`); the runner
   * maps the name to the VALUE through this helper before applying and
   * health-tracking (a name is a label, the value is the identity). */
  selectableValueForName(name: string): string | undefined {
    const record = this.byName(name)
    return record === undefined ? undefined : ThemeRegistry.selectableValueOf(record)
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