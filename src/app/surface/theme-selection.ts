/**
 * Cross-source theme SELECTION composition (TS8-E): resolve one
 * source-qualified selectable value to its palette (a custom file through the
 * Client-local loader, a plugin theme through the extension registry's
 * structural read view) and derive the source-qualified picker rows.
 *
 * The pure identity grammar lives in `domain/display/theme-selection.ts` and
 * the Client-local file IO in `client/theme/files.ts`. The registry is consumed
 * through the narrow public `TuiThemeRegistryView` — never the concrete
 * `ThemeRegistry` class.
 * @module @xmoon76/dsh-pi-tui/app/surface/theme-selection
 */

import type { TuiThemeRegistryView } from '../../extension/public-types.ts'
import type { ColorPalette } from '../../domain/display/theme.ts'
import {
  fileThemeNameOf,
  fileThemeValue,
  isFileThemeValue,
  isPluginThemeValue,
} from '../../domain/display/theme-selection.ts'
import { customThemeNames, isSafeCustomThemeName, loadCustomTheme } from '../../client/theme/files.ts'

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
  themes: TuiThemeRegistryView | undefined,
): ResolvedThemeSelection | undefined {
  if (isFileThemeValue(value)) {
    const name = fileThemeNameOf(value)
    // UNTRUSTED INPUT (the review's P2): a `file:<name>` value survives in
    // the persisted settings document, so the name is validated as a
    // directory-local basename BEFORE any path is constructed — a
    // `file:../../x` value resolves nothing (the deterministic missing
    // theme fallback), never a file outside the themes directory.
    // loadCustomTheme enforces the same guard at the fs seam.
    if (!isSafeCustomThemeName(name)) return undefined
    const palette = loadCustomTheme(name)
    return palette === undefined ? undefined : { kind: 'file', name, palette }
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
export function themePickerRows(themes: TuiThemeRegistryView | undefined): readonly {
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
    displayName: string,
    source: 'builtin' | 'file' | 'plugin',
  ): string => {
    // ANY taken label forces a new unique one — regardless of whether the
    // previous holder is the SAME source (the review's P3/P2: a generated
    // `X (plugin)` suffix label can collide with ANOTHER plugin's real
    // display name `X (plugin)`; original names are unique within a source
    // by the registry/filesystem, but GENERATED labels have no such
    // guarantee). Keep tagging until the label is unique.
    if (!used.has(displayName)) {
      used.set(displayName, source)
      return displayName
    }
    // The plain label is taken: tag with the source, then keep tagging
    // until unique (a file may already be named `X (plugin)`; the suffix
    // is a label, never an identity).
    let label = `${displayName} (${source})`
    let n = 2
    while (used.has(label)) {
      label = `${displayName} (${source} ${n})`
      n += 1
    }
    used.set(label, source)
    return label
  }
  const claimedBuiltins = builtins.map(row => ({
    value: row.value,
    displayName: claim(row.displayName, 'builtin'),
  }))
  const claimedFiles = files.map(row => ({
    value: row.value,
    displayName: claim(row.displayName, 'file'),
  }))
  const claimedPlugins = plugins.map(row => ({
    value: row.value,
    displayName: claim(row.displayName, 'plugin'),
  }))
  return [...claimedBuiltins, ...claimedFiles, ...claimedPlugins]
}
