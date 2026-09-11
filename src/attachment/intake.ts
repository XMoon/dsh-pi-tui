/**
 * Client-local unified attachment intake (Stage C2).
 *
 * Generic files are classified from a bounded signature probe only. Image
 * signatures are handed to the existing image intake, while other regular
 * files retain metadata and are streamed later at submit time.
 * @module @xmoon76/dsh-pi-tui/attachment/intake
 */

import { open, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import { ImageInputError } from '../image/errors.ts'
import { expandHome, sniffMediaType } from '../image/intake.ts'
import type { ImageMediaType } from '../image/types.ts'
import type { DraftFileFingerprint } from './file-draft.ts'

/** User-facing error for local generic-file intake and admission failures. */
export class FileInputError extends ImageInputError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'FileInputError'
  }
}

/** The outcome of the bounded local signature probe. */
export type AttachmentProbe =
  | { readonly kind: 'image'; readonly path: string; readonly mediaType: ImageMediaType }
  | {
      readonly kind: 'file'
      readonly path: string
      readonly name: string
      readonly byteLength: number
      readonly fingerprint: DraftFileFingerprint
    }

const PROBE_BYTES = 12

function absolutePath(raw: string, cwd: string): string {
  const expanded = expandHome(raw)
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded)
}

function fingerprintOf(stats: {
  readonly dev: bigint
  readonly ino: bigint
  readonly size: bigint
  readonly mtimeNs: bigint
}): DraftFileFingerprint {
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs }
}

/** Resolve and probe one Client-local path without reading generic bytes. */
export async function probeAttachment(rawPath: string, cwd: string, signal?: AbortSignal): Promise<AttachmentProbe> {
  signal?.throwIfAborted()
  const absolute = absolutePath(rawPath, cwd)
  const label = basename(absolute)
  let path: string
  try {
    path = await realpath(absolute)
  } catch {
    signal?.throwIfAborted()
    throw new FileInputError(`File not found: ${label}`)
  }
  signal?.throwIfAborted()

  // Stat before opening so directories, FIFOs, sockets, and devices are
  // rejected without creating a blocking read on a non-regular path.
  const initial = await stat(path, { bigint: true }).catch(() => {
    signal?.throwIfAborted()
    throw new FileInputError(`File cannot be read: ${label}`)
  })
  signal?.throwIfAborted()
  if (!initial.isFile()) throw new FileInputError(`Not a regular file: ${label}`)

  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => {
    signal?.throwIfAborted()
    throw new FileInputError(`File cannot be read: ${label}`)
  })
  try {
    signal?.throwIfAborted()
    const stats = await handle.stat({ bigint: true }).catch(() => {
      signal?.throwIfAborted()
      throw new FileInputError(`File cannot be read: ${label}`)
    })
    signal?.throwIfAborted()
    if (!stats.isFile()) throw new FileInputError(`Not a regular file: ${label}`)
    const prefix = new Uint8Array(PROBE_BYTES)
    const { bytesRead } = await handle.read(prefix, 0, prefix.byteLength, 0).catch(() => {
      signal?.throwIfAborted()
      throw new FileInputError(`File cannot be read: ${label}`)
    })
    signal?.throwIfAborted()
    const mediaType = sniffMediaType(prefix.subarray(0, bytesRead))
    if (mediaType !== undefined) return { kind: 'image', path, mediaType }
    return {
      kind: 'file',
      path,
      name: basename(path),
      byteLength: Number(stats.size),
      fingerprint: fingerprintOf(stats),
    }
  } finally {
    await handle.close()
  }
}
