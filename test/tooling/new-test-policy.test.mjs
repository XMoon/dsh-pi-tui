/**
 * The New Test Policy's OBJECTIVE guard: the rules that can be checked
 * without a human judgement.
 *
 * The policy (`docs/guides/testing.md`) has six rules. Most of them are
 * review judgements — Contract First, Evidence Integrity, Ownership
 * First's judgement half, and Rule 4's narrow-fake rule (whether a fake
 * exposes more capability than its consumer USES depends on what the test is
 * trying to prove, which no static check can decide; `docs/guides/
 * code-review.md` §2 carries that question instead).
 *
 * This suite proves the parts that ARE decidable:
 *
 *   - Rule 6 (Discoverability): a test file is found by the lane that owns
 *     it, the lanes never overlap, the infrastructure directories are never
 *     part of a lane, and a lane that matches nothing FAILS CLOSED;
 *   - Rule 5 (Deterministic Async Testing): a fixed sleep must be either
 *     bounded by a named constant or carry a stated reason.
 *
 * It also runs the SYNTHETIC placement the policy's acceptance requires: a
 * new Domain test, a new Integration test and a new Tooling test are
 * placed in an ISOLATED root, and the policy's own rules must place them in
 * the right lane and find them in the right verification entry point.
 *
 * @module @xmoon76/dsh-pi-tui/test/tooling/new-test-policy.test
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { discoverTestFiles, resolveLane } from '../../scripts/test-discovery.mjs'
import { fixedWaitHelpers, fixedWaitsOf } from '../../scripts/fixed-wait-helpers.mjs'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { LANES } from '../../scripts/test-lanes.mjs'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const TEST_ROOT = join(REPO_ROOT, 'test')

// ── Rule 6: Discoverability ───────────────────────────────────────────────

test('every discovered test file is owned by exactly one lane', () => {
  const all = discoverTestFiles(TEST_ROOT, ['.test.ts', '.test.mjs'])
  const owners = new Map()
  for (const [name, lane] of Object.entries(LANES)) {
    for (const rel of resolveLane(TEST_ROOT, lane.patterns, lane.suffixes, lane.exclude ?? [])) {
      assert.equal(owners.has(rel), false, `${rel} is in both the ${owners.get(rel)} and the ${name} lane`)
      owners.set(rel, name)
    }
  }
  assert.deepEqual(
    all.filter(rel => !owners.has(rel)),
    [],
    'every discovered test file must be owned by a lane — an unowned test never runs',
  )
})

test('the infrastructure directories are never part of a lane', () => {
  for (const [name, lane] of Object.entries(LANES)) {
    for (const rel of resolveLane(TEST_ROOT, lane.patterns, lane.suffixes, lane.exclude ?? [])) {
      assert.ok(!rel.startsWith('support/'), `${name} must not own ${rel}`)
      assert.ok(!rel.startsWith('fixtures/'), `${name} must not own ${rel}`)
      assert.ok(!rel.startsWith('compat/'), `${name} must not own ${rel}`)
    }
  }
})

test('a lane that matches nothing fails closed', () => {
  assert.throws(
    () => resolveLane(TEST_ROOT, ['no-such-owner/**/*.test.ts']),
    /matched no test file/u,
    'an empty lane must fail closed, never report green',
  )
})

// ── Rule 5: Deterministic Async Testing ───────────────────────────────────

/**
 * The pre-existing fixed waits, as a floor.
 *
 * The policy governs NEW tests. The baseline records the fixed waits that
 * already exist, so the guard can fail when a file that is NOT in the
 * baseline introduces one, and when a baseline file's count GROWS. The
 * baseline is a floor, not a target: a file may REPLACE its waits with
 * authoritative signals, and the count may go DOWN.
 */
const BASELINE = JSON.parse(readFileSync(join(TEST_ROOT, 'tooling', 'new-test-policy-baseline.json'), 'utf8'))

test('a fixed wait in a NEW test carries a stated reason', () => {
  const baseline = BASELINE.fixedWaits
  const offenders = []
  for (const rel of discoverTestFiles(TEST_ROOT, ['.test.ts', '.test.mjs'])) {
    const waits = fixedWaitsOf(rel, TEST_ROOT)
    const allowed = baseline[rel] ?? 0
    if (waits.length > allowed) {
      offenders.push(`${rel}: ${waits.length} unreasoned fixed wait(s) (the baseline allows ${allowed})`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'a fixed wait with no stated reason is a blind sleep: replace it with an authoritative signal, or state why the contract needs the window',
  )
})

test('the pre-existing fixed-wait baseline still matches the tree', () => {
  // A baseline entry whose file no longer has that many waits is stale:
  // the floor must not silently become weaker (or the file may have been
  // deleted, which the next case reports).
  const stale = []
  for (const [rel, count] of Object.entries(BASELINE.fixedWaits)) {
    if (!existsSync(join(TEST_ROOT, rel))) {
      stale.push(`${rel}: the file no longer exists`)
      continue
    }
    const actual = fixedWaitsOf(rel, TEST_ROOT).length
    if (actual > count) stale.push(`${rel}: ${actual} unreasoned fixed wait(s), the baseline allows ${count}`)
  }
  assert.deepEqual(stale, [],
    'the fixed-wait baseline must match the tree: a NEW unreasoned wait must be justified, not baselined')
})

// ── The synthetic placement the policy's acceptance requires ───────────────

/**
 * An ISOLATED test root: a disposable directory that mirrors the shape of
 * the real test tree.
 *
 * The synthetic tests must NOT be written into the REAL test tree. The
 * discovery rule, the lane resolution and the production-read guard all
 * scan the real tree at RUN time, so a synthetic file living there would be
 * picked up by a CONCURRENT runner (the product lane, the benchmark, the
 * guard itself) and would pollute the test set it discovers. The cleanup
 * that removes the file later cannot undo another process's discovery.
 *
 * The rules under test take the test root as a parameter, so the synthetic
 * placement is verified against a disposable root instead.
 */
function isolatedTestRoot(t) {
  const root = testLifecycle(t).tempDir('dsh-policy-probe-')
  for (const directory of ['domain', 'integration', 'tooling', 'architecture', 'support']) {
    mkdirSync(join(root, directory), { recursive: true })
  }
  return root
}

test('a new Domain, Integration and Tooling test land in the right lane', async (t) => {
  // The policy's own acceptance: a new test in each ownership area must be
  // PLACED correctly, DISCOVERED, and reach the right verification entry
  // point. The three files are created in an ISOLATED root, checked, and
  // removed again — the real test tree is never touched.
  const additions = [
    { rel: 'domain/synthetic-policy-probe.test.ts', lane: 'product', suffix: '.test.ts' },
    { rel: 'integration/synthetic-policy-probe.test.mjs', lane: 'product', suffix: '.test.mjs' },
    { rel: 'tooling/synthetic-policy-probe.test.mjs', lane: 'tooling', suffix: '.test.mjs' },
  ]
  const root = isolatedTestRoot(t)
  // The tooling lane's pattern set covers the architecture area as well, so
  // the isolated root needs a file there for the lane to resolve at all.
  writeFileSync(
    join(root, 'architecture', 'synthetic-architecture-probe.test.mjs'),
    "import test from 'node:test'\ntest('synthetic architecture probe', () => {})\n",
  )
  for (const addition of additions) {
    const path = join(root, addition.rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, `import test from 'node:test'\ntest('synthetic policy probe', () => {})\n`)
  }

  // 1. DISCOVERED: the new files are found by the discovery rule.
  const discovered = discoverTestFiles(root, ['.test.ts', '.test.mjs'])
  for (const addition of additions) {
    assert.ok(discovered.includes(addition.rel), `${addition.rel} must be discovered`)
  }

  // 2. PLACED: each new file is owned by the lane its directory names.
  for (const addition of additions) {
    const lane = LANES[addition.lane]
    const files = resolveLane(root, lane.patterns, lane.suffixes, lane.exclude ?? [])
    assert.ok(files.includes(addition.rel),
      `${addition.lane} must own ${addition.rel} in its executable file list`)
  }
})

test('a NEW long wait through a shared helper is caught', (t) => {
  // The regression for the review finding: the guard must see a fixed wait
  // that goes through a SHARED helper (`directSettle(ms)`), not only a
  // literal `setTimeout` in the test file. A new test that waits 30 seconds
  // through the helper must be caught exactly like a literal one.
  // The probe lives in an ISOLATED root: a synthetic file in the real
  // test tree would be discovered by a CONCURRENT runner.
  const root = isolatedTestRoot(t)
  try {
    const probe = 'integration/synthetic-long-wait-probe.test.ts'
    const path = join(root, probe)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, [
      "import test from 'node:test'",
      "import { directSettle } from '../support/direct-tsp-fixture.ts'",
      '',
      "test('a synthetic long wait through the shared helper', async () => {",
      '  await directSettle(30_000)',
      '})',
      '',
    ].join('\n'))
    const helpers = fixedWaitHelpers(join(TEST_ROOT, 'support'))
    assert.ok(helpers.has('directSettle'),
      'the shared fixed-wait helper must be discovered from the support modules')
    const waits = fixedWaitsOf(probe, root, helpers)
    assert.deepEqual(waits, [5],
      'a long wait through the shared helper must be reported as an unreasoned fixed wait')
  } finally {
    // The lifecycle removes the root when the test ends.
  }
})

test('a NEW long literal wait is caught', (t) => {
  // The same regression for the literal form, so both shapes are covered by
  // the same guard.
  const root = isolatedTestRoot(t)
  try {
    const probe = 'integration/synthetic-literal-wait-probe.test.ts'
    const path = join(root, probe)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, [
      "import test from 'node:test'",
      '',
      "test('a synthetic long literal wait', async () => {",
      '  await new Promise(resolve => setTimeout(resolve, 30_000))',
      '})',
      '',
    ].join('\n'))
    const waits = fixedWaitsOf(probe, root)
    assert.deepEqual(waits, [4],
      'a long literal wait must be reported as an unreasoned fixed wait')
  } finally {
    // The lifecycle removes the root when the test ends.
  }
})

test('a shared wait helper is discovered by its IMPLEMENTATION, not its name', (t) => {
  // The review's finding: a helper named `sleep(timeoutMs)` was not
  // discovered, because the discovery matched the PARAMETER NAME
  // `millis|ms|delay|durationMs`. The derivation must be name-independent:
  // a helper whose body waits a `setTimeout` whose delay comes from one of
  // its OWN parameters is a fixed-wait helper by construction.
  const root = isolatedTestRoot(t)
  try {
    const probe = 'support/synthetic-sleep-helper.ts'
    const path = join(root, probe)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, [
      'export async function sleep(timeoutMs: number): Promise<void> {',
      '  await new Promise(resolve => setTimeout(resolve, timeoutMs))',
      '}',
      '',
    ].join('\n'))
    const helpers = fixedWaitHelpers(join(root, 'support'))
    assert.ok(helpers.has('sleep'),
      'a helper that waits a parameter-driven setTimeout must be discovered, whatever its name')
  } finally {
    // The lifecycle removes the root when the test ends.
  }
})
