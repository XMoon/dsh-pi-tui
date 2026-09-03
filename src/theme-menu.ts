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
 * @module @xmoon76/dsh-pi-tui/theme-menu
 */

import { SettingsList, type RowBudgetAware } from '@xmoon76/pi-tui'
import { settingsListTheme } from './theme.ts'
import type { ThemeRegistry } from './theme-registry.ts'
import { themePickerRows, normalizePersistedTheme } from './theme-source.ts'

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
 * here). The `← current` marker compares ROW VALUES, never display
 * labels: theme sources are dynamic, so a same-labeled row from a
 * DIFFERENT source (a file `Solarized.json` created while a plugin theme
 * `Solarized` is selected) must never steal the marker — the review's
 * P3. The outer row's display string is presentational only and is never
 * consulted for identity.
 */
export class ThemeSubmenu implements RowBudgetAware {
  private readonly inner: SettingsList

  /** Host row-budget seam: forward the outer SettingsList's live grant so
   * the theme list reflows on a short terminal instead of being clipped
   * by the compositor (the outer forwards on open and on every change). */
  setMaxRows(rows: number): void {
    this.inner.setMaxRows(rows)
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
        label: row.displayName,
        description: row.value.startsWith('plugin:')
          ? 'Extension-registered theme'
          : row.value.startsWith('file:')
            ? 'Custom theme file'
            : 'Built-in palette',
        // The marker is a VALUE comparison against the live selection
        // identity — never a display-label comparison (a same-labeled row
        // from another source cannot steal it).
        currentValue: row.value === current ? '← current' : '',
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

  invalidate(): void {
    this.inner.invalidate?.()
  }

  render(width: number): string[] {
    return this.inner.render(width)
  }
}
