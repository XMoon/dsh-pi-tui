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

test('a throwing output seam is contained: the status never fails a boot', () => {
  // The seam has no never-throws contract, and the helper is called from an
  // AbortSignal listener and the terminal startup-failure root, where a throw
  // would become an uncaughtException or block teardown/exit.
  const writes: string[] = []
  const status = createStartupStatus({
    isTTY: true,
    write: (text) => {
      writes.push(text)
      throw new Error('stream exploded')
    },
  })
  assert.doesNotThrow(() => status.show('Starting DSH…'), 'show must contain a throwing write')
  assert.doesNotThrow(() => status.clear(), 'clear must contain a throwing write')
  // State semantics are unchanged: a show owns the line, so a later clear still
  // ATTEMPTS the erase (both writes were attempted above).
  assert.deepEqual(writes, ['\r\x1b[2KStarting DSH…', '\r\x1b[2K'])
})

test('a failed erase keeps the row owned so the next clear retries it', () => {
  const writes: string[] = []
  let eraseAttempts = 0
  const status = createStartupStatus({
    isTTY: true,
    write: (text) => {
      writes.push(text)
      // Fail the FIRST erase only: the retry must actually land.
      if (text === '\r\x1b[2K' && (eraseAttempts += 1) === 1) throw new Error('erase exploded')
    },
  })
  status.show('Starting DSH…')
  assert.doesNotThrow(() => status.clear(), 'the failed erase is still contained')
  assert.deepEqual(writes, ['\r\x1b[2KStarting DSH…', '\r\x1b[2K'], 'the first erase was attempted')

  // The row is still owned: the next clear retries the erase...
  status.clear()
  assert.equal(writes.filter(text => text === '\r\x1b[2K').length, 2, 'the erase must be retried')
  // ...and only a landed erase releases it.
  status.clear()
  assert.equal(writes.filter(text => text === '\r\x1b[2K').length, 2, 'a released row is not erased again')
})
