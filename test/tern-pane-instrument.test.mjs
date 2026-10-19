/**
 * Unit tests for `scripts/tern-pane-instrument.mjs` (the command-repeat rule and
 * the shell quoting) and for the two things the driver itself must never do with
 * a caller's directory:
 *
 *   - a `--out` that already exists is REFUSED, whatever spelling names it, and
 *     its contents are left exactly as they were — a run creates its own
 *     directory, it never reuses, takes over or cleans up someone else's;
 *   - a click, a key or a subject launch is delivered exactly ONCE, because a
 *     retried input is a second real input and would break every "one real click"
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
import { isRepeatableCommand, shellQuote } from '../scripts/tern-pane-instrument.mjs'
import { testLifecycle } from './support/temp-lifecycle.ts'

const DRIVER = fileURLToPath(new URL('../scripts/tern-pane-drive.mjs', import.meta.url))

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

test('a path written into the generated launch script survives spaces and quotes', () => {
  const quoted = shellQuote("/home/dev/my project/it's here")
  assert.equal(quoted, `'/home/dev/my project/it'\\''s here'`, 'the quote is escaped, not left open')
  // The quoting must round-trip through a real shell.
  const echoed = spawnSync('bash', ['-c', `printf %s ${quoted}`], { encoding: 'utf8' })
  assert.equal(echoed.stdout, "/home/dev/my project/it's here")
})

test('the driver refuses a --out that already exists, however it is spelled', (t) => {
  const dir = testLifecycle(t).tempDir('tern-pane-existing-')
  const evidence = join(dir, 'evidence.txt')
  writeFileSync(evidence, 'data that belongs to someone else\n')
  const flow = join(dir, 'flow.mjs')
  writeFileSync(flow, 'export default async function () {}\n')

  for (const out of [dir, `${dir}/`, `${dir}/./`, `${dir}/../${basename(dir)}`]) {
    const refused = spawnSync(process.execPath, [DRIVER, flow, '--out', out], {
      encoding: 'utf8',
      // TERN_BIN needs no Tern here: the refusal happens before anything spawns.
      env: { ...process.env, TERN_BIN: process.execPath },
    })
    assert.notEqual(refused.status, 0, `${out} must not be taken over:\n${refused.stdout}${refused.stderr}`)
    assert.match(refused.stderr, /already exists/, `${out} must be refused for existing`)
    assert.ok(refused.stderr.includes(dir), `${out} must be reported as the resolved directory`)
    assert.equal(readFileSync(evidence, 'utf8'), 'data that belongs to someone else\n', `${out} must not touch the contents`)
  }
})

test('a --out whose parent does not exist is the caller’s to create', (t) => {
  const parent = testLifecycle(t).tempDir('tern-pane-parentless-')
  const flow = join(parent, 'flow.mjs')
  writeFileSync(flow, 'export default async function () {}\n')
  const refused = spawnSync(process.execPath, [DRIVER, flow, '--out', join(parent, 'not-created', 'run')], {
    encoding: 'utf8',
    env: { ...process.env, TERN_BIN: process.execPath },
  })
  assert.notEqual(refused.status, 0, 'a missing parent is not filled in silently')
  assert.match(refused.stderr, /ENOENT/, 'and the failure names the missing directory')
})
