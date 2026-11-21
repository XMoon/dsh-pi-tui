/**
 * Directory-only completion adapter tests (Pre-Stage-D export convergence):
 * the Save Location field reuses the neutral path pipeline (query resolution,
 * Client-local discovery, ranking, dialect handling) and filters the candidate
 * facts to directories. Files are never suggested; `./`, `../`, `~/` and
 * directories with spaces all complete; the accepted value keeps the user's
 * separator and continues into the accepted directory.
 * @module @xmoon76/dsh-pi-tui/directory-completion.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { completeDirectory } from '../../src/client/file-completion/directory-completion.ts'
import { ClientLocalDiscoveryDriver, clientPathQueryEnvironment } from '../../src/client/file-completion/local-discovery.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

/** A forced-fallback Client discovery driver (`null` pins the bounded scan,
 * so the fixture results never depend on an installed finder). */
function clientDriver(): ClientLocalDiscoveryDriver {
  return new ClientLocalDiscoveryDriver(null)
}

/**
 * A pinned fake Client finder over a scripted record list. It records its argv
 * and honours fd's OWN `--max-results` bound, so the retired early-output
 * cutoff is observable as BEHAVIOUR: a capped run really omits the late
 * directory instead of it merely being filtered by the consumer.
 */
function scriptedFinder(
  life: ReturnType<typeof testLifecycle>,
  records: readonly string[],
): { path: string; argsFile: string } {
  const dir = life.tempDir('dsh-dir-fd-scripted-')
  const recordFile = join(dir, 'records.bin')
  writeFileSync(recordFile, records.map(record => `${record}\0`).join(''))
  const path = join(dir, 'fd')
  const argsFile = join(dir, 'args.txt')
  writeFileSync(path, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.writeFileSync(${JSON.stringify(argsFile)}, args.join('\\n'))
const maxIndex = args.indexOf('--max-results')
const max = maxIndex === -1 ? Infinity : Number(args[maxIndex + 1])
const records = fs.readFileSync(${JSON.stringify(recordFile)}, 'utf8').split('\\u0000')
if (records.at(-1) === '') records.pop()
process.stdout.write(records.slice(0, max).map(record => record + '\\u0000').join(''))
`)
  chmodSync(path, 0o755)
  return { path, argsFile }
}

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
  const items = await completeDirectory('./', cwd, clientDriver(), clientPathQueryEnvironment(), new AbortController().signal)
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
  const items = await completeDirectory('./src/', cwd, clientDriver(), clientPathQueryEnvironment(), new AbortController().signal)
  // The listing of ./src/ has no subdirectories — the file main.ts must not
  // appear, so the result is null (nothing to suggest).
  assert.equal(items, null)
})

test('fuzzy term matches directories only', async (t) => {
  const { cwd } = fixture(testLifecycle(t))
  const items = await completeDirectory('do', cwd, clientDriver(), clientPathQueryEnvironment(), new AbortController().signal)
  assert.ok(items !== null)
  const values = items.map(item => item.value)
  assert.ok(values.includes('docs/'), 'docs directory suggested for "do"')
  assert.ok(!values.some(value => value.includes('notes.txt')), 'files are excluded from fuzzy matches')
})

test('../ navigation works', async (t) => {
  const { root, cwd } = fixture(testLifecycle(t))
  const items = await completeDirectory('../', cwd, clientDriver(), clientPathQueryEnvironment(), new AbortController().signal)
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
    const items = await completeDirectory('~/', cwd, clientDriver(), clientPathQueryEnvironment(), new AbortController().signal)
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
  const items = await completeDirectory('./s', cwd, clientDriver(), clientPathQueryEnvironment(), new AbortController().signal)
  assert.ok(items !== null)
  const src = items.find(item => item.value === './src/')
  assert.ok(src !== undefined, './src/ is suggested with the trailing separator')
  assert.equal(src.displayPath, './src', 'the display path stays bare — the TUI owns the marker')
})

test('aborted completion returns null', async (t) => {
  const { cwd } = fixture(testLifecycle(t))
  const controller = new AbortController()
  controller.abort()
  const items = await completeDirectory('./', cwd, clientDriver(), clientPathQueryEnvironment(), controller.signal)
  assert.equal(items, null)
})

test('a late high-score directory survives 100 earlier files in the Save Location suggestions', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-dir-late-')
  const cwd = join(root, 'cwd')
  mkdirSync(cwd)
  // 120 file records stream out first (score 80: basename prefix); the only
  // FILESYSTEM directory among the finder records is emitted LAST and carries
  // the directory bonus (90), so a pre-ranking 100-record cutoff loses it.
  const records = Array.from({ length: 120 }, (_value, index) =>
    `s-file-${String(index).padStart(3, '0')}.txt`)
  records.push('src/')
  const finder = scriptedFinder(life, records)
  const items = await completeDirectory(
    './s',
    cwd,
    new ClientLocalDiscoveryDriver(finder.path),
    clientPathQueryEnvironment(),
    new AbortController().signal,
  )
  const args = readFileSync(finder.argsFile, 'utf8').split(/\r?\n/)
  assert.ok(!args.includes('--max-results'), `no early-output cap may reach the finder: ${JSON.stringify(args)}`)
  assert.ok(items !== null, 'the late directory keeps the directory chooser non-empty')
  const values = items.map(item => item.value)
  assert.ok(values.includes('./src/'), `the late high-score directory is suggested: ${JSON.stringify(values)}`)
  assert.ok(!values.some(value => value.includes('.txt')), 'files never surface in the directory-only chooser')
})
