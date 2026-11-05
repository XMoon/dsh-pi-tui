#!/usr/bin/env node
/**
 * Shared input qualification and failure diagnostics for the two split-process
 * smoke lanes: `split-process-smoke.mjs` and `split-process-upgrade-smoke.mjs`.
 *
 * Both lanes run against the ONE exact DSH runtime this checkout declares
 * (`npmDshVersion()`), so every packaged input must declare that same exact
 * pin. The production Client reexec preflight enforces the identical rule at
 * runtime and refuses a mismatching target; a lane that starts with a
 * differently pinned artifact therefore fails on its NEGATIVE expectation and
 * reports it as a timeout. This module makes that pairing mistake a fast,
 * explicitly classified INPUT problem instead of a product-looking failure.
 *
 * The rest of the module is the lanes' DEFAULT failure diagnostics: a bounded,
 * whitelisted projection of facts the lane already holds, written once to a
 * private report OUTSIDE the deletable qualification work root. It reads no
 * product service, owns no process or lifecycle, and never decides PASS — the
 * real PTY viewport and the entry's own JSONL records stay the only authorities.
 *
 * @module split-smoke-diagnostics
 */

import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DSH_AGENT_PACKAGE } from './dsh-distribution.mjs'

/**
 * The exact-pin grammar of `dsh-distribution.mjs` `npmDshVersion()`. The two
 * spellings must stay identical: one lane-wide authority decides what "an exact
 * DSH version" means, and the guard must not be stricter or looser than the
 * value it compares against.
 */
const EXACT_DSH_PIN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

const INPUT_ROLES = new Set(['candidate', 'old', 'new'])

/** The fixed report categories; nothing outside this set may ever be reported. */
export const FAILURE_CATEGORIES = Object.freeze([
  'INPUT_UNQUALIFIED',
  'UNEXPECTED_RELOAD_REFUSAL',
  'WAIT_TIMEOUT',
  'PROCESS_EXITED',
  'ASSERTION_FAILED',
  'INFRA_FAILURE',
])

/** The fixed `/reload-client` notice classifications (never raw viewport text). */
export const RELOAD_NOTICE_TYPES = Object.freeze([
  'ALREADY_CURRENT',
  'ATTACHMENTS',
  'DRAFT_TEXT',
  'SUBMISSION',
  'INTERACTION',
  'TRANSITION',
  'TARGET_INVALID',
  'TARGET_INVALID_DSH_PIN_MISMATCH',
  'TARGET_INVALID_UNCLASSIFIED',
  'UNAVAILABLE',
  'NOT_READY',
  'STOPPING',
])

/**
 * The ONE fixed notice text of every `/reload-client` decision, exactly as the
 * product paints it (`CLIENT_RELOAD_REFUSAL_NOTICES` in
 * `src/tui/commands/utility.ts`). This is the allowlist a painted row must match
 * COMPLETELY to be classified: an unknown row is never a notice, so user text
 * can never be mistaken for a refusal. A product notice change must land here
 * too, and the real lane fails loudly when the two diverge.
 */
const RELOAD_NOTICE_BY_TEXT = new Map([
  ['Client reload is available only in the split Client.', 'UNAVAILABLE'],
  ['Client reload is unavailable until the current Client is connected and ready.', 'NOT_READY'],
  ['Client reload blocked: finish or clear the editor draft first.', 'DRAFT_TEXT'],
  ['Client reload blocked: remove or submit the staged attachments first.', 'ATTACHMENTS'],
  ['Client reload blocked: wait for the pending submission to settle.', 'SUBMISSION'],
  ['Client reload blocked: finish the current Question or Approval first.', 'INTERACTION'],
  ['Client reload blocked: wait for the current session operation to settle.', 'TRANSITION'],
  ['Client reload skipped: this Client already runs the installed build.', 'ALREADY_CURRENT'],
  ['Client reload failed: the installed replacement Client is unavailable or incompatible.', 'TARGET_INVALID'],
  ['Client reload is unavailable because this Client is stopping.', 'STOPPING'],
])

/** The product notice row shape: the `✗`/`ℹ` mark, then `Client reload `. */
const RELOAD_NOTICE_LINE = /^\s*(?:✗|ℹ) Client reload (?:skipped|blocked|failed|is available|is unavailable)/u

/**
 * The three official telemetry event keys a report may name, and the CLOSED set
 * of event NAMES each key may carry. The values come from the entries the lanes
 * launch (`src/app/remote-process/**`), not from a guess: an event name outside
 * its set is omitted rather than truncated into the report, so a hostile or
 * drifted record cannot put arbitrary text into the default output.
 */
const EVENT_KEYS = Object.freeze(['m4a0', 'm4r', 'm4b2s'])
const EVENT_NAMES = Object.freeze({
  m4a0: new Set(['cleanup', 'cleanup-failure', 'client-started', 'context-ready', 'control-error',
    'control-failure', 'diag', 'failure', 'host-authenticated', 'host-seat-conflict',
    'peer-answer-sent', 'peer-frame', 'peer-interaction', 'peer-question-answer',
    'peer-stale-result-sent', 'profile-booted', 'qualification', 'ready', 'signal', 'status',
    'stop-repeat-ignored', 'stop-requested', 'transport-ready']),
  m4r: new Set(['handoff-failed', 'handoff-parent-exit', 'handoff-request-ignored',
    'handoff-request-rejected', 'handoff-requested', 'handoff-restored']),
  m4b2s: new Set(['client-closed', 'qualification', 'surface-status']),
})

function eventNameOrUndefined(key, value) {
  return EVENT_NAMES[key].has(value) ? value : undefined
}

/**
 * The CLOSED set of stable codes the lanes may ever report as a `reason`.
 *
 * `error.code` is not trustworthy text: a parser, a filesystem call or a foreign
 * library can set it to anything. Only a code declared here is ever projected;
 * an unknown one leaves the report at the category, so a stray `code` field can
 * neither reach the default report nor change its classification. The tooling
 * guard test proves every code literal the lanes use appears in this set.
 */
export const LANE_ERROR_CODES = Object.freeze([
  'INPUT_DSH_PIN_MISSING_OR_INVALID',
  'INPUT_DSH_PIN_MISMATCH',
  // The selectable-entry boundary: an unknown/ambiguous selector, a selector
  // combined with --list, or a full-only control used with --case/--suite.
  'INPUT_SMOKE_SELECTION_INVALID',
  'RECORD_READ_FAILED',
  'RECORD_WAIT_TIMEOUT',
  'PROCESS_EXITED_BEFORE_RECORD',
  'PROCESS_EXIT_TIMEOUT',
  'PROCESS_EXITED_BEFORE_FRAME',
  'FRAME_WAIT_TIMEOUT',
  'PROCESS_EXITED_BEFORE_COMPOSER',
  'COMPOSER_WAIT_TIMEOUT',
  'COMPOSER_CLEAR_TIMEOUT',
  'NOTICE_WAIT_TIMEOUT',
  'PROCESS_EXITED_BEFORE_NOTICE',
  'PAINTED_NOTICE_MISMATCH',
  'PROCESS_REFUSED_RELOAD',
  'PROCESS_IGNORED_RELOAD',
  'HANDOFF_WAIT_TIMEOUT',
  'PROCESS_EXITED_BEFORE_HANDOFF',
  'WORK_PROOF_WAIT_TIMEOUT',
  'SESSION_EVENT_WAIT_TIMEOUT',
  'HOST_SESSION_HEADER_TIMEOUT',
  'SURFACE_STATUS_WAIT_TIMEOUT',
  'PROCESS_EXITED_BEFORE_STATUS',
  'READY_RACE_TIMEOUT',
  'READY_RACE_EXITED',
  'SEAT_RELEASE_TIMEOUT',
  'REGISTRY_COMMIT_EXITED',
  'EVIDENCE_WRITE_FAILED',
  // The PR-A Web qualification's generic bounded condition wait (Browser
  // Session creation, client-hmr frames): declared here so its failure detail
  // survives the report projection instead of being dropped as unknown.
  'QUALIFICATION_CONDITION_TIMEOUT',
  // The same wait stopped by its caller (the Browser driver exited first): the
  // poller really stops, so this is a distinct, reportable outcome.
  'QUALIFICATION_CONDITION_ABORTED',
])

/** A POSIX errno NAME (`EACCES`, `ENOENT`, …) is a fixed vocabulary. */
const ERRNO_NAME = /^E[A-Z]{2,12}$/u

function laneCodeOrUndefined(value) {
  return LANE_ERROR_CODES.includes(value) ? value : undefined
}

function errnoOrUndefined(value) {
  return typeof value === 'string' && ERRNO_NAME.test(value) ? value : undefined
}

/** The only diagnostic detail a write failure may ever print: its errno name. */
function writeFailureLine(error) {
  const code = errnoOrUndefined(error?.code)
  return code === undefined ? 'DIAGNOSTIC_WRITE_FAILURE' : `DIAGNOSTIC_WRITE_FAILURE: ${code}`
}

const MAX_CHECKPOINTS = 24
const MAX_PROCESSES = 8
const MAX_PROCESS_EVENTS = 8
const MAX_ARTIFACTS = 3
const MAX_NAME_CHARS = 80
const MAX_LABEL_CHARS = 120

/** Keep only printable ASCII inside a fixed length: no ANSI, no newlines, no dump. */
function bounded(value, limit) {
  if (typeof value !== 'string') return undefined
  const clean = value.replace(/[^\x20-\x7e]/gu, '').slice(0, limit)
  return clean === '' ? undefined : clean
}

export function boundedName(value) {
  return bounded(value, MAX_NAME_CHARS)
}

function exactPinOrUndefined(value) {
  return typeof value === 'string' && EXACT_DSH_PIN.test(value) ? value : undefined
}

function sha256OrUndefined(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value) ? value : undefined
}

/**
 * The locator an error may PUBLISH: only the class that derived one may
 * contribute it. A plain error carrying an `assertion` property would otherwise
 * name a lane file it never resolved. This is the single producer rule both
 * reporting paths (`emitInputFailure`, the run collector) must use.
 */
function publishedAssertionOf(error) {
  return error instanceof SplitSmokeAssertionError ? error.assertion : undefined
}

/** A locator is reportable only when its shape AND its source are trusted. */
function assertionSiteOrUndefined(value) {
  if (typeof value !== 'string' || !ASSERTION_SITE.test(value)) return undefined
  return LANE_SOURCES.has(value.slice(0, value.indexOf(':'))) ? value : undefined
}

function reloadNoticeTypeOrUndefined(value) {
  return RELOAD_NOTICE_TYPES.includes(value) ? value : undefined
}

/** An input artifact this lane is not allowed to run with (never a product defect). */
export class SplitSmokeInputError extends Error {
  constructor(code, message, facts = {}) {
    super(message)
    this.name = 'SplitSmokeInputError'
    this.category = 'INPUT_UNQUALIFIED'
    this.code = code
    this.role = facts.role
    this.targetDshVersion = facts.targetDshVersion
    this.artifactPin = facts.artifactPin
  }
}

/**
 * One classified lane failure raised by the shared waiters. It carries ONLY
 * fixed labels, numbers and already-validated enums, so stderr and the report
 * never need raw terminal bytes, captured stderr text or record contents.
 */
export class SplitSmokeWaitError extends Error {
  constructor(category, facts = {}) {
    const expected = reloadNoticeTypeOrUndefined(facts.expected)
    const observed = reloadNoticeTypeOrUndefined(facts.observed)
    const label = bounded(facts.waitLabel, MAX_LABEL_CHARS)
    const role = boundedName(facts.processRole)
    super([
      `${category}: ${role ?? 'lane'}`,
      label,
      Number.isInteger(facts.elapsedMs) ? `after ${String(facts.elapsedMs)}ms` : undefined,
      expected === undefined ? undefined : `expected ${expected}`,
      observed === undefined ? undefined : `observed ${observed}`,
    ].filter(part => part !== undefined).join(': '))
    this.name = 'SplitSmokeWaitError'
    this.category = FAILURE_CATEGORIES.includes(category) ? category : 'INFRA_FAILURE'
    this.code = laneCodeOrUndefined(facts.code)
    this.waitLabel = label
    this.processRole = role
    this.elapsedMs = Number.isInteger(facts.elapsedMs) ? facts.elapsedMs : undefined
    this.expected = expected
    this.observed = observed
    /** The throwing waiter's own view of its process (already-exited targets are
     *  not in the lane's live list; this projection is bounded at report time). */
    this.processSummary = facts.process
    /** Every process this wait observed, for a failure that outlived the set. */
    this.processSummaries = Array.isArray(facts.processes) ? facts.processes : undefined
  }
}

/**
 * Classify one painted viewport row as a `/reload-client` notice, or refuse to.
 *
 * Only a row whose START carries the product notice shape and whose whole text
 * equals one known notice is classified; anything else returns `undefined`. A
 * prompt that repeats the same words, or any other painted row, can therefore
 * never be mistaken for a refusal.
 */
export function classifyReloadNoticeLine(line) {
  if (typeof line !== 'string' || !RELOAD_NOTICE_LINE.test(line)) return undefined
  return RELOAD_NOTICE_BY_TEXT.get(line.trimStart().slice(2).trim())
}

/** Every reload notice currently visible in one viewport (fixed enums only). */
export function classifyReloadNotices(viewportLines) {
  const types = []
  for (const line of Array.isArray(viewportLines) ? viewportLines : []) {
    const type = classifyReloadNoticeLine(line)
    if (type !== undefined && !types.includes(type)) types.push(type)
  }
  return types
}

/**
 * Diagnostic classification of the Client's internal `handoff-request-rejected`
 * `error` field. That field is NOT a public enum: it may only ever say "this
 * wait can no longer succeed", and the original text is never copied anywhere.
 */
export function classifyHandoffRejection(error) {
  if (typeof error !== 'string') return 'TARGET_INVALID_UNCLASSIFIED'
  if (error.includes('target package is pinned to a different DSH runtime')) return 'TARGET_INVALID_DSH_PIN_MISMATCH'
  if (error.includes('installed Client already runs this build')) return 'ALREADY_CURRENT'
  return 'TARGET_INVALID_UNCLASSIFIED'
}

/** The painted notice type of one known notice text (lane expected-value input). */
export function reloadNoticeTypeForText(text) {
  const type = RELOAD_NOTICE_BY_TEXT.get(bounded(text, 200) ?? '')
  if (type === undefined) throw new TypeError('split smoke: unknown /reload-client notice text')
  return type
}

/**
 * Require that one already-validated tarball manifest declares the exact DSH
 * runtime pin this lane runs. Returns the validated pin.
 *
 * Deliberately NO range matching and NO "compatible enough" inference: only
 * string equality with the lane's `npmDshVersion()` target qualifies.
 */
export function requireExactSmokeDshPin(role, manifest, targetDshVersion) {
  if (!INPUT_ROLES.has(role)) throw new TypeError(`split smoke pin guard: unknown role ${String(role)}`)
  if (exactPinOrUndefined(targetDshVersion) === undefined) {
    throw new TypeError('split smoke pin guard: the lane target must be an exact DSH version')
  }
  const pin = manifest?.devDependencies?.[DSH_AGENT_PACKAGE]
  if (exactPinOrUndefined(pin) === undefined) {
    // Never echo the illegal value: a manifest field is arbitrary input.
    throw new SplitSmokeInputError(
      'INPUT_DSH_PIN_MISSING_OR_INVALID',
      `INPUT_UNQUALIFIED: INPUT_DSH_PIN_MISSING_OR_INVALID (INVALID_TEST_PAIRING, not a product regression): `
        + `the ${role} split-smoke artifact declares no exact ${DSH_AGENT_PACKAGE} devDependency pin, `
        + `but this lane runs ${targetDshVersion}; rebuild the ${role} qualification artifact against DSH ${targetDshVersion}`,
      { role, targetDshVersion },
    )
  }
  if (pin !== targetDshVersion) {
    throw new SplitSmokeInputError(
      'INPUT_DSH_PIN_MISMATCH',
      `INPUT_UNQUALIFIED: INPUT_DSH_PIN_MISMATCH (INVALID_TEST_PAIRING, not a product regression): `
        + `the ${role} split-smoke artifact pins ${DSH_AGENT_PACKAGE} ${pin}, but this lane runs ${targetDshVersion}; `
        + `rebuild the ${role} qualification artifact against DSH ${targetDshVersion}`,
      { role, targetDshVersion, artifactPin: pin },
    )
  }
  return pin
}

/** The whitelisted artifact identity a lane may report from one tarball manifest. */
export function smokeArtifactIdentity(role, manifest, checksum) {
  return {
    role: boundedName(role),
    name: boundedName(manifest?.name),
    version: boundedName(manifest?.version),
    sha256: sha256OrUndefined(checksum),
    pin: exactPinOrUndefined(manifest?.devDependencies?.[DSH_AGENT_PACKAGE]),
  }
}

/** One owned process → the bounded projection a report may carry. */
function projectProcess(handle) {
  if (handle === null || typeof handle !== 'object') return undefined
  const records = Array.isArray(handle.records) ? handle.records : []
  const events = []
  for (const record of records.slice(-MAX_PROCESS_EVENTS)) {
    const event = {}
    for (const key of EVENT_KEYS) {
      const value = eventNameOrUndefined(key, record?.[key])
      if (value !== undefined) event[key] = value
    }
    if (Object.keys(event).length > 0) events.push(event)
  }
  // A reexec leaves BOTH Clients' records in the SAME stream, so the identity a
  // report names must be the NEWEST one: the oldest `ready` would blame the
  // replacement's failure on the PID that already handed off.
  let identity
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const name = records[index]?.m4a0
    if (name === 'ready' || name === 'client-started') {
      identity = records[index]
      break
    }
  }
  const summary = {
    role: boundedName(handle.role),
    exited: handle.exited === true,
    events,
  }
  if (Number.isInteger(identity?.pid)) summary.pid = identity.pid
  if (handle.exitResult !== undefined) {
    if (Number.isInteger(handle.exitResult.code)) summary.exitCode = handle.exitResult.code
    const signal = boundedName(handle.exitResult.signal)
    if (signal !== undefined) summary.exitSignal = signal
  }
  return summary.role === undefined ? undefined : summary
}

/**
 * Owned processes → bounded summaries, capped.
 *
 * Two handles collapse into one summary only when they are the same PROCESS:
 * either the same object (the live list and an error's own snapshot can carry
 * the same handle) or the same KNOWN `(role, pid)`. A missing PID is not an
 * identity: the T08 race starts sixteen processes whose role is `"host"` and
 * which never publish `ready`, so equality on `(role, undefined)` would report
 * sixteen DIFFERENT processes as one — exactly the failure whose report needs
 * them all.
 */
function projectProcesses(handles) {
  const summaries = []
  const seenHandles = new Set()
  const byIdentity = new Map()
  for (const handle of Array.isArray(handles) ? handles : []) {
    const isObject = handle !== null && typeof handle === 'object'
    if (isObject && seenHandles.has(handle)) continue
    const summary = projectProcess(handle)
    if (summary === undefined) continue
    if (isObject) seenHandles.add(handle)
    // A PID is a real identity only when the process published one.
    const identity = Number.isInteger(summary.pid)
      ? `${String(summary.role)}\u0000${String(summary.pid)}`
      : undefined
    if (identity !== undefined) {
      const known = byIdentity.get(identity)
      if (known !== undefined) {
        known.exited = known.exited || summary.exited
        known.exitCode = summary.exitCode ?? known.exitCode
        known.exitSignal = summary.exitSignal ?? known.exitSignal
        known.events = summary.events
        continue
      }
    }
    summaries.push(summary)
    if (identity !== undefined) byIdentity.set(identity, summary)
  }
  return summaries.slice(-MAX_PROCESSES)
}

function projectArtifacts(artifacts) {
  return (Array.isArray(artifacts) ? artifacts : [])
    .map(artifact => {
      const entry = { role: boundedName(artifact?.role) }
      if (entry.role === undefined) return undefined
      for (const key of ['name', 'version']) {
        const value = boundedName(artifact?.[key])
        if (value !== undefined) entry[key] = value
      }
      const sha256 = sha256OrUndefined(artifact?.sha256)
      if (sha256 !== undefined) entry.sha256 = sha256
      // Idempotent: a fresh identity carries `pin`, an already-projected one
      // carries `dshPin`, and re-projecting it must not lose the version.
      const pin = exactPinOrUndefined(artifact?.pin ?? artifact?.dshPin)
      if (pin !== undefined) entry.dshPin = pin
      return entry
    })
    .filter(entry => entry !== undefined)
    .slice(-MAX_ARTIFACTS)
}

/**
 * The ONE default failure report shape (`schemaVersion: 1`). A field the lane
 * cannot state is omitted, never guessed, and nothing outside the whitelist is
 * copied.
 */
export function projectFailureReport(input = {}) {
  const report = {
    schemaVersion: 1,
    lane: boundedName(input.lane) ?? 'split-process',
    status: 'FAIL',
    category: FAILURE_CATEGORIES.includes(input.category) ? input.category : 'INFRA_FAILURE',
  }
  // The code whitelist has exactly one home: an unknown `code` leaves the report
  // at its category instead of becoming reported text.
  const reason = laneCodeOrUndefined(input.reason)
  if (reason !== undefined) report.reason = reason
  const checkpoint = boundedName(input.checkpoint)
  if (checkpoint !== undefined) report.checkpoint = checkpoint
  // The assertion locator must satisfy the shape AND belong to a trusted lane
  // source. A shape-only check would let any error that happens to carry an
  // `assertion` property name a file the locator never vouched for.
  const assertion = assertionSiteOrUndefined(input.assertion)
  if (assertion !== undefined) report.assertion = assertion
  const waitLabel = bounded(input.waitLabel, MAX_LABEL_CHARS)
  if (waitLabel !== undefined) report.waitLabel = waitLabel
  if (Number.isInteger(input.elapsedMs)) report.elapsedMs = input.elapsedMs
  const runtimeDshPin = exactPinOrUndefined(input.runtimeDshPin)
  if (runtimeDshPin !== undefined) report.runtimeDshPin = runtimeDshPin
  const artifacts = projectArtifacts(input.artifacts)
  if (artifacts.length > 0) report.artifacts = artifacts
  const expected = reloadNoticeTypeOrUndefined(input.expected)
  if (expected !== undefined) report.expected = expected
  const observed = reloadNoticeTypeOrUndefined(input.observed)
  if (observed !== undefined) report.observed = observed
  const progress = (Array.isArray(input.progress) ? input.progress : [])
    .map(step => {
      const name = boundedName(step?.name)
      if (name === undefined) return undefined
      return Number.isInteger(step.elapsedMs) ? { name, elapsedMs: step.elapsedMs } : { name }
    })
    .filter(step => step !== undefined)
    .slice(-MAX_CHECKPOINTS)
  if (progress.length > 0) report.progress = progress
  const processes = projectProcesses(input.processes)
  if (processes.length > 0) report.processes = processes
  return report
}

/** The stable category of any lane error: its explicit code first, else the message shape. */
export function failureCategoryOf(error) {
  if (FAILURE_CATEGORIES.includes(error?.category)) return error.category
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (message.startsWith('ASSERTION_FAILED:')) return 'ASSERTION_FAILED'
  return 'INFRA_FAILURE'
}

/**
 * The ONE concise final stderr line: the fixed category and its stable code.
 *
 * No `Error.message` of any origin reaches the default output — not a lane
 * assertion, not a tar or parser failure, not a classified waiter error. The
 * text of a waiter error is itself a projection of whitelisted fields, but the
 * same fields already appear in the structured block the lane printed, so the
 * final line adds nothing but the classification. Anything beyond that is
 * forensics, and forensics is the operator's explicit `KEEP` run.
 */
export function safeFailureSummary(error) {
  const category = failureCategoryOf(error)
  const reason = laneCodeOrUndefined(error?.code)
  const head = reason === undefined ? category : `${category}: ${reason}`
  // Never read `error.assertion` here: only `publishedAssertionOf` may look at
  // the property, so a forged one cannot reach the summary either.
  const site = assertionSiteOrUndefined(publishedAssertionOf(error))
  const at = site === undefined ? '' : ` at ${site}`
  return `${head}${at}`
}

/**
 * The explicit forensic detail, printed ONLY when the operator already asked
 * for the preserved work root (`KEEP`). The default and CI path never calls it.
 */
export function forensicErrorText(error, limit = 2_000) {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? '')
  return bounded(text, limit) ?? '(no detail)'
}

/**
 * A lane assertion that can be LOCATED without being quoted.
 *
 * `ASSERTION_FAILED` was previously an ordinary `Error`, so once the message was
 * kept out of the default output (rightly: it interpolates records and tool
 * text) a failed check became `ASSERTION_FAILED` and nothing else. This carries
 * the one locator that is safe to publish — the calling file's BASENAME and its
 * line number — derived from the stack and filtered against the lane's own
 * assert helpers, so it names the check site rather than a helper frame. The
 * message itself stays out of the default report and is printed only under
 * `KEEP`, where the operator already kept the private scene.
 */
const ASSERT_HELPER_FRAMES = /^(?:assert|assertEqual|assertNotEqual|assertDeepEqual|assertMatch|laneAssertionError|SplitSmokeAssertionError)$/u

/**
 * The ONLY files whose stack frames may become an `assertion` locator.
 *
 * The shape check alone would trust any `.mjs` frame, including a helper, a
 * vendored module or a forged path a caller managed to get onto the stack. The
 * locator is meant to point at the lane's own assertion, so the basename must be
 * one of the lanes this module serves; every other frame is skipped and, when
 * nothing trusted remains, the field is simply omitted (fail closed).
 */
const LANE_SOURCE_LIST = Object.freeze([
  'split-process-smoke.mjs',
  'split-process-upgrade-smoke.mjs',
  // The extracted support modules that raise their own SplitSmokeAssertionError.
  // `split-smoke-sessions.mjs` is deliberately absent: it only classifies waits.
  'host-runtime-disabled.mjs',
  'split-smoke-processes.mjs',
  'split-smoke-fixtures.mjs',
  'split-smoke-profile.mjs',
])
/** The trust set as a live Set, kept private so no caller can widen it. */
const LANE_SOURCES = new Set(LANE_SOURCE_LIST)

/** The lane scripts whose assertion frames may become a locator (read-only). */
export const LANE_SOURCE_FILES = Object.freeze(LANE_SOURCE_LIST)

/** Whether `basename` belongs to the default trusted lane sources. */
export function isLaneSourceFile(basename) {
  return LANE_SOURCES.has(basename)
}
const STACK_FRAME = /^at (?:async )?(?:(?<fn>[A-Za-z0-9_$.<>| ]+?) \()?(?<path>[^\s()]+):(?<line>\d+):\d+\)?$/u
const SAFE_BASENAME = /^[A-Za-z0-9._-]{1,64}\.mjs$/u
/** The published assertion-site shape; the source check is separate. */
const ASSERTION_SITE = /^[A-Za-z0-9._-]{1,64}\.mjs:[1-9][0-9]{0,6}$/u

export class SplitSmokeAssertionError extends Error {
  constructor(message, facts = {}) {
    super(`ASSERTION_FAILED: ${message}`)
    this.name = 'SplitSmokeAssertionError'
    this.category = 'ASSERTION_FAILED'
    this.assertion = laneAssertionSite(this.constructor, facts.sources)
    this.checkpoint = facts.checkpoint
  }
}

/**
 * The caller's `<basename>:<line>` for a failure thrown from a lane assert
 * helper, restricted to a trusted source set (`sources`, defaulting to the lane
 * scripts). `holder` hides the error constructor's own frame.
 */
export function laneAssertionSite(holder, sources) {
  const trusted = sources ?? LANE_SOURCES
  const site = new Error()
  if (holder !== undefined) Error.captureStackTrace?.(site, holder)
  const frames = String(site.stack ?? '').split('\n').slice(1)
  for (const frame of frames) {
    const m = STACK_FRAME.exec(frame.trim())
    if (m === null) continue
    const groups = m.groups ?? {}
    const fn = (groups.fn ?? '').trim().split(/\s+/).at(-1) ?? ''
    if (ASSERT_HELPER_FRAMES.test(fn)) continue
    const file = String(groups.path ?? groups.bare ?? '').split('/').pop()
    const line = Number(groups.line)
    if (!SAFE_BASENAME.test(file) || !trusted.has(file)) continue
    if (!Number.isInteger(line) || line <= 0) continue
    return `${file}:${line}`
  }
  return undefined
}

/**
 * Write the private `0600` report file.
 *
 * The target is REPLACED, never rewritten in place: `writeFileSync({mode})`
 * does not tighten the mode of an inode that already exists, and an existing
 * symlink would be followed into whatever it points at. Writing an exclusive
 * sibling and renaming it gives the reader one complete file with the private
 * mode on a fresh inode. A diagnostic write never replaces the real failure.
 */
export function writePrivateReport(path, value) {
  const tempPath = `${path}.${String(process.pid)}.tmp`
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    chmodSync(tempPath, 0o600)
    renameSync(tempPath, path)
    return true
  } catch (error) {
    try { rmSync(tempPath, { force: true }) } catch { /* the original failure still owns the exit */ }
    process.stderr.write(`${writeFailureLine(error)}\n`)
    return false
  }
}

/**
 * Write the one default-retained failure artifact: a private directory OUTSIDE
 * the deletable work root (`0700`) holding `failure.json` (`0600`, created
 * exclusively). Returns its path, or `undefined` when the write itself failed.
 */
export function writeFailureReport(report) {
  try {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-pi-tui-smoke-failure-'))
    chmodSync(directory, 0o700)
    const path = join(directory, 'failure.json')
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    chmodSync(path, 0o600)
    return path
  } catch (error) {
    process.stderr.write(`${writeFailureLine(error)}\n`)
    return undefined
  }
}

/** The safe stderr summary of one failure report: fixed keys, bounded values. */
export function formatFailureSummary(report, reportPath) {
  const lines = []
  const add = (key, value) => {
    if (value !== undefined) lines.push(`  ${key}: ${String(value)}`)
  }
  add('category', report.category)
  add('reason', report.reason)
  add('checkpoint', report.checkpoint)
  add('assertion', report.assertion)
  add('wait', report.waitLabel)
  add('elapsedMs', report.elapsedMs)
  add('runtimeDshPin', report.runtimeDshPin)
  for (const artifact of report.artifacts ?? []) {
    add(artifact.role, `${artifact.name ?? '(unknown)'}@${artifact.version ?? '(unknown)'}; `
      + `pin=${artifact.dshPin ?? '(unqualified)'}; sha256=${artifact.sha256 ?? '(unread)'}`)
  }
  add('expected', report.expected)
  add('observed', report.observed)
  const progress = (report.progress ?? []).map(step => step.name)
  if (progress.length > 0) add('recent checkpoints', progress.join(' -> '))
  for (const handle of report.processes ?? []) {
    add(handle.role, `pid=${String(handle.pid ?? 'unknown')} exited=${String(handle.exited)} `
      + `events=${handle.events.map(event => Object.values(event).join('=')).join(',')}`)
  }
  add('report', reportPath)
  return lines.join('\n')
}

/**
 * Emit the fixed failure projection for a lane error raised BEFORE its
 * diagnostics collector existed (bad arguments, an unreadable or unnameable
 * artifact, a missing pin source). There are no processes or checkpoints to
 * project, so none are invented: the report holds the lane, the category, the
 * stable code and — for the dedicated input error — only the artifact role and
 * the exact pins that error already validated.
 */
export function emitInputFailure({ lane, heading, error, reason, evidencePath }) {
  // The dedicated input error is the ONE boundary that already holds the
  // validated artifact role and the two exact pins of an invalid pairing.
  // Projecting those declared facts keeps the role and both pins in the report
  // without copying any raw error text; a selector error carries neither, so it
  // stays role-less rather than inventing an artifact.
  const inputFacts = error instanceof SplitSmokeInputError ? error : undefined
  const report = projectFailureReport({
    lane,
    category: failureCategoryOf(error),
    reason: reason ?? error?.code,
    assertion: publishedAssertionOf(error),
    runtimeDshPin: inputFacts?.targetDshVersion,
    artifacts: inputFacts?.role === undefined
      ? []
      : [{ role: inputFacts.role, pin: inputFacts.artifactPin }],
  })
  const path = writeFailureReport(report)
  process.stderr.write(`${heading}_FAILURE\n${formatFailureSummary(report, path)}\n`)
  if (evidencePath !== undefined) writePrivateReport(evidencePath, report)
  return report
}

/**
 * The per-run collector a lane owns: its reported identity, the bounded
 * checkpoint ring, and the single default failure emission. No global state, no
 * lifecycle, no product read.
 */
export function createSmokeDiagnostics({ lane, heading, marker, runtimeDshPin, artifacts = [] }) {
  const startedAt = Date.now()
  const steps = []
  const pinned = exactPinOrUndefined(runtimeDshPin)
  const identity = projectArtifacts(artifacts)
  return {
    /** One phase boundary: remembered, and announced on stderr by default. */
    checkpoint(name) {
      const step = boundedName(name)
      if (step === undefined) return
      steps.push({ name: step, elapsedMs: Date.now() - startedAt })
      if (steps.length > MAX_CHECKPOINTS) steps.shift()
      process.stderr.write(`[${marker} checkpoint] ${step}\n`)
    },
    progress() {
      return steps.map(step => ({ ...step }))
    },
    /** The one-line startup identity — only ever printed AFTER preflight passed. */
    identityLine() {
      const parts = identity.map(entry => `${entry.role}=${entry.name ?? '(unknown)'}@${entry.version ?? '(unknown)'}`
        + ` sha256=${entry.sha256 ?? '(unread)'} pin=${entry.dshPin ?? '(unqualified)'}`)
      parts.push(`runtimeDshPin=${pinned ?? '(unpinned)'}`)
      parts.push('qualified=true')
      return `${heading}_START ${parts.join('; ')}`
    },
    /**
     * Build, write and announce the bounded failure projection. Returns the
     * report; propagating the original error stays the lane's job, as does the
     * cleanup in its own `finally`.
     *
     * `evidencePath` is the split-upgrade lane's `--evidence` file: its FAIL twin holds the
     * same safe fields (`0600`). A missing path is simply no twin.
     */
    reportFailure(error, { processes = [], evidencePath, ...extra } = {}) {
      const report = projectFailureReport({
        lane,
        category: extra.category ?? failureCategoryOf(error),
        reason: extra.reason ?? error?.code,
        checkpoint: extra.checkpoint ?? steps.at(-1)?.name,
        assertion: extra.assertion ?? publishedAssertionOf(error),
        waitLabel: extra.waitLabel ?? error?.waitLabel,
        elapsedMs: extra.elapsedMs ?? error?.elapsedMs,
        expected: extra.expected ?? error?.expected,
        observed: extra.observed ?? error?.observed,
        runtimeDshPin: pinned,
        artifacts: identity,
        progress: steps,
        processes: [
          ...processes,
          ...(error?.processSummaries ?? []),
          ...(error?.processSummary === undefined ? [] : [error.processSummary]),
        ],
      })
      const path = writeFailureReport(report)
      process.stderr.write(`${heading}_FAILURE\n${formatFailureSummary(report, path)}\n`)
      if (evidencePath !== undefined) writePrivateReport(evidencePath, report)
      return report
    },
  }
}
