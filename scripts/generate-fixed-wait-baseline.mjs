#!/usr/bin/env node
/**
 * Regenerate the New Test Policy's fixed-wait BASELINE from the tree.
 *
 * The baseline is a FLOOR: a file that is not in it cannot introduce an
 * unreasoned fixed wait, and a file in it cannot grow its count. It is
 * regenerated only when the tree's waits CHANGE on purpose — the guard
 * then fails until the baseline is regenerated deliberately.
 *
 * Usage: node scripts/generate-fixed-wait-baseline.mjs
 * @module @xmoon76/dsh-pi-tui/scripts/generate-fixed-wait-baseline
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { discoverTestFiles } from './test-discovery.mjs'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const TEST_ROOT = join(ROOT, 'test')

/** The shared FIXED-WAIT helpers, derived from the support modules. */
function fixedWaitHelpers() {
  const helpers = new Set()
  const supportRoot = join(TEST_ROOT, 'support')
  for (const entry of readdirSync(supportRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(ts|mjs)$/u.test(entry.name)) continue
    const source = readFileSync(join(supportRoot, entry.name), 'utf8')
    for (const match of source.matchAll(
      /export\s+(?:async\s+)?function\s+([a-zA-Z_$][A-Za-z0-9_$]*)\s*\([^)]*\b(?:millis|ms|delay|durationMs)\b[^)]*\)/gu,
    )) {
      helpers.add(match[1])
    }
  }
  return helpers
}

/** The unreasoned fixed waits a test file contains. */
function fixedWaitsOf(rel, helpers) {
  const source = readFileSync(join(TEST_ROOT, rel), 'utf8')
  const lines = source.split('\n')
  const found = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const literal = /setTimeout\([^,]*,\s*\d[\d_]{2,}/u.test(line)
    const helperCall = [...helpers].some(helper => {
      const pattern = new RegExp(`\\b${helper}\\s*\\(\\s*(\\d[\\d_]{2,})?\\s*\\)`, 'u')
      return pattern.test(line)
    })
    if (!literal && !helperCall) continue
    const context = `${lines[index - 1] ?? ''}\n${line}`
    if (/\/\/[^\n]*(?:reason|window|deadline|bounded|negative|observation)/iu.test(context)) continue
    found.push(index + 1)
  }
  return found
}

function main() {
  const helpers = fixedWaitHelpers()
  const fixedWaits = {}
  for (const rel of discoverTestFiles(TEST_ROOT, ['.test.ts', '.test.mjs'])) {
    const count = fixedWaitsOf(rel, helpers).length
    if (count > 0) fixedWaits[rel] = count
  }
  const sorted = {}
  for (const key of Object.keys(fixedWaits).sort()) sorted[key] = fixedWaits[key]
  const document = {
    schemaVersion: 1,
    note: 'The pre-existing fixed waits in the test tree, including the calls to the SHARED fixed-wait helpers (the helper names are derived from the support modules, so a new helper is covered automatically). The New Test Policy\'s deterministic-async rule governs NEW tests: the guard fails when a file that is NOT in this baseline introduces a fixed wait without a stated reason, and when a baseline file\'s wait count GROWS. The baseline is a floor, not a target.',
    fixedWaits: sorted,
  }
  writeFileSync(join(TEST_ROOT, 'tooling', 'new-test-policy-baseline.json'), `${JSON.stringify(document, null, 2)}\n`)
  const total = Object.values(sorted).reduce((a, b) => a + b, 0)
  console.log(`files with unreasoned fixed waits: ${Object.keys(sorted).length}; total waits: ${total}`)
  console.log(`shared wait helpers: ${[...helpers].join(', ')}`)
}

main()
