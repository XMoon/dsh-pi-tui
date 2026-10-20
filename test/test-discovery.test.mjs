/**
 * The test DISCOVERY rule: a synthetic tree proves that a lane finds the
 * root level AND the nested levels, never finds the infrastructure
 * directories, never discovers a file twice, and fails CLOSED when it
 * matches nothing.
 *
 * The synthetic tree is the plan's own example:
 *
 *   test/root.test.ts
 *   test/app/session/a.test.ts
 *   test/tui/b.test.ts
 *   test/fixtures/data.ts
 *   test/support/helper.ts
 *
 * @module @xmoon76/dsh-pi-tui/test/test-discovery.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  discoverTestFiles,
  isInfrastructurePath,
  matchesPattern,
  resolveLane,
} from '../scripts/test-discovery.mjs'
import { testLifecycle } from './support/temp-lifecycle.ts'

/** Build the synthetic discovery tree and return its root. */
function syntheticTree(life) {
  const root = join(life.tempDir('dsh-test-discovery-'), 'test')
  mkdirSync(join(root, 'app', 'session'), { recursive: true })
  mkdirSync(join(root, 'tui'), { recursive: true })
  mkdirSync(join(root, 'fixtures'), { recursive: true })
  mkdirSync(join(root, 'support'), { recursive: true })
  writeFileSync(join(root, 'root.test.ts'), '')
  writeFileSync(join(root, 'app', 'session', 'a.test.ts'), '')
  writeFileSync(join(root, 'tui', 'b.test.ts'), '')
  writeFileSync(join(root, 'fixtures', 'data.ts'), '')
  writeFileSync(join(root, 'support', 'helper.ts'), '')
  return root
}

test('discovery finds the root level and every nested level', (t) => {
  const life = testLifecycle(t)
  const root = syntheticTree(life)
  assert.deepEqual(
    discoverTestFiles(root, ['.test.ts']),
    ['app/session/a.test.ts', 'root.test.ts', 'tui/b.test.ts'],
    'the discovery must reach the root level AND the nested levels',
  )
})

test('discovery never treats the infrastructure directories as test files', (t) => {
  const life = testLifecycle(t)
  const root = syntheticTree(life)
  const found = discoverTestFiles(root, ['.test.ts', '.test.mjs'])
  assert.ok(!found.some(rel => rel.startsWith('support/')), 'support/ is infrastructure')
  assert.ok(!found.some(rel => rel.startsWith('fixtures/')), 'fixtures/ is infrastructure')
  assert.ok(!found.some(rel => rel.includes('/support/')), 'a nested support/ is infrastructure too')
  // The exclusion is by DIRECTORY, not by filename: a file NAMED like a test
  // inside an infrastructure directory is still infrastructure.
  writeFileSync(join(root, 'support', 'looks-like-a-test.test.ts'), '')
  writeFileSync(join(root, 'fixtures', 'also-looks-like-a-test.test.ts'), '')
  const after = discoverTestFiles(root, ['.test.ts', '.test.mjs'])
  assert.deepEqual(after, ['app/session/a.test.ts', 'root.test.ts', 'tui/b.test.ts'],
    'a test-named file inside an infrastructure directory must not be discovered')
})

test('discovery never returns the same file twice', (t) => {
  const life = testLifecycle(t)
  const root = syntheticTree(life)
  // Two OVERLAPPING patterns must not produce two entries for one file.
  const lane = resolveLane(root, ['**/*.test.ts', 'root.test.ts'])
  assert.deepEqual(lane, ['app/session/a.test.ts', 'root.test.ts', 'tui/b.test.ts'])
  assert.equal(new Set(lane).size, lane.length, 'the lane must not contain a duplicate')
})

test('an empty lane fails closed instead of reporting green', (t) => {
  const life = testLifecycle(t)
  const root = syntheticTree(life)
  assert.throws(
    () => resolveLane(root, ['**/*.test.tsx']),
    /matched no test file/u,
    'a pattern that matches nothing must fail closed',
  )
  assert.throws(
    () => resolveLane(root, []),
    /discovered no test file/u,
    'a lane with no pattern must fail closed',
  )
})

test('the lane membership is deterministic and independent of the filesystem order', (t) => {
  const life = testLifecycle(t)
  const root = syntheticTree(life)
  const first = resolveLane(root, ['**/*.test.ts'])
  const second = resolveLane(root, ['**/*.test.ts'])
  assert.deepEqual(first, second, 'the same tree must resolve to the same ordered list')
  assert.deepEqual(first, [...first].sort(), 'the lane list must be sorted')
})

test('the discovered paths are POSIX-style, so a membership comparison is platform-independent', (t) => {
  const life = testLifecycle(t)
  const root = syntheticTree(life)
  for (const rel of discoverTestFiles(root, ['.test.ts'])) {
    assert.ok(!rel.includes('\\'), `the discovered path must use POSIX separators: ${rel}`)
  }
})

test('a lane pattern selects exactly its own ownership area', (t) => {
  const life = testLifecycle(t)
  const root = syntheticTree(life)
  assert.deepEqual(
    resolveLane(root, ['tui/*.test.ts']),
    ['tui/b.test.ts'],
    'a lane pattern must address exactly its own area',
  )
  assert.deepEqual(
    resolveLane(root, ['app/**/*.test.ts']),
    ['app/session/a.test.ts'],
    'an ownership area must be addressable at any depth',
  )
  assert.deepEqual(
    resolveLane(root, ['root.test.ts']),
    ['root.test.ts'],
    'an exact path must select exactly that file',
  )
})

test('the pattern language matches one segment with * and any depth with **', () => {
  assert.equal(matchesPattern('tui/b.test.ts', 'tui/*.test.ts'), true)
  assert.equal(matchesPattern('tui/deep/b.test.ts', 'tui/*.test.ts'), false,
    '* must not cross a path separator')
  assert.equal(matchesPattern('tui/deep/b.test.ts', 'tui/**/*.test.ts'), true)
  assert.equal(matchesPattern('root.test.ts', '**/*.test.ts'), true,
    '** must also match the root level')
  assert.equal(matchesPattern('app/session/a.test.ts', '**/*.test.ts'), true)
  assert.equal(matchesPattern('app/session/a.test.mjs', '**/*.test.ts'), false)
  assert.equal(matchesPattern('app/session/a.test.ts', 'app/session/a.test.ts'), true)
  assert.equal(matchesPattern('app/session/a.test.ts', 'app/session/b.test.ts'), false)
})

test('the infrastructure-path rule is by directory segment', () => {
  assert.equal(isInfrastructurePath('support/helper.ts'), true)
  assert.equal(isInfrastructurePath('fixtures/data.ts'), true)
  assert.equal(isInfrastructurePath('tui/support/helper.ts'), true)
  assert.equal(isInfrastructurePath('supporting/helper.ts'), false,
    'a directory that merely starts with "support" is not infrastructure')
  assert.equal(isInfrastructurePath('app/supporting/helper.ts'), false)
  assert.equal(isInfrastructurePath('tui/b.test.ts'), false)
})

test('the REAL repository tree is discovered without loss or duplication', (t) => {
  const life = testLifecycle(t)
  // The real tree: the discovery rule must find every test file that the
  // current flat glob finds, PLUS any nested file — and never twice.
  const real = discoverTestFiles(join(process.cwd(), 'test'), ['.test.ts', '.test.mjs'])
  assert.ok(real.length > 0, 'the real repository must have discovered test files')
  assert.equal(new Set(real).size, real.length, 'the real discovery must not contain a duplicate')
  assert.ok(!real.some(rel => rel.startsWith('support/')), 'the real support/ must be excluded')
  assert.ok(!real.some(rel => rel.startsWith('fixtures/')), 'the real fixtures/ must be excluded')
})
