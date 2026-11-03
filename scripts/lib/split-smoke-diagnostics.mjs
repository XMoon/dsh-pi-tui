#!/usr/bin/env node
/**
 * Shared input qualification for the two split-process smoke lanes
 * (`split-process-smoke.mjs` T and `split-process-upgrade-smoke.mjs` U).
 *
 * Both lanes run against the ONE exact DSH runtime this checkout declares
 * (`npmDshVersion()`), so every packaged input must declare that same exact
 * pin. The production Client reexec preflight enforces the identical rule at
 * runtime and refuses a mismatching target; a lane that starts with a
 * differently pinned artifact therefore fails on its NEGATIVE expectation and
 * reports it as a timeout. This module makes that pairing mistake a fast,
 * explicitly classified INPUT problem instead of a product-looking failure.
 *
 * The module is deliberately pure: it reads no product service, owns no process
 * or lifecycle, and never decides PASS. The real PTY viewport and the entry's
 * own JSONL records stay the only authorities.
 *
 * @module split-smoke-diagnostics
 */

import { DSH_AGENT_PACKAGE } from './dsh-distribution.mjs'

/**
 * The exact-pin grammar of `dsh-distribution.mjs` `npmDshVersion()`. The two
 * spellings must stay identical: one lane-wide authority decides what "an exact
 * DSH version" means, and the guard must not be stricter or looser than the
 * value it compares against.
 */
const EXACT_DSH_PIN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

const INPUT_ROLES = new Set(['candidate', 'old', 'new'])

function exactPinOrUndefined(value) {
  return typeof value === 'string' && EXACT_DSH_PIN.test(value) ? value : undefined
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
    this.code = boundedName(facts.code)
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

