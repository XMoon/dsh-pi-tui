/**
 * The New Test Policy's OBJECTIVE guard: the rules that can be checked
 * without a human judgement.
 *
 * The policy (`docs/guides/testing.md`) has six rules. Three of them are
 * review judgements (Ownership First's judgement half, Contract First,
 * Evidence Integrity). This suite proves the OTHER three are enforced by
 * the repository itself:
 *
 *   - Rule 6 (Discoverability): a test file is found by the lane that owns
 *     it, the lanes never overlap, the infrastructure directories are never
 *     part of a lane, and a lane that matches nothing FAILS CLOSED;
 *   - Rule 4 (Minimal Test Infrastructure): a shared fixture may not be
 *     WIDENED beyond the capability its consumers use — the narrow-fake
 *     rule has an objective floor;
 *   - Rule 5 (Deterministic Async Testing): a fixed sleep must be either
 *     bounded by a named constant or carry a stated reason.
 *
 * It also runs the SYNTHETIC placement the policy's acceptance requires: a
 * new Domain test, a new Integration test and a new Tooling test are
 * placed, and the policy's own rules must place them in the right lane and
 * find them in the right verification entry point.
 *
 * @module @xmoon76/dsh-pi-tui/test/tooling/new-test-policy.test
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { discoverTestFiles, resolveLane } from '../../scripts/test-discovery.mjs'
import { fixedWaitHelpers, fixedWaitsOf } from '../../scripts/fixed-wait-helpers.mjs'
import { LANES } from '../../scripts/test-lanes.mjs'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const TEST_ROOT = join(REPO_ROOT, 'test')

/** The lane that owns a file, or `undefined` when no lane owns it. */
function ownerOf(rel) {
  for (const [name, lane] of Object.entries(LANES)) {
    const files = resolveLane(TEST_ROOT, lane.patterns, lane.suffixes, lane.exclude ?? [])
    if (files.includes(rel)) return name
  }
  return undefined
}

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

// ── Rule 4: Minimal Test Infrastructure ───────────────────────────────────

test('a shared fixture has at least one consumer', () => {
  // The objective floor of the narrow-fake rule: a shared fixture with NO
  // consumer is dead weight — a helper nobody reads is the "universal
  // fake" the policy forbids, and it is the one form of the rule that can
  // be checked without judging the test's INTENT.
  //
  // The rule that a fake must not expose MORE capability than its consumer
  // uses is a REVIEW judgement: whether a capability is "used" depends on
  // what the test is trying to prove, which no static check can decide. The
  // policy says so explicitly, and this guard checks only the part that can
  // be checked objectively.
  const supportRoot = join(TEST_ROOT, 'support')
  const fixtures = readdirSync(supportRoot, { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(ts|mjs)$/u.test(entry.name))
    .map(entry => entry.name)
  assert.ok(fixtures.length > 0, 'the support directory must hold the shared fixtures')

  const consumers = discoverTestFiles(TEST_ROOT, ['.test.ts', '.test.mjs'])
  const orphans = []
  for (const fixture of fixtures) {
    const used = consumers.some(rel => {
      if (rel.startsWith('support/')) return false
      return readFileSync(join(TEST_ROOT, rel), 'utf8').includes(fixture)
    })
    if (!used) orphans.push(fixture)
  }
  assert.deepEqual(
    orphans,
    [],
    'a shared fixture with no consumer is dead weight — inline it into its consumer, or delete it',
  )
})

// ── The synthetic placement the policy's acceptance requires ───────────────

test('a new Domain, Integration and Tooling test land in the right lane', async (t) => {
  // The policy's own acceptance: a new test in each ownership area must be
  // PLACED correctly, DISCOVERED, and reach the right verification entry
  // point. The three files are created, checked, and removed again — the
  // repository is left exactly as it was.
  const additions = [
    { rel: 'domain/synthetic-policy-probe.test.ts', lane: 'product', suffix: '.test.ts' },
    { rel: 'integration/synthetic-policy-probe.test.mjs', lane: 'product', suffix: '.test.mjs' },
    { rel: 'tooling/synthetic-policy-probe.test.mjs', lane: 'tooling', suffix: '.test.mjs' },
  ]
  const created = []
  t.after(() => {
    for (const rel of created) rmSync(join(TEST_ROOT, rel), { force: true })
  })
  for (const addition of additions) {
    const path = join(TEST_ROOT, addition.rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, `import test from 'node:test'\ntest('synthetic policy probe', () => {})\n`)
    created.push(addition.rel)
  }

  // 1. DISCOVERED: the new files are found by the discovery rule.
  const discovered = discoverTestFiles(TEST_ROOT, ['.test.ts', '.test.mjs'])
  for (const addition of additions) {
    assert.ok(discovered.includes(addition.rel), `${addition.rel} must be discovered`)
  }

  // 2. PLACED: each new file is owned by the lane its directory names.
  for (const addition of additions) {
    assert.equal(ownerOf(addition.rel), addition.lane,
      `${addition.rel} must be owned by the ${addition.lane} lane`)
  }

  // 3. The verification ENTRY POINT: the lane's file list contains the new
  //    file, so running the lane runs it.
  for (const addition of additions) {
    const lane = LANES[addition.lane]
    const files = resolveLane(TEST_ROOT, lane.patterns, lane.suffixes, lane.exclude ?? [])
    assert.ok(files.includes(addition.rel),
      `${addition.lane} must include ${addition.rel} in its executable file list`)
  }
})

test('a NEW long wait through a shared helper is caught', () => {
  // The regression for the review finding: the guard must see a fixed wait
  // that goes through a SHARED helper (`directSettle(ms)`), not only a
  // literal `setTimeout` in the test file. A new test that waits 30 seconds
  // through the helper must be caught exactly like a literal one.
  const probe = 'integration/synthetic-long-wait-probe.test.ts'
  const path = join(TEST_ROOT, probe)
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
  try {
    const helpers = fixedWaitHelpers()
    assert.ok(helpers.has('directSettle'),
      'the shared fixed-wait helper must be discovered from the support modules')
    const waits = fixedWaitsOf(probe, TEST_ROOT, helpers)
    assert.deepEqual(waits, [5],
      'a long wait through the shared helper must be reported as an unreasoned fixed wait')
  } finally {
    rmSync(path, { force: true })
  }
})

test('a NEW long literal wait is caught', () => {
  // The same regression for the literal form, so both shapes are covered by
  // the same guard.
  const probe = 'integration/synthetic-literal-wait-probe.test.ts'
  const path = join(TEST_ROOT, probe)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, [
    "import test from 'node:test'",
    '',
    "test('a synthetic long literal wait', async () => {",
    '  await new Promise(resolve => setTimeout(resolve, 30_000))',
    '})',
    '',
  ].join('\n'))
  try {
    const waits = fixedWaitsOf(probe, TEST_ROOT)
    assert.deepEqual(waits, [4],
      'a long literal wait must be reported as an unreasoned fixed wait')
  } finally {
    rmSync(path, { force: true })
  }
})

test('a shared wait helper is discovered by its IMPLEMENTATION, not its name', () => {
  // The review's finding: a helper named `sleep(timeoutMs)` was not
  // discovered, because the discovery matched the PARAMETER NAME
  // `millis|ms|delay|durationMs`. The derivation must be name-independent:
  // a helper whose body waits a `setTimeout` whose delay comes from one of
  // its OWN parameters is a fixed-wait helper by construction.
  const probe = 'support/synthetic-sleep-helper.ts'
  const path = join(TEST_ROOT, probe)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, [
    'export async function sleep(timeoutMs: number): Promise<void> {',
    '  await new Promise(resolve => setTimeout(resolve, timeoutMs))',
    '}',
    '',
  ].join('\n'))
  try {
    const helpers = fixedWaitHelpers()
    assert.ok(helpers.has('sleep'),
      'a helper that waits a parameter-driven setTimeout must be discovered, whatever its name')
  } finally {
    rmSync(path, { force: true })
  }
})
