/**
 * Unit tests for `scripts/tern-pane-instrument.mjs` — the two ways the harness
 * could destroy something instead of measuring it:
 *
 *   - it wipes its run directory, so `--out` must never resolve to the
 *     repository, its ancestors, the working directory, home, or a directory
 *     this driver does not own;
 *   - it must send a click, a key or a subject launch exactly ONCE: a retried
 *     input is a second real input, and would break every "one real click"
 *     claim while still reporting green.
 *
 * Run with `node --test test/tern-pane-instrument.test.mjs` from the repo root
 * (`pnpm test:tooling`).
 * @module test/tern-pane-instrument.test
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { RUN_MARKER, isRepeatableCommand, markerOwnership, runDirectoryVerdict, shellQuote } from '../scripts/tern-pane-instrument.mjs'
import { testLifecycle } from './support/temp-lifecycle.ts'

const DRIVER = fileURLToPath(new URL('../scripts/tern-pane-drive.mjs', import.meta.url))

const REPO = '/home/dev/project/dsh-pi-tui'
const CWD = '/home/dev/project/dsh-pi-tui/scripts'
const HOME = '/home/dev'

test('a run directory that holds the repository, its ancestors, the cwd or home is refused', () => {
  for (const root of [REPO, '/home/dev/project', HOME, '/home', '/', CWD]) {
    const verdict = runDirectoryVerdict({ root, repo: REPO, cwd: CWD, home: HOME, entries: ['whatever.txt'] })
    assert.equal(verdict.ok, false, `${root} must not be wipeable`)
    assert.match(verdict.reason, /holds/, `${root} must say what it would destroy`)
  }
})

test('an absent or empty run directory is taken over', () => {
  const base = join(REPO, 'temp', 'tern-pane')
  assert.deepEqual(runDirectoryVerdict({ root: base, repo: REPO, cwd: CWD, home: HOME }), { ok: true })
  assert.deepEqual(
    runDirectoryVerdict({ root: base, repo: REPO, cwd: CWD, home: HOME, entries: [] }),
    { ok: true },
    'an empty directory holds nothing to lose',
  )
})

test('a directory this driver owns is taken over again', () => {
  const verdict = runDirectoryVerdict({
    root: '/tmp/tern-pane',
    repo: REPO,
    cwd: CWD,
    home: HOME,
    entries: [RUN_MARKER, 'assertions.json', 'shots'],
    marker: markerOwnership('{"driver":"tern-pane-drive","pid":4242,"started":"x"}'),
    isAlive: () => false,
  })
  assert.deepEqual(verdict, { ok: true })
})

test('a non-empty directory this driver does not own is refused, whatever it holds', () => {
  for (const entries of [['src', 'package.json'], ['run.log'], ['.git'], ['photos']]) {
    const verdict = runDirectoryVerdict({ root: '/home/dev/notes', repo: REPO, cwd: CWD, home: HOME, entries })
    assert.equal(verdict.ok, false, `wiping /home/dev/notes with ${entries} must be refused`)
    assert.match(verdict.reason, /not a harness run directory/)
  }
})

test('only reads and idempotent sets may be repeated; a real input may not', () => {
  for (const args of [['tree'], ['dump'], ['stats'], ['pick', '10', '20'], ['shot', 'one'], ['resize', '400', '600'], ['css', 'tux']]) {
    assert.equal(isRepeatableCommand(args), true, `${args.join(' ')} is safe to repeat`)
  }
  for (const args of [['click', '1', '2'], ['key', 'a'], ['run', '/tmp/launch.sh'], ['quit']]) {
    assert.equal(isRepeatableCommand(args), false, `${args.join(' ')} must be delivered exactly once`)
  }
})

test('a command that only LOOKS like a read is classified by its full shape', () => {
  // `a11y` alone reads the tree; with an action it clicks or edits a control.
  assert.equal(isRepeatableCommand(['a11y']), true, 'the bare tree read is repeatable')
  for (const args of [['a11y', 'click', '#pick'], ['a11y', 'increment', '#stepper']]) {
    assert.equal(isRepeatableCommand(args), false, `${args.join(' ')} changes state`)
  }
  // `perf since` reads a finished collection; the rest restart it.
  assert.equal(isRepeatableCommand(['perf']), true)
  assert.equal(isRepeatableCommand(['perf', 'since']), true)
  for (const args of [['perf', 'on'], ['perf', 'off'], ['perf', 'reset'], ['perf', 'mark']]) {
    assert.equal(isRepeatableCommand(args), false, `${args.join(' ')} restarts the collection`)
  }
})

test('a run directory held by a LIVE run is refused, a stale one is taken over', () => {
  const held = { root: '/tmp/tern-pane', repo: REPO, cwd: CWD, home: HOME, entries: [RUN_MARKER], marker: { present: true, valid: true, pid: 4242 } }
  const live = runDirectoryVerdict({ ...held, isAlive: (pid) => pid === 4242 })
  assert.equal(live.ok, false, 'two harnesses must not share one run directory')
  assert.match(live.reason, /live run \(pid 4242\)/)
  assert.deepEqual(
    runDirectoryVerdict({ ...held, isAlive: () => false }),
    { ok: true },
    'the run that left the marker is gone, so its directory is ours again',
  )
})

test('only a marker that parses and identifies this driver proves ownership', () => {
  assert.deepEqual(markerOwnership(undefined), { present: false })
  assert.deepEqual(markerOwnership('{"driver":"tern-pane-drive","pid":7}'), { present: true, valid: true, pid: 7 })
  for (const raw of [
    '{"driver":"tern-pane-drive"',            // truncated
    'not json at all',                        // another writer's file
    '{"driver":"someone-else","pid":7}',      // not this driver
    '{"driver":"tern-pane-drive","pid":"7"}', // a pid that is not a number
    'null',
  ]) {
    assert.deepEqual(markerOwnership(raw), { present: true, valid: false }, `${raw} must not prove ownership`)
  }
})

test('a non-empty directory whose marker does not parse is refused, not wiped', () => {
  const verdict = runDirectoryVerdict({
    root: '/home/dev/notes',
    repo: REPO,
    cwd: CWD,
    home: HOME,
    entries: [RUN_MARKER, 'photos'],
    marker: markerOwnership('{"broken"'),
    isAlive: () => false,
  })
  assert.equal(verdict.ok, false, 'a file with the marker NAME is not a claim')
  assert.match(verdict.reason, /cannot read/)
})

test('the DRIVER applies that rule: a live holder is refused and its directory is untouched', (t) => {
  // The wiring is what this covers. A driver that reads its own marker wrongly
  // still passes the pure verdict test above, so run the real entry point with a
  // TERN_BIN that needs no Tern: the refusal must happen before anything spawns.
  const dir = testLifecycle(t).tempDir('tern-pane-refusal-')
  const evidence = join(dir, 'evidence.txt')
  writeFileSync(evidence, 'the previous run wrote this\n')
  writeFileSync(join(dir, RUN_MARKER), JSON.stringify({ driver: 'tern-pane-drive', pid: process.pid }))
  const flow = join(dir, 'flow.mjs')
  writeFileSync(flow, 'export default async function () {}\n')

  const refused = spawnSync(process.execPath, [DRIVER, flow, '--out', dir], {
    encoding: 'utf8',
    env: { ...process.env, TERN_BIN: process.execPath },
  })
  assert.notEqual(refused.status, 0, `the driver must not take over a held directory:\n${refused.stdout}${refused.stderr}`)
  assert.match(refused.stderr, /held by a live run/, 'and it must say which run holds it')
  assert.equal(readFileSync(evidence, 'utf8'), 'the previous run wrote this\n', 'a refused run directory is never wiped')
})

test('the DRIVER normalizes --out, so `.` and `..` cannot disguise a protected directory', (t) => {
  // The bypass: identity was compared on the raw string while `rmSync` resolves
  // the path on the way to the filesystem, so `<dir>/../<dir>` skipped the guard.
  // A stale-but-VALID marker is what makes the raw comparison decide: without
  // normalization the directory looks owned and gets wiped.
  const dir = testLifecycle(t).tempDir('tern-pane-normalize-')
  const evidence = join(dir, 'evidence.txt')
  writeFileSync(evidence, 'prior evidence\n')
  const gonePid = spawnSync(process.execPath, ['-e', '']).pid
  writeFileSync(join(dir, RUN_MARKER), JSON.stringify({ driver: 'tern-pane-drive', pid: gonePid }))
  const flow = join(dir, 'flow.mjs')
  writeFileSync(flow, 'export default async function () {}\n')

  const disguises = [dir, `${dir}/./`, `${dir}/../${basename(dir)}`, `${dir}/../${basename(dir)}/`]
  for (const out of disguises) {
    const refused = spawnSync(process.execPath, [DRIVER, flow, '--out', out], {
      encoding: 'utf8',
      cwd: dir, // so the run directory IS the working directory, which is protected
      env: { ...process.env, TERN_BIN: process.execPath },
    })
    assert.notEqual(refused.status, 0, `${out} must not be taken over:\n${refused.stdout}${refused.stderr}`)
    assert.match(refused.stderr, /holds/, `${out} must be refused as the working directory`)
    assert.equal(readFileSync(evidence, 'utf8'), 'prior evidence\n', `${out} must not be wiped`)
  }
})

test('a path written into the generated launch script survives spaces and quotes', () => {
  const quoted = shellQuote("/home/dev/my project/it's here")
  assert.equal(quoted, `'/home/dev/my project/it'\\''s here'`, 'the quote is escaped, not left open')
  // The quoting must round-trip through a real shell.
  const echoed = spawnSync('bash', ['-c', `printf %s ${quoted}`], { encoding: 'utf8' })
  assert.equal(echoed.stdout, "/home/dev/my project/it's here")
})
