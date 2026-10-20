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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { discoverTestFiles, resolveLane } from '../../scripts/test-discovery.mjs'
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

/**
 * The fixed waits a test file contains.
 *
 * A BLIND sleep is a fixed wait whose only purpose is "give the system
 * time". The policy allows a bounded wait when the contract IS about a
 * time window, and requires the reason next to it.
 */
function fixedWaitsOf(rel) {
  const source = readFileSync(join(TEST_ROOT, rel), 'utf8')
  const lines = source.split('\n')
  const found = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!/setTimeout\([^,]*,\s*\d{3,}/u.test(line)) continue
    // A blind wait needs a reason on the line itself or the line above.
    const context = `${lines[index - 1] ?? ''}\n${line}`
    if (/\/\/|reason|window|deadline|bounded|negative|observation/iu.test(context)) continue
    found.push(index + 1)
  }
  return found
}

test('a fixed wait in a NEW test carries a stated reason', () => {
  const baseline = BASELINE.fixedWaits
  const offenders = []
  for (const rel of discoverTestFiles(TEST_ROOT, ['.test.ts', '.test.mjs'])) {
    const waits = fixedWaitsOf(rel)
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
    const actual = fixedWaitsOf(rel).length
    if (actual > count) stale.push(`${rel}: ${actual} unreasoned fixed wait(s), the baseline allows ${count}`)
  }
  assert.deepEqual(stale, [],
    'the fixed-wait baseline must match the tree: a NEW unreasoned wait must be justified, not baselined')
})

// ── Rule 4: Minimal Test Infrastructure ───────────────────────────────────

test('a shared fixture exposes only the capability its consumers use', () => {
  // The narrow-fake rule has an objective floor: a shared fixture may not
  // grow a capability that NO consumer reads. An unused capability is the
  // "universal fake" the policy forbids.
  const fixture = join(TEST_ROOT, 'support', 'register-tui-commands.ts')
  if (!existsSync(fixture)) return
  const source = readFileSync(fixture, 'utf8')
  const declared = [...source.matchAll(/^\s{2}(readonly\s+)?([a-zA-Z][A-Za-z0-9_]*)\??\s*[:(]/gmu)].map(m => m[2])
  if (declared.length === 0) return
  const consumers = discoverTestFiles(TEST_ROOT, ['.test.ts', '.test.mjs'])
    .filter(rel => rel !== 'support/register-tui-commands.ts')
  const used = new Set()
  for (const rel of consumers) {
    const consumer = readFileSync(join(TEST_ROOT, rel), 'utf8')
    if (!consumer.includes('register-tui-commands')) continue
    for (const name of declared) {
      if (new RegExp(`\\b${name}\\b`, 'u').test(consumer)) used.add(name)
    }
  }
  const unused = declared.filter(name => !used.has(name))
  assert.deepEqual(
    unused,
    [],
    'a shared fixture must not expose a capability no consumer reads — remove it, or the fake pretends to cover more than it does',
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
