/**
 * The ONE selectable-case registry and strict selector grammar for the
 * split-upgrade smoke.
 *
 * The registry is the single static data fact behind `--list`, selector
 * resolution, the actual run call and the selected result line: there is no
 * second hand-written suite list and no directory scan. This module is pure —
 * importing it installs nothing, reads no tarball, creates no work root and
 * starts no process.
 *
 * The default (no selector) mode stays the complete U01-U09 qualification lane;
 * a selector only runs the registered cases below and never claims the complete
 * cross-build compatibility.
 *
 * @module split-upgrade-selection
 */

import { runCrossBuildCompatibility } from '../smoke/split-upgrade/cross-build-compatibility.mjs'
import { runManualClientReload } from '../smoke/split-upgrade/manual-client-reload.mjs'
import { runReloadSourceIsolation } from '../smoke/split-upgrade/reload-source-isolation.mjs'
import { SplitSmokeInputError } from './split-smoke-diagnostics.mjs'

/** The evidence scope every selected result declares. */
const SELECTABLE_SCOPE = 'SELECTABLE_ONLY'

/**
 * The frozen selectable cases, in registration order.
 *
 * The order IS the execution order a suite or the full lane follows: the
 * cross-build case keeps the old Host/Turn together, then the two independent
 * Client-reload cases run in their own isolated profiles.
 */
const CASE_REGISTRY = Object.freeze([
  Object.freeze({
    suite: 'upgrade',
    id: 'upgrade.cross-build-compatibility',
    title: 'an old Host keeps its admitted Turn while a new build Client reexecs onto it and a cold Host resumes the durable Session',
    run: runCrossBuildCompatibility,
  }),
  Object.freeze({
    suite: 'client-reload',
    id: 'client-reload.production-command',
    title: 'the production /reload-client command reexecs the profile-installed replacement while a second Client keeps its Session and Turn',
    run: runManualClientReload,
  }),
  Object.freeze({
    suite: 'client-reload',
    id: 'client-reload.target-source-isolation',
    title: 'the manual command resolves the active profile while the qualification signal uses the side-build override in one Client process',
    run: runReloadSourceIsolation,
  }),
])

function fail(detail) {
  throw new SplitSmokeInputError(
    'INPUT_SMOKE_SELECTION_INVALID',
    `INPUT_UNQUALIFIED: INPUT_SMOKE_SELECTION_INVALID (invalid smoke selection, not a product regression): ${detail}`,
  )
}

/** The frozen registry, in registration order (read-only to every caller). */
export function listSelectableUpgradeCases() {
  return CASE_REGISTRY
}

/**
 * Parse the lane arguments without side effects. Exactly one `--` (the pnpm
 * separator) may lead; every option, value and positional is then strict.
 * A missing/duplicate/combined selector, an unknown option, an extra
 * positional, `--list`/`--help` with anything else, and two candidates all
 * fail closed before any artifact is inspected or any work root exists.
 */
export function parseUpgradeSelectionArgs(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  let list = false
  let help = false
  let caseId
  let suiteId
  const values = { old: undefined, new: undefined, evidence: undefined }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--list') {
      if (list) fail('--list may appear only once')
      list = true
      continue
    }
    if (argument === '--help' || argument === '-h') {
      if (help) fail('--help may appear only once')
      help = true
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
    if (argument === '--old' || argument === '--new' || argument === '--evidence') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) fail(`${argument} requires a path`)
      const key = argument.slice(2)
      if (values[key] !== undefined) fail(`duplicate ${argument}`)
      values[key] = value
      index += 1
      continue
    }
    if (argument.startsWith('-')) fail('unknown option')
    fail('unexpected positional argument')
  }
  const hasArtifacts = values.old !== undefined || values.new !== undefined || values.evidence !== undefined
  if (help) {
    if (list || caseId !== undefined || suiteId !== undefined || hasArtifacts) fail('--help cannot be combined with other arguments')
    return { mode: 'help' }
  }
  if (list) {
    if (caseId !== undefined || suiteId !== undefined || hasArtifacts) fail('--list cannot be combined with other arguments')
    return { mode: 'list' }
  }
  if (caseId !== undefined && suiteId !== undefined) fail('--case and --suite are mutually exclusive')
  if (values.old === undefined || values.new === undefined) fail('both --old <tgz> and --new <tgz> are required')
  const artifacts = { old: values.old, new: values.new, evidence: values.evidence }
  if (caseId !== undefined) return { mode: 'case', id: caseId, ...artifacts }
  if (suiteId !== undefined) return { mode: 'suite', suite: suiteId, ...artifacts }
  return { mode: 'full', ...artifacts }
}

/**
 * Resolve an already-parsed selection against the registry. An unknown
 * id/suite fails closed, and an empty selection can never pass: every selected
 * run executes at least one registered case.
 */
export function resolveUpgradeSelection(selection) {
  if (selection.mode === 'full' || selection.mode === 'list' || selection.mode === 'help') return selection
  const cases = CASE_REGISTRY.filter(entry => selection.mode === 'case'
    ? entry.id === selection.id
    : entry.suite === selection.suite)
  if (cases.length === 0) fail(`unknown ${selection.mode}`)
  return { ...selection, cases }
}

/** The ONE selected result line; it names the selectable scope, never full. */
export function selectedUpgradePassLine(caseId) {
  return `SPLIT_UPGRADE_SELECTED_PASS id=${caseId} scope=${SELECTABLE_SCOPE}`
}
