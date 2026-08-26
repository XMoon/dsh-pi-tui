/**
 * The /settings THEME picker submenu (the review's P2): an in-place
 * SettingsList reached through the fork's `SettingItem.submenu` slot (the
 * /model pattern — no second overlay, no ghost overlay). The theme row
 * DISPLAYS the friendly name; the submenu rows carry BOTH the display
 * name (their label — what the row shows on selection) and the
 * SOURCE-QUALIFIED selectable value (what is applied and persisted),
 * mapped through {@link themeDisplayToValue}.
 *
 * Why a submenu instead of `values` cycling: the cycling list matches
 * `currentValue` against the `values` array verbatim, so the row's value
 * AND display would both be the source-qualified identity — the picker
 * would show raw `plugin:owner/id` strings, and a persisted value whose
 * source is gone (an unloaded plugin) would sit outside the values list
 * and silently jump to the first option on the first Enter (the illegal
 * picker state the review flagged). A submenu separates identity
 * (applied/persisted) from label (displayed), gives the source-
 * disambiguated labels (`Foo (file)` / `Foo (plugin)`) when a custom file
 * and a plugin share a name, and leaves a gone-source selection untouched
 * until the user picks a live option.
 * @module @xmoon76/dsh-pi-tui/theme-menu
 */

import { SettingsList } from '@xmoon76/pi-tui'
import { settingsListTheme } from './theme.ts'
import type { ThemeRegistry } from './theme-registry.ts'
import { themePickerRows } from './theme-source.ts'

/** The current display name of one persisted/selectable theme value
 * (friendly: builtins as-is, `file:X` → X, live `plugin:…` → its name;
 * a gone plugin's value falls back to the raw value — it IS a broken
 * state, and hiding it would make the picker lie). */
export function themeDisplayName(value: string | undefined, themes: ThemeRegistry | undefined): string {
  const rows = themePickerRows(themes)
  const current = rows.find(row => row.value === value)
  if (current !== undefined) return current.displayName
  if (value === undefined || value === '') return 'auto'
  if (value === 'auto' || value === 'dark' || value === 'light') return value
  if (value.startsWith('file:')) return value.slice('file:'.length)
  if (value.startsWith('custom:')) return value.slice('custom:'.length)
  // A plugin value whose source is gone (or a bare name / other legacy
  // form): show the value itself — the picker must never claim a live
  // selection that does not exist.
  return value
}

/** The display-name → source-qualified-value map for the CURRENT rows.
 * The submenu selects by DISPLAY name (its row id); the /settings handler
 * maps the display back to the identity through this map (unique display
 * names — file/plugin duplicates are source-disambiguated). */
export function themeDisplayToValue(themes: ThemeRegistry | undefined): Map<string, string> {
  const map = new Map<string, string>()
  for (const row of themePickerRows(themes)) map.set(row.displayName, row.value)
  return map
}

/** The in-place /settings theme picker. Selecting a row calls
 * `done(displayName)` (the fork's submenu done slot: the outer SettingsList
 * reflects the display name on the row and fires the outer onChange, which
 * maps display → source-qualified value). Esc calls `done()` with no
 * selection (the outer row is untouched). */
export class ThemeSubmenu {
  private readonly inner: SettingsList

  constructor(
    currentDisplay: string,
    themes: ThemeRegistry | undefined,
    done: (displayName?: string) => void,
  ) {
    const rows = themePickerRows(themes)
    const close = (selected?: string): void => {
      done(selected)
    }
    this.inner = new SettingsList(
      rows.map(row => ({
        id: row.displayName,
        label: row.displayName,
        description: row.value.startsWith('plugin:')
          ? 'Extension-registered theme'
          : row.value.startsWith('file:')
            ? 'Custom theme file'
            : 'Built-in palette',
        currentValue: row.displayName === currentDisplay ? '← current' : '',
        values: ['✓'],
      })),
      Math.min(8, Math.max(3, rows.length)),
      settingsListTheme(),
      (displayName) => close(displayName),
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
