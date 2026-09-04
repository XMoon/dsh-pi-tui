/**
 * Regression fixtures for the schema-v2 divergence ledger. The fixtures are
 * intentionally about proof quality: a source diff can be covered by a file
 * map while the retirement claim is still unsafe.
 * @module @xmoon76/dsh-pi-tui/pi-divergence-ledger-gate.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXPECTED_IDS, validateManifest } from '../scripts/pi-divergence-ledger-gate.mjs'
import { renderMarkdown } from '../scripts/generate-pi-divergences.mjs'
import { testLifecycle } from './support/temp-lifecycle.ts'

const ROOT = join(import.meta.dirname, '..')
const MANIFEST_PATH = join(ROOT, 'packages', 'pi-tui', 'vendor-divergences.json')
const REPORT_PATH = join(ROOT, 'packages', 'pi-tui', 'DIVERGENCES.md')

function currentManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
}

function fixture() {
  return structuredClone(currentManifest())
}

function errorsFor(manifest) {
  return validateManifest(manifest, {
    checkBaseline: false,
    checkReport: false,
    requireInventory: false,
  })
}

function assertHasError(errors, fragment) {
  assert.ok(errors.some((error) => error.includes(fragment)), `expected an error containing ${fragment}; got:\n${errors.join('\n')}`)
}

test('the checked-in schema-v2 ledger has the complete required inventory and report', () => {
  const errors = validateManifest(currentManifest(), {
    upstreamPath: join(ROOT, 'packages', 'pi-tui', 'UPSTREAM.json'),
    documentPath: REPORT_PATH,
    checkBaseline: true,
    checkReport: true,
    requireInventory: true,
  })
  assert.deepEqual(errors, [])
  assert.deepEqual(Object.keys(currentManifest().divergences).sort(), [...EXPECTED_IDS].sort())
})

test('overview metadata preserves category, gate, relocation, and legacy decisions', () => {
  const missing = fixture()
  delete missing.categoryDefinitions
  const missingErrors = validateManifest(missing, { checkBaseline: false, checkReport: false, requireInventory: true })
  assertHasError(missingErrors, 'categoryDefinitions')

  const malformed = fixture()
  malformed.relocationAudit[0].records = ['X999']
  malformed.gatePolicy.upstreamResolution = []
  malformed.removedLegacy[0].reason = ''
  const malformedErrors = errorsFor(malformed)
  assertHasError(malformedErrors, 'relocationAudit[0].records')
  assertHasError(malformedErrors, 'gatePolicy.upstreamResolution')
  assertHasError(malformedErrors, 'removedLegacy[0].reason')
})

test('audit snapshot commit refs must be full SHAs', () => {
  const manifest = fixture()
  manifest.verification.referenceSnapshots.kimi.commit = manifest.verification.referenceSnapshots.kimi.commit.slice(0, -1)
  const errors = validateManifest(manifest, {
    checkBaseline: false,
    checkReport: false,
    requireInventory: false,
  })
  assertHasError(errors, 'verification.referenceSnapshots.kimi.commit')
})

test('the upstream reference snapshot remains tied to the baseline repository', () => {
  const manifest = fixture()
  manifest.verification.referenceSnapshots.upstream.repository = 'evil/repo'
  const errors = errorsFor(manifest)
  assertHasError(errors, 'verification.referenceSnapshots.upstream.repository')
  assertHasError(errors, 'must match baseline.repository')
})

test('each per-record upstream comparison is anchored to the audited snapshots', () => {
  const manifest = fixture()
  manifest.divergences.X001.upstream.checkedAgainst = {
    repo: 'evil/repo',
    baselineRef: 'not-the-pinned-commit',
    referenceRef: 'other',
  }
  const errors = errorsFor(manifest)
  assertHasError(errors, 'must match baseline.repository')
  assertHasError(errors, 'must match baseline.commit')
  assertHasError(errors, 'must match verification.referenceSnapshots.upstream.commit')
})

test('a missing dependency class is a hard ledger error', () => {
  const manifest = fixture()
  delete manifest.divergences.X001.dependencies.behavioral
  const errors = errorsFor(manifest)
  assertHasError(errors, 'divergences.X001.dependencies.behavioral')
})

test('REMOVED_UNUSED cannot hide an inheritance or internal consumer', () => {
  const manifest = fixture()
  manifest.divergences.X003.dependencies.inheritanceStructural.items = ['a subclass still overrides the removed method']
  const errors = errorsFor(manifest)
  assertHasError(errors, 'REMOVED_UNUSED requires an audited empty dependency class')
})

test('ABSORBED_UPSTREAM requires semantic YES rather than a similar API', () => {
  const manifest = fixture()
  manifest.divergences.X015.upstream.equivalence = 'PARTIAL'
  const errors = errorsFor(manifest)
  assertHasError(errors, 'ABSORBED_UPSTREAM requires semantic equivalence YES')
})

test('MOVED_TO_HOST requires a capability replacement mapping', () => {
  const manifest = fixture()
  const entry = manifest.divergences.X015
  entry.status = 'MOVED_TO_HOST'
  entry.retirement.evidence = ['host replacement was reviewed']
  entry.retirement.replacementMapping = []
  const errors = errorsFor(manifest)
  assertHasError(errors, 'MOVED_TO_HOST requires a per-capability replacement mapping')

  entry.retirement.replacementMapping = ['similar implementation exists']
  const vague = errorsFor(manifest)
  assertHasError(vague, 'each mapping must state existing behavior -> new owner/API/state/test')
})

test('REDUNDANT_SHIM requires the atomic replacement and its evidence', () => {
  const manifest = fixture()
  const good = errorsFor(manifest)
  assert.deepEqual(good, [], 'the real X019 inheritance edge has a complete atomic retirement record')

  manifest.divergences.X019.retirement.replacementMapping = ['remove the base method']
  const missingAtomic = errorsFor(manifest)
  assertHasError(missingAtomic, 'REDUNDANT_SHIM mapping must state the atomic replacement')

  manifest.divergences.X019.retirement.replacementMapping = []
  manifest.divergences.X019.retirement.evidence = []
  const missingBoth = errorsFor(manifest)
  assertHasError(missingBoth, 'REDUNDANT_SHIM requires an atomic replacement mapping')
  assertHasError(missingBoth, 'REDUNDANT_SHIM requires evidence')
})

test('UNKNOWN upstream equivalence cannot be used for a retired record', () => {
  const manifest = fixture()
  manifest.divergences.X015.upstream.equivalence = 'UNKNOWN'
  const errors = errorsFor(manifest)
  assertHasError(errors, 'UNKNOWN upstream equivalence cannot be retired')
})

test('generated report drift is detected without touching the checked-in file', (t) => {
  const life = testLifecycle(t)
  const report = join(life.tempDir('pi-ledger-report-'), 'DIVERGENCES.md')
  writeFileSync(report, 'hand edited\n')
  const errors = validateManifest(fixture(), {
    checkBaseline: false,
    checkReport: true,
    documentPath: report,
    requireInventory: false,
  })
  assertHasError(errors, 'does not match the deterministic report')
})

test('report rendering is deterministic and naturally sorts mixed IDs', () => {
  const manifest = fixture()
  const first = renderMarkdown(manifest)
  const second = renderMarkdown(manifest)
  assert.equal(first, second)
  assert.ok(first.indexOf('### X004A') < first.indexOf('### X004B'))
  assert.ok(first.indexOf('### X044') < first.indexOf('### X045'))
  assert.ok(first.indexOf('### X045') < first.indexOf('### X046'))
  assert.ok(first.indexOf('### X046') < first.indexOf('### X047'))
  assert.ok(first.includes('- Baseline compared: `earendil-works/pi@b79e4cc834970cca69daebffab7df1da7d1e52c4`'))
  assert.ok(first.includes('- Reference snapshot: `earendil-works/pi@b8b873b9872db04a938fb4357b5e8e824ddc051c`'))
  assert.equal(first.endsWith('\n'), true)
  assert.equal(first.endsWith('\n\n'), false)
  assert.equal(first.includes('\n\n\n'), false)
  assert.equal(first.includes('\r'), false)
})

test('non-src packaging paths remain registered without entering source coverage', () => {
  const manifest = fixture()
  assert.deepEqual(manifest.divergences.X025.files, ['tsdown.config.ts', 'src/native-module-path.ts'])
  assert.deepEqual(errorsFor(manifest), [])
})
