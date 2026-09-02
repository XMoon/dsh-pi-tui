/**
 * Terminal notification backend tests (plan §10.4): the emitted
 * sequences per method, the auto resolution rule, and the OSC payload
 * sanitization (ESC / BEL / ST / C0 control chars can never inject an
 * arbitrary terminal sequence). Pure — injected writer, no real desktop.
 * @module @xmoon76/dsh-pi-tui/terminal-notifier.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { guardedStreamWriter, resolveAutoMethod, sanitizeOscPayload, TerminalNotifier } from '../src/notification/terminal-notifier.ts'

/** A writer that records every sequence. */
function recordingWriter(): { written: string[]; write(sequence: string): void } {
  const written: string[] = []
  return { written, write: (sequence) => { written.push(sequence) } }
}

test('bell writes exactly one BEL', () => {
  const writer = recordingWriter()
  const notifier = new TerminalNotifier(writer)
  notifier.notify('bell', 'DSH', 'Turn complete')
  assert.deepEqual(writer.written, ['\x07'])
})

test('osc9 writes the OSC 9 payload with the body', () => {
  const writer = recordingWriter()
  const notifier = new TerminalNotifier(writer)
  notifier.notify('osc9', 'DSH', 'Turn complete')
  assert.deepEqual(writer.written, ['\x1b]9;Turn complete\x07'])
})

test('osc777 writes the notify-send form with title and body', () => {
  const writer = recordingWriter()
  const notifier = new TerminalNotifier(writer)
  notifier.notify('osc777', 'DSH', 'Turn complete')
  assert.deepEqual(writer.written, ['\x1b]777;notify;DSH;Turn complete\x07'])
})

test('auto resolves from the terminal environment (Codex-aligned OSC 9 whitelist)', () => {
  // Confirmed OSC 9 implementations (by TERM_PROGRAM).
  assert.equal(resolveAutoMethod({ TERM_PROGRAM: 'iTerm.app' }), 'osc9')
  assert.equal(resolveAutoMethod({ TERM_PROGRAM: 'WezTerm' }), 'osc9')
  assert.equal(resolveAutoMethod({ TERM_PROGRAM: 'Ghostty' }), 'osc9')
  assert.equal(resolveAutoMethod({ TERM_PROGRAM: 'WarpTerminal' }), 'osc9')
  // Kitty: by TERM alias and by its window-id env marker.
  assert.equal(resolveAutoMethod({ TERM: 'xterm-kitty' }), 'osc9')
  assert.equal(resolveAutoMethod({ KITTY_WINDOW_ID: '1' }), 'osc9')
  assert.equal(resolveAutoMethod({ TERM: 'xterm-ghostty' }), 'osc9')
  // VTE-based terminals prefer the notify-send OSC 777 form.
  assert.equal(resolveAutoMethod({ VTE_VERSION: '0.68.0' }), 'osc777')
  // Terminals WITHOUT a confirmed OSC 9 implementation fall back to
  // bell (Apple Terminal, Alacritty, GNOME/Konsole/VTE, VS Code,
  // Windows Terminal, Hyper, unknown programs…).
  assert.equal(resolveAutoMethod({ TERM_PROGRAM: 'Apple_Terminal' }), 'bell', 'Apple Terminal has no confirmed OSC 9')
  assert.equal(resolveAutoMethod({ TERM_PROGRAM: 'Hyper' }), 'bell', 'Hyper stays off the whitelist (auto conservative)')
  assert.equal(resolveAutoMethod({ TERM_PROGRAM: 'gnome-terminal', VTE_VERSION: '0.68.0' }), 'osc777')
  assert.equal(resolveAutoMethod({ TERM_PROGRAM: 'alacritty' }), 'bell')
  assert.equal(resolveAutoMethod({ TERM_PROGRAM: 'gnome-terminal' }), 'bell', 'unknown programs fall back to bell')
  assert.equal(resolveAutoMethod({}), 'bell')
})

test('auto emits through the resolved method', () => {
  const writer = recordingWriter()
  const notifier = new TerminalNotifier(writer)
  notifier.notify('auto', 'DSH', 'Turn complete', { TERM_PROGRAM: 'iTerm.app' })
  assert.deepEqual(writer.written, ['\x1b]9;Turn complete\x07'])
  const bellWriter = recordingWriter()
  const bellNotifier = new TerminalNotifier(bellWriter)
  bellNotifier.notify('auto', 'DSH', 'Turn complete', {})
  assert.deepEqual(bellWriter.written, ['\x07'])
})

test('sanitizeOscPayload strips ESC, BEL, ST and C0 controls', () => {
  assert.equal(sanitizeOscPayload('plain'), 'plain')
  assert.equal(sanitizeOscPayload('a\x1bb'), 'ab', 'ESC stripped')
  assert.equal(sanitizeOscPayload('a\x07b'), 'ab', 'BEL stripped')
  assert.equal(sanitizeOscPayload('a\x1b\\b'), 'ab', 'ST (ESC backslash) stripped as a pair')
  assert.equal(sanitizeOscPayload('a\x00b\x1fc'), 'abc', 'C0 controls stripped')
  assert.equal(sanitizeOscPayload('a\x7fb'), 'ab', 'DEL stripped')
})

test('sanitizeOscPayload strips C1 controls (the 8-bit ST can terminate an OSC)', () => {
  // U+009C is the 8-bit ST: a single byte that ends an OSC sequence in
  // 8-bit mode — a payload carrying it could inject terminal control.
  assert.equal(sanitizeOscPayload('a\x9cb'), 'ab', '8-bit ST stripped')
  assert.equal(sanitizeOscPayload('a\x80b\x9fc'), 'abc', 'other C1 controls stripped')
})

test('a hostile title/body cannot inject a terminal sequence into the OSC payload', () => {
  const writer = recordingWriter()
  const notifier = new TerminalNotifier(writer)
  const hostile = 'x\x1b]9;evil\x07y'
  notifier.notify('osc9', 'DSH', hostile)
  const emitted = writer.written[0]!
  assert.ok(!emitted.includes('\x1b]9;evil'), `injected OSC must be stripped: ${JSON.stringify(emitted)}`)
  // The payload (between the OSC introducer and the final BEL terminator)
  // must contain no control character at all.
  const payload = emitted.slice(4, -1)
  assert.ok(!/[\x00-\x1f\x7f]/.test(payload), `the payload must be control-free: ${JSON.stringify(payload)}`)
  // The ESC and BEL are gone; the leftover literal text is inert (an OSC
  // sequence cannot start without its ESC introducer).
  assert.equal(emitted, '\x1b]9;x]9;evily\x07')
})

test('a throwing writer propagates to the caller (the runner contains it)', () => {
  const notifier = new TerminalNotifier({ write: () => { throw new Error('stream closed') } })
  assert.throws(() => notifier.notify('bell', 'DSH', 'Turn complete'), /stream closed/)
})

// ── the async stream-error guard (review finding: EPIPE is delivered
// through the stream's 'error' event, invisible to a sync try/catch) ────

test('guardedStreamWriter: a REAL asynchronous stream error event is swallowed', async () => {
  const stream = new EventEmitter() as EventEmitter & { write(data: string): unknown }
  const writes: string[] = []
  stream.write = (data: string) => { writes.push(data); return true }
  const writer = guardedStreamWriter(stream as never)
  writer.write('\x07')
  // Emit the failure the way a broken pipe delivers it: asynchronously
  // through the stream's 'error' event. WITHOUT the guard's listener,
  // EventEmitter.emit('error') throws ERR_UNHANDLED_ERROR synchronously
  // and this test would fail — with the guard it is swallowed.
  await new Promise<void>(resolve => {
    setImmediate(() => {
      stream.emit('error', new Error('EPIPE'))
      resolve()
    })
  })
  assert.deepEqual(writes, ['\x07'], 'the write reached the stream and the async error was contained')
})

test('guardedStreamWriter attaches ONE error listener per stream, across repeated wrappers', () => {
  const stream = new EventEmitter() as EventEmitter & { write(data: string): unknown }
  stream.write = () => true
  // A runner remount wraps the SAME stream again — the guard must not
  // accumulate listeners (MaxListenersExceededWarning / stale closures).
  for (let i = 0; i < 5; i += 1) {
    guardedStreamWriter(stream as never).write('\x07')
  }
  assert.equal(stream.listenerCount('error'), 1, 'one listener per stream, ever')
})

test('guardedStreamWriter keeps the notifier usable end-to-end', () => {
  const writes: string[] = []
  const stream = {
    write: (data: string) => { writes.push(data); return true },
    on: () => {},
  }
  const notifier = new TerminalNotifier(guardedStreamWriter(stream as never))
  notifier.notify('bell', 'DSH', 'Turn complete')
  assert.deepEqual(writes, ['\x07'])
})
