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
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parse as parseYaml } from 'yaml'

import { depsPlan, planEnvironment, runPlan } from '../../scripts/ci-deps.mjs'
import {
  MODE_STATUS,
  RELEASE_PHASES,
  REQUIRED_PHASES,
  SPLIT_PROCESS_PHASE,
  SUMMARY_EXTRA_PHASES,
  expectedSplitProcessStatus,
  isSupportedRef,
  parsePhases,
  verdict,
} from '../../scripts/ci-verdict.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const VERDICT_SCRIPT = join(ROOT, 'scripts', 'ci-verdict.mjs')
const PR_REF = 'refs/pull/464/merge'
const RELEASE_REF = 'refs/tags/v0.5.5'

/** Every required phase at one result, plus the mode-dependent phases. */
function phasesAt(result, { mode = 'npm', ref = PR_REF, extra = {} } = {}) {
  return [
    ...REQUIRED_PHASES.map(name => ({ name, result })),
    ...(mode === 'npm'
      ? [
          { name: 'prepare-dsh-source', result: 'skipped' },
          { name: 'client-family-compat', result: 'success' },
        ]
      : [
          { name: 'prepare-dsh-source', result: 'success' },
          { name: 'client-family-compat', result: 'skipped' },
        ]),
    { name: SPLIT_PROCESS_PHASE, result: expectedSplitProcessStatus(mode, ref) },
    ...Object.entries(extra).map(([name, value]) => ({ name, result: value })),
  ]
}

/** Set the split-process result, or remove it when `result` is `absent`. */
function withSplitProcess(phases, result) {
  if (result === 'absent') return phases.filter(phase => phase.name !== SPLIT_PROCESS_PHASE)
  return phases.map(phase => phase.name === SPLIT_PROCESS_PHASE ? { ...phase, result } : phase)
}

/** Run the verdict CLI. */
function cli(args) {
  const result = spawnSync(process.execPath, [VERDICT_SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** The CLI arguments for one full phase set. */
function cliPhases(phases) {
  return phases.flatMap(phase => ['--phase', `${phase.name}=${phase.result}`])
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

test('a fully successful npm PR run qualifies with split-process skipped', () => {
  const decision = verdict({ role: 'qualify', mode: 'npm', ref: PR_REF, phases: phasesAt('success') })
  assert.deepEqual(decision.failures, [])
  assert.equal(decision.ok, true)
})

test('a fully successful npm release-tag run qualifies with split-process success', () => {
  const decision = verdict({ role: 'qualify', mode: 'npm', ref: RELEASE_REF, phases: phasesAt('success', { ref: RELEASE_REF }) })
  assert.deepEqual(decision.failures, [])
  assert.equal(decision.ok, true)
})

test('a fully successful source run qualifies with the source mode-statuses', () => {
  const decision = verdict({ role: 'qualify', mode: 'source', ref: RELEASE_REF, phases: phasesAt('success', { mode: 'source', ref: RELEASE_REF }) })
  assert.deepEqual(decision.failures, [])
})

test('SKIPPED, FAILED and CANCELLED are not success for a required phase', () => {
  for (const result of ['skipped', 'failure', 'cancelled']) {
    const phases = phasesAt('success')
    phases[0] = { name: phases[0].name, result }
    const decision = verdict({ role: 'qualify', mode: 'npm', ref: PR_REF, phases })
    assert.equal(decision.ok, false, `'${result}' must not qualify`)
    assert.match(decision.failures.join('\n'), new RegExp(`is '${result}', not 'success'`, 'u'))
  }
})

test('an ABSENT phase is a failure, not a pass', () => {
  const phases = phasesAt('success').filter(phase => phase.name !== 'aggregate')
  const decision = verdict({ role: 'qualify', mode: 'npm', ref: PR_REF, phases })
  assert.equal(decision.ok, false)
  assert.match(decision.failures.join('\n'), /'aggregate' was not reported/u)
})

test('a mode-dependent phase with the WRONG status is a failure', () => {
  // The directions are different bugs and all must be caught: a source run
  // whose pinned pack was skipped has no graph to qualify against, and an npm
  // run whose client-family gate was skipped dropped a check.
  const sourceWrong = phasesAt('success', { mode: 'source', ref: PR_REF })
  sourceWrong.find(phase => phase.name === 'prepare-dsh-source').result = 'skipped'
  assert.equal(verdict({ role: 'qualify', mode: 'source', ref: PR_REF, phases: sourceWrong }).ok, false)

  const npmWrong = phasesAt('success')
  npmWrong.find(phase => phase.name === 'client-family-compat').result = 'skipped'
  const decision = verdict({ role: 'qualify', mode: 'npm', ref: PR_REF, phases: npmWrong })
  assert.equal(decision.ok, false)
  assert.match(decision.failures.join('\n'), /requires 'success'/u)
})

test('split-process has exactly one expected status per mode and actual ref', () => {
  assert.equal(expectedSplitProcessStatus('npm', PR_REF), 'skipped')
  assert.equal(expectedSplitProcessStatus('npm', 'refs/heads/main'), 'skipped')
  assert.equal(expectedSplitProcessStatus('npm', 'refs/heads/next'), 'skipped')
  assert.equal(expectedSplitProcessStatus('npm', 'refs/tags/v0.5.5'), 'success')
  assert.equal(expectedSplitProcessStatus('npm', 'refs/tags/next-v0.5.5-alpha.1'), 'success')
  assert.equal(expectedSplitProcessStatus('source', PR_REF), 'skipped')
  assert.equal(expectedSplitProcessStatus('source', 'refs/tags/v0.5.5'), 'skipped')
  assert.equal(isSupportedRef(PR_REF), true)
  assert.equal(isSupportedRef('refs/heads/main'), true)
  assert.equal(isSupportedRef('refs/heads/feature/nested-name'), true)
  assert.equal(isSupportedRef(RELEASE_REF), true)
  assert.equal(isSupportedRef('refs/pull/464'), false)
  assert.equal(isSupportedRef('main'), false)
  assert.equal(isSupportedRef(''), false)
  assert.equal(isSupportedRef(undefined), false)
  // These are ref-format failures, not merely "unknown prefixes": Git itself
  // rejects them, and a forged CLI value must not become a skipped PR proof.
  for (const invalid of [
    'refs/heads/a..b',
    'refs/heads/..',
    'refs/tags/v1.lock',
    'refs/heads/@{bad',
    'refs/heads/foo.',
    'refs/heads/foo//bar',
  ]) {
    assert.equal(isSupportedRef(invalid), false, `${invalid} must be rejected`)
  }
})

test('the split-process truth table is fail-closed in both directions', () => {
  const cases = [
    // Ordinary refs: the proof MUST be skipped.
    { name: 'PR npm skipped', mode: 'npm', ref: PR_REF, split: 'skipped', ok: true },
    { name: 'main npm skipped', mode: 'npm', ref: 'refs/heads/main', split: 'skipped', ok: true },
    { name: 'next npm skipped', mode: 'npm', ref: 'refs/heads/next', split: 'skipped', ok: true },
    { name: 'PR npm success is drift', mode: 'npm', ref: PR_REF, split: 'success', ok: false },
    { name: 'PR npm failure', mode: 'npm', ref: PR_REF, split: 'failure', ok: false },
    { name: 'PR npm cancelled', mode: 'npm', ref: PR_REF, split: 'cancelled', ok: false },
    { name: 'PR npm absent', mode: 'npm', ref: PR_REF, split: 'absent', ok: false },
    // Release tags: the proof MUST be exactly success.
    { name: 'release tag npm success', mode: 'npm', ref: RELEASE_REF, split: 'success', ok: true },
    { name: 'prerelease tag npm success', mode: 'npm', ref: 'refs/tags/next-v0.5.5-alpha.1', split: 'success', ok: true },
    { name: 'release tag npm skipped', mode: 'npm', ref: RELEASE_REF, split: 'skipped', ok: false },
    { name: 'release tag npm failure', mode: 'npm', ref: RELEASE_REF, split: 'failure', ok: false },
    { name: 'release tag npm cancelled', mode: 'npm', ref: RELEASE_REF, split: 'cancelled', ok: false },
    { name: 'release tag npm absent', mode: 'npm', ref: RELEASE_REF, split: 'absent', ok: false },
    // Source Mode is qualified by its own lanes; it never claims the npm-only proof.
    { name: 'source PR skipped', mode: 'source', ref: PR_REF, split: 'skipped', ok: true },
    { name: 'source release tag skipped', mode: 'source', ref: RELEASE_REF, split: 'skipped', ok: true },
    { name: 'source PR success', mode: 'source', ref: PR_REF, split: 'success', ok: false },
    { name: 'source release tag success', mode: 'source', ref: RELEASE_REF, split: 'success', ok: false },
    { name: 'source release tag failure', mode: 'source', ref: RELEASE_REF, split: 'failure', ok: false },
    { name: 'source release tag cancelled', mode: 'source', ref: RELEASE_REF, split: 'cancelled', ok: false },
    { name: 'source release tag absent', mode: 'source', ref: RELEASE_REF, split: 'absent', ok: false },
  ]
  for (const entry of cases) {
    const phases = withSplitProcess(phasesAt('success', { mode: entry.mode, ref: entry.ref }), entry.split)
    const decision = verdict({ role: 'qualify', mode: entry.mode, ref: entry.ref, phases })
    assert.equal(decision.ok, entry.ok, `${entry.name}: ${decision.failures.join('; ')}`)
  }
})

test('a missing or malformed GITHUB_REF is a failure, never an implicit PR skip', () => {
  for (const ref of [
    undefined,
    '',
    'main',
    'refs/pull/123',
    'refs/heads/',
    'refs/pull/x/merge',
    'refs/heads/a..b',
    'refs/heads/..',
    'refs/tags/v1.lock',
    'refs/heads/@{bad',
  ]) {
    const decision = verdict({ role: 'qualify', mode: 'npm', ref, phases: phasesAt('success') })
    assert.equal(decision.ok, false, `ref=${JSON.stringify(ref)} must fail`)
    assert.match(decision.failures.join('\n'), /missing or not a supported ref/u)
  }

  const args = cliPhases(phasesAt('success'))
  const missing = cli(['qualify', '--mode', 'npm', ...args])
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /--ref is required/u)

  const empty = cli(['qualify', '--mode', 'npm', '--ref', '', ...args])
  assert.equal(empty.status, 1)
  assert.match(empty.stderr, /--ref is required/u)

  const invalid = cli(['qualify', '--mode', 'npm', '--ref', 'main', ...args])
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /not a supported GitHub ref/u)

  const malformed = cli(['qualify', '--mode', 'npm', '--ref', 'refs/heads/a..b', ...args])
  assert.equal(malformed.status, 1)
  assert.match(malformed.stderr, /not a supported GitHub ref/u)

  const summaryArgs = cliPhases(phasesAt('success', { extra: { qualified: 'success' } }))
  const summaryMissing = cli(['summary', '--mode', 'npm', ...summaryArgs])
  assert.equal(summaryMissing.status, 1)
  assert.match(summaryMissing.stderr, /--ref is required/u)
})

test('an UNKNOWN mode cannot be qualified', () => {
  const decision = verdict({ role: 'qualify', mode: 'hybrid', ref: PR_REF, phases: phasesAt('success') })
  assert.equal(decision.ok, false)
  assert.match(decision.failures.join('\n'), /not one this verdict knows/u)
})

test('the release phases are required only on a release tag', () => {
  const withoutRelease = verdict({ role: 'qualify', mode: 'npm', ref: RELEASE_REF, phases: phasesAt('success', { ref: RELEASE_REF }) })
  assert.equal(withoutRelease.ok, true, 'a PR does not run the release jobs')

  const withRelease = verdict({ role: 'qualify', mode: 'npm', ref: RELEASE_REF, phases: phasesAt('success', { ref: RELEASE_REF }), release: true })
  assert.equal(withRelease.ok, false)
  for (const phase of RELEASE_PHASES) {
    assert.match(withRelease.failures.join('\n'), new RegExp(`'${phase}' was not reported`, 'u'))
  }

  const complete = verdict({
    role: 'qualify',
    mode: 'npm',
    ref: RELEASE_REF,
    release: true,
    phases: phasesAt('success', { ref: RELEASE_REF, extra: Object.fromEntries(RELEASE_PHASES.map(name => [name, 'success'])) }),
  })
  assert.equal(complete.ok, true)
})

test('the SUMMARY additionally requires the qualified artifact', () => {
  const summary = verdict({ role: 'summary', mode: 'npm', ref: PR_REF, phases: phasesAt('success') })
  assert.equal(summary.ok, false)
  assert.match(summary.failures.join('\n'), /'qualified' was not reported/u)
  const withQualified = verdict({ role: 'summary', mode: 'npm', ref: PR_REF, phases: phasesAt('success', { extra: { qualified: 'success' } }) })
  assert.equal(withQualified.ok, true)
  assert.deepEqual(SUMMARY_EXTRA_PHASES, ['qualified'])
})

test('an unusable start instant is a diagnosis, not an elapsed time', () => {
  // The shell treats an empty operand as zero, which once produced a
  // plausible-looking elapsed time for a run that never started.
  for (const started of ['', '0', 'yesterday']) {
    const decision = verdict({ role: 'summary', mode: 'npm', ref: PR_REF, phases: phasesAt('success', { extra: { qualified: 'success' } }), started })
    assert.equal(decision.ok, false, `started=${JSON.stringify(started)} must fail`)
    assert.match(decision.failures.join('\n'), /start instant is unusable/u)
  }
  const now = Math.floor(Date.now() / 1000) - 10
  const decision = verdict({ role: 'summary', mode: 'npm', ref: PR_REF, phases: phasesAt('success', { extra: { qualified: 'success' } }), started: String(now) })
  assert.equal(decision.ok, true)
  assert.ok(decision.elapsedSeconds !== null && decision.elapsedSeconds >= 10)
})

test('the phase parser refuses an unknown result instead of treating it as not-failed', () => {
  assert.deepEqual(parsePhases(['--phase', 'build=success']), [{ name: 'build', result: 'success' }])
  assert.throws(() => parsePhases(['--phase', 'build=']), /unknown result/u)
  assert.throws(() => parsePhases(['--phase', 'build']), /<name>=<result>/u)
})

test('the CLI exits non-zero on a failed phase and zero on a full success', () => {
  const args = cliPhases(phasesAt('success'))
  const ok = cli(['qualify', '--mode', 'npm', '--ref', PR_REF, ...args])
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /phase\s+result/u)

  const failed = args.map(entry => (entry === 'build=success' ? 'build=failure' : entry))
  const bad = cli(['qualify', '--mode', 'npm', '--ref', PR_REF, ...failed])
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
    ...Object.values(MODE_STATUS).flatMap(status => Object.keys(status)),
    SPLIT_PROCESS_PHASE]) {
    assert.ok(jobs.has(name), `the verdict requires '${name}', which is not a job in ci.yml`)
  }
  // And the reverse direction: a job that gates publication must be in the
  // verdict. `publish`/`release` are tag-only and are covered by
  // RELEASE_PHASES; everything else that `qualified` waits for must be named.
  const qualifiedNeeds = Array.isArray(workflow.jobs.qualified.needs) ? workflow.jobs.qualified.needs : [workflow.jobs.qualified.needs]
  for (const need of qualifiedNeeds) {
    assert.ok(
      REQUIRED_PHASES.includes(need) || need === SPLIT_PROCESS_PHASE || Object.values(MODE_STATUS).some(status => need in status),
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

test('the accelerated jobs exist, the pack-equivalence job is GONE, and the artifact has exactly one producer', () => {
  const jobs = workflow().jobs
  for (const name of ['build', 'typecheck', 'product-shard', 'aggregate', 'candidate', 'qualify', 'split-process', 'qualified']) {
    assert.ok(name in jobs, `the accelerated DAG is missing '${name}'`)
  }
  assert.equal('equivalence' in jobs, false, 'the retired pack-equivalence job must not survive')
  for (const [name, job] of Object.entries(jobs)) {
    assert.equal(needsOf(job).includes('equivalence'), false, `${name} still waits for equivalence`)
  }
  // One build, one pack. A second `pnpm build` anywhere else means a consumer
  // rebuilds instead of proving the build it received; a second physical pack
  // would create a second artifact identity.
  const builders = Object.entries(jobs)
    .filter(([, job]) => (job.steps ?? []).some(step => typeof step.run === 'string' && /^\s*pnpm (clean && pnpm clean:fork && pnpm )?build$/mu.test(step.run)))
  assert.deepEqual(builders.map(([name]) => name), ['build'])
  const packers = Object.entries(jobs)
    .filter(([, job]) => (job.steps ?? []).some(step => typeof step.run === 'string' && /^\s*pnpm pack:artifact$/mu.test(step.run)))
  assert.deepEqual(packers.map(([name]) => name), ['candidate'])
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
  // are the ones whose STEPS re-check the graph, so they are exempt here — and
  // all three are asserted to delegate to a script below.
  const reporting = new Set(['aggregate', 'summary', 'qualified'])
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
  // The aggregate reports on the MATRIX it received: a green aggregate must
  // never hide a failed or skipped shard matrix. It no longer branches on the
  // dependency mode — the proof is structural and mode-independent.
  const aggregateRun = jobs.aggregate.steps.find(step => typeof step.run === 'string' && step.run.includes('SHARD_RESULT')).run
  assert.match(aggregateRun, /if \[ "\$SHARD_RESULT" != "success" \]/u,
    'the aggregate must refuse a shard matrix that did not succeed')
  assert.match(jobs.summary.steps.find(step => typeof step.run === 'string' && step.run.includes('ci-verdict')).run,
    /ci-verdict\.mjs summary/u)
  // The qualification job runs on a failed graph too, so its whole check is
  // the script — not the job-level condition.
  assert.match(jobs.qualified.steps.find(step => typeof step.run === 'string' && step.run.includes('ci-verdict')).run,
    /ci-verdict\.mjs qualify/u)
})

test('the mode-dependent jobs stay in the qualification verdict with their EXACT status', () => {
  // Source needs the pinned distribution built; npm needs the npm-only
  // client-family gate. split-process is its own ref-dependent expectation.
  // Accepting "not failed" would let a source run qualify with no dependency
  // graph, and an npm run qualify with a dropped check.
  //
  // The policy lives in `ci-verdict` (the qualified job must RUN on failure
  // instead of being skipped by a job-level condition), and the job still
  // waits for every one of these jobs.
  assert.deepEqual(MODE_STATUS.npm, {
    'prepare-dsh-source': 'skipped',
    'client-family-compat': 'success',
  })
  assert.deepEqual(MODE_STATUS.source, {
    'prepare-dsh-source': 'success',
    'client-family-compat': 'skipped',
  })
  assert.equal(expectedSplitProcessStatus('npm', RELEASE_REF), 'success')
  assert.equal(expectedSplitProcessStatus('npm', PR_REF), 'skipped')
  assert.equal(expectedSplitProcessStatus('source', RELEASE_REF), 'skipped')
  const expectedPhases = [...REQUIRED_PHASES, ...Object.keys(MODE_STATUS.npm), SPLIT_PROCESS_PHASE]
  const job = workflow().jobs.qualified
  assert.deepEqual(
    new Set(needsOf(job)),
    new Set(expectedPhases),
    'the qualified job must still wait for every verdict phase, including every mode-dependent job',
  )
  const verdictStep = job.steps.find(step => typeof step.run === 'string' && step.run.includes('ci-verdict.mjs qualify'))
  assert.ok(verdictStep, 'the qualified job must delegate its verdict to ci-verdict')
  const listed = [...verdictStep.run.matchAll(/--phase "([^"=]+)=/gu)].map(match => match[1])
  assert.deepEqual(
    new Set(listed),
    new Set(expectedPhases),
    'the verdict must be given every phase the script requires, including every mode-dependent job',
  )
  assert.match(verdictStep.run, /--mode "\$DSH_MODE"/u)
  assert.match(verdictStep.run, /--ref "\$GITHUB_REF"/u,
    'the verdict must receive the actual GitHub ref, not a default')
  assert.match(verdictStep.env.DSH_MODE, /outputs\.mode/u,
    'the verdict must receive the mode the run resolved, not a default')

  const summaryStep = workflow().jobs.summary.steps.find(step => typeof step.run === 'string' && step.run.includes('ci-verdict.mjs summary'))
  assert.match(summaryStep.run, /--ref "\$GITHUB_REF"/u,
    'the summary verdict must use the same actual-ref expectation')
})

test('the qualified job RUNS on a failed graph, and the verdict gates before any download or upload', () => {
  const job = workflow().jobs.qualified
  assert.match(job.if, /always\(\)/u,
    'a skipped qualification both hides the missing proof and cannot be re-run by "Re-run failed jobs"')
  assert.doesNotMatch(job.if, /needs\./u,
    'a needs-status gate would skip the job before the verdict can fail it')

  const steps = job.steps
  const verdictIndex = steps.findIndex(step => typeof step.run === 'string' && /ci-verdict\.mjs qualify/u.test(step.run))
  const downloadIndex = steps.findIndex(step => step.uses === 'actions/download-artifact@v8' && step.with?.name === 'dsh-pi-tui-provisional')
  const uploadIndex = steps.findIndex(step => step.uses === 'actions/upload-artifact@v7' && step.with?.name === 'dsh-pi-tui-tarball')
  assert.ok(verdictIndex >= 0, 'the qualification verdict must exist')
  // The verdict is the FIRST executable step: checkout/setup only prepare the
  // runner, and nothing may read, digest or upload a candidate before the
  // proof exists.
  const runSteps = steps.filter(step => typeof step.run === 'string')
  assert.equal(runSteps[0], steps[verdictIndex],
    'the verdict must be the first scripted step of the qualification job')
  assert.ok(downloadIndex > verdictIndex,
    'a failed verdict must stop the job before it looks for a candidate that does not exist')
  assert.ok(uploadIndex > downloadIndex,
    'the publishable artifact must only be uploaded after the candidate was downloaded and re-proved')

  // GitHub runs a step after a failure only when its `if` says so. The verdict
  // is a real gate only if nothing after it is unconditional-by-condition.
  for (const step of steps) {
    assert.equal(step['continue-on-error'], undefined, `${step.name}: no qualification step may continue on error`)
  }
  for (const step of steps.slice(verdictIndex + 1)) {
    assert.equal(step.if, undefined, `${step.name}: no step may be scheduled to run after a failed verdict`)
  }
})

test('every artifact upload REPLACES its name so a partial re-run can recover', () => {
  // "Re-run failed jobs" re-executes a producer while the successful jobs keep
  // the artifact they already uploaded. A same-name upload without `overwrite`
  // fails on the name (or leaves the old artifact for a consumer to read), so
  // every producer must replace its own artifact.
  const uploads = []
  for (const [jobName, job] of Object.entries(workflow().jobs)) {
    for (const step of job.steps ?? []) {
      if (step.uses === 'actions/upload-artifact@v7') uploads.push({ jobName, step })
    }
  }
  assert.ok(uploads.length >= 10, 'every artifact producer in the workflow must be covered')
  for (const { jobName, step } of uploads) {
    assert.equal(step.with?.overwrite, true,
      `${jobName}/${step.with?.name ?? '(unnamed)'} must overwrite a same-name artifact on a re-run`)
  }

  // The shard artifact is identified by its SLOT, never by the attempt: an
  // attempt or run suffix would leave the previous artifact in place and give
  // the aggregate two directories for one shard.
  const shardUpload = workflow().jobs['product-shard'].steps.find(step => step.uses === 'actions/upload-artifact@v7')
  assert.equal(shardUpload.with.name, 'product-shard-${{ matrix.shard }}-node24')
  assert.doesNotMatch(shardUpload.with.name, /attempt/u,
    'an attempt in the artifact name would defeat the stable download pattern')
  assert.equal(shardUpload.if, 'always()', 'a failed shard must still upload its diagnosis')
  assert.equal(shardUpload.with['if-no-files-found'], 'warn',
    'a failed shard with no files must not turn its upload step into a different failure')
})

test('a SUCCESSFUL shard must produce complete diagnostics before uploading', () => {
  // `if-no-files-found: warn` on the always() upload cannot distinguish "this
  // shard succeeded and wrote evidence" from "this shard succeeded and wrote
  // nothing". A success-path check is the gate that stops a stale same-name
  // artifact from standing in for a shard that never recorded its run.
  const steps = workflow().jobs['product-shard'].steps
  const runIndex = steps.findIndex(step => typeof step.run === 'string' && step.run.includes('run-test-lane.mjs'))
  const checkIndex = steps.findIndex(step => typeof step.run === 'string' && step.run.includes('diagnostics/cases.jsonl'))
  const uploadIndex = steps.findIndex(step => step.uses === 'actions/upload-artifact@v7')
  assert.ok(runIndex >= 0, 'the shard run step must exist')
  assert.ok(checkIndex >= 0, 'the success path must check the shard diagnostics')
  assert.ok(uploadIndex >= 0, 'the shard upload step must exist')
  assert.ok(runIndex < checkIndex && checkIndex < uploadIndex,
    'the completeness check must sit between the run and the upload')
  const check = steps[checkIndex]
  assert.equal(check.if, 'success()',
    'the completeness check is a success-path gate; a failed shard still uploads its partial diagnosis')
  for (const file of ['cases.jsonl', 'runner-spec.json', 'effective-params.json']) {
    assert.ok(check.run.includes(file), `the success path must require ${file}`)
  }
})

test('the accelerated DAG is the ONLY product-lane path, on every event', () => {
  // The migration's reason for existing: no event may still reach a job that
  // runs the whole product lane to produce a tarball. `ci.yml` has no
  // event-specific product branch. split-process is deliberately the ONLY
  // non-release job gated on a tag: it is the release-only OS proof, and the
  // verdict requires it to be exactly `success` there and exactly `skipped`
  // everywhere else.
  const jobs = workflow().jobs
  const tagGated = Object.entries(jobs)
    .filter(([, job]) => typeof job.if === 'string' && job.if.includes("refs/tags/"))
    .map(([name]) => name)
    .sort()
  assert.deepEqual(tagGated, ['publish', 'release', 'release-context', 'release-metadata', 'release-packed-check', 'split-process'])
  for (const name of tagGated) {
    // A release job must still REQUIRE the qualification.
    if (name === 'publish' || name === 'release') {
      assert.match(jobs[name].if, /needs\.qualified\.result == 'success'/u, `${name} must require the qualified artifact`)
    }
  }
  const split = jobs['split-process']
  assert.match(split.if, /startsWith\(github\.ref, 'refs\/tags\/'\)/u,
    'the split-process job must only run on a release tag')
  assert.match(split.if, /outputs\.mode == 'npm'/u,
    'the split-process job must only run in npm mode')
  assert.match(split.if, /always\(\)/u,
    'always() must survive so npm mode is not skipped through the transitive source need')
  // And no job may be gated on the PR event alone: the same graph must run for
  // a push to main/next.
  for (const [name, job] of Object.entries(jobs)) {
    const condition = typeof job.if === 'string' ? job.if : ''
    assert.doesNotMatch(condition, /github\.event_name == 'pull_request'/u, `${name} is gated to PR events`)
  }
})

test('the install RUNS with the planned environment, not merely reporting it', () => {
  // `GITHUB_ENV` is the environment of the LATER steps. Writing the plan's
  // variables there does nothing for the install this script is about to run,
  // so `pnpm install` used to inherit whatever registry the runner had —
  // while every later step read the public one. Asserting `depsPlan().env`
  // alone cannot see that: this case drives a REAL child process and checks
  // what it observed.
  const npm = depsPlan({ mode: 'npm', workspace: '/w' })
  const probe = (plan) => ({
    ...plan,
    commands: [[process.execPath, '-e', 'process.stdout.write(String(process.env.NPM_CONFIG_REGISTRY) + "|" + String(process.env.TARBALL_SMOKE_SKIP_INSTALL))']],
  })
  // The BASE environment is controlled, not inherited: a CI job that already
  // exported a registry (the same workflow does) must not change what this
  // asserts. What is under test is the plan's effect on the child.
  const result = runPlan(probe(npm), { stdio: ['ignore', 'pipe', 'pipe'], base: {} })
  assert.equal(result.status, 0, String(result.stderr))
  assert.equal(String(result.stdout), 'https://registry.npmjs.org/|undefined',
    'the npm install must see the registry pin, and must NOT see the source-only install skip')

  // The same root cause reaches the Source Mode preparation: its exported
  // variables must be in the child's environment too.
  const source = depsPlan({ mode: 'source', distribution: '/pack', workspace: '/w' })
  const sourced = runPlan(probe(source), { stdio: ['ignore', 'pipe', 'pipe'], base: {} })
  assert.equal(sourced.status, 0, String(sourced.stderr))
  assert.equal(String(sourced.stdout), 'undefined|1')
})

test('the inherited environment is preserved, and the plan wins on a conflict', () => {
  // The child still needs PATH, HOME, GITHUB_* and the rest of the job
  // environment; the plan only overrides the variables it decides.
  const plan = depsPlan({ mode: 'npm', workspace: '/w' })
  const environment = planEnvironment(plan, { PATH: '/usr/bin', NPM_CONFIG_REGISTRY: 'http://mirror.invalid/' })
  assert.equal(environment.PATH, '/usr/bin')
  assert.equal(environment.NPM_CONFIG_REGISTRY, 'https://registry.npmjs.org/',
    'a runner-level mirror must not survive the plan')
})

test('the aggregate gates on STRUCTURE and a skip POLICY, never on a count', () => {
  // A hand-maintained total is a MEASUREMENT device, not a delivery gate: it
  // has to be edited by every commit that adds a test, so an ordinary PR
  // fails the build for doing the right thing (that is exactly how PR #385
  // was blocked). A skip REASON policy is a different thing — it is a
  // qualification boundary, independent of any count, and it is what stops a
  // case from quietly skipping itself for a reason nobody agreed to.
  const step = workflow().jobs.aggregate.steps.find(entry => typeof entry.run === 'string' && entry.run.includes('verify-shards'))
  assert.ok(step, 'the aggregate must run the shard proof')
  assert.doesNotMatch(step.run, /DSH_EXPECTED_CASES|DSH_EXPECTED_SKIPPED|DSH_BASELINE_SOURCE|measurement-/u,
    'no committed count or baseline may gate the delivery pipeline')
  for (const suffix of ['expected-cases.txt', 'expected-skipped.txt', 'baseline-source.txt']) {
    assert.equal(existsSync(join(ROOT, 'scripts', `measurement-${suffix}`)), false,
      `the measurement artefact measurement-${suffix} must not be committed`)
    assert.equal(existsSync(join(ROOT, 'scripts', `measurement-source-${suffix}`)), false)
  }
  // The policy IS passed, and the file it names is committed.
  assert.equal(step.env.DSH_ACCEPTED_SKIPS_FILE, 'scripts/ci-accepted-skips.txt')
  assert.ok(existsSync(join(ROOT, 'scripts', 'ci-accepted-skips.txt')), 'the accepted-skip policy must be committed')
  // The identity and the claimed concurrency are what the proof rests on.
  assert.match(step.env.DSH_EXPECTED_RUN_ID, /github\.run_id/u)
  assert.match(step.env.DSH_EXPECTED_RUN_ATTEMPT, /github\.run_attempt/u)
  assert.match(step.env.DSH_EXPECTED_CONCURRENCY, /outputs\.test_concurrency/u)
})
