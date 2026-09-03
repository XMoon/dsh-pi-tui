#!/usr/bin/env node
/**
 * Validate the structured pi-tui divergence ledger and its generated report.
 *
 * This gate is intentionally stricter than a JSON parse. It makes every
 * dependency class explicit, rejects unsupported retirement claims, checks the
 * duplicated pin against UPSTREAM.json, and detects hand-edited report drift.
 * It does not decide whether a behavior is useful; the audit evidence in the
 * ledger must make that decision reviewable.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOC_PATH, MANIFEST_PATH, loadManifest, renderMarkdown } from './generate-pi-divergences.mjs'

export const DEPENDENCY_CLASSES = [
  'vendorInternal',
  'inheritanceStructural',
  'host',
  'publicExtension',
  'behavioral',
]

export const AUDIT_SCOPE = [
  'vendor-internal',
  'inheritance-structural',
  'host',
  'public-extension',
  'behavioral',
  'tests',
]

export const STATUSES = [
  'ACTIVE',
  'RETIREMENT_CANDIDATE',
  'ABSORBED_UPSTREAM',
  'MOVED_TO_HOST',
  'SUPERSEDED',
  'REDUNDANT_SHIM',
  'REMOVED_UNUSED',
]

export const EQUIVALENCE = ['YES', 'PARTIAL', 'NO', 'UNKNOWN']
export const RISKS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
export const CATEGORIES = [
  'HARD_HOST_API',
  'PUBLIC_COMPONENT_CONTRACT',
  'LOCAL_UX',
  'BUGFIX_MISSING_UPSTREAM',
  'PERF_HOST_DEPENDENT',
  'PACKAGING',
]

export const EXPECTED_IDS = [
  'X001', 'X002', 'X003', 'X004A', 'X004B', 'X005', 'X006', 'X007',
  'X008', 'X009', 'X010', 'X011', 'X012', 'X013', 'X014', 'X015',
  'X016', 'X017', 'X018', 'X019', 'X020', 'X021', 'X022', 'X023',
  'X024', 'X025', 'X026', 'X027', 'X028', 'X029', 'X030', 'X031',
  'X032', 'X033', 'X034', 'X035', 'X036', 'X037', 'X038', 'X039',
  'X040', 'X041', 'X042', 'X043', 'X044', 'X045', 'X046',
]

const ID_PATTERN = /^X\d{3}[A-Z]?$/u
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u
const SHA_PATTERN = /^[0-9a-f]{40}$/u

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function stringArray(value, { allowEmpty = true } = {}) {
  return Array.isArray(value)
    && (allowEmpty || value.length > 0)
    && value.every((item) => nonEmptyString(item))
}

function add(errors, location, message) {
  errors.push(`${location}: ${message}`)
}

function safeRelativePath(value) {
  return nonEmptyString(value)
    && !path.posix.isAbsolute(value)
    && !path.win32.isAbsolute(value)
    && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value)
    && !value.includes('\\')
    && !value.split('/').includes('..')
    && !value.startsWith('./')
}

function validDate(value) {
  if (!DATE_PATTERN.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(value)
}

function validateVerification(manifest, errors) {
  const verification = manifest.verification
  if (!isRecord(verification)) {
    add(errors, 'verification', 'must record the audit snapshot and method')
    return
  }
  if (!validDate(verification.auditedAt)) add(errors, 'verification.auditedAt', 'must be a valid YYYY-MM-DD date')
  if (!nonEmptyString(verification.branch)) add(errors, 'verification.branch', 'must be a non-empty string')
  if (!SHA_PATTERN.test(verification.auditedSourceCommit ?? '')) add(errors, 'verification.auditedSourceCommit', 'must be a full 40-character commit SHA')
  const snapshots = verification.referenceSnapshots
  if (!isRecord(snapshots)) {
    add(errors, 'verification.referenceSnapshots', 'must record upstream and Kimi audit snapshots')
  } else {
    for (const key of ['upstream', 'kimi']) {
      const snapshot = snapshots[key]
      if (!isRecord(snapshot)) {
        add(errors, `verification.referenceSnapshots.${key}`, 'must record repository and a full commit SHA')
        continue
      }
      if (!nonEmptyString(snapshot.repository)) add(errors, `verification.referenceSnapshots.${key}.repository`, 'must be a non-empty string')
      if (key === 'upstream' && nonEmptyString(manifest.baseline?.repository) && snapshot.repository !== manifest.baseline.repository) {
        add(errors, `verification.referenceSnapshots.${key}.repository`, 'must match baseline.repository')
      }
      if (!SHA_PATTERN.test(snapshot.commit ?? '')) add(errors, `verification.referenceSnapshots.${key}.commit`, 'must be a full 40-character commit SHA')
    }
  }
  if (!stringArray(verification.method, { allowEmpty: false })) add(errors, 'verification.method', 'must contain at least one audit-method statement')
}

function validateBaseline(manifest, errors, upstreamPath) {
  if (!isRecord(manifest.baseline)) {
    add(errors, 'baseline', 'must be an object')
    return
  }
  for (const key of ['repository', 'package', 'tag', 'commit']) {
    if (!nonEmptyString(manifest.baseline[key])) add(errors, `baseline.${key}`, 'must be a non-empty string')
  }
  if (!SHA_PATTERN.test(manifest.baseline.commit ?? '')) add(errors, 'baseline.commit', 'must be a full 40-character commit SHA')
  try {
    const pinned = JSON.parse(readFileSync(upstreamPath, 'utf8'))
    for (const key of ['repository', 'package', 'tag', 'commit']) {
      if (manifest.baseline[key] !== pinned[key]) {
        add(errors, `baseline.${key}`, `must match packages/pi-tui/UPSTREAM.json (${pinned[key] ?? 'missing'})`)
      }
    }
  } catch (error) {
    add(errors, 'baseline', `could not read UPSTREAM.json: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function validateDependencyMap(entry, location, errors) {
  if (!isRecord(entry.dependencies)) {
    add(errors, `${location}.dependencies`, 'must contain all five audited dependency classes')
    return
  }
  for (const key of DEPENDENCY_CLASSES) {
    const dependency = entry.dependencies[key]
    if (!isRecord(dependency)) {
      add(errors, `${location}.dependencies.${key}`, 'must be an object with audited, items, and notes')
      continue
    }
    if (dependency.audited !== true) add(errors, `${location}.dependencies.${key}.audited`, 'must be true; an absent dependency is still an audited result')
    if (!stringArray(dependency.items)) add(errors, `${location}.dependencies.${key}.items`, 'must be an array of non-empty evidence strings')
    if (!nonEmptyString(dependency.notes)) add(errors, `${location}.dependencies.${key}.notes`, 'must be a non-empty audit note')
  }
}

function validateUpstream(entry, location, errors, manifest) {
  const upstream = entry.upstream
  if (!isRecord(upstream)) {
    add(errors, `${location}.upstream`, 'must be an object')
    return
  }
  if (!EQUIVALENCE.includes(upstream.equivalence)) add(errors, `${location}.upstream.equivalence`, `must be one of ${EQUIVALENCE.join(', ')}`)
  if (!isRecord(upstream.checkedAgainst)) {
    add(errors, `${location}.upstream.checkedAgainst`, 'must record the baseline and reference source refs')
  } else {
    for (const key of ['repo', 'baselineRef', 'referenceRef']) {
      if (!nonEmptyString(upstream.checkedAgainst[key])) add(errors, `${location}.upstream.checkedAgainst.${key}`, 'must be a non-empty string')
    }
    for (const key of ['baselineRef', 'referenceRef']) {
      if (!SHA_PATTERN.test(upstream.checkedAgainst[key] ?? '')) add(errors, `${location}.upstream.checkedAgainst.${key}`, 'must be a full 40-character commit SHA')
    }
    if (nonEmptyString(manifest.baseline?.repository) && upstream.checkedAgainst.repo !== manifest.baseline.repository) {
      add(errors, `${location}.upstream.checkedAgainst.repo`, 'must match baseline.repository')
    }
    if (nonEmptyString(manifest.baseline?.commit) && upstream.checkedAgainst.baselineRef !== manifest.baseline.commit) {
      add(errors, `${location}.upstream.checkedAgainst.baselineRef`, 'must match baseline.commit')
    }
    const referenceUpstreamCommit = manifest.verification?.referenceSnapshots?.upstream?.commit
    if (SHA_PATTERN.test(referenceUpstreamCommit ?? '') && upstream.checkedAgainst.referenceRef !== referenceUpstreamCommit) {
      add(errors, `${location}.upstream.checkedAgainst.referenceRef`, 'must match verification.referenceSnapshots.upstream.commit')
    }
  }
  if (!stringArray(upstream.relevantFiles, { allowEmpty: false })) add(errors, `${location}.upstream.relevantFiles`, 'must list at least one checked source file')
  if (!stringArray(upstream.relevantIssues)) add(errors, `${location}.upstream.relevantIssues`, 'must be an array of strings (it may be empty)')
  if (!nonEmptyString(upstream.semanticDelta)) add(errors, `${location}.upstream.semanticDelta`, 'must explain semantic equivalence or the remaining delta')
}

function validateRetirement(entry, location, errors) {
  const retirement = entry.retirement
  if (!isRecord(retirement)) {
    add(errors, `${location}.retirement`, 'must be an object')
    return
  }
  if (!stringArray(retirement.conditions, { allowEmpty: false })) add(errors, `${location}.retirement.conditions`, 'must contain at least one condition')
  if (!stringArray(retirement.replacementMapping)) add(errors, `${location}.retirement.replacementMapping`, 'must be an array of strings')
  if (!stringArray(retirement.evidence)) add(errors, `${location}.retirement.evidence`, 'must be an array of strings')

  const status = entry.status
  const evidence = Array.isArray(retirement.evidence) ? retirement.evidence : []
  const mapping = Array.isArray(retirement.replacementMapping) ? retirement.replacementMapping : []
  const equivalence = entry.upstream?.equivalence
  if (status !== 'ACTIVE' && status !== 'RETIREMENT_CANDIDATE' && evidence.length === 0) {
    add(errors, `${location}.retirement.evidence`, `${status} requires retirement evidence`)
  }
  if (equivalence === 'UNKNOWN' && status !== 'ACTIVE' && status !== 'RETIREMENT_CANDIDATE') {
    add(errors, `${location}.status`, 'UNKNOWN upstream equivalence cannot be retired')
  }
  if (status === 'ABSORBED_UPSTREAM' && equivalence !== 'YES') {
    add(errors, `${location}.upstream.equivalence`, 'ABSORBED_UPSTREAM requires semantic equivalence YES')
  }
  if ((status === 'MOVED_TO_HOST' || status === 'SUPERSEDED') && mapping.length === 0) {
    add(errors, `${location}.retirement.replacementMapping`, `${status} requires a per-capability replacement mapping`)
  }
  if (status === 'REDUNDANT_SHIM') {
    if (mapping.length === 0) add(errors, `${location}.retirement.replacementMapping`, 'REDUNDANT_SHIM requires an atomic replacement mapping')
    if (mapping.length > 0 && !mapping.some((item) => /atomic/iu.test(item))) add(errors, `${location}.retirement.replacementMapping`, 'REDUNDANT_SHIM mapping must state the atomic replacement')
    if (evidence.length === 0) add(errors, `${location}.retirement.evidence`, 'REDUNDANT_SHIM requires evidence for the existing edge and replacement')
  }
  if (status === 'REMOVED_UNUSED') {
    for (const key of DEPENDENCY_CLASSES) {
      const dependency = entry.dependencies?.[key]
      if (!isRecord(dependency) || dependency.audited !== true || !Array.isArray(dependency.items) || dependency.items.length > 0) {
        add(errors, `${location}.dependencies.${key}`, 'REMOVED_UNUSED requires an audited empty dependency class')
      }
    }
    if (evidence.length > 0 && evidence.some((item) => /unknown|unresolved/iu.test(item))) {
      add(errors, `${location}.retirement.evidence`, 'REMOVED_UNUSED evidence cannot contain unresolved or unknown consumers')
    }
    if (evidence.length > 0 && !evidence.some((item) => /deletion|removed|absence|no local|no consumer/iu.test(item))) {
      add(errors, `${location}.retirement.evidence`, 'REMOVED_UNUSED requires explicit deletion/absence evidence')
    }
    if (evidence.length > 0 && !evidence.some((item) => /gate|typecheck|test|build/iu.test(item))) {
      add(errors, `${location}.retirement.evidence`, 'REMOVED_UNUSED requires deletion experiment or gate results')
    }
  }
  if (status === 'ABSORBED_UPSTREAM' && evidence.length > 0 && !evidence.some((item) => /gate|typecheck|test|build/iu.test(item))) {
    add(errors, `${location}.retirement.evidence`, 'ABSORBED_UPSTREAM requires deletion experiment or gate results')
  }
  if ((status === 'MOVED_TO_HOST' || status === 'SUPERSEDED') && mapping.length > 0) {
    const invalidMappings = mapping.filter((item) => !/(?:->|→)/u.test(item) || !/(?:owner|api|state|test)/iu.test(item))
    if (invalidMappings.length > 0) add(errors, `${location}.retirement.replacementMapping`, 'each mapping must state existing behavior -> new owner/API/state/test')
  }
}

function validateOverview(manifest, errors, required) {
  const definitions = manifest.categoryDefinitions
  if (definitions === undefined) {
    if (required) add(errors, 'categoryDefinitions', 'must preserve category meanings')
  } else if (!isRecord(definitions)) {
    add(errors, 'categoryDefinitions', 'must be an object')
  } else {
    for (const category of CATEGORIES) {
      if (!nonEmptyString(definitions[category])) add(errors, `categoryDefinitions.${category}`, 'must be a non-empty definition')
    }
  }

  const policy = manifest.gatePolicy
  if (policy === undefined) {
    if (required) add(errors, 'gatePolicy', 'must preserve source/stale/packaging gate semantics')
  } else if (!isRecord(policy)) {
    add(errors, 'gatePolicy', 'must be an object')
  } else {
    for (const key of ['sourceCoverage', 'staleActive', 'historicalRecords', 'packagingPaths', 'referenceSnapshotPolicy']) {
      if (!nonEmptyString(policy[key])) add(errors, `gatePolicy.${key}`, 'must be a non-empty policy statement')
    }
    if (!stringArray(policy.upstreamResolution, { allowEmpty: false })) add(errors, 'gatePolicy.upstreamResolution', 'must list upstream resolution strategies')
  }

  const knownIds = new Set(isRecord(manifest.divergences) ? Object.keys(manifest.divergences) : [])
  const relocation = manifest.relocationAudit
  if (relocation === undefined) {
    if (required) add(errors, 'relocationAudit', 'must preserve structured relocation decisions')
  } else if (!Array.isArray(relocation) || relocation.length === 0) {
    add(errors, 'relocationAudit', 'must be a non-empty array')
  } else {
    relocation.forEach((record, index) => {
      const location = `relocationAudit[${index}]`
      if (!isRecord(record)) {
        add(errors, location, 'must be an object')
        return
      }
      if (!nonEmptyString(record.decision)) add(errors, `${location}.decision`, 'must be a non-empty string')
      if (!Array.isArray(record.records) || record.records.length === 0 || !record.records.every((id) => typeof id === 'string' && knownIds.has(id))) {
        add(errors, `${location}.records`, 'must list known divergence IDs')
      }
      if (!nonEmptyString(record.reason)) add(errors, `${location}.reason`, 'must be a non-empty string')
    })
  }

  const removedLegacy = manifest.removedLegacy
  if (removedLegacy === undefined) {
    if (required) add(errors, 'removedLegacy', 'must preserve structured removed/superseded surface decisions')
  } else if (!Array.isArray(removedLegacy) || removedLegacy.length === 0) {
    add(errors, 'removedLegacy', 'must be a non-empty array')
  } else {
    removedLegacy.forEach((record, index) => {
      const location = `removedLegacy[${index}]`
      if (!isRecord(record)) {
        add(errors, location, 'must be an object')
        return
      }
      for (const key of ['surface', 'decision', 'reason']) {
        if (!nonEmptyString(record[key])) add(errors, `${location}.${key}`, 'must be a non-empty string')
      }
    })
  }
}

function validateEntry(id, entry, errors, manifest) {
  const location = `divergences.${id}`
  if (!ID_PATTERN.test(id)) add(errors, location, 'ID must match Xnnn or XnnnA')
  if (!isRecord(entry)) {
    add(errors, location, 'must be an object')
    return
  }
  for (const key of ['title', 'why']) {
    if (!nonEmptyString(entry[key])) add(errors, `${location}.${key}`, 'must be a non-empty string')
  }
  if (!STATUSES.includes(entry.status)) add(errors, `${location}.status`, `must be one of ${STATUSES.join(', ')}`)
  if (!Array.isArray(entry.category) || entry.category.length === 0 || !entry.category.every((item) => CATEGORIES.includes(item))) {
    add(errors, `${location}.category`, `must be a non-empty array using ${CATEGORIES.join(', ')}`)
  }
  if (!RISKS.includes(entry.risk)) add(errors, `${location}.risk`, `must be one of ${RISKS.join(', ')}`)
  if (!Array.isArray(entry.files) || entry.files.length === 0 || !entry.files.every(safeRelativePath)) {
    add(errors, `${location}.files`, 'must be a non-empty array of safe relative paths')
  } else if (new Set(entry.files).size !== entry.files.length) {
    add(errors, `${location}.files`, 'must not contain duplicate paths')
  }
  if (!stringArray(entry.changedSurface, { allowEmpty: false })) add(errors, `${location}.changedSurface`, 'must contain at least one surface description')
  if (!stringArray(entry.tests, { allowEmpty: false })) add(errors, `${location}.tests`, 'must contain at least one test or an explicit missing-test note')

  validateDependencyMap(entry, location, errors)
  validateUpstream(entry, location, errors, manifest)
  validateRetirement(entry, location, errors)

  if (!isRecord(entry.audit)) {
    add(errors, `${location}.audit`, 'must record date, scope, and notes')
  } else {
    if (!validDate(entry.audit.lastAuditedAt)) add(errors, `${location}.audit.lastAuditedAt`, 'must be a valid YYYY-MM-DD date')
    if (!Array.isArray(entry.audit.scope) || !AUDIT_SCOPE.every((item) => entry.audit.scope.includes(item))) {
      add(errors, `${location}.audit.scope`, `must include all six audit scopes: ${AUDIT_SCOPE.join(', ')}`)
    }
    if (!nonEmptyString(entry.audit.notes)) add(errors, `${location}.audit.notes`, 'must be a non-empty audit note')
  }
}

export function validateManifest(manifest, {
  upstreamPath = path.join(path.dirname(MANIFEST_PATH), 'UPSTREAM.json'),
  documentPath = DOC_PATH,
  checkBaseline = true,
  checkReport = true,
  requireInventory = true,
} = {}) {
  const errors = []
  if (!isRecord(manifest)) return ['manifest: must be a JSON object']
  if (manifest.schemaVersion !== 2) add(errors, 'schemaVersion', 'must be exactly 2')
  if (checkBaseline) validateBaseline(manifest, errors, upstreamPath)
  if (requireInventory || manifest.verification !== undefined) validateVerification(manifest, errors)

  if (!isRecord(manifest.divergences)) {
    add(errors, 'divergences', 'must be an object keyed by divergence ID')
  } else {
    const ids = Object.keys(manifest.divergences)
    if (ids.length === 0) add(errors, 'divergences', 'must contain at least one record')
    if (requireInventory) {
      for (const expected of EXPECTED_IDS) {
        if (!Object.hasOwn(manifest.divergences, expected)) add(errors, 'divergences', `missing required audit record ${expected}`)
      }
    }
    for (const [id, entry] of Object.entries(manifest.divergences)) validateEntry(id, entry, errors, manifest)
  }
  validateOverview(manifest, errors, requireInventory)

  if (checkReport) {
    try {
      const expected = renderMarkdown(manifest)
      const actual = readFileSync(documentPath, 'utf8')
      if (actual !== expected) add(errors, 'DIVERGENCES.md', 'does not match the deterministic report generated from vendor-divergences.json; run pnpm generate:pi-divergences')
    } catch (error) {
      add(errors, 'DIVERGENCES.md', `could not check generated report: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return errors
}

export function runLedgerGate({ manifestPath = MANIFEST_PATH, ...options } = {}) {
  let manifest
  try {
    manifest = loadManifest(manifestPath)
  } catch (error) {
    return [`manifest: could not read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`]
  }
  return validateManifest(manifest, {
    upstreamPath: path.join(path.dirname(manifestPath), 'UPSTREAM.json'),
    ...options,
  })
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  try {
    const errors = runLedgerGate()
    if (errors.length > 0) {
      console.error(`pi-divergence-ledger gate: ${errors.length} error(s)`)
      for (const error of errors) console.error(`  - ${error}`)
      process.exitCode = 1
    } else {
      console.log(`pi-divergence-ledger gate: OK (schema v2, ${EXPECTED_IDS.length} required records, generated report in sync)`)
    }
  } catch (error) {
    console.error(`pi-divergence-ledger gate: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }
}
