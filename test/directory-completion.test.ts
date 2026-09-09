/**
 * Directory-only completion adapter tests (Pre-Stage-D export convergence):
 * the Save Location field reuses the shared path engine (query resolution,
 * LocalFileSource discovery, ranking, dialect handling) and filters the
 * candidate facts to directories. Files are never suggested; `./`, `../`,
 * `~/` and directories with spaces all complete; the accepted value keeps
 * the user's separator and continues into the accepted directory.
 * @module @xmoon76/dsh-pi-tui/directory-completion.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { completeDirectory } from '../src/file-completion/directory-completion.ts'
import { LocalFileSource } from '../src/file-completion/local-file-source.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'

/** A fixture root with directories and files (files must never be suggested). */
function fixture(life: ReturnType<typeof testLifecycle>): { root: string; cwd: string } {
  const root = life.tempDir('dsh-dir-complete-')
  const cwd = join(root, 'cwd')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(join(cwd, 'src'))
  mkdirSync(join(cwd, 'docs'))
  mkdirSync(join(cwd, 'my folder'))
  writeFileSync(join(cwd, 'src', 'main.ts'), 'x')
  writeFileSync(join(cwd, 'notes.txt'), 'x')
  writeFileSync(join(cwd, 'my folder', 'inner.txt'), 'x')
  return { root, cwd }
}

test('completes the initial ./ listing with directories only', async (t) => {
  const { cwd } = fixture(testLifecycle(t))
  const items = await completeDirectory('./', cwd, new LocalFileSource(null), new AbortController().signal)
  assert.ok(items !== null)
  const values = items.map(item => item.value)
  assert.ok(values.includes('./src/'), 'src directory suggested')
  assert.ok(values.includes('./docs/'), 'docs directory suggested')
  assert.ok(values.includes('./my folder/'), 'directory with spaces suggested')
  assert.ok(!values.some(value => value.includes('notes.txt')), 'files are excluded')
  assert.ok(!values.some(value => value.includes('main.ts')), 'nested files are excluded')
})

test('scoped ./src/ listing continues into the directory children', async (t) => {
  const { cwd } = fixture(testLifecycle(t))
  const items = await completeDirectory('./src/', cwd, new LocalFileSource(null), new AbortController().signal)
  // The listing of ./src/ has no subdirectories — the file main.ts must not
  // appear, so the result is null (nothing to suggest).
  assert.equal(items, null)
})

test('fuzzy term matches directories only', async (t) => {
  const { cwd } = fixture(testLifecycle(t))
  const items = await completeDirectory('do', cwd, new LocalFileSource(null), new AbortController().signal)
  assert.ok(items !== null)
  const values = items.map(item => item.value)
  assert.ok(values.includes('docs/'), 'docs directory suggested for "do"')
  assert.ok(!values.some(value => value.includes('notes.txt')), 'files are excluded from fuzzy matches')
})

test('../ navigation works', async (t) => {
  const { root, cwd } = fixture(testLifecycle(t))
  const items = await completeDirectory('../', cwd, new LocalFileSource(null), new AbortController().signal)
  assert.ok(items !== null)
  const values = items.map(item => item.value)
  assert.ok(values.includes('../cwd/'), 'the parent lists the cwd directory')
  assert.ok(values.every(value => value.startsWith('../')), 'values keep the ../ dialect')
})

test('~/ expansion lists the home directory', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-dir-home-')
  mkdirSync(join(home, 'pics'))
  const cwd = life.tempDir('dsh-dir-cwd-')
  const saved = process.env.HOME
  try {
    process.env.HOME = home
    const items = await completeDirectory('~/', cwd, new LocalFileSource(null), new AbortController().signal)
    assert.ok(items !== null)
    const values = items.map(item => item.value)
    assert.ok(values.includes('~/pics/'), 'home directory children are listed')
    assert.ok(values.every(value => value.startsWith('~/')), 'values keep the ~ dialect')
  } finally {
    if (saved === undefined) delete process.env.HOME
    else process.env.HOME = saved
  }
})

test('accepted directory value continues with a separator', async (t) => {
  const { cwd } = fixture(testLifecycle(t))
  const items = await completeDirectory('./s', cwd, new LocalFileSource(null), new AbortController().signal)
  assert.ok(items !== null)
  const src = items.find(item => item.value === './src/')
  assert.ok(src !== undefined, './src/ is suggested with the trailing separator')
  assert.equal(src.label, './src/')
})

test('aborted completion returns null', async (t) => {
  const { cwd } = fixture(testLifecycle(t))
  const controller = new AbortController()
  controller.abort()
  const items = await completeDirectory('./', cwd, new LocalFileSource(null), controller.signal)
  assert.equal(items, null)
})
