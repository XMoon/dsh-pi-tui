#!/usr/bin/env node
/**
 * The EXECUTION TOPOLOGY: which script drives which leaf, which lane the
 * leaf belongs to, and which CI job runs it.
 *
 * The topology is derived from the repository's OWN declarations — the
 * package scripts, the CI workflow and the lane definitions — so it cannot
 * drift from what actually runs. The report answers the question the
 * execution-topology review asks: is every retained script responsible for
 * a distinct qualification, and is any qualification run twice?
 *
 * Usage: node scripts/execution-topology.mjs
 * @module @xmoon76/dsh-pi-tui/scripts/execution-topology
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

/** The leaf script a package script drives, when it drives exactly one. */
function leafOf(command) {
  const match = /node\s+(?:--import\s+\S+\s+)?(?:--test\s+)?([\w./-]+\.(?:mjs|mts|ts))(?:\s|$)/u.exec(command)
  if (match !== null) return match[1]
  return undefined
}

function main() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const scripts = pkg.scripts
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')

  // The CI job each `pnpm <script>` invocation belongs to.
  const ciJobs = []
  let currentJob = '(before the first job)'
  for (const line of workflow.split('\n')) {
    const job = /^  ([a-z0-9-]+):\s*$/u.exec(line)
    if (job !== null) currentJob = job[1]
    const step = /^\s+- name: (.+)$/u.exec(line)
    const run = /^\s+run: pnpm ([a-z0-9:-]+)/u.exec(line)
    if (run !== null) ciJobs.push({ job: currentJob, script: run[1], step: step?.[1] ?? '' })
  }

  const rows = []
  for (const [name, command] of Object.entries(scripts)) {
    const leaf = leafOf(command)
    const invokedBy = ciJobs.filter(job => job.script === name)
    rows.push({
      script: name,
      command,
      leaf: leaf ?? '(orchestration)',
      ci: invokedBy.map(job => `${job.job}/${job.step}`).join(', '),
    })
  }

  // A LEAF that several scripts drive is a candidate duplicate entry point.
  const byLeaf = new Map()
  for (const row of rows) {
    if (row.leaf === '(orchestration)') continue
    if (!byLeaf.has(row.leaf)) byLeaf.set(row.leaf, [])
    byLeaf.get(row.leaf).push(row.script)
  }
  const shared = [...byLeaf].filter(([, scripts_]) => scripts_.length > 1)

  console.log('=== script -> leaf -> CI job ===')
  for (const row of rows) {
    console.log(`${row.script.padEnd(28)} ${row.leaf.padEnd(46)} ${row.ci || '(not in CI)'}`)
  }
  console.log('\n=== leaves driven by more than one script ===')
  if (shared.length === 0) console.log('(none)')
  for (const [leaf, scripts_] of shared) console.log(`${leaf}: ${scripts_.join(', ')}`)

  console.log('\n=== the package scripts with no CI consumer ===')
  const inCi = new Set(ciJobs.map(job => job.script))
  const orphans = rows.filter(row => !inCi.has(row.script) && row.script.startsWith('test:'))
  for (const row of orphans) console.log(`  ${row.script}: ${row.command}`)
}

main()
