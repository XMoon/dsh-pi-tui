#!/usr/bin/env node
/**
 * Verify the six fault injections the way the qualification requires.
 *
 * For each injected fault the pipeline must:
 *
 *   1. FAIL as a whole run;
 *   2. fail at the phase the injection targets (so the failure is
 *      attributable, not an unrelated breakage);
 *   3. produce NO qualified artifact — the artifact must not come into
 *      existence at all, not merely be marked bad;
 *   4. still refuse to report a green summary.
 *
 * The last two are the substance: an artifact that exists and is merely
 * "unqualified" by convention is exactly the hole the provisional/qualified
 * split closes.
 *
 * Usage: node scripts/verify-faults.mjs --out <report.json>
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

/**
 * What each injection must make FAIL, and the evidence that it is that
 * injection's failure rather than an unrelated breakage.
 *
 * `target` is the phase that OBSERVES the fault, which is not always the
 * phase whose name the token mentions — and the difference is not a
 * technicality:
 *
 *   - `shard-missing` suppresses a shard's RECORDS after its run passed, so
 *     the shard job still succeeds and the AGGREGATE is what must fail. A
 *     verifier that demanded a shard failure would be demanding the wrong
 *     behaviour and would pass a pipeline that never checked coverage.
 *
 *   - `build-missing` suppresses the shared build's UPLOAD, so the build job
 *     still succeeds and the artifact never exists. What must fail is the
 *     CONSUMER, and the invariant under test is that it fails closed instead
 *     of rebuilding its own build. Demanding a producer failure would test a
 *     weaker scenario.
 *
 * `expectLog` is the attribution evidence: the injected failure must carry
 * the message the fault is supposed to produce, so a red run for an
 * unrelated reason cannot be counted as proof.
 */
const FAULTS = [
  { fault: 'shard-fail', branch: 'ci/pr-pipeline-prototype-fault-shard-fail', target: 'product shards', expectLog: /the shard test run failed \(INJECTED FAULT 'shard-fail'\)/u },
  { fault: 'shard-missing', branch: 'ci/pr-pipeline-prototype-fault-shard-missing', target: 'aggregate', expectLog: /expected 4 shard directories/u },
  { fault: 'digest-mismatch', branch: 'ci/pr-pipeline-prototype-fault-digest-mismatch', target: 'product shards', expectLog: /the build digest is [0-9a-f]+, not the expected [0-9a-f]+/u },
  { fault: 'build-missing', branch: 'ci/pr-pipeline-prototype-fault-build-missing', target: 'product shards', expectLog: /Artifact not found for name: prototype-build/u },
  // The generic "Smoke 1/8" is not enough: it matches a first smoke that
  // failed for ANY reason, including one where the injection never truncated
  // the candidate. The extra signature is the one a truncated archive
  // produces and nothing else does.
  { fault: 'smoke-fail', branch: 'ci/pr-pipeline-prototype-fault-smoke-fail', target: 'qualification', expectLog: /Smoke 1\/8[\s\S]*Unexpected EOF in archive/u },
  { fault: 'downstream-fail', branch: 'ci/pr-pipeline-prototype-fault-downstream-fail', target: 'downstream matrix', expectLog: /the downstream compatibility leg failed \(INJECTED FAULT 'downstream-fail'\)/u },
  // The SELECTOR BOUNDARY. With one shard, a target of "shard 4" would never
  // exist and the pipeline could succeed while claiming to inject a fault.
  // The aggregate must be short the single shard.
  { fault: 'shard-missing (1-shard run)', branch: 'ci/pr-pipeline-prototype-n1-fault', target: 'aggregate', expectLog: /expected 1 shard directories/u },
  // The same injection on the other end of the range, after the target moved
  // from shard 3 to shard 1.
  { fault: 'shard-fail (N=4, target moved to shard 1)', branch: 'ci/pr-pipeline-prototype-n4-fault-shard-fail', target: 'product shards', expectLog: /the shard test run failed \(INJECTED FAULT 'shard-fail'\)/u },
]

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 28 }).trim()
}

/**
 * The job-name prefix of a summary phase.
 *
 * The summary names a PHASE; GitHub names a JOB. The two vocabularies are
 * deliberately different (a phase may be several jobs), so the mapping is
 * explicit rather than a substring guess.
 */
const PHASE_PREFIX = {
  build: 'Build the shared artifact',
  aggregate: 'Aggregate the shards',
  'product shards': 'Product shard',
  qualification: 'Qualify the candidate',
  'downstream matrix': 'Downstream compat',
  'Pipeline summary': 'Pipeline summary',
}

function phasePrefix(phase) {
  const prefix = PHASE_PREFIX[phase]
  if (prefix === undefined) throw new Error(`no job prefix is known for the phase '${phase}'`)
  return prefix
}

/**
 * The files an injection branch is allowed to change, relative to the
 * reviewed base.
 *
 * Everything else in the tree must be the reviewed code. Without this check
 * a verifier happily reports "8/8" while six of the runs executed an OLDER
 * commit: the evidence would describe a tree that no longer exists.
 */
const INJECTION_KNOBS = ['scripts/prototype-fault.txt', 'scripts/prototype-shard-total.txt']

function git(args) {
  return execFileSync('git', args, { cwd: WORKTREE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** Whether this commit is available locally, fetching it if not. */
function ensureCommit(sha) {
  try {
    git(['cat-file', '-e', `${sha}^{commit}`])
    return true
  } catch {
    try {
      git(['fetch', '--quiet', 'origin', sha])
      return true
    } catch {
      return false
    }
  }
}

/**
 * The files in which a run's commit differs from the reviewed base.
 *
 * @param {string} base - the reviewed base commit.
 * @param {string} sha - the commit the run actually executed.
 * @returns {string[]|null} the differing files, or null when the commit is
 *   not available (which is NOT proof of freshness).
 */
function differingFiles(base, sha) {
  if (!ensureCommit(sha)) return null
  try {
    return git(['diff', '--name-only', base, sha]).split('\n').filter(Boolean)
  } catch {
    return null
  }
}

function latestRun(branch) {
  const runs = JSON.parse(gh(['api', `repos/XMoon/dsh-pi-tui/actions/runs?branch=${branch}&per_page=1`]))
  return runs.workflow_runs[0] ?? null
}

function jobsOf(runId) {
  return JSON.parse(gh(['api', `repos/XMoon/dsh-pi-tui/actions/runs/${runId}/jobs?per_page=100`])).jobs
}

function failedLog(runId) {
  // `--log-failed` is the only part worth reading: the step that failed is
  // where the injection's message is.
  try {
    return execFileSync('gh', ['run', 'view', String(runId), '--log-failed'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  } catch (error) {
    // A failed run makes `gh run view --log-failed` exit non-zero; its
    // OUTPUT is still what we want.
    return String(error.stdout ?? '')
  }
}

/**
 * The lines of one job from `gh run view --log-failed`.
 *
 * Every line is prefixed with the job name and a tab, so the target job's
 * evidence can be isolated. Without this, a message produced by ANY job
 * would satisfy the assertion.
 *
 * @param {string} log - the whole failed log.
 * @param {string} jobPrefix - the job-name prefix of the target phase.
 * @returns {string} the target job's lines.
 */
function logForJob(log, jobPrefix) {
  return log
    .split('\n')
    .filter(line => line.startsWith(`${jobPrefix}`) || line.includes(`\t${jobPrefix}`))
    .join('\n')
}

function artifactsOf(runId) {
  return JSON.parse(gh(['api', `repos/XMoon/dsh-pi-tui/actions/runs/${runId}/artifacts?per_page=100`])).artifacts
}

const WORKTREE = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

/**
 * The commit whose tree the injections must have executed.
 *
 * The default is the CURRENT HEAD: a run of an older commit proves something
 * about an older tree, and reporting it as evidence for the present one is
 * how a verifier says "8/8" about code that no longer exists.
 */
const REVIEWED_BASE = (() => {
  const index = process.argv.indexOf('--base')
  if (index !== -1) return process.argv[index + 1]
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: WORKTREE, encoding: 'utf8' }).trim()
})()

const results = []
for (const { fault, branch, target, expectLog } of FAULTS) {
  const run = latestRun(branch)
  if (run === null) {
    results.push({ fault, ok: false, reason: 'no run found' })
    continue
  }
  if (run.status !== 'completed') {
    results.push({ fault, run: run.id, ok: false, reason: `run is ${run.status}` })
    continue
  }
  // FRESHNESS: the run must have executed the reviewed tree, plus only the
  // injection knobs. A stale run is not evidence for the current code.
  const differing = differingFiles(REVIEWED_BASE, run.head_sha)
  const stale = differing === null
    ? ['the run commit is not available locally, so freshness cannot be shown']
    : differing.filter(file => !INJECTION_KNOBS.includes(file))
  const headSha = run.head_sha

  const jobs = jobsOf(run.id)
  const names = jobs.map(job => job.name)
  const jobFor = (phase) => {
    // A matrix phase is several jobs; its verdict is the worst of them.
    const matching = jobs.filter(job => job.name.startsWith(phasePrefix(phase)))
    if (matching.length === 0) return 'absent'
    if (matching.some(job => job.conclusion === 'failure')) return 'failure'
    if (matching.some(job => job.conclusion === 'cancelled')) return 'cancelled'
    if (matching.some(job => job.conclusion === null)) return 'incomplete'
    if (matching.some(job => job.conclusion === 'skipped')) return 'skipped'
    return 'success'
  }
  const phaseResult = jobFor(target)
  // The target must have FAILED. Treating `skipped`, `cancelled` or an
  // unfinished job as "the target failed" would let a run where the target
  // never executed count as proof of the injection.
  const phaseFailed = phaseResult === 'failure'
  const artifacts = artifactsOf(run.id).map(a => a.name)
  const qualified = artifacts.includes('prototype-qualified-candidate')
  const provisional = artifacts.includes('prototype-provisional-candidate')
  const summary = jobFor('Pipeline summary')

  const failures = []
  if (stale.length > 0) {
    failures.push(`the run executed a tree that is not the reviewed base plus the injection knobs: ${stale.join(', ')}`)
  }
  if (run.conclusion !== 'failure') failures.push(`the run conclusion is '${run.conclusion}', not 'failure'`)
  if (!phaseFailed) {
    failures.push(`the target phase '${target}' is '${phaseResult}', not 'failure': the injection is not attributable to it`)
  }
  // The attribution evidence: the TARGET JOB's own log must carry the
  // injection's message.
  //
  // Reading the whole run's failed log is not the same thing: every other
  // job's failure would be searched too, so a target that never ran could be
  // "attributed" by a message produced somewhere else.
  let logMatched = null
  if (phaseFailed) {
    const log = failedLog(run.id)
    logMatched = expectLog.test(logForJob(log, phasePrefix(target)))
    if (!logMatched) {
      failures.push(`the target job's log does not carry the injection's own message (${expectLog})`)
    }
  }
  // THE substance: the qualified artifact must not exist.
  if (qualified) failures.push('a prototype-qualified-candidate artifact EXISTS: the qualification was not refused')
  if (summary === 'success') failures.push('the summary reported success for a run that did not qualify')

  results.push({
    fault,
    run: run.id,
    headSha,
    fresh: stale.length === 0,
    runConclusion: run.conclusion,
    target,
    phaseResult,
    phaseFailed,
    logMatched,
    qualifiedArtifact: qualified,
    provisionalArtifact: provisional,
    summary,
    jobCount: names.length,
    ok: failures.length === 0,
    reasons: failures,
  })
}

const report = { checkedAt: new Date().toISOString(), results }
console.log('| fault | run | head | fresh | run | target phase | phase | log | qualified | summary | verdict |')
console.log('|---|---|---|---|---|---|---|---|---|---|---|')
for (const r of results) {
  if (r.reasons === undefined) {
    console.log(`| ${r.fault} | ${r.run} | ? | — | — | — | — | **${r.reason}** |`)
    continue
  }
  console.log(`| ${r.fault} | ${r.run} | ${r.headSha.slice(0, 8)} | ${r.fresh ? 'yes' : '**stale**'} | ${r.runConclusion} | ${r.target} | ${r.phaseResult} | ${r.logMatched === true ? 'yes' : r.logMatched === false ? '**no**' : '—'} | ${r.qualifiedArtifact ? '**PRESENT**' : 'absent'} | ${r.summary} | ${r.ok ? 'PASS' : '**FAIL**'} |`)
}
for (const r of results) {
  if (!r.ok) for (const reason of r.reasons ?? [r.reason]) console.log(`  - ${r.fault}: ${reason}`)
}
const outIndex = process.argv.indexOf('--out')
if (outIndex !== -1) writeFileSync(process.argv[outIndex + 1], `${JSON.stringify(report, null, 2)}\n`)
if (results.some(r => !r.ok)) process.exit(1)
