#!/usr/bin/env node
/**
 * The PIPELINE GUARDS: the two decisions the prototype makes about its own
 * run, kept in a script so they can be tested.
 *
 * Both of them used to be shell inside the workflow, and both of them were
 * wrong in a way shell hides:
 *
 *   - `mode` — the pipeline resolves the DSH dependency mode and then ran
 *     ANYWAY. Source Mode needs the distribution injected into the
 *     source-leak gate and the startup smoke, and neither is wired here, so
 *     a source-mode run would SKIP a gate and still produce a qualified
 *     candidate. The prototype must refuse the mode outright instead —
 *     except through the one Owner-approved, prototype-only test entry,
 *     which is the only source of `source` the pipeline accepts.
 *
 *   - `summary` — the verdict accepted `skipped` as success, and the
 *     elapsed time was computed from a value that is empty when the context
 *     job fails. An empty operand is treated as ZERO by the shell, so a
 *     failed context produced a huge -- but valid -- number instead of an
 *     error. Today `always()` plus the skipped-acceptance would then report
 *     a green summary over a pipeline that never ran.
 *
 * Usage:
 *   node scripts/pipeline-guard.mjs mode <resolved-mode> [--origin <origin>]
 *   node scripts/pipeline-guard.mjs summary --started <epoch> \
 *       --phase <name>=<result> [--phase <name>=<result> ...]
 *
 * @module @xmoon76/dsh-pi-tui/scripts/pipeline-guard
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The phases that MUST succeed for the pipeline to be qualified, in the
 * order they appear in the summary.
 *
 * A phase that is absent from the list is not required — but a phase that
 * is LISTED and did not run is a failure, not a pass. That distinction is
 * the whole point: "it did not run" and "it passed" are different facts.
 */
export const REQUIRED_PHASES = ['context', 'build', 'typecheck', 'product shards', 'aggregate', 'candidate pack', 'qualification', 'downstream matrix', 'qualified artifact']

/**
 * The fault injections this pipeline can perform on itself.
 *
 * `none` is a normal run. Every other token makes the pipeline fail at a
 * specific place, so the fail-closed behaviour can be demonstrated instead
 * of argued: the point of each injection is that the qualification is
 * REJECTED and no qualified artifact is produced.
 *
 * The list is CLOSED. An unknown token is a configuration error, not a
 * silent no-op: a typo that quietly disabled the injection would produce a
 * green run that proves nothing.
 */
export const FAULT_TOKENS = [
  'none',
  // a shard's test run fails
  'shard-fail',
  // a shard's records never arrive
  'shard-missing',
  // a shard receives a build that is not the one the build job produced
  'digest-mismatch',
  // the shared build artifact is never uploaded
  'build-missing',
  // one of the eight postpack smokes fails on the candidate
  'smoke-fail',
  // a downstream compatibility leg fails after the candidate was built
  'downstream-fail',
]

/**
 * The number of shards this run splits the lane into.
 *
 * It is a COMMITTED fact, like every other parameter here, because
 * `workflow_dispatch` inputs only exist when the workflow is dispatched —
 * and a workflow that is not on the default branch cannot be dispatched at
 * all. A push-triggered run therefore has to be able to say which shape it
 * is, from the tree.
 *
 * A dispatch input, when one is present, wins: it is the human's explicit
 * choice for that run.
 *
 * @param {{file: string, input?: string}} options
 * @returns {{ok: boolean, shardTotal?: number, reason?: string}} the verdict.
 */
export function resolveShardTotal({ file, input }) {
  const supported = [1, 2, 3, 4]
  const fromInput = (input ?? '').trim()
  if (fromInput !== '') {
    const value = Number(fromInput)
    if (!Number.isInteger(value) || !supported.includes(value)) {
      return { ok: false, reason: `the dispatched shard total '${fromInput}' is not one of ${supported.join('/')}` }
    }
    return { ok: true, shardTotal: value }
  }
  if (!existsSync(file)) {
    return { ok: false, reason: `the committed shard total ${file} is missing: a push run cannot be dispatched, so it must state its shape` }
  }
  const raw = readFileSync(file, 'utf8').trim()
  if (raw === '') {
    return { ok: false, reason: `the committed shard total ${file} is empty` }
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || !supported.includes(value)) {
    return { ok: false, reason: `the committed shard total '${raw}' is not one of ${supported.join('/')}` }
  }
  return { ok: true, shardTotal: value }
}

/**
 * Validate the committed fault token.
 *
 * @param {string} raw - the file's contents.
 * @returns {{ok: boolean, fault?: string, reason?: string}} the verdict.
 */
export function checkFault(raw) {
  const fault = (raw ?? '').trim()
  if (fault === '') {
    return { ok: false, reason: 'the fault token is empty: a run must state whether it is an injection' }
  }
  if (!FAULT_TOKENS.includes(fault)) {
    return { ok: false, reason: `the fault token '${fault}' is not one this pipeline implements (closed list: ${FAULT_TOKENS.join(', ')})` }
  }
  return { ok: true, fault }
}

/**
 * The dependency modes this prototype can qualify.
 *
 * `source` is qualifyable ONLY through the Owner-approved test entry
 * (`scripts/prototype-source-mode.txt` = `source` on a prototype branch),
 * never through the resolver: `dsh-ci-context.mjs` derives `source` only for
 * a push to `next`, or a PR targeting `next`, when the tracked policy
 * selects it, and it refuses a forced mode that disagrees.
 */
export const SUPPORTED_MODES = ['npm', 'source']

/**
 * The origins a resolved mode can have.
 *
 * `resolver` is the repository's own decision and is the only origin a
 * production run can have. `prototype-override` means the run came through
 * the prototype's committed test entry, which is bound to the prototype
 * branches — so the two must never collapse into "the mode is source".
 */
export const MODE_ORIGINS = ['resolver', 'prototype-override']

/**
 * Refuse a mode the prototype cannot qualify.
 *
 * Source Mode is accepted ONLY from the test entry. That is not a formality:
 * the entry is what makes the pinned ref and version available (`source_ref`
 * is empty under the resolver on these branches), and it is what keeps the
 * experiment from being read as evidence about the production routing.
 *
 * @param {string} mode - the resolved DSH dependency mode.
 * @param {string} [origin] - where the mode came from.
 * @returns {{ok: boolean, reason?: string}} the verdict.
 */
export function checkMode(mode, origin = 'resolver') {
  if (mode === undefined || mode === '') {
    return { ok: false, reason: 'the DSH dependency mode was not resolved: the pipeline cannot qualify a run whose dependencies are unknown' }
  }
  if (!SUPPORTED_MODES.includes(mode)) {
    return { ok: false, reason: `the DSH dependency mode '${mode}' is not one this prototype can qualify` }
  }
  if (mode === 'source' && origin !== 'prototype-override') {
    // The WIRING exists (pinned distribution, one dependency preparation, the
    // leak gate taking the distribution, the equivalence proof running its own
    // packs), but Source Mode cannot be RESOLVED into this workflow: the
    // repository resolver derives `source` only for `next` when the tracked
    // policy selects source, and it refuses a forced mode that disagrees.
    //
    // A source run that did not come through the committed test entry
    // therefore has no pinned ref or version, and a mode this pipeline cannot
    // pin must not be accepted as qualified.
    return {
      ok: false,
      reason: 'Source Mode is reachable only through the prototype\'s committed test entry (scripts/prototype-source-mode.txt) on a prototype branch: the repository resolver derives it only for `next` when the tracked policy selects source. A source run outside that entry has no pinned ref or version.',
    }
  }
  if (!MODE_ORIGINS.includes(origin)) {
    return { ok: false, reason: `the DSH dependency mode origin '${origin}' is not one this pipeline recognises` }
  }
  return { ok: true }
}

/**
 * The verdict over every phase of one run.
 *
 * @param {{started: string|undefined, phases: Array<{name: string, result: string}>}} options
 * @returns {{ok: boolean, elapsedSeconds: number|null, failures: string[], lines: string[]}} the verdict.
 */
export function summarize({ started, phases }) {
  const failures = []

  // The start instant is REQUIRED. An empty one must be an explicit
  // diagnosis, not a number computed from a zero: the shell treats an empty
  // operand as 0, which yields a plausible-looking elapsed time for a run
  // that never started.
  const startedSeconds = Number(started)
  const startedValid = started !== undefined && started !== '' && Number.isInteger(startedSeconds) && startedSeconds > 0
  if (!startedValid) {
    failures.push(`the DAG start instant is unknown (got "${started ?? ''}"): the pipeline cannot report how long it took, and a run whose start is unknown did not qualify`)
  }

  const byName = new Map()
  for (const phase of phases) byName.set(phase.name, phase.result)

  for (const name of REQUIRED_PHASES) {
    const result = byName.get(name)
    if (result === undefined) {
      failures.push(`the required phase '${name}' was not reported: an absent phase is not a pass`)
      continue
    }
    // `skipped` is NOT success. A required phase that did not run did not
    // prove anything, and accepting it would let a green summary describe a
    // pipeline where the tests, the typecheck or the qualification never
    // happened.
    if (result !== 'success') {
      failures.push(`the required phase '${name}' is '${result}', not 'success'`)
    }
  }

  const lines = ['phase            result']
  for (const name of REQUIRED_PHASES) {
    lines.push(`${name.padEnd(16)} ${byName.get(name) ?? '(absent)'}`)
  }
  // Any phase the caller reported that this gate does not require is still
  // shown: a reader should not have to guess why it is missing.
  for (const phase of phases) {
    if (!REQUIRED_PHASES.includes(phase.name)) lines.push(`${phase.name.padEnd(16)} ${phase.result}`)
  }

  const elapsedSeconds = startedValid ? Math.floor(Date.now() / 1000) - startedSeconds : null
  if (elapsedSeconds !== null) {
    lines.push('')
    lines.push(`whole pipeline   ${elapsedSeconds}s`)
  }

  return { ok: failures.length === 0, elapsedSeconds, failures, lines }
}

function main() {
  const args = process.argv.slice(2)
  const command = args[0]
  if (command === 'shard-total') {
    // `--file` and `--input` are both optional in the CLI: the library
    // function is what the tests drive.
    const fileIndex = args.indexOf('--file')
    const inputIndex = args.indexOf('--input')
    const verdict = resolveShardTotal({
      file: fileIndex === -1 ? 'scripts/prototype-shard-total.txt' : args[fileIndex + 1],
      input: inputIndex === -1 ? '' : args[inputIndex + 1],
    })
    if (!verdict.ok) {
      console.error(verdict.reason)
      process.exit(1)
    }
    console.log(verdict.shardTotal)
    return
  }
  if (command === 'fault') {
    const verdict = checkFault(readFileSync(args[1], 'utf8'))
    if (!verdict.ok) {
      console.error(verdict.reason)
      process.exit(1)
    }
    console.log(`fault token '${verdict.fault}'`)
    return
  }
  if (command === 'mode') {
    const originIndex = args.indexOf('--origin')
    const verdict = checkMode(args[1], originIndex === -1 ? 'resolver' : args[originIndex + 1])
    if (!verdict.ok) {
      console.error(verdict.reason)
      process.exit(1)
    }
    console.log(`dependency mode '${args[1]}' is supported by this prototype`)
    return
  }
  if (command === 'summary') {
    const startedIndex = args.indexOf('--started')
    const started = startedIndex === -1 ? undefined : args[startedIndex + 1]
    const phases = []
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] !== '--phase') continue
      const value = args[index + 1]
      const separator = value.lastIndexOf('=')
      if (separator === -1) {
        console.error(`a phase must be written as <name>=<result>, got: ${value}`)
        process.exit(2)
      }
      phases.push({ name: value.slice(0, separator), result: value.slice(separator + 1) })
    }
    const verdict = summarize({ started, phases })
    console.log(verdict.lines.join('\n'))
    if (!verdict.ok) {
      console.error('\nthe pipeline did NOT qualify:')
      for (const failure of verdict.failures) console.error(`  - ${failure}`)
      process.exit(1)
    }
    return
  }
  console.error('usage: node scripts/pipeline-guard.mjs mode <mode> [--origin <resolver|prototype-override>]')
  console.error('       node scripts/pipeline-guard.mjs fault <file>')
  console.error('       node scripts/pipeline-guard.mjs shard-total [--file <file>] [--input <n>]')
  console.error('       node scripts/pipeline-guard.mjs summary --started <epoch> --phase <name>=<result> ...')
  process.exit(2)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
