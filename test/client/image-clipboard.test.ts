/**
 * M3 tests: the clipboard platform decision tree and the per-platform
 * probes, driven by injected command mocks (plan §9 + the clipboard test
 * matrix: Wayland success, Wayland→X11 fallback, X11 success, WSL
 * PowerShell fallback, macOS, unsupported, empty clipboard, text-only).
 * @module @xmoon76/dsh-pi-tui/image-clipboard.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFileSync } from 'node:fs'
import { clipboardBackendOf, commandOnPath, readClipboardImage, type ClipboardEnvironment, type RunCommand } from '../../src/client/clipboard/read.ts'
import { ClipboardImageError } from '../../src/domain/media/errors.ts'

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

/** A minimal JPEG with one SOF0 frame (1×1). */
function jpegBytes(): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b,
    0x08, 0x00, 0x01,
    0x00, 0x01, 0x01,
    0x01, 0x11, 0x00,
  ])
}

/** A minimal lossy WebP header (VP8, 1×1). */
function webpBytes(): Buffer {
  const bytes = Buffer.alloc(30)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(22, 4)
  bytes.write('WEBP', 8, 'ascii')
  bytes.write('VP8 ', 12, 'ascii')
  bytes.writeUInt32LE(10, 16)
  bytes.writeUInt16LE(1, 26)
  bytes.writeUInt16LE(1, 28)
  return bytes
}

/** A minimal GIF89a logical screen descriptor (1×1). */
function gifBytes(): Buffer {
  const bytes = Buffer.alloc(13)
  bytes.write('GIF89a', 0, 'ascii')
  bytes.writeUInt16LE(1, 6)
  bytes.writeUInt16LE(1, 8)
  return bytes
}

const INVALID_IMAGE_MESSAGE = 'Clipboard image data is invalid or unsupported. Supported: PNG, JPEG, WebP, GIF.'
const UNSUPPORTED_FORMAT_MESSAGE = 'Clipboard image format is unsupported. Supported: PNG, JPEG, WebP, GIF.'
const NO_IMAGE_DATA_MESSAGE = 'Clipboard advertised an image but no image data could be read.'

/** Assert one rejection is the fixed ClipboardImageError contract. */
async function rejectsWith(promise: Promise<unknown>, message: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) =>
    error instanceof ClipboardImageError && error.message === message)
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

test('an advertised image/png returns bytes; text-only returns text', async () => {
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

test('Wayland without wl-paste falls through to X11 xclip (review finding 4)', async () => {
  const calls: string[] = []
  const run = (async (command: string, args: readonly string[]) => {
    calls.push(command)
    if (args.includes('TARGETS')) return { stdout: Buffer.from('UTF8_STRING'), stderr: Buffer.alloc(0), code: 0 }
    return { stdout: Buffer.from('x11 text'), stderr: Buffer.alloc(0), code: 0 }
  }) as unknown as RunCommand
  const env = envOf({
    env: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' },
    exists: (command) => command === 'xclip',
  })
  const result = await readClipboardImage(run, env)
  assert.deepEqual(result, { kind: 'text', text: 'x11 text' })
  assert.ok(calls.length >= 1 && calls.every(command => command === 'xclip'), 'only xclip ran after wl-paste was missing')
})

test('the PowerShell text fallback loads System.Windows.Forms itself (review finding 2)', async () => {
  const commands: string[] = []
  const run = (async (command: string, args: readonly string[]) => {
    commands.push(args.join(' '))
    if (args.some(arg => arg.includes('GetImage'))) return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 }
    return { stdout: Buffer.from('clipboard text'), stderr: Buffer.alloc(0), code: 0 }
  }) as unknown as RunCommand
  const result = await readClipboardImage(run, envOf({ platform: 'win32' }))
  assert.deepEqual(result, { kind: 'text', text: 'clipboard text' })
  const fallback = commands.find(command => command.includes('GetText'))
  assert.ok(fallback !== undefined, 'the text fallback ran')
  assert.ok(fallback!.includes('Add-Type -AssemblyName System.Windows.Forms'), 'the fallback loads the assembly itself')
})

// ── advertised images that cannot be decoded are errors, never empty text ──

const WAYLAND_ENV = envOf({ env: { WAYLAND_DISPLAY: 'wayland-0' } })
const X11_ENV = envOf({ env: { DISPLAY: ':0' } })

test('Wayland: an advertised image/png with invalid bytes rejects instead of pasting empty text', async () => {
  // The old imageFromBytes() returned { kind: 'text', text: '' } here, making a
  // real image Ctrl+V look like a no-op.
  await rejectsWith(
    readClipboardImage(waylandMock(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])), WAYLAND_ENV),
    INVALID_IMAGE_MESSAGE,
  )
})

test('X11: a non-zero image probe exit rejects even when stdout is non-empty', async () => {
  const run = (async (command: string, args: readonly string[]) => {
    if (args.includes('TARGETS')) {
      return { stdout: Buffer.from('UTF8_STRING\nimage/png'), stderr: Buffer.alloc(0), code: 0 }
    }
    return { stdout: pngBytes(), stderr: Buffer.alloc(0), code: 4 }
  }) as unknown as RunCommand
  await rejectsWith(readClipboardImage(run, X11_ENV), 'clipboard command failed: xclip (exit 4)')
})

test('a clipboard advertising only an unsupported image format rejects without reading default text', async () => {
  const waylandCalls: string[][] = []
  const wayland = (async (_command: string, args: readonly string[]) => {
    waylandCalls.push([...args])
    if (args.includes('--list-types')) {
      return { stdout: Buffer.from('text/plain\nimage/tiff'), stderr: Buffer.alloc(0), code: 0 }
    }
    return { stdout: Buffer.from('plain text'), stderr: Buffer.alloc(0), code: 0 }
  }) as unknown as RunCommand
  await rejectsWith(readClipboardImage(wayland, WAYLAND_ENV), UNSUPPORTED_FORMAT_MESSAGE)
  assert.deepEqual(waylandCalls.map(args => [...args]), [['--list-types']],
    'no default-text read may run once an image was advertised')

  const x11Calls: string[][] = []
  const x11 = (async (_command: string, args: readonly string[]) => {
    x11Calls.push([...args])
    if (args.includes('TARGETS')) {
      return { stdout: Buffer.from('UTF8_STRING\nimage/tiff'), stderr: Buffer.alloc(0), code: 0 }
    }
    return { stdout: Buffer.from('plain text'), stderr: Buffer.alloc(0), code: 0 }
  }) as unknown as RunCommand
  await rejectsWith(readClipboardImage(x11, X11_ENV), UNSUPPORTED_FORMAT_MESSAGE)
  assert.equal(x11Calls.length, 1, 'only the TARGETS lookup ran for an unsupported image format')
})

test('an advertised supported image with only empty payloads rejects as no image data', async () => {
  const wayland = (async (_command: string, args: readonly string[]) => {
    if (args.includes('--list-types')) {
      return { stdout: Buffer.from('image/png'), stderr: Buffer.alloc(0), code: 0 }
    }
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 }
  }) as unknown as RunCommand
  await rejectsWith(readClipboardImage(wayland, WAYLAND_ENV), NO_IMAGE_DATA_MESSAGE)

  const x11 = (async (_command: string, args: readonly string[]) => {
    if (args.includes('TARGETS')) {
      return { stdout: Buffer.from('image/png'), stderr: Buffer.alloc(0), code: 0 }
    }
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 }
  }) as unknown as RunCommand
  await rejectsWith(readClipboardImage(x11, X11_ENV), NO_IMAGE_DATA_MESSAGE)

  // A genuinely image-less clipboard keeps its text semantics, empty included.
  const textOnlyEmpty = (async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 })) as unknown as RunCommand
  assert.deepEqual(await readClipboardImage(textOnlyEmpty, WAYLAND_ENV), { kind: 'text', text: '' })
})

test('an image payload is classified by its MAGIC bytes, not by the advertised MIME string', async () => {
  const payloads: ReadonlyArray<readonly [string, Buffer]> = [
    ['image/png', pngBytes()],
    ['image/jpeg', jpegBytes()],
    ['image/webp', webpBytes()],
    ['image/gif', gifBytes()],
  ]
  for (const [advertised, payload] of payloads) {
    const run = (async (_command: string, args: readonly string[]) => {
      if (args.includes('--list-types')) {
        return { stdout: Buffer.from(`text/plain\n${advertised}`), stderr: Buffer.alloc(0), code: 0 }
      }
      return { stdout: payload, stderr: Buffer.alloc(0), code: 0 }
    }) as unknown as RunCommand
    const result = await readClipboardImage(run, WAYLAND_ENV)
    assert.equal(result.kind, 'image', `${advertised} payload must parse`)
    if (result.kind === 'image') {
      assert.equal(result.mediaType, advertised, 'the parsed MIME matches the payload')
      assert.deepEqual([result.width, result.height], [1, 1])
    }
  }
  // The advertised label is a hint only: a PNG label carrying JPEG bytes is
  // classified by the parser (the MIME magic stays the authority).
  const mismatched = (async (_command: string, args: readonly string[]) => {
    if (args.includes('--list-types')) {
      return { stdout: Buffer.from('image/png'), stderr: Buffer.alloc(0), code: 0 }
    }
    return { stdout: jpegBytes(), stderr: Buffer.alloc(0), code: 0 }
  }) as unknown as RunCommand
  const result = await readClipboardImage(mismatched, WAYLAND_ENV)
  assert.equal(result.kind, 'image')
  if (result.kind === 'image') assert.equal(result.mediaType, 'image/jpeg', 'magic bytes win over the advertised label')
})

test('macOS: a PNG pasteboard still reads directly; a TIFF-only pasteboard rejects as unsupported', async () => {
  const pngRun = (async (_command: string, args: readonly string[]) => {
    const script = args[1] ?? ''
    const match = /POSIX file "([^"]+)"/u.exec(script)
    if (match === null) return { stdout: Buffer.from('clipboard text'), stderr: Buffer.alloc(0), code: 0 }
    writeFileSync(match[1]!, pngBytes())
    return { stdout: Buffer.from('ok'), stderr: Buffer.alloc(0), code: 0 }
  }) as unknown as RunCommand
  const image = await readClipboardImage(pngRun, envOf({ platform: 'darwin' }))
  assert.equal(image.kind, 'image', 'the AppKit PNG payload parses')

  const sentinelCalls: string[] = []
  const tiffRun = (async (_command: string, args: readonly string[]) => {
    sentinelCalls.push(args[1] ?? '')
    return { stdout: Buffer.from('unsupported-image'), stderr: Buffer.alloc(0), code: 0 }
  }) as unknown as RunCommand
  await rejectsWith(readClipboardImage(tiffRun, envOf({ platform: 'darwin' })), UNSUPPORTED_FORMAT_MESSAGE)
  assert.equal(sentinelCalls.length, 1, 'a TIFF sentinel never triggers the plain-text fallback')

  const noImageRun = (async (_command: string, args: readonly string[]) => {
    const script = args[1] ?? ''
    if (script.includes('the clipboard as text')) {
      return { stdout: Buffer.from('real clipboard text'), stderr: Buffer.alloc(0), code: 0 }
    }
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 }
  }) as unknown as RunCommand
  assert.deepEqual(await readClipboardImage(noImageRun, envOf({ platform: 'darwin' })),
    { kind: 'text', text: 'real clipboard text' },
    'no PNG and no TIFF keeps the unchanged plain-text fallback')
})

test('Windows: a failing GetText fallback rejects instead of masquerading as an empty clipboard', async () => {
  const run = (async (_command: string, args: readonly string[]) => {
    if (args.some(arg => arg.includes('GetImage'))) {
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 }
    }
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 5 }
  }) as unknown as RunCommand
  await rejectsWith(readClipboardImage(run, envOf({ platform: 'win32' })), 'powershell failed (exit 5)')

  // The unchanged empty-text success path stays a valid empty clipboard.
  const emptyRun = (async (_command: string, args: readonly string[]) => ({
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    code: 0,
  })) as unknown as RunCommand
  assert.deepEqual(await readClipboardImage(emptyRun, envOf({ platform: 'win32' })), { kind: 'text', text: '' })
})
