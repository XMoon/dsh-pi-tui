import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOOK = join(ROOT, '.husky', 'pre-push')

// Run the hook the way husky does: `sh -e .husky/pre-push` with refs on
// stdin and env vars.
function runHook(refs, env) {
  const r = spawnSync('sh', ['-e', HOOK], {
    cwd: ROOT,
    input: refs.join('\n') + '\n',
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { code: r.status, out: r.stdout + r.stderr }
}

function nodeStageShim() {
  const directory = mkdtempSync(join(tmpdir(), 'pre-push-node-shim-'))
  const node = join(directory, 'node')
  const marker = join(directory, 'derived-stage-ran')
  writeFileSync(node, `#!/bin/sh
if [ "$1" = "scripts/pre-push-stages.mjs" ]; then
  printf '%s\\n' 'touch ${marker}'
else
  exec ${process.execPath} "$@"
fi
`)
  chmodSync(node, 0o755)
  return { directory, marker }
}

const FEAT = ['refs/heads/feat/x 0000000000000000000000000000000000000000 refs/heads/feat/x 1111111111111111111111111111111111111111']
const MAIN = ['refs/heads/main 0000000000000000000000000000000000000000 refs/heads/main 1111111111111111111111111111111111111111']
const NEXT = ['refs/heads/next 0000000000000000000000000000000000000000 refs/heads/next 1111111111111111111111111111111111111111']
const RELEASE_TAG = ['refs/tags/v-test 0000000000000000000000000000000000000000 refs/tags/v-test 1111111111111111111111111111111111111111']
const NEXT_TAG = ['refs/tags/next-v-test 0000000000000000000000000000000000000000 refs/tags/next-v-test 1111111111111111111111111111111111111111']
const ARBITRARY_TAG = [
  'refs/tags/test-only 0000000000000000000000000000000000000000 refs/tags/test-only 1111111111111111111111111111111111111111',
  'refs/tags/next-debug 0000000000000000000000000000000000000000 refs/tags/next-debug 1111111111111111111111111111111111111111',
]

test('pre-push hook: stage with quotes executes via sh -c with quotes intact (F1)', () => {
  const stage = 'node -e "if (\'a && b\'.indexOf(\'&\') === -1) process.exit(1); console.log(\'quoted-stage-ran\')"'
  const { code, out } = runHook(RELEASE_TAG, { PUSH_GATE_TEST_MODE: '1', PUSH_GATE_STAGES: stage })
  assert.equal(code, 0, out)
  assert.match(out, /quoted-stage-ran/)
})

test('pre-push hook: multi-ref aggregation keeps the strict fork level (F2)', () => {
  // ref1 = a release tag with a base whose range demonstrably touches
  // packages/pi-tui/ (a historical commit that changed the fork), ref2 =
  // same-base clean ref (would reset FORK_CHANGED to 0 under the old
  // overwrite logic — or, after the round-2 fix, must NOT downgrade).
  const head1 = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()
  // 5d80967 is a known commit that touched packages/pi-tui/.
  const forkBase = spawnSync('git', ['rev-parse', '5d80967'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()
  // Sanity: the range must actually contain fork changes, else this test
  // asserts nothing about the strict level.
  const diff = spawnSync('git', ['diff', '--quiet', forkBase, head1, '--', 'packages/pi-tui/'], { cwd: ROOT })
  assert.notEqual(diff.status, 0, 'fixture range must touch packages/pi-tui/')
  const refs = [
    `refs/tags/v-test ${forkBase} refs/tags/v-test ${head1}`,
    `refs/tags/next-v-test ${forkBase} refs/tags/next-v-test ${head1}`,
    ...ARBITRARY_TAG,
    `refs/heads/feat/q ${head1} refs/heads/feat/q ${head1}`,
  ]
  const { code, out } = runHook(refs, { PUSH_GATE_TEST_MODE: '1', PUSH_GATE_STAGES: 'echo m1' })
  assert.equal(code, 0, out)
  // The header must show the FULL chain (verify:prepush), never nofork.
  assert.match(out, /pre-push gate: verify:prepush \(1 stage\)/)
})

test('pre-push hook: next-v release wins a multi-ref push without v* (F2)', () => {
  const { code, out } = runHook([...NEXT_TAG, ...ARBITRARY_TAG, ...FEAT], {
    PUSH_GATE_TEST_MODE: '1',
    PUSH_GATE_STAGES: 'echo next-release-wins',
  })
  assert.equal(code, 0, out)
  assert.match(out, /pre-push gate: verify:prepush \(1 stage\)/)
  assert.match(out, /next-release-wins/)
})

test('pre-push hook: fully clean multi-release-tag push selects the fast chain (F2 nofork reachable)', () => {
  // Both release tags have base == head (no fork changes): the round-2 fix
  // must keep FORK_CHANGED=0 so the fast nofork chain is selected.
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()
  const refs = [
    `refs/tags/v-test-a ${head} refs/tags/v-test-a ${head}`,
    `refs/tags/next-v-test-b ${head} refs/tags/next-v-test-b ${head}`,
  ]
  const { code, out } = runHook(refs, { PUSH_GATE_TEST_MODE: '1', PUSH_GATE_STAGES: 'echo m2' })
  assert.equal(code, 0, out)
  assert.match(out, /pre-push gate: verify:prepush:nofork \(1 stage\)/)
})

test('pre-push hook: feature, main, and next branch pushes skip verification (F3)', () => {
  const { code, out } = runHook([...FEAT, ...MAIN, ...NEXT], {
    PUSH_GATE_TEST_MODE: '1',
    PUSH_GATE_STAGES: 'sh -c "exit 99"',
  })
  assert.equal(code, 0, out)
  assert.match(out, /verification skipped/)
  assert.ok(!out.includes('exit 99'), out)
})

test('pre-push hook: arbitrary tags skip verification (F4)', () => {
  const { code, out } = runHook(ARBITRARY_TAG, { PUSH_GATE_TEST_MODE: '1', PUSH_GATE_STAGES: 'sh -c "exit 99"' })
  assert.equal(code, 0, out)
  assert.match(out, /verification skipped/)
  assert.ok(!out.includes('exit 99'), out)
})

test('pre-push hook: next-v release tags run the full gate (F5)', () => {
  const { code, out } = runHook(NEXT_TAG, { PUSH_GATE_TEST_MODE: '1', PUSH_GATE_STAGES: 'echo next-release-ran' })
  assert.equal(code, 0, out)
  assert.match(out, /pre-push gate: verify:prepush \(1 stage\)/)
  assert.match(out, /next-release-ran/)
})

test('pre-push hook: whitespace-only test override is refused (F5)', () => {
  const { code, out } = runHook(RELEASE_TAG, { PUSH_GATE_TEST_MODE: '1', PUSH_GATE_STAGES: '   ' })
  assert.equal(code, 1)
  assert.match(out, /no runnable stages/)
})

test('pre-push hook: PUSH_GATE_STAGES ignored without PUSH_GATE_TEST_MODE', () => {
  const { code, out } = runHook(FEAT, { PUSH_GATE_STAGES: 'echo fake-stage-should-not-run' })
  // Branch pushes skip the gate entirely, and a stray stage override must
  // never turn that policy into an execution.
  assert.equal(code, 0, out)
  assert.ok(!out.includes('fake-stage-should-not-run'), out)
  assert.match(out, /verification skipped/)
})

test('pre-push hook: non-test stage override cannot replace a release gate', () => {
  const shim = nodeStageShim()
  try {
    const { code, out } = runHook(RELEASE_TAG, {
      PATH: `${shim.directory}:${process.env.PATH}`,
      PUSH_GATE_TEST_MODE: '0',
      PUSH_GATE_STAGES: 'echo fake-stage-should-not-run',
    })
    assert.equal(code, 0, out)
    assert.match(out, /pre-push gate: verify:prepush \(1 stage\)/)
    assert.ok(existsSync(shim.marker), 'the derived stage must execute')
    assert.ok(!out.includes('fake-stage-should-not-run'), out)
  } finally {
    rmSync(shim.directory, { recursive: true, force: true })
  }
})

test('pre-push hook: non-test stage override cannot replace the clean release gate', () => {
  const shim = nodeStageShim()
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()
  try {
    const { code, out } = runHook([
      `refs/tags/v-clean ${head} refs/tags/v-clean ${head}`,
    ], {
      PATH: `${shim.directory}:${process.env.PATH}`,
      PUSH_GATE_TEST_MODE: '0',
      PUSH_GATE_STAGES: 'echo fake-stage-should-not-run',
    })
    assert.equal(code, 0, out)
    assert.match(out, /pre-push gate: verify:prepush:nofork \(1 stage\)/)
    assert.ok(existsSync(shim.marker), 'the derived stage must execute')
    assert.ok(!out.includes('fake-stage-should-not-run'), out)
  } finally {
    rmSync(shim.directory, { recursive: true, force: true })
  }
})

test('pre-push hook: failing stage reports and exits 1', () => {
  const { code, out } = runHook(RELEASE_TAG, {
    PUSH_GATE_TEST_MODE: '1',
    PUSH_GATE_STAGES: 'echo good\nsh -c "echo boom; exit 7"',
  })
  assert.equal(code, 1)
  assert.match(out, /failed stage: sh -c/)
  assert.match(out, /exit 7/)
})

test('pre-push hook: quiet mode prints only the summary line', () => {
  const { code, out } = runHook(RELEASE_TAG, { PUSH_GATE_QUIET: '1', PUSH_GATE_TEST_MODE: '1', PUSH_GATE_STAGES: 'echo q' })
  assert.equal(code, 0, out)
  const lines = out.trim().split('\n')
  assert.equal(lines.length, 1, out)
  assert.match(lines[0], /pre-push verification passed/)
})