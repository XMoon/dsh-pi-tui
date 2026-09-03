#!/usr/bin/env node
/**
 * Render the structured vendor divergence ledger as the human-readable report.
 *
 * vendor-divergences.json is authoritative. DIVERGENCES.md is generated from
 * it and must never carry hand-edited entry facts. The renderer is deliberately
 * deterministic: IDs are sorted numerically (including X004A/X004B), arrays
 * retain their authored evidence order, and the output always uses LF plus a
 * final newline.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const MANIFEST_PATH = path.join(ROOT, 'packages', 'pi-tui', 'vendor-divergences.json')
export const DOC_PATH = path.join(ROOT, 'packages', 'pi-tui', 'DIVERGENCES.md')

const DEPENDENCY_LABELS = {
  vendorInternal: 'Vendor internal',
  inheritanceStructural: 'Inheritance / structural',
  host: 'Host',
  publicExtension: 'Public / extension',
  behavioral: 'Behavioral coupling',
}

function naturalIdCompare(a, b) {
  const left = /^X(\d+)(.*)$/u.exec(a)
  const right = /^X(\d+)(.*)$/u.exec(b)
  if (left === null || right === null) return a.localeCompare(b)
  const numberDelta = Number(left[1]) - Number(right[1])
  if (numberDelta !== 0) return numberDelta
  return left[2].localeCompare(right[2])
}

export function orderedEntries(manifest) {
  return Object.entries(manifest.divergences ?? {}).sort(([left], [right]) => naturalIdCompare(left, right))
}

export function loadManifest(manifestPath = MANIFEST_PATH) {
  return JSON.parse(readFileSync(manifestPath, 'utf8'))
}

function oneLine(value) {
  return String(value ?? '').replaceAll('\r\n', '\n').replaceAll('\n', ' ').trim()
}

function code(value) {
  return `\`${oneLine(value)}\``
}

function listLines(values, empty = 'None recorded.') {
  if (!Array.isArray(values) || values.length === 0) return [`- ${empty}`]
  return values.map((value) => `- ${oneLine(value)}`)
}

function renderDependencies(entry) {
  const lines = []
  for (const [key, label] of Object.entries(DEPENDENCY_LABELS)) {
    const dependency = entry.dependencies?.[key] ?? {}
    lines.push(`**${label}**`)
    if (dependency.items?.length > 0) {
      lines.push(...listLines(dependency.items))
    } else {
      lines.push('- None found (audited).')
    }
    if (dependency.notes) lines.push(`- Audit note: ${oneLine(dependency.notes)}`)
    lines.push('')
  }
  lines.pop()
  return lines
}

function renderEntry(id, entry) {
  const categories = (entry.category ?? []).map(code).join(', ')
  const files = (entry.files ?? []).map(code).join(', ')
  const checked = entry.upstream?.checkedAgainst ?? {}
  const issueLines = entry.upstream?.relevantIssues?.length > 0
    ? entry.upstream.relevantIssues.map((issue) => `- ${oneLine(issue)}`)
    : ['- None recorded; issue/PR state was not used as semantic proof.']
  const mapping = entry.retirement?.replacementMapping ?? []
  const evidence = entry.retirement?.evidence ?? []
  const lines = [
    `### ${id} — ${oneLine(entry.title)}`,
    '',
    `- Status: ${code(entry.status)}`,
    `- Category: ${categories}`,
    `- Risk: ${code(entry.risk)}`,
    `- Files: ${files}`,
    `- Last audited: ${code(entry.audit?.lastAuditedAt)}`,
    `- Audited against: ${code(`${checked.repo ?? ''}@${checked.ref ?? ''}`)}`,
    '',
    '#### Why it exists',
    '',
    oneLine(entry.why),
    '',
    '#### Changed surface',
    '',
    ...listLines(entry.changedSurface),
    '',
    '#### Dependency map',
    '',
    ...renderDependencies(entry),
    '',
    '#### Guarding tests',
    '',
    ...listLines(entry.tests),
    '',
    '#### Upstream comparison',
    '',
    `- Baseline: ${code(`${checked.repo ?? ''}@${checked.ref ?? ''}`)}`,
    `- Semantic equivalence: ${code(entry.upstream?.equivalence)}`,
    `- Current upstream check: ${code(checked.currentRef ?? 'not recorded')}`,
    '- Relevant upstream files:',
    ...listLines(entry.upstream?.relevantFiles),
    '- Relevant issues/PRs:',
    ...issueLines,
    `- Remaining semantic delta: ${oneLine(entry.upstream?.semanticDelta)}`,
    '',
    '#### Retirement conditions',
    '',
    ...listLines(entry.retirement?.conditions),
    '',
    '#### Replacement mapping',
    '',
    ...listLines(mapping),
    '',
    '#### Retirement evidence',
    '',
    ...listLines(evidence),
    '',
    '#### Audit record',
    '',
    `- Scope: ${(entry.audit?.scope ?? []).map(code).join(', ')}`,
    `- Notes: ${oneLine(entry.audit?.notes)}`,
    '',
  ]
  return lines
}

function renderRelocationAudit(records) {
  if (!Array.isArray(records) || records.length === 0) return []
  return [
    '## Host relocation audit',
    '',
    ...records.map((record) => `- ${code(record.decision)}: ${(record.records ?? []).map(code).join(', ')} — ${oneLine(record.reason)}`),
    '',
  ]
}

function renderRemovedLegacy(records) {
  if (!Array.isArray(records) || records.length === 0) return []
  return [
    '## Removed or superseded legacy surfaces',
    '',
    ...records.map((record) => `- ${code(record.surface)} — ${code(record.decision)}: ${oneLine(record.reason)}`),
    '',
  ]
}

function renderCategoryDefinitions(definitions) {
  if (definitions === null || typeof definitions !== 'object' || Array.isArray(definitions)) return []
  const lines = ['## Category definitions', '']
  for (const [category, meaning] of Object.entries(definitions)) lines.push(`- ${code(category)}: ${oneLine(meaning)}`)
  lines.push('')
  return lines
}

function renderGatePolicy(policy) {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) return []
  const lines = ['## Gate policy', '']
  for (const key of ['sourceCoverage', 'staleActive', 'historicalRecords', 'packagingPaths']) {
    if (policy[key] !== undefined) lines.push(`- ${oneLine(key)}: ${oneLine(policy[key])}`)
  }
  if (Array.isArray(policy.upstreamResolution)) {
    lines.push('- Upstream resolution:')
    lines.push(...policy.upstreamResolution.map((value) => `  - ${oneLine(value)}`))
  }
  lines.push('')
  return lines
}

export function renderMarkdown(manifest) {
  const baseline = manifest.baseline ?? {}
  const verification = manifest.verification ?? {}
  const entries = orderedEntries(manifest)
  const statusCounts = new Map()
  for (const [, entry] of entries) statusCounts.set(entry.status, (statusCounts.get(entry.status) ?? 0) + 1)
  const statusSummary = [...statusCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${code(status)}: ${count}`)
    .join(', ')
  const methods = listLines(verification.method, 'No method notes recorded.')
  const lines = [
    '# pi-tui divergence ledger',
    '',
    '> Generated from `packages/pi-tui/vendor-divergences.json` (schema v2). Do not hand-edit this report; change the structured ledger and run `pnpm generate:pi-divergences`.',
    '>',
    '> The ledger records current consumers, structural and behavioral dependencies, semantic upstream comparison, and evidence required before a divergence can be retired.',
    '',
    '## Baseline',
    '',
    `- Upstream repository: ${code(baseline.repository)}`,
    `- Package: ${code(baseline.package)}`,
    `- Tag: ${code(baseline.tag)}`,
    `- Pinned commit: ${code(baseline.commit)}`,
    '',
    '## Re-audit context',
    '',
    `- Branch audited: ${code(verification.branch)}`,
    `- next commit: ${code(verification.nextCommit)}`,
    `- Current upstream snapshot: ${code(`${verification.currentUpstream?.repository ?? ''}@${verification.currentUpstream?.commit ?? ''}`)}`,
    `- Current Kimi snapshot: ${code(`${verification.currentKimi?.repository ?? ''}@${verification.currentKimi?.commit ?? ''}`)}`,
    `- Audit date: ${code(verification.auditedAt)}`,
    '',
    ...methods,
    '',
    '## Audit rules',
    '',
    '- Do not mark a record unused until vendor-internal, inheritance/structural, host, public/extension, behavioral, and test/runtime ownership have all been audited.',
    '- `YES` means semantic equivalence, not merely a matching symbol or a closed issue. `PARTIAL` and `NO` cannot be absorbed.',
    '- Every record has explicit dependency classes. An empty class means absence was audited, not that the audit was skipped.',
    '- Active records have retirement conditions. Non-active records retain retirement evidence; removed records must have no dependency evidence left.',
    '- Source coverage remains enforced by `pnpm gate:pi-vendor-diff --strict`; schema, retirement rules, and report drift are enforced by `pnpm gate:pi-divergence-ledger`.',
    '',
    ...renderCategoryDefinitions(manifest.categoryDefinitions),
    ...renderGatePolicy(manifest.gatePolicy),
    ...renderRelocationAudit(manifest.relocationAudit),
    ...renderRemovedLegacy(manifest.removedLegacy),
    '## Summary',
    '',
    `- Records: ${entries.length}`,
    `- Statuses: ${statusSummary}`,
    '',
    '| ID | Status | Risk | Categories | Upstream equivalence |',
    '| --- | --- | --- | --- | --- |',
    ...entries.map(([id, entry]) => `| ${id} | ${entry.status} | ${entry.risk} | ${(entry.category ?? []).join(', ')} | ${entry.upstream?.equivalence ?? ''} |`),
    '',
    '## Divergences',
    '',
  ]
  for (const [id, entry] of entries) lines.push(...renderEntry(id, entry))
  return `${lines.join('\n').replace(/\n+$/u, '')}\n`
}

export function generateReport({ manifestPath = MANIFEST_PATH, documentPath = DOC_PATH, check = false } = {}) {
  const manifest = loadManifest(manifestPath)
  const generated = renderMarkdown(manifest)
  if (check) {
    const current = readFileSync(documentPath, 'utf8')
    return { changed: current !== generated, generated }
  }
  writeFileSync(documentPath, generated)
  return { changed: true, generated }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  try {
    const check = process.argv.includes('--check')
    const result = generateReport({ check })
    if (check) {
      if (result.changed) {
        console.error('generate-pi-divergences: DIVERGENCES.md is out of date; run pnpm generate:pi-divergences')
        process.exitCode = 1
      } else {
        console.log('generate-pi-divergences: generated report is up to date')
      }
    } else {
      console.log(`generate-pi-divergences: wrote ${DOC_PATH}`)
    }
  } catch (error) {
    console.error(`generate-pi-divergences: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }
}
