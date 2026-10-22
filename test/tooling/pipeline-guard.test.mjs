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
import { readFileSync, writeFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { join, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { FAULT_TOKENS, REQUIRED_PHASES, checkFault, checkMode, resolveShardTotal, summarize } from '../../scripts/pipeline-guard.mjs'
import { depsPlan } from '../../scripts/prototype-deps.mjs'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { MODE_TOKENS, TEST_ENTRY_REF_PREFIX, readModeToken, resolvePrototypeMode } from '../../scripts/prototype-mode.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'pipeline-guard.mjs')
const MODE_SCRIPT = join(ROOT, 'scripts', 'prototype-mode.mjs')

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
  return testLifecycle(t).tempDir('dsh-guard-')
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

test('SOURCE mode is refused outside the prototype test entry', () => {
  // The wiring exists (pinned pack, one dependency preparation, the leak gate
  // taking the distribution, the equivalence proof running its own packs), but
  // no Source Mode run can be RESOLVED into this workflow: the repository
  // resolver derives `source` only on the `next` line when the tracked policy
  // selects it, and it refuses a forced mode that disagrees.
  //
  // A source run that did not come through the committed test entry therefore
  // has no pinned ref and no pinned version, and a run whose dependency graph
  // cannot be pinned is not qualified.
  const verdict = checkMode('source')
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /committed test entry/u)
  assert.match(verdict.reason, /pinned ref/u)
})

test('SOURCE mode is accepted from the test entry and only from it', () => {
  assert.deepEqual(checkMode('source', 'prototype-override'), { ok: true })
  // The origin is not decoration: `resolver` and `prototype-override` must not
  // collapse into "the mode is source", because only the second one carries a
  // pinned ref and version and only the second one is an experiment.
  assert.equal(checkMode('source', 'resolver').ok, false)
  assert.equal(checkMode('npm', 'prototype-override').ok, true)
})

test('the mode switch is a COMMITTED token the workflow reads by name', () => {
  // A dispatch input cannot carry this decision: a push has no inputs, and a
  // workflow that is not on the default branch cannot be dispatched at all.
  // The switch is therefore a file in the tree, and the workflow must name it
  // — a default buried in the script would let the tree and the run disagree.
  assert.doesNotThrow(() => readModeToken(join(ROOT, 'scripts', 'prototype-source-mode.txt')))
  assert.deepEqual(MODE_TOKENS, ['resolved', 'source'])
  const source = readFileSync(join(ROOT, '.github', 'workflows', 'pr-pipeline-prototype.yml'), 'utf8')
  assert.match(source, /--token scripts\/prototype-source-mode\.txt/u,
    'the workflow must read the committed switch, not default to one')
})

test('the test entry takes the pin from the TRACKED source config', () => {
  // A mode-only override would leave `source_ref` and `source_expected_version`
  // empty, and the source-pack job would then build nothing. The values must
  // come from the same file the production resolver reads.
  const ref = `${TEST_ENTRY_REF_PREFIX}example`
  const resolved = resolvePrototypeMode({ token: 'source', resolvedMode: 'npm', ref })
  const config = JSON.parse(readFileSync(join(ROOT, 'test', 'compat', 'dsh-source.json'), 'utf8'))
  assert.equal(resolved.mode, 'source')
  assert.equal(resolved.modeOrigin, 'prototype-override')
  assert.equal(resolved.sourceRef, config.ref)
  assert.equal(resolved.sourceExpectedVersion, config.expectedVersion)
})

test('the test entry passes the resolver answer through untouched', () => {
  const resolved = resolvePrototypeMode({
    token: 'resolved',
    resolvedMode: 'npm',
    ref: 'refs/heads/main',
  })
  assert.deepEqual(resolved, { mode: 'npm', modeOrigin: 'resolver', sourceRef: '', sourceExpectedVersion: '' })
})

test('the mode entry writes the outputs the workflow consumes', (t) => {
  // This case exists because the exported decision was fully tested while the
  // SCRIPT the workflow runs was not: a reference error in the CLI's banner
  // failed the whole pipeline at the context job, after every unit test above
  // had passed. The output NAMES are the machine contract — a rename here
  // silently empties `mode` downstream.
  const outputFile = join(scratch(t), 'github-output')
  const token = join(scratch(t), 'token.txt')
  writeFileSync(token, 'source\n')
  const result = spawnSync(process.execPath, [
    MODE_SCRIPT,
    '--token', token,
    '--resolved-mode', 'npm',
    '--ref', `${TEST_ENTRY_REF_PREFIX}example`,
  ], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: outputFile } })
  assert.equal(result.status, 0, result.stderr)
  const outputs = readFileSync(outputFile, 'utf8')
  const config = JSON.parse(readFileSync(join(ROOT, 'test', 'compat', 'dsh-source.json'), 'utf8'))
  assert.match(outputs, /^mode=source$/mu)
  assert.match(outputs, /^mode_origin=prototype-override$/mu)
  assert.match(outputs, new RegExp(`^source_ref=${config.ref}$`, 'mu'))
  assert.match(outputs, new RegExp(`^source_expected_version=${config.expectedVersion}$`, 'mu'))
  // And the log says it is an experiment, not a routing result.
  assert.match(result.stdout, /PROTOTYPE SOURCE MODE TEST ENTRY/u)
  assert.match(result.stdout, /NOT evidence about the production mode routing/u)
})

test('the test entry cannot act outside the prototype branches', () => {
  for (const ref of ['refs/heads/main', 'refs/heads/next', 'refs/pull/1/merge', 'refs/tags/v1.0.0']) {
    assert.throws(
      () => resolvePrototypeMode({ token: 'source', resolvedMode: 'npm', ref }),
      /bound to refs\/heads\/ci\/pr-pipeline-prototype-/u,
      `${ref} must not be able to turn itself into a Source Mode run`,
    )
  }
})

test('the test entry never masks a decision the resolver already made', () => {
  // The entry exists because source is unreachable here, not to override a
  // run the production routing already classified as source.
  assert.throws(
    () => resolvePrototypeMode({ token: 'source', resolvedMode: 'source', ref: `${TEST_ENTRY_REF_PREFIX}x` }),
    /already selected source mode/u,
  )
})

test('an UNKNOWN mode token is a configuration error, not "resolved"', (t) => {
  const file = join(scratch(t), 'token.txt')
  writeFileSync(file, 'source-mode\n')
  assert.throws(() => readModeToken(file), /is not one of resolved\/source/u)
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

test('the CLI refuses source mode at the entry', () => {
  const result = cli(['mode', 'source'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /committed test entry/u)
})

test('the CLI accepts source mode from the test entry', () => {
  const result = cli(['mode', 'source', '--origin', 'prototype-override'])
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
  assert.ok(shared >= 6, `the consumer jobs must all use the shared preparation, found ${shared}`)
})

test('the mode entry is the committed test switch, never a forced resolver mode', () => {
  // An override that passes `--force-mode source` fails at the entry: the
  // resolver accepts a forced mode only when it agrees with the derived one.
  // The Owner-approved test entry is therefore a SEPARATE step whose answer is
  // recorded with its own origin, not a flag that would fail every run.
  const source = readFileSync(join(ROOT, '.github', 'workflows', 'pr-pipeline-prototype.yml'), 'utf8')
  assert.doesNotMatch(source, /--force-mode/u, 'the workflow must not try to force a mode')
  // The resolver still runs, first and unmodified — its answer is what a
  // reader compares the override against.
  assert.match(source, /run: node scripts\/dsh-ci-context\.mjs/u,
    'the repository resolver must still resolve the mode')
  // The guard is told WHERE the mode came from; passing the origin is what
  // keeps "the mode is source" from being enough.
  assert.match(source, /pipeline-guard\.mjs mode "\$DSH_MODE" --origin "\$DSH_MODE_ORIGIN"/u,
    'the entry guard must receive the mode origin')
  assert.match(source, /mode_origin: \$\{\{ steps\.mode\.outputs\.mode_origin \}\}/u,
    'the context job must publish the mode origin')
  assert.match(source, /resolved_mode: \$\{\{ steps\.resolved\.outputs\.mode \}\}/u,
    'the context job must publish what production routing decided, separately')
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
  const consumers = ['build', 'typecheck', 'product-shard', 'candidate', 'qualify', 'downstream', 'equivalence']
  for (const job of consumers) {
    const start = source.indexOf(`\n  ${job}:\n`)
    assert.notEqual(start, -1, `the workflow must define '${job}'`)
    // The job's own header, up to its first step.
    const header = source.slice(start, source.indexOf('    steps:', start))
    assert.match(header, /needs:[\s\S]*source-pack/u, `${job} must wait for the source pack`)
    // Two shapes are acceptable, and only two:
    //   - "run unless the pack failed", which tolerates the npm-mode skip;
    //   - "the pack must have SUCCEEDED, when this run is a source run",
    //     which is what the equivalence proof needs: it must not compare two
    //     packs in a source run whose distribution never arrived.
    const tolerant = /needs\['source-pack'\]\.result != 'failure'/u.test(header)
    const strict = /needs\['source-pack'\]\.result == 'success'/u.test(header)
      && /needs\['context'\]\.outputs\.mode != 'source'/u.test(header)
    assert.ok(tolerant || strict,
      `${job} must tolerate a SKIPPED source pack only in npm mode, and stop when it FAILED`)
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

test('every job downstream of the source pack states its own condition', () => {
  // A skipped job skips its dependents THROUGH the dependency graph, not only
  // through direct `needs`. `source-pack` is skipped in npm mode, so every
  // job that can reach it — directly or transitively — must override the
  // default, or the npm path silently publishes nothing while each direct
  // dependency reports success.
  const source = readFileSync(join(ROOT, '.github', 'workflows', 'pr-pipeline-prototype.yml'), 'utf8')
  const workflow = source
  // The jobs that may legitimately run without an override.
  const exempt = new Set(['context', 'source-pack', 'aggregate', 'summary'])
  const jobNames = [...workflow.matchAll(/\n  ([a-z][a-z-]*):\n/g)].map(match => match[1])
  const overridden = []
  for (const name of jobNames) {
    if (exempt.has(name)) continue
    const start = workflow.indexOf(`\n  ${name}:\n`)
    const header = workflow.slice(start, workflow.indexOf('    steps:', start))
    if (!header.includes('source-pack')) continue
    const tolerant = /needs\['source-pack'\]\.result != 'failure'/u.test(header)
    const strict = /needs\['source-pack'\]\.result == 'success'/u.test(header)
      && /needs\['context'\]\.outputs\.mode != 'source'/u.test(header)
    const viaBuild = /needs\['build'\]\.result == 'success'/u.test(header)
    assert.ok(tolerant || strict || viaBuild, `${name} depends on the source pack but has no condition`)
    overridden.push(name)
  }
  assert.ok(overridden.length >= 6, `the consumers must be covered, only found ${overridden.join(', ')}`)
})

test('every conditional job checks EVERY one of its needs', () => {
  // The defect this protects is the sharpest one in the whole workflow.
  //
  // `!cancelled()` is a STATUS CHECK function: using it (like `always()` or
  // `failure()`) SUPPRESSES the implicit `success()` requirement on the
  // needs. A condition of `!cancelled() && needs.build.result == 'success'`
  // therefore runs when the typecheck, the aggregate, the qualification or a
  // downstream leg FAILED — as long as the build succeeded.
  //
  // The qualified-artifact job had exactly that condition, and its only steps
  // are a digest re-check and an upload: a failed downstream leg would still
  // have produced a "qualified" artifact.
  //
  // The needs are read from the PARSED workflow, not with a line regex: an
  // earlier version matched only contiguous `- item` lines, so a COMMENT
  // between two needs silently truncated the list and the need below the
  // comment was never checked.
  const workflow = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'pr-pipeline-prototype.yml'), 'utf8'))
  let inspected = 0
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const condition = job.if
    if (typeof condition !== 'string' || !condition.includes('!cancelled()')) continue
    inspected += 1
    const needs = Array.isArray(job.needs) ? job.needs : [job.needs].filter(Boolean)
    assert.ok(needs.length > 0, `${name} has a condition but no needs`)
    for (const need of needs) {
      // `source-pack` is skipped in npm mode, so it may not require success —
      // but its FAILURE must still stop the job. Two ways say that, and both
      // are checked: "not failed", or "succeeded when this run is a source
      // run". Every other need must be an explicit success, including the
      // equivalence proof: its JOB always runs, so a skipped proof is not a
      // state the gate has to tolerate.
      const expected = need === 'source-pack'
        ? new RegExp(`needs\\['${need}'\\]\\.result (?:!= 'failure'|== 'success')`, 'u')
        : new RegExp(`needs\\['${need}'\\]\\.result == 'success'`, 'u')
      assert.match(condition, expected,
        `${name} must state the verdict of '${need}': !cancelled() suppresses the implicit success() check`)
    }
  }
  assert.ok(inspected >= 7, `the conditional jobs must all be covered, found ${inspected}`)
})

test('the qualified artifact job cannot run on a failed downstream leg', () => {
  const workflow = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'pr-pipeline-prototype.yml'), 'utf8'))
  const condition = workflow.jobs.qualified.if
  for (const need of ['downstream', 'qualify', 'aggregate', 'typecheck', 'candidate', 'build', 'context']) {
    assert.match(condition, new RegExp(`needs\\['${need}'\\]\\.result == 'success'`, 'u'),
      `the qualified artifact must require '${need}'`)
  }
})

test('a FAILED equivalence proof blocks the qualified artifact', () => {
  // The proof runs only when the packaging inputs changed, but when it DOES
  // run and fails, the artifact must not be published. This is stated here
  // explicitly because the mechanical loop above previously missed the
  // `equivalence` need (a comment truncated its needs list).
  const workflow = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'pr-pipeline-prototype.yml'), 'utf8'))
  const qualified = workflow.jobs.qualified
  assert.ok(qualified.needs.includes('equivalence'), 'the qualified artifact must depend on the proof')
  assert.match(qualified.if, /needs\['equivalence'\]\.result == 'success'/u,
    'the proof job always runs, so its verdict must be success — not merely "not failed"')
})

// ---------------------------------------------------------------------------
// The Source Mode wiring, as a contract against the shipped workflow.
//
// The three gaps this section protects were all silent: the proof would
// compare two packs of the wrong graph, the fresh-install probe would pass on
// structure alone, and the case baseline would certify a Source Mode run
// against numbers measured on the npm graph.
// ---------------------------------------------------------------------------

test('the equivalence proof consumes the pinned distribution in Source Mode', () => {
  const workflow = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'pr-pipeline-prototype.yml'), 'utf8'))
  const job = workflow.jobs.equivalence
  assert.ok(job.needs.includes('source-pack'), 'the proof must wait for the pinned distribution')
  const steps = job.steps
  const download = steps.find(step => step.uses === 'actions/download-artifact@v8'
    && step.with?.name === 'prototype-dsh-source-pack')
  assert.ok(download, 'the proof must consume the SAME distribution every other source job installs')
  assert.match(download.with.path, /\$\{\{ runner\.temp \}\}\/dsh-source-pack/u,
    'the download path is the path the dependency preparation installs from')
  // The trigger must receive the RUN's mode. Without it the recorded npm proof
  // would satisfy a source run and the two packs would never be compared.
  const trigger = steps.find(step => typeof step.run === 'string' && step.run.includes('pack-equivalence-input.mjs --check'))
  assert.ok(trigger, 'the proof must stay gated by its trigger')
  assert.match(trigger.run, /--mode "\$\{\{ needs\.context\.outputs\.mode \}\}"/u,
    'the trigger must be scoped by the run\'s mode, or an npm proof covers a source run')
})

test('the downstream matrix proves a FRESH install from the pinned distribution', () => {
  // The defect: `prototype-deps.mjs` exports `TARBALL_SMOKE_SKIP_INSTALL=1` in
  // source mode, and the smoke was invoked without `--dsh-distribution`. Every
  // source leg therefore ran the structural checks and never attempted the
  // install — the one thing this matrix exists to prove.
  const workflow = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'pr-pipeline-prototype.yml'), 'utf8'))
  const steps = workflow.jobs.downstream.steps
  const deps = steps.find(step => typeof step.run === 'string' && step.run.includes('prototype-deps.mjs'))
  assert.ok(deps, 'the npm path must still prepare its dependencies')
  assert.match(deps.if, /needs\.context\.outputs\.mode == 'npm'/u,
    'the source leg must NOT install the workspace: that is what exports the install-skipping flag')
  const smoke = steps.find(step => typeof step.run === 'string' && step.run.includes('tarball-smoke.mjs'))
  assert.ok(smoke, 'the matrix must run the tarball smoke')
  assert.match(smoke.run, /--dsh-distribution "\$RUNNER_TEMP\/dsh-source-pack"/u,
    'the source leg must install against the pinned distribution, not the registry')
})

test('the case baseline is MODE-SCOPED, so npm numbers cannot certify a source run', () => {
  const workflow = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'pr-pipeline-prototype.yml'), 'utf8'))
  const step = workflow.jobs.aggregate.steps.find(s => typeof s.run === 'string' && s.run.includes('verify-shards.mjs'))
  assert.ok(step, 'the aggregate must run the shard proof')
  assert.match(step.env.DSH_MODE, /\$\{\{ needs\.context\.outputs\.mode \}\}/u,
    'the aggregate must know which mode it is proving')
  assert.match(step.run, /scripts\/measurement-source-expected-cases\.txt/u,
    'a source run needs its OWN case baseline')
  assert.match(step.run, /scripts\/measurement-expected-cases\.txt/u,
    'the npm baseline must survive unchanged')
  // And an unrecorded source baseline must FAIL rather than borrow the npm
  // numbers: the file is named in the log, with what to do about it.
  assert.match(step.run, /measurement-source-baseline\.txt/u,
    'a source run with no recorded baseline must say so and stop')
})
