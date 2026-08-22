/**
 * M3 tests: the clipboard platform decision tree and the per-platform
 * probes, driven by injected command mocks (plan §9 + the clipboard test
 * matrix: Wayland success, Wayland→X11 fallback, X11 success, WSL
 * PowerShell fallback, macOS, unsupported, empty clipboard, text-only).
 * @module @xmoon76/dsh-pi-tui/image-clipboard.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { clipboardBackendOf, commandOnPath, readClipboardImage, type ClipboardEnvironment, type RunCommand } from '../src/image/clipboard.ts'

/** A tiny valid PNG header (1×1). */
function pngBytes(): Buffer {
  const bytes = Buffer.alloc(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0, 0, 0, 13], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  bytes.writeUInt32BE(1, 16)
  bytes.writeUInt32BE(1, 20)
  return bytes
}

function envOf(overrides: Partial<ClipboardEnvironment> = {}): ClipboardEnvironment {
  return {
    platform: 'linux',
    env: {},
    // The default assumes the platform helpers are installed; the
    // missing-helper tests pass `exists: () => false` explicitly.
    exists: () => true,
    ...overrides,
  }
}

/** A scripted RunCommand: reads args to answer list-types vs payload. */
function waylandMock(png: Buffer | undefined): RunCommand {
  return (async (command: string, args: readonly string[]) => {
    if (args.includes('--list-types')) {
      return { stdout: Buffer.from(png === undefined ? 'text/plain' : 'text/plain\nimage/png'), stderr: Buffer.alloc(0), code: 0 }
    }
    if (args.includes('-t')) {
      return png === undefined
        ? { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 }
        : { stdout: png, stderr: Buffer.alloc(0), code: 0 }
    }
    return { stdout: Buffer.from('plain paste text'), stderr: Buffer.alloc(0), code: 0 }
  }) as unknown as RunCommand
}

function x11Record(png: Buffer | undefined): RunCommand {
  return (async (command: string, args: readonly string[]) => {
    if (args.includes('TARGETS')) {
      return { stdout: Buffer.from(png === undefined ? 'UTF8_STRING' : 'UTF8_STRING\nimage/png'), stderr: Buffer.alloc(0), code: 0 }
    }
    if (args.includes('image/png')) {
      return png === undefined ? { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 } : { stdout: png, stderr: Buffer.alloc(0), code: 0 }
    }
    return { stdout: Buffer.from('x11 paste text'), stderr: Buffer.alloc(0), code: 0 }
  }) as unknown as RunCommand
}

test('Wayland: an advertised image/png returns the bytes with dimensions', async () => {
  const result = await readClipboardImage(waylandMock(pngBytes()), envOf({ env: { WAYLAND_DISPLAY: 'wayland-0' } }))
  assert.equal(result.kind, 'image')
  if (result.kind === 'image') {
    assert.equal(result.mediaType, 'image/png')
    assert.equal(result.width, 1)
    assert.equal(result.height, 1)
  }
})

test('Wayland: text-only clipboard returns the plain text payload', async () => {
  const result = await readClipboardImage(waylandMock(undefined), envOf({ env: { WAYLAND_DISPLAY: 'wayland-0' } }))
  assert.deepEqual(result, { kind: 'text', text: 'plain paste text' })
})

test('X11: an advertised image/png returns bytes; text-only returns text', async () => {
  const image = await readClipboardImage(x11Record(pngBytes()), envOf({ env: { DISPLAY: ':0' } }))
  assert.equal(image.kind, 'image')
  if (image.kind === 'image') assert.equal(image.mediaType, 'image/png')
  const text = await readClipboardImage(x11Record(undefined), envOf({ env: { DISPLAY: ':0' } }))
  assert.deepEqual(text, { kind: 'text', text: 'x11 paste text' })
})

test('no display and no wayland resolves to unsupported without probing', async () => {
  let ran = false
  const run = (async () => { ran = true; return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 1 } }) as unknown as RunCommand
  const result = await readClipboardImage(run, envOf({}))
  assert.deepEqual(result, { kind: 'unsupported' })
  assert.equal(ran, false)
})

test('Termux resolves to unsupported without probing', async () => {
  let ran = false
  const run = (async () => { ran = true; return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 1 } }) as unknown as RunCommand
  const result = await readClipboardImage(run, envOf({ env: { TERMUX_VERSION: '0.118.0' } }))
  assert.deepEqual(result, { kind: 'unsupported' })
  assert.equal(ran, false)
})

test('WSL converts the temp path with wslpath before PowerShell (review finding 5)', async () => {
  const calls: string[] = []
  const run = (async (command: string, args: readonly string[]) => {
    calls.push(command)
    if (command === 'wslpath') {
      assert.ok(args.includes('-w'), 'wslpath receives -w')
      assert.ok(args.some(arg => arg.startsWith('/')), 'the LINUX temp path is converted')
      return { stdout: Buffer.from('\\\\wsl$\\Ubuntu\\tmp\\dsh-clipboard-x.png'), stderr: Buffer.alloc(0), code: 0 }
    }
    assert.equal(command, 'powershell.exe')
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 }
  }) as unknown as RunCommand
  const result = await readClipboardImage(run, envOf({ env: { WSL_DISTRO_NAME: 'Ubuntu', WAYLAND_DISPLAY: 'wayland-0' } }))
  assert.deepEqual(calls.slice(0, 2), ['wslpath', 'powershell.exe'], 'wslpath runs FIRST')
  assert.equal(result.kind, 'text', 'no PNG written by the bridge → text fallback')
})

test('native Windows skips wslpath entirely', async () => {
  const calls: string[] = []
  const run = (async (command: string) => {
    calls.push(command)
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 }
  }) as unknown as RunCommand
  await readClipboardImage(run, envOf({ platform: 'win32' }))
  assert.ok(calls.every(command => command === 'powershell.exe'), 'only powershell, no wslpath on native Windows')
})

test('macOS probes through osascript', async () => {
  const ran: string[] = []
  const run = (async (command: string) => {
    ran.push(command)
    assert.equal(command, 'osascript')
    return { stdout: Buffer.from('ok'), stderr: Buffer.alloc(0), code: 0 }
  }) as unknown as RunCommand
  const result = await readClipboardImage(run, envOf({ platform: 'darwin' }))
  assert.ok(ran.includes('osascript'), 'osascript probed for the PNG')
  assert.equal(result.kind, 'text', 'no PNG file → plain-text fallback probe')
})

test('clipboardBackendOf names the platform backend', () => {
  assert.equal(clipboardBackendOf(envOf({ platform: 'darwin' })), 'macos-appkit')
  assert.equal(clipboardBackendOf(envOf({ platform: 'win32' })), 'powershell')
  assert.equal(clipboardBackendOf(envOf({ env: { WSL_DISTRO_NAME: 'Ubuntu' } })), 'wsl-powershell')
  assert.equal(clipboardBackendOf(envOf({ env: { WAYLAND_DISPLAY: 'wayland-0' } })), 'wayland-wl-paste')
  assert.equal(clipboardBackendOf(envOf({ env: { DISPLAY: ':0' } })), 'x11-xclip')
  assert.equal(clipboardBackendOf(envOf({})), 'unsupported')
})

test('missing wl-paste/xclip resolves to unsupported instead of a raw exec error (review finding 7)', async () => {
  let ran = false
  const run = (async () => { ran = true; return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 } }) as unknown as RunCommand
  const wayland = await readClipboardImage(run, envOf({ env: { WAYLAND_DISPLAY: 'wayland-0' }, exists: () => false }))
  assert.deepEqual(wayland, { kind: 'unsupported' })
  const x11 = await readClipboardImage(run, envOf({ env: { DISPLAY: ':0' }, exists: () => false }))
  assert.deepEqual(x11, { kind: 'unsupported' })
  assert.equal(ran, false, 'no command ran without the helper present')
})

test('Wayland probes when wl-paste exists', async () => {
  const result = await readClipboardImage(waylandMock(pngBytes()), envOf({ env: { WAYLAND_DISPLAY: 'wayland-0' }, exists: () => true }))
  assert.equal(result.kind, 'image')
})

test('commandOnPath walks $PATH, never just the CWD (review finding)', () => {
  // A known binary resolves through the REAL path.
  assert.equal(commandOnPath('node', process.env.PATH, 'linux'), true)
  assert.equal(commandOnPath('definitely-not-a-real-binary-xyz', process.env.PATH, 'linux'), false)
  // An explicit directory list resolves only entries present in it.
  assert.equal(commandOnPath('node', '', 'linux'), false, 'no PATH, no CWD hit for a non-CWD binary')
  // Windows-style separators are honored only for ';'-separated PATHs.
  const windowsPath = 'C:\\NoSuchDir;' + process.env.PATH!.split(':').filter(Boolean).join(';')
  assert.equal(commandOnPath('node', windowsPath, 'win32'), true)
})

test('commandOnPath keeps win32 drive-letter colons and honors separators', () => {
  // A Windows-style PATH: only ';' splits, so drive-letter colons survive
  // as part of an entry (unreachable directories are simply missed).
  const windowsStyle = process.env.PATH!.split(':').filter(Boolean).join(';')
  assert.equal(commandOnPath('node', windowsStyle, 'win32'), true)
  assert.equal(commandOnPath('node', 'C:\\NoSuchDir;C:\\AlsoMissing', 'win32'), false)
  // POSIX keeps ':' splitting.
  assert.equal(commandOnPath('node', process.env.PATH, 'linux'), true)
})

test('commandOnPath resolves separator-bearing commands directly (shell lookup semantics)', () => {
  assert.equal(commandOnPath('./node', process.env.PATH, 'linux'), false, 'a CWD-relative name is checked directly, not under PATH dirs')
  assert.equal(commandOnPath('/bin/sh', undefined, 'linux'), true, 'an absolute path resolves directly')
})
