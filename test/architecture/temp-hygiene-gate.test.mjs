/**
 * Unit tests for the temp-hygiene gate: the mkdtemp* tokens are forbidden
 * in root test files (a text scan — no aliasing, scoping, or computed
 * access can evade a token check), while the whitelisted files stay
 * allowed. Comments and strings mentioning the tokens are flagged too:
 * that is the documented cost of the syntactic check.
 * @module @xmoon76/dsh-pi-tui/temp-hygiene-gate.test
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { ALLOWED_DIRECT_USAGE, ambiguousAllowlistEntries, collectTestFiles, scanSource, scanTree } from '../../scripts/temp-hygiene-gate.mjs'

// The WHOLE test tree, not this file's own directory: a violation in
// `test/app/`, `test/tui/` or `test/tooling/` is a violation too, and
// this test is the repository-level guard for them.
const TEST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(TEST_ROOT, '..')

test('a plain test file calling mkdtempSync directly is a violation', () => {
  const violations = scanSource(
    'test/example.test.ts',
    `import { mkdtempSync } from 'node:fs'\nconst root = mkdtempSync(join(tmpdir(), 'dsh-x-'))\n`,
  )
  assert.equal(violations.length, 2)
  assert.equal(violations[0].file, 'test/example.test.ts')
  assert.equal(violations[0].line, 1)
  assert.equal(violations[0].api, 'mkdtempSync')
  assert.equal(violations[1].line, 2)
})

test('the async mkdtemp form is a violation too', () => {
  const violations = scanSource(
    'test/async.test.ts',
    `import * as fs from 'node:fs/promises'\nconst dir = await fs.promises.mkdtemp('/tmp/x-')\n`,
  )
  assert.equal(violations.length, 1)
  assert.equal(violations[0].api, 'mkdtemp')
  assert.equal(violations[0].line, 2)
})

test('a file without the tokens is clean', () => {
  const source = [
    `import { testLifecycle } from '../support/temp-lifecycle.ts'`,
    `test('x', (t) => {`,
    `  const life = testLifecycle(t)`,
    `  const dir = life.tempDir('dsh-x-')`,
    `})`,
  ].join('\n')
  assert.deepEqual(scanSource('test/clean.test.ts', source), [])
})

test('comments and strings mentioning the tokens are flagged (documented text-scan behavior)', () => {
  const source = [
    '// legacy: mkdtempSync(join(tmpdir(), "dsh-old-"))',
    'const doc = "replace mkdtempSync(...) with the lifecycle helper"',
  ].join('\n')
  const violations = scanSource('test/comment.test.ts', source)
  assert.equal(violations.length, 2, 'the text scan flags every token occurrence, including comments')
})

test('scanTree walks the tree and allows only the whitelisted files', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-gate-tree-')
  mkdirSync(join(root, 'support'), { recursive: true })
  // The helper itself: allowed.
  writeFileSync(
    join(root, 'support', 'temp-lifecycle.ts'),
    `import { mkdtempSync } from 'node:fs'\nexport const x = mkdtempSync('/tmp/a-')\n`,
  )
  // A stray direct user: reported.
  writeFileSync(
    join(root, 'stray.test.ts'),
    `import { mkdtempSync } from 'node:fs'\nconst root = mkdtempSync('/tmp/b-')\n`,
  )
  const violations = scanTree(root)
  assert.equal(violations.length, 2)
  assert.equal(violations[0].file, join(root, 'stray.test.ts'))
  assert.equal(violations[0].line, 1)
  assert.ok(ALLOWED_DIRECT_USAGE.every((entry) => entry.reason.length > 0), 'every whitelist entry must carry a reason')
  // The allowlist matches by BASENAME, so moving the helper does not
  // silently un-whitelist it.
  assert.ok(ALLOWED_DIRECT_USAGE.some((entry) => entry.file === 'temp-lifecycle.ts'), 'the helper must be whitelisted')
})

test('collectTestFiles only picks up source files', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-gate-files-')
  writeFileSync(join(root, 'a.test.ts'), '')
  writeFileSync(join(root, 'b.test.mjs'), '')
  writeFileSync(join(root, 'notes.md'), '')
  writeFileSync(join(root, 'data.json'), '')
  mkdirSync(join(root, 'nested'), { recursive: true })
  writeFileSync(join(root, 'nested', 'c.test.js'), '')
  const files = collectTestFiles(root).map((file) => file.slice(root.length + 1)).sort()
  assert.deepEqual(files, ['a.test.ts', 'b.test.mjs', join('nested', 'c.test.js')])
})

test('two files with the SAME allowlisted basename are reported', (t) => {
  // The allowlist names a file by its BASENAME, so a second file with the
  // same basename inherits the exemption: the gate would stay green while
  // a file nobody reviewed creates temp dirs. The check has to be part of
  // the SCAN, because the scan is what the guard test runs.
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-gate-ambiguous-')
  mkdirSync(join(root, 'app'), { recursive: true })
  mkdirSync(join(root, 'tui'), { recursive: true })
  for (const directory of ['app', 'tui']) {
    writeFileSync(join(root, directory, 'temp-lifecycle.ts'), `import { mkdtempSync } from 'node:fs'\nexport const x = mkdtempSync('/tmp/a-')\n`)
  }
  const ambiguous = ambiguousAllowlistEntries(root)
  assert.deepEqual(ambiguous, ['temp-lifecycle.ts'],
    'the shared basename must be reported as ambiguous')
  // And the scan reports it as a violation of its own.
  const violations = scanTree(root)
  assert.ok(violations.some(violation => violation.api === 'ambiguous-allowlist-entry'),
    JSON.stringify(violations, null, 2))
})

test('the gate CLI fails closed on an ambiguous allowlist', (t) => {
  // The CLI is what a developer runs; the SCAN is what the guard test
  // runs. Both have to fail closed, or one of them is a hole.
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-gate-cli-')
  mkdirSync(join(root, 'app'), { recursive: true })
  mkdirSync(join(root, 'tui'), { recursive: true })
  for (const directory of ['app', 'tui']) {
    writeFileSync(join(root, directory, 'temp-lifecycle.ts'), `import { mkdtempSync } from 'node:fs'\nexport const x = mkdtempSync('/tmp/a-')\n`)
  }
  const result = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'temp-hygiene-gate.mjs'), root], {
    encoding: 'utf8',
  })
  assert.notEqual(result.status, 0, 'the CLI must fail on an ambiguous allowlist')
  assert.match(result.stderr, /two files share an allowed basename/u)
})

test('a violation in ANOTHER owner directory is reported', (t) => {
  // The repository-level guard has to reach every owner directory, not
  // only the one this file lives in.
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-gate-owner-')
  mkdirSync(join(root, 'app'), { recursive: true })
  mkdirSync(join(root, 'tui'), { recursive: true })
  writeFileSync(join(root, 'app', 'stray.test.ts'), `import { mkdtempSync } from 'node:fs'\nconst root = mkdtempSync(join(tmpdir(), 'dsh-x-'))\n`)
  const violations = scanTree(root)
  assert.equal(violations.length, 2, JSON.stringify(violations))
  assert.ok(violations[0].file.includes('app'), 'the violation in the other directory must be reported')
})

test('repository test tree satisfies temp hygiene', () => {
  const violations = scanTree(TEST_ROOT)
  assert.deepEqual(
    violations,
    [],
    `root test files must create fixture dirs through testLifecycle(t).tempDir(prefix): ${violations
      .map((v) => `${v.file}:${v.line} (${v.api})`)
      .join(', ')}`,
  )
})
