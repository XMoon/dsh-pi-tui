import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STAGES_SCRIPT = join(ROOT, 'scripts', 'pre-push-stages.mjs')

// The splitter resolves ROOT = dirname(itself)/.. so it reads package.json
// from the repository root. For isolated fixtures we copy it into a temp
// dir whose parent acts as the "repo root": fixtureRoot/scripts/... ->
// ROOT = fixtureRoot, package.json at fixtureRoot/package.json.
function withFixture(scripts, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pps-'))
  const fixtureRoot = join(dir, 'root')
  mkdirSync(join(fixtureRoot, 'scripts'), { recursive: true })
  copyFileSync(STAGES_SCRIPT, join(fixtureRoot, 'scripts', 'pre-push-stages.mjs'))
  writeFileSync(join(fixtureRoot, 'package.json'), JSON.stringify({ scripts }, null, 2) + '\n')
  try {
    return fn(fixtureRoot)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function runSplitter(fixtureRoot, name) {
  const r = spawnSync(process.execPath, [join(fixtureRoot, 'scripts', 'pre-push-stages.mjs'), name], {
    cwd: fixtureRoot,
    encoding: 'utf8',
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

test('pre-push-stages: splits top-level && into ordered stages', () => {
  withFixture({ 'verify:x': 'a && b && c' }, (root) => {
    const { code, out } = runSplitter(root, 'verify:x')
    assert.equal(code, 0)
    assert.equal(out.trim(), 'a\nb\nc')
  })
})

test('pre-push-stages: && inside double quotes is not a separator', () => {
  withFixture({ 'verify:x': 'echo hi && node -e "console.log(\'a && b\')" && echo bye' }, (root) => {
    const { code, out } = runSplitter(root, 'verify:x')
    assert.equal(code, 0)
    const stages = out.trim().split('\n')
    assert.equal(stages.length, 3)
    assert.ok(stages[1].includes("console.log('a && b')"), `stage intact: ${stages[1]}`)
  })
})

test('pre-push-stages: && inside single quotes is not a separator', () => {
  withFixture({ 'verify:x': "echo 'x && y' && echo z" }, (root) => {
    const { code, out } = runSplitter(root, 'verify:x')
    assert.equal(code, 0)
    assert.equal(out.trim(), "echo 'x && y'\necho z")
  })
})

test('pre-push-stages: escaped && outside quotes is not a separator', () => {
  withFixture({ 'verify:x': 'echo a\\&&b && echo after' }, (root) => {
    const { code, out } = runSplitter(root, 'verify:x')
    assert.equal(code, 0)
    const stages = out.trim().split('\n')
    assert.equal(stages.length, 2)
    assert.equal(stages[0], 'echo a\\&&b')
  })
})

test('pre-push-stages: unterminated quote is rejected', () => {
  withFixture({ 'verify:x': 'echo "oops' }, (root) => {
    const { code, err } = runSplitter(root, 'verify:x')
    assert.equal(code, 1)
    assert.match(err, /unterminated/i)
  })
})

test('pre-push-stages: dangling && is rejected', () => {
  withFixture({ 'verify:x': 'echo ok &&' }, (root) => {
    const { code, err } = runSplitter(root, 'verify:x')
    assert.equal(code, 1)
    assert.match(err, /dangling/i)
  })
})

test('pre-push-stages: empty script is rejected', () => {
  withFixture({ 'verify:x': '' }, (root) => {
    const { code, err } = runSplitter(root, 'verify:x')
    assert.equal(code, 1)
    assert.match(err, /no non-empty/i)
  })
})

test('pre-push-stages: missing verify: prefix is rejected', () => {
  withFixture({ 'verify:x': 'echo ok' }, (root) => {
    const { code, err } = runSplitter(root, 'typecheck')
    assert.equal(code, 1)
    assert.match(err, /usage/i)
  })
})

test('pre-push-stages: current verify:prepush derives to the expected 8 stages', () => {
  const r = spawnSync(process.execPath, [STAGES_SCRIPT, 'verify:prepush'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0)
  const stages = r.stdout.trim().split('\n')
  assert.equal(stages.length, 8)
  assert.deepEqual(stages, [
    'pnpm typecheck:fork',
    'pnpm test:fork',
    'pnpm test:docs',
    'node scripts/naming-gate.mjs',
    'pnpm gate:boundary',
    'pnpm gate:keybindings',
    'pnpm audit --prod --audit-level high',
    'pnpm pack:release',
  ])
})

test('pre-push-stages: current verify:prepush:nofork derives to 6 stages', () => {
  const r = spawnSync(process.execPath, [STAGES_SCRIPT, 'verify:prepush:nofork'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0)
  const stages = r.stdout.trim().split('\n')
  assert.equal(stages.length, 6)
  assert.deepEqual(stages, [
    'pnpm test:docs',
    'node scripts/naming-gate.mjs',
    'pnpm gate:boundary',
    'pnpm gate:keybindings',
    'pnpm audit --prod --audit-level high',
    'pnpm pack:release',
  ])
})