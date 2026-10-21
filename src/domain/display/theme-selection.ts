/**
 * The persisted theme-selection identity grammar (TS8-E): the source-qualified
 * selectable-value protocol — `auto|dark|light` (builtins), `file:<name>`
 * (custom files in ~/.dsh-pi-tui/themes) and `plugin:<owner>/<id>`
 * (extension-registered themes). The bare NAME is never a selection identity:
 * it is only a display label.
 *
 * This module is the pure identity grammar — no filesystem, no registry, no
 * environment. The cross-source composition (resolving a value to a palette,
 * and the picker rows) lives in `app/surface/theme-selection.ts`.
 * @module @xmoon76/dsh-pi-tui/domain/display/theme-selection
 */

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
