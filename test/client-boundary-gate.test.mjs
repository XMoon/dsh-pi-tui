/**
 * Static audit for the server/client migration boundary (AGENTS.md
 * "Server/client migration guardrails (hard rules)"): the checked-in gate
 * baseline must match the current tree, and the gate's matching logic must
 * catch new Host coupling while ignoring comments and non-Host services.
 * The gate itself (`scripts/client-boundary-gate.mjs`) is the enforcement;
 * this test guards the baseline against drift and the matcher against
 * regressions.
 * @module @xmoon76/dsh-pi-tui/client-boundary-gate.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { testLifecycle } from './support/temp-lifecycle.ts'
import { scanTree, findNewDebt, findStaleBaseline, loadBaseline, HOST_SERVICES } from '../scripts/client-boundary-gate.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('baseline matches the current src/ tree (no drift, no new debt)', () => {
  const scanned = scanTree(join(root, 'src'))
  const baseline = loadBaseline()
  const debt = findNewDebt(scanned, baseline)
  assert.deepEqual(
    debt,
    [],
    `new Host coupling detected — see docs/client-server-coupling.md; ` +
      `if a migration phase legitimately relocated coupling, update the baseline deliberately:\n${debt.join('\n')}`,
  )
})

test('scanTree ignores comment lines and non-Host services', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('client-boundary-')
  writeFileSync(
    join(dir, 'sample.ts'),
    [
      '// ctx.get(\'agents\') — comment must be ignored',
      '/* ctx.get(\'sessions\') */',
      ' * ctx.get(\'subagents\')',
      'const a = ctx.get(\'agents\')',
      'const b = ctx.get(\'loader\') // Cordis process service, not a pattern',
      'const c = ctx.get(\'appExit\')',
      "import type { Agent } from '@deepseek-ai/dsh-agent'",
      'const d = ctx.sessions.list()',
    ].join('\n'),
  )
  const scanned = scanTree(dir)
  assert.deepEqual(scanned, {
    'sample.ts': ['agents', 'import:dsh-agent', 'sessions'],
  })
})

test('scanTree sees OPTIONAL-CHAINED Host access (ctx?.get / ctx?.<service>)', (t) => {
  // A lazily-resolved service is the same Host coupling as a direct read: the
  // Direct Host-file adapter reads its `fileReferences` authority through
  // `this.ctx?.get('fileReferences')`, which the pre-TS8-A matcher silently
  // missed (it required a literal `ctx.get(`).
  const life = testLifecycle(t)
  const dir = life.tempDir('client-boundary-optional-')
  writeFileSync(
    join(dir, 'sample.ts'),
    [
      'const a = this.ctx?.get(\'fileReferences\')',
      'const b = ctx?.sessions.list()',
      'const c = this.ctx?.get(\'loader\') // not a Host pattern',
    ].join('\n'),
  )
  assert.deepEqual(scanTree(dir), {
    'sample.ts': ['fileReferences', 'sessions'],
  })
})

test('findNewDebt reports only pairs missing from the baseline', () => {
  const scanned = { 'a.ts': ['agents', 'sessions'], 'b.ts': ['skills'] }
  const baseline = { 'a.ts': ['agents'] }
  assert.deepEqual(findNewDebt(scanned, baseline), ['a.ts: sessions', 'b.ts: skills'])
  assert.deepEqual(findNewDebt(scanned, scanned), [])
})

test('findStaleBaseline reports removed files and coupling pairs', () => {
  const scanned = { 'a.ts': ['agents'], 'b.ts': ['skills'] }
  const baseline = { 'a.ts': ['agents', 'sessions'], 'removed.ts': ['llm'] }
  assert.deepEqual(findStaleBaseline(scanned, baseline), ['a.ts: sessions', 'removed.ts: file'])
  assert.deepEqual(findStaleBaseline(scanned, scanned), [])
})

test('HOST_SERVICES covers the migration inventory', () => {
  for (const service of [
    'agents',
    'sessions',
    'subagents',
    'jobs',
    'credentials',
    'userQuestions',
    'agentPresets',
    'sessionQuery',
    'sessionPersistence',
    'sessionProjections',
    'sessionProjectionCache',
    'sessionTitle',
    'fileReferences',
    'commands',
    'tools',
    'skills',
    'attachments',
    'llm',
    'settings',
  ]) {
    assert.ok(HOST_SERVICES.includes(service), `missing ${service}`)
  }
})
