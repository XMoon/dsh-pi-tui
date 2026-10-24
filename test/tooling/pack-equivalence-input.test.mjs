/**
 * WHEN the pack-equivalence proof must run again.
 *
 * The equality between an ordinary `pnpm pack` and a lifecycle-free one is a
 * GATED PROPERTY: it holds for the packaging inputs it was measured on, and a
 * change to those inputs reopens the question. This file covers the trigger's
 * arithmetic — the part that decides whether the expensive proof runs.
 *
 * The dangerous direction is the quiet one: reporting "unchanged" for inputs
 * nobody proved. A missing record must therefore be a TRIGGER, not a pass.
 *
 * @module @xmoon76/dsh-pi-tui/test/tooling/pack-equivalence-input.test
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parse as parseYaml } from 'yaml'

import {
  normalizePackInvocation,
  packagingEvidenceSensitivePaths,
  packagingInputDigest,
  readSourceIdentity,
} from '../../scripts/pack-equivalence-input.mjs'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'pack-equivalence-input.mjs')

function cli(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function scratch(t) {
  return testLifecycle(t).tempDir('dsh-pack-eq-')
}


/** A proof that carries the provenance a real CI run stamps, so the validity
 *  checks below are about INPUTS/SCOPE rather than failing on provenance. */
function trustedProof(overrides = {}) {
  return {
    equivalent: true,
    mode: 'npm',
    node: '24',
    platform: 'linux',
    entryCount: 40,
    differingFiles: [],
    manifestDifferences: [],
    run: 'https://github.com/XMoon/dsh-pi-tui/actions/runs/40048155158',
    commit: 'db889aa9bc2a71e7b46da649365cec40cd505d03',
    ...overrides,
  }
}

test('the digest names the inputs the equality depends on', () => {
  const identity = packagingInputDigest()
  const paths = identity.inputs.map(input => input.path)
  assert.ok(paths.includes('package.json'), 'the manifest decides what is packed')
  assert.ok(paths.includes('tsdown.config.ts'), 'the bundle build decides the payload')
  assert.ok(paths.includes('scripts/generate-dsh-presets.mjs'), 'the generated presets are payload')
  for (const input of identity.inputs) {
    if (input.present) assert.match(input.sha256, /^[0-9a-f]{64}$/u)
    else assert.equal(input.sha256, null)
  }
})

test('the digest is stable across two reads', () => {
  assert.equal(packagingInputDigest().digest, packagingInputDigest().digest)
})

test('a DIGEST alone is not a proof', (t) => {
  // The defect this replaces: the check compared only `digest`, so a record
  // with no proof at all — or a proof that said `equivalent: false` — was
  // reported as "unchanged" and the pipeline skipped the comparison while
  // still publishing. Bytes say WHICH inputs; they say nothing about whether
  // the comparison ever ran or passed.
  const file = join(scratch(t), 'baseline.json')
  assert.equal(cli(['--write', file]).status, 0)
  const check = cli(['--check', file])
  assert.equal(check.status, 1, 'a record without a passing proof must trigger the proof')
  assert.match(check.stdout, /no recorded equivalence proof exists for mode 'npm'/u)
})

test('a proof that says equivalent: false triggers the proof', (t) => {
  const file = join(scratch(t), 'baseline.json')
  cli(['--write', file])
  const recorded = JSON.parse(readFileSync(file, 'utf8'))
  recorded.proofs = { npm: trustedProof({ equivalent: false }) }
  writeFileSync(file, `${JSON.stringify(recorded, null, 2)}\n`)
  const check = cli(['--check', file])
  assert.equal(check.status, 1)
  assert.match(check.stdout, /no PASSING equivalence proof for mode 'npm'/u)
})

test('a recorded proof covers the inputs it was taken at, in ITS scope', (t) => {
  const file = join(scratch(t), 'baseline.json')
  cli(['--write', file])
  const recorded = JSON.parse(readFileSync(file, 'utf8'))
  recorded.proofs = { npm: trustedProof({ node: process.versions.node.split('.')[0], platform: process.platform }) }
  writeFileSync(file, `${JSON.stringify(recorded, null, 2)}\n`)
  const check = cli(['--check', file])
  assert.equal(check.status, 0, check.stdout + check.stderr)
  assert.match(check.stdout, /unchanged/u)
})

test('a proof from ANOTHER mode does not cover this run', (t) => {
  // An npm proof says nothing about a source run: the dependency graph and
  // the packed payload are different.
  const file = join(scratch(t), 'baseline.json')
  cli(['--write', file])
  const recorded = JSON.parse(readFileSync(file, 'utf8'))
  recorded.proofs = { npm: trustedProof({ node: process.versions.node.split('.')[0], platform: process.platform }) }
  writeFileSync(file, `${JSON.stringify(recorded, null, 2)}\n`)
  const check = cli(['--check', file, '--mode', 'source'])
  assert.equal(check.status, 1)
  assert.match(check.stdout, /no recorded equivalence proof exists for mode 'source'/u,
    'an npm proof must never be replayed as a source proof')
})

test('a proof from ANOTHER Node major does not cover this run', (t) => {
  const file = join(scratch(t), 'baseline.json')
  cli(['--write', file])
  const recorded = JSON.parse(readFileSync(file, 'utf8'))
  recorded.proofs = { npm: trustedProof({ platform: process.platform }) }
  writeFileSync(file, `${JSON.stringify(recorded, null, 2)}\n`)
  const check = cli(['--check', file, '--node', '26'])
  assert.equal(check.status, 1)
  assert.match(check.stdout, /Node 24, not 26/u)
})

test('the comparator and the protocol are part of the digested inputs', () => {
  // "equivalent" is whatever the comparator measures, and the comparison is
  // between two specific commands. A change to either makes the recorded
  // proof describe a comparison the pipeline no longer performs.
  const paths = packagingInputDigest().inputs.map(input => input.path)
  assert.ok(paths.includes('scripts/compare-tarballs.mjs'), 'the comparator defines "equivalent"')
  assert.ok(paths.includes('scripts/pack-equivalence-protocol.json'), 'the protocol is the pair of commands compared')
  assert.ok(paths.includes('pnpm-lock.yaml'), 'the lockfile pins the build toolchain that produces the payload')
})

test('a MISSING record TRIGGERS the proof instead of counting as unchanged', (t) => {
  // The quiet failure this prevents: an equality nobody ever measured being
  // treated as still valid because no record contradicts it.
  const check = cli(['--check', join(scratch(t), 'absent.json')])
  assert.equal(check.status, 1)
  assert.match(check.stdout, /no recorded equivalence proof exists/u)
})

test('a record for OTHER inputs TRIGGERS the proof and names what differs', (t) => {
  const file = join(scratch(t), 'baseline.json')
  const recorded = JSON.parse(readFileSync((cli(['--write', file]), file), 'utf8'))
  // A valid proof, so the check proceeds to the digest comparison this case
  // is about.
  recorded.proofs = { npm: trustedProof({ node: process.versions.node.split('.')[0], platform: process.platform }) }
  // Pretend the manifest changed since the proof was taken.
  recorded.digest = '0'.repeat(64)
  recorded.inputs = recorded.inputs.map(input =>
    input.path === 'package.json' ? { ...input, sha256: '1'.repeat(64) } : input)
  writeFileSync(file, `${JSON.stringify(recorded, null, 2)}\n`)
  const check = cli(['--check', file])
  assert.equal(check.status, 1)
  assert.match(check.stdout, /differ/u)
  assert.match(check.stdout, /package\.json/u, 'the trigger must name the input that changed')
})

// ---------------------------------------------------------------------------
// RFL-007: the protocol must be BOUND to what the workflow runs.
//
// `scripts/pack-equivalence-protocol.json` is a static string. If the workflow
// changes its pack command and the JSON is not updated, the digest does not
// change, `--check` keeps saying "unchanged", the real comparison is skipped —
// and the recorded proof now describes a comparison the pipeline no longer
// performs.
//
// So the workflow's own commands are read and compared with the protocol.
// ---------------------------------------------------------------------------

test('the workflow runs EXACTLY the two commands the protocol declares', () => {
  const workflow = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'))
  const protocol = JSON.parse(readFileSync(join(ROOT, 'scripts', 'pack-equivalence-protocol.json'), 'utf8'))

  // Every `pnpm pack` invocation in the equivalence job, as the shell will run
  // it.
  const commands = []
  for (const step of workflow.jobs.equivalence.steps) {
    if (typeof step.run !== 'string') continue
    for (const line of step.run.split('\n')) {
      if (/^\s*pnpm pack\b/u.test(line)) commands.push(line.trim())
    }
  }
  assert.equal(commands.length, 2, `the equivalence job must run exactly two packs, found: ${commands.join(' | ')}`)

  const actual = commands.map(normalizePackInvocation).map(tokens => tokens.join(' ')).sort()
  const declared = [protocol.ordinaryPack, protocol.ciOnlyPack]
    .map(normalizePackInvocation)
    .map(tokens => tokens.join(' '))
    .sort()
  assert.deepEqual(actual, declared,
    'a workflow pack command that differs from the protocol must be a protocol change, not an invisible drift')
})

test('the protocol declares the comparator, and the workflow uses that file', () => {
  const workflow = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'))
  const protocol = JSON.parse(readFileSync(join(ROOT, 'scripts', 'pack-equivalence-protocol.json'), 'utf8'))
  assert.equal(typeof protocol.comparator, 'string')
  const compareStep = workflow.jobs.equivalence.steps.find(step => typeof step.run === 'string' && step.run.includes('compare-tarballs'))
  assert.ok(compareStep, 'the equivalence job must compare with the declared comparator')
  assert.ok(compareStep.run.includes(protocol.comparator),
    `the job must invoke ${protocol.comparator}`)
})

test('a proof from ANOTHER platform does not cover this run', (t) => {
  // `pnpm pack` and the tar layout are platform-dependent.
  const file = join(scratch(t), 'baseline.json')
  cli(['--write', file])
  const recorded = JSON.parse(readFileSync(file, 'utf8'))
  recorded.proofs = { npm: trustedProof() }
  writeFileSync(file, `${JSON.stringify(recorded, null, 2)}\n`)
  const check = cli(['--check', file, '--platform', 'win32'])
  assert.equal(check.status, 1)
  assert.match(check.stdout, /platform 'linux', not 'win32'/u)
})

test('a workflow command that drifts from the protocol is caught', () => {
  // The discrimination check for the binding above: if the workflow dropped
  // `--config.ignore-scripts=true`, the CI-only pack would run the FULL
  // lifecycle — a different comparison — while the protocol file and the
  // digest stayed the same.
  const protocol = JSON.parse(readFileSync(join(ROOT, 'scripts', 'pack-equivalence-protocol.json'), 'utf8'))
  const mutated = 'pnpm pack --pack-destination "$GITHUB_WORKSPACE"'
  const declared = normalizePackInvocation(protocol.ciOnlyPack).join(' ')
  assert.notEqual(
    normalizePackInvocation(mutated).join(' '),
    declared,
    'the ordinary and the lifecycle-free command must not compare equal',
  )
})

test('the comparator is given the ordinary pack and the lifecycle-free pack, not itself', () => {
  // The residual gap in the same root: the guard checked that the compare step
  // MENTIONS the comparator, not which two tarballs it compares. Rewriting
  // `--b "$ci_only"` to `--b "$ordinary"` turns the proof into a pack compared
  // with itself — it passes, every digest is unchanged, and the equality is
  // never actually tested.
  const workflow = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'))
  const protocol = JSON.parse(readFileSync(join(ROOT, 'scripts', 'pack-equivalence-protocol.json'), 'utf8'))
  const compare = workflow.jobs.equivalence.steps.find(step => typeof step.run === 'string' && step.run.includes('compare-tarballs'))
  assert.ok(compare, 'the equivalence job must run the comparator')

  const { a, b } = protocol.operands
  assert.notEqual(a, b, 'the two operands must be different packs')
  // Each operand is a shell variable assigned from the protocol's directory...
  assert.match(compare.run, new RegExp(`ordinary="\\$\\(ls ${a}/\\*\\.tgz`, 'u'),
    `--a must come from the ${a} directory`)
  assert.match(compare.run, new RegExp(`ci_only="\\$\\(ls ${b}/\\*\\.tgz`, 'u'),
    `--b must come from the ${b} directory`)
  // ...and the comparator must receive exactly those two.
  assert.match(compare.run, /--a "\$ordinary"/u, 'the first operand must be the ordinary pack')
  assert.match(compare.run, /--b "\$ci_only"/u, 'the second operand must be the lifecycle-free pack')
})

test('each pack is produced into the directory its operand names', () => {
  // If the destinations swapped, both operands would still be "different
  // directories" while naming the wrong package.
  const workflow = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'))
  const protocol = JSON.parse(readFileSync(join(ROOT, 'scripts', 'pack-equivalence-protocol.json'), 'utf8'))
  const ordinary = workflow.jobs.equivalence.steps.find(step => typeof step.run === 'string' && step.run.includes('pnpm pack') && !step.run.includes('ignore-scripts'))
  const ciOnly = workflow.jobs.equivalence.steps.find(step => typeof step.run === 'string' && step.run.includes('ignore-scripts=true'))
  assert.ok(ordinary && ciOnly, 'both packs must have their own step')
  // The workflow moves the tarball to `"$GITHUB_WORKSPACE/<dir>/"`, so the
  // directory is matched as a path segment rather than as a whole quoted word.
  assert.ok(ordinary.run.includes(`/${protocol.operands.a}/`),
    `the ordinary pack must land in ${protocol.operands.a}/`)
  assert.ok(ciOnly.run.includes(`/${protocol.operands.b}/`),
    `the lifecycle-free pack must land in ${protocol.operands.b}/`)
  // And NOT in the other one's directory: a swapped destination would make the
  // operands name the wrong package while still being two distinct paths.
  assert.equal(ordinary.run.includes(`/${protocol.operands.b}/`), false,
    'the ordinary pack must not land in the lifecycle-free directory')
  assert.equal(ciOnly.run.includes(`/${protocol.operands.a}/`), false,
    'the lifecycle-free pack must not land in the ordinary directory')
})

// ---------------------------------------------------------------------------
// The "same PR owes the proof" rules. These cover the decision the workflow
// takes, not a preset boolean: each case states the PR's file delta and asserts
// what the decision must be for it.
// ---------------------------------------------------------------------------

test('every digested packaging input, and the whole proof machinery, is evidence-sensitive', () => {
  const watched = packagingEvidenceSensitivePaths([
    'package.json',
    'pnpm-lock.yaml',
    'tsdown.config.ts',
    'scripts/generate-dsh-presets.mjs',
    'pnpm-workspace.yaml',
    'scripts/compare-tarballs.mjs',
    'scripts/pack-equivalence-protocol.json',
    'scripts/pack-equivalence-input.mjs',
    'scripts/pack-equivalence-baseline.json',
    '.github/workflows/ci.yml',
  ])
  assert.deepEqual(watched, [
    '.github/workflows/ci.yml',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'scripts/compare-tarballs.mjs',
    'scripts/generate-dsh-presets.mjs',
    'scripts/pack-equivalence-baseline.json',
    'scripts/pack-equivalence-input.mjs',
    'scripts/pack-equivalence-protocol.json',
    'tsdown.config.ts',
  ])
})

test('a PR that touches no packaging input owes no comparison', () => {
  assert.deepEqual(
    packagingEvidenceSensitivePaths(['src/tui-app.ts', 'test/app/foo.test.ts', 'docs/README.md']),
    [],
  )
})

test('editing the baseline, the checker or the workflow itself demands a real re-proof', () => {
  // The three ways to fake a pass without proving anything.
  for (const path of [
    'scripts/pack-equivalence-baseline.json',
    'scripts/pack-equivalence-input.mjs',
    '.github/workflows/ci.yml',
  ]) {
    assert.deepEqual(packagingEvidenceSensitivePaths([path]), [path],
      `${path} must force the comparison rather than ride an old proof`)
  }
})

test('a baseline candidate is authored ONLY from a comparison that proved equivalence', (t) => {
  const dir = scratch(t)
  const comparison = join(dir, 'comparison.json')
  const out = join(dir, 'baseline.json')
  writeFileSync(comparison, `${JSON.stringify({
    entryCountA: 40, entryCountB: 40, entriesEqual: true,
    onlyInA: [], onlyInB: [], differingFiles: [], manifestDifferences: [], equivalent: true,
  })}\n`)
  const written = cli([
    '--baseline', join(dir, 'absent.json'), '--comparison', comparison, '--out', out,
    '--run', 'https://example.test/run/1', '--commit', 'deadbeef',
    '--mode', 'npm', '--node', '24', '--platform', 'Linux',
  ])
  assert.equal(written.status, 0, written.stderr)
  const candidate = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(candidate.proofs.npm.equivalent, true)
  assert.equal(candidate.proofs.npm.entryCount, 40)
  assert.equal(candidate.proofs.npm.run, 'https://example.test/run/1')
  assert.equal(candidate.proofs.npm.commit, 'deadbeef')
  assert.equal(candidate.digest, packagingInputDigest().digest,
    'the authored baseline must describe the inputs the comparison actually ran on')

  // Provenance SHAPE is enforced: a made-up run URL or a short SHA records a
  // digest but not trustworthy evidence, so it must not satisfy the checker.
  const weak = cli(['--check', out, '--mode', 'npm', '--node', '24', '--platform', 'Linux'])
  assert.equal(weak.status, 1, 'a fabricated run URL must not count as evidence')
  assert.match(weak.stdout, /not trustworthy evidence/u)

  // The same comparison authored with real provenance DOES satisfy it.
  const good = join(dir, 'good.json')
  const stamped = cli([
    '--baseline', join(dir, 'absent.json'), '--comparison', comparison, '--out', good,
    '--run', 'https://github.com/XMoon/dsh-pi-tui/actions/runs/40048155158',
    '--commit', 'db889aa9bc2a71e7b46da649365cec40cd505d03',
    '--mode', 'npm', '--node', '24', '--platform', 'Linux',
  ])
  assert.equal(stamped.status, 0, stamped.stderr)
  assert.equal(cli(['--check', good, '--mode', 'npm', '--node', '24', '--platform', 'Linux']).status, 0)
})

test('a hand-written equivalent:true is not evidence and must not skip the proof', (t) => {
  // The whole point of separating "digest matches" from "evidence exists": a
  // developer (or an agent) can type a matching digest and this flag, but
  // cannot fabricate the provenance a real comparison stamps.
  const file = join(scratch(t), 'baseline.json')
  cli(['--write', file])
  const recorded = JSON.parse(readFileSync(file, 'utf8'))
  recorded.proofs = { npm: trustedProof() }
  const cases = [
    { label: 'no run URL', override: { run: undefined } },
    { label: 'not this repository', override: { run: 'https://github.com/someone/else/actions/runs/1' } },
    { label: 'not a run URL', override: { run: 'https://example.test/run/1' } },
    { label: 'short commit', override: { commit: 'deadbeef' } },
    { label: 'no entry count', override: { entryCount: undefined } },
    { label: 'claims a differing file', override: { differingFiles: ['CHANGELOG.md'] } },
    { label: 'no manifestDifferences field', override: { manifestDifferences: undefined } },
  ]
  for (const { label, override } of cases) {
    recorded.proofs.npm = trustedProof(override)
    writeFileSync(file, `${JSON.stringify(recorded, null, 2)}\n`)
    const check = cli(['--check', file, '--mode', 'npm', '--node', '24', '--platform', 'Linux'])
    assert.equal(check.status, 1, `${label}: a non-evidence proof must not satisfy the checker`)
    assert.match(check.stdout, /not trustworthy evidence/u, label)
  }
})

test('an unequal comparison authors NO candidate, so it cannot become a PASS', (t) => {
  const dir = scratch(t)
  const comparison = join(dir, 'comparison.json')
  const out = join(dir, 'baseline.json')
  const cases = [
    // The decisive case: EVERY other field looks clean and only `equivalent`
    // is false. Without an explicit check on this flag the case below would
    // author a "PASSING" baseline from a failed comparison.
    { label: 'equivalent:false with no visible difference', report: { entryCountA: 40, entryCountB: 40, onlyInA: [], onlyInB: [], differingFiles: [], manifestDifferences: [], equivalent: false } },
    { label: 'not equivalent', report: { entryCountA: 40, entryCountB: 40, onlyInA: ['x'], onlyInB: [], differingFiles: [], manifestDifferences: [], equivalent: false } },
    { label: 'differing file', report: { entryCountA: 40, entryCountB: 40, onlyInA: [], onlyInB: [], differingFiles: ['CHANGELOG.md'], manifestDifferences: [], equivalent: true } },
    { label: 'entry count', report: { entryCountA: 40, entryCountB: 39, onlyInA: [], onlyInB: [], differingFiles: [], manifestDifferences: [], equivalent: true } },
    { label: 'manifest difference', report: { entryCountA: 40, entryCountB: 40, onlyInA: [], onlyInB: [], differingFiles: [], manifestDifferences: ['files'], equivalent: true } },
  ]
  for (const { label, report } of cases) {
    writeFileSync(comparison, `${JSON.stringify(report)}\n`)
    const run = cli([
      '--baseline', join(dir, 'absent.json'), '--comparison', comparison, '--out', out,
      '--run', 'x', '--commit', 'y',
    ])
    assert.notEqual(run.status, 0, `${label}: an unequal comparison must not author a baseline`)
    assert.equal(existsSync(out), false, `${label}: no candidate file may be written`)
  }
})

test('the workflow uploads the proof BEFORE it can fail on a stale baseline', () => {
  // The whole point of the gate is that the developer gets the evidence needed
  // to fix the baseline. If the gate ran before the upload, a stale baseline
  // would fail the job and destroy the very artifact that fixes it.
  const workflow = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'))
  const steps = workflow.jobs.equivalence.steps
  const uploads = steps
    .map((step, index) => ({ index, name: String(step.uses === 'actions/upload-artifact@v7' ? step.with?.name ?? '' : '') }))
    .filter(entry => entry.name !== '')
  const upload = uploads.find(entry => entry.name === 'dsh-pi-tui-pack-equivalence')?.index ?? -1
  const candidate = uploads.find(entry => entry.name.includes('dsh-pi-tui-pack-equivalence-candidate'))?.index ?? -1
  const gate = steps.findIndex(step => String(step.name ?? '').includes('Does the committed baseline describe THIS tree'))
  assert.ok(upload >= 0, 'the proof must still be uploaded')
  assert.ok(candidate >= 0, 'the baseline candidate must be uploaded')
  assert.ok(gate >= 0, 'the baseline sync gate must exist')
  assert.ok(upload < gate, 'the proof artifact must be uploaded before the gate can fail')
  assert.ok(candidate < gate, 'the baseline candidate must be uploaded before the gate can fail')
})

test('the workflow decides sensitivity from the PR BASE, not from the working tree', () => {
  // A stale file in `main` is not this PR's debt; a file this PR changed is its
  // debt even when the resulting hash matches the baseline.
  const workflow = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'))
  const decide = workflow.jobs.equivalence.steps.find(step => step.id === 'trigger')
  assert.ok(decide, 'the trigger step must exist')
  assert.match(decide.run, /--sensitive --base/u, 'the decision must diff against a base ref')
  assert.match(decide.run, /github\.base_ref/u, 'a pull_request must compare against its base branch')
  assert.match(decide.run, /sensitive=true/u)
  assert.match(decide.run, /needed=true/u)
  // Source Mode participates in the SAME gate, bound to the verified
  // distribution; its proof is never the npm one.
  assert.match(decide.run, /"\$mode" = "source"/u)
  assert.match(decide.run, /--source-distribution/u)
})

// ---------------------------------------------------------------------------
// Source Mode. The MECHANISM is implemented and unit-tested here; the real
// Source Mode Pack Equivalence comparison is NOT_RUN (there is no Source Mode
// CI this run). No source proof may be fabricated to make this look verified.
// ---------------------------------------------------------------------------

function writeSourceDistribution(dir, overrides = {}) {
  const manifest = {
    schemaVersion: 1,
    mode: 'source-pack',
    repository: 'deepseek-ai/deepseek-harness',
    sourceRef: 'a'.repeat(40),
    sourceSha: 'a'.repeat(40),
    version: '0.2.1-rc.3',
    dirty: false,
    reproducible: true,
    packages: {},
    ...overrides,
  }
  writeFileSync(join(dir, 'dsh-source-distribution.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

function sourceBaseline(t, sourceDir, proofOverrides = {}) {
  const file = join(scratch(t), 'baseline.json')
  cli(['--write', file])
  const recorded = JSON.parse(readFileSync(file, 'utf8'))
  recorded.proofs = {
    source: trustedProof({
      mode: 'source',
      sourceSha: readSourceIdentity(sourceDir).sourceSha,
      sourceVersion: readSourceIdentity(sourceDir).version,
      ...proofOverrides,
    }),
  }
  writeFileSync(file, `${JSON.stringify(recorded, null, 2)}\n`)
  return file
}

test('a source distribution must be verified and reproducible before it can be proved', (t) => {
  const dir = scratch(t)
  assert.throws(() => readSourceIdentity(dir), /is missing/u,
    'a source proof cannot be computed without the distribution artifact')
  writeSourceDistribution(dir, { dirty: true, reproducible: false })
  assert.throws(() => readSourceIdentity(dir), /clean and reproducible/u,
    'a dirty or irreproducible distribution must not author a reusable proof')
  writeSourceDistribution(dir, { schemaVersion: 2 })
  assert.throws(() => readSourceIdentity(dir), /schemaVersion/u)
  writeSourceDistribution(dir, { sourceRef: 'b'.repeat(40) })
  assert.throws(() => readSourceIdentity(dir), /sourceRef must equal sourceSha/u)
})

test('a source proof only covers the DSH identity it was taken at', (t) => {
  const sourceDir = scratch(t)
  writeSourceDistribution(sourceDir)
  const file = join(scratch(t), 'baseline.json')

  // A matching identity passes, so the binding is not vacuously false.
  cli(['--write', file])
  const recorded = JSON.parse(readFileSync(file, 'utf8'))
  recorded.proofs = {
    source: trustedProof({ mode: 'source', sourceSha: 'a'.repeat(40), sourceVersion: '0.2.1-rc.3' }),
  }
  writeFileSync(file, `${JSON.stringify(recorded, null, 2)}\n`)
  const matching = cli(['--check', file, '--mode', 'source', '--node', '24', '--platform', 'linux',
    '--source-distribution', sourceDir])
  assert.equal(matching.status, 0, matching.stdout + matching.stderr)
  assert.match(matching.stdout, /unchanged/u)

  // A moved DSH commit must reopen the question.
  writeSourceDistribution(sourceDir, { sourceRef: 'b'.repeat(40), sourceSha: 'b'.repeat(40) })
  const movedSha = cli(['--check', file, '--mode', 'source', '--node', '24', '--platform', 'linux',
    '--source-distribution', sourceDir])
  assert.equal(movedSha.status, 1)
  assert.match(movedSha.stdout, new RegExp(`DSH source ${'a'.repeat(40)}, not ${'b'.repeat(40)}`, 'u'))

  // A moved DSH version must reopen it too, even at the same commit.
  writeSourceDistribution(sourceDir, { version: '0.2.2-rc.1' })
  const movedVersion = cli(['--check', file, '--mode', 'source', '--node', '24', '--platform', 'linux',
    '--source-distribution', sourceDir])
  assert.equal(movedVersion.status, 1)
  assert.match(movedVersion.stdout, /DSH version 0\.2\.1-rc\.3, not 0\.2\.2-rc\.1/u)
})

test('an npm proof never satisfies Source Mode and a source proof never satisfies npm', (t) => {
  const sourceDir = scratch(t)
  writeSourceDistribution(sourceDir)
  const file = join(scratch(t), 'baseline.json')
  cli(['--write', file])
  const recorded = JSON.parse(readFileSync(file, 'utf8'))
  recorded.proofs = { npm: trustedProof() }
  writeFileSync(file, `${JSON.stringify(recorded, null, 2)}\n`)

  const asSource = cli(['--check', file, '--mode', 'source', '--node', '24', '--platform', 'linux',
    '--source-distribution', sourceDir])
  assert.equal(asSource.status, 1)
  assert.match(asSource.stdout, /no recorded equivalence proof exists for mode 'source'/u)

  recorded.proofs = { source: trustedProof({ mode: 'source', sourceSha: 'a'.repeat(40), sourceVersion: '0.2.1-rc.3' }) }
  writeFileSync(file, `${JSON.stringify(recorded, null, 2)}\n`)
  const asNpm = cli(['--check', file, '--mode', 'npm', '--node', '24', '--platform', 'linux'])
  assert.equal(asNpm.status, 1)
  assert.match(asNpm.stdout, /no recorded equivalence proof exists for mode 'npm'/u)
})

test('a source proof cannot be authored without a real comparison and a verified distribution', (t) => {
  const dir = scratch(t)
  const comparison = join(dir, 'comparison.json')
  const out = join(dir, 'baseline.json')
  writeFileSync(comparison, `${JSON.stringify({
    entryCountA: 40, entryCountB: 40, onlyInA: [], onlyInB: [],
    differingFiles: [], manifestDifferences: [], equivalent: true,
  })}\n`)
  const sourceDir = scratch(t)
  writeSourceDistribution(sourceDir)

  // No --source-distribution: the identity cannot be bound, so no proof exists.
  const unbound = cli([
    '--baseline', join(dir, 'absent.json'), '--comparison', comparison, '--out', out,
    '--mode', 'source', '--node', '24', '--platform', 'linux',
    '--run', 'x', '--commit', 'y',
  ])
  assert.notEqual(unbound.status, 0, 'a source proof without a verified distribution must fail')

  const bound = cli([
    '--baseline', join(dir, 'absent.json'), '--comparison', comparison, '--out', out,
    '--mode', 'source', '--node', '24', '--platform', 'linux',
    '--source-distribution', sourceDir, '--run', 'x', '--commit', 'y',
  ])
  assert.equal(bound.status, 0, bound.stderr)
  const candidate = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(candidate.proofs.source.sourceSha, 'a'.repeat(40))
  assert.equal(candidate.proofs.source.sourceVersion, '0.2.1-rc.3')
  assert.equal(candidate.proofs.npm, undefined,
    'authoring a source proof must not invent an npm proof')
})

test('authoring one mode preserves the other mode record only while it still applies', (t) => {
  const dir = scratch(t)
  const comparison = join(dir, 'comparison.json')
  const sourceDir = scratch(t)
  writeSourceDistribution(sourceDir)
  writeFileSync(comparison, `${JSON.stringify({
    entryCountA: 40, entryCountB: 40, onlyInA: [], onlyInB: [],
    differingFiles: [], manifestDifferences: [], equivalent: true,
  })}\n`)

  const recordedFile = join(dir, 'recorded.json')
  cli(['--write', recordedFile])
  const recorded = JSON.parse(readFileSync(recordedFile, 'utf8'))
  recorded.proofs = { source: trustedProof({ mode: 'source', sourceSha: 'a'.repeat(40), sourceVersion: '0.2.1-rc.3' }) }
  writeFileSync(recordedFile, `${JSON.stringify(recorded, null, 2)}\n`)

  const out = join(dir, 'out.json')
  const authored = cli([
    '--baseline', recordedFile, '--comparison', comparison, '--out', out,
    '--mode', 'npm', '--node', '24', '--platform', 'linux', '--run', 'x', '--commit', 'y',
  ])
  assert.equal(authored.status, 0, authored.stderr)
  const candidate = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(candidate.proofs.npm.equivalent, true)
  assert.equal(candidate.proofs.source.sourceSha, 'a'.repeat(40),
    'an npm run must not destroy a still-applicable source record')
  // ...and the source record still verifies against the same identity.
  const check = cli(['--check', out, '--mode', 'source', '--node', '24', '--platform', 'linux',
    '--source-distribution', sourceDir])
  assert.equal(check.status, 0, check.stdout)
})

test('a base-diff failure makes the run owe a comparison instead of skipping it', () => {
  // Observed in real CI run 40051144234: `actions/checkout` was shallow, so
  // `origin/main...HEAD` had no merge base, the diff failed, and the shell read
  // that failure as "not sensitive" and skipped the comparison a sensitive PR
  // owed. A failure to LOOK is not evidence that nothing changed.
  const workflow = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'))
  const steps = workflow.jobs.equivalence.steps

  const checkout = steps.find(step => step.uses === 'actions/checkout@v7')
  assert.ok(checkout, 'the job must check out the repository')
  assert.equal(checkout.with['fetch-depth'], 0,
    'a BASE...HEAD diff needs a merge base, so the clone cannot be shallow')

  const decide = steps.find(step => step.id === 'trigger').run
  // The safe value must be the DEFAULT, not something a later branch can forget.
  const failClosed = /sensitive=true\n\s+if \[ -z "\$base" \]|sensitive=true\s*\n\s*if \[/.test(decide)
  assert.ok(failClosed, 'the decision must default to sensitive and only narrow it on proof')
  // The narrowing must require the EXPLICIT "changes no packaging input" text,
  // so an error message can never be mistaken for the negative answer.
  assert.match(decide, /grep -q 'changes no packaging evidence input'/u)
  // A failed diff must not fall through to `sensitive=false`.
  assert.match(decide, /the base diff failed, assuming this run owes a real comparison/u)
})

test('the sensitive probe reports its negative answer explicitly', () => {
  // The workflow narrows to `sensitive=false` only on this exact sentence, so it
  // must exist and must not be a substring of the positive one.
  const negative = 'sensitive: this branch changes no packaging evidence input'
  const positive = 'sensitive: this branch changes packaging evidence inputs ('
  assert.equal(positive.includes(negative), false)
  assert.match(negative, /changes no packaging evidence input/u)
})

// ---------------------------------------------------------------------------
// The THREE-outcome decision. The earlier version collapsed "the PR touches
// nothing" with "the baseline is stale" into one expensive answer, so an
// unrelated PR paid for a comparison it did not owe.
// ---------------------------------------------------------------------------

function decisionScript() {
  const workflow = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'))
  return workflow.jobs.equivalence.steps.find(step => step.id === 'trigger').run
}

test('the decision trusts recorded evidence first, not the sensitive flag', () => {
  const script = decisionScript()
  // Trusted evidence wins even when the PR touched a packaging input: the
  // owner should not pay for the same comparison twice.
  assert.match(script, /if \[ "\$records" = "true" \]; then\n\s+needed=false\n\s+sync=ok/u)
  // No evidence + sensitive -> the real comparison, then the sync gate.
  assert.match(script, /elif \[ "\$sensitive" = "true" \]; then\n\s+needed=true\n\s+sync=required/u)
  // No evidence + untouched -> fast FAIL, never another pack.
  assert.match(script, /else\n\s+needed=false\n\s+sync=stale/u)
  // The bug this replaced: `sensitive` alone bought a comparison even when the
  // record was already trustworthy.
  assert.doesNotMatch(script, /\[ "\$sensitive" = "true" \] \|\| \[ "\$records" = "false" \]/u)
})

test('the stale-baseline fast failure does not build either package', () => {
  const workflow = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'))
  const steps = workflow.jobs.equivalence.steps
  const gate = steps.find(step => String(step.name ?? '').includes('Does the committed baseline describe THIS tree'))
  assert.ok(gate, 'the sync gate must exist')
  assert.match(gate.if, /sync == 'stale'/u, 'the gate must fire for a stale inherited baseline')
  for (const name of ['Build the ordinary package', 'Build the CI-only package']) {
    const step = steps.find(candidate => candidate.name === name)
    assert.ok(step, `${name} must exist`)
    assert.match(step.if, /steps\.trigger\.outputs\.needed == 'true'/u,
      `${name} must be gated on the decision, so sync=stale skips it`)
  }
})

test('the two failure modes give different, actionable diagnostics', () => {
  const workflow = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'))
  const gate = workflow.jobs.equivalence.steps.find(step => String(step.name ?? '').includes('Does the committed baseline describe THIS tree'))
  // The proof owner is told to take ITS OWN artifact...
  assert.match(gate.run, /pack-equivalence-candidate-\$\{MODE\}/u,
    'the diagnostic must name the mode-suffixed artifact that actually exists')
  // ...while an unrelated PR is explicitly told it is not the owner.
  assert.match(gate.run, /This PR does not owe a comparison, and it will NOT run one/u)
  assert.match(gate.run, /does not owe a comparison/u)
  // The source-mode re-check must carry its identity argument or it reports a
  // misleading "source directory missing".
  assert.match(gate.run, /--source-distribution "\$RUNNER_TEMP\/dsh-source-pack"/u)
})

test('a push event resolves its own base instead of assuming an expensive run', () => {
  const script = decisionScript()
  // A push must try its own `before` commit, fetching only when absent.
  assert.match(script, /push\)/u)
  assert.match(script, /printf '%s' "\$before" \| grep -qE '\^0\+\$'/u,
    'an all-zero `before` (new branch) must not be treated as a real base')
  assert.match(script, /git cat-file -e "\$\{before\}\^\{commit\}"/u)
  assert.match(script, /git fetch --no-tags origin "\$before"/u)
  // Missing base is still fail-closed.
  assert.match(script, /base commit unknown, assuming this run owes a real comparison/u)
})
