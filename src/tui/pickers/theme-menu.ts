/**
 * The /settings THEME picker submenu (the review's P2/P3): an in-place
 * SettingsList reached through the fork's `SettingItem.submenu` slot (the
 * /model pattern — no second overlay, no ghost overlay).
 *
 * IDENTITY END-TO-END: every submenu ROW's id IS the SOURCE-QUALIFIED
 * selectable value (`auto|dark|light`, `file:<name>`, `plugin:<owner>/<id>`)
 * — the exact string that gets applied and persisted. The display name is
 * ONLY a label (rendered text); nothing ever round-trips
 * `value → display → value`. The outer SettingsList row's `currentValue`
 * is the FRIENDLY display name (what the panel shows — the /settings
 * handler rewrites the fork's raw selected value back to the label via
 * the updateValue seam after a pick); the outer onChange receives the
 * source-qualified value directly from the submenu row id, so no
 * live-registry re-resolution happens at confirm time (an HMR unload
 * between open and confirm can never redirect the selection to a
 * same-named new contribution — the review's P2).
 *
 * Why a submenu instead of `values` cycling: the cycling list matches
 * `currentValue` against the `values` array verbatim, so the row's value
 * AND display would both be the source-qualified identity — the picker
 * would show raw `plugin:owner/id` strings, and a persisted value whose
 * source is gone (an unloaded plugin) would sit outside the values list
 * and silently jump to the first option on the first Enter (the illegal
 * picker state the review flagged). A submenu separates identity (the
 * row id, applied/persisted) from label (rendered), and leaves a
 * gone-source selection untouched until the user picks a live option.
 * @module @xmoon76/dsh-pi-tui/tui/pickers/theme-menu
 */

import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { SettingsList, type Focusable, type RowBudgetAware, type TuiMouseEvent, type TuiMouseEventResult } from '@xmoon76/pi-tui'
import { color, settingsListTheme } from '../theme/runtime.ts'
import { abbreviateName } from './name-label.ts'
import type { ThemeRegistry } from '../../extension/internal/theme-registry.ts'
import { themePickerRows } from '../../app/surface/theme-selection.ts'
import { normalizePersistedTheme } from '../../domain/display/theme-selection.ts'

/** The FRIENDLY display name of one persisted/selectable theme value:
 * builtins as-is, `file:X` → X, `custom:X` → X, a LIVE `plugin:…` → its
 * contribution name (a gone plugin's value falls back to the raw value —
 * it IS a broken state, and hiding it would make the picker lie). The
 * persisted value is normalized FIRST (a legacy `custom:X` becomes the
 * `file:X` row), so the label matches the row the current selection
 * points at. This is display-only — never an identity. */
export function themeDisplayName(value: string | undefined, themes: ThemeRegistry | undefined): string {
  const normalized = normalizePersistedTheme(value)
  const rows = themePickerRows(themes)
  const current = rows.find(row => row.value === normalized)
  if (current !== undefined) return current.displayName
  if (normalized === 'auto' || normalized === 'dark' || normalized === 'light') return normalized
  if (normalized.startsWith('file:')) return normalized.slice('file:'.length)
  // A plugin value whose source is gone: show the value itself — the
  // picker must never claim a live selection that does not exist.
  return normalized
}

/** The in-place /settings theme picker. Row ids ARE the SOURCE-QUALIFIED
 * selectable values (the identity — applied and persisted verbatim); the
 * labels are unique display strings (builtin/file/plugin collisions are
 * source-tagged by {@link themePickerRows}). Selecting a row calls
 * `done(selectableValue)` — the fork's submenu done slot: the outer
 * SettingsList reflects the FRIENDLY display name on the row and fires
 * the outer onChange with the source-qualified VALUE. Esc calls `done()`
 * with no selection (the outer row is untouched).
 *
 * `currentSelection` is the CURRENT SELECTION's SOURCE-QUALIFIED IDENTITY
 * (the /settings handler's synchronous `lastThemeChoice` — normalized
 * here). The `[current]` state chip compares ROW VALUES, never display
 * labels: theme sources are dynamic, so a same-labeled row from a
 * DIFFERENT source (a file `Solarized.json` created while a plugin theme
 * `Solarized` is selected) must never steal the marker — the review's
 * P3. The outer row's display string is presentational only and is never
 * consulted for identity.
 */
export class ThemeSubmenu implements RowBudgetAware, Focusable {
  private readonly inner: SettingsList

  /** Host row-budget seam: forward the outer SettingsList's live grant so
   * the theme list reflows on a short terminal instead of being clipped
   * by the compositor (the outer forwards on open and on every change). */
  setMaxRows(rows: number): void {
    this.inner.setMaxRows(rows)
  }

  /** Focus forwarding (mouse parity): the search-enabled SettingsList
   * needs the focused flag for its search Input's cursor/IME state. */
  get focused(): boolean {
    return this.inner.focused
  }

  set focused(value: boolean) {
    this.inner.focused = value
  }

  constructor(
    currentSelection: string,
    themes: ThemeRegistry | undefined,
    done: (selectableValue?: string) => void,
  ) {
    const rows = themePickerRows(themes)
    // The caller passes the selection's IDENTITY; normalize defensively
    // (a legacy `custom:X` outer doc value still marks the `file:X` row).
    const current = normalizePersistedTheme(currentSelection)
    const close = (selected?: string): void => {
      done(selected)
    }
    this.inner = new SettingsList(
      rows.map(row => ({
        // The row id IS the identity — no display round-trip anywhere.
        id: row.value,
        // 25 = the label column at the 44-column floor (40 child width minus the
        // one 9-cell state chip this list reserves minus the 6 fixed cells). The
        // label keeps BOTH ends of a long name (head…tail around one `…`); that
        // abbreviation is a DRAWING fact, so the COMPLETE display name is declared
        // as the search basis (fork X062) — this list runs with `enableSearch:
        // true` and filters on `searchText ?? label`. The SELECTED row's
        // description leads with the same complete name, so two long same-prefix
        // theme names cannot paint one indistinguishable pair.
        label: sanitizedPhysicalLine(abbreviateName(sanitizedPhysicalLine(row.displayName), 25)),
        searchText: row.displayName,
        description: `${sanitizedPhysicalLine(row.displayName)} · ${row.value.startsWith('plugin:')
          ? 'Extension-registered theme'
          : row.value.startsWith('file:')
            ? 'Custom theme file'
            : 'Built-in palette'}`,
        // The marker is a VALUE comparison against the live selection
        // identity — never a display-label comparison (a same-labeled row
        // from another source cannot steal it). §4.5/§12.2: the state chip
        // is `textMuted` and is NEVER recoloured by the row's selection,
        // while `settingsListTheme().value` paints `selected ? primary :
        // textDim` — so the chip is PRE-PAINTED here (the same pattern as
        // `src/tui/plugin-manager/workspace.ts`) and handed to the renderer as a WHOLE part (X061): the
        // slot drops it entirely rather than ever painting `[curre`, and the
        // row's own `currentValue` keeps the fork's values/update semantics
        // untouched (it is unused for these rows).
        currentValue: '',
        valueParts: row.value === current
          ? [{ kind: 'chip' as const, text: color.textMuted('[current]') }]
          : undefined,
        values: ['✓'],
      })),
      Math.min(8, Math.max(3, rows.length)),
      settingsListTheme(),
      (selectableValue) => close(selectableValue),
      () => close(),
      { enableSearch: true },
    )
  }

  handleInput(data: string): void {
    this.inner.handleInput(data)
  }

  /** Transparent mouse forwarding (mouse parity): the outer SettingsList
   * dispatches submenu events here; the inner list owns row hit-testing,
   * search-Input positioning, and wheel selection. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.inner.handleMouse?.(event)
  }

  invalidate(): void {
    this.inner.invalidate?.()
  }

  render(width: number): string[] {
    return this.inner.render(width)
  }
}
