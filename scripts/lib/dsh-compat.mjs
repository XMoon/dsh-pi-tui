#!/usr/bin/env node
/**
 * The shared reader and fallback rule for the DSH/TUI compatibility matrix
 * (`src/dsh-compat-matrix.json`) — the single source also inlined into
 * `src/startup.ts`. Release tooling, the installation-doc gate and the
 * release-notes tests all read the matrix through this module so a new
 * release updates the JSON once instead of every hand-written expectation.
 *
 * @module dsh-compat
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The parsed matrix; see `src/dsh-compat-matrix.json` for the field semantics. */
export const COMPAT_MATRIX = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'dsh-compat-matrix.json'), 'utf8'),
)

/** The matrix rows a release body must document below its own line: the two
 * most recent rows that released a compatible TUI, newest first. A row without
 * a TUI is skipped (nothing to install) and so is a row sharing the current
 * line's TUI (already covered by the current install command). At most one
 * alpha row is listed: a second alpha is skipped and the next older row takes
 * its place, so the list still names two fallbacks. */
export function compatFallbacks(dshPin) {
  const currentIndex = COMPAT_MATRIX.matrix.findIndex(row => row.versions.includes(dshPin))
  if (currentIndex < 0) {
    throw new Error(`DSH ${dshPin} has no src/dsh-compat-matrix.json row; add one before publishing`)
  }
  const currentTui = COMPAT_MATRIX.matrix[currentIndex].tui
  const fallbacks = []
  for (let index = currentIndex - 1; index >= 0 && fallbacks.length < 2; index -= 1) {
    const row = COMPAT_MATRIX.matrix[index]
    if (row.tui === undefined || row.tui === currentTui) continue
    // The row's newest published version is the one a reader can pair with it.
    const dsh = row.versions[row.versions.length - 1]
    if (dsh.includes('-alpha.') && fallbacks.some(fallback => fallback.dsh.includes('-alpha.'))) continue
    fallbacks.push({ dsh, tui: row.tui })
  }
  return fallbacks
}

/** Every exact install guidance string the current release body must document:
 * the shipped DSH floor and TUI version, then each selected fallback row's
 * DSH/TUI pair. */
export function requiredGuidance(version) {
  const { upgradeDsh } = COMPAT_MATRIX.current
  return [
    `@deepseek-ai/dsh@${upgradeDsh}`,
    `@xmoon76/dsh-pi-tui@${version}`,
    ...compatFallbacks(upgradeDsh).flatMap(({ dsh, tui }) => [`@deepseek-ai/dsh@${dsh}`, `@xmoon76/dsh-pi-tui@${tui}`]),
  ]
}
