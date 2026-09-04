import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { testLifecycle } from './support/temp-lifecycle.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STAGES_SCRIPT = join(ROOT, 'scripts', 'pre-push-stages.mjs')

// The splitter resolves ROOT = dirname(itself)/.. so it reads package.json
// from the repository root. For isolated fixtures we copy it into a temp
// dir whose parent acts as the "repo root": fixtureRoot/scripts/... ->
// ROOT = fixtureRoot, package.json at fixtureRoot/package.json.
function withFixture(life, scripts, fn) {
  const dir = life.tempDir('pps-')
  const fixtureRoot = join(dir, 'root')
  mkdirSync(join(fixtureRoot, 'scripts'), { recursive: true })
  copyFileSync(STAGES_SCRIPT, join(fixtureRoot, 'scripts', 'pre-push-stages.mjs'))
  writeFileSync(join(fixtureRoot, 'package.json'), JSON.stringify({ scripts }, null, 2) + '\n')
  return fn(fixtureRoot)
}

function runSplitter(fixtureRoot, name) {
  const r = spawnSync(process.execPath, [join(fixtureRoot, 'scripts', 'pre-push-stages.mjs'), name], {
    cwd: fixtureRoot,
    encoding: 'utf8',
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

test('pre-push-stages: splits top-level && into ordered stages', (t) => {
  const life = testLifecycle(t)
  withFixture(life, { 'verify:x': 'a && b && c' }, (root) => {
    const { code, out } = runSplitter(root, 'verify:x')
    assert.equal(code, 0)
    assert.equal(out.trim(), 'a\nb\nc')
  })
})

test('pre-push-stages: && inside double quotes is not a separator', (t) => {
  const life = testLifecycle(t)
  withFixture(life, { 'verify:x': 'echo hi && node -e "console.log(\'a && b\')" && echo bye' }, (root) => {
    const { code, out } = runSplitter(root, 'verify:x')
    assert.equal(code, 0)
    const stages = out.trim().split('\n')
    assert.equal(stages.length, 3)
    assert.ok(stages[1].includes("console.log('a && b')"), `stage intact: ${stages[1]}`)
  })
})

test('pre-push-stages: && inside single quotes is not a separator', (t) => {
  const life = testLifecycle(t)
  withFixture(life, { 'verify:x': "echo 'x && y' && echo z" }, (root) => {
    const { code, out } = runSplitter(root, 'verify:x')
    assert.equal(code, 0)
    assert.equal(out.trim(), "echo 'x && y'\necho z")
  })
})

test('pre-push-stages: escaped && outside quotes is not a separator', (t) => {
  const life = testLifecycle(t)
  withFixture(life, { 'verify:x': 'echo a\\&&b && echo after' }, (root) => {
    const { code, out } = runSplitter(root, 'verify:x')
    assert.equal(code, 0)
    const stages = out.trim().split('\n')
    assert.equal(stages.length, 2)
    assert.equal(stages[0], 'echo a\\&&b')
  })
})

test('pre-push-stages: unterminated quote is rejected', (t) => {
  const life = testLifecycle(t)
  withFixture(life, { 'verify:x': 'echo "oops' }, (root) => {
    const { code, err } = runSplitter(root, 'verify:x')
    assert.equal(code, 1)
    assert.match(err, /unterminated/i)
  })
})

test('pre-push-stages: dangling && is rejected', (t) => {
  const life = testLifecycle(t)
  withFixture(life, { 'verify:x': 'echo ok &&' }, (root) => {
    const { code, err } = runSplitter(root, 'verify:x')
    assert.equal(code, 1)
    assert.match(err, /dangling/i)
  })
})

test('pre-push-stages: empty script is rejected', (t) => {
  const life = testLifecycle(t)
  withFixture(life, { 'verify:x': '' }, (root) => {
    const { code, err } = runSplitter(root, 'verify:x')
    assert.equal(code, 1)
    assert.match(err, /no non-empty/i)
  })
})

test('pre-push-stages: missing verify: prefix is rejected', (t) => {
  const life = testLifecycle(t)
  withFixture(life, { 'verify:x': 'echo ok' }, (root) => {
    const { code, err } = runSplitter(root, 'typecheck')
    assert.equal(code, 1)
    assert.match(err, /usage/i)
  })
})

test('pre-push-stages: current verify:prepush derives to the expected 14 stages', () => {
  const r = spawnSync(process.execPath, [STAGES_SCRIPT, 'verify:prepush'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0)
  const stages = r.stdout.trim().split('\n')
  assert.equal(stages.length, 14)
  assert.deepEqual(stages, [
    'pnpm typecheck:fork',
    'pnpm test:fork',
    'pnpm test:docs',
    'pnpm test:tooling',
    'pnpm gate:installation-doc',
    'pnpm gate:pi-divergence-ledger',
    'pnpm gate:pi-vendor-diff --strict',
    'node scripts/naming-gate.mjs',
    'pnpm gate:temp-hygiene',
    'node scripts/check-no-session-events.mjs',
    'pnpm gate:boundary',
    'pnpm gate:keybindings',
    'pnpm audit --prod --audit-level high',
    'pnpm pack:release',
  ])
})

test('pre-push-stages: current verify:prepush:nofork derives to 12 stages', () => {
  const r = spawnSync(process.execPath, [STAGES_SCRIPT, 'verify:prepush:nofork'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0)
  const stages = r.stdout.trim().split('\n')
  assert.equal(stages.length, 12)
  assert.deepEqual(stages, [
    'pnpm test:docs',
    'pnpm test:tooling',
    'pnpm gate:installation-doc',
    'pnpm gate:pi-divergence-ledger',
    'pnpm gate:pi-vendor-diff --strict',
    'node scripts/naming-gate.mjs',
    'pnpm gate:temp-hygiene',
    'node scripts/check-no-session-events.mjs',
    'pnpm gate:boundary',
    'pnpm gate:keybindings',
    'pnpm audit --prod --audit-level high',
    'pnpm pack:release',
  ])
})