#!/usr/bin/env node
/**
 * The ownership CLASSIFIER: propose a production owner for every remaining
 * test file, with the evidence that produced the proposal.
 *
 * The classifier is a REVIEW AID, not the authority. It reads what a test
 * imports and what it asserts about, and proposes the owner whose contract
 * the test primarily proves. Every proposal is reviewed before it is
 * applied, and the review corrections are what the migration uses.
 *
 * The evidence is deliberately more than the import set:
 *   - the production modules the test imports (the LAYERS it touches);
 *   - the module the test's own HEADER describes (the contract it claims);
 *   - whether the test drives a real composition (the runner, the Host) or
 *     a pure semantic unit.
 *
 * @module @xmoon76/dsh-pi-tui/scripts/classify-test-ownership
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { discoverTestFiles } from './test-discovery.mjs'

const TEST_ROOT = join(process.cwd(), 'test')

/** The production layer a module belongs to. */
function layerOf(modulePath) {
  const segments = modulePath.split('/')
  if (segments.length === 1) return 'root'
  return segments[0]
}

/** The root-level production modules and the layer they belong to. */
const ROOT_MODULE_LAYER = {
  'tui-app.ts': 'tui',
  'transcript.ts': 'domain',
  'commands.ts': 'app',
  'index.ts': 'app',
  'startup.ts': 'app',
  'extensions.ts': 'extension',
  'builtins.ts': 'extension',
  'diff.ts': 'domain',
  'diagnostics.ts': 'runtime',
  'catalog.ts': 'app',
}

/** Every production module a test file imports. */
export function importedModules(source) {
  const modules = new Set()
  for (const match of source.matchAll(/from\s+'\.\.\/(?:\.\.\/)?src\/([^']+)'/gu)) modules.add(match[1])
  for (const match of source.matchAll(/from\s+'\.\.\/src\/([^']+)'/gu)) modules.add(match[1])
  for (const match of source.matchAll(/new URL\('\.\.\/(?:\.\.\/)?src\/([^']+)'/gu)) modules.add(match[1])
  for (const match of source.matchAll(/new URL\('\.\.\/src\/([^']+)'/gu)) modules.add(match[1])
  return [...modules]
}

/** The layers a test touches. */
export function touchedLayers(source) {
  const layers = new Set()
  for (const module of importedModules(source)) {
    const base = module.split('/').pop()
    layers.add(ROOT_MODULE_LAYER[base] ?? layerOf(module))
  }
  return [...layers].sort()
}

/**
 * Propose an owner for one test file.
 *
 * The rule is the plan's: a test is filed under the layer that owns the
 * behaviour its assertions protect. The evidence is the LAYER SET, and the
 * proposal prefers the layer that appears in the test's own HEADER (the
 * contract it claims) over the layer it merely imports.
 */
export function proposeOwner(rel, source) {
  const layers = touchedLayers(source)
  if (layers.length === 0) return { owner: 'unclassified', layers, reason: 'imports no production module' }
  if (layers.length === 1) {
    return { owner: layers[0], layers, reason: `touches only ${layers[0]}` }
  }
  // Several layers: the header names the contract, and the header is the
  // test's own statement of what it proves.
  const header = source.slice(0, 2_000)
  const named = layers.filter(layer => new RegExp(`\\b${layer}\\b`, 'u').test(header))
  if (named.length === 1) {
    return { owner: named[0], layers, reason: `the header names ${named[0]} as the contract` }
  }
  if (named.length > 1) {
    // The header names several; the FIRST (in the layer order) is the
    // primary contract, and the proposal is marked for review.
    return { owner: named[0], layers, reason: `the header names ${named.join(', ')} — needs review`, review: true }
  }
  return { owner: layers[0], layers, reason: `touches ${layers.join(', ')} — needs review`, review: true }
}

function main() {
  const files = discoverTestFiles(TEST_ROOT, ['.test.ts', '.test.mjs'])
    .filter(rel => !rel.includes('/'))
  const proposals = []
  for (const rel of files) {
    const source = readFileSync(join(TEST_ROOT, rel), 'utf8')
    proposals.push({ file: rel, ...proposeOwner(rel, source) })
  }
  const byOwner = {}
  for (const proposal of proposals) {
    byOwner[proposal.owner] ??= []
    byOwner[proposal.owner].push(proposal)
  }
  console.log('=== proposals by owner ===')
  for (const [owner, group] of Object.entries(byOwner).sort((a, b) => b[1].length - a[1].length)) {
    const review = group.filter(p => p.review === true).length
    console.log(`${String(group.length).padStart(4)}  ${owner}${review > 0 ? `  (${review} need review)` : ''}`)
  }
  console.log('\n=== the ones that need a human decision ===')
  for (const proposal of proposals) {
    if (proposal.review !== true) continue
    console.log(`${proposal.file}  -> ${proposal.owner}  (${proposal.reason})`)
  }
  console.log('\n=== the unclassified ones ===')
  for (const proposal of proposals) {
    if (proposal.owner !== 'unclassified') continue
    console.log(`${proposal.file}`)
  }
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main()
}
