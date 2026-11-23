/**
 * The ONE ACP SDK version fact shared by the split-process qualification:
 * the exact dependency this candidate was built with, and the version the
 * running process actually resolved. They must agree (the lockfile is frozen),
 * and no case may hardcode a historical pin as its evidence.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The exact `@agentclientprotocol/sdk` dependency pinned by this repository. */
export function pinnedSdkVersion() {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
    .dependencies?.['@agentclientprotocol/sdk']
}

/**
 * The version of the package that actually resolved. The root export moved to
 * `dist/v1/stable` in 2.9.1, so a fixed relative depth is not a fact: walk up to
 * the manifest that names THIS package.
 */
export function installedSdkVersion() {
  let dir = dirname(fileURLToPath(import.meta.resolve('@agentclientprotocol/sdk')))
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (manifest.name === '@agentclientprotocol/sdk') return manifest.version
    } catch {
      // Not a manifest here; keep walking up to the installed package root.
    }
    const parent = dirname(dir)
    if (parent === dir) throw new Error('the resolved @agentclientprotocol/sdk has no manifest')
    dir = parent
  }
}
