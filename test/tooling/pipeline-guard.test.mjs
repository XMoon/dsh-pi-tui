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
import { join, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { FAULT_TOKENS, REQUIRED_PHASES, checkFault, checkMode, summarize } from '../../scripts/pipeline-guard.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'pipeline-guard.mjs')

/** Every required phase, at one result. */
function phasesAt(result) {
  return REQUIRED_PHASES.map(name => ({ name, result }))
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

test('SOURCE mode is REFUSED, with the reason and the remedy', () => {
  // The prototype cannot qualify it: the source-leak gate needs the built
  // distribution and the startup smoke is npm-only. Running anyway would
  // skip a gate and still produce a qualified candidate.
  const verdict = checkMode('source')
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /SOURCE MODE IS NOT IMPLEMENTED/u)
  assert.match(verdict.reason, /would skip a gate/u)
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

test('the CLI exits non-zero for source mode, so the workflow stops there', () => {
  const result = cli(['mode', 'source'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /SOURCE MODE IS NOT IMPLEMENTED/u)
  // The point of refusing at the ENTRY: nothing downstream may run, so no
  // candidate tarball can be produced for a mode that skipped a gate.
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
