/**
 * M4-A0 split-process smoke wiring guard.
 *
 * The real OS qualification lives in `scripts/split-process-smoke.mjs` and is
 * driven by the CI Build-and-pack job. This tooling test keeps that lane
 * discoverable and prevents the script/CI/package wiring from silently rotting
 * while the heavy installation path stays out of the ordinary product lane.
 *
 * @module split-process-smoke-wiring.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { statusMatches } from '../../scripts/split-process-smoke.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'split-process-smoke.mjs')

test('the split-process smoke is a package script and a CI Build-and-pack step', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts?.['smoke:split-process'], 'node scripts/split-process-smoke.mjs')
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  assert.match(ci, /Host\/Client split-process bootstrap/u)
  assert.match(ci, /pnpm smoke:split-process -- "\$CANDIDATE"/u)
  assert.match(ci, /NOT_APPLICABLE: the startup strictness and split-process smokes are npm-only/u)
})

test('the process smoke script parses as ESM', () => {
  const result = spawnSync(process.execPath, ['--check', SCRIPT], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('a stale status record cannot satisfy a new request id', () => {
  const stale = { m4a0: 'status', requestId: 'status-1', pid: 10 }
  const fresh = { m4a0: 'status', requestId: 'status-2', pid: 10 }
  assert.equal(statusMatches(stale, 'status-2'), false)
  assert.equal(statusMatches(fresh, 'status-2'), true)
})
