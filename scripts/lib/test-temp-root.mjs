/**
 * Choose an owned test-runner temp root outside this checkout.
 *
 * Test fixtures use TMPDIR as their default base, while the Source Pack
 * explicitly refuses outputs inside the TUI checkout. An ambient TMPDIR under
 * the checkout must therefore not become the runner's inherited TMPDIR.
 * Preserve a safe ambient base; otherwise use a system temp base. All
 * containment decisions use canonical paths (including symlinked TMPDIR).
 */

import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'

function pathInside(path, parent) {
  const rel = relative(parent, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Create an independent runner-owned directory; never return a checkout child. */
export function createTestTempRoot(checkoutRoot) {
  const checkout = realpathSync(checkoutRoot)
  const fallbackBases = process.platform === 'win32'
    ? [
        ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Temp')] : []),
        join(process.env.SystemRoot ?? 'C:\\Windows', 'Temp'),
      ]
    : ['/tmp', '/var/tmp']
  const rejected = []

  for (const candidate of new Set([tmpdir(), ...fallbackBases])) {
    let base
    try {
      base = realpathSync(candidate)
    } catch (error) {
      rejected.push(`${candidate}: ${error.message}`)
      continue
    }
    if (pathInside(base, checkout)) {
      rejected.push(`${candidate}: inside TUI checkout`)
      continue
    }
    try {
      return realpathSync(mkdtempSync(join(base, 'dsh-pi-tui-test-run-')))
    } catch (error) {
      rejected.push(`${candidate}: ${error.message}`)
    }
  }

  throw new Error(`TEST_TMPDIR_INFRA_FAILURE: cannot create an isolated test root outside ${checkout}; ${rejected.join('; ')}`)
}
