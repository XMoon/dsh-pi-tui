/**
 * The theme SELECTION identity protocol (the review's P2): the /settings
 * picker, the apply path, the persisted settings document and the startup/
 * reload restore all address themes through SOURCE-QUALIFIED selectable
 * values — `auto|dark|light` (builtins), `file:<name>` (custom files in
 * ~/.dsh-pi-tui/themes) and `plugin:<owner>/<id>` (extension-registered
 * themes, owner = the plugin's STABLE name — see ThemeRegistry). The bare
 * NAME is never a selection identity: it is only a display label.
 *
 * Why this exists:
 * - a custom FILE and a plugin theme may share a display name; the old
 *   bare-name value made the persisted meaning depend on which source
 *   existed, so the same value could resolve to the file before a plugin
 *   registered and to the plugin afterwards (and a plugin unload could
 *   silently change the value's meaning back to the file);
 * - a persisted plugin value degrades DETERMINISTICALLY when the plugin
 *   unloads: it resolves nothing and falls back to the builtin dark
 *   palette — it can never silently become the same-named file theme.
 *
 * The legacy `custom:<name>` form (the pre-qualification format) is still
 * READ as a file theme so existing documents keep working; new writes are
 * always `file:<name>` / `plugin:<owner>/<id>`.
 * @module @xmoon76/dsh-pi-tui/theme-source
 */

import type { ColorPalette } from './theme.ts'
import { loadCustomTheme, customThemeNames } from './theme.ts'
import type { ThemeRegistry } from './theme-registry.ts'

/** The source-qualified prefix for custom-theme files. */
const FILE_PREFIX = 'file:'
/** The source-qualified prefix for plugin themes. */
const PLUGIN_PREFIX = 'plugin:'
/** The legacy (pre-qualification) prefix for custom-theme files. */
const LEGACY_CUSTOM_PREFIX = 'custom:'

/** The source-qualified selectable value of one custom theme file. */
export function fileThemeValue(name: string): string {
  return `${FILE_PREFIX}${name}`
}

/** Whether one selectable value names a custom theme file. */
export function isFileThemeValue(value: string): boolean {
  return value.startsWith(FILE_PREFIX)
}

/** The file name behind one `file:` selectable value. */
export function fileThemeNameOf(value: string): string {
  return value.slice(FILE_PREFIX.length)
}

/** Whether one selectable value names an extension-registered theme. */
export function isPluginThemeValue(value: string): boolean {
  return value.startsWith(PLUGIN_PREFIX)
}

/** Whether one selectable value is a builtin theme (auto/dark/light). */
export function isBuiltinThemeValue(value: string): boolean {
  return value === 'auto' || value === 'dark' || value === 'light'
}

/** Normalize a PERSISTED theme value to its source-qualified selectable
 * form. The legacy `custom:<name>` form (and a bare name, the oldest
 * format) map to `file:<name>`; `auto|dark|light` and the `file:`/`plugin:`
 * forms pass through. Unknown/garbage resolves to `auto` (the host default). */
export function normalizePersistedTheme(value: string | undefined): string {
  if (value === undefined || value === '') return 'auto'
  if (value === 'auto' || value === 'dark' || value === 'light') return value
  if (value.startsWith(FILE_PREFIX) || value.startsWith(PLUGIN_PREFIX)) return value
  if (value.startsWith(LEGACY_CUSTOM_PREFIX)) return fileThemeValue(value.slice(LEGACY_CUSTOM_PREFIX.length))
  // A bare name: the oldest format, always a file reference.
  return fileThemeValue(value)
}

/** One resolved theme selection: the source kind + the palette. */
export type ResolvedThemeSelection =
  | { readonly kind: 'file'; readonly name: string; readonly palette: ColorPalette }
  | { readonly kind: 'plugin'; readonly value: string; readonly palette: ColorPalette }

/** Resolve one source-qualified selectable value to a palette, or
 * undefined when the source is absent (a missing file, an unloaded
 * plugin, or a value in no known namespace). ONLY service reads: a file
 * applies its own palette; a plugin resolves through the registry (never
 * a bare-name lookup — a value is an identity, not a label). */
export function resolveThemeSelection(
  value: string,
  themes: ThemeRegistry | undefined,
): ResolvedThemeSelection | undefined {
  if (isFileThemeValue(value)) {
    const palette = loadCustomTheme(fileThemeNameOf(value))
    return palette === undefined ? undefined : { kind: 'file', name: fileThemeNameOf(value), palette }
  }
  if (isPluginThemeValue(value)) {
    const palette = themes?.paletteForSelectable(value)
    return palette === undefined ? undefined : { kind: 'plugin', value, palette }
  }
  return undefined
}

/** The rows of the theme picker's SOURCE-QUALIFIED values, as
 * {value, displayName} pairs: builtins, then custom files, then plugin
 * themes. The DISPLAY names are unique across the WHOLE row set
 * (builtin/file/plugin AND any label that a user file name could mimic,
 * e.g. a `(plugin)`/`(file)` suffix — the review's P2: a `dark.json` file
 * next to the builtin `dark`, or a file literally named `X (plugin)`,
 * must never produce two rows with the same label). The VALUE stays the
 * identity; the LABEL is purely presentational and never round-tripped
 * back to an identity. */
export function themePickerRows(themes: ThemeRegistry | undefined): readonly {
  readonly value: string
  readonly displayName: string
}[] {
  const builtins: readonly { value: string; displayName: string }[] = [
    { value: 'auto', displayName: 'auto' },
    { value: 'dark', displayName: 'dark' },
    { value: 'light', displayName: 'light' },
  ]
  const files = customThemeNames().map(name => ({ value: fileThemeValue(name), displayName: name }))
  const plugins = (themes?.selectableValues() ?? []).map(value => ({
    value,
    displayName: themes?.displayNameForSelectable(value) ?? value,
  }))
  // Disambiguate EVERY label collision across all three sources, in
  // declaration order (builtin < file < plugin): the first holder keeps
  // the bare label, later holders get their source tagged. This covers
  // builtin/file (`dark` vs `dark.json`), file/plugin (the original P2)
  // AND a user file that literally names itself `X (plugin)` — the
  // tagging is computed against the CURRENT unique set, so an already
  // taken suffixed label is tagged again, never silently duplicated.
  const used = new Map<string, 'builtin' | 'file' | 'plugin'>()
  const claim = (
    value: string,
    displayName: string,
    source: 'builtin' | 'file' | 'plugin',
  ): string => {
    let label = displayName
    if (used.has(label) && used.get(label) !== source) {
      label = `${displayName} (${source})`
      // A file may already be named `X (plugin)`; keep tagging until the
      // label is unique (the suffix is a label, never an identity).
      let n = 2
      while (used.has(label)) {
        label = `${displayName} (${source} ${n})`
        n += 1
      }
    }
    used.set(label, source)
    return label
  }
  const claimedBuiltins = builtins.map(row => ({
    value: row.value,
    displayName: claim(row.value, row.displayName, 'builtin'),
  }))
  const claimedFiles = files.map(row => ({
    value: row.value,
    displayName: claim(row.value, row.displayName, 'file'),
  }))
  const claimedPlugins = plugins.map(row => ({
    value: row.value,
    displayName: claim(row.value, row.displayName, 'plugin'),
  }))
  return [...claimedBuiltins, ...claimedFiles, ...claimedPlugins]
}