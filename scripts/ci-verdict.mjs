#!/usr/bin/env node
/**
 * The FINAL verdict over one CI run: did every phase that must prove
 * something actually prove it?
 *
 * The accelerated DAG has one job — `qualified` — whose only purpose is to
 * refuse publication unless the whole graph succeeded. That job cannot use
 * GitHub's implicit `success()` requirement, because three of its needs are
 * LEGITIMATELY skipped depending on the dependency mode, and `always()` /
 * `!cancelled()` suppress the implicit check. So the verdict is a script:
 * it is exercised by tests, it prints a table, and it fails closed.
 *
 * Three things it enforces, and none of them is expressible as "not failed":
 *
 *   - every required phase is exactly `success` — `skipped`, `cancelled` and
 *     an ABSENT phase are failures, because a phase that did not run did not
 *     prove anything;
 *   - the MODE-DEPENDENT phases have the status their mode requires: in
 *     Source Mode the pinned distribution must have been built (`success`),
 *     and the npm-only client-family and split-process gates must be
 *     `skipped`; in npm mode the distribution must be `skipped` and both
 *     npm-only gates `success`. A source run whose distribution was skipped
 *     has no dependency graph to qualify against, and an npm run whose
 *     npm-only gate was skipped silently dropped a check;
 *   - on a RELEASE TAG the release phases are required too.
 *
 * Usage:
 *   node scripts/ci-verdict.mjs qualify --mode <npm|source> --phase <job>=<result>...
 *   node scripts/ci-verdict.mjs summary --mode <npm|source> [--release] [--started <epoch>] \
 *     --phase <job>=<result>...
 *
 * @module @xmoon76/dsh-pi-tui/scripts/ci-verdict
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The phases every run must show as `success`.
 *
 * The names are JOB IDS, not prose: a reader can find each one in
 * `.github/workflows/ci.yml`, and a test asserts that every name here is a
 * job in that file — a renamed job must not silently drop out of the verdict.
 */
export const REQUIRED_PHASES = [
  'dsh-context',
  'build',
  'typecheck',
  'product-shard',
  'aggregate',
  'candidate',
  'qualify',
  'equivalence',
  'source-checks',
  'compat-smoke',
  'ecosystem-compat',
  'official-preset-assembly',
  'runtime-boundary',
  'security-audit',
]

/** Additional phases the SUMMARY requires on top of its own run's graph. */
export const SUMMARY_EXTRA_PHASES = ['qualified']

/** Phases that exist only on a release tag. */
export const RELEASE_PHASES = ['release-context', 'release-metadata', 'release-packed-check', 'publish', 'release']

/**
 * The status each MODE-DEPENDENT job must show.
 *
 * These are the jobs whose presence is a function of the dependency mode.
 * `success` and `skipped` are both "expected"; what is forbidden is the WRONG
 * one, which is what a mis-gated job looks like.
 */
export const MODE_STATUS = {
  npm: {
    'prepare-dsh-source': 'skipped',
    'client-family-compat': 'success',
    'split-process': 'success',
  },
  source: {
    'prepare-dsh-source': 'success',
    'client-family-compat': 'skipped',
    'split-process': 'skipped',
  },
}

const RESULT_VALUES = new Set(['success', 'failure', 'cancelled', 'skipped'])

function fail(message) {
  throw new Error(message)
}

/**
 * Decide whether this run qualifies.
 *
 * @param {{role: 'qualify'|'summary', mode: string, phases: Array<{name: string, result: string}>, release?: boolean, started?: string}} options
 * @returns {{ok: boolean, failures: string[], lines: string[], elapsedSeconds: number|null}} the verdict.
 */
export function verdict({ role, mode, phases, release = false, started }) {
  const failures = []
  const byName = new Map()
  for (const phase of phases) byName.set(phase.name, phase.result)

  const required = role === 'summary'
    ? [...REQUIRED_PHASES, ...SUMMARY_EXTRA_PHASES]
    : [...REQUIRED_PHASES]
  if (release) required.push(...RELEASE_PHASES)

  for (const name of required) {
    const result = byName.get(name)
    if (result === undefined) {
      failures.push(`the required phase '${name}' was not reported: an absent phase is not a pass`)
      continue
    }
    if (result !== 'success') {
      failures.push(`the required phase '${name}' is '${result}', not 'success'`)
    }
  }

  // The mode-dependent pair. A mode the pipeline does not know is itself a
  // failure: defaulting it would let an unresolved run through.
  const expected = MODE_STATUS[mode]
  if (expected === undefined) {
    failures.push(`the DSH mode '${mode}' is not one this verdict knows: the mode-dependent phases cannot be checked`)
  } else {
    for (const [name, wanted] of Object.entries(expected)) {
      const actual = byName.get(name)
      if (actual !== wanted) {
        failures.push(`the mode-dependent phase '${name}' is '${actual ?? '(absent)'}', but mode '${mode}' requires '${wanted}'`)
      }
    }
  }

  // The start instant is optional. When it IS given it must be usable: the
  // shell treats an empty operand as zero, which once produced a
  // plausible-looking elapsed time for a run that never started.
  let elapsedSeconds = null
  if (started !== undefined) {
    const seconds = Number(started)
    if (started === '' || !Number.isInteger(seconds) || seconds <= 0) {
      failures.push(`the DAG start instant is unusable (got ${JSON.stringify(started)}): the elapsed time cannot be reported`)
    } else {
      elapsedSeconds = Math.floor(Date.now() / 1000) - seconds
    }
  }

  const lines = ['phase                         result']
  const shown = [...required, ...(mode === undefined ? [] : Object.keys(MODE_STATUS[mode] ?? {})), ...phases.map(phase => phase.name)]
  const seen = new Set()
  for (const name of shown) {
    if (seen.has(name)) continue
    seen.add(name)
    lines.push(`${name.padEnd(29)} ${byName.get(name) ?? '(absent)'}`)
  }
  if (elapsedSeconds !== null) {
    lines.push('')
    lines.push(`whole pipeline                ${elapsedSeconds}s`)
  }
  return { ok: failures.length === 0, failures, lines, elapsedSeconds }
}

/** Parse `--phase <name>=<result>` pairs. */
export function parsePhases(args) {
  const phases = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--phase') continue
    const value = args[index + 1]
    if (typeof value !== 'string') fail('--phase needs a <name>=<result> value')
    const separator = value.lastIndexOf('=')
    if (separator === -1) fail(`a phase must be written as <name>=<result>, got: ${value}`)
    const name = value.slice(0, separator)
    const result = value.slice(separator + 1)
    if (name === '') fail(`a phase must be written as <name>=<result>, got: ${value}`)
    if (!RESULT_VALUES.has(result)) {
      fail(`the phase '${name}' has the unknown result '${result}'; expected one of ${[...RESULT_VALUES].join(', ')}`)
    }
    phases.push({ name, result })
  }
  return phases
}

function main() {
  const args = process.argv.slice(2)
  const role = args[0]
  if (role !== 'qualify' && role !== 'summary') {
    console.error('usage: node scripts/ci-verdict.mjs <qualify|summary> --mode <npm|source> [--release] [--started <epoch>] --phase <job>=<result>...')
    process.exit(2)
  }
  const valueOf = (name) => {
    const index = args.indexOf(name)
    return index === -1 ? undefined : args[index + 1]
  }
  const mode = valueOf('--mode')
  if (mode === undefined) fail('--mode is required: the mode-dependent phases cannot be checked without it')
  const phases = parsePhases(args)
  if (phases.length === 0) fail('--phase is required: a verdict over no phases is not a verdict')
  const decision = verdict({
    role,
    mode,
    phases,
    release: args.includes('--release'),
    started: valueOf('--started'),
  })
  console.log(decision.lines.join('\n'))
  if (!decision.ok) {
    console.error(`\nthe run did NOT qualify (${decision.failures.length}):`)
    for (const failure of decision.failures) console.error(`  - ${failure}`)
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`CI_VERDICT_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
