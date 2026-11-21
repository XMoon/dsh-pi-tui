/**
 * The Client-local launcher/version reads: the installed DSH (DeepSeek
 * Harness) runtime version and the bundle's OWN version. The header, welcome
 * card, status footer and About page show the harness this Client runs on, not
 * this bundle's own patch level; `dshVersion` is undefined when the installed
 * runtime identity is unreadable.
 *
 * Direct: `process.argv[1]` is the `dsh` bin, whose realpath walks up to the
 * `@deepseek-ai/dsh/package.json` that owns it. Split surface Client: argv[1]
 * is `dist/local-client.mjs`, so the version comes ONLY from the official
 * Profile launcher's `SPLIT_PROCESS_DSH_ANCHOR` manifest — never from argv or
 * this bundle's manifest.
 *
 * This is Client-local platform IO: it reads the local process environment and
 * installed package manifests. The zero-dependency startup island keeps its
 * own private comparator and never imports this module.
 * @module @xmoon76/dsh-pi-tui/client/launcher/version
 */

import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Read one JSON object manifest; an unreadable path, malformed JSON or a
 * non-object root is unavailable. */
function readManifestObject(path: string): Record<string, unknown> | undefined {
  try {
    const manifest: unknown = JSON.parse(readFileSync(realpathSync(path), 'utf8'))
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return undefined
    return manifest as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** @returns the installed dsh runtime version string, or undefined. */
export function dshVersion(): string | undefined {
  // The real Split surface Client is the ONLY branch whose argv[1] is not a
  // DSH launcher. Its ONE trusted source is the install anchor the official
  // Profile launcher placed in this process's environment; no argv or bundle
  // fallback is allowed when that anchor is absent or invalid.
  if (process.env.SPLIT_PROCESS_CLIENT_MODE === 'surface') {
    const anchor = process.env.SPLIT_PROCESS_DSH_ANCHOR
    if (anchor === undefined || anchor === '') return undefined
    const manifest = readManifestObject(anchor)
    return manifest?.name === '@deepseek-ai/dsh'
      && typeof manifest.version === 'string'
      && manifest.version !== ''
      ? manifest.version
      : undefined
  }
  const bin = process.argv[1]
  if (bin === undefined) return undefined
  try {
    let dir = dirname(realpathSync(bin))
    for (let depth = 0; depth < 8; depth += 1) {
      const pkg = readManifestObject(join(dir, 'package.json'))
      if (pkg?.name === '@deepseek-ai/dsh' && typeof pkg.version === 'string') return pkg.version
      const parent = dirname(dir)
      if (parent === dir) return undefined
      dir = parent
    }
  } catch {
    // Unreadable launcher path: unavailable.
  }
  return undefined
}

/**
 * The bundle's OWN manifest version (`@xmoon76/dsh-pi-tui`), resolved by
 * walking up from THIS module's directory instead of assuming a fixed depth:
 * the source layout (`src/client/launcher/**`, the depth TS8-F2 introduced)
 * and the flat packed layout (`dist/*.mjs`) both reach the shipped manifest,
 * and an installed copy reaches its own `node_modules` manifest first.
 * @returns the version string, or undefined when no own manifest is reachable.
 */
function ownBundleVersion(): string | undefined {
  let dir = import.meta.dirname
  for (let depth = 0; depth < 8; depth += 1) {
    const pkg = readManifestObject(join(dir, 'package.json'))
    if (pkg?.name === '@xmoon76/dsh-pi-tui' && typeof pkg.version === 'string') return pkg.version
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/**
 * The BUNDLE's OWN version (`@xmoon76/dsh-pi-tui`'s package.json),
 * INDEPENDENT of the installed dsh version. This is the ONE TUI bundle version
 * semantic consumed by the header/welcome card, About, `boot.bundle` and the
 * extension host's own version.
 * @returns the bundle version string, or a fallback when the file is unreadable.
 */
export function bundleVersion(): string {
  return ownBundleVersion() ?? '0.0.0'
}
