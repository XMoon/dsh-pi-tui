/**
 * M4-A0 split-process smoke wiring guard.
 *
 * The real OS qualification lives in `scripts/split-process-smoke.mjs` and is
 * driven by the dedicated CI split-process job. This tooling test keeps that
 * lane discoverable and prevents the script/CI/package wiring from silently
 * rotting while the heavy installation path stays out of the ordinary product
 * lane.
 *
 * @module split-process-smoke-wiring.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { statusMatches } from '../../scripts/split-process-smoke.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'split-process-smoke.mjs')

test('the split-process smoke is a package script and a dedicated CI job', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts?.['smoke:split-process'], 'node scripts/split-process-smoke.mjs')
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  assert.match(ci, /Host\/Client split-process bootstrap/u)
  assert.match(ci, /pnpm smoke:split-process -- "\$CANDIDATE"/u)
  assert.match(ci, /NOT_APPLICABLE: the startup strictness smoke is npm-only; the Host\/Client split-process job is also npm-only/u)

  // Parse the two jobs rather than only matching prose: the split-process job
  // must own the npm gate, and `qualify` must explicitly record the source-mode
  // skip for both npm-only surfaces. A text-only assertion could keep passing
  // while the job-level gate or the source record was dropped.
  const workflow = parseYaml(ci)
  const job = workflow.jobs['split-process']
  assert.ok(job, 'the split-process smoke must be its own CI job')
  assert.match(job.if, /outputs\.mode == 'npm'/u, 'the split-process job must only run in npm mode')
  const record = workflow.jobs.qualify.steps.find(step => step.name === 'Record the npm-only smoke on a source run')
  assert.ok(record, 'qualify must record the npm-only skip on a source run')
  assert.match(record.run, /startup strictness smoke is npm-only/u)
  assert.match(record.run, /split-process job is also npm-only/u)
})

test('the process smoke script parses as ESM', () => {
  const result = spawnSync(process.execPath, ['--check', SCRIPT], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('a stale or unrelated record cannot satisfy a new status request id', () => {
  const stale = { m4a0: 'status', requestId: 'status-1', pid: 10 }
  const fresh = { m4a0: 'status', requestId: 'status-2', pid: 10 }
  const unrelated = { m4a0: 'qualification', requestId: 'status-2', pid: 10 }
  assert.equal(statusMatches(stale, 'status-2'), false)
  assert.equal(statusMatches(fresh, 'status-2'), true)
  assert.equal(statusMatches(unrelated, 'status-2'), false)
})

test('the upgraded smoke carries every B1 gate and the critical negative controls', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  for (const gate of ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08', 'T09', 'T10', 'T11', 'T12', 'T13', 'T14', 'T15', 'T16', 'T17', 'T18', 'T19']) {
    assert.match(source, new RegExp(`\\b${gate}\\b`, 'u'), `missing ${gate}`)
  }
  for (const marker of [
    '/api/pi-tui.local-host',
    '/connect',
    'qualification-drop-websocket',
    'SPLIT_PROCESS_CLIENT_FORCE_FAILURE',
    'SPLIT_PROCESS_CLIENT_OMIT_COOKIE',
    'SPLIT_PROCESS_CLIENT_FORCE_STARTUP_FATAL',
    'SPLIT_PROCESS_CLIENT_FORCE_REFRESH_UNRESPONSIVE_ONCE',
    'SPLIT_PROCESS_SMOKE_FAIL_AFTER',
    'SPLIT_PROCESS_HOST_PUBLISH_BARRIER',
    'SPLIT_PROCESS_HOST_STOP_BARRIER',
    'stop-repeat-ignored',
    'FAILPOINT_CLEANUP_OK',
    't14-startup-fatal',
    't13-retryable-refresh',
    'mutation-tui-enabled',
    'mutation-connection-disabled',
    'killIsolatedProcesses',
    'trackedProcesses',
    't14-lifetime',
    'HOST_ALREADY_OWNED',
    'CLIENT_ALREADY_ACTIVE',
    'HOST_UNRESPONSIVE',
    'HOST_BUILD_INCOMPATIBLE',
    'HOST_AUTH_FAILED',
    'HOST_IDENTITY_MISMATCH',
  ]) {
    assert.ok(source.includes(marker), `missing smoke marker ${marker}`)
  }
  const extraPatchUses = source.match(/SPLIT_PROCESS_EXTRA_PATCH/gu) ?? []
  assert.equal(extraPatchUses.length, 4, 'the extra patch may only implement the two child mutations and the whole-smoke mutation mode')
  assert.match(source, /SPLIT_PROCESS_EXTRA_PATCH: tuiMutationPatch/u)
  assert.match(source, /SPLIT_PROCESS_EXTRA_PATCH: connectionMutationPatch/u)
  assert.match(source, /SPLIT_PROCESS_SMOKE_MUTATION/u)
  assert.match(source, /SPLIT_PROCESS_SMOKE_MUTATION/u)
  assert.match(source, /mutationEnv/u)
  assert.match(source, /DSH_PI_TUI_ROLE: 'host'/u, 'the inherited-role negative control must remain')
})
