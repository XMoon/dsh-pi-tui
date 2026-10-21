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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parse as parseYaml } from 'yaml'

import { normalizePackInvocation, packagingInputDigest } from '../../scripts/pack-equivalence-input.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'pack-equivalence-input.mjs')

function cli(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function scratch(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-pack-eq-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
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
  assert.match(check.stdout, /no PASSING equivalence proof/u)
})

test('a proof that says equivalent: false triggers the proof', (t) => {
  const file = join(scratch(t), 'baseline.json')
  cli(['--write', file])
  const recorded = JSON.parse(readFileSync(file, 'utf8'))
  recorded.proof = { equivalent: false, mode: 'npm', node: '24' }
  writeFileSync(file, `${JSON.stringify(recorded, null, 2)}\n`)
  const check = cli(['--check', file])
  assert.equal(check.status, 1)
  assert.match(check.stdout, /no PASSING equivalence proof/u)
})

test('a recorded proof covers the inputs it was taken at, in ITS scope', (t) => {
  const file = join(scratch(t), 'baseline.json')
  cli(['--write', file])
  const recorded = JSON.parse(readFileSync(file, 'utf8'))
  recorded.proof = { equivalent: true, mode: 'npm', node: process.versions.node.split('.')[0], platform: process.platform }
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
  recorded.proof = { equivalent: true, mode: 'npm', node: process.versions.node.split('.')[0], platform: process.platform }
  writeFileSync(file, `${JSON.stringify(recorded, null, 2)}\n`)
  const check = cli(['--check', file, '--mode', 'source'])
  assert.equal(check.status, 1)
  assert.match(check.stdout, /mode 'npm', not 'source'/u)
})

test('a proof from ANOTHER Node major does not cover this run', (t) => {
  const file = join(scratch(t), 'baseline.json')
  cli(['--write', file])
  const recorded = JSON.parse(readFileSync(file, 'utf8'))
  recorded.proof = { equivalent: true, mode: 'npm', node: '24', platform: process.platform }
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
  recorded.proof = { equivalent: true, mode: 'npm', node: process.versions.node.split('.')[0], platform: process.platform }
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
  const workflow = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'pr-pipeline-prototype.yml'), 'utf8'))
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
  const workflow = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'pr-pipeline-prototype.yml'), 'utf8'))
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
  recorded.proof = { equivalent: true, mode: 'npm', node: '24', platform: 'linux' }
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
  const workflow = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'pr-pipeline-prototype.yml'), 'utf8'))
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
  const workflow = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'pr-pipeline-prototype.yml'), 'utf8'))
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
