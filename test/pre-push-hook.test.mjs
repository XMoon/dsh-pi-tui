import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
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

const FEAT = ['refs/heads/feat/x 0000000000000000000000000000000000000000 refs/heads/feat/x 1111111111111111111111111111111111111111']

// Create a temp script and return a { path, cleanup } handle so callers
// can remove the temp dir when the test ends (no /tmp leaks across runs).
function tmpScript(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'hook-'))
  const p = join(dir, 'stage.sh')
  writeFileSync(p, contents)
  chmodSync(p, 0o755)
  return { path: p, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('pre-push hook: stage with quotes executes via sh -c with quotes intact (F1)', () => {
  const stage = 'node -e "if (\'a && b\'.indexOf(\'&\') === -1) process.exit(1); console.log(\'quoted-stage-ran\')"'
  const { code, out } = runHook(FEAT, { PUSH_GATE_TEST_MODE: '1', PUSH_GATE_STAGES: stage })
  assert.equal(code, 0, out)
  assert.match(out, /quoted-stage-ran/)
})

test('pre-push hook: multi-ref aggregation keeps the strict fork level (F2)', () => {
  // ref1 = main with a base whose range demonstrably touches
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
    `refs/heads/main ${forkBase} refs/heads/main ${head1}`,
    `refs/heads/feat/q ${head1} refs/heads/feat/q ${head1}`,
  ]
  const { code, out } = runHook(refs, { PUSH_GATE_TEST_MODE: '1', PUSH_GATE_STAGES: 'echo m1' })
  assert.equal(code, 0, out)
  // The header must show the FULL chain (verify:prepush), never nofork.
  assert.match(out, /pre-push gate: verify:prepush \(1 stage\)/)
})

test('pre-push hook: fully clean multi-ref push selects the fast chain (F2 nofork reachable)', () => {
  // Both refs have base == head (no fork changes): the round-2 fix must
  // keep FORK_CHANGED=0 so the fast chain is selected (feat branch →
  // typecheck:bundle... but feat with no fork changes → typecheck:bundle
  // single stage header shows "typecheck:bundle").
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()
  const refs = [
    `refs/heads/feat/q ${head} refs/heads/feat/q ${head}`,
    `refs/heads/feat/r ${head} refs/heads/feat/r ${head}`,
  ]
  const { code, out } = runHook(refs, { PUSH_GATE_TEST_MODE: '1', PUSH_GATE_STAGES: 'echo m2' })
  assert.equal(code, 0, out)
  assert.match(out, /pre-push gate: typecheck:bundle \(1 stage\)/)
})

test('pre-push hook: whitespace-only test override is refused (F5)', () => {
  const { code, out } = runHook(FEAT, { PUSH_GATE_TEST_MODE: '1', PUSH_GATE_STAGES: '   ' })
  assert.equal(code, 1)
  assert.match(out, /no runnable stages/)
})

test('pre-push hook: final drain emits the last line exactly once (F3)', () => {
  const stage = tmpScript('#!/bin/sh\necho "final-line-XYZ"\n')
  try {
    const { code, out } = runHook(FEAT, { PUSH_GATE_VERBOSE: '1', PUSH_GATE_TEST_MODE: '1', PUSH_GATE_STAGES: stage.path })
    assert.equal(code, 0, out)
    const count = (out.match(/final-line-XYZ/g) ?? []).length
    assert.equal(count, 1, `final line must appear exactly once, got ${count}:\n${out}`)
  } finally {
    stage.cleanup()
  }
})

test('pre-push hook: PUSH_GATE_STAGES ignored without PUSH_GATE_TEST_MODE', () => {
  const { code, out } = runHook(FEAT, { PUSH_GATE_STAGES: 'echo fake-stage-should-not-run' })
  // Without test mode the real gate derives (typecheck here — feat branch,
  // fork changed → single `pnpm typecheck` stage). Assert the fake stage
  // never ran and the real stage name appears.
  assert.equal(code, 0, out)
  assert.ok(!out.includes('fake-stage-should-not-run'), out)
  assert.match(out, /typecheck/)
})

test('pre-push hook: failing stage reports and exits 1', () => {
  const { code, out } = runHook(FEAT, {
    PUSH_GATE_TEST_MODE: '1',
    PUSH_GATE_STAGES: 'echo good\nsh -c "echo boom; exit 7"',
  })
  assert.equal(code, 1)
  assert.match(out, /failed stage: sh -c/)
  assert.match(out, /exit 7/)
})

test('pre-push hook: quiet mode prints only the summary line', () => {
  const { code, out } = runHook(FEAT, { PUSH_GATE_QUIET: '1', PUSH_GATE_TEST_MODE: '1', PUSH_GATE_STAGES: 'echo q' })
  assert.equal(code, 0, out)
  const lines = out.trim().split('\n')
  assert.equal(lines.length, 1, out)
  assert.match(lines[0], /pre-push verification passed/)
})