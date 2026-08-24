/**
 * Issue #7 tests: the shared clipboard WRITE policy (tmux → platform
 * helper → OSC 52 best-effort), driven by injected command mocks — the
 * decision trees never execute real host commands in CI.
 * @module @xmoon76/dsh-pi-tui/clipboard.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { buildOsc52Sequence, copyToClipboard, type CopyEnvironment, type CopyExecutor } from '../src/clipboard.ts'
import { createClipboardRunner } from '../src/image/clipboard.ts'

/** A recording executor: captures every invocation, answers per script. */
function scriptedRun(script: Record<string, number>): { run: CopyExecutor; calls: Array<{ command: string; args: readonly string[]; input: string }> } {
  const calls: Array<{ command: string; args: readonly string[]; input: string }> = []
  const run: CopyExecutor = async (command, args, input) => {
    calls.push({ command, args, input })
    return { code: script[`${command} ${args.join(' ')}`] ?? script[command] ?? 1 }
  }
  return { run, calls }
}

function envOf(overrides: Partial<CopyEnvironment> = {}): CopyEnvironment {
  return {
    platform: 'linux',
    env: {},
    // The default assumes the platform helpers are installed; the
    // missing-helper tests pass `exists: () => false` explicitly.
    exists: () => true,
    isTTY: () => true,
    writeOsc52: () => {},
    ...overrides,
  }
}

test('tmux: $TMUX set prefers `tmux load-buffer -w -` with the text on stdin', async () => {
  const { run, calls } = scriptedRun({ 'tmux load-buffer -w -': 0 })
  const ok = await copyToClipboard('hello', run, envOf({ env: { TMUX: '/tmp/tmux-1000/default,1234,0' } }))
  assert.equal(ok, true)
  assert.deepEqual(calls, [{ command: 'tmux', args: ['load-buffer', '-w', '-'], input: 'hello' }])
})

test('tmux: a failing tmux falls through to the platform helper', async () => {
  const { run, calls } = scriptedRun({ 'tmux load-buffer -w -': 1, 'wl-copy': 0 })
  const ok = await copyToClipboard('hello', run, envOf({ env: { TMUX: 'x', WAYLAND_DISPLAY: 'wayland-0' } }))
  assert.equal(ok, true)
  assert.deepEqual(calls, [
    { command: 'tmux', args: ['load-buffer', '-w', '-'], input: 'hello' },
    { command: 'wl-copy', args: [], input: 'hello' },
  ])
})

test('tmux: a throwing executor falls through, never rejects', async () => {
  const run: CopyExecutor = async () => { throw new Error('spawn ENOENT') }
  // No display env and no TTY: the throw must fall through to a clean
  // `false`, not an unhandled rejection.
  const ok = await copyToClipboard('hello', run, envOf({ env: { TMUX: 'x' }, isTTY: () => false }))
  assert.equal(ok, false)
})

test('Wayland: wl-copy receives the text on stdin', async () => {
  const { run, calls } = scriptedRun({ 'wl-copy': 0 })
  const ok = await copyToClipboard('hello', run, envOf({ env: { WAYLAND_DISPLAY: 'wayland-0' } }))
  assert.equal(ok, true)
  assert.deepEqual(calls, [{ command: 'wl-copy', args: [], input: 'hello' }])
})

test('Wayland without wl-copy falls through to X11 xclip when DISPLAY is set', async () => {
  const { run, calls } = scriptedRun({ 'xclip -selection clipboard': 0 })
  const ok = await copyToClipboard('hello', run, envOf({
    env: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' },
    exists: (command) => command === 'xclip',
  }))
  assert.equal(ok, true)
  assert.deepEqual(calls, [{ command: 'xclip', args: ['-selection', 'clipboard'], input: 'hello' }])
})

test('X11: xclip first, xsel as the fallback', async () => {
  const { run, calls } = scriptedRun({ 'xclip -selection clipboard': 1, 'xsel --clipboard --input': 0 })
  const ok = await copyToClipboard('hello', run, envOf({ env: { DISPLAY: ':0' } }))
  assert.equal(ok, true)
  assert.deepEqual(calls, [
    { command: 'xclip', args: ['-selection', 'clipboard'], input: 'hello' },
    { command: 'xsel', args: ['--clipboard', '--input'], input: 'hello' },
  ])
})

test('X11: xsel alone works when xclip is missing', async () => {
  const { run, calls } = scriptedRun({ 'xsel --clipboard --input': 0 })
  const ok = await copyToClipboard('hello', run, envOf({
    env: { DISPLAY: ':0' },
    exists: (command) => command === 'xsel',
  }))
  assert.equal(ok, true)
  assert.deepEqual(calls, [{ command: 'xsel', args: ['--clipboard', '--input'], input: 'hello' }])
})

test('macOS: pbcopy receives the text on stdin', async () => {
  const { run, calls } = scriptedRun({ pbcopy: 0 })
  const ok = await copyToClipboard('hello', run, envOf({ platform: 'darwin' }))
  assert.equal(ok, true)
  assert.deepEqual(calls, [{ command: 'pbcopy', args: [], input: 'hello' }])
})

test('Windows: clip receives the text on stdin', async () => {
  const { run, calls } = scriptedRun({ clip: 0 })
  const ok = await copyToClipboard('hello', run, envOf({ platform: 'win32' }))
  assert.equal(ok, true)
  assert.deepEqual(calls, [{ command: 'clip', args: [], input: 'hello' }])
})

test('all helpers fail: OSC 52 fallback writes the sequence and returns true (best-effort)', async () => {
  let osc52 = ''
  const { run } = scriptedRun({})
  const ok = await copyToClipboard('hello', run, envOf({
    env: { DISPLAY: ':0' },
    writeOsc52: (text) => { osc52 = text },
  }))
  assert.equal(ok, true, 'the OSC 52 fallback is best-effort success (the sequence was written)')
  assert.equal(osc52, 'hello')
})

test('no helper and no TTY: returns false without writing anything', async () => {
  let osc52 = ''
  const { run, calls } = scriptedRun({})
  const ok = await copyToClipboard('hello', run, envOf({
    isTTY: () => false,
    writeOsc52: (text) => { osc52 = text },
  }))
  assert.equal(ok, false)
  assert.equal(osc52, '')
  assert.deepEqual(calls, [])
})

test('a throwing OSC 52 writer returns false instead of rejecting (round-2 finding)', async () => {
  const { run } = scriptedRun({})
  const ok = await copyToClipboard('hello', run, envOf({
    writeOsc52: () => { throw new Error('stdout write failed') },
  }))
  assert.equal(ok, false, 'a failed best-effort write must resolve false, never reject')
})

test('large text passes through the tmux path unchanged', async () => {
  const large = 'x'.repeat(2 * 1024 * 1024)
  const { run, calls } = scriptedRun({ 'tmux load-buffer -w -': 0 })
  const ok = await copyToClipboard(large, run, envOf({ env: { TMUX: 'x' } }))
  assert.equal(ok, true)
  assert.equal(calls[0]!.input, large)
})

test('empty text still runs the policy (the caller filters empty selections)', async () => {
  const { run, calls } = scriptedRun({ 'tmux load-buffer -w -': 0 })
  const ok = await copyToClipboard('', run, envOf({ env: { TMUX: 'x' } }))
  assert.equal(ok, true)
  assert.equal(calls[0]!.input, '')
})

test('the real execFile runner pipes the input payload to the child stdin (issue #7 wiring)', async () => {
  // The production wiring (src/index.ts) runs the copy policy through
  // createClipboardRunner: the payload must reach the helper's stdin —
  // a runner that drops it would "succeed" while copying nothing
  // (review finding). `node -e` echoes stdin to stdout on every platform.
  const run = createClipboardRunner()
  const result = await run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'hello stdin' })
  assert.equal(result.code, 0)
  assert.equal(result.stdout.toString('utf8'), 'hello stdin')
})

test('the real execFile runner preserves binary stdout byte-for-byte (clipboard image intake)', async () => {
  // Regression (P0): without `encoding: 'buffer'`, execFile decodes stdout
  // as UTF-8 and REPLACES invalid bytes — PNG magic (0x89 0x50 0x4E 0x47
  // 0x0D 0x0A 0x1A 0x0A) becomes EF BF BD ... before parseImageMetadata
  // ever sees it, so a Wayland/X11 image paste silently no-ops. The runner
  // must hand the parser the EXACT bytes the child wrote.
  const run = createClipboardRunner()
  const expected = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG magic
    0x00, 0xff, 0xfe, 0x80, // non-UTF-8 bytes
  ])
  const result = await run(process.execPath, [
    '-e',
    `process.stdout.write(Buffer.from(${JSON.stringify([...expected])}))`,
  ])
  assert.equal(result.code, 0)
  assert.ok(Buffer.isBuffer(result.stdout), 'stdout must be a raw Buffer, never a decoded string')
  assert.deepEqual(result.stdout, expected)
})

test('the real execFile runner survives an early-exiting child while piping a large payload (EPIPE, round-3 finding)', async () => {
  // A helper that exits immediately while a large payload is being piped
  // emits EPIPE on stdin; without an error listener the process crashes
  // with an unhandled 'error' event. The runner must resolve with the
  // child's non-zero exit instead.
  const run = createClipboardRunner()
  const result = await run(process.execPath, ['-e', 'process.exit(1)'], { input: 'x'.repeat(2 * 1024 * 1024) })
  assert.equal(result.code, 1)
})

test('buildOsc52Sequence: a bare OSC 52 sequence outside tmux', () => {
  const sequence = buildOsc52Sequence('hello', false)
  assert.equal(sequence, `\x1b]52;c;${Buffer.from('hello', 'utf8').toString('base64')}\x07`)
})

test('buildOsc52Sequence: inside tmux the sequence rides a DCS passthrough with doubled ESC bytes', () => {
  // kimi-code convention: tmux swallows bare OSC sequences, so the payload
  // is wrapped in `\x1bPtmux;…\x1b\\` with every ESC doubled.
  const sequence = buildOsc52Sequence('hello', true)
  const payload = `\x1b]52;c;${Buffer.from('hello', 'utf8').toString('base64')}\x07`
  assert.equal(sequence, `\x1bPtmux;${payload.replaceAll('\x1b', '\x1b\x1b')}\x1b\\`)
  assert.ok(sequence.startsWith('\x1bPtmux;'), 'must open the tmux passthrough')
  assert.ok(sequence.endsWith('\x1b\\'), 'must close the tmux passthrough')
  // Every inner ESC is doubled: the OSC start appears only as `\x1b\x1b]52;c;`.
  assert.ok(sequence.includes('\x1b\x1b]52;c;'), 'the OSC start must ride the doubled ESC')
  assert.ok(!sequence.includes('\x1bPtmux;\x1b]52;c;'), 'a bare (undoubled) OSC start must never follow the passthrough open')
})
