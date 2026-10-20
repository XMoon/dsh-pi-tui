#!/usr/bin/env node
/**
 * Apply the shared app-lifecycle teardown guard to the files whose local
 * implementation is IDENTICAL to the shared one.
 *
 * Only the EXACT shape is replaced: a file whose teardown differs (an async
 * disposer, an aggregated failure, a different iteration) keeps its own
 * implementation, because unifying it would change what a failure means.
 *
 * The replacement is a TEXTUAL swap of the local block with the shared
 * guard's call, so the semantics cannot drift: the shared helper's body is
 * the local body, moved.
 *
 * Usage: node scripts/apply-app-lifecycle-guard.mjs [--dry-run]
 * @module @xmoon76/dsh-pi-tui/scripts/apply-app-lifecycle-guard
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { discoverTestFiles } from './test-discovery.mjs'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const TEST_ROOT = join(ROOT, 'test')

/**
 * The local teardown the shared guard replaces.
 *
 * The block is matched EXACTLY, with its own indentation, so a file with a
 * different shape is never touched.
 */
const LOCAL_GUARD = [
  'const startedApps = new Set<{TYPE}>()',
  'afterEach(() => {',
  '  for (const app of [...startedApps]) {',
  '    startedApps.delete(app)',
  '    if (app.isDisposed()) continue',
  '    try { app.dispose() } catch {}',
  '  }',
  '})',
].join('\n')

function main() {
  const dryRun = process.argv.includes('--dry-run')
  const files = discoverTestFiles(TEST_ROOT, ['.test.ts'])
  let changed = 0
  let kept = 0
  for (const rel of files) {
    const path = join(TEST_ROOT, rel)
    const source = readFileSync(path, 'utf8')
    if (!source.includes('startedApps')) continue
    const typeMatch = /const startedApps = new Set<([^>]+)>\(\)/u.exec(source)
    if (typeMatch === null) { kept += 1; continue }
    const local = LOCAL_GUARD.replace('{TYPE}', typeMatch[1])
    if (!source.includes(local)) { kept += 1; continue }
    const replacement = [
      `const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<${typeMatch[1]}>()`,
      'afterEach(() => {',
      '  disposeStartedApps()',
      '})',
    ].join('\n')
    const withGuard = source.replace(local, replacement)
    const importPath = rel.includes('/') ? '../support/app-lifecycle-guard.ts' : './support/app-lifecycle-guard.ts'
    const withImport = withGuard.replace(
      /^(import .*\n)/mu,
      `$1import { createAppLifecycleGuard } from '${importPath}'\n`,
    )
    if (withImport === source) { kept += 1; continue }
    if (!dryRun) writeFileSync(path, withImport)
    changed += 1
  }
  console.log(`${dryRun ? 'would replace' : 'replaced'} ${changed} local guard(s); ${kept} file(s) keep their own`)
}

main()
