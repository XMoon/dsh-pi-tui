/**
 * Stream generic file drafts into the DSH attachment service (Stage C2).
 *
 * The source is opened only for submit-time admission, read in bounded chunks,
 * and checked against the attach-time fingerprint before and after streaming.
 * @module @xmoon76/dsh-pi-tui/attachment/file-admission
 */

import { open, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { FileInputError } from './intake.ts'
import type { DraftFile, DraftFileFingerprint } from './file-draft.ts'

/** Structural subset of DSH's durable file reference. */
export interface FileAttachmentRefLike {
  readonly attachmentId: string
  readonly name: string
  readonly bytes: number
}

/** Structural subset of DSH's streamed file-admission service. */
export interface FileAttachmentStoreLike {
  saveFileStream(input: {
    readonly data: AsyncIterable<Uint8Array>
    readonly signal?: AbortSignal
    readonly name?: string
  }): Promise<FileAttachmentRefLike>
}

/** Bounded source chunk size used for generic file admission. */
export const FILE_STREAM_CHUNK_BYTES = 64 * 1024

function sameFingerprint(stats: BigIntStats, expected: DraftFileFingerprint): boolean {
  return stats.dev === expected.dev
    && stats.ino === expected.ino
    && stats.size === expected.size
    && stats.mtimeNs === expected.mtimeNs
}

function changed(file: DraftFile): FileInputError {
  return new FileInputError(`File changed since it was attached; reattach ${file.name}.`)
}

/**
 * Read one local file as bounded chunks. The generator owns and closes its
 * handle on success, source mutation, cancellation, and consumer failure.
 */
export async function* streamDraftFile(
  file: DraftFile,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  if (file.source.type !== 'path') {
    throw new FileInputError(`Recalled file ${file.name} has no local source.`)
  }
  const source = file.source
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    signal?.throwIfAborted()
    const initial = await stat(source.path, { bigint: true })
    signal?.throwIfAborted()
    if (!initial.isFile() || !sameFingerprint(initial, source.fingerprint)) throw changed(file)
    // O_NONBLOCK prevents a replaced FIFO from hanging the submit path before
    // the descriptor can be fstat-validated below. It is ignored for regular files.
    handle = await open(source.path, constants.O_RDONLY | constants.O_NONBLOCK)
    signal?.throwIfAborted()
    const before = await handle.stat({ bigint: true })
    signal?.throwIfAborted()
    if (!before.isFile() || !sameFingerprint(before, source.fingerprint)) throw changed(file)

    let total = 0n
    for (;;) {
      signal?.throwIfAborted()
      const chunk = new Uint8Array(FILE_STREAM_CHUNK_BYTES)
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null)
      if (bytesRead === 0) break
      total += BigInt(bytesRead)
      yield chunk.subarray(0, bytesRead)
    }

    signal?.throwIfAborted()
    const after = await handle.stat({ bigint: true })
    if (!after.isFile() || !sameFingerprint(after, source.fingerprint) || total !== source.fingerprint.size) {
      throw changed(file)
    }
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted()
    if (error instanceof FileInputError) throw error
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw changed(file)
    throw new FileInputError(`File cannot be read: ${file.name}`, { cause: error })
  } finally {
    await handle?.close()
  }
}

/** Admit local and recalled file drafts in their original file order. */
export async function admitDraftFiles(
  files: readonly DraftFile[],
  attachments: FileAttachmentStoreLike,
  signal?: AbortSignal,
): Promise<readonly FileAttachmentRefLike[]> {
  const refs: FileAttachmentRefLike[] = []
  for (const file of files) {
    if (file.source.type === 'recalled') {
      refs.push(file.source.ref)
      continue
    }
    refs.push(await attachments.saveFileStream({
      data: streamDraftFile(file, signal),
      ...(signal === undefined ? {} : { signal }),
      name: file.name,
    }))
  }
  return refs
}
