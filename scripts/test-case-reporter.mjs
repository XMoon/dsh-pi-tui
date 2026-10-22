#!/usr/bin/env node
/**
 * The CASE INVENTORY reporter: the machine-readable half of the test report.
 *
 * The repository needs two things from one test run:
 *
 *   1. the HUMAN report a CI log shows — unchanged, byte-for-byte the
 *      `spec` reporter's own output;
 *   2. a MACHINE-readable record of every case — its full title, its file,
 *      its duration, its result and its source location.
 *
 * The second one is what the title policy and the CI diagnostics are built
 * on. It must therefore be derived from the SAME events the human report
 * comes from, not from a second run and not from a text scrape of the
 * report: a scraped report is a different, undocumented interface whose
 * format changes between Node versions.
 *
 * So this reporter TEE's the event stream: every event is handed to Node's
 * own `spec` reporter (the human report is therefore exactly what it would
 * have been) and, in parallel, the case-level events are written as JSONL.
 *
 * The JSONL is OPT-IN. Without `DSH_TEST_JSONL=<path>` the reporter behaves
 * exactly like the plain `spec` reporter — the default run of a lane is
 * unchanged, byte for byte.
 *
 * The record shape:
 *
 *   { "file": "<repo-relative file>", "name": "<full title>",
 *     "type": "test" | "suite", "line": <n>, "column": <n>,
 *     "nesting": <n>, "duration_ms": <n|undefined>,
 *     "result": "pass" | "fail" | "skip" | "todo" | "cancelled",
 *     "skipReason": <string|null> }
 *
 * `type` is Node's OWN classification, and the distinction matters to every
 * consumer: a `describe()` block is a SUITE, not a case, and `describe('x',
 * () => {})` reports one suite and zero tests. A file's own root entry is
 * `type: "test"` with `name === file`, which is how a file is told apart from
 * the cases inside it. A missing `type` is recorded as `test`.
 *
 * Usage: node --test --test-reporter=scripts/test-case-reporter.mjs <files>
 * @module @xmoon76/dsh-pi-tui/scripts/test-case-reporter
 */

import { createWriteStream } from 'node:fs'
import { relative } from 'node:path'
import { spec } from 'node:test/reporters'

const ROOT = new URL('..', import.meta.url)

/**
 * The JSONL destination; absent means "behave exactly like the spec
 * reporter".
 *
 * The variable is read ONCE and then REMOVED from the environment, so a
 * test that starts a nested test run does not hand that run the same
 * destination. A nested run would otherwise write its own records into
 * this run's file, and the result would be a mixture of two runs that no
 * reader could tell apart.
 */
const jsonlPath = process.env.DSH_TEST_JSONL
delete process.env.DSH_TEST_JSONL

/** The result a `test:complete` event reports, mapped to a stable token. */
function resultOf(details) {
  if (details === undefined) return 'unknown'
  if (details.skip === true) return 'skip'
  if (details.todo === true) return 'todo'
  if (details.cancelled === true) return 'cancelled'
  if (details.passed === true) return 'pass'
  return 'fail'
}

/**
 * The reason a skip/todo marker carries.
 *
 * Node's marker is a STRING when the case stated why it did not run, and
 * `true` when it did not. The distinction matters: the qualification
 * classifies reasons, so "no reason given" must be representable and must
 * not look like a reason.
 *
 * @param {unknown} marker - the marker value.
 * @returns {string|null} the reason, or null when none was given.
 */
function describeMarker(marker) {
  if (typeof marker === 'string') return marker
  if (marker === true) return null
  return null
}

export default async function reporter(source, options) {
  // The human report: Node's own `spec` reporter, fed the SAME events. The
  // output is therefore identical to a run without this reporter.
  const human = spec(options)
  // The spec reporter is a Transform whose READABLE side carries the report.
  // Nothing drains it unless a consumer is attached, so the report is piped
  // to stdout here — exactly where Node's own runner sends it.
  human.on('data', chunk => process.stdout.write(chunk))

  // The machine record: only opened when the caller asked for it.
  //
  // The file is opened EXCLUSIVELY: a nested run that inherits the
  // destination variable would otherwise append its own records into this
  // run's file, and the result would be a mixture of two runs that no
  // reader could tell apart.
  const machine = jsonlPath === undefined
    ? undefined
    : createWriteStream(jsonlPath, { flags: 'wx' })

  // The duration arrives on the `complete` event, but the `skip` / `todo`
  // flags arrive on the OUTCOME event, which Node emits AFTER the
  // completion. The completion is therefore buffered, and the record is
  // written when the outcome arrives — so a skipped case is recorded as
  // skipped, not as a fast pass.
  //
  // The buffer is a QUEUE, not a map. Node's `testId` is only unique WITHIN
  // one file, and a file's own root entry reuses the id of the file's
  // first case once the file's cases are done — so an id-keyed buffer
  // would drop or mis-pair cases in a run that covers many files. The
  // events of one file arrive in order, so a FIFO queue pairs each outcome
  // with the completion it belongs to.
  const completions = []

  // The SUITE chain, by test id.
  //
  // Node's `name` on a nested test is the node's OWN name — it does not
  // include the enclosing `describe()`. The full title a reader sees in a
  // report is the chain, so the chain is rebuilt here from the `test:start`
  // events, which carry the parent id.
  //
  // The ids are unique WITHIN one file, so the map is per file: a file's
  // own root entry reuses the id of the file's first suite.
  const suiteNames = new Map()

  const write = (record) => {
    if (machine === undefined) return
    machine.write(`${JSON.stringify(record)}\n`)
  }

  /**
   * The full title of a case: its own name plus the chain of suites.
   *
   * @param {string} file - the file the case belongs to.
   * @param {string} name - the case's own name.
   * @param {number|undefined} parentId - the enclosing suite's id.
   * @returns {string} the full title.
   */
  const fullTitle = (file, name, parentId) => {
    if (parentId === undefined) return name
    const chain = suiteNames.get(file)
    if (chain === undefined) return name
    const parts = []
    let current = parentId
    const seen = new Set()
    while (current !== undefined && current !== 0 && !seen.has(current)) {
      seen.add(current)
      const suiteName = chain.get(current)
      if (suiteName === undefined) break
      parts.unshift(suiteName)
      current = chain.get(`parent:${current}`)
    }
    return parts.length === 0 ? name : `${parts.join(' > ')} > ${name}`
  }

  const recordOf = (data, outcome) => {
    // The file is recorded in ONE form: relative to the repository root.
    // Node names a file's own root entry after the file's ABSOLUTE path,
    // so recording the file relative while the name stays absolute would
    // make the two impossible to compare — and the file entry is exactly
    // what tells a file apart from the cases inside it.
    const file = data.file === undefined ? undefined : relative(ROOT.pathname, data.file)
    return {
      file,
      name: file !== undefined && data.name === data.file
        ? file
        : fullTitle(data.file, data.name, data.parentId),
      line: data.line,
      column: data.column,
      nesting: data.nesting,
      duration_ms: data.details?.duration_ms,
      // Node's OWN type of the entry: a `describe()` block is a SUITE, a
      // `test()` is a TEST, and a file's own root entry is a FILE. The
      // nesting depth is NOT that distinction — a suite at the top level
      // has nesting 0, exactly like a plain test.
      type: data.details?.type ?? 'test',
      // The `skip` and `todo` markers carry a REASON, not a boolean: a
      // skipped case says WHY it was skipped, and that reason is the whole
      // value of the marker. So the marker is detected by its PRESENCE.
      //
      // The marker is read from the OUTCOME and from the COMPLETION: a
      // completion that never got an outcome still carries its own skip,
      // and reading only the outcome would report such a case as `pass`.
      result: outcome.skip !== undefined || data.skip !== undefined
        ? 'skip'
        : outcome.todo !== undefined || data.todo !== undefined
          ? 'todo'
          : resultOf(data.details),
      // WHY a case did not run.
      //
      // The qualification does not accept "it skipped" — it accepts a skip
      // whose REASON belongs to a pre-agreed class (a missing environment
      // capability, an unprovisioned dependency). A skip with no stated
      // reason, or one outside those classes, is a case that quietly stopped
      // being proved, and the aggregate has to be able to see that.
      //
      // Node carries the reason as the VALUE of the marker, so a marker that
      // is `true` means "skipped, reason not given" and is recorded as such.
      skipReason: describeMarker(outcome.skip ?? outcome.todo ?? data.skip ?? data.todo),
    }
  }

  for await (const event of source) {
    if (machine !== undefined) {
      if (event.type === 'test:start') {
        // The suite chain: a start event names a node and points at its
        // parent, so the chain is built as the nodes arrive.
        const chain = suiteNames.get(event.data.file) ?? new Map()
        chain.set(event.data.testId, event.data.name)
        chain.set(`parent:${event.data.testId}`, event.data.parentId)
        suiteNames.set(event.data.file, chain)
      }
      if (event.type === 'test:complete') {
        completions.push(event.data)
      } else if (event.type === 'test:pass' || event.type === 'test:fail' || event.type === 'test:skip') {
        // The outcome belongs to the OLDEST completion that is still
        // waiting, in the same file.
        const index = completions.findIndex(completion => completion.file === event.data.file)
        if (index !== -1) {
          const [completion] = completions.splice(index, 1)
          write(recordOf(completion, event.data))
        }
      }
    }
    // Hand the event to the human report as well.
    human.write(event)
  }

  // A case that completed without an outcome is still a case; it is recorded
  // with the result its own completion carries, so the inventory never
  // silently drops it.
  for (const completion of completions) {
    write(recordOf(completion, {}))
  }

  human.end()
  await new Promise(resolve => human.on('end', resolve))
  machine?.end()
  await new Promise(resolve => machine?.on('finish', resolve))
}