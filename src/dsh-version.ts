/**
 * The installed dsh (DeepSeek Harness CLI) version, resolved from the
 * launcher's real path: `process.argv[1]` is the `dsh` bin, whose realpath
 * walks up to the `@deepseek-ai/dsh/package.json` that owns it. The header
 * and the welcome card show the harness the TUI runs on, not this bundle's
 * own patch level. Undefined when the launcher path is unreadable.
 * @module @xmoon76/dsh-pi-tui/dsh-version
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
