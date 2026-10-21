/**
 * Client-local custom theme file IO + trust boundary (TS8-E): discovery,
 * safe-name validation, JSON/schema validation, base inheritance and the
 * contained load.
 *
 * `~/.dsh-pi-tui/themes/*.json` is a CLIENT-LOCAL convention (a theme file
 * lives on the Client filesystem, never the Host workspace). The untrusted
 * persisted `file:<name>` value is validated against the directory-local
 * basename guard BEFORE any path is constructed, so the guard and the
 * filesystem loader stay one owner.
 * @module @xmoon76/dsh-pi-tui/client/theme/files
 */

import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { darkColors, lightColors, withSearchCurrentTokens, type ColorPalette } from '../../domain/display/theme.ts'

/** One custom theme file: optional base palette plus color overrides. */
export interface CustomThemeFile {
  /** Display name, echoed in the theme picker. */
  name: string
  /** Base palette to inherit unset tokens from; defaults to dark. */
  base?: 'dark' | 'light'
  /** Token overrides; any subset of {@link ColorPalette}. */
  colors?: Partial<ColorPalette>
}

/** Build a full palette from a custom theme file (base + overrides). */
export function resolveCustomTheme(file: CustomThemeFile): ColorPalette {
  const base = file.base === 'light' ? lightColors : darkColors
  return withSearchCurrentTokens({ ...base, ...file.colors })
}

/** Custom-theme directory convention: `~/.dsh-pi-tui/themes/*.json`. */
export function customThemesDir(): string {
  return join(homedir(), '.dsh-pi-tui', 'themes')
}

/** Names of the custom theme files (basename without the extension). */
export function customThemeNames(): string[] {
  try {
    return readdirSync(customThemesDir())
      .filter(file => file.endsWith('.json'))
      .map(file => file.slice(0, -'.json'.length))
  } catch {
    return []
  }
}

/** Hex colour format: `#rgb`, `#rrggbb`, or `#rrggbbaa`. */
const COLOR_FORMAT = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([0-9a-fA-F]{2})?$/

/** The token names a custom theme may override. */
const PALETTE_KEYS: readonly (keyof ColorPalette)[] = [
  'primary', 'accent', 'text', 'textStrong', 'textDim', 'textMuted', 'border',
  'borderFocus', 'success', 'warning', 'error',
  'diffAdded', 'diffRemoved', 'diffAddedStrong', 'diffRemovedStrong',
  'diffGutter', 'diffMeta',
  'roleUser', 'roleUserBg', 'shellMode',
  'searchCurrentFg', 'searchCurrentBg', 'searchAnchorBg',
]

/**
 * Runtime schema validation for a custom theme file: the keys must be a
 * known token subset, every value a hex colour, and `base` one of the
 * built-in families. An invalid file resolves to undefined (callers fall
 * back and notify once), never a half-parsed palette.
 * @param value - the parsed JSON value.
 * @returns the validated theme file, or undefined.
 */
export function validateCustomTheme(value: unknown): CustomThemeFile | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const file = value as Record<string, unknown>
  if (typeof file.name !== 'string' || file.name.trim() === '') return undefined
  if (file.base !== undefined && file.base !== 'dark' && file.base !== 'light') return undefined
  const colors = file.colors
  if (colors !== undefined) {
    if (typeof colors !== 'object' || colors === null || Array.isArray(colors)) return undefined
    for (const [key, token] of Object.entries(colors)) {
      if (!PALETTE_KEYS.includes(key as keyof ColorPalette)) return undefined
      if (typeof token !== 'string' || !COLOR_FORMAT.test(token)) return undefined
    }
  }
  return {
    name: file.name,
    ...file.base === undefined ? {} : { base: file.base },
    ...colors === undefined ? {} : { colors: colors as Partial<ColorPalette> },
  }
}

/** Whether one custom theme NAME is a safe directory-local basename. The
 * name reaches `loadCustomTheme` from UNTRUSTED persisted input (a
 * `file:<name>` settings value survives reloads), so a traversal value
 * (`..`, a path separator) must never construct a path outside the themes
 * directory. Also enforced by the resolved-path containment check below —
 * this guard is the first line (a rejected name never touches the fs).
 * @param name - the bare theme name (no `.json` suffix).
 */
export function isSafeCustomThemeName(name: string): boolean {
  if (name === '' || name === '.' || name === '..') return false
  if (name.includes('/') || name.includes('\\')) return false
  // Control characters (including NUL) and DEL never appear in a legitimate
  // file name and could smuggle separators on exotic filesystems.
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

/** Load and resolve one custom theme file, or undefined when
 * missing/broken/UNSAFE (a name that is not a directory-local basename is
 * rejected before any path is constructed — a corrupted or hand-edited
 * persisted `file:../../x` value must not read outside the themes
 * directory). */
export function loadCustomTheme(name: string): ColorPalette | undefined {
  if (!isSafeCustomThemeName(name)) return undefined
  try {
    const dir = customThemesDir()
    const path = join(dir, `${name}.json`)
    // Belt: a symlink inside the themes directory pointing OUTSIDE it is
    // not honored (the themes directory is the trust boundary). A missing
    // file (realpath ENOENT) keeps the ordinary undefined fallback.
    if (realpathSync(dir) !== dirname(realpathSync(path))) return undefined
    const raw = readFileSync(path, 'utf8')
    const file = validateCustomTheme(JSON.parse(raw))
    return file === undefined ? undefined : resolveCustomTheme(file)
  } catch {
    return undefined
  }
}
