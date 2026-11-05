/**
 * The ONE selectable-case registry and the strict selector grammar for
 * `scripts/split-process-smoke.mjs`.
 *
 * The registry is the single static data fact behind `--list`, selector
 * resolution, the actual run call and the selected result line: there is no
 * second hand-written suite list and no directory scan. This module is pure —
 * importing it installs nothing, creates no work root and instantiates no
 * process.
 *
 * The default (no selector) mode stays the OLD full qualification lane; a
 * selector only runs the registered cases below and never claims the complete
 * inventory.
 *
 * @module split-smoke-selection
 */

import { runAuthenticatedLifecycle } from '../smoke/split-process/authenticated-lifecycle.mjs'
import { runEntryAdmission } from '../smoke/split-process/entry-admission.mjs'
import { runHostRuntimeDisabled } from '../smoke/split-process/host-runtime-disabled.mjs'
import { runRuntimeArtifactRecovery } from '../smoke/split-process/runtime-artifact-recovery.mjs'
import { SplitSmokeInputError } from './split-smoke-diagnostics.mjs'

/** The evidence scope every selected result declares. */
const SELECTABLE_SCOPE = 'SELECTABLE_ONLY'

/**
 * The frozen selectable cases, in registration order.
 *
 * The order IS the fact: a suite runs these entries in exactly this sequence and
 * the full lane runs every migrated entry through the same `run()` at its old
 * position. `bootstrap` keeps the row-disabled pilot first, then the entry
 * admission and artifact-recovery negatives; `transport` owns the whole
 * authenticated-link chain.
 */
const CASE_REGISTRY = Object.freeze([
  Object.freeze({
    suite: 'bootstrap',
    id: 'bootstrap.host-runtime-disabled',
    title: 'a disabled Host Runtime owner refuses Ready without publishing a Host identity',
    run: runHostRuntimeDisabled,
  }),
  Object.freeze({
    suite: 'bootstrap',
    id: 'bootstrap.entry-admission',
    title: 'an inherited Host role without a mounted TUI surface is refused before Host admission',
    run: runEntryAdmission,
  }),
  Object.freeze({
    suite: 'bootstrap',
    id: 'bootstrap.runtime-artifact-recovery',
    title: 'a renamed-away Host Runtime artifact fails closed and the restored artifact reaches authenticated Ready',
    run: runRuntimeArtifactRecovery,
  }),
  Object.freeze({
    suite: 'transport',
    id: 'transport.authenticated-lifecycle',
    title: 'concurrent Host launches elect one authenticated owner whose Client lifecycle survives exits and signals',
    run: runAuthenticatedLifecycle,
  }),
])

function fail(detail) {
  throw new SplitSmokeInputError(
    'INPUT_SMOKE_SELECTION_INVALID',
    `INPUT_UNQUALIFIED: INPUT_SMOKE_SELECTION_INVALID (invalid smoke selection, not a product regression): ${detail}`,
  )
}

/** The frozen registry, in registration order (read-only to every caller). */
export function listSelectableCases() {
  return CASE_REGISTRY
}

/**
 * Parse the lane arguments without side effects. Exactly one `--` (the pnpm
 * separator) may lead; every option, value and positional is then strict.
 * A missing/duplicate/combined selector, an unknown option, an extra
 * positional, `--list` with anything else, and two candidates all fail closed.
 */
export function parseSelectionArgs(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  let list = false
  let caseId
  let suiteId
  let candidate
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--list') {
      if (list) fail('--list may appear only once')
      list = true
      continue
    }
    if (argument === '--case' || argument === '--suite') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('-')) fail(`${argument} requires exactly one value`)
      if (argument === '--case') {
        if (caseId !== undefined) fail('--case may appear only once')
        caseId = value
      } else {
        if (suiteId !== undefined) fail('--suite may appear only once')
        suiteId = value
      }
      index += 1
      continue
    }
    if (argument.startsWith('-')) fail('unknown option')
    if (candidate !== undefined) fail('at most one candidate tarball may be named')
    candidate = argument
  }
  if (list) {
    if (caseId !== undefined || suiteId !== undefined) fail('--list cannot be combined with --case or --suite')
    if (candidate !== undefined) fail('--list does not take a candidate tarball')
    return { mode: 'list' }
  }
  if (caseId !== undefined && suiteId !== undefined) fail('--case and --suite are mutually exclusive')
  if (caseId !== undefined) return { mode: 'case', id: caseId, candidate }
  if (suiteId !== undefined) return { mode: 'suite', suite: suiteId, candidate }
  return { mode: 'full', candidate }
}

/**
 * Resolve an already-parsed selection against the registry. An unknown
 * id/suite fails closed, and an empty selection can never pass: every selected
 * run executes at least one registered case.
 */
export function resolveSelection(selection) {
  if (selection.mode === 'full' || selection.mode === 'list') return selection
  const cases = CASE_REGISTRY.filter(entry => selection.mode === 'case'
    ? entry.id === selection.id
    : entry.suite === selection.suite)
  if (cases.length === 0) fail(`unknown ${selection.mode}`)
  return { ...selection, cases }
}

/** The ONE selected result line; it names the selectable scope, never full. */
export function selectedPassLine(caseId) {
  return `SPLIT_PROCESS_SELECTED_PASS id=${caseId} scope=${SELECTABLE_SCOPE}`
}
