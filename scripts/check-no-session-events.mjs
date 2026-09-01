#!/usr/bin/env node
/**
 * @xmoon76/dsh-pi-tui/scripts/check-no-session-events — CI guard for the
 * DSH 0.1.2-alpha.4 Session API migration: the public `Session.events`
 * getter was REMOVED upstream (replaced by `seq` / `eventAt(seq)` /
 * `snapshotEvents(from?, toExclusive?)`), so production code under `src/`
 * must never read `session.events` again. A stray read would typecheck
 * against a structural mock and slip through the unit suite, then crash
 * at runtime against a real Session — this gate pins the migration
 * statically.
 *
 * Test fixtures under `test/` are out of scope here (tests may quote the
 * old API in migration comments); production mocks that still EXPOSE a
 * fake `events` field are caught by review of the harnesses, and the
 * fixtures in the runner-level suites deliberately serve only the
 * alpha.4 snapshot API.
 *
 * Usage:
 *   node scripts/check-no-session-events.mjs   # exit 1 listing offenders
 * @module check-no-session-events
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')

/** `session.events` / `agent.session.events` reads (property access on a
 * session-typed receiver). The word-boundary forms deliberately do not
 * match `snapshotEvents` or `session.eventAt`. */
const SESSION_EVENTS_READ = /(?<![A-Za-z])session(?:s)?\.events\b/u

/** Collect the .ts files of one directory tree (src only; no fixtures). */
function collect(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...collect(path))
    else if (entry.name.endsWith('.ts')) files.push(path)
  }
  return files
}

/**
 * Scan one source tree for the removed `Session.events` read.
 * @param files - absolute .ts paths to scan.
 * @returns the offenders as `file:line` records.
 */
export function scanSessionEvents(files) {
  const offenders = []
  for (const path of files) {
    const lines = readFileSync(path, 'utf8').split('\n')
    lines.forEach((line, index) => {
      if (SESSION_EVENTS_READ.test(line)) {
        offenders.push({ file: path, line: index + 1, text: line.trim() })
      }
    })
  }
  return offenders
}

function main() {
  const offenders = scanSessionEvents(collect(SRC))
  if (offenders.length > 0) {
    console.error('check-no-session-events: DSH alpha.4 removed Session.events; use seq/eventAt/snapshotEvents instead:')
    for (const offender of offenders) {
      console.error(`  ${relative(ROOT, offender.file)}:${offender.line}: ${offender.text}`)
    }
    process.exitCode = 1
    return
  }
  console.error('check-no-session-events: ok (src/ is free of the removed Session.events API)')
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (invokedDirectly) main()
