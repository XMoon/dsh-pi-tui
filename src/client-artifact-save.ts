/**
 * The Client-local safe file sink (Pre-Stage-D export convergence): narrow
 * local filesystem writing for the artifact save workflows. It owns temp
 * files, incremental streaming, atomic commit and best-effort cleanup — the
 * final artifact is NEVER exposed partially written. The Host/archive port
 * never touches the filesystem; this module never touches the Host.
 *
 * Commit model: the temp file lives in the selected final directory under a
 * collision-resistant exclusive name; rename is the commit point. A
 * confirmed overwrite uses the safest platform-appropriate replacement
 * (POSIX rename replaces atomically; Windows falls back to unlink + rename
 * once — the temp file is complete, so the final artifact is never partial).
 * @module @xmoon76/dsh-pi-tui/client-artifact-save
 */

import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { open, rename, rm, unlink } from 'node:fs/promises'
import { isAbsolute, join, win32 } from 'node:path'
import type { FileHandle } from 'node:fs/promises'
import { expandHomeToken } from './file-completion/query.ts'
import { cancellationError } from './detached.ts'

/** A collision-resistant temp path in the target's directory. */
function tempPathFor(target: string): string {
  return join(dirnameOf(target), `.${basenameOf(target)}.${randomUUID()}.tmp`)
}

function dirnameOf(target: string): string {
  const slash = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'))
  return slash === -1 ? '.' : target.slice(0, slash)
}

function basenameOf(target: string): string {
  const slash = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'))
  return target.slice(slash + 1)
}

/** Write one chunk fully (a regular-file write may return short). */
async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset)
    if (bytesWritten === 0) throw new Error('artifact save: zero-byte write')
    offset += bytesWritten
  }
}

/** Whether a rename failure means the target already exists (Windows). */
function isReplaceError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  return code === 'EEXIST' || code === 'EPERM'
}

/** Commit the complete temp file onto the final target. POSIX rename
 * replaces atomically; on Windows a rename onto an existing file fails, so
 * the old target is removed and the rename retried once (the temp file is
 * complete — the final artifact is never partial). */
async function commitRename(tempPath: string, target: string): Promise<void> {
  try {
    await rename(tempPath, target)
  } catch (error) {
    if (process.platform === 'win32' && isReplaceError(error)) {
      await unlink(target)
      await rename(tempPath, target)
      return
    }
    throw error
  }
}

/** Resolve the typed directory against the Client cwd: `~`/`~/` expand
 * through the shared path engine, relative forms resolve against the Client
 * process cwd (never the Host/session cwd), absolute forms (POSIX and
 * Windows dialect) pass through. */
export function resolveClientDirectory(input: string, cwd: string): string {
  const expanded = expandHomeToken(input)
  if (isAbsolute(expanded) || win32.isAbsolute(expanded)) return expanded
  return join(cwd, expanded)
}

/** Whether the resolved path exists and is a directory (never throws). */
export function isDirectoryPath(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Stream one artifact byte stream into a temp file in the target's
 * directory and commit it onto the final target. The stream is consumed
 * incrementally (never concatenated); cancellation aborts the stream and
 * cleans the temp file; a failure never leaves a partial file under the
 * final name.
 * @param target - the final Client-local path.
 * @param stream - the artifact byte stream.
 * @param signal - cancellation; aborts the stream and the write.
 * @returns the resolved final path on success.
 */
export async function streamToFile(
  target: string,
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<string> {
  const tempPath = tempPathFor(target)
  let handle: FileHandle | undefined
  try {
    handle = await open(tempPath, 'wx')
    const reader = stream.getReader()
    try {
      for (;;) {
        if (signal.aborted) {
          // Cancel the producer (the upstream compressor terminates on
          // consumer cancel) before settling as a cancellation.
          await reader.cancel().catch(() => {})
          throw cancellationError('artifact save aborted')
        }
        const { done, value } = await reader.read()
        if (done) break
        if (value.byteLength > 0) await writeAll(handle, value)
      }
    } finally {
      reader.releaseLock()
    }
    await handle.close()
    handle = undefined
    await commitRename(tempPath, target)
    return target
  } catch (error) {
    if (handle !== undefined) {
      try { await handle.close() } catch { /* best-effort */ }
    }
    try { await rm(tempPath, { force: true }) } catch { /* best-effort */ }
    throw error
  }
}

/**
 * Write one text artifact (the readable Markdown transcript) through a temp
 * file and commit it onto the final target, so cancellation/failure can
 * never leave a partial final `.md`.
 * @param target - the final Client-local path.
 * @param text - the artifact text.
 * @param signal - cancellation.
 * @returns the resolved final path on success.
 */
export async function writeTextAtomically(
  target: string,
  text: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted()
  const tempPath = tempPathFor(target)
  let handle: FileHandle | undefined
  try {
    handle = await open(tempPath, 'wx')
    await handle.writeFile(text, 'utf8')
    await handle.close()
    handle = undefined
    await commitRename(tempPath, target)
    return target
  } catch (error) {
    if (handle !== undefined) {
      try { await handle.close() } catch { /* best-effort */ }
    }
    try { await rm(tempPath, { force: true }) } catch { /* best-effort */ }
    throw error
  }
}
