/**
 * Headless tests for the diagnostics channel: level filtering, line format,
 * field rendering, env resolution, and the file sink.
 * @module @xmoon76/dsh-pi-tui/diag.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDiag, diagFromEnv, diagLevelFromEnv, formatDiagTime, type DiagSink } from '../src/diag.ts'

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

test('file sink appends to the configured path and applies the file level', () => {
  const dir = mkdtempSync(join(tmpdir(), 'diag-test-'))
  try {
    const path = join(dir, 'tui.log')
    const diag = createDiag({ fileLevel: 'info', stderrLevel: 'off', filePath: path })
    diag.debug('dropped by the info threshold')
    diag.info('boot', { pid: 7 })
    diag.dispose()
    const content = readFileSync(path, 'utf8')
    assert.match(content, / INFO boot pid=7\n$/)
    assert.ok(!content.includes('dropped by the info threshold'), 'debug line must be filtered out of the file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
