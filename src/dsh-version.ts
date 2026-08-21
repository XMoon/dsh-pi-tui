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

/** One parsed semver (core numbers + optional prerelease identifiers). */
interface ParsedVersion {
  nums: number[]
  pre: string[]
}

function parseVersion(value: string): ParsedVersion {
  const [core, prerelease = ''] = value.split('-')
  return {
    nums: core.split('.').map(Number),
    pre: prerelease === '' ? [] : prerelease.split('.'),
  }
}

/**
 * Whether one semver string is >= another, prerelease-aware (semver
 * ordering: a release beats any prerelease of the same core; numeric
 * prerelease identifiers compare numerically and sort BELOW alphanumeric
 * ones). Used by the startup compatibility gate to decide whether the
 * installed harness satisfies the minimum dsh version.
 */
export function versionAtLeast(version: string, minimum: string): boolean {
  const a = parseVersion(version)
  const b = parseVersion(minimum)
  for (let i = 0; i < 3; i += 1) {
    const pa = a.nums[i] ?? 0
    const pb = b.nums[i] ?? 0
    if (pa !== pb) return pa > pb
  }
  if (a.pre.length === 0) return true
  if (b.pre.length === 0) return false
  const length = Math.max(a.pre.length, b.pre.length)
  for (let i = 0; i < length; i += 1) {
    const pa = a.pre[i]
    const pb = b.pre[i]
    if (pa === undefined) return false
    if (pb === undefined) return true
    if (pa === pb) continue
    const na = Number(pa)
    const nb = Number(pb)
    const naNumeric = !Number.isNaN(na)
    const nbNumeric = !Number.isNaN(nb)
    if (naNumeric && nbNumeric) return na > nb
    if (naNumeric !== nbNumeric) return !naNumeric
    return pa > pb
  }
  return true
}
