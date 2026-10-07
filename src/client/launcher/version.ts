/**
 * The Client-local launcher/version reads: the installed dsh (DeepSeek
 * Harness CLI) version, resolved from the launcher's real path — `process.argv[1]`
 * is the `dsh` bin, whose realpath walks up to the `@deepseek-ai/dsh/package.json`
 * that owns it — plus the bundle's OWN version reads (`bundleVersion`,
 * `packageVersion`). The header and the welcome card show the harness the TUI
 * runs on, not this bundle's own patch level; `dshVersion` is undefined when
 * the launcher path is unreadable. The combined welcome-card display line lives
 * in the application presentation owner (`app/surface/version-display.ts`).
 *
 * This is Client-local platform IO: it reads the local process argv and the
 * locally installed package manifests. The zero-dependency startup island keeps
 * its own private comparator and never imports this module.
 * @module @xmoon76/dsh-pi-tui/client/launcher/version
 */

import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** @returns the installed dsh version string, or undefined. */
export function dshVersion(): string | undefined {
  const bin = process.argv[1]
  if (bin === undefined) return undefined
  try {
    let dir = dirname(realpathSync(bin))
    for (let depth = 0; depth < 8; depth += 1) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string }
        if (pkg.name === '@deepseek-ai/dsh' && typeof pkg.version === 'string') return pkg.version
      } catch {
        // Not a manifest directory; keep walking up.
      }
      const parent = dirname(dir)
      if (parent === dir) return undefined
      dir = parent
    }
  } catch {
    // Unreadable launcher path: fall back to the bundle version.
  }
  return undefined
}

/**
 * The bundle's own version, read from package.json at runtime so the welcome
 * card never drifts from the shipped version. The DISPLAYED version prefers
 * the installed dsh version (`dshVersion` — shared with the header badge),
 * falling back to this one.
 * @returns the version string, or a fallback when the file is unreadable.
 */
export function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version?: string }
    return dshVersion() ?? pkg.version ?? '0.0.0'
  } catch {
    return dshVersion() ?? '0.0.0'
  }
}

/**
 * The BUNDLE's OWN version (`@xmoon76/dsh-pi-tui`'s package.json),
 * INDEPENDENT of the installed dsh version. The status snapshot's
 * host.tuiVersion and the footer's `version(format=tui)` item must report
 * the TUI's own patch level — the welcome-card helper above deliberately
 * prefers the dsh version for display, so reusing it made `tui` show the
 * harness version (and `both` show the dsh version twice) inside a real
 * dsh installation (the review's P2).
 * @returns the bundle version string, or a fallback when the file is unreadable.
 */
export function bundleVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}
