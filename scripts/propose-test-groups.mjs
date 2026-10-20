#!/usr/bin/env node
/**
 * Propose the migration GROUPS for the remaining test files, and print the
 * move list for each group as JSON.
 *
 * The proposal is a REVIEW AID. Each group is small enough to review
 * (roughly 20-60 files), owner-coherent, and independently revertable.
 *
 * Usage: node scripts/propose-test-groups.mjs
 * @module @xmoon76/dsh-pi-tui/scripts/propose-test-groups
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { discoverTestFiles } from './test-discovery.mjs'
import { proposeOwner } from './classify-test-ownership.mjs'

const TEST_ROOT = join(process.cwd(), 'test')

/** The runtime adapter a test exercises, read from its own name and header. */
function runtimeAdapter(rel, source) {
  if (/-parity\b/u.test(rel) || /\bparity\b/u.test(source.slice(0, 1_500))) return 'parity'
  if (/^remote-|^runner-remote-|^performance-host-remote-/u.test(rel)) return 'remote'
  if (/direct/u.test(rel)) return 'direct'
  return 'direct'
}

function main() {
  const files = discoverTestFiles(TEST_ROOT, ['.test.ts', '.test.mjs'])
    .filter(rel => !rel.includes('/'))
  const groups = new Map()
  for (const rel of files) {
    const source = readFileSync(join(TEST_ROOT, rel), 'utf8')
    const proposal = proposeOwner(rel, source)
    let owner = proposal.owner
    if (owner === 'unclassified') owner = 'integration'
    if (owner === 'runtime') {
      owner = `runtime/${runtimeAdapter(rel, source)}`
    }
    if (!groups.has(owner)) groups.set(owner, [])
    groups.get(owner).push(rel)
  }
  const manifest = {}
  for (const [owner, group] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    manifest[owner] = group
    console.log(`${String(group.length).padStart(4)}  ${owner}`)
  }
  writeFileSync('/tmp/proposed-groups.json', `${JSON.stringify(manifest, null, 1)}\n`)
  console.log('\nwrote /tmp/proposed-groups.json')
}

main()
