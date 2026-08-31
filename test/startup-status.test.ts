/**
 * Pre-mount startup status helper tests: TTY show/update/clear, clear
 * idempotence, non-TTY silence, and no stale text after clear.
 * @module @xmoon76/dsh-pi-tui/startup-status.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createStartupStatus, type StartupStatusOutput } from '../src/startup-status.ts'

/** A recording output seam. */
function recordingOutput(isTTY = true): { writes: string[]; output: StartupStatusOutput } {
  const writes: string[] = []
  return {
    writes,
    output: {
      isTTY,
      write: (text) => {
        writes.push(text)
        return undefined
      },
    },
  }
}

test('TTY show writes CR + erase-line + message', () => {
  const { writes, output } = recordingOutput()
  const status = createStartupStatus(output)
  status.show('Resuming session…')
  assert.deepEqual(writes, ['\r\x1b[2KResuming session…'])
})

test('TTY update overwrites the line in place (no accumulation)', () => {
  const { writes, output } = recordingOutput()
  const status = createStartupStatus(output)
  status.show('Resuming session…')
  status.show('Preparing conversation…')
  assert.deepEqual(writes, [
    '\r\x1b[2KResuming session…',
    '\r\x1b[2KPreparing conversation…',
  ])
})

test('clear erases the line and is idempotent', () => {
  const { writes, output } = recordingOutput()
  const status = createStartupStatus(output)
  status.show('Resuming session…')
  status.clear()
  status.clear()
  assert.deepEqual(writes, ['\r\x1b[2KResuming session…', '\r\x1b[2K'])
})

test('clear before any show writes nothing', () => {
  const { writes, output } = recordingOutput()
  const status = createStartupStatus(output)
  status.clear()
  assert.deepEqual(writes, [])
})

test('non-TTY output is completely silent', () => {
  const { writes, output } = recordingOutput(false)
  const status = createStartupStatus(output)
  status.show('Resuming session…')
  status.show('Preparing conversation…')
  status.clear()
  assert.deepEqual(writes, [], 'a pipe / CI must never see the status')
})

test('show after clear re-arms the line (a later clear erases again)', () => {
  const { writes, output } = recordingOutput()
  const status = createStartupStatus(output)
  status.show('Resuming session…')
  status.clear()
  status.show('Preparing conversation…')
  status.clear()
  assert.deepEqual(writes, [
    '\r\x1b[2KResuming session…',
    '\r\x1b[2K',
    '\r\x1b[2KPreparing conversation…',
    '\r\x1b[2K',
  ])
})

test('isTTY defaults to true when the output does not declare it', () => {
  const writes: string[] = []
  const status = createStartupStatus({ write: (text) => { writes.push(text) } })
  status.show('Resuming session…')
  assert.deepEqual(writes, ['\r\x1b[2KResuming session…'])
})
