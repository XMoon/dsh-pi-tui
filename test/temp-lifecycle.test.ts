/**
 * Unit tests for the test-owned temp lifecycle helper: creation, teardown
 * removal, ordering guarantees, prefix validation, and the keep-mode escape
 * hatch.
 * @module @xmoon76/dsh-pi-tui/temp-lifecycle.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { testLifecycle } from './support/temp-lifecycle.ts'

test('tempDir creates a real directory under the OS temp root', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-tl-create-')
  assert.ok(dir.startsWith(tmpdir()), `fixture must live under tmpdir: ${dir}`)
  assert.ok(existsSync(dir), `fixture must exist: ${dir}`)
})

test('the directory is gone once the owning test finishes', async (t) => {
  let created = ''
  await t.test('inner test owns the fixture', async (inner) => {
    const life = testLifecycle(inner)
    created = life.tempDir('dsh-tl-teardown-')
    assert.ok(existsSync(created))
  })
  assert.ok(created !== '', 'inner test must have run')
  assert.ok(!existsSync(created), `teardown must remove ${created}`)
})

test('nested files and directories are removed recursively', async (t) => {
  let created = ''
  await t.test('inner', async (inner) => {
    const life = testLifecycle(inner)
    created = life.tempDir('dsh-tl-nested-')
    mkdirSync(join(created, 'a', 'b'), { recursive: true })
    writeFileSync(join(created, 'a', 'b', 'deep.txt'), 'payload')
    writeFileSync(join(created, 'top.txt'), 'payload')
  })
  assert.ok(!existsSync(created), `recursive teardown must remove ${created}`)
})

test('disposers run in reverse registration order', async (t) => {
  const order: string[] = []
  await t.test('inner', async (inner) => {
    const life = testLifecycle(inner)
    life.defer(() => { order.push('first') })
    life.defer(() => { order.push('second') })
    life.defer(() => { order.push('third') })
  })
  assert.deepEqual(order, ['third', 'second', 'first'])
})

test('a deferred resource disposer runs before the temp directory is removed', async (t) => {
  let observedAtDisposer = ''
  let created = ''
  await t.test('inner', async (inner) => {
    const life = testLifecycle(inner)
    created = life.tempDir('dsh-tl-order-')
    life.defer(() => {
      observedAtDisposer = join(created, 'held.txt')
      // The resource teardown still sees the directory it was created in.
      if (!existsSync(created)) throw new Error(`directory removed before resource disposer: ${created}`)
    })
    writeFileSync(join(created, 'held.txt'), 'held')
  })
  assert.ok(!existsSync(created), 'directory removed after disposers')
  assert.equal(observedAtDisposer, join(created, 'held.txt'))
})

test('a disposer registered BEFORE tempDir still runs before the directory removal', async (t) => {
  let observedAtDisposer = ''
  let created = ''
  await t.test('inner', async (inner) => {
    const life = testLifecycle(inner)
    // Registration order is deliberately inverted: the contract is that
    // ALL disposers run before ANY temp-dir removal, not that callers must
    // remember to register tempDir first.
    life.defer(() => {
      observedAtDisposer = join(created, 'held.txt')
      if (!existsSync(created)) throw new Error(`directory removed before resource disposer: ${created}`)
    })
    created = life.tempDir('dsh-tl-order2-')
    writeFileSync(join(created, 'held.txt'), 'held')
  })
  assert.ok(!existsSync(created), 'directory removed after disposers')
  assert.equal(observedAtDisposer, join(created, 'held.txt'))
})

test('invalid prefixes are rejected without creating anything', async (t) => {
  const life = testLifecycle(t)
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a\0b']) {
    assert.throws(() => life.tempDir(bad), TypeError, `prefix ${JSON.stringify(bad)} must be rejected`)
  }
})

test('DSH_TEST_KEEP_TMP=1 keeps the directory and prints its path', async (t) => {
  const previous = process.env.DSH_TEST_KEEP_TMP
  let created = ''
  const stderrChunks: string[] = []
  const originalWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
    return true
  }) as typeof process.stderr.write
  process.env.DSH_TEST_KEEP_TMP = '1'
  try {
    await t.test('inner', async (inner) => {
      const life = testLifecycle(inner)
      created = life.tempDir('dsh-tl-keep-')
    })
    assert.ok(existsSync(created), 'keep mode must retain the directory')
    const combined = stderrChunks.join('')
    assert.ok(combined.includes(created), `keep mode must print the retained path, got: ${combined}`)
    assert.ok(combined.includes('DSH_TEST_KEEP_TMP'), 'the notice must name the escape hatch')
  } finally {
    if (previous === undefined) delete process.env.DSH_TEST_KEEP_TMP
    else process.env.DSH_TEST_KEEP_TMP = previous
    process.stderr.write = originalWrite
    rmSync(created, { recursive: true, force: true })
  }
})

test('a throwing disposer does not block the remaining cleanup, and the failure surfaces', async (t) => {
  const life = testLifecycle(t)
  const outRoot = life.tempDir('dsh-tl-hostile-out-')
  const outcomePath = join(outRoot, 'outcome.json')
  const childPath = join(outRoot, 'hostile-child.mjs')
  const helperUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'support', 'temp-lifecycle.ts')).href
  // The hostile teardown must fail the owning test, so it runs in a child
  // process (a failing subtest would fail this file's own run). The child
  // records what actually happened from its exit handler — after every hook.
  writeFileSync(childPath, [
    "import { existsSync, writeFileSync } from 'node:fs'",
    "import { test } from 'node:test'",
    `import { testLifecycle } from ${JSON.stringify(helperUrl)}`,
    'let dir = null',
    'let secondRan = false',
    "test('hostile teardown', async (ctx) => {",
    '  const inner = testLifecycle(ctx)',
    "  dir = inner.tempDir('dsh-tl-hostile-child-')",
    '  inner.defer(() => { throw new Error("hostile disposer") })',
    '  inner.defer(() => { secondRan = true })',
    '}).then(() => { process.exitCode = 3 }, () => { process.exitCode = 7 })',
    `process.on('exit', () => {`,
    `  writeFileSync(${JSON.stringify(outcomePath)}, JSON.stringify({ secondRan, dirRemoved: dir === null ? false : !existsSync(dir) }))`,
    '})',
    '',
  ].join('\n'))
  const result = spawnSync(process.execPath, [childPath], { encoding: 'utf8' })
  assert.notEqual(result.status, 0, `the owning test must fail (stderr: ${result.stderr})`)
  const outcome = JSON.parse(readFileSync(outcomePath, 'utf8')) as { secondRan: boolean; dirRemoved: boolean }
  assert.equal(outcome.secondRan, true, 'cleanup registered before the throwing disposer must still run')
  assert.equal(outcome.dirRemoved, true, 'the directory must still be removed after a cleanup failure')
})
