/**
 * The Client-local safe file sink (Pre-Stage-D export convergence): narrow
 * local filesystem writing for the artifact save workflows. It owns temp
 * files, incremental streaming, atomic commit and best-effort cleanup — the
 * final artifact is NEVER exposed partially written. The Host/archive port
 * never touches the filesystem; this module never touches the Host.
 *
 * Commit model: the temp file lives in the selected final directory under a
 * collision-resistant exclusive name; the commit is an ATOMIC operation —
 * WITHOUT overwrite consent a hard link is created at the target
 * (`link()` fails with EEXIST if the target appeared, closing the
 * stat→rename race; filesystems that refuse hard links fail closed), and a
 * confirmed overwrite uses the safest platform-appropriate replacement
 * (POSIX rename replaces atomically; Windows falls back to unlink + rename
 * once — the temp file is complete, so the final artifact is never partial).
 * @module @xmoon76/dsh-pi-tui/client-artifact-save
 */

import { randomUUID } from 'node:crypto'
import { lstatSync, statSync } from 'node:fs'
import { link, open, rename, rm, unlink } from 'node:fs/promises'
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

/** Commit the complete temp file onto the final target. WITHOUT explicit
 * overwrite consent the target must not exist at commit time — a file (or a
 * symlink, DANGLING or not: `lstatSync` never follows) that appeared after
 * the prompt's collision check is a real conflict, never a silent overwrite.
 * The no-overwrite commit is ATOMIC: `link()` fails with EEXIST if the
 * target appeared between the check and the commit, closing the
 * stat→rename race. A filesystem that refuses hard links FAILS CLOSED (the
 * save reports the unsupported commit instead of risking a silent
 * overwrite). With consent, POSIX rename replaces atomically; on Windows a
 * rename onto an existing file fails, so the old target is removed and the
 * rename retried once (the temp file is complete — the final artifact is
 * never partial). */
async function commitRename(tempPath: string, target: string, overwrite: boolean): Promise<void> {
  if (!overwrite) {
    // lstatSync: a dangling symlink is a real directory entry — never
    // follow it into ENOENT (a symlink target must not be silently
    // replaced either).
    try {
      lstatSync(target)
      throw new Error(`artifact save: target appeared after the collision check: ${target}`)
    } catch (error) {
      // ENOENT is the expected no-collision case; anything else is a real
      // conflict or a stat failure — never a silent overwrite.
      if ((error as { code?: unknown }).code !== 'ENOENT') throw error
    }
    // Atomic no-replace commit: link() fails with EEXIST if the target
    // appeared between the check and the commit — the stat→rename race is
    // closed. The fail-closed mapping applies to the LINK operation ONLY.
    try {
      await link(tempPath, target)
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (code === 'EEXIST') {
        throw new Error(`artifact save: target appeared after the collision check: ${target}`)
      }
      // FAIL-CLOSED: a filesystem without hard links (or a directory that
      // refuses new entries) cannot commit without the replace race — never
      // fall back to an unchecked rename (a silent overwrite would violate
      // the no-overwrite consent). The user re-runs with explicit overwrite
      // consent instead.
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'EOPNOTSUPP') {
        throw new Error(`artifact save: filesystem does not support atomic no-replace commit: ${target}`)
      }
      throw error
    }
    // The link succeeded: the final artifact is COMMITTED. The temp-name
    // cleanup is best-effort — a cleanup failure (e.g. the directory turned
    // read-only in the race window) must never report a failed save for a
    // committed artifact; the outer catch's rm is the second best-effort
    // pass when a later step fails.
    try { await unlink(tempPath) } catch { /* best-effort: the artifact is committed */ }
    return
  }
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
  if (isAbsolute(expanded)) {
    // POSIX: backslashes are the user's dialect, not filesystem separators —
    // normalize them in POSIX-ABSOLUTE paths too (a completion-suggested
    // `/tmp/foo\bar/` must round-trip into the real directory; the query
    // engine already treats `\` as a separator there). A Windows drive/UNC
    // path stays literal (a Windows dialect, never a POSIX filesystem
    // path). On Windows the native filesystem handles backslashes.
    return process.platform === 'win32' ? expanded : expanded.replace(/\\/g, '/')
  }
  if (win32.isAbsolute(expanded)) return expanded
  // POSIX: backslashes are the user's dialect, not filesystem separators —
  // normalize them exactly like the completion engine (query.ts
  // joinRelativeScope) so a suggested `foo\bar/` round-trips into the SAME
  // directory the completion listed. On Windows the native joiner handles
  // backslashes.
  return join(cwd, process.platform === 'win32' ? expanded : expanded.replace(/\\/g, '/'))
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
 * final name. The producer is cancelled on ANY failure (a failed write must
 * not leave the upstream compressor blocked in backpressure), and a
 * cancellation that lands after the last chunk still prevents the commit.
 * @param target - the final Client-local path.
 * @param stream - the artifact byte stream.
 * @param signal - cancellation; aborts the stream and the write.
 * @param overwrite - whether the user consented to replacing an existing
 *   target; without consent a target that appeared after the collision
 *   check is a real conflict, never a silent overwrite.
 * @returns the resolved final path on success.
 */
export async function streamToFile(
  target: string,
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  overwrite: boolean,
): Promise<string> {
  const tempPath = tempPathFor(target)
  let handle: FileHandle | undefined
  const reader = stream.getReader()
  // Whether the reader lock is still held: the inner finally releases it
  // after the read loop, but an open failure never reaches it — the outer
  // finally releases the lock on EVERY exit path.
  let readerLocked = true
  // A pending `read()` is not interrupted by the signal alone: cancel the
  // producer so a cancelled save settles promptly instead of hanging on a
  // stream that never sends another chunk.
  const onAbort = (): void => {
    void reader.cancel().catch(() => {}) // allowlist: producer cancel on abort is best-effort (the loop rethrows the cancellation)
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    handle = await open(tempPath, 'wx')
    try {
      for (;;) {
        if (signal.aborted) throw cancellationError('artifact save aborted')
        const { done, value } = await reader.read()
        if (done) break
        if (value.byteLength > 0) await writeAll(handle, value)
      }
    } catch (error) {
      // Terminate the producer BEFORE releasing the lock (cancel requires
      // the lock); a failed write must not leave the upstream compressor
      // blocked in backpressure. Best-effort.
      try { await reader.cancel() } catch { /* best-effort */ }
      throw error
    } finally {
      // The reader lock is released after the read loop (success AND
      // failure): the stream stays reusable and the producer is never left
      // locked.
      reader.releaseLock()
      readerLocked = false
    }
    await handle.close()
    handle = undefined
    // A cancellation that landed after the last chunk must still prevent
    // the commit (the final artifact is never written for a cancelled save).
    if (signal.aborted) throw cancellationError('artifact save aborted')
    await commitRename(tempPath, target, overwrite)
    return target
  } catch (error) {
    // An open failure leaves the producer unconsumed (the lock is still
    // held): cancel it so it is never left blocked; after the inner finally
    // released the lock this is a no-op rejected promise. Best-effort.
    try { await reader.cancel() } catch { /* best-effort */ }
    if (handle !== undefined) {
      try { await handle.close() } catch { /* best-effort */ }
    }
    try { await rm(tempPath, { force: true }) } catch { /* best-effort */ }
    if (signal.aborted) throw cancellationError('artifact save aborted')
    throw error
  } finally {
    // Every exit path releases the reader lock — including a temp-open
    // failure that never reached the inner finally (the caller's stream
    // must stay reusable).
    if (readerLocked) reader.releaseLock()
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Write one text artifact (the readable Markdown transcript) through a temp
 * file and commit it onto the final target, so cancellation/failure can
 * never leave a partial final `.md`. A cancellation that lands after the
 * write still prevents the commit.
 * @param target - the final Client-local path.
 * @param text - the artifact text.
 * @param signal - cancellation.
 * @param overwrite - whether the user consented to replacing an existing
 *   target; without consent a target that appeared after the collision
 *   check is a real conflict, never a silent overwrite.
 * @returns the resolved final path on success.
 */
export async function writeTextAtomically(
  target: string,
  text: string,
  signal: AbortSignal,
  overwrite: boolean,
): Promise<string> {
  signal.throwIfAborted()
  const tempPath = tempPathFor(target)
  let handle: FileHandle | undefined
  try {
    handle = await open(tempPath, 'wx')
    await handle.writeFile(text, 'utf8')
    await handle.close()
    handle = undefined
    if (signal.aborted) throw cancellationError('artifact save aborted')
    await commitRename(tempPath, target, overwrite)
    return target
  } catch (error) {
    if (handle !== undefined) {
      try { await handle.close() } catch { /* best-effort */ }
    }
    try { await rm(tempPath, { force: true }) } catch { /* best-effort */ }
    if (signal.aborted) throw cancellationError('artifact save aborted')
    throw error
  }
}
