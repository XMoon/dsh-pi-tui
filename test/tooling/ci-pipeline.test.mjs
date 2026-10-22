/**
 * The CI pipeline's OWN decisions: how a job prepares its dependencies, and
 * whether a run qualifies.
 *
 * Both are decisions that a green job list cannot make for you:
 *
 *   - a job that installs from the registry while the run claims Source Mode
 *     is testing a different dependency graph, and nothing about its own
 *     result says so;
 *   - a verdict that accepts `skipped` as success describes a pipeline where
 *     the tests, the typecheck or the qualification never happened.
 *
 * So the decisions are scripts, and these cases are the ones that must FAIL.
 *
 * @module @xmoon76/dsh-pi-tui/test/tooling/ci-pipeline.test
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parse as parseYaml } from 'yaml'

import { depsPlan } from '../../scripts/ci-deps.mjs'
import {
  MODE_STATUS,
  RELEASE_PHASES,
  REQUIRED_PHASES,
  SUMMARY_EXTRA_PHASES,
  parsePhases,
  verdict,
} from '../../scripts/ci-verdict.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const VERDICT_SCRIPT = join(ROOT, 'scripts', 'ci-verdict.mjs')

/** Every required phase at one result, plus the two mode-dependent phases. */
function phasesAt(result, { mode = 'npm', extra = {} } = {}) {
  return [
    ...REQUIRED_PHASES.map(name => ({ name, result })),
    ...(mode === 'npm'
      ? [{ name: 'prepare-dsh-source', result: 'skipped' }, { name: 'client-family-compat', result: 'success' }]
      : [{ name: 'prepare-dsh-source', result: 'success' }, { name: 'client-family-compat', result: 'skipped' }]),
    ...Object.entries(extra).map(([name, value]) => ({ name, result: value })),
  ]
}

/** Run the verdict CLI. */
function cli(args) {
  const result = spawnSync(process.execPath, [VERDICT_SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

// ---------------------------------------------------------------------------
// The dependency preparation.
// ---------------------------------------------------------------------------

test('npm mode installs from the registry and skips nothing', () => {
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
  assert.ok(args.some(argument => argument.endsWith('scripts/prepare-dsh-test-environment.mjs')), JSON.stringify(args))
  assert.deepEqual(args.slice(args.indexOf('--mode'), args.indexOf('--mode') + 2), ['--mode', 'source'])
  assert.deepEqual(args.slice(args.indexOf('--distribution'), args.indexOf('--distribution') + 2), ['--distribution', '/pack'])
  assert.ok(args.includes('test/compat/dsh-source.json'), 'the pinned configuration is part of the plan')
  assert.equal(plan.env.TARBALL_SMOKE_SKIP_INSTALL, '1',
    'the packed package must not install its own DSH peer when the distribution is already in the workspace')
})

test('source mode WITHOUT the pinned distribution FAILS', () => {
  // The place the boundary lives: a source job that would fall back to the
  // registry is testing a different dependency graph.
  assert.throws(() => depsPlan({ mode: 'source', workspace: '/w' }), /source mode requires --distribution/u)
  assert.throws(() => depsPlan({ mode: 'source', distribution: '', workspace: '/w' }), /source mode requires --distribution/u)
})

test('an UNKNOWN mode is refused rather than installed as npm', () => {
  assert.throws(() => depsPlan({ mode: 'registry', workspace: '/w' }), /not one this pipeline prepares dependencies for/u)
})

// ---------------------------------------------------------------------------
// The final verdict.
// ---------------------------------------------------------------------------

test('a fully successful npm run qualifies', () => {
  const decision = verdict({ role: 'qualify', mode: 'npm', phases: phasesAt('success') })
  assert.deepEqual(decision.failures, [])
  assert.equal(decision.ok, true)
})

test('a fully successful source run qualifies with the source mode-statuses', () => {
  const decision = verdict({ role: 'qualify', mode: 'source', phases: phasesAt('success', { mode: 'source' }) })
  assert.deepEqual(decision.failures, [])
})

test('SKIPPED is not success for a required phase', () => {
  const phases = phasesAt('success')
  phases[0] = { name: phases[0].name, result: 'skipped' }
  const decision = verdict({ role: 'qualify', mode: 'npm', phases })
  assert.equal(decision.ok, false)
  assert.match(decision.failures.join('\n'), /is 'skipped', not 'success'/u)
})

test('an ABSENT phase is a failure, not a pass', () => {
  const phases = phasesAt('success').filter(phase => phase.name !== 'aggregate')
  const decision = verdict({ role: 'qualify', mode: 'npm', phases })
  assert.equal(decision.ok, false)
  assert.match(decision.failures.join('\n'), /'aggregate' was not reported/u)
})

test('a mode-dependent phase with the WRONG status is a failure', () => {
  // The two directions are different bugs and both must be caught: a source
  // run whose pinned pack was skipped has no graph to qualify against, and an
  // npm run whose client-family gate was skipped dropped a check.
  const sourceWrong = phasesAt('success', { mode: 'source' })
  sourceWrong.find(phase => phase.name === 'prepare-dsh-source').result = 'skipped'
  assert.equal(verdict({ role: 'qualify', mode: 'source', phases: sourceWrong }).ok, false)

  const npmWrong = phasesAt('success')
  npmWrong.find(phase => phase.name === 'client-family-compat').result = 'skipped'
  const decision = verdict({ role: 'qualify', mode: 'npm', phases: npmWrong })
  assert.equal(decision.ok, false)
  assert.match(decision.failures.join('\n'), /requires 'success'/u)
})

test('an UNKNOWN mode cannot be qualified', () => {
  const decision = verdict({ role: 'qualify', mode: 'hybrid', phases: phasesAt('success') })
  assert.equal(decision.ok, false)
  assert.match(decision.failures.join('\n'), /not one this verdict knows/u)
})

test('the release phases are required only on a release tag', () => {
  const withoutRelease = verdict({ role: 'qualify', mode: 'npm', phases: phasesAt('success') })
  assert.equal(withoutRelease.ok, true, 'a PR does not run the release jobs')

  const withRelease = verdict({ role: 'qualify', mode: 'npm', phases: phasesAt('success'), release: true })
  assert.equal(withRelease.ok, false)
  for (const phase of RELEASE_PHASES) {
    assert.match(withRelease.failures.join('\n'), new RegExp(`'${phase}' was not reported`, 'u'))
  }

  const complete = verdict({
    role: 'qualify',
    mode: 'npm',
    release: true,
    phases: phasesAt('success', { extra: Object.fromEntries(RELEASE_PHASES.map(name => [name, 'success'])) }),
  })
  assert.equal(complete.ok, true)
})

test('the SUMMARY additionally requires the qualified artifact', () => {
  const summary = verdict({ role: 'summary', mode: 'npm', phases: phasesAt('success') })
  assert.equal(summary.ok, false)
  assert.match(summary.failures.join('\n'), /'qualified' was not reported/u)
  const withQualified = verdict({ role: 'summary', mode: 'npm', phases: phasesAt('success', { extra: { qualified: 'success' } }) })
  assert.equal(withQualified.ok, true)
  assert.deepEqual(SUMMARY_EXTRA_PHASES, ['qualified'])
})

test('an unusable start instant is a diagnosis, not an elapsed time', () => {
  // The shell treats an empty operand as zero, which once produced a
  // plausible-looking elapsed time for a run that never started.
  for (const started of ['', '0', 'yesterday']) {
    const decision = verdict({ role: 'summary', mode: 'npm', phases: phasesAt('success', { extra: { qualified: 'success' } }), started })
    assert.equal(decision.ok, false, `started=${JSON.stringify(started)} must fail`)
    assert.match(decision.failures.join('\n'), /start instant is unusable/u)
  }
  const now = Math.floor(Date.now() / 1000) - 10
  const decision = verdict({ role: 'summary', mode: 'npm', phases: phasesAt('success', { extra: { qualified: 'success' } }), started: String(now) })
  assert.equal(decision.ok, true)
  assert.ok(decision.elapsedSeconds !== null && decision.elapsedSeconds >= 10)
})

test('the phase parser refuses an unknown result instead of treating it as not-failed', () => {
  assert.deepEqual(parsePhases(['--phase', 'build=success']), [{ name: 'build', result: 'success' }])
  assert.throws(() => parsePhases(['--phase', 'build=']), /unknown result/u)
  assert.throws(() => parsePhases(['--phase', 'build']), /<name>=<result>/u)
})

test('the CLI exits non-zero on a failed phase and zero on a full success', () => {
  const args = phasesAt('success').flatMap(phase => ['--phase', `${phase.name}=${phase.result}`])
  const ok = cli(['qualify', '--mode', 'npm', ...args])
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /phase\s+result/u)

  const failed = args.map(entry => (entry === 'build=success' ? 'build=failure' : entry))
  const bad = cli(['qualify', '--mode', 'npm', ...failed])
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /did NOT qualify/u)
})

// ---------------------------------------------------------------------------
// The verdict's phase names ARE the workflow's job ids.
//
// A renamed job must not silently drop out of the verdict: the list is
// checked against the parsed workflow, not against a comment.
// ---------------------------------------------------------------------------

test('every phase the verdict names is a job in ci.yml, and every blocking job is named', () => {
  const workflow = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'))
  const jobs = new Set(Object.keys(workflow.jobs))
  for (const name of [...REQUIRED_PHASES, ...SUMMARY_EXTRA_PHASES, ...RELEASE_PHASES,
    ...Object.values(MODE_STATUS).flatMap(status => Object.keys(status))]) {
    assert.ok(jobs.has(name), `the verdict requires '${name}', which is not a job in ci.yml`)
  }
  // And the reverse direction: a job that gates publication must be in the
  // verdict. `publish`/`release` are tag-only and are covered by
  // RELEASE_PHASES; everything else that `qualified` waits for must be named.
  const qualifiedNeeds = Array.isArray(workflow.jobs.qualified.needs) ? workflow.jobs.qualified.needs : [workflow.jobs.qualified.needs]
  for (const need of qualifiedNeeds) {
    assert.ok(
      REQUIRED_PHASES.includes(need) || Object.values(MODE_STATUS).some(status => need in status),
      `'qualified' waits for '${need}', but the verdict does not require it`,
    )
  }
})

// ---------------------------------------------------------------------------
// The workflow's STRUCTURE, as a contract.
//
// These are static gates over `ci.yml`. They replace nothing: the run itself
// proves the behaviour. What they protect is the SHAPE of the graph, which a
// green run cannot report on — a missing `needs` edge or an unchecked status
// is invisible until the day the skipped job silently publishes something.
// ---------------------------------------------------------------------------

/** The parsed workflow. */
function workflow() {
  return parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'))
}

/** A job's needs, normalised to an array. */
function needsOf(job) {
  return Array.isArray(job.needs) ? job.needs : [job.needs].filter(Boolean)
}

test('the retired build-and-pack job is GONE, and nothing still waits for it', () => {
  // A surviving copy would run the whole product lane a second time on every
  // PR, which is the cost this migration exists to remove — and the tag path
  // would then have two artifact producers with different names.
  const jobs = workflow().jobs
  assert.equal('build-and-pack' in jobs, false, 'the old single-runner pack job must be retired')
  for (const [name, job] of Object.entries(jobs)) {
    assert.equal(needsOf(job).includes('build-and-pack'), false, `${name} still waits for build-and-pack`)
  }
})

test('the accelerated jobs exist and the old artifact has exactly one producer', () => {
  const jobs = workflow().jobs
  for (const name of ['build', 'typecheck', 'product-shard', 'aggregate', 'candidate', 'qualify', 'equivalence', 'qualified']) {
    assert.ok(name in jobs, `the accelerated DAG is missing '${name}'`)
  }
  // One build, one pack. A second `pnpm build` anywhere else means a consumer
  // rebuilds instead of proving the build it received.
  const builders = Object.entries(jobs)
    .filter(([, job]) => (job.steps ?? []).some(step => typeof step.run === 'string' && /^\s*pnpm (clean && pnpm clean:fork && pnpm )?build$/mu.test(step.run)))
  assert.deepEqual(builders.map(([name]) => name), ['build'])
})

test('every consumer downloads the PROVISIONAL artifact and re-proves it', () => {
  // `provisional` is what the downstream gates are allowed to read; the final
  // `dsh-pi-tui-tarball` is the only publishable one. Swapping them would let a
  // gate certify one tarball while another is published.
  const jobs = workflow().jobs
  for (const name of ['compat-smoke', 'ecosystem-compat', 'official-preset-assembly', 'runtime-boundary']) {
    const steps = jobs[name].steps
    const download = steps.find(step => step.uses === 'actions/download-artifact@v8' && step.with?.path === 'tarball')
    assert.equal(download?.with?.name, 'dsh-pi-tui-provisional', `${name} must consume the provisional artifact`)
  }
  // And the publish path reads ONLY the qualified artifact.
  for (const name of ['publish', 'release']) {
    const steps = jobs[name].steps
    const download = steps.find(step => step.uses === 'actions/download-artifact@v8' && /tarball|release-assets/u.test(step.with?.path ?? ''))
    assert.equal(download.with.name, 'dsh-pi-tui-tarball', `${name} must consume the FINAL artifact`)
  }
})

test('the qualified job uploads the artifact the publish path reads', () => {
  const jobs = workflow().jobs
  const upload = jobs.qualified.steps.find(step => step.uses === 'actions/upload-artifact@v7')
  assert.equal(upload.with.name, 'dsh-pi-tui-tarball')
  assert.match(upload.with.path, /\$\{\{ env\.QUALIFIED_TARBALL \}\}/u,
    'the artifact must be uploaded from its own path, keeping the package basename')
  // No rebuild inside the final gate: it re-proves and uploads bytes only.
  assert.equal((jobs.qualified.steps ?? []).some(step => typeof step.run === 'string' && /pnpm (pack|build)\b/u.test(step.run)), false)
})

test('the shard job passes BOTH the partition and the resolved concurrency', () => {
  const job = workflow().jobs['product-shard']
  const run = job.steps.find(step => typeof step.run === 'string' && step.run.includes('run-test-lane.mjs')).run
  assert.match(run, /--shard=\$\{\{ matrix\.shard \}\}\/\$\{\{ needs\.dsh-context\.outputs\.shard_total \}\}/u)
  assert.match(run, /--test-concurrency=\$\{\{ needs\.dsh-context\.outputs\.test_concurrency \}\}/u,
    'the claimed concurrency must reach the runner, or the run reports a level nobody applied')
  assert.match(run, /runner-spec\.mjs/u, 'the applied parameters must be recorded for the aggregate')
  assert.deepEqual(job.strategy['max-parallel'], '${{ fromJSON(needs.dsh-context.outputs.max_parallel) }}')
  assert.deepEqual(job.strategy.matrix.shard, '${{ fromJSON(needs.dsh-context.outputs.shards) }}')
})

test('every job that can be SKIPPED by mode states the mode it needs', () => {
  // `always()` suppresses the implicit success requirement. The reporting jobs
  // are the two whose STEPS re-check the graph, so they are exempt here — and
  // both are asserted to delegate to a script below.
  const reporting = new Set(['aggregate', 'summary'])
  const jobs = workflow().jobs
  for (const [name, job] of Object.entries(jobs)) {
    if (typeof job.if !== 'string') continue
    if (!/always\(\)|!cancelled\(\)/u.test(job.if)) continue
    if (!reporting.has(name)) {
      for (const need of needsOf(job)) {
        const checked = job.if.includes(`needs.${need}.result`) || job.if.includes(`needs['${need}'].result`)
        assert.ok(checked, `${name} has an always()/!cancelled() condition but does not check '${need}'`)
      }
    }
  }
  assert.match(jobs.aggregate.steps.find(step => typeof step.run === 'string' && step.run.includes('verify-shards')).run,
    /DSH_MODE/u, 'the aggregate must check the matrix result and the mode before trusting the records')
  assert.match(jobs.summary.steps.find(step => typeof step.run === 'string' && step.run.includes('ci-verdict')).run,
    /ci-verdict\.mjs summary/u)
})

test('the two mode-dependent jobs are required with their EXACT status', () => {
  // Source needs the pinned distribution built; npm needs the npm-only
  // client-family gate. Accepting "not failed" would let a source run qualify
  // with no dependency graph, and an npm run qualify with a dropped check.
  const condition = workflow().jobs.qualified.if
  assert.match(condition, /needs\.dsh-context\.outputs\.mode == 'npm' && needs\['prepare-dsh-source'\]\.result == 'skipped' && needs\['client-family-compat'\]\.result == 'success'/u)
  assert.match(condition, /needs\.dsh-context\.outputs\.mode == 'source' && needs\['prepare-dsh-source'\]\.result == 'success' && needs\['client-family-compat'\]\.result == 'skipped'/u)
})

test('the accelerated DAG is the ONLY product-lane path, on every event', () => {
  // The migration's reason for existing: no event may still reach a job that
  // runs the whole product lane to produce a tarball. `ci.yml` has no
  // event-specific product branch, and the only tag-gated jobs are the release
  // ones — a tag must not skip the tests it publishes the result of.
  const jobs = workflow().jobs
  const tagGated = Object.entries(jobs)
    .filter(([, job]) => typeof job.if === 'string' && job.if.includes("refs/tags/"))
    .map(([name]) => name)
    .sort()
  assert.deepEqual(tagGated, ['publish', 'release', 'release-context', 'release-metadata'])
  for (const name of tagGated) {
    // A release job must still REQUIRE the qualification.
    if (name === 'publish' || name === 'release') {
      assert.match(jobs[name].if, /needs\.qualified\.result == 'success'/u, `${name} must require the qualified artifact`)
    }
  }
  // And no job may be gated on the PR event alone: the same graph must run for
  // a push to main/next.
  for (const [name, job] of Object.entries(jobs)) {
    const condition = typeof job.if === 'string' ? job.if : ''
    assert.doesNotMatch(condition, /github\.event_name == 'pull_request'/u, `${name} is gated to PR events`)
  }
})
