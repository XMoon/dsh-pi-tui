/**
 * The pipeline GUARDS: the mode boundary and the phase verdict.
 *
 * Both were shell inside the workflow, and both were wrong in a way shell
 * hides. These cases drive the decisions directly, because a guard that is
 * only exercised by a green CI run has not been shown to reject anything.
 *
 * The four behaviours that must FAIL are the four the shell got wrong:
 *
 *   1. a Source Mode run was allowed to proceed to a qualified candidate
 *      while silently skipping a gate;
 *   2. `skipped` counted as success in the summary;
 *   3. `context` was absent from the phase list, so a run with no resolved
 *      dependency mode summarised as green;
 *   4. an empty start instant became a plausible elapsed time, because the
 *      shell treats an empty operand as zero.
 *
 * @module @xmoon76/dsh-pi-tui/test/tooling/pipeline-guard.test
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { FAULT_TOKENS, REQUIRED_PHASES, checkFault, checkMode, resolveShardTotal, summarize } from '../../scripts/pipeline-guard.mjs'
import { depsPlan } from '../../scripts/prototype-deps.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'pipeline-guard.mjs')

/** Every required phase, at one result. */
function phasesAt(result) {
  return REQUIRED_PHASES.map(name => ({ name, result }))
}

/**
 * A scratch directory that is removed when the case ends.
 *
 * @param {import('node:test').TestContext} t - the case context.
 * @returns {string} the directory.
 */
function scratch(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-guard-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

/** Run the CLI. */
function cli(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

// ---------------------------------------------------------------------------
// F3 — the mode boundary.
// ---------------------------------------------------------------------------

test('npm mode is supported', () => {
  assert.deepEqual(checkMode('npm'), { ok: true })
})

test('SOURCE mode is supported once the distribution wiring exists', () => {
  // The guard refused source mode while the source-leak gate had no
  // distribution and the startup smoke was unconditionally skipped: a
  // source run would have skipped a gate and still produced a qualified
  // candidate. Both are wired now, so the mode is allowed — and the
  // refusal is not "deleted", it moved to the dependency preparation, which
  // FAILS a source job that was not given the distribution.
  const verdict = checkMode('source')
  assert.deepEqual(verdict, { ok: true })
})

test('a SOURCE job without the pinned distribution FAILS', () => {
  // The new place the boundary lives: a source job that would fall back to
  // the registry is testing a different dependency graph.
  assert.throws(
    () => depsPlan({ mode: 'source', workspace: '/w' }),
    /source mode requires --distribution/u,
  )
  const plan = depsPlan({ mode: 'source', distribution: '/pack', workspace: '/w' })
  assert.equal(plan.commands[0].includes('--distribution'), true)
  assert.equal(plan.env.TARBALL_SMOKE_SKIP_INSTALL, '1',
    'the packed package must not install its own DSH peer when the distribution is already in the workspace')
})

test('an UNRESOLVED mode is refused, not defaulted', () => {
  // A missing mode means the dependency graph is unknown. Treating it as
  // npm would qualify a run whose dependencies nobody identified.
  for (const mode of [undefined, '']) {
    const verdict = checkMode(mode)
    assert.equal(verdict.ok, false, `mode ${JSON.stringify(mode)} must be refused`)
    assert.match(verdict.reason, /was not resolved/u)
  }
})

test('an UNKNOWN mode is refused', () => {
  const verdict = checkMode('registry-next')
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /not one this prototype can qualify/u)
})

test('the CLI accepts source mode now that its gates are wired', () => {
  // The entry guard exists to stop a mode the pipeline cannot qualify. It
  // refused source while the source-leak gate had no distribution; that
  // wiring exists, so the entry passes and the boundary moved to the
  // dependency preparation (asserted separately).
  const result = cli(['mode', 'source'])
  assert.equal(result.status, 0, result.stderr)
})

test('the CLI succeeds for npm mode', () => {
  const result = cli(['mode', 'npm'])
  assert.equal(result.status, 0, result.stderr)
})

// ---------------------------------------------------------------------------
// P2-b — the phase verdict.
// ---------------------------------------------------------------------------

test('an all-success run qualifies', () => {
  const verdict = summarize({ started: '1700000000', phases: phasesAt('success') })
  assert.deepEqual(verdict.failures, [])
  assert.equal(verdict.ok, true)
  assert.ok(Number.isInteger(verdict.elapsedSeconds))
})

test('a SKIPPED required phase does NOT qualify', () => {
  // The defect: `success|skipped` were both accepted. A phase that did not
  // run proved nothing, so accepting it lets a green summary describe a
  // pipeline where the tests never happened.
  for (const name of REQUIRED_PHASES) {
    const phases = phasesAt('success').map(phase => (phase.name === name ? { name, result: 'skipped' } : phase))
    const verdict = summarize({ started: '1700000000', phases })
    assert.equal(verdict.ok, false, `a skipped '${name}' must not qualify`)
    assert.match(verdict.failures.join('\n'), new RegExp(`'${name}' is 'skipped', not 'success'`, 'u'))
  }
})

test('a FAILED required phase does not qualify', () => {
  const phases = phasesAt('success').map(phase => (phase.name === 'typecheck' ? { name: phase.name, result: 'failure' } : phase))
  const verdict = summarize({ started: '1700000000', phases })
  assert.equal(verdict.ok, false)
  assert.match(verdict.failures.join('\n'), /'typecheck' is 'failure'/u)
})

test('a MISSING required phase does not qualify', () => {
  // An absent phase is not a pass. This is the shape of the "context was
  // never in the list" defect: the run had no resolved mode and still
  // summarised as green.
  const phases = phasesAt('success').filter(phase => phase.name !== 'context')
  const verdict = summarize({ started: '1700000000', phases })
  assert.equal(verdict.ok, false)
  assert.match(verdict.failures.join('\n'), /'context' was not reported: an absent phase is not a pass/u)
})

test('`context` IS required, so a failed context cannot summarise as green', () => {
  // The concrete path: the context job fails, every dependent phase is
  // skipped, and `always()` still runs the summary. With `skipped` accepted
  // and `context` unlisted, that run reported a green summary.
  const phases = [
    { name: 'context', result: 'failure' },
    ...REQUIRED_PHASES.filter(name => name !== 'context').map(name => ({ name, result: 'skipped' })),
  ]
  const verdict = summarize({ started: '1700000000', phases })
  assert.equal(verdict.ok, false)
  const joined = verdict.failures.join('\n')
  assert.match(joined, /'context' is 'failure'/u)
  assert.match(joined, /'product shards' is 'skipped'/u)
})

test('an EMPTY start instant is a DIAGNOSIS, not a number', () => {
  // The shell treats an empty operand as 0, so `$(( now - STARTED ))`
  // produced a plausible-looking elapsed time for a run that never started.
  // The guard must say so instead.
  for (const started of [undefined, '', '0', 'not-a-number']) {
    const verdict = summarize({ started, phases: phasesAt('success') })
    assert.equal(verdict.ok, false, `started ${JSON.stringify(started)} must be rejected`)
    assert.match(verdict.failures.join('\n'), /the DAG start instant is unknown/u)
    assert.equal(verdict.elapsedSeconds, null, 'an unknown start must not yield an elapsed time')
    assert.doesNotMatch(verdict.lines.join('\n'), /whole pipeline/u)
  }
})

test('the CLI exits non-zero when every phase was skipped', () => {
  const args = ['summary', '--started', '1700000000']
  for (const name of REQUIRED_PHASES) args.push('--phase', `${name}=skipped`)
  const result = cli(args)
  assert.equal(result.status, 1, 'an all-skipped pipeline must not report success')
  assert.match(result.stderr, /did NOT qualify/u)
})

test('the CLI exits non-zero when the start instant is missing', () => {
  const args = ['summary']
  for (const name of REQUIRED_PHASES) args.push('--phase', `${name}=success`)
  const result = cli(args)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /the DAG start instant is unknown/u)
})

test('the CLI exits zero for a fully successful run and prints the summary', () => {
  const args = ['summary', '--started', '1700000000']
  for (const name of REQUIRED_PHASES) args.push('--phase', `${name}=success`)
  const result = cli(args)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /whole pipeline\s+\d+s/u)
  for (const name of REQUIRED_PHASES) {
    assert.match(result.stdout, new RegExp(`${name.padEnd(16)} success`, 'u'), `the summary must show ${name}`)
  }
})

// ---------------------------------------------------------------------------
// The FAULT token.
//
// The injections exist to prove the pipeline REJECTS a qualification instead
// of arguing that it would. That only works if the token is read, valid and
// CLOSED: an unknown token must be a configuration error, because a typo
// that silently disabled the injection would produce a green run that proves
// nothing.
// ---------------------------------------------------------------------------

test('every implemented injection is accepted', () => {
  for (const fault of FAULT_TOKENS) {
    assert.deepEqual(checkFault(`${fault}\n`), { ok: true, fault }, `'${fault}' must be a valid token`)
  }
})

test('an UNKNOWN fault token is a configuration error, not a silent no-op', () => {
  const verdict = checkFault('shard-fial')
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /not one this pipeline implements/u)
  assert.match(verdict.reason, /closed list/u)
})

test('an EMPTY fault token is refused: a run must state whether it is an injection', () => {
  for (const raw of ['', '\n', '   ']) {
    const verdict = checkFault(raw)
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /must state whether it is an injection/u)
  }
})

test('the CLI accepts the committed fault file', () => {
  const file = join(ROOT, 'scripts', 'prototype-fault.txt')
  const result = cli(['fault', file])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /fault token 'none'/u, 'the committed default must be a normal run')
})

test('the six required failure classes each have a token', () => {
  // The Owner's list, one token per class. Keeping it explicit means a class
  // cannot quietly disappear from the list.
  const required = ['shard-fail', 'shard-missing', 'digest-mismatch', 'build-missing', 'smoke-fail', 'downstream-fail']
  for (const fault of required) {
    assert.ok(FAULT_TOKENS.includes(fault), `the class '${fault}' must have a token`)
  }
  assert.equal(required.length, 6)
})

test('the required phases include the two the qualified-artifact split added', () => {
  // The split is the whole point of the sixth failure class: a provisional
  // candidate is consumed downstream, and only a fully gated run produces a
  // QUALIFIED artifact. A summary that did not require those phases would
  // report green while neither happened.
  assert.ok(REQUIRED_PHASES.includes('downstream matrix'))
  assert.ok(REQUIRED_PHASES.includes('qualified artifact'))
})

// ---------------------------------------------------------------------------
// The SHARD TOTAL, and the injection targets that depend on it.
//
// A workflow that is not on the default branch cannot be dispatched, so a
// push run has NO inputs. A shard total that only existed as a dispatch
// input would therefore pin every push to one shape — and the shapes that
// were never exercised are exactly where a fault injection can silently stop
// firing.
// ---------------------------------------------------------------------------

test('the shard total is read from the committed file when nothing is dispatched', (t) => {
  const file = join(scratch(t), 'total.txt')
  writeFileSync(file, '1\n')
  assert.deepEqual(resolveShardTotal({ file, input: '' }), { ok: true, shardTotal: 1 })
})

test('a dispatched shard total OVERRIDES the committed one', (t) => {
  const file = join(scratch(t), 'total.txt')
  writeFileSync(file, '4\n')
  assert.deepEqual(resolveShardTotal({ file, input: '2' }), { ok: true, shardTotal: 2 })
})

test('a MISSING committed total is refused, not defaulted', (t) => {
  const file = join(scratch(t), 'absent.txt')
  const verdict = resolveShardTotal({ file, input: '' })
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /is missing/u)
})

test('an UNSUPPORTED total is refused in either form', (t) => {
  const file = join(scratch(t), 'total.txt')
  writeFileSync(file, '7\n')
  assert.equal(resolveShardTotal({ file, input: '' }).ok, false)
  assert.equal(resolveShardTotal({ file, input: '0' }).ok, false)
  assert.equal(resolveShardTotal({ file, input: 'three' }).ok, false)
})

test('the committed total is one the matrix supports', () => {
  const result = cli(['shard-total'])
  assert.equal(result.status, 0, result.stderr)
  assert.ok(['1', '2', '3', '4'].includes(result.stdout.trim()))
})

test('the injections target shards that exist for EVERY total', () => {
  // The defect this protects: the targets were hardcoded to shards 2, 3 and
  // 4. With a 1-shard run none of those exist, so the injection never fired
  // and the pipeline could SUCCEED while claiming to inject a fault. The
  // selector must target a shard that always exists, or the last shard of
  // the current total.
  const source = readFileSync(join(ROOT, '.github', 'workflows', 'pr-pipeline-prototype.yml'), 'utf8')
  // A hardcoded index above 1 is the bug: shard 1 exists for every total.
  assert.doesNotMatch(source, /fault == 'shard-fail' && matrix\.shard == [2-9]/u,
    'the shard-fail target must exist for every total')
  assert.doesNotMatch(source, /fault == 'digest-mismatch' && matrix\.shard == [2-9]/u,
    'the digest-mismatch target must exist for every total')
  // Dropping a shard must follow the CURRENT total, not a fixed index.
  assert.match(source, /fault == 'shard-missing' && matrix\.shard == fromJSON\(needs\.context\.outputs\.shard_total\)/u,
    'the missing-records target must be the last shard of the current total')
})

test('the qualified artifact is uploaded from its original path', () => {
  // A renamed copy (`qualified.tgz`) does not match the
  // `xmoon76-dsh-pi-tui-*.tgz` glob a downstream consumer looks for, so the
  // qualified artifact would be unusable by the jobs it exists for.
  const source = readFileSync(join(ROOT, '.github', 'workflows', 'pr-pipeline-prototype.yml'), 'utf8')
  assert.doesNotMatch(source, /cp "\$\{TARBALLS\[0\]\}" qualified/u,
    'the qualified artifact must not be a renamed copy')
  assert.match(source, /path: \$\{\{ env\.QUALIFIED_TARBALL \}\}/u,
    'the upload must use the verified tarball\'s own path')
})

// ---------------------------------------------------------------------------
// Stage 3 — the dependency preparation, in one place.
//
// Six jobs install dependencies and they must install the SAME graph for the
// run's mode. Six hand-written copies is how one job keeps installing from
// the registry while the run claims Source Mode.
// ---------------------------------------------------------------------------

test('npm mode installs from the registry and exports the registry variables', () => {
  const plan = depsPlan({ mode: 'npm', workspace: '/w' })
  assert.deepEqual(plan.commands, [['pnpm', 'install', '--frozen-lockfile']])
  assert.equal(plan.env.NPM_CONFIG_REGISTRY, 'https://registry.npmjs.org/')
  assert.equal(plan.env.TARBALL_SMOKE_SKIP_INSTALL, undefined,
    'the npm path must NOT skip the tarball install')
})

test('source mode installs the PINNED distribution, not the registry', () => {
  const plan = depsPlan({ mode: 'source', distribution: '/pack', workspace: '/w' })
  const [command, ...args] = plan.commands[0]
  assert.equal(command, 'node')
  assert.ok(args.some(arg => arg.endsWith('scripts/prepare-dsh-test-environment.mjs')), JSON.stringify(args))
  assert.deepEqual(args.slice(args.indexOf('--mode'), args.indexOf('--mode') + 2), ['--mode', 'source'])
  assert.deepEqual(args.slice(args.indexOf('--distribution'), args.indexOf('--distribution') + 2), ['--distribution', '/pack'])
  assert.ok(args.includes('test/compat/dsh-source.json'), 'the pinned configuration is part of the plan')
})

test('an UNKNOWN mode is refused rather than installed as npm', () => {
  assert.throws(() => depsPlan({ mode: 'registry', workspace: '/w' }), /not one this prototype prepares dependencies for/u)
})

test('every job that installs dependencies uses the shared preparation', () => {
  // The contract against the shipped workflow: no job may keep its own
  // inline `pnpm install`, because that is the copy that drifts.
  const source = readFileSync(join(ROOT, '.github', 'workflows', 'pr-pipeline-prototype.yml'), 'utf8')
  const inline = [...source.matchAll(/pnpm install --frozen-lockfile/gu)].length
  assert.equal(inline, 0, 'no job may install dependencies inline: use scripts/prototype-deps.mjs')
  const shared = [...source.matchAll(/prototype-deps\.mjs/gu)].length
  assert.equal(shared, 6, `the six consumer jobs must all use the shared preparation, found ${shared}`)
})

test('the mode override exists and is one the resolver accepts', () => {
  const raw = readFileSync(join(ROOT, 'scripts', 'prototype-mode.txt'), 'utf8').trim()
  assert.ok(['resolved', 'npm', 'source'].includes(raw), `unexpected mode override: ${raw}`)
})

test('a job that needs the SKIPPED source pack still runs in npm mode', () => {
  // GitHub skips a job whose `needs` job was skipped, unless the job says
  // otherwise. `source-pack` is skipped in npm mode, so every consumer needs
  // an explicit condition — and without it the whole npm path is skipped
  // while `aggregate` and `summary` go red for a reason nobody can see.
  //
  // This was a real failure: adding `source-pack` to `needs` skipped the
  // build, every shard, the candidate and the qualification.
  const source = readFileSync(join(ROOT, '.github', 'workflows', 'pr-pipeline-prototype.yml'), 'utf8')
  const consumers = ['build', 'typecheck', 'product-shard', 'candidate', 'qualify', 'downstream']
  for (const job of consumers) {
    const start = source.indexOf(`\n  ${job}:\n`)
    assert.notEqual(start, -1, `the workflow must define '${job}'`)
    // The job's own header, up to its first step.
    const header = source.slice(start, source.indexOf('    steps:', start))
    assert.match(header, /needs:[\s\S]*source-pack/u, `${job} must wait for the source pack`)
    assert.match(header, /if: \$\{\{ !cancelled\(\) && needs\.source-pack\.result != 'failure' \}\}/u,
      `${job} must run when the source pack was SKIPPED (npm mode) and stop when it FAILED`)
  }
})

test('the source pack is only built in source mode', () => {
  const source = readFileSync(join(ROOT, '.github', 'workflows', 'pr-pipeline-prototype.yml'), 'utf8')
  const start = source.indexOf('\n  source-pack:\n')
  assert.notEqual(start, -1)
  const header = source.slice(start, source.indexOf('    steps:', start))
  assert.match(header, /if: \$\{\{ needs\.context\.outputs\.mode == 'source' \}\}/u,
    'the pinned distribution must not be built for an npm run')
})
