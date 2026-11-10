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
import { runClientHmrSignals } from '../smoke/split-process/client-hmr-signals.mjs'
import { runDetachedTurnInteractions } from '../smoke/split-process/detached-turn-interactions.mjs'
import { runNonDestructiveClientLifecycle } from '../smoke/split-process/non-destructive-client-lifecycle.mjs'
import { runReadAuthority } from '../smoke/split-process/read-authority.mjs'
import { runInteractionNavigationFirst } from '../smoke/split-process/interaction-admission.mjs'
import { runSessionWorkspaceActivity } from '../smoke/split-process/session-workspace-activity.mjs'
import { runSessionWorkspaceEditorEntry } from '../smoke/split-process/session-workspace-editor-entry.mjs'
import { runEntryAdmission } from '../smoke/split-process/entry-admission.mjs'
import { runOfficialWebComposition } from '../smoke/split-process/official-web-composition.mjs'
import { runPtySessionWriteRecovery } from '../smoke/split-process/pty-session-write-recovery.mjs'
import { runSharedSessionInteractions } from '../smoke/split-process/shared-session-interactions.mjs'
import { runHostRuntimeDisabled } from '../smoke/split-process/host-runtime-disabled.mjs'
import { runHostUserShellF1 } from '../smoke/split-process/host-user-shell-f1.mjs'
import { runRuntimeArtifactRecovery } from '../smoke/split-process/runtime-artifact-recovery.mjs'
import { runUnknownWriteHostDeath } from '../smoke/split-process/unknown-write-host-death.mjs'
import { runWebProductQualification } from '../smoke/split-process/web-product.mjs'
import { runWebRuntimeToggle } from '../smoke/split-process/web-runtime-toggle.mjs'
import { runWebStartupPreference } from '../smoke/split-process/web-startup-preference.mjs'
import { runF2AccountComposition } from '../smoke/split-process/account-composition.mjs'
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
 * authenticated-link chain; `surface`, `multi-client` and `navigation` own the
 * real-surface, shared-Session and non-destructive Client scenes; `recovery`
 * owns the detached-interaction, HMR/signal and unknown-write Host-death
 * continuity evidence; `account` owns the official Account Controller, verified callback and PKCE proof; `web` owns the official Web composition, the live
 * runtime toggle, the profile startup preference and the product Browser/TUI
 * matrix.
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
  Object.freeze({
    suite: 'surface',
    id: 'surface.host-user-shell-f1',
    title: 'real installed Host Shell and Host completion use Host environment, bound output and exact Session writes',
    run: runHostUserShellF1,
  }),
  Object.freeze({
    suite: 'surface',
    id: 'surface.pty-session-write-recovery',
    title: 'one authenticated Host drives real PTY surfaces through Session writes, recovery and stale-generation fences',
    run: runPtySessionWriteRecovery,
  }),
  Object.freeze({
    suite: 'multi-client',
    id: 'multi-client.shared-session-interactions',
    title: 'two real Clients retain one Session and settle one Host Question or Approval exactly once',
    run: runSharedSessionInteractions,
  }),
  Object.freeze({
    suite: 'navigation',
    id: 'navigation.non-destructive-client-lifecycle',
    title: 'leaving a Session from one Client never stops the Host Turn another Client keeps reading',
    run: runNonDestructiveClientLifecycle,
  }),
  Object.freeze({
    suite: 'read',
    id: 'read.official-read-authority',
    title: 'A(Y) reads X\'s real Host pending/Workspace facts through the ONE read-authority port and answers X through the existing first-settlement path',
    run: runReadAuthority,
  }),
  Object.freeze({
    suite: 'interaction',
    id: 'interaction.navigation-first-answerability',
    title: 'navigation-first admission holds a forwarded interaction until its Session commits and re-offers the SAME request after a no-answer navigation',
    run: runInteractionNavigationFirst,
  }),
  Object.freeze({
    suite: 'interaction',
    id: 'interaction.workspace-needs-attention',
    title: 'the Session Workspace proves a forwarded Question as a Needs-attention row, keeps its answer modal off the wrong editor, peeks read-only and answers only after the real Session commit',
    run: runSessionWorkspaceActivity,
  }),
  Object.freeze({
    suite: 'interaction',
    id: 'interaction.workspace-editor-entry',
    title: 'two real PTY Left presses from the empty PiTUI Host Editor open the ONE All-workspaces Session Workspace without switching, stopping or answering',
    run: runSessionWorkspaceEditorEntry,
  }),
  Object.freeze({
    suite: 'recovery',
    id: 'recovery.detached-turn-interactions',
    title: 'an accepted Turn, Tool, Job, Child and pending interaction survive the Client that started them',
    run: runDetachedTurnInteractions,
  }),
  Object.freeze({
    suite: 'recovery',
    id: 'recovery.client-hmr-signals',
    title: 'Client-only HMR, real PTY signals and Host kill keep the official disposition taxonomy',
    run: runClientHmrSignals,
  }),
  Object.freeze({
    suite: 'recovery',
    id: 'recovery.unknown-write-host-death',
    title: 'an ACK-dropped write survives Host death as one durable write and no fabricated answer',
    run: runUnknownWriteHostDeath,
  }),
  Object.freeze({
    suite: 'account',
    id: 'account.official-composition',
    title: 'the official Host Account Controller serves one authenticated Client through a verified callback and PKCE exchange',
    run: runF2AccountComposition,
  }),
  Object.freeze({
    suite: 'web',
    id: 'web.official-composition',
    title: 'the official Web composition stays default-off and a real Browser plus real TUI share one authenticated Host',
    run: runOfficialWebComposition,
  }),
  Object.freeze({
    suite: 'web',
    id: 'web.runtime-toggle',
    title: 'one live Host toggles the official Web runtime on and off without unloading the real TUI',
    run: runWebRuntimeToggle,
  }),
  Object.freeze({
    suite: 'web',
    id: 'web.startup-preference',
    title: 'the profile-owned Web startup preference applies on the next cold Host through the real settings wire',
    run: runWebStartupPreference,
  }),
  Object.freeze({
    suite: 'web',
    id: 'web.product-browser-tui',
    title: 'the product Browser and real TUI share one Host across the 22-case WP matrix',
    run: runWebProductQualification,
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
