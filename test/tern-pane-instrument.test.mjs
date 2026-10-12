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
import { join } from 'node:path'
import test from 'node:test'
import { RUN_MARKER, isRepeatableCommand, runDirectoryVerdict, shellQuote } from '../scripts/tern-pane-instrument.mjs'

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
  for (const command of ['tree', 'dump', 'stats', 'pick', 'shot', 'resize', 'css']) {
    assert.equal(isRepeatableCommand(command), true, `${command} is safe to repeat`)
  }
  for (const command of ['click', 'key', 'run', 'quit']) {
    assert.equal(isRepeatableCommand(command), false, `${command} must be delivered exactly once`)
  }
})

test('a path written into the generated launch script survives spaces and quotes', () => {
  const quoted = shellQuote("/home/dev/my project/it's here")
  assert.equal(quoted, `'/home/dev/my project/it'\\''s here'`, 'the quote is escaped, not left open')
  // The quoting must round-trip through a real shell.
  const echoed = spawnSync('bash', ['-c', `printf %s ${quoted}`], { encoding: 'utf8' })
  assert.equal(echoed.stdout, "/home/dev/my project/it's here")
})
