#!/usr/bin/env node
/**
 * @xmoon76/dsh-pi-tui/scripts/check-no-session-events — CI guard for the DSH
 * Session history-reader migration.
 *
 * Two rules:
 *  A. REMOVED API: the public `Session.events` getter was removed upstream
 *     (0.1.2-alpha.4) and production code under `src/` must never read it. A
 *     stray read would typecheck against a structural mock and crash against a
 *     real Session, so this gate pins the migration statically.
 *  B. DEPRECATED SYNCHRONOUS READERS: DSH 0.1.6 deprecates
 *     `Session.eventAt()`, `Session.snapshotEvents()` and `Session.ownEvents()`.
 *     Existing production logic may remain unmigrated, but NEW calls, aliases
 *     and wrappers are prohibited. The existing debt is frozen as an EXPLICIT
 *     file + normalized call-site allowlist so a call cannot move to another
 *     file or expression (that would amount to a new call) and so a removed
 *     call must drop its allowance.
 *
 * Test fixtures under `test/` are out of scope here (tests may quote the old
 * API in migration comments); production mocks that still EXPOSE a fake
 * `events` field are caught by review of the harnesses.
 *
 * Usage:
 *   node scripts/check-no-session-events.mjs   # exit 1 listing offenders
 * @module check-no-session-events
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** `session.events` / `agent.session.events` reads (property access on a
 * session-typed receiver). The word-boundary forms deliberately do not
 * match `snapshotEvents` or `session.eventAt`. */
const SESSION_EVENTS_READ = /(?<![A-Za-z])session(?:s)?\.events\b/u

/**
 * The deprecated synchronous Session history readers (DSH 0.1.6). `\s*`
 * allows whitespace AND a line break between the method name and `(`. An
 * intervening COMMENT between the name and its `(` is not matched — an
 * explicit limitation; canonical and whitespace/newline forms are.
 */
export const DEPRECATED_READER_PATTERNS = [
  { call: 'eventAt', pattern: /\.eventAt\s*\(/u },
  { call: 'snapshotEvents', pattern: /\.snapshotEvents\s*\(/u },
  { call: 'ownEvents', pattern: /\.ownEvents\s*\(/u },
]

/**
 * The frozen compatibility-debt baseline: every EXISTING production call of a
 * deprecated synchronous history reader, keyed by file + call + NORMALIZED
 * call-site line, each with the reason it may remain this round.
 *
 * This is NOT a per-file count allowance: a call whose file, call or
 * surrounding expression changes is a DIFFERENT call site and fails until it
 * is re-reviewed; a call that disappears leaves a STALE allowance and fails
 * until the entry is removed. `ownEvents()` has no allowance — its first
 * appearance fails immediately.
 *
 * NOTE: the compatibility plan's prose baseline listed only a subset of these
 * call sites; this allowlist is derived from the ACTUAL audited tree so the
 * gate passes on it (plan §4.6: the real tree must pass the baseline).
 */
export const DEPRECATED_READER_ALLOWLIST = [
  { file: 'src/index.ts', call: 'snapshotEvents', site: 'let observedEvents: readonly SessionEvent[] = initialChild?.snapshotEvents() ?? []', why: 'Direct child-viewer observed history seed' },
  { file: 'src/index.ts', call: 'snapshotEvents', site: 'const durableEvents = mergeSessionEventCut(currentChild?.snapshotEvents() ?? observedEvents, opening.events)', why: 'Direct child-viewer durable history merge' },
  { file: 'src/index.ts', call: 'snapshotEvents', site: '? agent.session.snapshotEvents()', why: 'Direct resume history branch' },
  { file: 'src/index.ts', call: 'snapshotEvents', site: ': mergeSessionEventCut(agent.session.snapshotEvents(), opening.events)', why: 'Direct resume history merge branch' },
  { file: 'src/index.ts', call: 'snapshotEvents', site: 'const candidates = collectRewindCandidates(source.session.snapshotEvents())', why: 'Direct rewind candidate fold' },
  // A3-2 relocated the two command-fact reads from commands.ts into the
  // scope-bound facade providers (the Direct implementation is now localized
  // in the runner); the debt moved WITH the call site, never doubled. A3-5
  // relocated the provider bodies into the runner's command-runtime surface
  // hooks, so the same two call sites now read through `attachmentForSession`.
  { file: 'src/index.ts', call: 'snapshotEvents', site: 'sessionStats: (sessionId) => computeStats(attachmentForSession(sessionId).session.snapshotEvents()),', why: '/status Direct stats fold over the in-process session log (A3-5 command-runtime surface hook)' },
  { file: 'src/index.ts', call: 'eventAt', site: 'const event = session.eventAt(SessionSeq(seq))', why: '/copy last assistant-message read over the Direct in-process session log (A3-2 facade provider)' },
  // A4-7 relocated the compaction-settle working read into the injected
  // `currentWorkingFromLog` capability (the surface owns only the WHEN); the
  // debt moved WITH the call site, never doubled. The surface never reads the
  // live session log itself.
  { file: 'src/index.ts', call: 'snapshotEvents', site: 'return agent === undefined ? false : workingFromLog(agent.session.snapshotEvents())', why: 'Direct compaction-end context re-measure from the in-process log (A4-7 injected capability)' },
  { file: 'src/runtime/direct/model-selection-direct.ts', call: 'snapshotEvents', site: 'const folded = foldPendingModelSelection(agent.session.snapshotEvents())', why: 'Direct model-selection replay over the in-process session log' },
  { file: 'src/runtime/direct/presentation-read-direct.ts', call: 'snapshotEvents', site: 'const durableEvents = agent.session.snapshotEvents().map(event => detachedClone(event as PresentationDurableEvent))', why: 'Direct presentation read fold over the in-process session log' },
  { file: 'src/transcript.ts', call: 'snapshotEvents', site: 'for (const event of session.snapshotEvents()) {', why: 'Direct full transcript reconstruction from the in-process log' },
]

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

/** The production source files this gate scans: `src/**` only, never `test/`. */
export function collectSourceFiles(root = ROOT) {
  return collect(join(root, 'src'))
}

/** Normalize one source line for the allowlist key: trimmed, single-spaced. */
function normalizeSite(line) {
  return line.trim().replace(/\s+/gu, ' ')
}

/** The repo-relative POSIX label of one scanned file. */
function fileLabel(path, root) {
  return relative(root, path).split(sep).join('/')
}

/**
 * Scan one source tree for the removed `Session.events` read.
 * @param files - absolute .ts paths to scan.
 * @returns the offenders as records.
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

/**
 * Scan source files for the deprecated synchronous history readers.
 *
 * Scans the WHOLE FILE (not line-by-line) so a whitespace/newline form between
 * the method name and `(` is still detected; the reported `site` is the
 * normalized line that carries the call.
 * @param files - absolute .ts paths to scan.
 * @param options - `root` used for the repo-relative file label (injectable for tests).
 * @returns one record per call site (`file`, `call`, `line`, normalized `site`, raw `text`).
 */
export function scanDeprecatedReaders(files, { root = ROOT } = {}) {
  const offenders = []
  for (const path of files) {
    const content = readFileSync(path, 'utf8')
    const file = fileLabel(path, root)
    const sourceLines = content.split('\n')
    for (const { call, pattern } of DEPRECATED_READER_PATTERNS) {
      const regex = new RegExp(pattern.source, 'gu')
      let match
      while ((match = regex.exec(content)) !== null) {
        const line = content.slice(0, match.index).split('\n').length
        const text = sourceLines[line - 1] ?? ''
        offenders.push({ file, call, line, site: normalizeSite(text), text: text.trim() })
      }
    }
  }
  return offenders
}

/**
 * Match observed deprecated-reader call sites against the frozen allowlist.
 * @param offenders - {@link scanDeprecatedReaders} output.
 * @param allowlist - the baseline (injectable for tests).
 * @returns unallowlisted call sites and allowances with no matching call.
 */
export function classifyDeprecatedReaders(offenders, allowlist = DEPRECATED_READER_ALLOWLIST) {
  const remaining = [...allowlist]
  const unallowed = []
  for (const offender of offenders) {
    const index = remaining.findIndex(entry =>
      entry.file === offender.file && entry.call === offender.call && entry.site === offender.site)
    if (index === -1) unallowed.push(offender)
    else remaining.splice(index, 1)
  }
  return { unallowed, stale: remaining }
}

function main() {
  const files = collectSourceFiles()
  const failures = []
  for (const offender of scanSessionEvents(files)) {
    failures.push(`${relative(ROOT, offender.file)}:${offender.line}: ${offender.text}`)
  }
  const readers = classifyDeprecatedReaders(scanDeprecatedReaders(files))
  for (const offender of readers.unallowed) {
    failures.push(`${offender.file}:${offender.line}: ${offender.text}`)
  }
  for (const entry of readers.stale) {
    failures.push(`STALE ALLOWANCE ${entry.file} (${entry.call}): ${entry.site}`)
  }
  if (failures.length > 0) {
    console.error('check-no-session-events: FAILED')
    console.error('  Session.events is removed, and since DSH 0.1.6 Session.eventAt/snapshotEvents/ownEvents are deprecated.')
    console.error('  New production logic must use Session projections / the current event / official Client observation;')
    console.error('  a genuine full-history read needs an explicit async history/storage seam.')
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exitCode = 1
    return
  }
  console.error(`check-no-session-events: ok (Session.events absent; ${DEPRECATED_READER_ALLOWLIST.length} frozen deprecated-reader debt call site(s))`)
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (invokedDirectly) main()
