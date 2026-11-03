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

/** The three official telemetry event keys a report may name. */
const EVENT_KEYS = Object.freeze(['m4a0', 'm4r', 'm4b2s'])

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
  'EVIDENCE_WRITE_FAILED',
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
      const value = boundedName(record?.[key])
      if (value !== undefined) event[key] = value
    }
    if (Object.keys(event).length > 0) events.push(event)
  }
  const identity = records.find(record => record?.m4a0 === 'ready')
    ?? records.find(record => record?.m4a0 === 'client-started')
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

/** Owned processes → bounded summaries, merged by role+PID, capped. */
function projectProcesses(handles) {
  const summaries = []
  for (const handle of Array.isArray(handles) ? handles : []) {
    const summary = projectProcess(handle)
    if (summary === undefined) continue
    const known = summaries.find(entry => entry.role === summary.role && entry.pid === summary.pid)
    // A live handle and the exiting snapshot of the SAME process never count twice.
    if (known !== undefined) {
      known.exited = known.exited || summary.exited
      known.exitCode = summary.exitCode ?? known.exitCode
      known.exitSignal = summary.exitSignal ?? known.exitSignal
      known.events = summary.events
      continue
    }
    summaries.push(summary)
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
  return reason === undefined ? category : `${category}: ${reason}`
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
 * artifact, a missing pin source). There are no artifacts, processes or
 * checkpoints to project, so none are invented: the report holds the lane, the
 * category, the stable code and the target pin the lane could know.
 */
export function emitInputFailure({ lane, heading, error, reason, evidencePath }) {
  const report = projectFailureReport({
    lane,
    category: failureCategoryOf(error),
    reason: reason ?? error?.code,
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
        waitLabel: extra.waitLabel ?? error?.waitLabel,
        elapsedMs: extra.elapsedMs ?? error?.elapsedMs,
        expected: extra.expected ?? error?.expected,
        observed: extra.observed ?? error?.observed,
        runtimeDshPin: pinned,
        artifacts: identity,
        progress: steps,
        processes: error?.processSummary === undefined
          ? processes
          : [...processes, error.processSummary],
      })
      const path = writeFailureReport(report)
      process.stderr.write(`${heading}_FAILURE\n${formatFailureSummary(report, path)}\n`)
      if (evidencePath !== undefined) writePrivateReport(evidencePath, report)
      return report
    },
  }
}
