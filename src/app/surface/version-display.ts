/**
 * The welcome card's combined version line: the installed dsh version plus the
 * bundle's own version (header-badge parity — `dsh-0.2.0-rc.2 · tui-v0.5.1`).
 * Without a resolvable dsh launcher it degrades to the bundle version alone.
 *
 * Application presentation ownership: it composes the Client-local launcher
 * reads (`client/launcher/version.ts`) into the user-facing string; the reads
 * themselves stay Client-local.
 * @module @xmoon76/dsh-pi-tui/app/surface/version-display
 */

import { bundleVersion, dshVersion } from '../../client/launcher/version.ts'

/**
 * The welcome card's version line.
 * @returns the combined version string.
 */
export function versionDisplay(): string {
  const dsh = dshVersion()
  return dsh === undefined ? `tui-v${bundleVersion()}` : `dsh-${dsh} · tui-v${bundleVersion()}`
}
