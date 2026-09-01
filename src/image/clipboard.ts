/**
 * Clipboard image reading (plan M3, §9).
 *
 * The paste action probes the platform clipboard ONCE, then: an image
 * becomes a draft (placeholder into the editor); plain text keeps the
 * ordinary paste behavior; "clipboard has no image" is NOT an error (a
 * text Ctrl+V must never pop "No image found" — §20). The platform matrix
 * follows the plan: Wayland `wl-paste`, X11 `xclip`, WSL/macOS/Windows
 * PowerShell+AppKit PNG round-trips, graceful unsupported elsewhere.
 *
 * Every platform runs through an injected `RunCommand`, so CI exercises
 * the decision trees with mocks (plan §26) and real machines verify one
 * native path.
 * @module @xmoon76/dsh-pi-tui/image/clipboard
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { ClipboardImageError } from './errors.ts'
import { parseImageMetadata } from './intake.ts'
import type { ImageMediaType } from './types.ts'

/** One clipboard probe outcome. */
export type ClipboardReadResult =
  | { readonly kind: 'image'; readonly bytes: Uint8Array; readonly mediaType: ImageMediaType; readonly width: number; readonly height: number }
  /** The clipboard holds no image: the plain text payload ('' = empty). */
  | { readonly kind: 'text'; readonly text: string }
  /** The platform cannot be probed (Termux / unknown desktop). */
  | { readonly kind: 'unsupported' }

/** The command runner abstraction (CI injects mocks). */
export interface RunCommand {
  (
    command: string,
    args: readonly string[],
    options?: { timeoutMs?: number; input?: string },
  ): Promise<{ stdout: Buffer; stderr: Buffer; code: number }>
}

/**
 * The real execFile-backed runner (plan M3): a bounded execFile with a
 * generous buffer (clipboard payloads can be multi-MB). `input` is piped
 * to the child's stdin and closed before awaiting — the copy policy's
 * `tmux load-buffer -w -` / `pbcopy` / `wl-copy` / `xclip` all read their
 * payload from stdin, so a runner that drops the payload would "succeed"
 * while copying nothing (issue #7 review finding). Note: async execFile
 * has NO `input` option (that is spawnSync/execFileSync-only), so the
 * payload is written to `child.stdin` explicitly.
 */
export function createClipboardRunner(): RunCommand {
  return (command, args, options) => new Promise((resolve) => {
    const child = execFile(command, args as string[], {
      timeout: options?.timeoutMs ?? 2000,
      maxBuffer: 64 * 1024 * 1024,
      // Binary-safe (P0): without an explicit encoding, execFile decodes
      // stdout as UTF-8 and REPLACES invalid bytes — PNG magic (0x89 0x50
      // 0x4E 0x47 ...) arrives as EF BF BD ... and parseImageMetadata
      // cannot recognize the payload, so an image paste silently no-ops.
      // `encoding: 'buffer'` keeps stdout/stderr as raw Buffers end to end.
      encoding: 'buffer',
    }, (error, stdout, stderr) => {
      const code = error === null
        ? 0
        : typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code
          : 1
      resolve({
        stdout,
        stderr,
        code,
      })
    })
    if (options?.input !== undefined) {
      // A helper that exits early (missing command, immediate failure)
      // while a large payload is being piped emits EPIPE on stdin — an
      // unhandled 'error' event would crash the process (round-3 finding).
      // Swallow it: the child is gone, and its non-zero exit (or the
      // timeout) already reports the failure through the result code.
      child.stdin?.on('error', () => {})
      child.stdin?.end(options.input)
    }
  })
}

/** Platform facts the probe decision tree reads. */
export interface ClipboardEnvironment {
  readonly platform: string
  readonly env: Record<string, string | undefined>
  readonly exists: (path: string) => boolean
}

/**
 * Whether a command is available on $PATH (review finding): a bare
 * `existsSync(command)` only checks the CURRENT directory, so normal
 * Wayland/X11 installations would look "helper missing". Walks the PATH
 * entries; empty entries fall back to the CWD like a real shell.
 * - a command containing a path separator resolves DIRECTLY (shell lookup
 *   semantics: `./wl-paste` never walks PATH);
 * - win32 PATH entries split on `;` ONLY — drive-letter colons (`C:\…`)
 *   survive (follow-up finding); POSIX splits on `:`.
 */
export function commandOnPath(command: string, pathVar: string | undefined, platform: string): boolean {
  if (command.includes('/') || (platform === 'win32' && command.includes('\\'))) {
    return existsSync(command)
  }
  const separator = platform === 'win32' ? ';' : ':'
  const dirs = (pathVar ?? '').split(separator)
  // An empty PATH entry (leading/trailing/double separator) means the CWD.
  if (dirs.length === 0 || dirs.some(dir => dir === '')) {
    if (existsSync(command)) return true
  }
  for (const dir of dirs) {
    if (dir === '') continue
    try {
      if (existsSync(join(dir, command))) return true
    } catch {
      // Unreadable directory entries are skipped, never fatal.
    }
  }
  return false
}

/** WSL detection: the interop marker env or the kernel banner. */
export function isWsl(env: ClipboardEnvironment): boolean {
  return env.env.WSL_DISTRO_NAME !== undefined
    || env.env.WSL_INTEROP !== undefined
    || env.env.WSLENV !== undefined
}

/** Whether the termux environment is active. */
export function isTermux(env: ClipboardEnvironment): boolean {
  return env.env.TERMUX_VERSION !== undefined || env.env.PREFIX === '/data/data/com.termux/files/usr'
}

/** The platform's image-paste capability name, for diagnostics. */
export function clipboardBackendOf(env: ClipboardEnvironment): string {
  if (isTermux(env)) return 'unsupported (Termux)'
  if (env.platform === 'darwin') return 'macos-appkit'
  if (env.platform === 'win32') return 'powershell'
  if (isWsl(env)) return 'wsl-powershell'
  if (env.env.WAYLAND_DISPLAY !== undefined) return 'wayland-wl-paste'
  if (env.env.DISPLAY !== undefined) return 'x11-xclip'
  return 'unsupported'
}

/** Wait-free bounded run helper for clipboard commands. */
async function runWithTimeout(
  run: RunCommand,
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ stdout: Buffer; code: number }> {
  const result = await run(command, args, { timeoutMs })
  if (result.code !== 0 && result.stdout.length === 0) {
    throw new ClipboardImageError(`clipboard command failed: ${command} (exit ${result.code})`)
  }
  return { stdout: result.stdout, code: result.code }
}

/** Parse the bytes once a binary clipboard payload arrives. */
function imageFromBytes(bytes: Uint8Array): ClipboardReadResult {
  const meta = parseImageMetadata(bytes)
  if (meta === undefined) return { kind: 'text', text: '' }
  return { kind: 'image', bytes, mediaType: meta.mediaType, width: meta.width, height: meta.height }
}

async function waylandProbe(run: RunCommand): Promise<ClipboardReadResult> {
  const types = await runWithTimeout(run, 'wl-paste', ['--list-types'], 1500)
  const list = types.stdout.toString('utf8')
  if (!/[iI]mage\//.test(list)) {
    const text = await runWithTimeout(run, 'wl-paste', [], 1500)
    return { kind: 'text', text: text.stdout.toString('utf8') }
  }
  for (const mediaType of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
    if (!list.includes(mediaType)) continue
    const data = await runWithTimeout(run, 'wl-paste', ['-t', mediaType], 2000)
    if (data.stdout.length === 0) continue
    return imageFromBytes(data.stdout)
  }
  // The clipboard advertises a raster we do not name: read the default.
  const data = await runWithTimeout(run, 'wl-paste', [], 2000)
  if (data.stdout.length === 0) return { kind: 'text', text: '' }
  return imageFromBytes(data.stdout)
}

async function x11Probe(run: RunCommand): Promise<ClipboardReadResult> {
  const targets = await runWithTimeout(run, 'xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'], 1500)
  const list = targets.stdout.toString('utf8')
  if (!/[mM]age\//.test(list)) {
    const text = await runWithTimeout(run, 'xclip', ['-selection', 'clipboard', '-o'], 1500)
    return { kind: 'text', text: text.stdout.toString('utf8') }
  }
  // Try the supported raster types in order, exactly like the Wayland
  // probe — a clipboard advertising only image/jpeg or image/webp must
  // still work (review finding 6).
  for (const mediaType of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
    if (!list.includes(mediaType)) continue
    const data = await runWithTimeout(run, 'xclip', ['-selection', 'clipboard', '-t', mediaType, '-o'], 2000)
    if (data.stdout.length === 0) continue
    return imageFromBytes(data.stdout)
  }
  const data = await runWithTimeout(run, 'xclip', ['-selection', 'clipboard', '-o'], 2000)
  if (data.stdout.length === 0) return { kind: 'text', text: '' }
  return imageFromBytes(data.stdout)
}

/** macOS: AppKit NSPasteboard PNG → temp file. */
async function macosProbe(run: RunCommand): Promise<ClipboardReadResult> {
  const file = join(tmpdir(), `dsh-clipboard-${randomUUID()}.png`)
  const osascript = [
    'use framework "AppKit"',
    `set thePasteboard to current application's NSPasteboard's generalPasteboard()`,
    `set theData to thePasteboard's dataForType:(current application's NSPasteboardTypePNG)`,
    'if theData is missing value then return ""',
    `set theFile to POSIX file "${file}"`,
    "theData's writeToFile:theFile atomically:true",
    'return "ok"',
  ].join('\n')
  try {
    const result = await run('osascript', ['-e', osascript], { timeoutMs: 5000 })
    if (result.code !== 0) throw new ClipboardImageError(`osascript failed (exit ${result.code})`)
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(readFileSync(file))
    } catch {
      // No PNG on the clipboard: fall back to the plain-text payload.
      const text = await run('osascript', ['-e', 'the clipboard as text'], { timeoutMs: 3000 })
      return { kind: 'text', text: text.stdout.toString('utf8') }
    }
    return imageFromBytes(bytes)
  } finally {
    rmSync(file, { force: true })
  }
}

/** Windows / WSL: PowerShell clipboard → temp PNG. Under WSL the Linux
 * temp path is converted with `wslpath -w` first — PowerShell cannot
 * address `/tmp/...` directly (review finding 5). */
async function powershellProbe(run: RunCommand, wsl: boolean): Promise<ClipboardReadResult> {
  const file = join(tmpdir(), `dsh-clipboard-${randomUUID()}.png`)
  let target = file
  if (wsl) {
    const converted = await run('wslpath', ['-w', file], { timeoutMs: 2000 })
    if (converted.code !== 0) {
      throw new ClipboardImageError(`wslpath failed (exit ${converted.code})`)
    }
    target = converted.stdout.toString('utf8').trim()
  }
  const escaped = target.replaceAll("'", "''")
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$img = [System.Windows.Forms.Clipboard]::GetImage()',
    'if ($null -eq $img) { exit 0 }',
    `$img.Save('${escaped}')`,
  ].join('; ')
  try {
    const result = await run('powershell.exe', ['-NoProfile', '-Command', script], { timeoutMs: 8000 })
    if (result.code !== 0) throw new ClipboardImageError(`powershell failed (exit ${result.code})`)
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(readFileSync(file))
    } catch {
      // No image on the clipboard: read the plain-text payload. The
      // SECOND PowerShell invocation must load System.Windows.Forms itself
      // (each -Command process starts fresh — review finding 2).
      const text = await run('powershell.exe', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText()'], { timeoutMs: 3000 })
      return { kind: 'text', text: text.stdout.toString('utf8') }
    }
    return imageFromBytes(bytes)
  } finally {
    rmSync(file, { force: true })
  }
}

/**
 * Probe the clipboard for an image. Never throws for "no image": plain
 * text and empty clipboards resolve to `{ kind: 'text' }`; platform
 * failures throw {@link ClipboardImageError} (a clipboard that DOES carry
 * an image but cannot be read must be distinguished from no image).
 */
/**
 * Read the system clipboard as PLAIN TEXT (the fullscreen right-click
 * paste — native Windows terminals lose their right-click paste under the
 * alt screen's mouse capture, so the host reads the clipboard itself and
 * feeds a bracketed paste). Returns undefined when no backend is
 * available; best-effort, never throws.
 */
export async function readClipboardText(run: RunCommand, env: ClipboardEnvironment): Promise<string | undefined> {
  const platformCommand = (): { command: string; args: string[]; syntheticTrailingNewline: boolean } | undefined => {
    if (isTermux(env)) return { command: 'termux-clipboard-get', args: [], syntheticTrailingNewline: false }
    if (env.platform === 'darwin') return { command: 'pbpaste', args: [], syntheticTrailingNewline: false }
    if (env.platform === 'win32' || isWsl(env)) {
      // Get-Clipboard SYNTHESIZES a trailing CRLF that is NOT part of the
      // copied text; every other backend returns the clipboard verbatim
      // (a real trailing newline belongs to the content and must survive).
      return {
        command: isWsl(env) ? 'powershell.exe' : 'powershell',
        args: ['-NoProfile', '-Command', 'Get-Clipboard'],
        syntheticTrailingNewline: true,
      }
    }
    if (env.env.WAYLAND_DISPLAY !== undefined && env.exists('wl-paste')) {
      // NO --no-newline: wl-paste would strip a REAL trailing newline from
      // the copied content — only PowerShell's synthetic CRLF is removed.
      return { command: 'wl-paste', args: [], syntheticTrailingNewline: false }
    }
    if (env.env.DISPLAY !== undefined && env.exists('xclip')) {
      return { command: 'xclip', args: ['-selection', 'clipboard', '-o'], syntheticTrailingNewline: false }
    }
    return undefined
  }
  const target = platformCommand()
  if (target === undefined) return undefined
  try {
    const result = await run(target.command, target.args, { timeoutMs: 2000 })
    if (result.code !== 0) return undefined
    const text = result.stdout.toString('utf8')
    if (!target.syntheticTrailingNewline) return text
    return text.replace(/\r\n$/, '').replace(/\n$/, '')
  } catch {
    return undefined
  }
}

export async function readClipboardImage(run: RunCommand, env: ClipboardEnvironment): Promise<ClipboardReadResult> {
  if (isTermux(env)) return { kind: 'unsupported' }
  if (env.platform === 'darwin') return macosProbe(run)
  if (env.platform === 'win32') return powershellProbe(run, false)
  if (isWsl(env)) return powershellProbe(run, true)
  // Each probe is INDEPENDENTLY gated on its helper's presence: a
  // Wayland+XWayland session without wl-paste but with xclip falls through
  // to the X11 probe instead of giving up (review finding 4).
  if (env.env.WAYLAND_DISPLAY !== undefined && env.exists('wl-paste')) {
    return waylandProbe(run)
  }
  if (env.env.DISPLAY !== undefined && env.exists('xclip')) {
    return x11Probe(run)
  }
  return { kind: 'unsupported' }
}
