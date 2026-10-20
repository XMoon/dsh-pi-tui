#!/usr/bin/env node
/**
 * The REVIEWED migration manifest: the reviewed owner of every remaining
 * test file, and the move list for one group at a time.
 *
 * The classification was produced by `scripts/classify-test-ownership.mjs`
 * and then REVIEWED file by file: every proposal that the classifier marked
 * ambiguous was checked against the test's own header (the contract it
 * claims) and the production module it exercises. The corrections are
 * recorded here, so the manifest IS the review result.
 *
 * Usage:
 *   node scripts/build-migration-manifest.mjs            # write the manifest
 *   node scripts/build-migration-manifest.mjs <owner>    # write one group
 * @module @xmoon76/dsh-pi-tui/scripts/build-migration-manifest
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { discoverTestFiles } from './test-discovery.mjs'
import { proposeOwner } from './classify-test-ownership.mjs'

const TEST_ROOT = join(process.cwd(), 'test')

/**
 * The REVIEWED corrections: the files the classifier placed by import
 * evidence alone, whose real contract the header names differently.
 *
 * Each entry is `file -> owner`, with the reason the review gave.
 */
export const REVIEWED_CORRECTIONS = {
  // The TUI editor host subclass and the picker it drives: terminal
  // interaction and rendering, not a runtime adapter.
  'model-picker.test.ts': 'tui',
  'tui-editor.test.ts': 'tui',
  // The Direct session content search: the Direct adapter's own business
  // semantics, not a cross-adapter parity proof.
  'session-search-direct.test.ts': 'runtime/direct',
  // The Focus Mode disclosure and the fullscreen viewport policy: terminal
  // presentation, not an adapter contract.
  'focus-anchor.test.ts': 'tui',
  'focus-viewport-policy.test.ts': 'tui',
  'focus-mounted-batch-refresh.test.ts': 'tui',
  // The input experience (editor keybindings, history recall, the local
  // shell card): terminal interaction.
  'input-experience.test.ts': 'tui',
  'keybinding-ui-controller.test.ts': 'tui',
  // The subagent model-selection picker: terminal presentation.
  'subagent-model-menu.test.ts': 'tui',
  // The preset wiring: the application-level preset authority.
  'preset.test.ts': 'app',
  // The interaction settlement hardening and the port contracts: the
  // application's own interaction authority.
  'interaction-settlement-hardening.test.ts': 'app',
  'interaction-port.test.ts': 'app',
  'host-command-port.test.ts': 'app',
  'host-user-shell-direct.test.ts': 'app',
  'pending-input-reader.test.ts': 'app',
  'subagent-port.test.ts': 'app',
  'session-lifecycle-port.test.ts': 'app',
  'session-reader-port.test.ts': 'app',
  'session-writer-port.test.ts': 'app',
  'catalog-port.test.ts': 'app',
  'config-port.test.ts': 'app',
  'credential-events.test.ts': 'app',
  'diagnostics.test.ts': 'app',
  'job-controller-composition.test.ts': 'app',
  'initial-catalog.test.ts': 'app',
  'generation-cache.test.ts': 'app',
  'application-runtime-selection.test.ts': 'app',
  'runtime-backend.test.ts': 'app',
  'direct-backend-assembly.test.ts': 'app',
  'disposal.test.ts': 'app',
  'assistant-stream-direct.test.ts': 'runtime/direct',
  'direct-owned-session-retirement.test.ts': 'runtime/direct',
  'direct-session-fork.test.ts': 'runtime/direct',
  'direct-surface-authority-reader.test.ts': 'runtime/direct',
  'direct-working-directory-rc2.test.ts': 'runtime/direct',
  'job-observation-direct.test.ts': 'runtime/direct',
  'plugin-manager-direct.test.ts': 'runtime/direct',
  'plugin-manager-live-tool.test.ts': 'runtime/direct',
  'session-archive-direct.test.ts': 'runtime/direct',
  'session-status-projection.test.ts': 'runtime/direct',
  'web-provider-config-direct.test.ts': 'runtime/direct',
  'web-provider-rc2-integration.test.ts': 'runtime/direct',
  's4-d2-projections-workflow.test.ts': 'runtime/direct',
  'request-time-zone-child.test.ts': 'runtime/direct',
  'tern-tsp-model-profile.test.ts': 'runtime/direct',
  'tern-tsp-preset-runner.test.ts': 'runtime/direct',
  'tern-tsp-session-browser-commands.test.ts': 'runtime/direct',
  'job-observation-parity.test.ts': 'runtime/parity',
  'remote-surface-authority-shadow.test.ts': 'runtime/parity',
}

/** The runtime adapter a test exercises, read from its own name and header. */
function runtimeAdapter(rel, source) {
  if (/-parity\b/u.test(rel) || /\bparity\b/u.test(source.slice(0, 1_500))) return 'parity'
  if (/^remote-|^runner-remote-|^performance-host-remote-/u.test(rel)) return 'remote'
  return 'direct'
}

/** The reviewed owner of every remaining test file. */
export function reviewedOwners() {
  const files = discoverTestFiles(TEST_ROOT, ['.test.ts', '.test.mjs'])
    .filter(rel => !rel.includes('/'))
  const owners = {}
  for (const rel of files) {
    const source = readFileSync(join(TEST_ROOT, rel), 'utf8')
    if (rel in REVIEWED_CORRECTIONS) {
      owners[rel] = REVIEWED_CORRECTIONS[rel]
      continue
    }
    const proposal = proposeOwner(rel, source)
    let owner = proposal.owner
    if (owner === 'unclassified') owner = 'integration'
    if (owner === 'runtime') owner = `runtime/${runtimeAdapter(rel, source)}`
    owners[rel] = owner
  }
  return owners
}

function main() {
  const owners = reviewedOwners()
  const groups = new Map()
  for (const [rel, owner] of Object.entries(owners)) {
    if (!groups.has(owner)) groups.set(owner, [])
    groups.get(owner).push(rel)
  }
  const requested = process.argv[2]
  if (requested !== undefined) {
    const group = groups.get(requested)
    if (group === undefined) {
      console.error(`unknown owner: ${requested}\nowners: ${[...groups.keys()].join(', ')}`)
      process.exit(2)
    }
    const moves = {}
    for (const rel of group) moves[rel] = `${requested}/${rel}`
    writeFileSync('/tmp/group-moves.json', `${JSON.stringify({ moves }, null, 1)}\n`)
    console.log(`${requested}: ${group.length} file(s) -> /tmp/group-moves.json`)
    return
  }
  for (const [owner, group] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${String(group.length).padStart(4)}  ${owner}`)
  }
  writeFileSync('/tmp/reviewed-owners.json', `${JSON.stringify(owners, null, 1)}\n`)
}

main()
