/**
 * Headless tests for the diagnostics channel: level filtering, line format,
 * field rendering, env resolution, and the file sink.
 * @module @xmoon76/dsh-pi-tui/runtime/process/diagnostics.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { testLifecycle } from './support/temp-lifecycle.ts'
import { createDiag, diagFromEnv, diagLevelFromEnv, formatDiagTime, type DiagSink } from '../src/runtime/process/diagnostics.ts'

/** Absolute path of the module for the child-process fd-2 probes. */
const DIAG_MODULE_PATH = fileURLToPath(new URL('../src/runtime/process/diagnostics.ts', import.meta.url))

/** Collect every written line. */
function collector(): { lines: string[]; sink: DiagSink } {
  const lines: string[] = []
  return {
    lines,
    sink: { write: (line) => { lines.push(line) } },
  }
}

test('formatDiagTime renders local wall time with offset', () => {
  const date = new Date(2026, 7, 15, 10, 5, 3, 42) // 2026-08-15 10:05:03.042 local
  const line = formatDiagTime(date)
  assert.match(line, /^2026-08-15T10:05:03\.042[+-]\d{2}:\d{2}$/)
})

test('custom sinks observe every line; format and fields render', () => {
  const { lines, sink } = collector()
  const diag = createDiag({ fileLevel: 'info', stderrLevel: 'off', sinks: [sink], now: () => new Date(2026, 7, 15, 10, 0, 0) })
  diag.debug('a debug line')
  diag.info('boot', { pid: 42 })
  diag.warn('guard diverged', { fileEvents: 5, memoryEvents: 4 })
  diag.error('resume failed', { error: 'boom' })
  assert.equal(lines.length, 4)
  assert.match(lines[0], / DEBUG a debug line\n$/)
  assert.match(lines[1], / INFO boot pid=42\n$/)
  assert.match(lines[2], / WARN guard diverged fileEvents=5 memoryEvents=4\n$/)
  assert.match(lines[3], / ERROR resume failed error=boom\n$/)
})

test('debug level enables debug lines; field values render scalars and JSON', () => {
  const { lines, sink } = collector()
  const diag = createDiag({ fileLevel: 'debug', stderrLevel: 'off', sinks: [sink] })
  diag.debug('guard ok', { fileEvents: 0, memoryEvents: 0, tags: ['a', 'b'] })
  assert.equal(lines.length, 1)
  assert.match(lines[0], / DEBUG guard ok fileEvents=0 memoryEvents=0 tags=\["a","b"\]\n$/)
})

test('stderrLevel off suppresses nothing else; diagFromEnv resolves the file level', () => {
  assert.equal(diagLevelFromEnv({}), 'info')
  assert.equal(diagLevelFromEnv({ DSH_PI_TUI_LOG_LEVEL: 'debug' }), 'debug')
  assert.equal(diagLevelFromEnv({ DSH_PI_TUI_LOG_LEVEL: 'bogus' }), 'info')
  // diagFromEnv with log off must not throw and must not write a file.
  const diag = diagFromEnv({ DSH_PI_TUI_LOG: 'off' })
  diag.info('no file sink', {})
  diag.dispose()
})

test('file sink appends to the configured path and applies the file level', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('diag-test-')
  const path = join(dir, 'tui.log')
  const diag = createDiag({ fileLevel: 'info', stderrLevel: 'off', filePath: path })
  diag.debug('dropped by the info threshold')
  diag.info('boot', { pid: 7 })
  diag.dispose()
  const content = readFileSync(path, 'utf8')
  assert.match(content, / INFO boot pid=7\n$/)
  assert.ok(!content.includes('dropped by the info threshold'), 'debug line must be filtered out of the file')
})

test('a hostile field value never throws: circular + hostile toString both degrade', () => {
  const { lines, sink } = collector()
  const diag = createDiag({ fileLevel: 'debug', stderrLevel: 'off', sinks: [sink] })
  const circular: Record<string, unknown> = {}
  circular.self = circular
  // JSON.stringify fails on the cycle; the fallback must not throw either
  // (a hostile toString would previously escape the never-throw contract).
  diag.error('probe', { circular })
  assert.ok(lines.length >= 1, 'the line is still written')
  assert.match(lines[0]!, /ERROR probe/)
  // A hostile value that breaks BOTH paths: JSON.stringify fails on the
  // cycle AND String() throws (hostile toString) — the write must not
  // throw and the line carries the fixed placeholder.
  const hostile: Record<string, unknown> = {}
  hostile.self = hostile
  hostile.toString = () => { throw new Error('diag fallback exploded') }
  assert.doesNotThrow(() => diag.error('probe', { hostile }))
  assert.match(lines[1]!, /hostile=<unprintable error>/)
})

test('stderr threshold: lines below stderrLevel never reach fd 2', () => {
  // fd 2 is written with a raw `writeSync`, so the only faithful witness is a
  // child process whose stderr is captured.
  const script = [
    `import { createDiag } from ${JSON.stringify(DIAG_MODULE_PATH)}`,
    "const diag = createDiag({ fileLevel: 'info', stderrLevel: 'warn', now: () => new Date(2026, 7, 15, 10, 0, 0) })",
    "diag.debug('dbg-probe')",
    "diag.info('inf-probe')",
    "diag.warn('wrn-probe')",
    "diag.error('err-probe')",
    'diag.dispose()',
  ].join('\n')
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  assert.equal(result.status, 0, `child failed: ${result.stderr}`)
  assert.match(result.stderr, / WARN wrn-probe\n/)
  assert.match(result.stderr, / ERROR err-probe\n/)
  assert.ok(!result.stderr.includes('dbg-probe'), 'a debug line is below the stderr threshold')
  assert.ok(!result.stderr.includes('inf-probe'), 'an info line is below the stderr threshold')
})

test('a file write failure disables the sink without throwing', (t) => {
  // /dev/full accepts the open and fails every write with ENOSPC — the only
  // deterministic way to reach the file-write failure branch.
  if (!existsSync('/dev/full')) {
    t.skip('no /dev/full on this platform')
    return
  }
  const script = [
    `import { createDiag } from ${JSON.stringify(DIAG_MODULE_PATH)}`,
    "const diag = createDiag({ fileLevel: 'debug', stderrLevel: 'off', filePath: '/dev/full' })",
    "diag.debug('triggers-the-write')",
    "diag.info('after-the-failure')",
    'diag.dispose()',
    'diag.dispose()',
  ].join('\n')
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  assert.equal(result.status, 0, `a failed file sink must never escape: ${result.stderr}`)
  assert.equal((result.stderr.match(/diag file sink disabled/g) ?? []).length, 1,
    'the sink-loss record is written exactly once, then the sink stays disabled')
  assert.ok(!result.stderr.includes('after-the-failure'), 'stderrLevel off keeps the lines off fd 2')
})

test('a file open failure disables the sink without throwing', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('diag-open-failure-')
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'not a directory')
  const filePath = join(blocker, 'tui.log')
  const { lines, sink } = collector()
  const diag = createDiag({ fileLevel: 'debug', stderrLevel: 'off', filePath, sinks: [sink] })
  assert.doesNotThrow(() => diag.info('still recording', {}))
  assert.equal(lines.length, 1, 'the diagnostics channel keeps working after the sink is disabled')
  assert.equal(existsSync(filePath), false)
  diag.dispose()
})

test('dispose is idempotent and no line is written after it', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('diag-dispose-')
  const filePath = join(dir, 'tui.log')
  const diag = createDiag({ fileLevel: 'info', stderrLevel: 'off', filePath })
  diag.info('boot', { pid: 9 })
  diag.dispose()
  const written = readFileSync(filePath, 'utf8')
  assert.match(written, / INFO boot pid=9\n$/)
  assert.doesNotThrow(() => diag.dispose())
  assert.doesNotThrow(() => diag.dispose())
  assert.doesNotThrow(() => diag.info('after dispose', {}))
  assert.equal(readFileSync(filePath, 'utf8'), written, 'the closed handle is never reopened')
})
